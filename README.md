# vDelivers ↔ Shopify Connector

Node.js/Express service that connects a Shopify store to the vDelivers platform via OAuth, real-time webhooks, and a 5-minute polling fallback.

---

## Architecture

```
Shopify Cloud
    │
    │  OAuth grant + webhooks (HMAC-signed)
    ▼
Express Server (this service)
    ├── GET  /shopify/oauth/install     → builds signed install URL, redirects merchant
    ├── GET  /shopify/oauth/callback    → exchanges code → access_token, saves shop, registers webhooks
    ├── POST /webhooks/shopify          → HMAC-verified ingest (orders, products, customers, uninstall)
    ├── GET  /api/shops                 → list connected shops (dashboard auth)
    └── POST /api/auth/login            → session login for admin dashboard
    │
    ├── node-cron (every 5 min)        → poll Shopify for missed webhook events
    └── optional push → vDelivers API  → POST /shopify/ingest with recent orders
    │
PostgreSQL
    ├── shops           — OAuth credentials + last_synced_at
    ├── orders          — normalised + raw_data JSONB
    ├── products        — variants + images JSONB
    ├── customers       — contact + spend data
    └── sync_logs       — every event/error with timestamp
```

---

## Project Structure

```
├── server.js                   ← main Express entry point          [TODO]
├── package.json
├── .env.example
└── src/
    ├── config/
    │   └── index.js            ← all env vars, validated at startup  [DONE]
    ├── db/
    │   ├── index.js            ← pg Pool, query(), getClient()        [DONE]
    │   └── migrations.js       ← CREATE TABLE IF NOT EXISTS …         [DONE]
    ├── middleware/
    │   ├── hmac.js             ← verifyOAuthHmac, verifyWebhookHmac  [DONE]
    │   └── auth.js             ← requireDashboardAuth (session)       [DONE]
    └── services/
        ├── shopifyClient.js    ← axios wrapper, token exchange,
        │                          webhook registration, paginated fetch [DONE]
        ├── sync.js             ← upsertOrder/Product/Customer,
        │                          processWebhookEvent, fullSync,
        │                          pushToVDelivers                      [DONE]
        └── scheduler.js        ← node-cron polling loop               [DONE]
```

---

## Build Status

### Done

| File | What it does |
|---|---|
| `src/config/index.js` | Loads and validates all env vars; exposes typed config object |
| `src/db/index.js` | pg connection pool (max 10 connections) |
| `src/db/migrations.js` | Idempotent DDL for `shops`, `orders`, `products`, `customers`, `sync_logs` |
| `src/middleware/hmac.js` | HMAC-SHA256 verification for OAuth callbacks and webhook POST bodies; raw-body capture middleware |
| `src/middleware/auth.js` | Session-based guard for internal dashboard routes |
| `src/services/shopifyClient.js` | `exchangeCodeForToken`, `getShopInfo`, `registerAllWebhooks`, `fetchOrders/Products/Customers` with link-based pagination |
| `src/services/sync.js` | `upsertOrder`, `upsertProduct`, `upsertCustomer` (ON CONFLICT upsert); `processWebhookEvent`; `fullSync`; `pushToVDelivers` |
| `src/services/scheduler.js` | `start()` / `stop()` cron job — polls all active shops every N minutes |

### Recently completed

| File | What it does |
|---|---|
| `server.js` | Express app: session, body-parser order (webhook routes before `express.json()`), route mounts, runs migrations + scheduler on boot |
| `src/routes/oauth.js` | `GET /shopify/oauth/install` — validates shop, builds signed JWT state, redirects; `GET /shopify/oauth/callback` — verifies HMAC + state, exchanges code, upserts shop, registers webhooks, kicks off background sync |
| `src/routes/webhooks.js` | `POST /webhooks/shopify` — `captureRawBody` → `verifyWebhookHmac` → look up shop by domain header → `processWebhookEvent`; responds 200 before processing |
| `src/routes/api.js` | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/shops`, `GET /api/shops/:id`, `DELETE /api/shops/:id`, `GET /api/shops/:id/orders`, `GET /api/shops/:id/products`, `GET /api/shops/:id/customers`, `GET /api/shops/:id/sync-logs`, `POST /api/shops/:id/sync` |
| `public/index.html` | SPA shell — single `<div id="app">` entry point |
| `public/style.css` | Clean admin dashboard styles — sidebar, topbar, tables, badges, modal, pagination |
| `public/app.js` | Vanilla JS SPA — login, shop list, orders/products/customers/logs tabs, manual sync, disconnect, connect modal, paginated tables |

---

## Database Schema

### `shops`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `shop_domain` | VARCHAR UNIQUE | e.g. `mystore.myshopify.com` |
| `access_token` | TEXT | OAuth permanent token |
| `scope` | TEXT | granted scopes |
| `shop_info` | JSONB | metadata from Shopify `/shop.json` |
| `is_active` | BOOLEAN | set false on `app/uninstalled` |
| `installed_at` | TIMESTAMPTZ | |
| `last_synced_at` | TIMESTAMPTZ | used as `updated_at_min` for incremental polls |

### `orders` / `products` / `customers`
All have a `(shop_id, shopify_id)` UNIQUE constraint for idempotent upserts and a `raw_data JSONB` column storing the full Shopify payload.

### `sync_logs`
Event audit trail — `event_type`, `resource_type`, `status` (`success`/`error`), `message`, `metadata JSONB`.

---

## Setup

### 1. Shopify Partner Dashboard (one-time)

1. Create an app → **Custom Distribution** (not App Store).
2. Set **App URL** to `https://<HOST_URL>/`.
3. Add **Redirect URL**: `https://<HOST_URL>/shopify/oauth/callback`.
4. Copy **Client ID** and **Client secret**.
5. Set scopes: `read_orders, write_orders, read_products, write_products, read_customers, write_customers, read_inventory, write_inventory`.

### 2. Environment variables

```bash
cp .env.example .env
# fill in all values — see .env.example for descriptions
```

Key variables:

| Variable | Description |
|---|---|
| `SHOPIFY_API_KEY` | Client ID from Partner Dashboard |
| `SHOPIFY_API_SECRET` | Client secret — used for HMAC verification |
| `HOST_URL` | Public URL of this server (no trailing slash) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Min 32-char random string for signing OAuth state tokens |
| `SESSION_SECRET` | Random string for Express session |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | Admin dashboard login |
| `VDELIVERS_API_URL` + `VDELIVERS_API_KEY` | Optional — leave blank to skip push |
| `POLL_INTERVAL_MINUTES` | Polling fallback cadence (default 5) |

### 3. Install and run

```bash
npm install
npm run dev        # nodemon — auto-restart on changes
# or
npm start          # production
```

The server runs migrations automatically on boot.

---

## OAuth Flow

```
Merchant browser
  │
  ├─► GET /shopify/oauth/install?shop=mystore.myshopify.com
  │       └─ server builds signed JWT state, redirects to Shopify grant screen
  │
  ├─► Merchant approves → Shopify calls:
  │       GET /shopify/oauth/callback?code=…&shop=…&hmac=…&state=…
  │
  └─► Server:
        1. verifyOAuthHmac(query)                       ← HMAC check
        2. jwt.verify(state) → { tenantId, nonce }      ← state check
        3. exchangeCodeForToken(shop, code)             ← get access_token
        4. upsert into shops table
        5. registerAllWebhooks(shop, token, HOST_URL)   ← 9 webhook topics
        6. fullSync(shop)                               ← initial data pull
        7. redirect → success page
```

---

## Webhook Topics Registered

| Topic | Action |
|---|---|
| `orders/create` | upsert order |
| `orders/updated` | upsert order |
| `orders/cancelled` | upsert order (cancel_reason set) |
| `products/create` | upsert product |
| `products/update` | upsert product |
| `products/delete` | delete from local DB |
| `customers/create` | upsert customer |
| `customers/update` | upsert customer |
| `app/uninstalled` | set `is_active=false`, clear `access_token` |

---

## Security

- OAuth callback HMAC verified with `SHOPIFY_API_SECRET` before any processing.
- Webhook HMAC verified with `SHOPIFY_API_SECRET` on raw (pre-parsed) body.
- OAuth `state` is a short-TTL (10 min) signed JWT — replay protection via nonce.
- Dashboard routes require session login; credentials in env vars (not hardcoded).
- `access_token` cleared immediately on `app/uninstalled`.

---

## Next Steps

1. Build `server.js` and the route files listed in the TODO table above.
2. Wire up the `captureRawBody` middleware only on `/webhooks/*` (must come before `express.json()`).
3. Add a minimal HTML dashboard in `public/` or a separate frontend.
4. Deploy behind HTTPS — Shopify requires TLS on all callback and webhook URLs.
5. In production, envelope-encrypt `access_token` at rest (KMS or similar).
