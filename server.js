require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const express = require('express')
const cors = require('cors')
const path = require('path')
const crypto = require('crypto')
const { getDb } = require('./db')
const unifiedCheckout = require('./index')
const { createCloakMiddleware } = require('./middleware/cloak')

const app = express()
const PORT = process.env.PORT || 3003
const db = getDb()

app.use(cors({ origin: '*', credentials: true }))
app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname, 'client')))

// ==================== Load Payment Configs from DB ====================
function loadConfigs() {
  const configs = {}
  const keys = {
    stripe: ['stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret'],
    paypal: ['paypal_client_id', 'paypal_client_secret', 'paypal_mode', 'paypal_email'],
    sellup: ['sellup_api_key', 'sellup_store_id', 'sellup_webhook_secret'],
    crypto: ['crypto_address_usdt', 'crypto_address_btc'],
    sepa: ['sepa_iban', 'sepa_bic', 'sepa_bank_name', 'sepa_holder_name'],
  }
  for (const [plugin, pluginKeys] of Object.entries(keys)) {
    configs[plugin] = {}
    for (const key of pluginKeys) {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)
      configs[plugin][key] = row?.value || process.env[key.toUpperCase()] || ''
    }
  }
  return configs
}

// ==================== Internal API Client to Business Engine ====================
function getBusinessSecret() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'internal_api_secret'").get()
  return row?.value || process.env.INTERNAL_API_SECRET || 'dev-secret-change-in-production'
}

function getBusinessUrl() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'business_engine_url'").get()
  return row?.value || process.env.BUSINESS_ENGINE_URL || 'http://localhost:3001'
}

function signPayload(payload) {
  const secret = getBusinessSecret()
  const timestamp = Math.floor(Date.now() / 1000)
  const rawBody = JSON.stringify(payload)
  const sig = crypto.createHmac('sha256', secret).update(rawBody + String(timestamp)).digest('hex')
  return `${timestamp}.${sig}`
}

async function notifyBusiness(payload) {
  const url = `${getBusinessUrl()}/api/internal/fulfill`
  const signature = signPayload(payload)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Signature': signature,
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    return data
  } catch (err) {
    console.error('[PaymentEngine] Failed to notify Business Engine:', err.message)
    return { error: err.message }
  }
}

// ==================== Mount Unified Checkout ====================
const cloakEnabled = db.prepare("SELECT value FROM app_settings WHERE key = 'cloak_enabled'").get()?.value !== '0'

const { router } = unifiedCheckout({
  basePath: '/api/checkout',
  plugins: ['stripe', 'paypal', 'sellup', 'crypto', 'sepa', 'email-link'],
  pluginConfigs: loadConfigs(),
  siteUrl: process.env.SITE_URL || 'http://localhost:3003',
  successUrl: '/payment/success',
  cancelUrl: '/payment/cancel',
  db: getDb,
  cloakEnabled,
  cloakConfigPath: path.join(__dirname, 'config', 'cloak.json'),
  onOrderComplete: async (result) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.orderId)
    if (!order || order.status === 'completed') return

    db.prepare("UPDATE orders SET status = 'completed', payment_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(result.paymentId || '', result.orderId)

    const payload = {
      order_id: result.orderId,
      customer_email: order.customer_email,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      provider_id: order.provider_id,
      plan_id: order.plan_id,
      method: result.method,
      payment_id: result.paymentId,
      amount: order.plan_price,
      currency: order.currency,
      website_id: order.website_id,
    }

    const businessResult = await notifyBusiness(payload)
    if (businessResult?.success) {
      db.prepare("UPDATE orders SET business_order_id = ?, status = 'fulfilled', updated_at = datetime('now') WHERE id = ?")
        .run(businessResult.business_order_id, result.orderId)
    }
  },
})

app.use('/api/checkout', router)

// ==================== Points System ====================
// GET /api/credits/:email — check balance
app.get('/api/credits/:email', (req, res) => {
  const row = db.prepare('SELECT balance FROM prepaid_credits WHERE customer_email = ?').get(req.params.email)
  res.json({ email: req.params.email, balance: row?.balance || 0 })
})

// GET /api/credits/:email/history — transaction history
app.get('/api/credits/:email/history', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM credit_transactions WHERE customer_email = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.params.email)
  res.json(rows)
})

// POST /api/credits/purchase — buy credit package (returns payment URL)
app.post('/api/credits/purchase', express.json(), async (req, res) => {
  try {
    const { email, name, amount, package: pkg } = req.body
    if (!email || !amount || amount < 10) {
      return res.status(400).json({ error: 'Email and minimum €10 required' })
    }

    const plan = {
      id: `credits_${Date.now()}`,
      provider_id: null,
      price_sell: amount,
      currency: 'EUR',
      is_credits: true,
    }

    const result = db.prepare(`
      INSERT INTO orders (customer_email, customer_name, provider_id, plan_id, plan_name, plan_price, method, status, website_id, created_at)
      VALUES (?, ?, NULL, 'credits', ?, ?, 'credits', 'pending', ?, datetime('now'))
    `).run(email, name || null, `€${amount} Credits`, amount, req.body.website_id || 1)

    const order = {
      id: result.lastInsertRowid,
      plan,
      email,
      name,
      website_id: req.body.website_id || '1',
      siteUrl: process.env.SITE_URL || 'http://localhost:3003',
      returnUrl: '',
      cancelUrl: '/payment/cancel',
    }

    const { tryPayment } = require('./plugins/failover')
    const PluginRegistry = require('./plugins/registry')
    const registry = new PluginRegistry()
    const configs = loadConfigs()

    for (const name of ['stripe', 'paypal', 'sellup', 'crypto', 'sepa', 'email-link']) {
      try {
        const PluginClass = require(`./plugins/${name}`)
        const plugin = new PluginClass(configs[name] || {})
        registry.register(plugin)
      } catch {}
    }

    const payResult = await tryPayment(registry, order)

    if (payResult.success) {
      res.json({ success: true, method: payResult.method, url: payResult.result.url, manual: payResult.result.manual, orderId: result.lastInsertRowid })
    } else {
      res.json({ success: false, error: payResult.error, failures: payResult.failures })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/credits/add — add credits (called after payment confirmed)
app.post('/api/credits/add', express.json(), (req, res) => {
  const { email, amount, reference } = req.body
  if (!email || !amount) return res.status(400).json({ error: 'Email and amount required' })

  const existing = db.prepare('SELECT * FROM prepaid_credits WHERE customer_email = ?').get(email)
  if (existing) {
    db.prepare('UPDATE prepaid_credits SET balance = balance + ?, updated_at = datetime(\'now\') WHERE customer_email = ?').run(amount, email)
  } else {
    db.prepare('INSERT INTO prepaid_credits (customer_email, balance) VALUES (?, ?)').run(email, amount)
  }

  db.prepare('INSERT INTO credit_transactions (customer_email, amount, type, reference) VALUES (?, ?, ?, ?)').run(email, amount, 'purchase', reference || null)
  res.json({ success: true, email, added: amount })
})

// POST /api/credits/spend — spend credits on a plan
app.post('/api/credits/spend', express.json(), async (req, res) => {
  try {
    const { email, plan, website_id } = req.body
    if (!email || !plan) return res.status(400).json({ error: 'Email and plan required' })

    const costCents = Math.round((plan.price_sell || 0) * 100)
    const row = db.prepare('SELECT balance FROM prepaid_credits WHERE customer_email = ?').get(email)
    if (!row || row.balance < costCents) {
      return res.status(400).json({ error: 'Insufficient credits' })
    }

    db.prepare('UPDATE prepaid_credits SET balance = balance - ?, updated_at = datetime(\'now\') WHERE customer_email = ?').run(costCents, email)

    const orderResult = db.prepare(`
      INSERT INTO orders (customer_email, method, provider_id, plan_id, plan_name, plan_price, status, website_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))
    `).run(email, 'credits', plan.provider_id || null, plan.id, plan.plan_name || plan.id, plan.price_sell, website_id || 1)
    const orderId = orderResult.lastInsertRowid

    db.prepare('INSERT INTO credit_transactions (customer_email, amount, type, reference, order_id) VALUES (?, ?, ?, ?, ?)').run(email, -costCents, 'spend', `Plan ${plan.id}`, orderId)

    const payload = {
      order_id: orderId,
      customer_email: email,
      provider_id: plan.provider_id,
      plan_id: plan.id,
      method: 'credits',
      payment_id: `credits_${orderId}`,
      amount: plan.price_sell,
      website_id: website_id || 1,
    }

    const businessResult = await notifyBusiness(payload)
    if (businessResult?.success) {
      db.prepare("UPDATE orders SET business_order_id = ?, status = 'fulfilled', updated_at = datetime('now') WHERE id = ?").run(businessResult.business_order_id, orderId)
    }

    res.json({ success: true, business_result: businessResult })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ==================== Crypto Monitor (background) ====================
async function checkCryptoPayments() {
  const pending = db.prepare("SELECT * FROM crypto_payments WHERE status = 'pending'").all()
  if (pending.length === 0) return

  console.log(`[CryptoMonitor] Checking ${pending.length} pending payments...`)
  for (const payment of pending) {
    try {
      const apiKey = db.prepare("SELECT value FROM app_settings WHERE key = 'blockio_api_key'").get()?.value
      if (!apiKey) continue

      const res = await fetch(`https://block.io/api/v2/get_address_balance/?api_key=${apiKey}&addresses=${payment.address}`)
      const data = await res.json()

      if (data.status === 'success' && data.data?.balances?.length > 0) {
        const balance = parseFloat(data.data.balances[0].balance)
        const confirmations = parseInt(data.data.balances[0].confirmations) || 0
        const minConfirms = parseInt(db.prepare("SELECT value FROM app_settings WHERE key = 'crypto_min_confirmations'").get()?.value || '2')

        db.prepare('UPDATE crypto_payments SET received_amount = ?, confirmations = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(balance, confirmations, payment.id)

        if (balance >= payment.expected_amount && confirmations >= minConfirms) {
          db.prepare("UPDATE crypto_payments SET status = 'confirmed', tx_hash = ? WHERE id = ?").run(data.data.balances[0].tx_hash || '', payment.id)
          db.prepare("UPDATE orders SET status = 'completed', payment_id = ?, updated_at = datetime('now') WHERE id = ?").run(`crypto_${payment.id}`, payment.order_id)

          const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id)
          if (order) {
            const payload = {
              order_id: payment.order_id,
              customer_email: order.customer_email,
              customer_name: order.customer_name,
              provider_id: order.provider_id,
              plan_id: order.plan_id,
              method: `crypto_${payment.coin}`,
              payment_id: `crypto_${payment.id}`,
              amount: order.plan_price,
              website_id: order.website_id,
            }
            const result = await notifyBusiness(payload)
            if (result?.success) {
              db.prepare("UPDATE orders SET business_order_id = ?, status = 'fulfilled', updated_at = datetime('now') WHERE id = ?").run(result.business_order_id, payment.order_id)
            }
          }
        }
      }
    } catch (err) {
      console.error(`[CryptoMonitor] Error checking payment ${payment.id}:`, err.message)
    }
  }
}

// ==================== Admin: Payment list ====================
app.get('/api/admin/orders', (req, res) => {
  const page = parseInt(req.query.page) || 1
  const limit = parseInt(req.query.limit) || 50
  const offset = (page - 1) * limit
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)
  const total = db.prepare('SELECT COUNT(*) as c FROM orders').get().c
  res.json({ orders, total, page, limit, pages: Math.ceil(total / limit) })
})

app.get('/api/admin/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_orders,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END) as fulfilled,
      COALESCE(SUM(CASE WHEN status IN ('completed','fulfilled') THEN plan_price ELSE 0 END), 0) as total_revenue
    FROM orders
  `).get()
  const credits = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(balance), 0) as total_balance FROM prepaid_credits').get()
  res.json({ ...stats, credit_users: credits.c, total_credit_balance: credits.total_balance })
})

// ==================== Landing Pages (Cloaking Faces) ====================

// Internal API: receive landing page from Marketing Engine
app.post('/api/internal/landing-page', express.json(), async (req, res) => {
  try {
    const sig = req.headers['x-engine-signature']
    if (!sig) return res.status(401).json({ error: 'Missing signature' })

    const parts = sig.split('.')
    if (parts.length !== 2) return res.status(401).json({ error: 'Invalid signature format' })

    const [timestamp, signature] = parts
    const secret = db.prepare("SELECT value FROM app_settings WHERE key = 'internal_api_secret'").get()?.value
    const rawBody = JSON.stringify(req.body)
    const expected = crypto.createHmac('sha256', secret).update(rawBody + timestamp).digest('hex')
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - parseInt(timestamp)) > 300) return res.status(401).json({ error: 'Signature expired' })
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Invalid signature' })
    }

    const { website_id, title, slug, keyword, audience, html_content, language, page_type } = req.body
    if (!slug || !html_content) return res.status(400).json({ error: 'slug and html_content required' })

    const existing = db.prepare('SELECT id FROM landing_pages WHERE slug = ?').get(slug)
    if (existing) {
      db.prepare("UPDATE landing_pages SET html_content = ?, title = ?, keyword = ?, audience = ?, language = ?, updated_at = datetime('now') WHERE slug = ?")
        .run(html_content, title || slug, keyword || null, audience || null, language || 'fr', slug)
      res.json({ success: true, id: existing.id, action: 'updated' })
    } else {
      const result = db.prepare(
        "INSERT INTO landing_pages (website_id, title, slug, keyword, audience, html_content, language, page_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(website_id || 1, title || slug, slug, keyword || null, audience || null, html_content, language || 'fr', page_type || 'iptv')
      res.json({ success: true, id: result.lastInsertRowid, action: 'created' })
    }
  } catch (err) {
    console.error('[PaymentEngine] Landing page internal error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /lp/:slug — serve landing page for cloaking (bot sees page, real user redirected)
app.get('/lp/:slug', async (req, res) => {
  try {
    const page = db.prepare("SELECT * FROM landing_pages WHERE slug = ? AND active = 1").get(req.params.slug)
    if (!page) return res.status(404).send('Page not found')

    const ua = (req.headers['user-agent'] || '').toLowerCase()
    const isBot = !ua || /bot|crawl|spider|scrape|curl|wget|python-urllib|go-http|facebookexternalhit|twitterbot|slack|google|bing|yahoo|duckduckgo|baidu|yandex|applebot|semrush|ahrefs|majestic|archive|wayback|validator|checker|monitor|uptime/i.test(ua)

    if (isBot) {
      // Serve the landing page as cloaked face
      res.set('Content-Type', 'text/html; charset=utf-8')
      res.set('X-Cloak', 'landing-page')
      return res.send(page.html_content)
    }

    // Real user — redirect to checkout with page context
    const checkoutUrl = `/api/checkout/create?lp=${page.slug}&keyword=${encodeURIComponent(page.keyword || page.title)}`
    res.redirect(307, checkoutUrl)
  } catch (err) {
    console.error('[PaymentEngine] Landing page error:', err)
    res.status(500).send('Internal error')
  }
})

// GET /lp/:slug/raw — always serve raw HTML (for verification/debug)
app.get('/lp/:slug/raw', (req, res) => {
  const page = db.prepare("SELECT * FROM landing_pages WHERE slug = ? AND active = 1").get(req.params.slug)
  if (!page) return res.status(404).send('Page not found')
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(page.html_content)
})

// GET /api/lp — list stored landing pages
app.get('/api/lp', (req, res) => {
  const pages = db.prepare('SELECT id, website_id, title, slug, keyword, audience, language, page_type, active, created_at FROM landing_pages ORDER BY created_at DESC').all()
  res.json(pages)
})

// POST /api/internal/adapt-page — use local Ollama to adapt a landing page
app.post('/api/internal/adapt-page', express.json(), async (req, res) => {
  try {
    const { slug, instructions, page_type, ollama_url, ollama_model } = req.body
    if (!slug) return res.status(400).json({ error: 'slug required' })

    const page = db.prepare("SELECT * FROM landing_pages WHERE slug = ? AND active = 1").get(slug)
    if (!page) return res.status(404).json({ error: 'Page not found' })

    const ollamaUrl = ollama_url || process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
    const model = ollama_model || 'llama3.1:8b-instruct-q8_0'

    const prompt = `You are a web designer. Adapt the following landing page HTML according to these instructions.
Instructions: ${instructions || 'Make minor improvements to the design and copy'}
Page type to target: ${page_type || page.page_type || 'iptv'}

Current page title: ${page.title}
Current page keyword: ${page.keyword || ''}

Return the COMPLETE modified HTML page. Keep all CSS inline. Make it look professional and premium.
Do NOT wrap in markdown code blocks. Return ONLY the raw HTML.

ORIGINAL HTML:
${page.html_content.substring(0, 10000)}`

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.7, num_predict: 8192 }
      }),
      signal: AbortSignal.timeout(120000)
    })

    if (!response.ok) {
      const errText = await response.text()
      return res.status(502).json({ error: `Ollama error: ${response.status} ${errText}` })
    }

    const data = await response.json()
    const adaptedHtml = data.response || ''

    // Update page in DB
    db.prepare("UPDATE landing_pages SET html_content = ?, page_type = ?, updated_at = datetime('now') WHERE slug = ?")
      .run(adaptedHtml, page_type || page.page_type || 'iptv', slug)

    res.json({ success: true, slug, adapted: adaptedHtml.length > 0 })
  } catch (err) {
    console.error('[PaymentEngine] Adapt page error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/internal/plans — fetch live plans from Business Engine (for dynamic page injection)
app.get('/api/internal/plans', async (req, res) => {
  try {
    const secret = db.prepare("SELECT value FROM app_settings WHERE key = 'internal_api_secret'").get()?.value || process.env.INTERNAL_API_SECRET
    const bossUrl = db.prepare("SELECT value FROM app_settings WHERE key = 'business_engine_url'").get()?.value || 'http://localhost:3001'
    const timestamp = Math.floor(Date.now() / 1000)
    const sig = crypto.createHmac('sha256', secret).update('{}' + timestamp).digest('hex')
    const signature = `${timestamp}.${sig}`

    const bossRes = await fetch(`${bossUrl}/api/internal/plans${req.query.website_id ? '?website_id=' + req.query.website_id : ''}`, {
      headers: { 'X-Engine-Signature': signature }
    })
    if (!bossRes.ok) return res.status(502).json({ error: 'Business Engine error: ' + bossRes.status })
    const plans = await bossRes.json()
    res.json(plans)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ==================== Health Endpoint (for EngineWatcher) ====================
app.get('/api/internal/health', (req, res) => {
  const start = Date.now();
  try {
    const checks = {};

    try {
      const c = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get().c;
      checks.db = { status: 'ok', tables: c };
    } catch (e) { checks.db = { status: 'error', error: e.message }; }

    try {
      const orders24h = db.prepare("SELECT COUNT(*) as c FROM orders WHERE created_at > datetime('now', '-1 day')").get().c;
      const pending = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get().c;
      checks.orders = { last_24h: orders24h, pending };
    } catch { checks.orders = { error: 'unavailable' }; }

    try {
      const creditUsers = db.prepare('SELECT COUNT(*) as c FROM prepaid_credits').get().c;
      const totalBalance = db.prepare('SELECT COALESCE(SUM(balance), 0) as s FROM prepaid_credits').get().s;
      checks.credits = { users: creditUsers, total_balance: totalBalance };
    } catch { checks.credits = { error: 'unavailable' }; }

    try {
      const lpCount = db.prepare('SELECT COUNT(*) as c FROM landing_pages WHERE active = 1').get().c;
      checks.landing_pages = lpCount;
    } catch { checks.landing_pages = 0; }

    try {
      const cryptoMonitor = db.prepare("SELECT value FROM app_settings WHERE key = 'crypto_monitor_enabled'").get()?.value;
      checks.crypto_monitor = cryptoMonitor === '1' ? 'enabled' : 'disabled';
    } catch { checks.crypto_monitor = 'unknown'; }

    res.json({
      engine: 'payment',
      status: checks.db.status === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      response_time_ms: Date.now() - start,
      checks,
    });
  } catch (e) {
    res.status(500).json({ engine: 'payment', status: 'error', error: e.message });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`Payment Engine running on port ${PORT}`)

  // Start crypto monitor every 60 seconds
  const cryptoEnabled = db.prepare("SELECT value FROM app_settings WHERE key = 'crypto_monitor_enabled'").get()?.value
  if (cryptoEnabled === '1') {
    setInterval(checkCryptoPayments, 60 * 1000)
    checkCryptoPayments()
    console.log('[CryptoMonitor] Started')
  }
})

module.exports = app
