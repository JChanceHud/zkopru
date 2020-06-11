import { TransactionReceipt } from 'web3-core'
import { logger } from '@zkopru/utils'
import App, { AppMenu, Context } from '../../app'

export default class CommitDeposits extends App {
  static code = AppMenu.COMMIT_DEPOSITS

  async run(context: Context): Promise<{ context: Context; next: number }> {
    logger.info('Commit depostis')
    let receipt!: TransactionReceipt
    try {
      receipt = await this.base.commitMassDeposit()
    } catch (err) {
      logger.error(err)
    } finally {
      if (receipt && receipt.status) {
        logger.info('Successfully committed the latest mass deposit')
      } else {
        logger.error('Failed to commit the latest mass deposit')
      }
    }
    return { context, next: AppMenu.SETUP_MENU }
  }
}
