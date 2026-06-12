# Unified Checkout Plugin

Universal payment checkout plugin for Express — Stripe, PayPal, Sellup, Crypto, SEPA with **automatic failover** and **built-in cloaking**.

## Usage

```js
const unifiedCheckout = require('/var/www/unified-checkout')

const { router } = unifiedCheckout({
  plugins: ['stripe', 'paypal', 'sellup', 'crypto', 'sepa', 'email-link'],
  pluginConfigs: {
    stripe: { stripe_secret_key: 'sk_...', stripe_publishable_key: 'pk_...' },
    paypal: { paypal_client_id: '...', paypal_client_secret: '...' },
  },
  siteUrl: 'https://mysite.com',
  onOrderComplete: async (result) => { /* fulfillment */ },
  db: () => myDb,  // function that returns DB instance
})

app.use('/api/checkout', router)
```

## Routes

| Route | Purpose |
|-------|---------|
| `POST /api/checkout/create` | Initiate payment — tries plugins in order |
| `POST /api/checkout/failover` | Retry with next plugin if one fails |
| `GET /api/checkout/settings` | Available payment methods + public config |
| `GET /api/checkout/plugins` | List all registered plugins |
| `POST /api/checkout/webhook/:method` | Webhook dispatcher (Stripe/Sellup) |
| `GET /api/checkout/return/:method` | Redirect handler (PayPal capture) |

## Failover Flow

```
client → POST /create → tries stripe → fails → tries paypal → fails → tries sellup → OK → return URL
client → POST /failover { failedMethod: 'stripe' } → tries paypal → fails → tries sellup → OK
```

## Cloaking

Built-in middleware detects Stripe/PayPal/Google/Facebook crawlers by IP + UA and returns fake hosting/consulting pages. Webhook URLs are whitelisted.

## Adding a Payment Method

```js
class MyPlugin extends require('/var/www/unified-checkout/plugins/base') {
  get name() { return 'myplugin' }
  async createPayment(order) { return { url: '...' } }
  async handleWebhook(event) { return { handled: true, orderId: '...' } }
}
registry.register(new MyPlugin())
```

## Embed in any HTML page

```html
<script src="/var/www/unified-checkout/client/embed.js"></script>
<script>
UniCheckout.openCheckout({
  plan: { id: 1, name: 'Premium', price_sell: 24.99 },
  provider: { name: 'StreamMax' },
  onComplete: () => window.location.href = '/payment/success'
})
</script>
```

For React: `import { CheckoutWidget } from '/var/www/unified-checkout/client/CheckoutWidget'`
