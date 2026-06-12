import React, { useState, useEffect, useCallback } from 'react'

const API_BASE = window.location.origin + '/api/checkout'

const METHOD_STYLES = {
  stripe: { bg: '#635bff', hover: '#5548f0' },
  paypal: { bg: '#0070ba', hover: '#005fa3' },
  sellup: { bg: '#2d8c3c', hover: '#247030' },
  crypto: { bg: '#f7931a', hover: '#d98215' },
  sepa: { bg: '#1a5276', hover: '#154360' },
  'email-link': { bg: '#6c3483', hover: '#5b2c6f' },
}

const METHOD_ICONS = {
  stripe: '💳',
  paypal: '🅿️',
  sellup: '🛒',
  crypto: '₿',
  sepa: '🏦',
  'email-link': '📧',
}

function CheckoutWidget({ plan, provider, onComplete, onClose }) {
  const [step, setStep] = useState('loading')
  const [settings, setSettings] = useState(null)
  const [selectedMethod, setSelectedMethod] = useState(null)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [orderResult, setOrderResult] = useState(null)
  const [failures, setFailures] = useState([])
  const [triedMethods, setTriedMethods] = useState([])

  useEffect(() => {
    fetchSettings()
  }, [])

  async function fetchSettings() {
    try {
      const res = await fetch(`${API_BASE}/settings`)
      const data = await res.json()
      setSettings(data)
      setStep('methods')
    } catch (err) {
      setError('Failed to load payment methods')
      setStep('methods')
    }
  }

  async function handleMethodClick(method) {
    setSelectedMethod(method)
    setError('')

    if (method.manual) {
      await initiatePayment(method.id)
      return
    }

    if (!email) {
      setStep('email')
      return
    }

    await initiatePayment(method.id)
  }

  async function initiatePayment(methodId) {
    setLoading(true)
    setError('')

    try {
      const body = {
        plan: { ...plan, provider_id: provider?.id },
        email,
        name,
        phone,
      }

      if (triedMethods.length > 0) {
        body.failedMethod = triedMethods[triedMethods.length - 1]
        body.orderId = orderResult?.orderId
      }

      const endpoint = triedMethods.length > 0 ? '/failover' : '/create'
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()

      if (data.success) {
        setOrderResult(data)

        if (data.url) {
          window.location.href = data.url
          return
        }

        if (data.manual) {
          setStep('manual')
          return
        }

        setStep('success')
      } else {
        setFailures(prev => [...prev, ...(data.failures || [])])
        setTriedMethods(prev => [...prev, methodId])

        if (data.failures?.length > 0) {
          const nextMethod = settings?.plugins.find(
            p => !triedMethods.includes(p.id) && p.id !== methodId
          )
          if (nextMethod) {
            setError(`${data.error}. Trying next method...`)
            setTimeout(() => initiatePayment(nextMethod.id), 1500)
            return
          }
        }

        setError(data.error || 'Payment failed')
        setSelectedMethod(null)
        setStep('methods')
      }
    } catch (err) {
      setError(err.message)
      setSelectedMethod(null)
      setStep('methods')
    } finally {
      setLoading(false)
    }
  }

  async function handleFailover() {
    if (!orderResult?.orderId) {
      setError('No active order')
      return
    }

    const nextMethod = settings?.plugins.find(
      p => !triedMethods.includes(p.id)
    )

    if (!nextMethod) {
      setError('No more payment methods available')
      return
    }

    setTriedMethods(prev => [...prev, nextMethod.id])
    await initiatePayment(nextMethod.id)
  }

  if (step === 'loading') {
    return <div style={styles.loading}>Loading payment methods...</div>
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <h2 style={styles.title}>Checkout</h2>
          {onClose && (
            <button style={styles.closeBtn} onClick={onClose}>✕</button>
          )}
        </div>

        <div style={styles.planSummary}>
          <span style={styles.planName}>{provider?.name || 'Plan'}: {plan?.name || ''}</span>
          <span style={styles.planPrice}>€{plan?.price_sell || '0'}</span>
        </div>

        {failures.length > 0 && (
          <div style={styles.failures}>
            {failures.map((f, i) => (
              <div key={i} style={styles.failureItem}>
                ⚠️ {f.method}: {f.error}
              </div>
            ))}
          </div>
        )}

        {step === 'methods' && (
          <div>
            <p style={styles.subtitle}>Choose payment method</p>
            {error && <div style={styles.error}>{error}</div>}

            <div style={styles.methodsGrid}>
              {(settings?.plugins || []).map(method => {
                const style = METHOD_STYLES[method.id] || { bg: '#666', hover: '#555' }
                return (
                  <button
                    key={method.id}
                    style={{
                      ...styles.methodBtn,
                      background: style.bg,
                    }}
                    onClick={() => handleMethodClick(method)}
                    disabled={loading}
                    onMouseEnter={e => e.target.style.background = style.hover}
                    onMouseLeave={e => e.target.style.background = style.bg}
                  >
                    <span style={styles.methodIcon}>{method.icon || METHOD_ICONS[method.id] || '💳'}</span>
                    <span style={styles.methodLabel}>{method.label}</span>
                    {method.description && (
                      <span style={styles.methodDesc}>{method.description}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step === 'email' && (
          <div>
            <p style={styles.subtitle}>Enter your details for {selectedMethod?.label || 'payment'}</p>
            {error && <div style={styles.error}>{error}</div>}
            <input
              style={styles.input}
              placeholder="Full name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="Email address"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="Phone (optional)"
              value={phone}
              onChange={e => setPhone(e.target.value)}
            />
            <button
              style={styles.primaryBtn}
              onClick={() => initiatePayment(selectedMethod.id)}
              disabled={loading || !email}
            >
              {loading ? 'Processing...' : `Pay €${plan?.price_sell || '0'} via ${selectedMethod?.label || ''}`}
            </button>
            <button style={styles.backBtn} onClick={() => setStep('methods')}>Back</button>
          </div>
        )}

        {step === 'manual' && orderResult?.details && (
          <div>
            <p style={styles.subtitle}>
              {orderResult.details.method === 'crypto' && 'Send cryptocurrency to this address:'}
              {orderResult.details.method === 'sepa' && 'Transfer via SEPA to:'}
              {orderResult.details.method === 'email-link' && 'Payment link sent to your email'}
              {orderResult.details.method === 'paypal' && 'Send payment via PayPal Friends & Family:'}
            </p>

            {orderResult.details.addresses && (
              <div>
                {orderResult.details.addresses.usdt && (
                  <div style={styles.addressBox}>
                    <label style={styles.addressLabel}>USDT (TRC20)</label>
                    <code style={styles.address}>{orderResult.details.addresses.usdt}</code>
                    <button style={styles.copyBtn} onClick={() => navigator.clipboard.writeText(orderResult.details.addresses.usdt)}>Copy</button>
                  </div>
                )}
                {orderResult.details.addresses.btc && (
                  <div style={styles.addressBox}>
                    <label style={styles.addressLabel}>Bitcoin</label>
                    <code style={styles.address}>{orderResult.details.addresses.btc}</code>
                    <button style={styles.copyBtn} onClick={() => navigator.clipboard.writeText(orderResult.details.addresses.btc)}>Copy</button>
                  </div>
                )}
              </div>
            )}

            {orderResult.details.bankDetails && (
              <div>
                <div style={styles.detailRow}><strong>IBAN:</strong> {orderResult.details.bankDetails.iban}</div>
                {orderResult.details.bankDetails.bic && <div style={styles.detailRow}><strong>BIC:</strong> {orderResult.details.bankDetails.bic}</div>}
                {orderResult.details.bankDetails.bankName && <div style={styles.detailRow}><strong>Bank:</strong> {orderResult.details.bankDetails.bankName}</div>}
                {orderResult.details.bankDetails.holderName && <div style={styles.detailRow}><strong>Holder:</strong> {orderResult.details.bankDetails.holderName}</div>}
                <div style={styles.detailRow}><strong>Amount:</strong> €{orderResult.details.amount}</div>
                {orderResult.details.reference && <div style={styles.detailRow}><strong>Reference:</strong> <code>{orderResult.details.reference}</code></div>}
              </div>
            )}

            {orderResult.details.paypalEmail && (
              <div>
                <div style={styles.detailRow}><strong>PayPal Email:</strong> {orderResult.details.paypalEmail}</div>
                <div style={styles.detailRow}><strong>Amount:</strong> €{orderResult.details.amount}</div>
              </div>
            )}

            {orderResult.details.paymentUrl && step !== 'email' && (
              <div style={styles.detailRow}>
                <strong>Payment Link:</strong> <code>{orderResult.details.paymentUrl}</code>
              </div>
            )}

            <div style={styles.manualActions}>
              <button style={styles.primaryBtn} onClick={handleFailover} disabled={loading}>
                {loading ? 'Checking...' : 'Try another payment method'}
              </button>
              <button style={styles.backBtn} onClick={() => setStep('methods')}>Back to methods</button>
            </div>
          </div>
        )}

        {step === 'success' && (
          <div style={styles.successBox}>
            <div style={styles.successIcon}>✅</div>
            <p style={styles.successText}>Payment initiated!</p>
            <button style={styles.primaryBtn} onClick={onComplete}>Continue</button>
          </div>
        )}
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', zIndex: 10000, padding: '20px',
  },
  modal: {
    background: '#1a1a2e', borderRadius: '12px', padding: '28px',
    width: '100%', maxWidth: '440px', maxHeight: '90vh', overflowY: 'auto',
    border: '1px solid #2a2a4a',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' },
  title: { margin: 0, fontSize: '20px', color: '#fff' },
  closeBtn: { background: 'none', border: 'none', color: '#888', fontSize: '20px', cursor: 'pointer' },
  planSummary: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: '#0d0d1e', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px',
  },
  planName: { color: '#ccc', fontSize: '14px' },
  planPrice: { color: '#e94560', fontSize: '18px', fontWeight: 'bold' },
  subtitle: { color: '#aaa', fontSize: '14px', marginBottom: '12px' },
  error: { color: '#e94560', fontSize: '13px', marginBottom: '12px', padding: '8px 12px', background: '#2a1520', borderRadius: '6px' },
  methodsGrid: { display: 'flex', flexDirection: 'column', gap: '10px' },
  methodBtn: {
    display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px',
    border: 'none', borderRadius: '8px', cursor: 'pointer', color: '#fff',
    fontSize: '14px', textAlign: 'left', transition: 'background 0.2s',
  },
  methodIcon: { fontSize: '22px' },
  methodLabel: { fontWeight: '600', flex: 1 },
  methodDesc: { fontSize: '11px', opacity: 0.8, display: 'block' },
  input: {
    width: '100%', padding: '12px', marginBottom: '10px', background: '#0d0d1e',
    border: '1px solid #2a2a4a', borderRadius: '8px', color: '#fff',
    fontSize: '14px', boxSizing: 'border-box',
  },
  primaryBtn: {
    width: '100%', padding: '14px', background: '#e94560', color: '#fff',
    border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: '600',
    cursor: 'pointer', marginTop: '8px',
  },
  backBtn: {
    width: '100%', padding: '10px', background: 'none', color: '#888',
    border: '1px solid #2a2a4a', borderRadius: '8px', fontSize: '13px',
    cursor: 'pointer', marginTop: '8px',
  },
  loading: { color: '#888', fontSize: '14px', padding: '20px', textAlign: 'center' },
  addressBox: { background: '#0d0d1e', padding: '12px', borderRadius: '8px', marginBottom: '12px' },
  addressLabel: { color: '#888', fontSize: '12px', display: 'block', marginBottom: '6px' },
  address: { color: '#e94560', fontSize: '12px', wordBreak: 'break-all', display: 'block', marginBottom: '6px' },
  copyBtn: { padding: '6px 12px', background: '#2a2a4a', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px' },
  detailRow: { color: '#ccc', fontSize: '13px', padding: '8px 0', borderBottom: '1px solid #2a2a4a' },
  manualActions: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' },
  successBox: { textAlign: 'center', padding: '20px' },
  successIcon: { fontSize: '48px', marginBottom: '12px' },
  successText: { color: '#81c784', fontSize: '16px', marginBottom: '16px' },
  failures: { marginBottom: '12px' },
  failureItem: { color: '#e94560', fontSize: '12px', padding: '4px 8px', background: '#2a1520', borderRadius: '4px', marginBottom: '4px' },
}

export { CheckoutWidget }
export default CheckoutWidget
