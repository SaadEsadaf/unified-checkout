const path = require('path')
const express = require('express')
const PluginRegistry = require('./plugins/registry')
const { tryPayment } = require('./plugins/failover')
const { createCloakMiddleware } = require('./middleware/cloak')

const BUILTIN_PLUGINS = {
  stripe: './plugins/stripe',
  paypal: './plugins/paypal',
  sellup: './plugins/sellup',
  crypto: './plugins/crypto',
  sepa: './plugins/sepa',
  'email-link': './plugins/email-link',
}

function unifiedCheckout(userConfig = {}) {
  const config = {
    basePath: userConfig.basePath || '/api/checkout',
    plugins: userConfig.plugins || ['stripe', 'paypal', 'sellup', 'crypto', 'sepa', 'email-link'],
    pluginConfigs: userConfig.pluginConfigs || {},
    successUrl: userConfig.successUrl || '/payment/success',
    cancelUrl: userConfig.cancelUrl || '/payment/cancel',
    siteUrl: userConfig.siteUrl || 'http://localhost:3000',
    onOrderComplete: userConfig.onOrderComplete || (async () => {}),
    onTrialClaim: userConfig.onTrialClaim || (async () => {}),
    db: userConfig.db || null,
    cloakEnabled: userConfig.cloakEnabled !== false,
    cloakConfigPath: userConfig.cloakConfigPath || path.join(__dirname, 'config', 'cloak.json'),
  }

  const registry = new PluginRegistry()

  for (const pluginName of config.plugins) {
    try {
      const pluginPath = BUILTIN_PLUGINS[pluginName]
      if (!pluginPath) {
        console.warn(`[Checkout] Unknown plugin: ${pluginName}`)
        continue
      }
      const PluginClass = require(pluginPath)
      const pluginConfig = config.pluginConfigs[pluginName] || {}
      const plugin = new PluginClass(pluginConfig)
      registry.register(plugin)
    } catch (err) {
      console.warn(`[Checkout] Failed to load plugin ${pluginName}:`, err.message)
    }
  }

  const router = express.Router()

  if (config.cloakEnabled) {
    router.use(createCloakMiddleware(config.cloakConfigPath))
  }

  // ==================== Settings ====================
  router.get('/settings', (req, res) => {
    const plugins = registry.getPublicConfigs()
    res.json({
      siteName: (() => {
        try {
          if (config.db) {
            const row = config.db().prepare("SELECT value FROM app_settings WHERE key = 'site_name'").get()
            return row?.value || 'Store'
          }
        } catch {}
        return 'Store'
      })(),
      plugins,
      currencies: ['EUR', 'USD', 'GBP'],
    })
  })

  // ==================== Create Payment ====================
  router.post('/create', express.json(), async (req, res) => {
    try {
      const { plan, email, name, phone, websiteId } = req.body

      if (!plan || !plan.id || !plan.price_sell) {
        return res.status(400).json({ error: 'Plan with id and price_sell required' })
      }

      if (!email && !name) {
        return res.status(400).json({ error: 'Email or name required' })
      }

      let orderId
      try {
        if (config.db) {
          const db = config.db()
          const result = db.prepare(`
            INSERT INTO orders (customer_email, customer_name, customer_phone, provider_id, plan_id, status, plan_price, currency, website_id, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
          `).run(
            email || null, name || null, phone || null,
            plan.provider_id || null, plan.id,
            plan.price_sell, plan.currency || 'EUR', websiteId || 1
          )
          orderId = result.lastInsertRowid
        } else {
          orderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        }
      } catch (err) {
        return res.status(500).json({ error: `Failed to create order: ${err.message}` })
      }

      const order = {
        id: orderId,
        plan,
        email,
        name,
        phone,
        website_id: websiteId || '1',
        siteUrl: config.siteUrl,
        returnUrl: `${config.siteUrl}${config.basePath}/return/${'{method}'}?order_id=${orderId}`,
        cancelUrl: `${config.siteUrl}${config.cancelUrl}`,
      }

      const result = await tryPayment(registry, order)

      if (result.success) {
        const plugin = registry.get(result.method)
        const orderUpdate = {}
        if (result.result.metadata) {
          orderUpdate.metadata = result.result.metadata
        }

        res.json({
          success: true,
          method: result.method,
          url: result.result.url || null,
          manual: result.result.manual || false,
          details: result.result,
          orderId,
          label: plugin?.label || result.method,
          icon: plugin?.icon || '💳',
        })
      } else {
        res.json({
          success: false,
          error: result.error,
          failures: result.failures,
          orderId,
        })
      }
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ==================== Failover ====================
  router.post('/failover', express.json(), async (req, res) => {
    try {
      const { plan, email, name, phone, websiteId, orderId, failedMethod } = req.body

      if (!plan || !failedMethod) {
        return res.status(400).json({ error: 'Plan and failedMethod required' })
      }

      const order = {
        id: orderId,
        plan,
        email,
        name,
        phone,
        website_id: websiteId || '1',
        siteUrl: config.siteUrl,
        returnUrl: `${config.siteUrl}${config.basePath}/return/paypal?order_id=${orderId}`,
        cancelUrl: `${config.siteUrl}${config.cancelUrl}`,
      }

      const result = await tryPayment(registry, order, [failedMethod])

      if (result.success) {
        const plugin = registry.get(result.method)
        res.json({
          success: true,
          method: result.method,
          url: result.result.url || null,
          manual: result.result.manual || false,
          details: result.result,
          orderId,
          label: plugin?.label || result.method,
          icon: plugin?.icon || '💳',
          failures: result.failures,
        })
      } else {
        res.json({
          success: false,
          error: result.error,
          failures: result.failures,
          orderId,
        })
      }
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ==================== Payment Return (redirect handler) ====================
  router.get('/return/:method', async (req, res) => {
    try {
      const plugin = registry.get(req.params.method)
      if (!plugin) {
        return res.redirect(`${config.cancelUrl}?error=unknown_method`)
      }

      const result = await plugin.handleReturn(req.query)

      if (result.method === 'paypal') {
        try {
          await config.onOrderComplete({
            orderId: result.orderId,
            method: 'paypal',
            paymentId: result.paymentId,
            raw: result.raw,
          })
        } catch {}
        return res.redirect(`${config.successUrl}?paypal_order_id=${result.paymentId}`)
      }

      res.redirect(`${config.cancelUrl}?error=unhandled_return`)
    } catch (err) {
      res.redirect(`${config.cancelUrl}?error=${encodeURIComponent(err.message)}`)
    }
  })

  // ==================== Webhook Handler ====================
  router.post('/webhook/:method', (req, res) => {
    const plugin = registry.get(req.params.method)
    if (!plugin) {
      return res.status(400).json({ error: `Unknown payment method: ${req.params.method}` })
    }

    try {
      const rawBody = req.rawBody
      const body = req.body
      const signature = req.headers['stripe-signature'] || req.headers['x-sellup-signature'] || ''

      if (plugin.verifyWebhookSignature) {
        const valid = plugin.verifyWebhookSignature(body, signature, rawBody)
        if (!valid) {
          return res.status(401).json({ error: 'Invalid webhook signature' })
        }
      }

      plugin.handleWebhook(body).then(result => {
        if (result.handled) {
          config.onOrderComplete({
            orderId: result.orderId,
            method: result.method,
            paymentId: result.paymentId,
            raw: result.raw,
          }).catch(() => {})
        }
        res.json({ received: true, ...result })
      }).catch(err => {
        res.status(400).json({ error: err.message })
      })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // ==================== Verify Payment Status ====================
  router.get('/status/:method', express.json(), async (req, res) => {
    try {
      const plugin = registry.get(req.params.method)
      if (!plugin) {
        return res.status(400).json({ error: `Unknown payment method: ${req.params.method}` })
      }

      const result = await plugin.handleReturn(req.query)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // ==================== Plugin Info ====================
  router.get('/plugins', (req, res) => {
    res.json({
      available: registry.getPluginNames(),
      configured: registry.getConfigured().map(p => ({
        name: p.name,
        label: p.label,
        icon: p.icon,
        description: p.description,
      })),
    })
  })

  return { router, registry }
}

module.exports = unifiedCheckout
