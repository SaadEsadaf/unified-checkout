const PaymentPlugin = require('./base')

class SEPAPlugin extends PaymentPlugin {
  get name() { return 'sepa' }
  get label() { return 'SEPA Transfer' }
  get icon() { return '🏦' }
  get description() { return 'Bank transfer within EU (SEPA)' }

  getConfigSchema() {
    return {
      sepa_iban: { type: 'string', secret: false, required: true },
      sepa_bic: { type: 'string', secret: false, required: false },
      sepa_bank_name: { type: 'string', secret: false, required: false },
      sepa_holder_name: { type: 'string', secret: false, required: false },
    }
  }

  async createPayment(order) {
    return {
      manual: true,
      method: 'sepa',
      bankDetails: {
        iban: this.config.sepa_iban,
        bic: this.config.sepa_bic,
        bankName: this.config.sepa_bank_name,
        holderName: this.config.sepa_holder_name,
      },
      amount: order.plan.price_sell,
      currency: 'EUR',
      reference: `ORDER-${order.id}-${Date.now().toString(36).toUpperCase()}`,
      metadata: { order_id: order.id },
    }
  }

  async handleWebhook() {
    return { handled: false, error: 'SEPA requires manual confirmation' }
  }

  async handleReturn() {
    return { handled: false, error: 'SEPA uses bank transfer, no return URL' }
  }
}

module.exports = SEPAPlugin
