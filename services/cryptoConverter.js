const crypto = require('crypto')

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3'
const BINANCE_BASE = 'https://api.binance.com'

const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  BNB: 'binancecoin',
  SOL: 'solana',
}

const POLL_INTERVAL_MS = 30000
const MAX_RETRIES = 3
const DEFAULT_FEE_PERCENT = 2.0

class CryptoConverter {
  constructor(db) {
    this.db = db
    this.workerTimer = null
    this._ensureTable()
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crypto_convert_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        fiat_amount REAL NOT NULL,
        fiat_currency TEXT DEFAULT 'EUR',
        crypto_amount REAL,
        crypto_currency TEXT DEFAULT 'USDT',
        wallet_address TEXT NOT NULL,
        customer_email TEXT,
        exchange_rate REAL,
        rate_locked_at TEXT,
        fee_percent REAL DEFAULT 2.0,
        fee_amount REAL,
        status TEXT DEFAULT 'PENDING',
        tx_hash TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        last_error TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `)
  }

  getSetting(key) {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)
    return row?.value
  }

  // ============ CoinGecko Rate ============

  async fetchRate(cryptoCurrency, fiatCurrency = 'EUR') {
    const coinId = COINGECKO_IDS[cryptoCurrency.toUpperCase()]
    if (!coinId) throw new Error(`Unsupported crypto: ${cryptoCurrency}`)
    const url = `${COINGECKO_BASE}/simple/price?ids=${coinId}&vs_currencies=${fiatCurrency.toLowerCase()}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`)
    const data = await res.json()
    const rate = data[coinId]?.[fiatCurrency.toLowerCase()]
    if (!rate) throw new Error(`Rate not found for ${cryptoCurrency}/${fiatCurrency}`)
    return rate
  }

  // ============ Binance API ============

  async _binance(method, endpoint, params = {}, signed = false) {
    const apiKey = this.getSetting('binance_api_key')
    const secret = this.getSetting('binance_secret')
    if (!apiKey || !secret) throw new Error('Binance API not configured in app_settings')

    let qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')

    if (signed) {
      const ts = Date.now()
      const payload = qs ? `${qs}&timestamp=${ts}` : `timestamp=${ts}`
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex')
      qs = `${payload}&signature=${sig}`
    }

    const url = `${BINANCE_BASE}${endpoint}?${qs}`
    const res = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    if (!res.ok) throw new Error(`Binance error: ${data.msg || JSON.stringify(data)}`)
    return data
  }

  async executeBuy(cryptoCurrency, fiatAmount) {
    const symbol = `${cryptoCurrency.toUpperCase()}USDT`
    const order = await this._binance('POST', '/api/v3/order', {
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: fiatAmount.toFixed(2),
    }, true)
    return order
  }

  async withdraw(cryptoCurrency, amount, address) {
    const network = cryptoCurrency === 'USDT' ? 'TRX' : cryptoCurrency
    const result = await this._binance('POST', '/sapi/v1/capital/withdraw/apply', {
      coin: cryptoCurrency.toUpperCase(),
      network,
      address,
      amount: amount.toFixed(8),
    }, true)
    return result
  }

  // ============ Job CRUD ============

  async createJob({ fiatAmount, fiatCurrency, cryptoCurrency, walletAddress, customerEmail, idempotencyKey }) {
    if (idempotencyKey) {
      const existing = this.db.prepare("SELECT * FROM crypto_convert_jobs WHERE idempotency_key = ?").get(idempotencyKey)
      if (existing) return { existing: true, job: existing }
    }

    const rate = await this.fetchRate(cryptoCurrency, fiatCurrency)
    const feePercent = parseFloat(this.getSetting('crypto_convert_fee_percent') || DEFAULT_FEE_PERCENT)
    const feeAmount = fiatAmount * (feePercent / 100)
    const netAmount = fiatAmount - feeAmount
    const cryptoAmount = parseFloat((netAmount / rate).toFixed(8))

    const r = this.db.prepare(`
      INSERT INTO crypto_convert_jobs
        (fiat_amount, fiat_currency, crypto_amount, crypto_currency, wallet_address, customer_email, exchange_rate, fee_percent, fee_amount, status, idempotency_key, rate_locked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, datetime('now'), datetime('now'), datetime('now'))
    `).run(fiatAmount, fiatCurrency || 'EUR', cryptoAmount, cryptoCurrency.toUpperCase(), walletAddress, customerEmail || null, rate, feePercent, feeAmount, idempotencyKey || null)

    return {
      id: r.lastInsertRowid,
      fiatAmount,
      fiatCurrency: fiatCurrency || 'EUR',
      cryptoAmount,
      cryptoCurrency: cryptoCurrency.toUpperCase(),
      rate,
      feePercent,
      feeAmount,
    }
  }

  getJob(id) {
    return this.db.prepare("SELECT * FROM crypto_convert_jobs WHERE id = ?").get(id)
  }

  getJobByOrderId(orderId) {
    return this.db.prepare("SELECT * FROM crypto_convert_jobs WHERE order_id = ?").get(orderId)
  }

  getAllJobs(limit = 50) {
    return this.db.prepare("SELECT * FROM crypto_convert_jobs ORDER BY created_at DESC LIMIT ?").all(limit)
  }

  // ============ Processing ============

  async processJob(job) {
    const update = (status, error = null) => {
      this.db.prepare("UPDATE crypto_convert_jobs SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, error, job.id)
    }

    try {
      update('PROCESSING')

      const order = await this.executeBuy(job.crypto_currency, job.fiat_amount)
      const executedQty = parseFloat(order.executedQty || 0)
      if (executedQty <= 0) {
        const fills = order.fills || []
        const cummulativeQuoteQty = parseFloat(order.cummulativeQuoteQty || 0)
        throw new Error(`Order executed with 0 quantity. fills=${JSON.stringify(fills)}, quoteQty=${cummulativeQuoteQty}`)
      }

      const withdrawResult = await this.withdraw(job.crypto_currency, executedQty, job.wallet_address)
      const txHash = withdrawResult?.id || String(order.orderId)

      this.db.prepare("UPDATE crypto_convert_jobs SET status = 'COMPLETED', tx_hash = ?, crypto_amount = ?, updated_at = datetime('now') WHERE id = ?")
        .run(txHash, executedQty, job.id)

      if (job.customer_email) {
        await this._sendReceipt(job, executedQty, txHash).catch(() => {})
      }

      return { success: true, txHash, amount: executedQty }
    } catch (err) {
      const retryCount = (job.retry_count || 0) + 1
      this.db.prepare("UPDATE crypto_convert_jobs SET retry_count = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?")
        .run(retryCount, err.message, job.id)

      if (retryCount >= MAX_RETRIES) {
        update('FAILED', err.message)
        if (job.customer_email) {
          await this._sendFailure(job, err.message).catch(() => {})
        }
      }

      throw err
    }
  }

  async _sendReceipt(job, amount, txHash) {
    const to = job.customer_email
    if (!to) return
    try {
      const emailService = require('./emailService')
      await emailService.sendEmail({
        to,
        subject: 'Crypto Conversion Complete',
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0d0d1a;color:#e0e0f0;border-radius:12px">
          <h2 style="color:#00d4ff;margin-bottom:16px">✅ Conversion Complete</h2>
          <p>Your fiat-to-crypto conversion has been processed.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:6px 0;color:#888">Amount</td><td style="text-align:right;font-weight:600">€${job.fiat_amount}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Received</td><td style="text-align:right;font-weight:600;color:#00ff88">${amount} ${job.crypto_currency}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Rate</td><td style="text-align:right">€${job.exchange_rate} per ${job.crypto_currency}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Fee</td><td style="text-align:right">${job.fee_percent}%</td></tr>
            <tr><td style="padding:6px 0;color:#888">TX Hash</td><td style="text-align:right;font-family:monospace;font-size:11px;color:#888">${txHash}</td></tr>
          </table>
          <p style="color:#888;font-size:12px">Sent to: <code style="word-break:break-all">${job.wallet_address}</code></p>
          <p style="color:#555;font-size:11px;margin-top:16px">Pay Engine &bull; pay.dalletek.live</p>
        </div>`,
      })
    } catch (e) {
      console.error('[CryptoConverter] Receipt email failed:', e.message)
    }
  }

  async _sendFailure(job, error) {
    const to = job.customer_email
    if (!to) return
    try {
      const emailService = require('./emailService')
      await emailService.sendEmail({
        to,
        subject: 'Crypto Conversion Failed',
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0d0d1a;color:#e0e0f0;border-radius:12px">
          <h2 style="color:#ff4444;margin-bottom:16px">❌ Conversion Failed</h2>
          <p>Your conversion of <strong>€${job.fiat_amount} → ${job.crypto_currency}</strong> has failed after ${MAX_RETRIES} attempts.</p>
          <p style="color:#888">Reason: ${error}</p>
          <p style="margin-top:16px">Please try again or contact support with job ID <code>#${job.id}</code>.</p>
          <p style="color:#555;font-size:11px;margin-top:16px">Pay Engine &bull; pay.dalletek.live</p>
        </div>`,
      })
    } catch (e) {
      console.error('[CryptoConverter] Failure email error:', e.message)
    }
  }

  // ============ Worker ============

  async processPending() {
    const jobs = this.db.prepare(`
      SELECT * FROM crypto_convert_jobs
      WHERE status = 'PENDING'
         OR (status = 'PROCESSING' AND retry_count < max_retries AND retry_count > 0 AND datetime(updated_at, '+' || retry_count * 30 || ' seconds') < datetime('now'))
      ORDER BY created_at ASC
    `).all()

    for (const job of jobs) {
      try {
        await this.processJob(job)
      } catch (err) {
        console.error(`[CryptoConverter] Job #${job.id} failed:`, err.message)
      }
    }
  }

  startWorker() {
    console.log('[CryptoConverter] Worker started (poll every 30s)')
    this.processPending().catch(() => {})
    this.workerTimer = setInterval(() => this.processPending().catch(() => {}), POLL_INTERVAL_MS)
  }

  stopWorker() {
    if (this.workerTimer) {
      clearInterval(this.workerTimer)
      this.workerTimer = null
    }
  }

  async retryJob(jobId) {
    const job = this.getJob(jobId)
    if (!job) throw new Error('Job not found')
    if (job.status !== 'FAILED') throw new Error('Status must be FAILED to retry')
    this.db.prepare("UPDATE crypto_convert_jobs SET status = 'PENDING', retry_count = 0, last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(jobId)
    return { success: true }
  }

  // ============ Stripe Checkout Link ============

  async createCheckout(jobId, successUrl, cancelUrl) {
    const job = this.getJob(jobId)
    if (!job) throw new Error('Job not found')

    const stripeKey = this.getSetting('stripe_secret_key')
    if (!stripeKey) throw new Error('Stripe not configured')

    const stripe = require('stripe')(stripeKey)
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: (job.fiat_currency || 'eur').toLowerCase(),
          product_data: {
            name: 'Premium Package',
            description: `Order #${job.id}`,
          },
          unit_amount: Math.round(job.fiat_amount * 100),
        },
        quantity: 1,
      }],
      metadata: {
        ref: `job_${job.id}`,
      },
      success_url: successUrl || `${process.env.SITE_URL || 'http://localhost:3003'}/payment/success?id=${job.id}`,
      cancel_url: cancelUrl || `${process.env.SITE_URL || 'http://localhost:3003'}/payment/cancel?id=${job.id}`,
    })

    this.db.prepare("UPDATE crypto_convert_jobs SET order_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(session.id, job.id)

    return { url: session.url, session_id: session.id }
  }
}

module.exports = CryptoConverter
