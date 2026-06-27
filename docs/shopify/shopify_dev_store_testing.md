# Testing Shopify Order Flow on Your Dev Store

End-to-end test plan for verifying that orders placed on your Shopify dev
store land in the SaaS, get confirmed via the AI call agent, and the status
syncs back to Shopify.

> **No ngrok needed.** The 1-minute auto-poller (`apps/api/src/store/inbound_poller.py`)
> picks up new orders via Shopify Admin API, so you don't need a public URL
> for inbound testing. Real-time webhooks need a tunnel — covered in §6.

Your dev store: `vdelivers-drvk9n7t.myshopify.com`
Storefront password: `rartau`
App Client ID: `0b904b0eb4bda6c17915462fe4abe543`

---

## Step 1 — Add the dev store to Custom Distribution

The 400 you hit earlier was Shopify rejecting the OAuth install because the
dev store wasn't on your app's allowed-stores list. Fix it once:

1. Open <https://partners.shopify.com/current/apps>.
2. Click your app **VDelivers**.
3. Left nav → **Distribution**.
4. If asked "Choose how to distribute your app", pick **Custom distribution** → **Choose**.
5. Click **Add store** (or **+ Custom distribution link**).
6. Paste exactly:
   ```
   vdelivers-drvk9n7t.myshopify.com
   ```
7. Save.

Shopify generates a per-store install link. You don't need to copy it — our
SaaS UI builds the same OAuth URL when you click Install.

---

## Step 2 — Install the app via the SaaS UI

1. Open <http://localhost:3001/login> as `admin@demo.local` / `DemoAdmin-Pass!1`
   (or whichever active tenant you want to test on).
2. **Settings → Website** → **Shopify** tab.
3. In the green **Connect via Shopify (recommended)** banner, type the shop
   handle (just the prefix, no `.myshopify.com`):
   ```
   vdelivers-drvk9n7t
   ```
4. Click **Install** → new tab opens to Shopify's permission screen.
5. Sign into Shopify Admin if not already.
6. Click **Install app**.
7. The new tab redirects to `/settings/website?shopify=connected&shop=vdelivers-drvk9n7t.myshopify.com`. Close it, come back to the original tab, click **Refresh**.
8. New Shopify connection appears in the list, marked **Active**, with `sync_orders=true` and `sync_products=true` enabled by default.

### Verify it took

```bash
docker compose exec -T postgres psql -U vdelivers -d vdelivers -c "
SELECT label, is_active, sync_orders,
       (credentials->>'access_token') IS NOT NULL AS has_token,
       credentials->>'shop_url' AS shop_url
FROM store_connections
WHERE label = 'vdelivers-drvk9n7t.myshopify.com';
"
```

You want: `is_active=t, sync_orders=t, has_token=t`. The token is a real `shpat_...` string from Shopify's OAuth response.

---

## Step 3 — Add a product to the dev store

You need at least one purchasable item to place an order against.

1. Partner Dashboard → **Stores** → click `vdelivers-drvk9n7t.myshopify.com` → opens the **Shopify Admin**.
2. **Products → Add product**.
3. Fill in:
   - Title: `Test Cotton Punjabi`
   - Price: `1450.00`
   - Track quantity: off (skip stock for now)
   - Status: **Active** (top-right)
4. Click **Save**.

---

## Step 4 — Place a test order on the storefront

1. From Shopify Admin top-right, click **View store** (the eye icon).
2. The storefront asks for a password — enter `rartau`.
3. Click on your test product → **Add to cart** → **Check out**.
4. Fill in shipping info (any plausible Bangladesh address — e.g. `Karim Rahman / +8801711111111 / House 12, Dhanmondi, Dhaka, 1205`).
5. **Continue to shipping** → **Continue to payment**.
6. Use Shopify's test card: `Bogus Gateway` if visible, or enter card number `1` for a successful test order, or `2` for a declined test. (Shopify dev stores have these built in. Cardholder name = anything; expiry = any future date; CVV = any 3 digits.)
7. Click **Pay now**.

You should land on a "Thank you" / order confirmation page. The order is now in Shopify.

---

## Step 5 — Watch it land in the SaaS (within 60 seconds)

Two ways to see it:

### (a) Browser

Go to <http://localhost:3001/orders>. The header will show the **Live · …** badge. Within ~1 minute:
- The order count goes up by 1.
- A new row appears at the top with `Karim Rahman / +8801711111111 / 1450 BDT / call_status=confirmed`.
- The order's `source=website` and the connection-label column shows `vdelivers-drvk9n7t.myshopify.com`.

### (b) Database

```bash
docker compose exec -T postgres psql -U vdelivers -d vdelivers -c "
SELECT o.external_id, o.customer_name, o.customer_phone, o.amount_paisa,
       o.call_status, o.courier_status, o.created_at
FROM orders o
JOIN store_connections sc ON sc.id = o.store_connection_id
WHERE sc.label = 'vdelivers-drvk9n7t.myshopify.com'
ORDER BY o.created_at DESC LIMIT 3;
"
```

### Why it works without webhooks

The inbound poller (`src/store/inbound_poller.py`, runs every 60s) calls
`GET /admin/api/.../orders.json?status=any&updated_at_min=<watermark>` against
Shopify and pipes each order through `_handle_order` — same parser that
processes real-time webhooks. First time the watermark is unset, so it pulls
the last 30 days. Subsequent ticks pull only deltas.

---

## Step 6 — Confirm an order, watch it sync back to Shopify

This validates the **outbound** half of the pipeline:

1. In `/orders`, find your test order (top row).
2. Click **Confirm** (or pick a different `call_status` via the row's edit menu).
3. Within 5 seconds, the outbound worker pushes:
   - `PUT /orders/{id}.json` with `tags += "vd-ai-confirmed"` and an appended `[VDelivers] Confirmed by AI agent...` private note.
4. Verify in the dev store admin: open the order → you'll see the new tag and the note in the timeline.

### Send to courier (the second outbound transition)

1. In `/orders`, click **Send to courier** on the same order.
2. Pick `steadfast` (or any configured courier).
3. The outbound worker pushes:
   - `POST /fulfillments.json` with the tracking number from the courier
   - The order moves to **Fulfilled** in the dev store admin
   - A "Tracking added" event appears in the order timeline

```bash
# DB-side verification: outbound jobs sent
docker compose exec -T postgres psql -U vdelivers -d vdelivers -c "
SELECT osj.action, osj.target_state, osj.status, osj.attempts,
       osj.sent_at IS NOT NULL AS sent
FROM outbound_sync_jobs osj
JOIN orders o ON o.id = osj.order_id
JOIN store_connections sc ON sc.id = o.store_connection_id
WHERE sc.label = 'vdelivers-drvk9n7t.myshopify.com'
ORDER BY osj.created_at DESC LIMIT 5;
"
```

Both jobs should be `sent=t`.

---

## Step 7 — (Optional) Real-time webhooks via ngrok

Skip this for testing; the 1-minute poller is sufficient. But if you want
seconds-latency inbound (matching production behaviour) you need a public
URL Shopify can POST to.

1. Install ngrok: `brew install ngrok` (macOS).
2. Run: `ngrok http 8002` — gives you a URL like `https://abc123.ngrok.app`.
3. Update `.env`:
   ```env
   PUBLIC_API_BASE_URL=https://abc123.ngrok.app
   ```
4. `docker compose up -d api`.
5. **Re-install** the app on the dev store from `/settings/website`. The new install registers webhooks pointing at the ngrok URL.

Now any order placed on the dev store fires a webhook in <5 seconds. The
poller still runs every minute as a fallback for any failed deliveries.

When you tear down ngrok, revert `PUBLIC_API_BASE_URL` back to `http://localhost:8002` and re-install — webhooks will re-register correctly.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Click Install → Shopify says "App can't be installed on this store" | Step 1 — add the shop to Custom Distribution |
| Click Install → 503 `shopify_app_not_configured` | `SHOPIFY_API_KEY/SECRET` empty — check `.env`, restart API |
| Connection saved, but no order appears after 60s | Check `docker compose logs api | grep -i 'inbound poller'`. The watermark may have advanced past the order's timestamp; trigger a manual sync from the connection card to backfill |
| Order appears with `call_status=pending` (not `confirmed`) | The inbound mapping treats Shopify `financial_status=paid` → `call_status=confirmed`. If you used the Bogus Gateway "card declined" card (`2`), `financial_status=pending` and our mapping leaves call_status as `pending` — that's correct |
| Confirm pushed back but no tag in Shopify admin | Check `outbound_sync_jobs.last_error` for that job. Most common: `401` token revoked → `outbound_disabled=true` automatically. Re-install. |

### Reading what's happening

```bash
docker compose logs --follow api | grep -iE 'shopify|inbound poller|outbound'
```

You'll see every install, callback, webhook (if ngrok), poller tick, outbound
push, in real time.

---

## Cross-references

- `docs/shopify_partner_setup.md` — one-time Shopify Partner setup
- `docs/client_onboarding.md` — production runbook (per-merchant)
- `docs/shopify_status_mapping.md` — bidirectional state machine
- `docs/shopify_implementation.md` — code map
