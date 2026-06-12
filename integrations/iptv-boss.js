const path = require('path')
const unifiedCheckout = require('/var/www/unified-checkout')

function integrateWithIptvBoss(app, deps) {
  const getDb = deps.getDb
  const configs = loadPaymentConfigs(getDb)

  const IPTV_BOSS_SERVER = path.join(__dirname, '..', '..', '..', 'iptv-boss', 'server')

  function requireIptvService(name) {
    return require(path.join(IPTV_BOSS_SERVER, 'services', name))
  }

  const { router } = unifiedCheckout({
    basePath: '/api/checkout',
    plugins: ['stripe', 'paypal', 'sellup', 'crypto', 'sepa', 'email-link'],
    pluginConfigs: configs,
    siteUrl: process.env.SITE_URL || 'https://dalletek.live',
    successUrl: '/payment/success',
    cancelUrl: '/payment/cancel',
    db: getDb,
    cloakEnabled: true,
    cloakConfigPath: path.join(__dirname, '..', 'config', 'cloak.json'),
    onOrderComplete: async (result) => {
      const db2 = getDb()

      try {
        const order = db2.prepare('SELECT * FROM orders WHERE id = ?').get(result.orderId)
        if (!order) return
        if (order.status === 'completed') return

        const paymentIdField = result.method === 'stripe' ? 'stripe_payment_id' :
                               result.method === 'paypal' ? 'paypal_payment_id' :
                               result.method === 'sellup' ? 'sellup_order_id' : 'payment_id'

        db2.prepare(
          `UPDATE orders SET status = 'completed', ${paymentIdField} = ?, payment_confirmed_at = datetime('now') WHERE id = ?`
        ).run(result.paymentId || '', result.orderId)

        const emailService = requireIptvService('emailService')
        await emailService.sendThankYou({ email: order.customer_email, name: order.customer_name })

        const { assignCode } = requireIptvService('codeAssigner')
        const credentials = assignCode(result.orderId, order.provider_id, order.plan_id)
        if (credentials) {
          const codeRow = db2.prepare('SELECT id FROM activation_codes WHERE used_by_order_id = ?').get(result.orderId)
          if (codeRow) {
            db2.prepare('UPDATE orders SET activation_code_id = ? WHERE id = ?').run(codeRow.id, result.orderId)
          }

          setTimeout(async () => {
            try {
              await emailService.sendCredentials({ email: order.customer_email, name: order.customer_name, credentials })
              db2.prepare("UPDATE orders SET credentials_sent_at = datetime('now') WHERE id = ?").run(result.orderId)
            } catch (e) {
              console.error('[Checkout] Delayed credentials error:', e.message)
            }
          }, 3 * 60 * 1000)

          db2.prepare('INSERT INTO agent_log (agent, action, details, order_id) VALUES (?, ?, ?, ?)')
            .run('System', 'payment_completed',
              `${result.method} payment ${result.paymentId} confirmed for order ${result.orderId}`,
              result.orderId)
        } else {
          console.error(`[Checkout] No codes available for order ${result.orderId}`)
          db2.prepare('INSERT INTO agent_log (agent, action, details, order_id) VALUES (?, ?, ?, ?)')
            .run('System', 'stock_issue', `No codes available for order ${result.orderId}`, result.orderId)
        }

        db2.prepare('UPDATE chat_sessions SET converted = 1 WHERE id = ?').run(order.session_id)

        try {
          const { notificationService } = requireIptvService('notificationService')
          if (notificationService?.sendNotification) {
            notificationService.sendNotification({
              type: 'payment',
              message: `${result.method.toUpperCase()} payment €${order.price} completed for order #${result.orderId}`,
            })
          }
        } catch {}
      } catch (err) {
        console.error('[Checkout] onOrderComplete error:', err.message)
      }
    },
  })

  app.use('/api/checkout', router)

  return router
}

function loadPaymentConfigs(getDb) {
  const configs = {}
  const keys = {
    stripe: ['stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret'],
    paypal: ['paypal_client_id', 'paypal_client_secret', 'paypal_mode', 'paypal_email'],
    sellup: ['sellup_api_key', 'sellup_store_id', 'sellup_webhook_secret'],
    crypto: ['crypto_address_usdt', 'crypto_address_btc'],
    sepa: ['sepa_iban', 'sepa_bic', 'sepa_bank_name', 'sepa_holder_name'],
  }

  try {
    if (!getDb) return configs
    const db = getDb()

    for (const [plugin, pluginKeys] of Object.entries(keys)) {
      configs[plugin] = {}
      for (const key of pluginKeys) {
        try {
          const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)
          configs[plugin][key] = row?.value || process.env[key.toUpperCase()] || ''
        } catch {
          configs[plugin][key] = process.env[key.toUpperCase()] || ''
        }
      }
    }
  } catch {}

  return configs
}

module.exports = { integrateWithIptvBoss }
