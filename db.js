const path = require('path')
const Database = require('better-sqlite3')

let db = null

function getDb() {
  if (db) return db
  const dbPath = path.join(__dirname, 'payments.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initializeSchema()
  return db
}

function initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_engine_order_id TEXT UNIQUE,
      website_id INTEGER DEFAULT 1,
      customer_email TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      provider_id INTEGER,
      plan_id INTEGER,
      plan_name TEXT,
      plan_price REAL,
      currency TEXT DEFAULT 'EUR',
      method TEXT,
      status TEXT DEFAULT 'pending',
      payment_id TEXT,
      gateway_ref TEXT,
      business_order_id INTEGER,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id),
      method TEXT NOT NULL,
      amount REAL,
      currency TEXT DEFAULT 'EUR',
      status TEXT DEFAULT 'pending',
      gateway_ref TEXT,
      raw_response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prepaid_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_email TEXT NOT NULL,
      balance INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('purchase', 'spend', 'refund', 'bonus')),
      reference TEXT,
      description TEXT,
      order_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crypto_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id),
      coin TEXT NOT NULL,
      address TEXT NOT NULL,
      expected_amount REAL,
      received_amount REAL DEFAULT 0,
      confirmations INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      tx_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS landing_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER DEFAULT 1,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      keyword TEXT,
      audience TEXT,
      html_content TEXT NOT NULL,
      language TEXT DEFAULT 'fr',
      active INTEGER DEFAULT 1,
      page_type TEXT DEFAULT 'iptv',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_lp_slug ON landing_pages(slug);
  `)

  const upsert = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)')
  const defaults = [
    ['site_name', 'Payment Engine'],
    ['site_url', 'http://localhost:3003'],
    ['internal_api_secret', process.env.INTERNAL_API_SECRET || 'dev-secret-change-in-production'],
    ['business_engine_url', process.env.BUSINESS_ENGINE_URL || 'http://localhost:3001'],
    ['cloak_enabled', '1'],
    ['crypto_monitor_enabled', '0'],
    ['crypto_min_confirmations', '2'],
    ['blockio_api_key', ''],
    ['blockio_pin', ''],
  ]
  for (const [k, v] of defaults) upsert.run(k, v)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_credits_email ON prepaid_credits(customer_email);
    CREATE INDEX IF NOT EXISTS idx_crypto_status ON crypto_payments(status);
  `)
}

module.exports = { getDb }
