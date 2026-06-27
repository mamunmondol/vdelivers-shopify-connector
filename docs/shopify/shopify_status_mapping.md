# Shopify ↔ VDelivers — Status Mapping (bidirectional)

Source of truth for how Shopify order state maps onto our two internal state
machines (`call_status`, `courier_status`), in both directions.

Shopify is messier than WooCommerce: the order's state lives across **three
independent fields** (`financial_status`, `fulfillment_status`, `cancelled_at`)
plus per-fulfillment objects. Our mapping reads all of them and collapses the
combination onto our two states.

---

## 1. The state spaces

### Shopify order fields

| Field | Possible values | What it means |
|---|---|---|
| `financial_status` | `pending`, `authorized`, `partially_paid`, `paid`, `partially_refunded`, `refunded`, `voided` | Payment lifecycle |
| `fulfillment_status` | `null` (unfulfilled), `partial`, `fulfilled`, `restocked` | Order-level shipping state, derived from fulfillments |
| `cancelled_at` | timestamp or null | If non-null → order is cancelled. `cancel_reason` says why |
| `tags` | comma-separated string | Free-form labels, both ours (e.g. `vd-ai-confirmed`) and the merchant's |
| `note` | free text | Private merchant note. We append `[VDelivers] …` lines |
| `fulfillments[]` | array of Fulfillment objects | Per-shipment, each with `status` (`success`/`cancelled`) and `shipment_status` (`delivered`/`in_transit`/`out_for_delivery`/etc.) |

### Our internal states (same as WC)

```
call_status:    pending → calling → confirmed | cancelled | unreachable | retry | failed
courier_status: pending → in_transit → delivered | hold | cancelled | returned
```

---

## 2. Direction A — Shopify → us (inbound, webhooks + polling)

Webhooks arrive in seconds: `orders/create`, `orders/updated`, `orders/paid`,
`orders/cancelled`. Polling backfills any that fail to deliver.

### Per-field mapping

#### `financial_status` → our `call_status`

| Shopify `financial_status` | our `call_status` | Reasoning |
|---|---|---|
| `pending` | `pending` | Authorization not yet captured |
| `authorized` | `pending` | Same |
| `partially_paid` | `pending` | Active but incomplete |
| `paid` | `confirmed` | Fully paid. For card-paid stores this is auto; for COD stores `paid` means COD was collected at delivery, which IS confirmation |
| `partially_refunded` | `confirmed` | Was confirmed once, partially refunded after |
| `refunded` | `cancelled` | Fully refunded — treat as cancelled from our POV |
| `voided` | `cancelled` | Auth was voided pre-capture |

> ⚠ The `paid → confirmed` mapping is ambiguous: in a card-paid storefront, "paid"
> just means the customer's card cleared, not that they confirmed via call. For
> a COD storefront, "paid" means the courier collected cash on delivery. Both
> interpretations point to a confirmed-from-merchant POV order, so the mapping
> is correct in practice — but be aware when interpreting telemetry.

#### `fulfillment_status` (+ `fulfillments[].shipment_status`) → our `courier_status`

| Shopify | our `courier_status` | Reasoning |
|---|---|---|
| `null` (unfulfilled) | `pending` | No items shipped yet |
| `partial` | `in_transit` | Some items on the way |
| `fulfilled` | `in_transit` *unless* a fulfillment has `shipment_status=delivered` → `delivered` | "Fulfilled" only means the merchant created a fulfillment; the courier might still be carrying the parcel |
| `fulfilled` + any fulfillment with `shipment_status=delivered` | `delivered` | The courier has confirmed drop-off |
| `restocked` | `returned` | Items restocked = parcel came back |

#### `cancelled_at` → both states

| Shopify | our `call_status` | our `courier_status` |
|---|---|---|
| `cancelled_at` is non-null | `cancelled` | `cancelled` (regardless of fulfillment_status — whatever's in transit is now cancelled from the merchant's POV) |

**`cancelled_at` always wins** — it's the merchant's explicit declaration that
the order is dead, and it overrides whatever the financial / fulfillment fields
say.

### Combined evaluation order

Reading inbound:

```
1. if order.cancelled_at is not None:
       call_status    = "cancelled"
       courier_status = "cancelled"

2. elif fulfillment_status == "restocked":
       call_status    = "cancelled"
       courier_status = "returned"

3. else:
       call_status    = MAP[financial_status]              # see table above
       courier_status = MAP[fulfillment_status]            # see table above
       if any fulfillment has shipment_status="delivered":
           courier_status = "delivered"
```

### Loop-prevention rule

Same shape as WooCommerce. Merchant-driven terminals always propagate; routine
echoes (financial_status=paid right after our confirm push, fulfillment_status=fulfilled
right after our create_fulfillment push) are filtered:

```
                ┌── webhook arrives / poller fetches ──┐
                │                                       │
                ▼                                       ▼
     New (no local row yet)?                  Existing local row?
                │                                       │
                ▼                                       ▼
     create with full mapping       Is the new state a
                                    MERCHANT TERMINAL?
                                    (cancelled_at set,
                                     fulfillment_status='restocked',
                                     financial_status in {'refunded','voided'},
                                     fulfillment.shipment_status='delivered')
                                                       │
                                              yes ────►│◄──── no
                                                       │
                                                       ▼
                                          Propagate to local
                                          (BOTH state machines if relevant)
                                          + confirmation_method='manual'
```

For non-terminal states (paid / authorized / fulfilled / partial), if our local
`call_status` is already non-pending (we acted on the order), we leave it alone —
that's the echo of our own outbound push. Only if local is still `pending` do
we let inbound update it.

---

## 3. Direction B — us → Shopify (outbound, sync worker)

Each internal transition fires one Admin API action. The handlers are in
`apps/api/src/store/outbound/shopify_client.py`.

| Internal transition | Shopify call | Effect in merchant's admin |
|---|---|---|
| `call_status: → confirmed` | `PUT /orders/{id}.json` with `tags += "vd-ai-confirmed"` and append `[VDelivers] Confirmed by AI agent at <ts>` to `note` | Order gets a `vd-ai-confirmed` tag and a private note. No status change. |
| `call_status: → cancelled` | `POST /orders/{id}/cancel.json` with `reason=customer` | Order moves to **Cancelled** in Shopify admin |
| `call_status: → unreachable` | `PUT /orders/{id}.json` with `tags += "vd-unreachable"` + note | Tag + note only |
| `call_status: → failed` | `PUT /orders/{id}.json` with `tags += "vd-call-failed"` + note | Tag + note only |
| `courier_status: → in_transit` | `GET /orders/{id}/fulfillment_orders.json` then `POST /fulfillments.json` with line_items_by_fulfillment_order + tracking_info | Order moves to **Fulfilled**; a Fulfillment object is created with the courier's tracking number |
| `courier_status: → delivered` | `POST /orders/{id}/fulfillments/{fulfillment_id}/events.json` with `status=delivered` | A "Delivered" event appears on the fulfillment timeline in Shopify admin |
| `courier_status: → returned` | `POST /fulfillments/{id}/cancel.json` + tag `vd-returned` | Fulfillment cancelled |
| `courier_status: → cancelled` | `POST /fulfillments/{id}/cancel.json` | Fulfillment cancelled |

### Idempotency on the Shopify side

| Replay scenario | Shopify response | We treat it as |
|---|---|---|
| Re-add a tag that's already on the order | 200 OK (set semantics) | success |
| Re-cancel an already-cancelled order | 422 with "already cancelled" | success (we accept 422 on cancel.json) |
| Re-create a fulfillment with the same tracking number on the same line items | 422 "already fulfilled" | success |
| Re-post a `delivered` event when one exists | 200 OK (events are append-only but Shopify de-dupes by status within a window) | success |
| Re-cancel an already-cancelled fulfillment | 422 | success |

The Shopify client classifies HTTP responses centrally:

```python
401 / 403 → SyncAuthFailed → auto-disable connection, alert tenant
404       → SyncDead       → order/fulfillment was deleted upstream
429       → SyncRetry      → rate limit, back off
5xx       → SyncRetry      → upstream blip, back off
422       → success        → idempotent replay
other 4xx → SyncDead       → permanent — config bug, drop the job
```

---

## 4. Edge cases

### Merchant cancels in Shopify admin after we've shipped

```
T+0   AI confirms                   → call_status=confirmed, push tag+note
T+5   Operator clicks "Send to courier" → courier_status=in_transit, push fulfillment
T+30  Merchant clicks "Cancel order" in Shopify admin
T+30  Shopify fires orders/cancelled webhook  → /webhooks/shopify/{id}
                                              → cancelled_at is non-null
                                              → loop guard: cancelled_at IS the
                                                merchant terminal — propagate
                                              → call_status='cancelled',
                                                courier_status='cancelled',
                                                confirmation_method='manual'
                                              → does NOT enqueue outbound
                                              → does NOT call the courier API
                                                (parcel may be on the truck)
```

Net effect: SaaS reflects the merchant's intent; the courier-side stays running
until its own status poller surfaces delivered/returned.

### Echo from our own confirm push

```
T+0   AI confirms          → call_status=confirmed, enqueue
T+2   Worker pushes        → PUT /orders/{id}.json with tag vd-ai-confirmed
                              (financial_status NOT changed by us)
T+30  Webhook orders/updated arrives because the order was modified
                          → financial_status=paid (unchanged)
                          → loop guard: paid is NOT in merchant terminals
                          → local call_status already 'confirmed' (non-pending)
                          → DO NOTHING ✓
```

### Echo from our own fulfillment push

```
T+0   Operator ships             → courier_status=in_transit, enqueue
T+2   Worker pushes               → POST /fulfillments.json
                                  → Shopify sets fulfillment_status='fulfilled'
T+5   Webhook orders/updated arrives → fulfillment_status='fulfilled'
                                     → loop guard: 'fulfilled' is NOT a
                                       merchant terminal
                                     → mapping says it'd be courier_status=
                                       in_transit, which equals current state
                                     → no-op ✓
```

### Customer receives parcel; courier marks delivered to Shopify

```
T+0   Our courier-status poller sees "delivered" from courier API
                                     → courier_status='delivered'
                                     → enqueue fulfillment_event/delivered
T+2   Worker pushes                  → POST /fulfillments/{f_id}/events.json
                                       status=delivered
                                     → Shopify shows "Delivered" in admin
T+10  Shopify auto-fires fulfillments/update webhook with shipment_status=delivered
                                     → matches our local state
                                     → no-op ✓
```

### Merchant manually marks fulfillment delivered in Shopify admin

(Some merchants use Shopify's built-in shipment-status updates rather than
our courier integration.)

```
T+0   Merchant in Shopify admin: Fulfillment → Mark as delivered
T+1   Webhook fulfillments/update arrives
                                     → shipment_status=delivered
                                     → merchant terminal: yes
                                     → propagate to local courier_status=delivered
                                     → confirmation_method='manual'
                                     → does NOT enqueue outbound
```

### Partial fulfillment

For orders with multiple line items where some ship and others don't:

```
fulfillment_status='partial' → courier_status='in_transit'
```

We treat partial as in_transit because at least one parcel is on the way.
When all line items are fulfilled, Shopify changes to `fulfilled` and we're
already at in_transit — no-op.

### Order with multiple fulfillments

A merchant might split an order into multiple fulfillments (e.g. one per
warehouse). Our courier integration creates ONE fulfillment per ship action.
For inbound:

- `fulfillment_status` reflects the aggregate (`partial` if any unfulfilled,
  `fulfilled` if all done).
- Per-fulfillment `shipment_status='delivered'` is checked across ALL
  fulfillments — if ANY is delivered, we set courier_status=delivered. (For
  multi-parcel orders that's debatable; v1 keeps it simple — we can split per
  parcel later if a merchant asks.)

---

## 5. Sequence: end-to-end happy path on Shopify

```
   AI agent      API           DB              Worker      Shopify
      │           │             │                  │           │
      │ confirms call              │                  │           │
      │──────────►│ UPDATE orders │                  │           │
      │           │   call_status='confirmed'        │           │
      │           │ INSERT outbound_sync_jobs        │           │
      │           │   action=update_call_status      │           │
      │           │   target=confirmed               │           │
      │           │   COMMIT                         │           │
      │                                              │ SELECT FOR UPDATE
      │                                              │ PUT /orders/{id}.json
      │                                              │  {tags+="vd-ai-confirmed",
      │                                              │   note+="[VDelivers] …"}
      │                                              │──────────►│
      │                                              │           │ ← admin shows new tag + note
      │                                              │   200     │
      │                                              │◄──────────│
      │
      │ Webhook orders/updated (echo)               │           │
      │◄────────────────────────────────────────────────────────│
      │ /webhooks/shopify/{id}                       │           │
      │ ─ cancelled_at is null
      │ ─ fulfillment_status not changed
      │ ─ financial_status=paid (unchanged)
      │ ─ NOT a merchant terminal
      │ ─ local already confirmed → no-op ✓
      │
      │ Operator ships             │                  │           │
      │──────────►│ UPDATE orders │                  │           │
      │           │   courier_status='in_transit'    │           │
      │           │ INSERT outbound_sync_jobs        │           │
      │           │   action=create_fulfillment      │           │
      │                                              │ POST /fulfillments.json
      │                                              │──────────►│ ← Fulfillment created
      │                                              │   201     │   tracking visible to customer
      │                                              │◄──────────│
      │
      │  …time passes, courier delivers…
      │
      │ Courier-status poller flips courier_status=delivered
      │           │ INSERT outbound_sync_jobs       │           │
      │           │   action=fulfillment_event       │           │
      │                                              │ POST /events.json
      │                                              │  status=delivered
      │                                              │──────────►│ ← timeline shows "Delivered"
      │                                              │   200     │
```

---

## 6. Code references

- **Inbound webhook + polling**: `apps/api/src/store/shopify.py`
  - `_handle_order` — main entrypoint for `orders/*` webhooks
  - `_SHOPIFY_TO_CALL_STATUS` — financial_status mapping
  - `_SHOPIFY_FULFILLMENT_TO_COURIER` (new) — fulfillment_status mapping
  - `_SHOPIFY_MERCHANT_TERMINALS` (new) — set of states that propagate even on existing orders
- **Outbound client**: `apps/api/src/store/outbound/shopify_client.py`
  - per-action handlers: `update_call_status_confirmed`, `cancel_order`, `create_fulfillment`, `fulfillment_event`, `fulfillment_cancel`
- **Enqueue helper**: `apps/api/src/store/outbound/enqueue.py`
- **Worker loop**: `apps/api/src/store/outbound/worker.py`

For the sister doc on WooCommerce see [`docs/woocommerce_status_mapping.md`](./woocommerce_status_mapping.md).
