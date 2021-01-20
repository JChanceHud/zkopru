import chalk from 'chalk'
import Web3 from 'web3'
import crypto from 'crypto'
import fs from 'fs'
import { PromptApp, makePathAbsolute } from '@zkopru/utils'
import { Config } from '../../configurator/configurator'
import { Menu } from '../menu'

export default class Wallet extends PromptApp<Config, Config> {
  static code = Menu.CREATE_WALLET

  async run(context: Config): Promise<{ context: Config; next: number }> {
    console.log(chalk.blue(`Create a wallet?`))
    const { create } = await this.ask({
      type: 'confirm',
      name: 'create',
      message: `Would you like to create a wallet?`,
      initial: true,
    })
    if (!create) {
      return { context, next: Menu.SET_PUBLIC_URLS }
    }
    const web3 = new Web3()
    const account = web3.eth.accounts.create()
    const securePassword = crypto.randomBytes(32).toString('hex')
    const { password } = await this.ask({
      type: 'password',
      name: 'password',
      message: `Enter a password to encrypt (leave blank to use secure password):`,
      initial: securePassword,
    })
    const keystore = account.encrypt(password)
    const { passwordFile } = await this.ask({
      type: 'text',
      name: 'passwordFile',
      message: 'Enter a path where the password should be stored',
      initial: `${makePathAbsolute('./password.secret')}`,
    })
    fs.writeFileSync(passwordFile, password)
    return {
      context: {
        ...context,
        keystore,
        passwordFile,
      },
      next: Menu.SET_PUBLIC_URLS,
    }
  }
}
