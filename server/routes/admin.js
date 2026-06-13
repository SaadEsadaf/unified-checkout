const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const { getDb } = require('../db');

function authMiddleware(req, res, next) {
  const db = getDb();
  const secret = db.prepare("SELECT value FROM app_settings WHERE key = 'internal_api_secret'").get()?.value || process.env.INTERNAL_API_SECRET;
  const token = req.query.token || req.headers['x-admin-token'];
  if (token && token === secret) return next();
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ') && auth.slice(7) === secret) return next();
  if (req.path === '/login' || req.path === '/api/admin/auth') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/admin/login');
}

router.use(authMiddleware);

router.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Engine Login</title><style>
* { margin:0; padding:0; box-sizing:border-box }
body { font-family:system-ui,sans-serif; background:#0a0a0f; color:#fff; display:flex; align-items:center; justify-content:center; min-height:100vh }
.card { background:linear-gradient(145deg,#111,#1a1a2e); border:1px solid #2a2a4a; border-radius:20px; padding:40px; width:100%; max-width:400px; text-align:center }
.card h1 { font-size:22px; margin-bottom:8px; background:linear-gradient(135deg,#00d4ff,#8b5cf6); -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text }
.card p { color:#666; font-size:13px; margin-bottom:24px }
.input { width:100%; padding:12px 16px; background:#0f0f1a; border:1px solid #2a2a4a; border-radius:10px; color:#fff; font-size:14px; outline:none; margin-bottom:16px }
.input:focus { border-color:#00d4ff }
.btn { width:100%; padding:12px; background:linear-gradient(135deg,#00d4ff,#8b5cf6); border:none; border-radius:10px; color:#fff; font-size:15px; font-weight:700; cursor:pointer }
.btn:hover { opacity:0.9 }
.error { color:#ff4444; font-size:13px; margin-top:12px }
</style></head><body>
<div class="card"><h1>🔐 Payment Engine</h1><p>Admin access</p>
<input class="input" id="pwd" type="password" placeholder="Admin token" onkeydown="if(event.key==='Enter')login()">
<button class="btn" onclick="login()">Unlock</button>
<div class="error" id="err"></div></div>
<script>function login(){const p=document.getElementById('pwd').value;fetch('/admin/api/auth?token='+encodeURIComponent(p)).then(r=>r.json()).then(d=>{if(d.success)window.location.href='/admin';else document.getElementById('err').textContent='Invalid token'}).catch(()=>document.getElementById('err').textContent='Error')}</script>
</body></html>`);
});

router.get('', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});

// === API endpoints ===

// Auth check
router.get('/api/auth', (req, res) => {
  res.json({ success: !!req.query.token });
});

// Orders with advanced stats
router.get('/api/orders', (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const method = req.query.method || '';
  const status = req.query.status || '';
  let where = [];
  let params = [];
  if (method) { where.push('method = ?'); params.push(method); }
  if (status) { where.push('status = ?'); params.push(status); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as c FROM orders ${whereClause}`).get(...params).c;
  const orders = db.prepare(`SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ orders, total, page, limit, pages: Math.ceil(total / limit) });
});

router.get('/api/orders/:id', (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const txs = db.prepare('SELECT * FROM payment_transactions WHERE order_id = ? ORDER BY created_at DESC').all(order.id);
  res.json({ order, transactions: txs });
});

router.post('/api/orders', (req, res) => {
  const db = getDb();
  const { customer_email, customer_name, customer_phone, provider_id, plan_id, plan_name, plan_price, method, currency } = req.body;
  if (!customer_email || !plan_price) return res.status(400).json({ error: 'email and price required' });
  const r = db.prepare(`INSERT INTO orders (customer_email, customer_name, customer_phone, provider_id, plan_id, plan_name, plan_price, method, status, currency, website_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, datetime('now'), datetime('now'))`)
    .run(customer_email, customer_name || null, customer_phone || null, provider_id || null, plan_id || null, plan_name || null, plan_price, method || 'manual', currency || 'EUR');
  res.json({ success: true, id: r.lastInsertRowid });
});

router.delete('/api/orders/:id', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', req.params.id);
  res.json({ success: true });
});

// Stats with revenue by method + daily breakdown
router.get('/api/stats', (req, res) => {
  const db = getDb();
  const days = parseInt(req.query.days) || 30;
  const now = new Date().toISOString().split('T')[0];
  const past = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const overview = db.prepare(`
    SELECT
      COUNT(*) as total_orders,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END) as fulfilled,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      COALESCE(SUM(CASE WHEN status IN ('completed','fulfilled') THEN plan_price ELSE 0 END), 0) as total_revenue
    FROM orders
  `).get();
  const byMethod = db.prepare(`
    SELECT method, COUNT(*) as count, COALESCE(SUM(plan_price), 0) as revenue
    FROM orders WHERE status IN ('completed','fulfilled')
    GROUP BY method ORDER BY revenue DESC
  `).all();
  const daily = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count, COALESCE(SUM(plan_price), 0) as revenue
    FROM orders WHERE date(created_at) >= ?
    GROUP BY date(created_at) ORDER BY day ASC
  `).all(past);
  const hourly = db.prepare(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as count
    FROM orders WHERE created_at > datetime('now', '-24 hours')
    GROUP BY hour ORDER BY hour
  `).all();
  const credits = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(balance), 0) as total_balance FROM prepaid_credits').get();
  const creditTxs = db.prepare('SELECT type, COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM credit_transactions GROUP BY type').all();
  res.json({ overview, byMethod, daily, hourly, credits, creditTxs });
});

// All payment methods config
router.get('/api/methods', (req, res) => {
  const db = getDb();
  const keys = {
    stripe: ['stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret'],
    paypal: ['paypal_client_id', 'paypal_client_secret', 'paypal_mode', 'paypal_email'],
    sellup: ['sellup_api_key', 'sellup_store_id', 'sellup_webhook_secret'],
    crypto: ['crypto_address_usdt', 'crypto_address_btc'],
    sepa: ['sepa_iban', 'sepa_bic', 'sepa_bank_name', 'sepa_holder_name'],
  };
  const methods = {};
  for (const [name, ks] of Object.entries(keys)) {
    methods[name] = {};
    for (const k of ks) {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(k);
      methods[name][k] = row?.value || '';
    }
    methods[name]._configured = Object.values(methods[name]).some(v => v && v.length > 3);
  }
  res.json(methods);
});

router.post('/api/methods', (req, res) => {
  const db = getDb();
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  const existing = db.prepare("SELECT id FROM app_settings WHERE key = ?").get(key);
  if (existing) db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(value || '', key);
  else db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(key, value || '');
  res.json({ success: true, key, value: value || '' });
});

// Cloak stats
router.get('/api/cloak', (req, res) => {
  const db = getDb();
  const enabled = db.prepare("SELECT value FROM app_settings WHERE key = 'cloak_enabled'").get()?.value !== '0';
  const config = require(path.join(__dirname, '..', 'config', 'cloak.json'));
  const pages = db.prepare('SELECT id, website_id, title, slug, keyword, audience, language, page_type, active, created_at FROM landing_pages ORDER BY created_at DESC').all();
  const totalLPs = pages.length;
  const activeLPs = pages.filter(p => p.active).length;
  res.json({ enabled, platforms: Object.keys(config), totalLPs, activeLPs, landingPages: pages });
});

router.post('/api/cloak/toggle', (req, res) => {
  const db = getDb();
  const current = db.prepare("SELECT value FROM app_settings WHERE key = 'cloak_enabled'").get()?.value;
  const newVal = current === '0' ? '1' : '0';
  const existing = db.prepare("SELECT id FROM app_settings WHERE key = 'cloak_enabled'").get();
  if (existing) db.prepare("UPDATE app_settings SET value = ? WHERE key = 'cloak_enabled'").run(newVal);
  else db.prepare("INSERT INTO app_settings (key, value) VALUES ('cloak_enabled', ?)").run(newVal);
  res.json({ success: true, enabled: newVal === '1' });
});

// Landing page CRUD
router.get('/api/landing-pages', (req, res) => {
  const db = getDb();
  const pages = db.prepare('SELECT id, website_id, title, slug, keyword, audience, language, page_type, active, created_at, updated_at FROM landing_pages ORDER BY created_at DESC').all();
  res.json(pages);
});

router.post('/api/landing-pages', (req, res) => {
  const db = getDb();
  const { title, slug, keyword, audience, html_content, language, page_type } = req.body;
  if (!slug || !html_content) return res.status(400).json({ error: 'slug and content required' });
  const existing = db.prepare('SELECT id FROM landing_pages WHERE slug = ?').get(slug);
  if (existing) {
    db.prepare("UPDATE landing_pages SET html_content = ?, title = ?, keyword = ?, audience = ?, language = ?, page_type = ?, updated_at = datetime('now') WHERE slug = ?")
      .run(html_content, title || slug, keyword || null, audience || null, language || 'fr', page_type || 'iptv', slug);
    return res.json({ success: true, id: existing.id, action: 'updated' });
  }
  const r = db.prepare("INSERT INTO landing_pages (website_id, title, slug, keyword, audience, html_content, language, page_type) VALUES (1, ?, ?, ?, ?, ?, ?, ?)")
    .run(title || slug, slug, keyword || null, audience || null, html_content, language || 'fr', page_type || 'iptv');
  res.json({ success: true, id: r.lastInsertRowid, action: 'created' });
});

router.post('/api/landing-pages/:id/toggle', (req, res) => {
  const db = getDb();
  const page = db.prepare('SELECT active FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE landing_pages SET active = ? WHERE id = ?').run(page.active ? 0 : 1, req.params.id);
  res.json({ success: true, active: !page.active });
});

// Crypto payments
router.get('/api/crypto', (req, res) => {
  const db = getDb();
  const enabled = db.prepare("SELECT value FROM app_settings WHERE key = 'crypto_monitor_enabled'").get()?.value === '1';
  const minConfirms = parseInt(db.prepare("SELECT value FROM app_settings WHERE key = 'crypto_min_confirmations'").get()?.value || '2');
  const payments = db.prepare(`
    SELECT cp.*, o.customer_email, o.plan_name, o.plan_price
    FROM crypto_payments cp LEFT JOIN orders o ON cp.order_id = o.id
    ORDER BY cp.created_at DESC LIMIT 50
  `).all();
  const stats = {
    pending: db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(expected_amount), 0) as total FROM crypto_payments WHERE status = 'pending'").get(),
    confirmed: db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(expected_amount), 0) as total FROM crypto_payments WHERE status = 'confirmed'").get(),
  };
  const addresses = {
    usdt: db.prepare("SELECT value FROM app_settings WHERE key = 'crypto_address_usdt'").get()?.value || '',
    btc: db.prepare("SELECT value FROM app_settings WHERE key = 'crypto_address_btc'").get()?.value || '',
  };
  res.json({ enabled, minConfirmations: minConfirms, payments, stats, addresses });
});

router.post('/api/crypto/address', (req, res) => {
  const db = getDb();
  const { coin, address } = req.body;
  if (!coin || !address) return res.status(400).json({ error: 'coin and address required' });
  const key = `crypto_address_${coin}`;
  const existing = db.prepare("SELECT id FROM app_settings WHERE key = ?").get(key);
  if (existing) db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(address, key);
  else db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(key, address);
  res.json({ success: true, coin, address });
});

router.post('/api/crypto/toggle-monitor', (req, res) => {
  const db = getDb();
  const current = db.prepare("SELECT value FROM app_settings WHERE key = 'crypto_monitor_enabled'").get()?.value;
  const newVal = current === '1' ? '0' : '1';
  const existing = db.prepare("SELECT id FROM app_settings WHERE key = 'crypto_monitor_enabled'").get();
  if (existing) db.prepare("UPDATE app_settings SET value = ? WHERE key = 'crypto_monitor_enabled'").run(newVal);
  else db.prepare("INSERT INTO app_settings (key, value) VALUES ('crypto_monitor_enabled', ?)").run(newVal);
  res.json({ success: true, enabled: newVal === '1' });
});

// Credits admin
router.get('/api/credits', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT pc.*, (SELECT COUNT(*) FROM credit_transactions WHERE customer_email = pc.customer_email) as tx_count FROM prepaid_credits pc ORDER BY pc.balance DESC LIMIT 100').all();
  const stats = db.prepare('SELECT COUNT(*) as total_users, COALESCE(SUM(balance), 0) as total_balance, COALESCE(AVG(balance), 0) as avg_balance FROM prepaid_credits').get();
  res.json({ users, stats });
});

router.post('/api/credits/grant', (req, res) => {
  const db = getDb();
  const { email, amount, reference } = req.body;
  if (!email || !amount) return res.status(400).json({ error: 'email and amount required' });
  const existing = db.prepare('SELECT * FROM prepaid_credits WHERE customer_email = ?').get(email);
  if (existing) db.prepare('UPDATE prepaid_credits SET balance = balance + ?, updated_at = datetime(\'now\') WHERE customer_email = ?').run(amount, email);
  else db.prepare('INSERT INTO prepaid_credits (customer_email, balance) VALUES (?, ?)').run(email, amount);
  db.prepare('INSERT INTO credit_transactions (customer_email, amount, type, reference) VALUES (?, ?, ?, ?)').run(email, amount, 'admin_grant', reference || 'Admin grant');
  res.json({ success: true, email, added: amount });
});

// Failover chain config
router.get('/api/failover', (req, res) => {
  const db = getDb();
  const chain = db.prepare("SELECT value FROM app_settings WHERE key = 'failover_chain'").get()?.value;
  const defaultChain = ['stripe', 'paypal', 'sellup', 'crypto', 'sepa', 'email-link'];
  res.json({ chain: chain ? chain.split(',') : defaultChain });
});

router.post('/api/failover', (req, res) => {
  const db = getDb();
  const { chain } = req.body;
  if (!chain || !Array.isArray(chain)) return res.status(400).json({ error: 'chain array required' });
  const value = chain.join(',');
  const existing = db.prepare("SELECT id FROM app_settings WHERE key = 'failover_chain'").get();
  if (existing) db.prepare("UPDATE app_settings SET value = ? WHERE key = 'failover_chain'").run(value);
  else db.prepare("INSERT INTO app_settings (key, value) VALUES ('failover_chain', ?)").run(value);
  res.json({ success: true, chain });
});

// Plugin testing
router.post('/api/test-plugin', async (req, res) => {
  try {
    const { method, email, amount } = req.body;
    if (!method || !email || !amount) return res.status(400).json({ error: 'method, email, amount required' });
    const db = getDb();
    const keys = {
      stripe: ['stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret'],
      paypal: ['paypal_client_id', 'paypal_client_secret', 'paypal_mode', 'paypal_email'],
      sellup: ['sellup_api_key', 'sellup_store_id', 'sellup_webhook_secret'],
      crypto: ['crypto_address_usdt', 'crypto_address_btc'],
      sepa: ['sepa_iban', 'sepa_bic', 'sepa_bank_name', 'sepa_holder_name'],
    };
    const configs = {};
    for (const [plugin, pluginKeys] of Object.entries(keys)) {
      configs[plugin] = {};
      for (const key of pluginKeys) {
        const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
        configs[plugin][key] = row?.value || '';
      }
    }
    const PluginClass = require(`../plugins/${method}`);
    const plugin = new PluginClass(configs[method] || {});
    if (!plugin.isConfigured || !plugin.isConfigured()) {
      return res.json({ success: false, error: `${method} is not configured` });
    }
    const order = {
      id: `test_${Date.now()}`,
      plan: { id: 'test_plan', provider_id: 1, price_sell: amount, currency: 'EUR' },
      email, name: 'Test User', website_id: '1',
      siteUrl: process.env.SITE_URL || 'http://localhost:3003',
      returnUrl: '', cancelUrl: '/payment/cancel',
    };
    const result = await plugin.createPayment(order);
    res.json({ success: true, method, result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Internal logs
router.get('/api/logs', (req, res) => {
  const db = getDb();
  const lines = parseInt(req.query.lines) || 50;
  const logs = db.prepare('SELECT * FROM payment_transactions ORDER BY created_at DESC LIMIT ?').all(lines);
  res.json(logs);
});

// Webhook test
router.post('/api/test-webhook', (req, res) => {
  const { method } = req.body;
  if (!method) return res.status(400).json({ error: 'method required' });
  try {
    const PluginClass = require(`../plugins/${method}`);
    const plugin = new PluginClass({});
    res.json({ success: true, webhookUrl: `${process.env.SITE_URL || 'http://localhost:3003'}/api/checkout/webhook/${method}` });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
