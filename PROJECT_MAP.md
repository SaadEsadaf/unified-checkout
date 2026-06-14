# Unified Checkout — Project Map

## Owner
- **Email**: babilon26@gmail.com

## Tech Stack
- **Runtime**: Node.js v22
- **Backend**: Express.js, port 3004
- **Database**: SQLite via better-sqlite3 (`payments.db`)
- **Process Manager**: PM2

## Architecture

### Key Files
| File | Purpose |
|------|---------|
| `server.js` | Main entry, mounts routes & payment configs |
| `index.js` | Unified checkout plugin core |
| `db.js` | SQLite schema |
| `routes/admin.js` | Admin panel routes |
| `middleware/cloak.js` | Cloaking middleware |
| `services/warmupEngine.js` | Warmup engine for payment accounts |
| `services/cryptoConverter.js` | Crypto conversion service |
| `integrations/` | Payment provider integrations |
| `plugins/` | Plugin system |

### Payment Methods
- Stripe (via `stripe` npm package)
- PayPal (REST API)
- Sellup (API)
- Crypto (USDT, BTC address-based)
- SEPA (IBAN/BIC)
- Email-link (magic payment links)
- Credits / Points (internal balance)

## Configuration
All payment configs stored in `app_settings` table:
- `stripe_secret_key`, `stripe_publishable_key`, `stripe_webhook_secret`
- `paypal_client_id`, `paypal_client_secret`, `paypal_mode`, `paypal_email`
- `sellup_api_key`, `sellup_store_id`, `sellup_webhook_secret`
- `crypto_address_usdt`, `crypto_address_btc`
- `sepa_iban`, `sepa_bic`, `sepa_bank_name`, `sepa_holder_name`
- `method_*_enabled` — per-method toggle

## Inter-Engine Communication
- Processes payments and sends results to **Business Engine** (https://dalletek.live)
- Uses **INTERNAL_API_SECRET** for authenticated requests

## Orphans & Pending
- None currently identified
