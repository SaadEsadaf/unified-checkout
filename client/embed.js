;(function () {
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.onload = resolve
      s.onerror = reject
      document.head.appendChild(s)
    })
  }

  window.UniCheckout = {
    async init(apiBase) {
      this.apiBase = apiBase || window.location.origin + '/api/checkout'
      try {
        const res = await fetch(this.apiBase + '/settings')
        this.settings = await res.json()
        this.ready = true
        console.log('[UniCheckout] Ready —', this.settings.plugins.length, 'payment methods available')
        return this.settings
      } catch (err) {
        console.error('[UniCheckout] Failed to load settings:', err.message)
        throw err
      }
    },

    async openCheckout(options) {
      if (!this.ready) await this.init()
      if (window.CheckoutWidget) {
        window.CheckoutWidget.open(options)
        return
      }
      await loadScript('/var/www/unified-checkout/client/checkout-widget.js')
      window.CheckoutWidget.open(options)
    }
  }

  if (document.readyState === 'complete') {
    window.UniCheckout.init()
  } else {
    document.addEventListener('DOMContentLoaded', () => window.UniCheckout.init())
  }
})()
