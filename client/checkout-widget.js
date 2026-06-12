(function () {
  'use strict'

  const API_BASE = window.location.origin + '/api/checkout'

  const ICONS = { stripe: '💳', paypal: '🅿️', sellup: '🛒', crypto: '₿', sepa: '🏦', 'email-link': '📧' }
  const COLORS = { stripe: '#635bff', paypal: '#0070ba', sellup: '#2d8c3c', crypto: '#f7931a', sepa: '#1a5276', 'email-link': '#6c3483' }

  window.CheckoutWidget = {
    open: async function (options) {
      const { plan, provider, onComplete } = options
      let settings, selectedMethod, email = '', name = '', phone = ''
      let loading = false, error = '', orderResult = null, failures = [], triedMethods = [], step = 'loading'

      try {
        const res = await fetch(API_BASE + '/settings')
        settings = await res.json()
        step = 'methods'
      } catch {
        step = 'methods'
      }
      render()

      async function handlePayment(methodId) {
        loading = true
        error = ''
        render()

        try {
          const body = { plan: { ...plan, provider_id: provider?.id }, email, name, phone }
          if (triedMethods.length > 0) {
            body.failedMethod = triedMethods[triedMethods.length - 1]
            body.orderId = orderResult?.orderId
          }

          const endpoint = triedMethods.length > 0 ? '/failover' : '/create'
          const res = await fetch(API_BASE + endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          })
          const data = await res.json()

          if (data.success) {
            orderResult = data
            if (data.url) { window.location.href = data.url; return }
            if (data.manual) { step = 'manual'; render(); return }
            step = 'success'; render(); return
          }

          failures = [...failures, ...(data.failures || [])]
          triedMethods.push(methodId)
          const nextMethod = settings?.plugins.find(p => !triedMethods.includes(p.id) && p.id !== methodId)
          if (nextMethod) {
            error = data.error + '. Retrying...'
            render()
            setTimeout(() => handlePayment(nextMethod.id), 1500)
            return
          }
          error = data.error || 'Payment failed'
          step = 'methods'
        } catch (err) { error = err.message; step = 'methods' }
        loading = false
        render()
      }

      function render() {
        const overlay = document.getElementById('cw-overlay')
        if (!overlay) {
          const div = document.createElement('div')
          div.id = 'cw-overlay'
          div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px'
          document.body.appendChild(div)
        }

        const el = document.getElementById('cw-overlay')

        if (step === 'loading') {
          el.innerHTML = '<div style="background:#1a1a2e;border-radius:12px;padding:28px;color:#888;font-size:14px;text-align:center">Loading payment methods...</div>'
          return
        }

        const methodsHtml = (settings?.plugins || []).map(m => {
          const c = COLORS[m.id] || '#666'
          return `<button onclick="CheckoutWidget._handleMethod('${m.id}')" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border:none;border-radius:8px;cursor:pointer;color:#fff;font-size:14px;background:${c};width:100%;text-align:left">` +
            `<span style="font-size:22px">${ICONS[m.id] || '💳'}</span>` +
            `<span style="font-weight:600">${m.label}</span>` +
            (m.description ? `<span style="font-size:11px;opacity:0.8;display:block">${m.description}</span>` : '') +
            `</button>`
        }).join('')

        const failuresHtml = failures.length > 0
          ? failures.map(f => `<div style="color:#e94560;font-size:12px;padding:4px 8px;background:#2a1520;border-radius:4px;margin-bottom:4px">⚠️ ${f.method}: ${f.error}</div>`).join('')
          : ''

        const errorHtml = error ? `<div style="color:#e94560;font-size:13px;margin-bottom:12px;padding:8px 12px;background:#2a1520;border-radius:6px">${error}</div>` : ''

        let bodyHtml = ''
        if (step === 'methods') {
          bodyHtml = `<p style="color:#aaa;font-size:14px;margin-bottom:12px">Choose payment method</p>${errorHtml}${methodsHtml}`
        } else if (step === 'email') {
          bodyHtml = `<p style="color:#aaa;font-size:14px;margin-bottom:12px">Enter your details</p>${errorHtml}` +
            `<input id="cw-name" placeholder="Full name" value="${name}" style="width:100%;padding:12px;margin-bottom:10px;background:#0d0d1e;border:1px solid #2a2a4a;border-radius:8px;color:#fff;font-size:14px;box-sizing:border-box"><br>` +
            `<input id="cw-email" placeholder="Email address" value="${email}" style="width:100%;padding:12px;margin-bottom:10px;background:#0d0d1e;border:1px solid #2a2a4a;border-radius:8px;color:#fff;font-size:14px;box-sizing:border-box"><br>` +
            `<input id="cw-phone" placeholder="Phone (optional)" value="${phone}" style="width:100%;padding:12px;margin-bottom:10px;background:#0d0d1e;border:1px solid #2a2a4a;border-radius:8px;color:#fff;font-size:14px;box-sizing:border-box"><br>` +
            `<button onclick="CheckoutWidget._submitEmail()" style="width:100%;padding:14px;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer" ${loading ? 'disabled' : ''}>${loading ? 'Processing...' : 'Pay €' + (plan?.price_sell || '0')}</button>` +
            `<button onclick="CheckoutWidget._back()" style="width:100%;padding:10px;background:none;color:#888;border:1px solid #2a2a4a;border-radius:8px;font-size:13px;cursor:pointer;margin-top:8px">Back</button>`
        } else if (step === 'manual' && orderResult?.details) {
          let manualHtml = `<p style="color:#aaa;font-size:14px;margin-bottom:12px">Complete your payment</p>`
          const d = orderResult.details

          if (d.addresses?.usdt) {
            manualHtml += `<div style="background:#0d0d1e;padding:12px;border-radius:8px;margin-bottom:12px"><label style="color:#888;font-size:12px;display:block;margin-bottom:6px">USDT (TRC20)</label><code style="color:#e94560;font-size:12px;word-break:break-all;display:block;margin-bottom:6px">${d.addresses.usdt}</code></div>`
          }
          if (d.addresses?.btc) {
            manualHtml += `<div style="background:#0d0d1e;padding:12px;border-radius:8px;margin-bottom:12px"><label style="color:#888;font-size:12px;display:block;margin-bottom:6px">Bitcoin</label><code style="color:#e94560;font-size:12px;word-break:break-all;display:block;margin-bottom:6px">${d.addresses.btc}</code></div>`
          }
          if (d.bankDetails) {
            manualHtml += `<div style="font-size:13px;color:#ccc">`
            manualHtml += `<div style="padding:8px 0;border-bottom:1px solid #2a2a4a"><strong>IBAN:</strong> ${d.bankDetails.iban}</div>`
            if (d.bankDetails.bic) manualHtml += `<div style="padding:8px 0;border-bottom:1px solid #2a2a4a"><strong>BIC:</strong> ${d.bankDetails.bic}</div>`
            if (d.bankDetails.bankName) manualHtml += `<div style="padding:8px 0;border-bottom:1px solid #2a2a4a"><strong>Bank:</strong> ${d.bankDetails.bankName}</div>`
            manualHtml += `<div style="padding:8px 0;border-bottom:1px solid #2a2a4a"><strong>Amount:</strong> €${d.amount}</div>`
            if (d.reference) manualHtml += `<div style="padding:8px 0;border-bottom:1px solid #2a2a4a"><strong>Reference:</strong> <code>${d.reference}</code></div>`
            manualHtml += `</div>`
          }
          if (d.paypalEmail) {
            manualHtml += `<div style="padding:8px 0;border-bottom:1px solid #2a2a4a;font-size:13px;color:#ccc"><strong>PayPal:</strong> ${d.paypalEmail}</div>`
            manualHtml += `<div style="padding:8px 0;border-bottom:1px solid #2a2a4a;font-size:13px;color:#ccc"><strong>Amount:</strong> €${d.amount}</div>`
          }

          manualHtml += `<div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">` +
            `<button onclick="CheckoutWidget._failover()" style="width:100%;padding:14px;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer">Try another method</button>` +
            `<button onclick="CheckoutWidget._back()" style="width:100%;padding:10px;background:none;color:#888;border:1px solid #2a2a4a;border-radius:8px;font-size:13px;cursor:pointer">Back</button>` +
            `</div>`
          bodyHtml = manualHtml
        } else if (step === 'success') {
          bodyHtml = `<div style="text-align:center;padding:20px"><div style="font-size:48px;margin-bottom:12px">✅</div><p style="color:#81c784;font-size:16px;margin-bottom:16px">Payment initiated!</p>` +
            `<button onclick="CheckoutWidget._complete()" style="width:100%;padding:14px;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer">Continue</button></div>`
        }

        el.innerHTML = `<div style="background:#1a1a2e;border-radius:12px;padding:28px;width:100%;max-width:440px;max-height:90vh;overflow-y:auto;border:1px solid #2a2a4a">` +
          `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">` +
          `<h2 style="margin:0;font-size:20px;color:#fff">Checkout</h2>` +
          `<button onclick="CheckoutWidget._close()" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer">✕</button></div>` +
          `<div style="display:flex;justify-content:space-between;align-items:center;background:#0d0d1e;padding:12px 16px;border-radius:8px;margin-bottom:16px">` +
          `<span style="color:#ccc;font-size:14px">${provider?.name || 'Plan'}: ${plan?.name || ''}</span>` +
          `<span style="color:#e94560;font-size:18px;font-weight:bold">€${plan?.price_sell || '0'}</span></div>` +
          failuresHtml + bodyHtml + `</div>`
      }

      window.CheckoutWidget._handleMethod = function (id) {
        selectedMethod = settings?.plugins.find(p => p.id === id)
        if (selectedMethod?.config?.addresses || selectedMethod?.config?.bankDetails) {
          handlePayment(id)
          return
        }
        step = 'email'
        render()
      }

      window.CheckoutWidget._submitEmail = function () {
        name = document.getElementById('cw-name')?.value || name
        email = document.getElementById('cw-email')?.value || email
        phone = document.getElementById('cw-phone')?.value || phone
        if (!email) { error = 'Email required'; render(); return }
        handlePayment(selectedMethod?.id)
      }

      window.CheckoutWidget._back = function () {
        step = 'methods'
        error = ''
        render()
      }

      window.CheckoutWidget._close = function () {
        const el = document.getElementById('cw-overlay')
        if (el) el.remove()
      }

      window.CheckoutWidget._complete = function () {
        window.CheckoutWidget._close()
        if (typeof onComplete === 'function') onComplete()
      }

      window.CheckoutWidget._failover = function () {
        const nextMethod = settings?.plugins.find(p => !triedMethods.includes(p.id))
        if (!nextMethod) { error = 'No more payment methods'; render(); return }
        triedMethods.push(nextMethod.id)
        handlePayment(nextMethod.id)
      }

      render()
    }
  }
})()
