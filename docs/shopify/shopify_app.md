# Shopify ↔ SME-Automation — End-to-End Integration

How a merchant's Shopify store gets connected to the **sme-automation** SaaS,
including the **SaaS-admin approval gate** that has to clear before a tenant's
Shopify install can go live.

This document covers:

1. Which Shopify app *type* to publish (and why)
2. The full lifecycle: tenant registration → SaaS-admin approval → app install → OAuth → webhooks → live sync
3. ASCII sequence + system diagrams
4. What we need to build inside `apps/api` and `apps/web`
5. Database / table additions
6. Concrete step-by-step procedure for the Shopify Partner side

---

## 1. Which Shopify app type to use

| Option | Verdict | Why |
|---|---|---|
| **Custom App (Admin → Apps → Develop apps)** | ⚠ Only for one-off pilot stores | Shop-owner-installed; no central distribution; no OAuth — they paste an Admin API token. Already supported today via `kind=shopify` (`shop_url` + `access_token`). |
| **Custom Distribution App (Partner Dashboard)** | ✅ **Recommended for sme-automation** | One app, installed per merchant via a unique install link issued by *us*. Full OAuth, webhooks, embedded UI possible. Doesn't go through Shopify App Store review. Perfect fit for a B2B SaaS that onboards merchants 1-by-1 after our own approval step. |
| **Public App (App Store listed)** | ⏳ Later | Requires Shopify's review + listing. Worth it once self-serve sign-up is open; not needed while every tenant is approved manually by SaaS Admin. |

**Decision:** ship a **Custom Distribution App** from our Shopify Partner account.
Keep the existing `shop_url + access_token` (manual paste) as a **fallback** for stores
that won't go through OAuth.

---

## 2. The full lifecycle (with the SaaS-admin approval gate)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PHASE A — Tenant onboarding                         │
└─────────────────────────────────────────────────────────────────────────────┘

  Merchant ──(1) Sign up on sme-automation web app ─────► apps/web /signup
                                                                │
                                                                ▼
                                               creates Tenant{ status="pending" }
                                                                │
                                                                ▼
                                               sends "pending approval" e-mail
                                                                │
                                                                ▼
  SaaS Admin ──(2) Reviews tenant in Super-Admin console ──────►
                  Approve  ─► Tenant.status = "active"
                  Reject   ─► Tenant.status = "rejected" (stop here)


┌─────────────────────────────────────────────────────────────────────────────┐
│                  PHASE B — Shopify install for the approved tenant           │
└─────────────────────────────────────────────────────────────────────────────┘

  Tenant Admin ──(3) Logs in ─► Settings → Integrations → "Connect Shopify"
                                                  │
                                                  ▼
                       apps/api issues an install URL bound to this tenant_id:
                       https://{shop}.myshopify.com/admin/oauth/authorize
                         ?client_id=APP_KEY
                         &scope=read_orders,write_orders,read_products,...
                         &redirect_uri=https://api.sme-automation/shopify/oauth/callback
                         &state=<signed JWT carrying tenant_id + nonce>
                                                  │
                                                  ▼
                       Tenant Admin clicks → redirected to their Shopify Admin
                                                  │
                                                  ▼
                       Shopify shows install/permission screen → merchant Approves
                                                  │
                                                  ▼
                       Shopify ──► GET /shopify/oauth/callback?code=…&shop=…&state=…
                                                  │
                                                  ▼
                       apps/api:
                          • verify HMAC of callback query
                          • verify signed state JWT → recover tenant_id
                          • POST {shop}/admin/oauth/access_token  → access_token
                          • upsert StoreConnection(tenant_id, kind="shopify",
                                  credentials={shop_url, access_token, scope},
                                  webhook_secret=<random>,
                                  is_active=true)
                                                  │
                                                  ▼
                       Register webhooks via Shopify Admin API:
                          orders/create, orders/updated, orders/paid, orders/cancelled
                          products/create, products/update, products/delete
                          app/uninstalled        ◄── critical for cleanup
                                                  │
                                                  ▼
                       Redirect Tenant Admin back to web UI:
                          /settings/integrations?shopify=connected


┌─────────────────────────────────────────────────────────────────────────────┐
│                       PHASE C — Live operation (steady state)                │
└─────────────────────────────────────────────────────────────────────────────┘

  Shopify event ──► POST /webhooks/shopify/{connection_id}
                          │
                          ▼
                   verify X-Shopify-Hmac-Sha256 with webhook_secret
                          │
                          ▼
                   normalize → upsert into orders / products
                   (dedupe on (tenant_id, store_connection_id, external_id))
                          │
                          ▼
                   if call_status = pending → enqueue AI call agent

  + 5-min poll fallback for any webhook delivery failures
  + app/uninstalled webhook → mark StoreConnection inactive, revoke tokens
```

---

## 3. System view (where it slots into existing architecture)

```
                ┌────────────── Shopify Cloud ───────────────┐
                │                                            │
                │   Merchant Admin (browser)                 │
                │        │ (1) install link                  │
                │        ▼                                   │
                │   OAuth grant screen                       │
                │        │                                   │
                │        ▼                                   │
                │   Shopify Auth Server  ──► access_token    │
                │        │                                   │
                │        ▼                                   │
                │   Shopify Webhooks (HMAC-signed)           │
                │        │                                   │
                └────────┼───────────────────────────────────┘
                         │
                         ▼
       ┌─────────────────────────────────────────────────────────────┐
       │                  apps/api (FastAPI)                          │
       │                                                              │
       │  /shopify/oauth/install   ── builds signed install URL       │
       │  /shopify/oauth/callback  ── exchanges code, saves token,    │
       │                              registers webhooks              │
       │  /webhooks/shopify/{id}   ── HMAC-verified ingest endpoint   │
       │                                                              │
       │  src/store/router.py      ── existing kind="shopify"         │
       │  src/store/models.py      ── StoreConnection (already there) │
       │  src/orders/...           ── Order normalize + upsert        │
       │  src/agent/...            ── AI call agent                   │
       │                                                              │
       └─────────────────────────────────────────────────────────────┘
                         │
                         ▼
       ┌──────────────────────────────────────────────┐
       │   Postgres                                   │
       │   • tenants(status: pending|active|…)        │
       │   • tenant_approvals (NEW — see §5)          │
       │   • store_connections (kind="shopify",       │
       │       credentials={shop_url, access_token},  │
       │       webhook_secret)                        │
       │   • orders / products                        │
       └──────────────────────────────────────────────┘
                         ▲
                         │
       ┌─────────────────┴───────────────────────┐
       │  apps/web (Next.js)                     │
       │                                         │
       │  Tenant: /settings/integrations         │
       │     → "Connect Shopify" button          │
       │  Super-Admin: /admin/tenants/approvals  │
       │     → approve / reject pending tenants  │
       └─────────────────────────────────────────┘
```

---

## 4. Sequence diagram — the approval-gated install

```
Merchant   Web (Next)   API (FastAPI)   Super-Admin   Shopify    Webhooks
   │           │             │                │           │           │
   │ signup    │             │                │           │           │
   │──────────►│ POST /signup│                │           │           │
   │           │────────────►│                │           │           │
   │           │             │ create tenant  │           │           │
   │           │             │ status=pending │           │           │
   │           │             │ notify admin   │           │           │
   │           │             │───────────────►│           │           │
   │           │             │                │           │           │
   │           │             │   approve      │           │           │
   │           │             │◄───────────────│           │           │
   │           │             │ status=active  │           │           │
   │           │             │ email tenant   │           │           │
   │           │             │                │           │           │
   │ login + click "Connect Shopify"          │           │           │
   │──────────►│             │                │           │           │
   │           │ GET /shopify/oauth/install   │           │           │
   │           │────────────►│                │           │           │
   │           │   302       │                │           │           │
   │           │◄────────────│                │           │           │
   │ 302 to Shopify install URL (with signed state)       │           │
   │─────────────────────────────────────────────────────►│           │
   │                         approve permissions          │           │
   │◄─────────────────────────────────────────────────────│           │
   │ 302 to /shopify/oauth/callback?code=…&shop=…&state=… │           │
   │─────────────────────────►│                │           │          │
   │                         │ verify HMAC + state         │          │
   │                         │ POST /admin/oauth/access_token────────►│
   │                         │ access_token  ◄────────────────────────│
   │                         │ upsert StoreConnection                  │
   │                         │ register webhooks ─────────────────────►│
   │                         │ 302 → /settings/integrations?shopify=connected
   │◄────────────────────────│                                         │
   │                                                                   │
   │ ……… steady state ………                                              │
   │                                                                   │
   │                         │  POST /webhooks/shopify/{id}  ◄─────────│
   │                         │  verify HMAC, upsert order              │
   │                         │  enqueue AI call                        │
```

---

## 5. What we need to build

### 5.1 Database changes

| Table | Change |
|---|---|
| `tenants` | already has `status` — make sure `pending`, `active`, `rejected`, `suspended` are all valid values |
| `tenant_approvals` (**new**) | `id, tenant_id, requested_at, decided_at, decided_by_user_id, decision (approve/reject), reason` — audit trail for SaaS-admin review |
| `store_connections` | already supports `kind="shopify"`. Extend `credentials` JSONB to also store `scope` and `installed_at`; reuse `webhook_secret` for HMAC verification |
| `audit_log` | record `tenant_approved`, `tenant_rejected`, `shopify_app_installed`, `shopify_app_uninstalled` |

### 5.2 New API endpoints (FastAPI)

| Method + Path | Purpose | Auth |
|---|---|---|
| `POST /platform/tenants/{id}/approve` | SaaS Admin approves a pending tenant | Super-Admin |
| `POST /platform/tenants/{id}/reject` | SaaS Admin rejects a pending tenant | Super-Admin |
| `GET /platform/tenants?status_filter=pending` | List pending tenants | Super-Admin |
| `GET /shopify/oauth/install?shop=…` | Build & redirect to Shopify install URL with signed `state` | Tenant Admin (active tenant only) |
| `GET /shopify/oauth/callback` | Exchange `code` → `access_token`, save StoreConnection, register webhooks | Public (Shopify calls it) — verified via HMAC + signed `state` |
| `POST /webhooks/shopify/{connection_id}` | HMAC-verified ingest for `orders/*`, `products/*`, `app/uninstalled` | Public (HMAC-verified) |

### 5.3 Frontend pages (Next.js)

| Page | Role | What it does |
|---|---|---|
| `/signup` | Public | Calls `POST /tenants/signup` → creates `Tenant(status="pending")`, shows "awaiting approval" message |
| `/platform/tenants/approvals` | Super-Admin | Lists pending tenants; Approve / Reject buttons |
| `/settings/website` | Tenant Admin | Existing page; the **Connect Shopify** button hits `/shopify/oauth/install` |
| `/settings/integrations?shopify=connected` | Tenant Admin | Success landing after OAuth |

### 5.4 Background workers

- **Webhook retry/poll fallback** — every 5 min, for every active Shopify connection, pull `orders.json?updated_at_min=last_seen` to fill any webhooks Shopify failed to deliver (already aligned with the WC pattern in `architecture_recommendation.md` §2).
- **`app/uninstalled` handler** — when received, set `StoreConnection.is_active = false`, null out `access_token`, stop polling.

---

## 6. Step-by-step procedure for setting up the Shopify side

**One-time setup, done by the sme-automation team in the Shopify Partner Dashboard:**

1. Sign up at <https://partners.shopify.com> with the company account.
2. **Apps → Create app → Create app manually**.
   - Distribution: **Custom distribution** (not "App Store").
   - App URL: `https://app.sme-automation.com/`
   - Allowed redirection URLs: `https://api.sme-automation.com/shopify/oauth/callback`
3. From **Configuration**, copy:
   - `Client ID` → env var `SHOPIFY_API_KEY`
   - `Client secret` → env var `SHOPIFY_API_SECRET`
4. Set **API scopes**: `read_orders, write_orders, read_products, write_products, read_customers`. Add `read_fulfillments, write_fulfillments` once we wire courier dispatch.
5. **Webhooks** are registered per-shop via Admin API at install time (not in the dashboard) so each tenant's connection_id can be embedded in the URL.
6. In **Distribution**, generate a per-merchant install link template — but we don't hand it out directly: our `/shopify/oauth/install` endpoint builds it dynamically with a signed `state`.

**Per-tenant runtime flow** (already covered in §2):

- Tenant signs up → SaaS Admin approves → Tenant Admin clicks Connect Shopify → OAuth → token + webhooks saved → live.

---

## 7. Security checklist

- ✅ Verify Shopify HMAC on **every** webhook (`X-Shopify-Hmac-Sha256` over raw body, with `SHOPIFY_API_SECRET` for OAuth-callback HMAC and per-connection `webhook_secret` for shop webhooks).
- ✅ Sign the OAuth `state` as a short-TTL JWT carrying `tenant_id` + nonce. Reject the callback if it's missing, expired, or if the tenant is not `active`.
- ✅ Store `access_token` envelope-encrypted (KMS) in production, as flagged in `auth_system_design.md §7.5`. Phase 0 keeps it in JSONB.
- ✅ Reject the install if `tenants.status != "active"` — this is what makes the SaaS-admin gate enforceable.
- ✅ On `app/uninstalled`, clear the token immediately so a stolen DB snapshot can't replay.
- ✅ Rate-limit `/shopify/oauth/install` per-tenant to prevent state-token spam.

---

## 8. TL;DR

| Concern | Decision |
|---|---|
| App type | **Custom Distribution App** from Shopify Partner Dashboard |
| Approval gate | `Tenant.status` must be `active` (set by Super-Admin) **before** install URL is issued |
| Connect flow | Tenant Admin clicks Connect → signed-state OAuth → callback saves token + registers webhooks |
| Storage | Reuse existing `store_connections` table, `kind="shopify"` |
| Ingest | `/webhooks/shopify/{connection_id}` (HMAC-verified) + 5-min poll fallback |
| Cleanup | `app/uninstalled` webhook → deactivate connection, drop token |
| Future | Promote to Public App once self-serve sign-up replaces manual approval |
