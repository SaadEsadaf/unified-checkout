const PaymentPlugin = require('./base')

class EmailLinkPlugin extends PaymentPlugin {
  get name() { return 'email-link' }
  get label() { return 'Email Payment Link' }
  get icon() { return '📧' }
  get description() { return 'Receive a payment link by email' }

  getConfigSchema() {
    return {}
  }

  async createPayment(order) {
    return {
      manual: true,
      method: 'email-link',
      email: order.email,
      amount: order.plan.price_sell,
      paymentUrl: `${order.siteUrl}/checkout?order=${order.id}`,
      metadata: { order_id: order.id },
    }
  }

  async handleWebhook() {
    return { handled: false, error: 'Email link requires manual processing' }
  }

  async handleReturn() {
    return { handled: false, error: 'Email link has no return URL' }
  }
}

module.exports = EmailLinkPlugin
