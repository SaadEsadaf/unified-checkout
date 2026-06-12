const PaymentPlugin = require('./base')

class CryptoPlugin extends PaymentPlugin {
  get name() { return 'crypto' }
  get label() { return 'Crypto' }
  get icon() { return '₿' }
  get description() { return 'Pay with USDT (TRC20) or Bitcoin' }

  getConfigSchema() {
    return {
      crypto_address_usdt: { type: 'string', secret: false, required: true },
      crypto_address_btc: { type: 'string', secret: false, required: false },
    }
  }

  async createPayment(order) {
    return {
      manual: true,
      method: 'crypto',
      addresses: {
        usdt: this.config.crypto_address_usdt,
        btc: this.config.crypto_address_btc,
      },
      amount: order.plan.price_sell,
      currency: 'USD',
      network: 'USDT (TRC20) / BTC',
      metadata: { order_id: order.id },
    }
  }

  async handleWebhook() {
    return { handled: false, error: 'Crypto requires manual confirmation' }
  }

  async handleReturn() {
    return { handled: false, error: 'Crypto uses manual transfer, no return URL' }
  }
}

module.exports = CryptoPlugin
