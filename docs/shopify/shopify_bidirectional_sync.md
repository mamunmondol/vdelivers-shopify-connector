# Shopify ↔ VDelivers — Bidirectional Sync

How customer/order information flows IN from Shopify, and how status changes
flow back OUT after our SaaS confirms / cancels / ships an order.

This doc is the single-page summary tying together the four sibling docs:

- `docs/shopify_app.md` — architecture diagrams (the why)
- `docs/shopify_implementation.md` — code map (the where)
- `docs/shopify_status_mapping.md` — state machine table (the rules)
- `docs/status_sync_back.md` — outbound outbox + worker (the how)

Read this one if you just want to know **what gets captured** and **what gets
pushed back**, without reading 1500 lines of code.

---

## 1. The two halves in one diagram

```
═══════════════════════════════════════════════════════════════════════════════
                               SHOPIFY
═══════════════════════════════════════════════════════════════════════════════

       OUTBOUND (us → Shopify)            INBOUND (Shopify → us)
       us writes back                     we capture
              ▲                                  │
              │                                  │
              │  PUT /orders/{id}.json           │  POST /webhooks/shopify/
              │   tags, note                     │       {connection_id}
              │                                  │
              │  POST /orders/{id}/cancel.json   │  X-Shopify-Hmac-Sha256: …
              │                                  │  body: full order payload
              │  POST /fulfillments.json         │
              │   tracking_number, items         │  Topics:
              │                                  │    orders/create
              │  POST /fulfillments/{id}/        │    orders/updated
              │       events.json                │    orders/paid
              │   {status: "delivered"}          │    orders/cancelled
              │                                  │    products/*
              │  POST /fulfillments/{id}/        │    app/uninstalled
              │       cancel.json                │    customers/data_request
              │                                  │    customers/redact
              │                                  │    shop/redact
              │                                  ▼
═══════════════════════════════════════════════════════════════════════════════
                              VDELIVERS SaaS
═══════════════════════════════════════════════════════════════════════════════

  ┌─────────────────────────┐         ┌──────────────────────────────────┐
  │ Outbound worker         │         │ Webhook ingest                   │
  │  src/store/outbound/    │         │  src/store/shopify.py            │
  │   shopify_client.py     │         │   shopify_webhook (POST handler) │
  │   worker.py             │         │   _handle_order()                │
  │                         │         │   _handle_product()              │
  │ • update_call_status_   │         │   _handle_uninstall()            │
  │   confirmed             │         │                                  │
  │ • update_call_status_   │         │ Captures (every webhook):        │
  │   note  (unreachable/   │         │   ✓ external_id                  │
  │   failed)               │         │   ✓ customer_name                │
  │ • cancel_order          │         │   ✓ customer_phone               │
  │ • create_fulfillment    │         │   ✓ customer_address             │
  │ • fulfillment_event     │         │   ✓ customer_email (passthrough) │
  │ • fulfillment_cancel    │         │   ✓ line_items[] (name/sku/qty)  │
  │                         │         │   ✓ amount_paisa, shipping_paisa │
  │ HMAC-signed,            │         │   ✓ financial_status →            │
  │ idempotent retry        │         │     call_status                  │
  │ classifier:             │         │   ✓ fulfillment_status →          │
  │   422 → success         │         │     courier_status               │
  │   401/403 → auto-       │         │   ✓ cancelled_at →                │
  │     disable             │         │     call/courier_status=         │
  │   429/5xx → retry       │         │     cancelled                    │
  │   404 → dead-letter     │         │                                  │
  └─────────────▲───────────┘         └─────────────────┬────────────────┘
                │                                       │
   enqueue_status_sync                            INSERT orders +
   (same DB txn as the                            INSERT order_items
   status mutation —                              (or UPDATE if exists)
   transactional outbox)                                │
                │                                       │
                ▼                                       ▼
       ┌─────────────────────────────────────────────────────┐
       │ orders table                                         │
       │   id, tenant_id, store_connection_id, external_id   │
       │   customer_name, customer_phone, customer_address    │
       │   amount_paisa, shipping_paisa, …                    │
       │   call_status:    pending|calling|confirmed|         │
       │                   cancelled|unreachable|failed       │
       │   courier_status: pending|in_transit|delivered|      │
       │                   hold|cancelled|returned            │
       │   items[]                                            │
       │                                                      │
       │ outbound_sync_jobs table                             │
       │   pending → sent | failed | dead | paused            │
       └──────────────────────────────────────────────────────┘
                ▲
                │  Operator action in /orders, OR AI agent flips
                │  status after call, OR courier-status poller
                │  updates after delivery confirmation
                │
       ┌────────┴───────────┐
       │ /orders UI         │
       │  Confirm,          │
       │  Send to courier,  │
       │  Mark delivered,   │
       │  Cancel            │
       └────────────────────┘
```

---

## 2. Inbound — what we capture from Shopify

When a customer places an order on the merchant's storefront, Shopify fires
the `orders/create` webhook to `https://api.your-domain.com/webhooks/shopify/{connection_id}`.
The handler is `shopify_webhook` in `src/store/shopify.py`.

### Per webhook, the handler does

1. **Verify HMAC** — `X-Shopify-Hmac-Sha256` header signed with `SHOPIFY_API_SECRET`
   over the raw request body. Reject 401 on mismatch.
2. **Look up the connection** — by `connection_id` path parameter; reject if
   the connection is gone or not Shopify.
3. **Compute target states** — `_shopify_target_states(payload)` collapses
   Shopify's `financial_status` + `fulfillment_status` + `cancelled_at` +
   `fulfillments[].shipment_status` into our two state machines (call_status,
   courier_status). See `docs/shopify_status_mapping.md` for the truth table.
4. **INSERT or UPDATE the order** — keyed on
   `(tenant_id, store_connection_id, external_id)` for idempotency.
5. **Replace line items** — cascade-delete old items, insert fresh from the
   webhook payload.
6. **Loop guard** — for an existing order, only propagate state if it's a
   merchant-driven terminal (cancelled/refunded/fulfillment_delivered) OR if
   our local call_status is still `pending`. Routine echoes from our own
   outbound pushes are silently dropped.
7. **Return 200** — Shopify retries on 5xx but stops on 2xx. We always 2xx
   if the request was authenticated, even if the payload is unrecognizable
   (we just log + drop).

### Customer fields captured

From the webhook payload:

| Shopify field | Our column |
|---|---|
| `id` | `external_id` |
| `customer.first_name + last_name` (with shipping_address fallback) | `customer_name` |
| `customer.phone` (with shipping_address.phone fallback) | `customer_phone` |
| `shipping_address.address1 + address2 + city + province + zip + country` | `customer_address` |
| `total_price` × 100 | `amount_paisa` |
| `shipping_lines[].price` summed × 100 | `shipping_paisa` |
| `financial_status` (paid/refunded/voided/…) | mapped → `call_status` |
| `fulfillment_status` (null/partial/fulfilled/restocked) + `fulfillments[]` | mapped → `courier_status` |
| `cancelled_at` (non-null) | call_status=cancelled, courier_status=cancelled |
| `line_items[]` (id, product_id, title, sku, quantity, price) | `order_items` rows |

### Real-time vs. polling

- **Real-time webhooks** (production path): Shopify POSTs to our endpoint
  within ~3 seconds of the storefront event.
- **1-minute auto-poller** (fallback for missed webhooks): runs every 60s,
  calls `GET /admin/api/2025-01/orders.json?updated_at_min=<watermark>`,
  pipes each order through the same `_handle_order` parser. See
  `src/store/inbound_poller.py`.

Same code path for both — the parser doesn't care if it's a webhook or a poll.

---

## 3. Outbound — what we push back to Shopify

When the operator clicks **Confirm**, **Send to courier**, **Mark delivered**,
or **Cancel** in `/orders` (or the AI agent flips `call_status` after a call,
or the courier-status poller updates `courier_status` after a delivery
confirmation), the SAME database transaction that mutates `orders.call_status`
or `orders.courier_status` ALSO inserts a row into `outbound_sync_jobs`. This
is the **transactional outbox** pattern — guarantees we never have a torn
state where the local DB updated but the remote didn't.

A background worker (`src/store/outbound/worker.py`) drains
`outbound_sync_jobs`:

1. `SELECT FOR UPDATE SKIP LOCKED` — claim one pending job (multi-replica safe).
2. Look up the connection's credentials (real `shpat_…` token).
3. Dispatch by `(action, target_state)` to the right handler in
   `src/store/outbound/shopify_client.py`.
4. The handler hits Shopify's Admin API.
5. Mark the job `sent` on success; on failure, exponential backoff
   (1s, 5s, 30s, 5m, 30m, 2h, 12h) up to 8 attempts then `dead-letter`.

### The 8 outbound actions

| Internal transition | Shopify call | Effect in merchant's admin |
|---|---|---|
| `call_status: → confirmed` | `PUT /orders/{id}.json` adds `vd-ai-confirmed` tag + appends `[VDelivers] Confirmed by AI agent at <ts>` to private note | order tagged + noted |
| `call_status: → cancelled` | `POST /orders/{id}/cancel.json` reason=`customer` | order moves to **Cancelled** |
| `call_status: → unreachable` | `PUT /orders/{id}.json` adds `vd-unreachable` tag + note | tag + note only, no status change |
| `call_status: → failed` | `PUT /orders/{id}.json` adds `vd-call-failed` tag + note | tag + note only |
| `courier_status: → in_transit` | `GET /orders/{id}/fulfillment_orders.json` then `POST /fulfillments.json` with line_items_by_fulfillment_order + tracking_info | order moves to **Fulfilled**, customer gets tracking |
| `courier_status: → delivered` | `POST /orders/{id}/fulfillments/{f_id}/events.json` `status=delivered` | "Delivered" event in fulfillment timeline |
| `courier_status: → returned` | `POST /fulfillments/{f_id}/cancel.json` + `vd-returned` tag | fulfillment cancelled |
| `courier_status: → cancelled` | `POST /fulfillments/{f_id}/cancel.json` | fulfillment cancelled |

### Idempotency on Shopify's side

| Replay scenario | Shopify response | We treat it as |
|---|---|---|
| Re-add a tag already on the order | 200 OK (set semantics) | success |
| Re-cancel an already-cancelled order | 422 with "already cancelled" | success |
| Re-create a fulfillment with same tracking_number | 422 "already fulfilled" | success |
| Re-post a `delivered` event | 200 OK (Shopify de-dupes) | success |
| Re-cancel an already-cancelled fulfillment | 422 | success |

---

## 4. End-to-end operator journey (what you see in the UI)

Once Shopify Protected Customer Data is approved and the connection is real
(non-mock), here's exactly what happens at each step:

```
T+0s    Customer places order on the merchant's storefront
        (e.g. ms-fashion-shop.myshopify.com).

T+~3s   Shopify fires orders/create webhook to
        https://api.your-domain.com/webhooks/shopify/{conn_id}.
        Our HMAC-verified handler parses the payload, INSERTs the
        Order row with full customer name/phone/address/items.

T+~3s   Order appears at the top of /orders in our SaaS.
        The "Live · just now" badge shows fresh data.
        Sync indicator dot is green (no outbound queued yet).

T+10m   Operator clicks Place AI call on the order.
        AI calls the customer (real telephony), confirms the order.
        On success: call_status flips from pending → confirmed.
        SAME transaction inserts outbound_sync_jobs row.
        Sync indicator dot turns AMBER (pending push).

T+10m+5s  Outbound worker picks up the job:
          PUT /orders/{external_id}.json with tags+="vd-ai-confirmed"
          and a private note. Job marked 'sent'.
          Sync indicator dot turns GREEN.
          In Shopify Admin, the order now shows the tag + note.

T+15m   Operator clicks Send to courier (Pathao / Steadfast / RedX).
        Courier adapter calls the courier's API, gets a tracking_code.
        courier_status flips: pending → in_transit.
        Outbound job enqueued.

T+15m+5s  Worker calls Shopify:
          GET /orders/{id}/fulfillment_orders.json
          POST /fulfillments.json with line_items_by_fulfillment_order
          and tracking_info{number, company}.
          Order in Shopify Admin moves to Fulfilled state.
          Customer gets a tracking notification email from Shopify.

T+next day  Courier delivers. Their poller flips
            courier_status: in_transit → delivered.
            Outbound job enqueued.

T+next day +5s   Worker calls:
                 POST /orders/{id}/fulfillments/{f_id}/events.json
                 {status: "delivered"}.
                 Shopify timeline shows "Delivered" event.

(Cancellation paths are symmetric — all 8 transitions push back.)
```

---

## 5. Edge cases handled

### Merchant cancels in Shopify admin AFTER we shipped

```
T+0    AI confirmed → call_status=confirmed (pushed: tag + note)
T+5m   Operator shipped → courier_status=in_transit (pushed: fulfillment)
T+30m  Merchant clicks Cancel order in Shopify Admin
T+30m+3s  Webhook orders/cancelled fires
T+30m+3s  cancelled_at is non-null → propagate to local
          call_status=cancelled, courier_status=cancelled
          confirmation_method=manual
T+30m+3s  Inbound NEVER calls enqueue_status_sync — no outbound loop.
          Courier dispatch is NOT recalled — the parcel may be on the truck.
```

The SaaS reflects the merchant's intent; the courier-side stays running until
its own poller surfaces the actual delivered/returned state.

### Echo from our own confirm push

```
T+0   AI confirms → call_status=confirmed, enqueue
T+2s  Worker pushes → PUT /orders/{id}.json with vd-ai-confirmed tag
                      (financial_status NOT changed by us)
T+30s Webhook orders/updated arrives because the order was modified
      → financial_status=paid (unchanged)
      → loop guard: 'paid' is NOT a merchant terminal
      → local call_status already 'confirmed' (non-pending)
      → DO NOTHING ✓
```

Matched in `_handle_order`'s loop guard branch:
- `is_merchant_terminal` → propagate
- else if `existing.call_status == "pending"` → propagate
- else → silently drop

### Echo from our own fulfillment push

```
T+0   Operator ships → courier_status=in_transit, enqueue
T+2s  Worker → POST /fulfillments.json
                Shopify sets fulfillment_status='fulfilled'
T+5s  Webhook orders/updated → fulfillment_status='fulfilled'
      → loop guard: 'fulfilled' is NOT a merchant terminal
      → mapping says it'd be courier_status=in_transit (= current)
      → no-op ✓
```

### Multiple connections per tenant

A tenant can have several Shopify shops connected (one
`store_connections` row each). Orders are keyed on `(tenant_id,
store_connection_id, external_id)` so the same Shopify order id from
two different shops doesn't collide.

### Token revocation

If the merchant uninstalls the app from their Shopify Admin:
1. Shopify fires `app/uninstalled` webhook.
2. Our handler clears `credentials.access_token`, sets
   `is_active=false`, sets `outbound_disabled=true`, pauses sibling
   outbound jobs.
3. New status changes still queue outbound jobs but get `paused` status.
4. Re-installing creates a new token, flips active=true, drains paused
   jobs in chronological order.

---

## 6. What's gated by Protected Customer Data (PCD)

Both halves of the bidirectional flow touch PCD:

| | What's gated by PCD |
|---|---|
| **Inbound** | webhook subscription for `orders/*` topics (registration returns 403 until PCD approved); REST polling of `/admin/api/.../orders.json` (returns 403) |
| **Outbound** | `PUT /admin/api/.../orders/{id}.json` (the orders endpoint contains customer fields → returns 403) |

**Same approval flips both on simultaneously.**

What's NOT gated by PCD (works today):
- `products/*` webhooks
- `app/uninstalled` webhook
- `/admin/api/.../products.json` (read & write)
- `/admin/api/.../shop.json`
- `/admin/api/.../orders/count.json` (count only, no PII)

See `docs/shopify_app_store_submission.md` §3.1 and `docs/shopify_dev_store_testing.md`
for the PCD declaration steps.

---

## 7. CSV import as the no-PCD fallback

For testing or onboarding without going through PCD, the merchant can export
orders from Shopify Admin (Orders → Export → CSV) and upload via the
**Import Shopify CSV** button on the connection card. Implementation in
`src/store/shopify_csv.py`. The CSV parser maps Shopify's column layout
(Name, Email, Total, Lineitem name/quantity/price, Shipping Address1/City/Zip,
Phone) onto the same `Order` shape — orders flow into the SaaS with full
customer info, just batch-instead-of-realtime.

CSV import does NOT push outbound (operator's status changes still go to the
mock sink in dev-mock mode, or to api.shopify.com once PCD lights up). It's
purely an inbound bypass for the API gate.

---

## 8. Code references

| Concern | File |
|---|---|
| Webhook ingest endpoint | `src/store/shopify.py` → `shopify_webhook()` |
| Inbound order parser | `src/store/shopify.py` → `_handle_order()` |
| Inbound state mapper | `src/store/shopify.py` → `_shopify_target_states()` |
| 1-min auto-poller | `src/store/inbound_poller.py` |
| CSV importer | `src/store/shopify_csv.py` |
| Outbound enqueue helper | `src/store/outbound/enqueue.py` → `enqueue_status_sync()` |
| Outbound worker (drain loop) | `src/store/outbound/worker.py` |
| Outbound action handlers | `src/store/outbound/shopify_client.py` |
| Outbox table | `src/store/outbound/models.py` → `OutboundSyncJob` |
| Status mapping rules | `docs/shopify_status_mapping.md` |
| Outbound architecture | `docs/status_sync_back.md` |
| Implementation guide | `docs/shopify_implementation.md` |

---

## 9. TL;DR

| Capability | How |
|---|---|
| Capture customer name / phone / address / items / total / dates | `orders/create` webhook → `_handle_order` → INSERT |
| Capture status changes from Shopify Admin | `orders/updated`, `orders/cancelled`, `orders/paid` webhooks → `_handle_order` with loop guard |
| Push our confirm back to Shopify | `enqueue_status_sync` → outbound worker → `PUT /orders/{id}.json` (tag + note) |
| Push our shipping back to Shopify | outbound worker → `POST /fulfillments.json` with tracking |
| Push delivery back to Shopify | outbound worker → `POST /fulfillments/{id}/events.json` |
| Push our cancel back to Shopify | outbound worker → `POST /orders/{id}/cancel.json` |
| Loop prevention | inbound respects `_SHOPIFY_MERCHANT_TERMINALS`; doesn't re-enqueue from inbound path |
| Token revocation handling | `app/uninstalled` webhook → `_handle_uninstall` |
| GDPR compliance webhooks | `src/store/shopify_compliance.py` (data_request / customer_redact / shop_redact) |

The SaaS is fully bidirectional, idempotent, retry-aware, and tenant-isolated.
The only thing standing between today's dev-mock and tomorrow's production is
the Protected Customer Data declaration on the Shopify Partner side.
