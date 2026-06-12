const Stripe = require('stripe')
const PaymentPlugin = require('./base')

class StripePlugin extends PaymentPlugin {
  get name() { return 'stripe' }
  get label() { return 'Credit Card' }
  get icon() { return '💳' }
  get description() { return 'Pay by credit card via Stripe' }

  getConfigSchema() {
    return {
      stripe_secret_key: { type: 'string', secret: true, required: true },
      stripe_publishable_key: { type: 'string', secret: false, required: true },
      stripe_webhook_secret: { type: 'string', secret: true, required: false },
      stripe_webhook_secret_test: { type: 'string', secret: true, required: false },
    }
  }

  _getStripe() {
    if (!this.config.stripe_secret_key) return null
    return new Stripe(this.config.stripe_secret_key)
  }

  async createPayment(order) {
    const stripe = this._getStripe()
    if (!stripe) throw new Error('Stripe not configured')

    const priceId = order.plan.stripe_price_id
    if (!priceId) throw new Error('No Stripe price ID mapped to this plan')

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: order.email,
      metadata: {
        actual_plan_id: String(order.plan.id),
        order_id: String(order.id),
        website_id: String(order.website_id || '1'),
      },
      success_url: order.returnUrl || `${order.siteUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: order.cancelUrl || `${order.siteUrl}/payment/cancel`,
    })

    return {
      url: session.url,
      sessionId: session.id,
      metadata: { stripe_session_id: session.id },
    }
  }

  async handleWebhook(event) {
    if (event.type !== 'checkout.session.completed') return { handled: false }

    const session = event.data.object
    const metadata = session.metadata || {}
    const actualPlanId = metadata.actual_plan_id
    const orderId = metadata.order_id

    if (!actualPlanId || !orderId) {
      return { handled: false, error: 'Missing metadata' }
    }

    const stripePaymentId = session.payment_intent || session.id
    return {
      handled: true,
      method: 'stripe',
      orderId,
      paymentId: stripePaymentId,
      raw: session,
    }
  }

  async handleReturn(query) {
    const { session_id } = query
    if (!session_id) throw new Error('Missing session_id')

    const stripe = this._getStripe()
    if (!stripe) throw new Error('Stripe not configured')

    const session = await stripe.checkout.sessions.retrieve(session_id)
    if (session.payment_status !== 'paid') {
      throw new Error('Payment not completed')
    }

    return {
      method: 'stripe',
      orderId: session.metadata?.order_id,
      paymentId: session.payment_intent || session.id,
      raw: session,
    }
  }

  verifyWebhookSignature(body, signature, rawBody) {
    try {
      const stripe = this._getStripe()
      if (!stripe) return false
      const secret = this.config.stripe_webhook_secret
      if (!secret) return false
      stripe.webhooks.constructEvent(rawBody, signature, secret)
      return true
    } catch {
      return false
    }
  }
}

module.exports = StripePlugin
