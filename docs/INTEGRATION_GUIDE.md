# vDelivers Shopify Connector — Integration Guide

---

## 1. App Installation (Merchant Side)

### Install URL

Send this link to any merchant to install the Shopify app on their store:

```
https://noble-intuition-production.up.railway.app/shopify/oauth/install?shop=MERCHANT-STORE.myshopify.com
```

Replace `MERCHANT-STORE` with the merchant's actual Shopify store name.

**Example:**
```
https://noble-intuition-production.up.railway.app/shopify/oauth/install?shop=gadgetking.myshopify.com
```

### What happens after the merchant clicks the link

1. Merchant is redirected to their Shopify Admin → permission approval screen
2. Merchant clicks **Install app**
3. The connector automatically:
   - Saves the store and access token
   - Registers webhooks for orders, products, and customers
   - Starts an initial sync of all existing orders
4. Merchant lands on the connector dashboard — **no login required**

---

## 2. Connecting vDelivers Backend to a Shop

### Option A — During Install (Recommended for vDelivers-initiated flows)

Pass the merchant's vDelivers credentials directly in the install URL. The connector saves them automatically after OAuth — no setup form needed.

```
https://noble-intuition-production.up.railway.app/shopify/oauth/install
  ?shop=MERCHANT-STORE.myshopify.com
  &vdelivers_api_url=http://35.255.120.233:3001
  &vdelivers_api_key=MERCHANT_API_KEY
  &redirect_to=http://35.255.120.233:3001/settings/website
```

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `shop` | Yes | Merchant's Shopify store domain |
| `vdelivers_api_url` | No | vDelivers backend base URL |
| `vdelivers_api_key` | No | Merchant's unique API key from vDelivers |
| `redirect_to` | No | Where to send the merchant after install |

After OAuth completes, the connector redirects back to `redirect_to`. The vDelivers backend can detect the completed install by reading the `?connected=SHOP` query parameter appended to the return URL.

---

### Option B — After Install (From Connector Dashboard)

1. Open the connector dashboard:
   ```
   https://noble-intuition-production.up.railway.app
   ```
2. Select the shop from the sidebar
3. Click **⚠ Setup vDelivers**
4. Enter the vDelivers API URL and API Key
5. Click **Save Credentials**

---

## 3. What the vDelivers Backend Needs to Implement

The connector pushes orders to the vDelivers backend at this endpoint:

### `POST {vdelivers_api_url}/shopify/ingest`

**Authentication:**
```
Authorization: Bearer {vdelivers_api_key}
```

**Request body:**
```json
{
  "shop": "merchant-store.myshopify.com",
  "orders": [
    {
      "id": "uuid",
      "shopify_id": 5678901234,
      "order_number": "#1001",
      "status": "open",
      "financial_status": "paid",
      "fulfillment_status": null,
      "customer": {
        "id": 1234567890,
        "email": "customer@example.com",
        "name": "John Doe"
      },
      "line_items": [
        {
          "id": 111,
          "title": "Product Name",
          "quantity": 2,
          "price": "25.00",
          "sku": "SKU-001"
        }
      ],
      "shipping_address": {
        "first_name": "John",
        "last_name": "Doe",
        "address1": "123 Main St",
        "city": "Dhaka",
        "country": "Bangladesh",
        "zip": "1200",
        "phone": "+8801700000000"
      },
      "total_price": "50.00",
      "currency": "BDT",
      "shopify_created_at": "2026-06-27T10:00:00Z",
      "shopify_updated_at": "2026-06-27T10:05:00Z"
    }
  ]
}
```

**Expected responses:**

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "ok": true }` | Success |
| `401` | `{ "error": "..." }` | Invalid API key |
| `4xx/5xx` | `{ "error": "..." }` | Failure — connector will retry |

---

## 4. vDelivers Backend — Shopify Settings Page Changes Required

> **This section is for the vDelivers backend developer.**

The **Settings → Website → Shopify** page currently generates its own Shopify OAuth URL with a stale ngrok redirect URI, which causes a `400 invalid_request` from Shopify. This needs to be fixed.

### What to change

The **Install** button on `/settings/website` should redirect to the connector's install URL instead of generating a Shopify OAuth URL directly.

**Replace the current OAuth URL generation with a redirect to:**

```
https://noble-intuition-production.up.railway.app/shopify/oauth/install
  ?shop={SHOP}.myshopify.com
  &vdelivers_api_url=http://35.255.120.233:3001
  &vdelivers_api_key={TENANT_API_KEY}
  &redirect_to=http://35.255.120.233:3001/settings/website
```

Where:
- `{SHOP}` = the value the merchant typed in the shop input field
- `{TENANT_API_KEY}` = the merchant's unique vDelivers API key (generate one if it doesn't exist yet)

### What currently breaks

The current code sends:
```
redirect_uri=https://platonic-vanity-shower.ngrok-free.dev/shopify/oauth/callback
```

This is an old ngrok development URL that is **not registered** in the Shopify Partner Dashboard. Shopify rejects it immediately.

### After install — showing the connection as active

After OAuth, the connector redirects back to the `redirect_to` URL. To show the connection as active on the Settings page, the vDelivers backend should either:

1. **Detect via `?connected=` param** — the connector appends `?connected=SHOP` to the redirect URL. Read this on page load and mark the shop as connected in the DB.
2. **Detect via first ingest** — when `POST /shopify/ingest` is received for a shop for the first time, create the connection record automatically.

---

## 5. When Orders Are Synced

| Trigger | When |
|---|---|
| **Full sync** | Immediately after the merchant installs the app |
| **Webhook** | Within seconds of a new order or order update in Shopify |
| **Polling fallback** | Every 5 minutes — catches any webhooks Shopify failed to deliver |

The `shop` field in the request body identifies which merchant the orders belong to — use it on the vDelivers side to route to the correct account.

---

## 6. Connector Dashboard

Access the dashboard at:
```
https://noble-intuition-production.up.railway.app
```

From the dashboard you can:
- View all connected stores
- Browse synced orders, products, and customers
- Set or update vDelivers credentials per shop
- Trigger a manual sync
- View sync logs
- Disconnect a store

---

## 7. Environment Variables (Railway)

| Variable | Value |
|---|---|
| `SHOPIFY_API_KEY` | `0b904b0eb4bda6c17915462fe4abe543` |
| `SHOPIFY_API_SECRET` | *(set in Railway — do not share publicly)* |
| `HOST_URL` | `https://noble-intuition-production.up.railway.app` |
| `JWT_SECRET` | *(random 32+ char string)* |
| `SESSION_SECRET` | *(random 32+ char string)* |
| `NODE_ENV` | `production` |
| `VDELIVERS_API_URL` | *(optional — global fallback if not set per shop)* |
| `VDELIVERS_API_KEY` | *(optional — global fallback if not set per shop)* |

---

## 8. Shopify Partner Dashboard Settings

| Setting | Value |
|---|---|
| App URL | `https://noble-intuition-production.up.railway.app/` |
| Allowed redirect URL | `https://noble-intuition-production.up.railway.app/shopify/oauth/callback` |
| Distribution | Custom distribution |

---

## 9. Health Check

Verify the connector is running:
```
GET https://noble-intuition-production.up.railway.app/health
```
Returns `{ "status": "ok" }` when healthy.
