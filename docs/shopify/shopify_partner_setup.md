# Shopify Partner Dashboard — Step-by-Step Setup

You already have a **Shopify Partner account** at <https://partners.shopify.com>.
This doc takes you from there to a working **"Connect Shopify"** OAuth button
in the SaaS, in about 10 minutes.

What you'll end up with:

- A Custom Distribution App registered in your Partner account
- `SHOPIFY_API_KEY` + `SHOPIFY_API_SECRET` in your `.env`
- Per-tenant install URLs that walk merchants through the standard Shopify
  permission screen and auto-register webhooks for orders, products, and
  app/uninstalled

---

## Step 1 — Open the Apps section

1. Sign in at <https://partners.shopify.com>.
2. Left sidebar → **Apps**.
3. You'll see a list of any apps you've already created (probably empty).
4. Top-right → **Create app**.

You'll get a "How would you like to create your app?" screen:

- Pick **Create app manually** (NOT *Use Shopify CLI*).

---

Shopify Partner App:

Store URL: https://vdelivers-drvk9n7t.myshopify.com/
Store password: rartau

Client ID:
0b904b0eb4bda6c17915462fe4abe543

Secret:
(set in Railway env var SHOPIFY_API_SECRET — do not commit)



## Step 2 — Name the app + choose distribution

You'll see a form like this:

| Field | Value |
|---|---|
| App name | `VDelivers` (or whatever you want — merchants see this on the consent screen) |
| App URL | `http://localhost:3001/` for dev — your prod URL later |
| Allowed redirection URL(s) | `http://localhost:8002/shopify/oauth/callback` |

Click **Create app**.

> ⚠ The redirect URL **must match exactly** — case, port, path, no trailing
> slash. Mismatch produces `redirect_uri_mismatch` on install.

After creation you'll land on the app's overview page.

---

## Step 3 — Configure API access (scopes)

Left side-nav inside the app → **Configuration**.

Scroll to **Admin API access scopes** and tick exactly these:

- ✅ `read_orders`
- ✅ `write_orders`
- ✅ `read_products`
- ✅ `write_products`
- ✅ `read_customers`

(Optional, only if you'll wire courier dispatch from Shopify side later:
`read_fulfillments`, `write_fulfillments`.)

Click **Save** at the top of the Configuration page.

---

## Step 4 — Switch to Custom Distribution

In the same Configuration page (or **Distribution** in the left nav), find
**Distribution** section.

- Pick **Custom distribution** (NOT "Public" / App Store).
- Confirm.

This means your app installs only via per-merchant install links you generate
yourself — which is exactly what our `/shopify/oauth/install` endpoint does.
You don't need Shopify's app review.

---

## Step 5 — Copy the Client ID and Client Secret

Left nav → **Client credentials** (also visible at the top of the Configuration
page in newer Partner Dashboards).

You'll see two fields:

- **Client ID** — long string, ~32 chars
- **Client secret** — click **Reveal** if it's hidden

Copy both. Treat the secret like a password.

---

## Step 6 — Paste into `.env`

Open `/Users/sayan/Documents/personal/sme-automation/.env` and add or update:

```env
SHOPIFY_API_KEY=YOUR_CLIENT_ID_HERE
SHOPIFY_API_SECRET=YOUR_CLIENT_SECRET_HERE
SHOPIFY_SCOPES=read_orders,write_orders,read_products,write_products,read_customers
```

Already-default values you can ignore unless you need to change them:

```env
PUBLIC_API_BASE_URL=http://localhost:8002   # set in docker-compose.yml; matches the redirect URL
PUBLIC_WEB_BASE_URL=http://localhost:3001   # where merchants land after OAuth completes
```

---

## Step 7 — Restart the API and verify

```bash
cd /Users/sayan/Documents/personal/sme-automation
docker compose up -d api
sleep 5
docker compose exec -T api python -c "
from src.core.config import get_settings
s = get_settings()
print('shopify configured:', bool(s.shopify_api_key and s.shopify_api_secret))
"
```

Should print `shopify configured: True`.

---

## Step 8 — Test the install in the browser

You need a **development store** to install into. Partners can create unlimited
free dev stores:

1. Partner Dashboard → **Stores** → **Add store** → **Create development store**.
2. Pick *Create a store to test and build*.
3. Store name: anything (e.g. `vdelivers-dev`).
4. Build version: latest.
5. **Create development store**. You'll get a URL like `vdelivers-dev.myshopify.com`.

Now exercise the SaaS-side OAuth flow:

1. Make sure your tenant is **active**. If you're testing as
   `saifulbrur9379@gmail.com`, that workspace is already active.
2. Log in at <http://localhost:3001/login>.
3. Go to **Settings → Website → Shopify** tab.
4. In the **Connect via Shopify (recommended)** banner:
   - Type the dev-store handle (the part before `.myshopify.com`) — e.g. `vdelivers-dev`.
   - Click **Install**.
5. Browser redirects to Shopify's **install / permissions** screen for that dev store.
6. Click **Install app**.
7. Browser redirects back to `/settings/website?shopify=connected&shop=vdelivers-dev.myshopify.com`.
8. The Shopify connection is now in `store_connections`, webhooks are registered, and any test order placed on the dev store will fire into our orders pipeline within seconds.

To make a test order on the dev store:

1. Open the dev store admin (link in Partner Dashboard → Stores → click your store).
2. Add a product (any product is fine).
3. Open the storefront (top-right "Online Store" eye icon, password = the one shown in the dev store details).
4. Buy it (Shopify dev stores let you complete checkout with bogus card numbers — see <https://help.shopify.com/manual/checkout-settings/test-orders>).
5. Within ~5 seconds, the order appears in `/orders` in the SaaS, with `call_status=pending` ready for the AI agent.

---

## Step 9 — Going to production

When you're ready to ship to real merchants:

1. In the Partner Dashboard app → **Configuration** → **App URL** + **Allowed redirection URLs**:
   - Replace `http://localhost:3001/` with `https://app.your-domain.com`.
   - Replace `http://localhost:8002/shopify/oauth/callback` with `https://api.your-domain.com/shopify/oauth/callback`.
   - You can keep the localhost entries alongside for dev (Shopify allows multiple redirect URLs).
2. Update `.env` (or production secrets manager) with the prod `PUBLIC_API_BASE_URL` and `PUBLIC_WEB_BASE_URL`.
3. Rotate the client secret if it's been exposed in any logs / chat / commits.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503 shopify_app_not_configured` from Install button | env var empty or API not reloaded | check `docker compose exec api env | grep SHOPIFY`, then `docker compose up -d api` |
| `redirect_uri_mismatch` on Shopify's install screen | redirect URL in Partner Dashboard doesn't match `PUBLIC_API_BASE_URL/shopify/oauth/callback` exactly | fix the **Allowed redirection URLs** in Partner Dashboard → Configuration |
| "App can't be installed because of an oAuth error" | scopes mismatch (you ticked one in dashboard but request asked for a different one) | ensure `SHOPIFY_SCOPES` env matches the scopes you ticked in step 3 |
| 502 `shopify_token_exchange_failed` after merchant approval | client secret typo, or you copied an old/rotated secret | regenerate secret in Partner Dashboard, update `.env`, restart API |
| Webhooks don't fire | dev stores deliver webhooks normally, but check Partner Dashboard → app → **Webhooks** for delivery failures | usually a redirect-URL or HMAC issue — check `docker compose logs --tail 100 api` |
| `store_orders_synced` events for the right tenant but wrong shop | a merchant connected the same shop to two different tenants | each tenant needs its own dev store; same shop can't OAuth into two tenants |

### Reading what Shopify is sending

```bash
docker compose logs --follow api | grep -i shopify
```

Every install / callback / webhook leaves a trace in the API logs.

---

## What's already built on our side

You don't need to write any code — `apps/api/src/store/shopify.py` already handles:

- `GET /shopify/oauth/install?shop=…` → builds a signed-state install URL
- `GET /shopify/oauth/callback` → HMAC-verifies, exchanges code, upserts `StoreConnection`, registers webhooks
- `POST /webhooks/shopify/{connection_id}` → HMAC-verifies, dispatches `orders/*`, `products/*`, `app/uninstalled`
- `app/uninstalled` handler → drops the access token, marks the connection inactive

The only thing missing was the actual app registration in your Partner account. Once you finish steps 1–7 above, the whole pipeline lights up.
