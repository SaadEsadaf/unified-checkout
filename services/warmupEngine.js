const crypto = require('crypto')
const path = require('path')

function getDb() {
  return require(path.join(__dirname, '..', 'db')).getDb()
}

const DEFAULT_RULES = {
  stripe: {
    ramp: { week1: { dailyMax: 100, perTxnMax: 30 }, week2: { dailyMax: 300, perTxnMax: 50 }, week3: { dailyMax: 500, perTxnMax: 100 }, week4: { dailyMax: 1000, perTxnMax: 200 } },
    disputeThreshold: 0.005,
    refundThreshold: 0.03,
    minAgeDays: 30,
    requireKycBefore: 5000,
    descriptorRequired: true,
  },
  paypal: {
    ramp: { week1: { dailyMax: 200, perTxnMax: 50 }, week2: { dailyMax: 500, perTxnMax: 100 }, week3: { dailyMax: 1000, perTxnMax: 200 }, week4: { dailyMax: 2000, perTxnMax: 500 } },
    disputeThreshold: 0.005,
    minAgeDays: 60,
    requireKycBefore: 3000,
    cookieWarmupDays: 3,
  },
}

function getAccountState(provider, accountId) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM account_providers WHERE provider = ? AND account_id = ?').get(provider, accountId)
  if (!row) {
    const defaults = { provider, account_id: accountId, age_days: 0, status: 'warming', total_volume: 0, daily_volume: 0, weekly_volume: 0, dispute_count: 0, refund_count: 0, txn_count: 0, kyc_completed: 0, descriptor_ok: 0, last_txn_date: null, created_at: new Date().toISOString() }
    db.prepare(`INSERT INTO account_providers (provider, account_id, age_days, status, total_volume, daily_volume, weekly_volume, dispute_count, refund_count, txn_count, kyc_completed, descriptor_ok, last_txn_date, created_at) VALUES (@provider, @account_id, @age_days, @status, @total_volume, @daily_volume, @weekly_volume, @dispute_count, @refund_count, @txn_count, @kyc_completed, @descriptor_ok, @last_txn_date, @created_at)`).run(defaults)
    return defaults
  }
  return row
}

function getWarmupWeek(ageDays) {
  if (ageDays <= 7) return 1
  if (ageDays <= 14) return 2
  if (ageDays <= 21) return 3
  if (ageDays <= 28) return 4
  return 5
}

function getStatus(ageDays, totalVolume, disputeRate, refundRate, kycDone, providerRules) {
  if (ageDays < providerRules.minAgeDays && totalVolume < providerRules.requireKycBefore && !kycDone) return 'warming'
  if (disputeRate > providerRules.disputeThreshold || refundRate > (providerRules.refundThreshold || 0.03)) return 'restricted'
  if (ageDays >= providerRules.minAgeDays && totalVolume > providerRules.requireKycBefore && kycDone && disputeRate < providerRules.disputeThreshold * 0.5) return 'trusted'
  if (ageDays > 28 && totalVolume > 0 && disputeRate < providerRules.disputeThreshold) return 'active'
  return 'warming'
}

function checkVelocity(currentDaily, currentWeekly, ageDays, providerRules) {
  const week = getWarmupWeek(ageDays)
  const ramp = providerRules.ramp
  const weekKey = `week${Math.min(week, 5)}`
  const limits = ramp[weekKey] || ramp.week4
  const violations = []
  if (currentDaily >= limits.dailyMax) violations.push(`daily limit €${limits.dailyMax}`)
  if (currentWeekly >= limits.dailyMax * 6) violations.push('weekly velocity anomaly')
  return { allowed: violations.length === 0, limits, violations, week }
}

function checkTxnAmount(amount, ageDays, providerRules) {
  const week = getWarmupWeek(ageDays)
  const ramp = providerRules.ramp
  const weekKey = `week${Math.min(week, 5)}`
  const limits = ramp[weekKey] || ramp.week4
  if (amount > limits.perTxnMax) {
    return { allowed: false, reason: `Transaction €${amount} exceeds week ${week} limit of €${limits.perTxnMax}` }
  }
  return { allowed: true }
}

function logTxn(provider, accountId, amount, success, disputeRisk) {
  const db = getDb()
  const now = new Date().toISOString()
  const today = now.split('T')[0]

  const state = getAccountState(provider, accountId)
  const newDaily = state.last_txn_date === today ? state.daily_volume + amount : amount
  const newWeekly = state.weekly_volume + amount
  const newTotal = state.total_volume + amount
  const newTxn = state.txn_count + 1
  const newDisputes = state.dispute_count + (disputeRisk ? 1 : 0)

  db.prepare(`UPDATE account_providers SET daily_volume = ?, weekly_volume = ?, total_volume = ?, txn_count = ?, dispute_count = ?, last_txn_date = ?, updated_at = ? WHERE provider = ? AND account_id = ?`)
    .run(newDaily, newWeekly, newTotal, newTxn, newDisputes, today, now, provider, accountId)

  const ageDays = Math.ceil((Date.now() - new Date(state.created_at).getTime()) / 86400000)
  const rules = DEFAULT_RULES[provider]
  if (!rules) return

  const disputeRate = newTxn > 0 ? newDisputes / newTxn : 0
  const newStatus = getStatus(ageDays, newTotal, disputeRate, 0, state.kyc_completed, rules)
  if (newStatus !== state.status) {
    db.prepare(`UPDATE account_providers SET status = ? WHERE provider = ? AND account_id = ?`).run(newStatus, provider, accountId)
  }
}

function getBestAccount(provider) {
  const db = getDb()
  const accounts = db.prepare('SELECT * FROM account_providers WHERE provider = ? ORDER BY status DESC, age_days DESC, txn_count DESC').all(provider)
  if (accounts.length === 0) return null

  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const rules = DEFAULT_RULES[provider]
  if (!rules) return accounts[0]

  for (const acc of accounts) {
    const ageDays = Math.ceil((now.getTime() - new Date(acc.created_at).getTime()) / 86400000)
    const dailyOk = acc.last_txn_date === today ? acc.daily_volume < rules.ramp[`week${Math.min(getWarmupWeek(ageDays), 5)}`]?.dailyMax * 0.9 : true
    if (acc.status !== 'restricted' && dailyOk) return acc
  }

  return accounts[0] || null
}

function routePayment(provider, amount) {
  const rules = DEFAULT_RULES[provider]
  if (!rules) return { allowed: true, reason: 'no warming rules for this provider' }

  const account = getBestAccount(provider)
  if (!account) return { allowed: true, reason: 'no account tracked, allowing' }
  if (account.status === 'restricted') return { allowed: false, reason: `Account ${account.account_id} is restricted (dispute rate too high)` }

  const now = new Date()
  const ageDays = Math.ceil((now.getTime() - new Date(account.created_at).getTime()) / 86400000)
  const today = now.toISOString().split('T')[0]
  const currentDaily = account.last_txn_date === today ? account.daily_volume : 0
  const currentWeekly = account.weekly_volume

  const velocity = checkVelocity(currentDaily, currentWeekly, ageDays, rules)
  if (!velocity.allowed) return { allowed: false, reason: velocity.violations.join('; '), velocity }

  const txnCheck = checkTxnAmount(amount, ageDays, rules)
  if (!txnCheck.allowed) return { allowed: false, reason: txnCheck.reason }

  if (ageDays < rules.minAgeDays && currentDaily + amount > rules.ramp.week1.dailyMax * (ageDays > 3 ? 2 : 1)) {
    return { allowed: true, warning: `warming day ${ageDays} — keep transactions small and consistent` }
  }

  return { allowed: true, account: account.account_id, ageDays, status: account.status }
}

function shouldUseAlternative(provider, amount) {
  const routing = routePayment(provider, amount)
  if (routing.allowed) return { usePrimary: true, routing }

  return { usePrimary: false, routing }
}

module.exports = {
  DEFAULT_RULES,
  getAccountState,
  getWarmupWeek,
  getStatus,
  checkVelocity,
  checkTxnAmount,
  logTxn,
  getBestAccount,
  routePayment,
  shouldUseAlternative,
}
