# vDelivers API Integration Spec
**For:** vDelivers Backend Developer  
**From:** vDelivers Product Team  
**Purpose:** Shopify Connector → vDelivers order sync

---

## Overview

We have a Shopify Connector app that installs on merchants' Shopify stores. When an order is placed, the connector syncs it to the merchant's vDelivers account via your API.

You need to provide **two things per merchant:**
1. An **API URL** (your server base URL)
2. An **API Key** (unique per merchant/account)

---

## The Endpoint You Need to Build

### `POST {API_URL}/shopify/ingest`

The connector will call this endpoint whenever orders are synced from Shopify.

**Authentication:**
```
Authorization: Bearer {API_KEY}
```

**Request body (JSON):**
```json
{
  "shop": "merchant-store.myshopify.com",
  "orders": [
    {
      "id": "uuid",
      "shop_id": "uuid",
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
          "sku": "SKU-001",
          "variant_id": 222
        }
      ],
      "shipping_address": {
        "first_name": "John",
        "last_name": "Doe",
        "address1": "123 Main St",
        "city": "Dhaka",
        "province": "",
        "country": "Bangladesh",
        "zip": "1200",
        "phone": "+8801700000000"
      },
      "total_price": "50.00",
      "currency": "BDT",
      "tags": "",
      "note": "",
      "shopify_created_at": "2026-06-27T10:00:00Z",
      "shopify_updated_at": "2026-06-27T10:05:00Z",
      "synced_at": "2026-06-27T10:06:00Z"
    }
  ]
}
```

**Expected response on success:**
```json
{ "ok": true }
```
HTTP status: `200`

**On auth failure:**  
HTTP status: `401`

**On error:**  
HTTP status: `4xx` or `5xx` with `{ "error": "reason" }`

---

## When This Gets Called

- When a merchant first connects their Shopify store (full sync of all existing orders)
- Every time a new order is placed (webhook, near real-time)
- Every time an order is updated (status change, fulfillment, etc.)
- Every 5 minutes as a polling fallback (catches any missed webhooks)

The `shop` field tells you which merchant's account the orders belong to — use it to route to the correct vDelivers account on your side.

---

## What You Need to Give Us Per Merchant

When a merchant signs up on vDelivers and wants to connect Shopify, you need to provide:

| Field | Example | Notes |
|-------|---------|-------|
| **API URL** | `https://api.vdelivers.com` | Your server base URL, no trailing slash |
| **API Key** | `vd_live_abc123xyz456` | Unique per merchant, used in the `Authorization` header |

The merchant will enter these in the Shopify Connector setup page after installing the app.

---

## Recommended: Per-Merchant API Keys

Each merchant should have their own unique API key so you can:
- Identify which vDelivers account to post orders to
- Revoke access for a specific merchant without affecting others
- Track usage per account

You can generate them however you like (random UUID, JWT, etc.) and expose them in the merchant's vDelivers dashboard under **Settings → API Keys**.

---

## Questions?

Contact the vDelivers product team. The connector is live at:  
`https://noble-intuition-production.up.railway.app`
