class PaymentPlugin {
  constructor(config = {}) {
    this.config = config
    if (this.constructor === PaymentPlugin) {
      throw new Error('PaymentPlugin is abstract — extend it')
    }
  }

  get name() { throw new Error('Plugin must implement get name()') }
  get label() { return this.name }
  get icon() { return '💳' }
  get description() { return '' }

  isConfigured() {
    const schema = this.getConfigSchema()
    for (const [key, field] of Object.entries(schema)) {
      if (field.required && !this.config[key]) return false
    }
    return true
  }

  getConfigSchema() { return {} }

  getPublicConfig() {
    const schema = this.getConfigSchema()
    const pub = {}
    for (const [key, field] of Object.entries(schema)) {
      if (!field.secret) pub[key] = this.config[key]
    }
    return pub
  }

  async createPayment(order) {
    throw new Error(`Plugin ${this.name} must implement createPayment()`)
  }

  async handleWebhook(event) {
    throw new Error(`Plugin ${this.name} must implement handleWebhook()`)
  }

  async handleReturn(query) {
    throw new Error(`Plugin ${this.name} must implement handleReturn()`)
  }

  verifyWebhookSignature(body, signature, rawBody) {
    return false
  }
}

module.exports = PaymentPlugin
