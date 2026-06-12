const crypto = require('crypto')
const PaymentPlugin = require('./base')

const API_BASE = 'https://sellup.io/api/v1'

class SellupPlugin extends PaymentPlugin {
  get name() { return 'sellup' }
  get label() { return 'Sellup' }
  get icon() { return '🛒' }
  get description() { return 'Pay securely via Sellup' }

  getConfigSchema() {
    return {
      sellup_api_key: { type: 'string', secret: true, required: false },
      sellup_store_id: { type: 'string', secret: false, required: true },
      sellup_webhook_secret: { type: 'string', secret: true, required: false },
    }
  }

  get _apiKey() {
    const key = this.config.sellup_api_key
    return key && key !== 'your_sellup_api_key_here' ? key : null
  }

  get _store() { return this.config.sellup_store_id || 'app' }

  _generateCheckoutUrl(productId) {
    return `https://${this._store}.sellup.io/checkout/${productId}`
  }

  async createPayment(order) {
    const productId = order.plan.sellup_product_id
    if (!productId) throw new Error('No Sellup product ID mapped to this plan')

    const checkoutUrl = this._generateCheckoutUrl(productId)
    if (checkoutUrl) {
      return {
        url: checkoutUrl,
        method: 'sellup',
        metadata: { sellup_store_id: this._store, sellup_product_id: productId },
      }
    }

    if (this._apiKey) {
      try {
        const res = await fetch(`${API_BASE}/orders`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this._apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            product_id: productId,
            metadata: { internal_order_id: order.id },
          }),
        })
        if (res.ok) {
          const data = await res.json()
          return {
            url: data.checkout_url || checkoutUrl,
            method: 'sellup',
            metadata: { sellup_order_id: data.id },
          }
        }
      } catch {}
    }

    const fallbackUrl = `${order.siteUrl}/checkout?order=${order.id}`
    return {
      url: fallbackUrl,
      method: 'sellup',
      metadata: { fallback: true },
    }
  }

  async handleWebhook(event) {
    if (event.event !== 'order.completed') return { handled: false }

    const metadata = event.data?.metadata || {}
    const internalOrderId = metadata.internal_order_id
    if (!internalOrderId) return { handled: false, error: 'Missing internal_order_id' }

    return {
      handled: true,
      method: 'sellup',
      orderId: internalOrderId,
      paymentId: event.data?.id,
      raw: event,
    }
  }

  async handleReturn(query) {
    return { handled: false, error: 'Sellup uses webhooks, not return URLs' }
  }

  verifyWebhookSignature(body, signature, rawBody) {
    const secret = this.config.sellup_webhook_secret
    if (!secret || secret === 'your_sellup_webhook_secret_here') return true

    try {
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    } catch {
      return false
    }
  }
}

module.exports = SellupPlugin
