# Shopify App — Implementation Guide

How the Shopify integration was built, module-by-module. Read this if you're
about to touch the Shopify code, want to extend it (a new outbound action, a
new webhook topic), or just need to understand how the pieces fit together.

For sibling docs:
- **Why** the design looks the way it does → `docs/shopify_app.md`
- **One-time setup** in Shopify Partner Dashboard → `docs/shopify_partner_setup.md`
- **Bidirectional state mapping** → `docs/shopify_status_mapping.md`
- **Per-client onboarding runbook** → `docs/client_onboarding.md`

---

## 1. Build journey & key decisions

The integration was built in five distinct layers, each landed before the next:

```
   Layer                            Where it lives
   ─────────────                    ──────────────────────────────────────
   1. Inbound (orders/products)     src/store/shopify.py
                                    (webhooks + helpers)

   2. OAuth install + callback      src/store/shopify.py (same file)
                                    (custom-distribution flow)

   3. Outbound sync (us → Shopify)  src/store/outbound/shopify_client.py
                                    + worker + outbox table

   4. Status mapping                src/store/shopify.py (_shopify_target_states)
                                    + outbound dispatch tables

   5. Dev-mock for local testing    src/store/shopify_dev_mock.py
                                    (gated on APP_ENV=dev)
```

### Decision log

| Decision | Rationale | Alternatives considered |
|---|---|---|
| **Custom Distribution app** (not Public App Store) | One-app, many-installs, no Shopify review. Suits B2B SaaS with manual onboarding for now. | Public App — defer until 50+ clients/month |
| **Webhook-primary, polling-fallback** | Real-time status changes; polling backfills any webhooks Shopify failed to deliver | Pure polling — too laggy. Pure webhook — orders get lost on flake. |
| **Transactional outbox** for outbound | Same DB txn that mutates `orders.call_status` enqueues the push. No torn states between local and remote. | Inline API calls — block UI. Celery — overkill at our volume. |
| **Per-action handlers, not a god method** | Each transition (`confirmed`, `cancelled`, `in_transit`, etc.) is a separate Python function with its own retry/idempotency story | One mega-`update_shopify_order` function — becomes a 500-line if/elif tangle |
| **Signed-state JWT** for OAuth `state` param | Carries `tenant_id` across the round-trip without trusting URL params; short TTL prevents replay | DB row keyed by random nonce — works but adds a write |
| **Dev-mock auto-disabled when SHOPIFY_API_KEY is set** | Hard guardrail: prod can't accidentally hit the mock | Feature flag — fragile (one missed env var = silent disaster) |

---

## 2. The Partner Dashboard registration (one-time)

Already documented in `docs/shopify_partner_setup.md`. In a sentence: we
registered a **Custom Distribution app** in Shopify Partner Dashboard with
client ID `0b904b0e…`, redirect URL `http://localhost:8002/shopify/oauth/callback`,
and these scopes: `read_orders, write_orders, read_products, write_products,
read_customers`. The Client ID + Secret live in `.env` as `SHOPIFY_API_KEY` /
`SHOPIFY_API_SECRET`; everything else is computed at runtime.

---

## 3. Code structure

```
apps/api/src/store/
├── models.py                    # StoreConnection — generic per-tenant integration row
├── router.py                    # Settings → Website CRUD endpoints (multi-source)
├── shopify.py                   # ★ Shopify-specific install + callback + inbound webhooks
├── shopify_dev_mock.py          # ★ Dev-only mock provider for local testing
└── outbound/
    ├── __init__.py
    ├── models.py                # OutboundSyncJob — the outbox row
    ├── enqueue.py               # enqueue_status_sync(order, transition)
    ├── worker.py                # SELECT FOR UPDATE SKIP LOCKED → dispatch loop
    ├── shopify_client.py        # ★ The 8 outbound actions to Shopify Admin API
    ├── woocommerce_client.py    # WC sister client (same shape)
    └── types.py                 # SyncOk / SyncRetry / SyncDead / SyncAuthFailed
```

---

## 4. Layer-by-layer walkthrough

### 4.1 Layer 1 + 2 — `src/store/shopify.py`

This file owns three groups of endpoints:

#### (a) `GET /shopify/oauth/install` — kicks off OAuth

Builds the Shopify install URL with our client ID + a signed-state JWT
carrying `tenant_id`. Refuses to issue a URL if `tenant.status != "active"` —
this is what enforces the SaaS-Admin approval gate.

Key code:

```python
# Signed state — short-TTL (10 min) JWT carrying tenant_id + nonce.
state = _issue_state_jwt(effective, nonce)
params = {
    "client_id": settings.shopify_api_key,
    "scope": settings.shopify_scopes,
    "redirect_uri": redirect_uri,
    "state": state,
}
install_url = f"https://{shop_domain}/admin/oauth/authorize?{urlencode(params)}"
```

#### (b) `GET /shopify/oauth/callback` — handles Shopify's redirect

Three security checks, in order:

1. **HMAC verification** of the entire query string (minus `hmac` and
   `signature`) using `SHOPIFY_API_SECRET`. Rejects forged callbacks.
2. **JWT verification** of the `state` param. Recovers `tenant_id`.
   Re-checks tenant is `active`.
3. **Code-for-token exchange** with `POST /admin/oauth/access_token`.

Then upserts `StoreConnection` and registers webhooks.

```python
# Idempotent webhook registration — Shopify returns 422 if (topic, address)
# already exists, which we treat as success.
WEBHOOK_TOPICS = (
    "orders/create", "orders/updated", "orders/paid", "orders/cancelled",
    "products/create", "products/update", "products/delete",
    "app/uninstalled",  # ← critical for cleanup
)
```

#### (c) `POST /webhooks/shopify/{connection_id}` — inbound webhook ingest

HMAC-verifies the raw request body using the per-app `SHOPIFY_API_SECRET`,
then dispatches by `X-Shopify-Topic`:

```python
if topic == "app/uninstalled":
    await _handle_uninstall(session, row)        # drops access_token, deactivates
elif topic.startswith("orders/"):
    await _handle_order(session, row, topic, payload)
elif topic.startswith("products/"):
    await _handle_product(session, row, topic, payload)
```

`_handle_order` is the meat — it calls `_shopify_target_states(payload)` to
collapse Shopify's three-field state space (`financial_status`,
`fulfillment_status`, `cancelled_at`, `fulfillments[].shipment_status`) onto
our two state machines, then applies the loop guard before mutating the
local Order row. See `docs/shopify_status_mapping.md` for the full state
machine.

### 4.2 Layer 3 — outbox + worker

Three files do the heavy lifting:

**`src/store/outbound/models.py`** — `OutboundSyncJob` table:

```python
class OutboundSyncJob(Base):
    __table_args__ = (
        UniqueConstraint("order_id", "action", "target_state",
                         name="uq_outbound_pending"),  # ← idempotency
        Index("ix_outbound_pending", "next_attempt_at",
              postgresql_where="status = 'pending'"),  # ← worker hot path
    )

    id, tenant_id, store_connection_id, order_id
    provider, action, target_state, payload (JSONB)
    status: pending | sent | failed | dead | paused
    attempts, last_attempt_at, next_attempt_at, last_error
    sent_at
```

**`src/store/outbound/enqueue.py`** — single entry point:

```python
async def enqueue_status_sync(session, order, transition: str):
    """
    Called from operator/agent mutation sites in the SAME txn that mutates
    orders.call_status / orders.courier_status. Never called from inbound
    webhook handlers — that would create a sync loop.
    """
    field, value = transition.split(":", 1)
    action, target_state = _DISPATCH[(field, value)]   # internal noise filtered
    ...
    await session.execute(
        pg_insert(OutboundSyncJob).values(...)
        .on_conflict_do_nothing(constraint="uq_outbound_pending")
    )
```

**`src/store/outbound/worker.py`** — the loop:

```python
async def _claim_one(session):
    return (await session.execute(
        select(OutboundSyncJob)
        .where(OutboundSyncJob.status == "pending")
        .where(OutboundSyncJob.next_attempt_at <= now)
        .order_by(OutboundSyncJob.next_attempt_at)
        .limit(1)
        .with_for_update(skip_locked=True)   # ← multi-replica safe
    )).scalar_one_or_none()

# Backoff: [1s, 5s, 30s, 5m, 30m, 2h, 12h], dead at attempt 8 (~24h).
BACKOFF = [1, 5, 30, 5*60, 30*60, 2*3600, 12*3600]
```

The worker auto-disables connections on auth failure (`401`/`403`):

```python
elif isinstance(result, SyncAuthFailed):
    conn.outbound_disabled = True
    job.status = "paused"
    # Pause all sibling jobs on the same connection.
    await session.execute(update(OutboundSyncJob)
        .where(OutboundSyncJob.store_connection_id == conn.id)
        .where(OutboundSyncJob.status == "pending")
        .values(status="paused", ...))
    await audit_record(action="outbound_connection_disabled", ...)
```

The worker runs as a FastAPI lifespan task in dev (single-process, embedded).
For prod, comment that out and run `python -m src.store.outbound.worker` as a
separate service — the SKIP LOCKED claim keeps multiple replicas correct.

### 4.3 Layer 4 — `src/store/outbound/shopify_client.py`

8 actions, one per (action, target_state) pair, dispatched from the worker
via a lookup table:

```python
ACTIONS = {
    ("update_call_status", "confirmed"): update_call_status_confirmed,
    ("append_note",        "unreachable"): update_call_status_note,
    ("append_note",        "failed"): update_call_status_note,
    ("cancel_order",       "cancelled"): cancel_order,
    ("create_fulfillment", "in_transit"): create_fulfillment,
    ("fulfillment_event",  "delivered"): fulfillment_event,
    ("fulfillment_cancel", "returned"): fulfillment_cancel,
    ("fulfillment_cancel", "cancelled"): fulfillment_cancel,
}
```

Every handler is idempotent and returns one of `SyncOk / SyncRetry / SyncDead
/ SyncAuthFailed`. The classifier `_classify_http()` maps Shopify HTTP
responses centrally:

```python
401 / 403 → SyncAuthFailed   # token revoked, auto-disable
404       → SyncDead          # order/fulfillment gone upstream
422       → success (idempotent replay — already in target state)
429       → SyncRetry         # rate limit, back off
5xx       → SyncRetry         # upstream blip
4xx other → SyncDead          # config bug, drop the job
```

`create_fulfillment` is the only handler with two API calls — it has to
`GET /orders/{id}/fulfillment_orders.json` first to find which Fulfillment
Orders to ship from (multi-location stores can have several open at once),
then `POST /fulfillments.json` with `line_items_by_fulfillment_order`. See
the comment in that function for the wire format.

### 4.4 Layer 5 — `src/store/shopify_dev_mock.py`

Hard-gated to `APP_ENV=dev` AND empty `SHOPIFY_API_KEY`. Provides:

| Endpoint | Purpose |
|---|---|
| `GET /shopify/dev-mock/consent` | HTML page that mimics Shopify's permission screen — includes a yellow `DEV MOCK` badge so it can't be confused with the real one |
| `POST /shopify/dev-mock/install` | Creates a real `StoreConnection` row with `credentials.dev_mock=true` and a fake `shpat_DEVMOCK_…` token |
| `POST /shopify/dev-mock/fire-webhook/{connection_id}` | Synthesizes a Shopify-shaped order payload and calls the real `_handle_order` to exercise the inbound parser |
| `GET /shopify/dev-mock/calls` | In-memory log of every outbound call the worker would have made — useful for asserting in smoke tests |

The outbound worker short-circuits dev-mock connections so they never reach
`api.shopify.com`:

```python
# In src/store/outbound/shopify_client.py:
async def dispatch(conn, *, action, target_state, payload):
    if (conn.credentials or {}).get("dev_mock"):
        from ..shopify_dev_mock import record_mock_call
        record_mock_call(shop=conn.label, action=action, ...)
        return SyncOk()
    # …else hit real Shopify
```

Setting `SHOPIFY_API_KEY` to a real value automatically disables the entire
mock module — every endpoint returns 404. Zero risk of leaking into prod.

---

## 5. The full request lifecycle

End-to-end, what happens when a merchant clicks **Connect Shopify** in the SaaS:

```
   Browser        SaaS API           Postgres            Shopify
     │               │                  │                  │
1.   │ click Install                    │                  │
     │──────────────►│                  │                  │
     │               │ build install URL│                  │
     │               │  with state JWT  │                  │
     │  install_url  │                  │                  │
     │◄──────────────│                  │                  │
2.   │ open new tab to install_url      │                  │
     │─────────────────────────────────────────────────────►│
     │                                  │                  │
     │  Shopify shows permission screen                    │
     │◄────────────────────────────────────────────────────│
3.   │ click "Install app"              │                  │
     │─────────────────────────────────────────────────────►│
     │                                  │                  │
     │  302 → /shopify/oauth/callback?code=…&hmac=…&state=…│
     │◄────────────────────────────────────────────────────│
4.   │ GET /shopify/oauth/callback       │                  │
     │──────────────►│                  │                  │
     │               │ verify HMAC                          │
     │               │ verify state JWT                     │
     │               │ POST /admin/oauth/access_token ─────►│
     │               │                                  ◄──│ access_token
     │               │ INSERT store_connections             │
     │               │──────────────►│  ✓                  │
     │               │ register N webhooks ────────────────►│
     │               │                                  ✓  │
     │               │ INSERT audit_log                     │
     │               │──────────────►│                     │
     │  302 → /settings/website?shopify=connected           │
     │◄──────────────│                                      │
     │                                                       │
5.   │ ……time later, merchant places test order on Shopify…
     │                                                       │
     │  POST /webhooks/shopify/{conn_id}                    │
     │  ◄────────────────────────────────────────────────── │
     │               │ HMAC verify                           │
     │               │ _handle_order(payload)                │
     │               │ _shopify_target_states(payload)       │
     │               │ INSERT orders + items                 │
     │               │──────────────►│  ✓                   │
     │  200 OK                                               │
     │  ────────────────────────────────────────────────────►│
     │                                                       │
6.   │ ……AI agent confirms the order…
     │                                                       │
     │               │ orders.call_status = 'confirmed'      │
     │               │ enqueue_status_sync(call_status:confirmed)
     │               │ INSERT outbound_sync_jobs             │
     │               │ COMMIT (txn)  │                       │
     │                                                       │
7.   │ ……outbound worker tick…
     │                                                       │
     │               │ SELECT FOR UPDATE SKIP LOCKED         │
     │               │  → claim 1 job                        │
     │               │ shopify_client.update_call_status_confirmed
     │               │ PUT /admin/api/.../orders/{id}.json ─►│ tag + note
     │               │                                  ◄──│ 200
     │               │ UPDATE outbound_sync_jobs            │
     │               │  SET status='sent'                    │
     │               │ INSERT audit_log                      │
```

---

## 6. How to extend

### Adding a new outbound action

E.g. *"when call_status hits `retry`, add a `vd-retry-pending` tag in Shopify"*.

1. Add to `_DISPATCH` in `src/store/outbound/enqueue.py`:
   ```python
   ("call_status", "retry"): ("update_call_status", "retry"),
   ```
2. Add a handler in `src/store/outbound/shopify_client.py`:
   ```python
   async def update_call_status_retry(conn, *, external_id, **_):
       # similar to update_call_status_note — tag + note
   ```
3. Wire it into `ACTIONS`:
   ```python
   ("update_call_status", "retry"): update_call_status_retry,
   ```
4. Same for WC if applicable (`woocommerce_client.py`).
5. No migration needed — outbound_sync_jobs.action is a free-form String(40).

### Adding a new inbound webhook topic

E.g. handling `customers/update` to update local customer data.

1. Add to `WEBHOOK_TOPICS` in `src/store/shopify.py` so it's auto-registered
   on install:
   ```python
   WEBHOOK_TOPICS = (..., "customers/update")
   ```
2. Add a dispatch branch in `shopify_webhook`:
   ```python
   elif topic.startswith("customers/"):
       await _handle_customer(session, row, topic, payload)
   ```
3. Implement `_handle_customer` similar to `_handle_order`.
4. Existing connections won't have the new topic registered until they
   reinstall — write a one-off backfill script that calls
   `_register_webhooks` for every active connection.

### Adding a new provider (e.g. BigCommerce)

The outbound machinery is provider-agnostic:

1. Add `bigcommerce` to `PUSH_PROVIDERS` in `src/store/outbound/enqueue.py`.
2. New file `src/store/outbound/bigcommerce_client.py` with the same shape
   as `shopify_client.py`: `ACTIONS` table, per-action handlers, `dispatch`
   function returning `SyncOk/Retry/Dead/AuthFailed`.
3. Register it in `_PROVIDER_CLIENTS` in `src/store/outbound/worker.py`.
4. Inbound work (webhooks, OAuth, polling) is per-provider — write a sister
   file to `src/store/shopify.py`.

---

## 7. Testing

Local: use the dev-mock (`docs/shopify_partner_setup.md` Step 8 covers this).
Real: install onto a Shopify dev store created from your Partner Dashboard.

Smoke tests we ran during development:

| Scenario | Tool | Result |
|---|---|---|
| Inbound parse — paid + unfulfilled | synthetic payload via `_handle_order` | call=confirmed, courier=pending |
| Inbound parse — cancelled_at set | synthetic payload | call=cancelled, courier=cancelled (terminal) |
| Inbound parse — refunded post-delivery | synthetic payload | call=cancelled, courier=*leave alone* (terminal) |
| Inbound parse — restocked | synthetic payload | call=cancelled, courier=returned (terminal) |
| Outbox enqueue + worker dispatch | PATCH `/tenant/orders/{id}` | new outbound_sync_jobs row, worker marks `sent` within 5s |
| Idempotent replay | PATCH same status twice | second PATCH is no-op (changed list empty), no duplicate enqueue |
| Auth failure auto-disable | revoke token in Shopify | next worker tick → `outbound_disabled=true`, sibling jobs paused |
| Dev-mock end-to-end | install → fire-webhook → confirm → check `/calls` | full chain green |

---

## 8. Operational notes

- **Logs**: every install, callback, webhook, and outbound action leaves a trail in either `audit_log` or stdout (`docker compose logs api | grep -i shopify`).
- **Token rotation**: `app/uninstalled` webhook drops the token and deactivates the connection. Re-install via the same UI button.
- **Webhook delivery failures**: Shopify retries failed webhooks for 48h before giving up. Polling fallback (per `docs/shopify_app.md` §2) covers anything Shopify drops.
- **Rate limits**: Shopify Admin API is 2 req/s leaky bucket per shop. Our worker is single-threaded per shop (one job at a time → no contention). 429 → SyncRetry → exponential backoff handles spikes.
- **Multi-replica worker**: `SELECT FOR UPDATE SKIP LOCKED` is the locking primitive. Run as many worker processes as you want; each row is processed exactly once.

---

## 9. What we did NOT build (and why)

- **Bulk operations API integration**. Shopify offers Bulk Order Operations
  for >500-orders/min throughput. Out of scope for v1; our merchants peak
  at maybe 50 orders/min.
- **GraphQL API**. We use REST throughout. GraphQL is more efficient for
  multi-resource fetches but the per-action handlers don't need that.
- **Multipass / customer SSO**. Not relevant — we don't do customer auth.
- **Theme app extensions / app bridge**. We don't render UI inside Shopify
  Admin. The merchant interacts with our SaaS at `/settings/website`.
- **Bulk webhooks deletion on uninstall**. Shopify automatically deactivates
  webhooks when the app is uninstalled; we just clear our local state.
