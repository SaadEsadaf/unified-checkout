const PaymentPlugin = require('./base')

const API_BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
}

class PayPalPlugin extends PaymentPlugin {
  get name() { return 'paypal' }
  get label() { return 'PayPal' }
  get icon() { return '💳' }
  get description() { return 'Pay with PayPal or credit card' }

  getConfigSchema() {
    return {
      paypal_client_id: { type: 'string', secret: false, required: true },
      paypal_client_secret: { type: 'string', secret: true, required: true },
      paypal_mode: { type: 'string', secret: false, required: false },
      paypal_email: { type: 'string', secret: false, required: false },
    }
  }

  get _mode() { return this.config.paypal_mode || 'live' }
  get _baseUrl() { return API_BASE[this._mode] || API_BASE.live }

  isConfigured() {
    const { paypal_client_id, paypal_client_secret } = this.config
    return !!(
      paypal_client_id && paypal_client_secret &&
      paypal_client_id !== 'your_paypal_client_id_here' &&
      paypal_client_secret !== 'your_paypal_client_secret_here'
    )
  }

  async _getAccessToken() {
    const res = await fetch(`${this._baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${this.config.paypal_client_id}:${this.config.paypal_client_secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    if (!res.ok) throw new Error(`PayPal auth error ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return data.access_token
  }

  async createPayment(order) {
    if (order.plan.paypal_link) {
      return {
        url: order.plan.paypal_link,
        method: 'paypal',
        metadata: { paypal_link: order.plan.paypal_link },
      }
    }

    if (!this.isConfigured()) {
      if (this.config.paypal_email) {
        return {
          manual: true,
          method: 'paypal',
          paypalEmail: this.config.paypal_email,
          amount: order.plan.price_sell,
          metadata: { paypal_email: this.config.paypal_email },
        }
      }
      throw new Error('PayPal not configured')
    }

    const token = await this._getAccessToken()
    const returnUrl = order.returnUrl || `${order.siteUrl}/api/checkout/return/paypal?order_id=${order.id}`
    const cancelUrl = order.cancelUrl || `${order.siteUrl}/payment/cancel`

    const res = await fetch(`${this._baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: String(order.id),
          description: `Order #${order.id}`,
          amount: {
            currency_code: order.currency || 'EUR',
            value: String(order.plan.price_sell),
          },
        }],
        payment_source: {
          paypal: {
            experience_context: {
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              landing_page: 'LOGIN',
              user_action: 'PAY_NOW',
              return_url: returnUrl,
              cancel_url: cancelUrl,
            },
          },
        },
      }),
    })

    if (!res.ok) throw new Error(`PayPal create order error ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const approvalUrl = data.links?.find(l => l.rel === 'payer-action')?.href

    return {
      url: approvalUrl,
      method: 'paypal',
      metadata: { paypal_order_id: data.id },
    }
  }

  async handleWebhook(event) {
    return { handled: false, error: 'PayPal uses redirect-based capture, not webhooks' }
  }

  async handleReturn(query) {
    const { order_id, token: paypalOrderId } = query
    if (!paypalOrderId && !order_id) throw new Error('Missing PayPal order token')

    const token = await this._getAccessToken()
    const orderId = paypalOrderId || query.token

    const res = await fetch(`${this._baseUrl}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (!res.ok) throw new Error(`PayPal capture error ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0]

    if (data.status !== 'COMPLETED') {
      throw new Error(`PayPal payment not completed: ${data.status}`)
    }

    return {
      method: 'paypal',
      orderId: order_id,
      paymentId: capture?.id,
      raw: data,
    }
  }
}

module.exports = PayPalPlugin
