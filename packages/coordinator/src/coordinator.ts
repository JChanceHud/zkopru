import { Field } from '@zkopru/babyjubjub'
import { EventEmitter } from 'events'
import { ZkTx } from '@zkopru/transaction'
import { logger, root, Worker } from '@zkopru/utils'
import {
  FullNode,
  NetworkStatus,
  massDepositHash,
  headerHash,
  Block,
  Finalization,
  serializeFinalization,
  L1Contract,
  L2Chain,
} from '@zkopru/core'
import { Account, TransactionReceipt } from 'web3-core'
import { Subscription } from 'web3-core-subscriptions'
import { Uint256 } from 'soltypes'
import assert from 'assert'
import AsyncLock from 'async-lock'
import { Layer1 } from '@zkopru/contracts'
import BN from 'bn.js'
import fetch from 'node-fetch'
import { BlockHeader } from 'web3-eth'
import { TxMemPool } from './tx-pool'
import { CoordinatorConfig, CoordinatorContext } from './context'
import { GeneratorBase } from './middlewares/interfaces/generator-base'
import { ProposerBase } from './middlewares/interfaces/proposer-base'
import { BlockGenerator } from './middlewares/default/block-generator'
import { BlockProposer } from './middlewares/default/block-proposer'
import { CoordinatorApi } from './api'
import { AuctionMonitor } from './auction-monitor'

export interface CoordinatorInterface {
  start: () => void
  onTxRequest(handler: (tx: ZkTx) => Promise<string>): void
  onBlock: () => void
}

export interface MiddlewareOption {
  generator?: GeneratorBase
  proposer?: ProposerBase
}

export interface Middlewares {
  generator: GeneratorBase
  proposer: ProposerBase
}

export class Coordinator extends EventEmitter {
  context: CoordinatorContext

  api: CoordinatorApi

  gasPriceSubscriber?: Subscription<BlockHeader>

  taskRunners: {
    blockPropose: Worker<void>
    blockFinalize: Worker<void>
    massDepositCommit: Worker<TransactionReceipt | undefined>
  }

  proposeLock: AsyncLock

  middlewares: Middlewares

  currentRound: number | undefined

  constructor(
    node: FullNode,
    account: Account,
    config: CoordinatorConfig,
    middlewares?: MiddlewareOption,
  ) {
    super()
    this.context = {
      account,
      node,
      auctionMonitor: new AuctionMonitor(node, account, config),
      txPool: new TxMemPool(),
      // eslint-disable-next-line prefer-object-spread
      config: Object.assign({ priceMultiplier: 32 }, config),
    }
    this.api = new CoordinatorApi(this.context)
    this.proposeLock = new AsyncLock()
    this.taskRunners = {
      blockPropose: new Worker(),
      blockFinalize: new Worker(),
      massDepositCommit: new Worker(),
    }
    this.middlewares = {
      generator: middlewares?.generator || new BlockGenerator(this.context),
      proposer: middlewares?.proposer || new BlockProposer(this.context),
    }
  }

  layer1(): L1Contract {
    return this.context.node.layer1
  }

  layer2(): L2Chain {
    return this.context.node.layer2
  }

  node(): FullNode {
    return this.context.node
  }

  async start() {
    logger.info('Starting coordinator')
    this.context.node.synchronizer.on(
      'status',
      async (status: NetworkStatus) => {
        // udpate the txpool using the newly proposed hash
        // if the hash does not exist in the tx pool's block list
        // create an observer to fetch the block data from database
        logger.info(`current status: ${status}`)
        switch (status) {
          case NetworkStatus.SYNCED:
          case NetworkStatus.FULLY_SYNCED:
            if (!this.taskRunners.blockPropose.isRunning()) {
              this.taskRunners.blockPropose.start({
                task: this.proposeTask.bind(this),
                interval: 10000,
              })
            }
            break
          case NetworkStatus.ON_ERROR:
            logger.error(`on error, stop generating new blocks`)
            this.taskRunners.blockPropose.stop()
            break
          default:
            break
        }
      },
    )
    this.context.node.synchronizer.on('onFetched', (block: Block) => {
      this.context.txPool.markAsIncluded(block.body.txs)
    })
    this.context.node.blockProcessor.on('slash', challenge =>
      this.context.txPool.revert(challenge.block.header.txRoot.toString()),
    )
    this.context.node.blockProcessor.on('processed', proposal =>
      proposal.block
        ? this.context.txPool.drop(proposal.block.header.txRoot.toString())
        : undefined,
    )
    this.context.node.start()
    await Promise.all([
      this.context.auctionMonitor.start(),
      this.startSubscribeGasPrice(),
    ])
    this.api.start()
    this.taskRunners.blockFinalize.start({
      task: this.finalizeTask.bind(this),
      interval: 10000,
    })
    this.taskRunners.massDepositCommit.start({
      task: this.commitMassDepositTask.bind(this),
      interval: 10000,
    })
    this.emit('start')
  }

  async stop() {
    await Promise.all([
      this.taskRunners.blockPropose.close(),
      this.taskRunners.blockFinalize.close(),
      this.taskRunners.massDepositCommit.close(),
      this.context.node.stop(),
      this.context.auctionMonitor.stop(),
      this.api.stop(),
      this.stopGasPriceSubscription(),
    ])
    this.emit('stop')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async registerVk(
    nIn: number,
    nOut: number,
    vk: {
      vk_alpha_1: string[]
      vk_beta_2: string[][]
      vk_gamma_2: string[][]
      vk_delta_2: string[][]
      IC: string[][]
    },
  ): Promise<TransactionReceipt | undefined> {
    const tx = this.layer1().setup.methods.registerVk(nIn, nOut, {
      // caution: snarkjs G2Point is reversed
      alpha1: { X: vk.vk_alpha_1[0], Y: vk.vk_alpha_1[1] },
      beta2: { X: vk.vk_beta_2[0].reverse(), Y: vk.vk_beta_2[1].reverse() },
      gamma2: { X: vk.vk_gamma_2[0].reverse(), Y: vk.vk_gamma_2[1].reverse() },
      delta2: { X: vk.vk_delta_2[0].reverse(), Y: vk.vk_delta_2[1].reverse() },
      ic: vk.IC.map((ic: string[]) => ({
        X: ic[0],
        Y: ic[1],
      })),
    })
    return this.layer1().sendTx(tx, this.context.account)
  }

  async completeSetup(): Promise<TransactionReceipt | undefined> {
    const tx = this.layer1().setup.methods.completeSetup()
    return this.layer1().sendTx(tx, this.context.account)
  }

  async bidAuctions(): Promise<void> {
    const consensus = await this.layer1()
      .upstream.methods.consensusProvider()
      .call()
    const auction = Layer1.getIBurnAuction(this.layer1().web3, consensus)
    const [currentRound, url] = await Promise.all([
      auction.methods.currentRound().call(),
      auction.methods.coordinatorUrls(this.context.account.address).call(),
    ])
    if (+currentRound !== this.currentRound) {
      this.currentRound = +currentRound
      logger.info(`Current auction round: ${currentRound}`)
    }
    if (!url) {
      // Set a url
      // TODO: determine apparent external ip/port
      const urlTx = auction.methods.setUrl('http://localhost')
      await this.layer1().sendExternalTx(urlTx, this.context.account, consensus)
    }
    const futureRounds = 20
    const maxPrice = new BN((100000 * 10 ** 9).toString())
    const startRound = +(await auction.methods.currentRound().call()) + 3
    const promises = [] as Promise<TransactionReceipt | undefined>[]

    for (let x = startRound; x < startRound + futureRounds; x += 1) {
      const currentWinner = await auction.methods.coordinatorForRound(x).call()
      if (
        currentWinner.toString().toLowerCase() ===
        this.context.account.address.toLowerCase()
      ) {
        // Already highest bidder for this round
        // eslint-disable-next-line no-continue
        continue
      }
      const nextBid = await auction.methods.minNextBid(x).call()
      if (new BN(nextBid).gt(maxPrice)) {
        // price too high
        // eslint-disable-next-line no-continue
        continue
      }
      logger.info(`Bidding on round ${x}`)
      const tx = auction.methods.bid(x)
      promises.push(
        this.layer1().sendExternalTx(tx, this.context.account, consensus, {
          value: nextBid,
        }),
      )
    }
    await Promise.all(promises)
  }

  async registerAsCoordinator(): Promise<TransactionReceipt | undefined> {
    const { minimumStake } = this.layer2().config
    const consensus = await this.layer1()
      .upstream.methods.consensusProvider()
      .call()
    const tx = Layer1.getIBurnAuction(
      this.layer1().web3,
      consensus,
    ).methods.register()
    return this.layer1().sendTx(tx, this.context.account, {
      value: minimumStake,
    })
  }

  async deregister(): Promise<TransactionReceipt | undefined> {
    const tx = this.layer1().coordinator.methods.deregister()
    return this.layer1().sendTx(tx, this.context.account)
  }

  private async proposeTask() {
    if (this.proposeLock.isBusy('propose')) return
    await this.proposeLock.acquire('propose', async () => {
      logger.trace(`try to propose a new block`)
      if (!this.context.gasPrice) {
        logger.trace('Skip gen block. Gas price is not synced yet')
        return
      }
      if (!this.context.node.synchronizer.isSynced()) {
        logger.trace(
          `Skip gen block. Syncing layer 2 with the layer 1 - status: ${this.context.node.synchronizer.status}`,
        )
        return
      }
      const isProposable = await this.layer1()
        .upstream.methods.isProposable(this.context.account.address)
        .call()
      if (isProposable) {
        await this.proposeBlock()
      } else {
        await this.forwardTxs()
      }
    })
  }

  private async proposeBlock() {
    let block: Block
    try {
      block = await this.middlewares.generator.genBlock()
    } catch (err) {
      logger.warn(`Failed to gen block: ${err}`)
      return
    }
    try {
      const receipt = await this.middlewares.proposer.propose(block)
      if (receipt?.status) {
        await this.context.node.synchronizer.updateStatus()
      }
    } catch (err) {
      logger.error(`Error occurred during block proposing.`)
      logger.error(err)
    }
  }

  private async forwardTxs() {
    const { auctionMonitor } = this.context
    logger.info(`Skipping block proposal: Not current round owner`)
    // get pending tx and forward to active proposer
    const pendingTx = await this.context.txPool.pickTxs(Infinity, new BN('1'))
    if (!pendingTx?.length) return
    const url = await auctionMonitor.functionalCoordinatorUrl(
      auctionMonitor.currentProposer,
    )
    if (!url) {
      logger.warn('No functional url to forward pending tx!')
      return
    }
    for (const tx of pendingTx) {
      // forward
      await fetch(`${url}/tx`, {
        method: 'post',
        body: tx.encode().toString('hex'),
      })
    }
  }

  async commitMassDepositTask(): Promise<TransactionReceipt | undefined> {
    const stagedDeposits = await this.layer1()
      .upstream.methods.stagedDeposits()
      .call()
    if (
      Uint256.from(stagedDeposits.fee)
        .toBN()
        .gtn(0)
    ) {
      const tx = this.layer1().coordinator.methods.commitMassDeposit()
      return this.layer1().sendTx(tx, this.context.account)
    }
    return undefined
  }

  private async finalizeTask() {
    const finalization = await this.genFinalization()
    if (!finalization) return
    logger.info('finalization')
    const blockHash = headerHash(finalization.header).toString()
    const tx = this.layer1().coordinator.methods.finalize(
      `0x${serializeFinalization(finalization).toString('hex')}`,
    )
    let finalizable = false
    try {
      await tx.call({ from: this.context.account.address })
      finalizable = true
    } catch (err) {
      logger.error(err)
      return
    }
    if (finalizable) {
      try {
        const receipt = await this.layer1().sendTx(tx, this.context.account)
        if (receipt) {
          await this.layer2().db.write(prisma =>
            prisma.proposal.update({
              where: { hash: blockHash },
              data: { finalized: true },
            }),
          )
          logger.info(`finalized block ${blockHash}`)
        } else {
          logger.warn(`Failed to finalize the block ${blockHash}`)
        }
      } catch (err) {
        logger.error(err)
      }
    }
  }

  private async genFinalization(): Promise<Finalization | undefined> {
    const latest = await this.layer1()
      .upstream.methods.latest()
      .call()
    const currentBlockNumber: number = await this.layer1().web3.eth.getBlockNumber()
    const l1Config = await this.layer1().getConfig()
    const unfinalizedProposals = await this.layer2().db.read(prisma =>
      prisma.proposal.findMany({
        where: {
          AND: [
            { finalized: null },
            { block: { header: { parentBlock: latest } } },
            { verified: true },
            { isUncle: null },
            { proposalData: { not: null } },
            {
              proposedAt: {
                lt: currentBlockNumber - l1Config.challengePeriod,
              },
            },
          ],
        },
        take: 1,
      }),
    )
    const proposalToFinalize = unfinalizedProposals[0]
    if (!proposalToFinalize) return undefined
    assert(proposalToFinalize.proposalData)

    const tx = JSON.parse(proposalToFinalize.proposalData)
    const block = Block.fromTx(tx, true)

    const finalization: Finalization = block.getFinalization()
    logger.trace(`latest: ${latest}`)
    logger.trace(`finalization block: ${block.hash.toString()}`)
    logger.trace(
      `header deposit root: ${finalization.header.depositRoot.toString()}`,
    )
    logger.trace(
      `calculated root: ${root(
        finalization.massDeposits.map(massDepositHash),
      )}`,
    )
    return finalization
  }

  private async startSubscribeGasPrice() {
    if (this.gasPriceSubscriber) return
    this.context.gasPrice = Field.from(
      await this.layer1().web3.eth.getGasPrice(),
    )
    this.gasPriceSubscriber = this.layer1()
      .web3.eth.subscribe('newBlockHeaders')
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .on('data', async _ => {
        this.context.gasPrice = Field.from(
          await this.layer1().web3.eth.getGasPrice(),
        )
      })
  }

  private async stopGasPriceSubscription() {
    if (!this.gasPriceSubscriber) return
    try {
      await this.gasPriceSubscriber.unsubscribe()
    } catch (e) {
      logger.error(e.toString())
    } finally {
      this.gasPriceSubscriber = undefined
    }
  }
}
