# Shopify App Store — Submission Guide

How to graduate your Custom Distribution app to a **Public app listed on the
Shopify App Store**, so any Shopify merchant can self-install without you
manually adding their store to your distribution list.

> Time-to-live: **2–6 weeks**. Code changes alone are 1–2 weeks; Shopify's
> first review takes 5–10 business days; expect 1–3 rounds of revisions.

---

## 1. Should you do this now?

### Stay on Custom Distribution while…

- You have **< 30 paying merchants** total.
- You're still iterating on scopes, webhooks, or core flows weekly.
- You haven't drafted a privacy policy or refund policy.
- You don't have an English-language website with public docs + support contact.
- You charge merchants outside Shopify (your own billing — Stripe, manual invoices).

### Switch to Public listing once…

- You have **30+ merchants** and onboarding manually-adding-to-Distribution is a real chore.
- You're ready to support **any Shopify store** (including stores in jurisdictions you haven't dealt with — GDPR, CCPA, PIPEDA).
- You can commit to **24h response SLA** on listing reviews and merchant tickets.
- You have a **public-facing English website** with privacy/terms/refund/support links.
- You're ready to add **Shopify-billing** integration if you want app-level subscription / per-install fees (optional — you can keep your own billing).

If you're not ticking most of those, stay Custom Distribution — App Store review is a one-shot deal and you don't want to fail on something fixable.

---

## 2. Gap analysis — what we have vs what App Store wants

| Requirement | Status today | Work needed |
|---|---|---|
| OAuth install + callback | ✅ done (`src/store/shopify.py`) | none |
| Webhook ingestion (orders/products) | ✅ done | none |
| `app/uninstalled` cleanup | ✅ done (drops token, deactivates connection) | none |
| HMAC verification on every webhook | ✅ done | none |
| **GDPR compliance webhooks** (`customers/data_request`, `customers/redact`, `shop/redact`) | ❌ **missing — REQUIRED** | implement (see §3.1) |
| Privacy policy URL | ❌ missing | write + host (see §4.2) |
| Support contact (email or form) | ❌ missing | set up `support@your-domain.com` |
| App listing copy (name, tagline, description, categories) | ❌ missing | write (see §4.3) |
| Screenshots (1280×800) ×4–6 | ❌ missing | capture from `/settings/website` + `/orders` + AI agent flow |
| Demo video (60–90s) | ❌ missing | record |
| Pricing model declaration | ❌ missing | decide: free, recurring, usage, one-time |
| Embedded app (App Bridge) | ❌ standalone today | optional but recommended (see §3.3) |
| Shop-locale support | ❌ English-only | flag for v2 unless you're targeting non-English merchants |
| Performance budget (< 1.5s LCP, etc.) | ⚠ untested | run Web Vitals test, fix if needed |
| Built-for-Shopify badge (highest tier) | ❌ optional | defer; nice-to-have for marketing later |

The two **REQUIRED but missing** items are:
1. GDPR compliance webhooks (technical)
2. Privacy policy + support contact (operational)

Everything else is "nice to have" or "make this look polished."

---

## 3. Technical work needed

### 3.1 GDPR mandatory webhooks (required to pass review)

Shopify requires every app to handle three compliance webhooks. These are fired
by Shopify when a merchant or customer exercises their data-protection rights.
Your app **must respond within 30 days**, not in real time — so you can queue
them and process async.

| Topic | When fired | What you must do |
|---|---|---|
| `customers/data_request` | Merchant requests data export for a customer | Within 30 days, send the requesting merchant all PII you hold for that customer (orders, phone, address, AI call transcripts, etc.) |
| `customers/redact` | Merchant requests deletion of a customer's data | Within 30 days, delete or anonymise that customer's PII from your DB |
| `shop/redact` | 48 hours after the merchant uninstalls your app | Within 30 days, delete or anonymise all data for that shop |

#### Implementation sketch

Add to `apps/api/src/store/shopify.py`:

```python
WEBHOOK_TOPICS = (
    "orders/create", "orders/updated", "orders/paid", "orders/cancelled",
    "products/create", "products/update", "products/delete",
    "app/uninstalled",
    # GDPR mandatory — added for App Store submission
    "customers/data_request",
    "customers/redact",
    "shop/redact",
)

# In shopify_webhook() dispatch:
elif topic == "customers/data_request":
    await _handle_customer_data_request(session, row, payload)
elif topic == "customers/redact":
    await _handle_customer_redact(session, row, payload)
elif topic == "shop/redact":
    await _handle_shop_redact(session, row, payload)
```

You'll also need to register the same three URLs as **Mandatory webhooks**
in Partner Dashboard → app → Configuration → Mandatory webhooks (separate
from the per-shop webhooks we register at install time — Shopify uses these
URLs on a *shop-agnostic* basis):

```
customers/data_request → https://api.your-domain.com/webhooks/shopify/compliance/customers-data-request
customers/redact       → https://api.your-domain.com/webhooks/shopify/compliance/customers-redact
shop/redact            → https://api.your-domain.com/webhooks/shopify/compliance/shop-redact
```

These URLs need a **separate handler** because:
- They're called by Shopify with shop-domain in the body (not derivable from `connection_id`).
- They're HMAC-signed with the app's `SHOPIFY_API_SECRET`.
- They must respond 200 even if you don't recognise the shop (Shopify retries 5xx).

Suggested handler shape:

```python
async def _verify_compliance_webhook(request: Request) -> dict[str, Any]:
    raw = await request.body()
    sig = request.headers.get("X-Shopify-Hmac-Sha256", "")
    if not _verify_webhook_hmac(raw, sig):  # same helper as shop webhooks
        raise HTTPException(401, "invalid_hmac")
    return json.loads(raw)


@compliance_router.post("/customers-data-request")
async def customers_data_request(request: Request, session: SessionDep):
    payload = await _verify_compliance_webhook(request)
    # Enqueue an "export job" — actual export sent to the merchant by email
    # within 30 days. Don't block the webhook on the export.
    session.add(GdprDataRequest(
        shop_domain=payload["shop_domain"],
        customer_id=str(payload["customer"]["id"]),
        requested_at=datetime.now(timezone.utc),
    ))
    await session.commit()
    return Response(status_code=200)
```

You need a small new table `gdpr_data_requests` (and similarly
`gdpr_redact_jobs`) to track these. A separate background worker drains them
within the 30-day SLA.

**Estimated effort: 1–2 days** for the three handlers + tables + a basic
admin script to actually fulfil the requests.

### 3.2 Privacy policy webhook (also required)

Shopify also wants a `webhooks/customers/data_request` URL even if your app
doesn't store customer PII (to confirm you got the request). Even our basic
order intake stores customer phone + address, so this applies.

### 3.3 Embedded app via App Bridge (optional but strongly recommended)

A **standalone** app (what we have now) opens in its own browser tab. An
**embedded** app loads inside the Shopify Admin via App Bridge — the merchant
clicks "VDelivers" in their Shopify left nav and our SaaS renders inside an
iframe in their Shopify Admin.

| Standalone | Embedded |
|---|---|
| Merchant has to remember to log into your SaaS separately | Single sign-on via Shopify session |
| OK for back-office ops apps | Required for "Built for Shopify" badge |
| What we have now | What App Store reviewers prefer |

Going embedded means:
1. Add `@shopify/app-bridge-react` to the web app.
2. Detect Shopify's `?embedded=1&host=...&shop=...` query params on `/settings/website` and switch to embedded mode (use Shopify session token instead of our JWT for some endpoints).
3. Set `embedded: true` in Partner Dashboard → app → Configuration.

**Estimated effort: 1 week** to retrofit App Bridge cleanly. Defer to v2.

### 3.4 Billing (only if charging through Shopify)

If you want merchants to be billed for the app via their existing Shopify
invoice (instead of you collecting payment separately), implement the
[Shopify Billing API](https://shopify.dev/docs/api/usage/billing-api).

| You bill via | Pros | Cons |
|---|---|---|
| Shopify Billing API | Merchants pay through their existing Shopify subscription. Higher conversion. | Shopify takes 15–20% commission. Locked into Shopify's billing primitives (recurring, usage, one-time). |
| Your own billing (Stripe, etc.) | No commission. Full pricing flexibility. | Merchants enter card details twice. Slightly lower conversion. |

For B2B SaaS with high ticket sizes, your own billing is usually the right call.
For freemium / low-ticket apps, Shopify Billing wins.

**Estimated effort: 3–4 days** for Shopify Billing integration if you go that route.

### 3.5 Performance budget

App Store reviewers care about page-load speed in the embedded iframe.
Targets:
- LCP (Largest Contentful Paint) < 1.5s
- CLS (Cumulative Layout Shift) < 0.1
- INP (Interaction to Next Paint) < 200ms

Run Lighthouse on `/settings/website` with throttled connection. Fix if you fail.

**Estimated effort: 0–3 days** depending on what Lighthouse finds.

---

## 4. Listing assets needed

### 4.1 Decide pricing

Pick one (you can change later):
- **Free**
- **Free trial → recurring** (e.g. 14 days free, then $29/month)
- **Usage-based** (e.g. $0.05 per AI call confirmed)
- **One-time**

Document the price clearly on your listing. Merchants will see this as the first thing.

### 4.2 Privacy policy + Terms + Refund policy

Three URLs, all hosted publicly on your domain:
- `https://your-domain.com/privacy`
- `https://your-domain.com/terms`
- `https://your-domain.com/refund-policy`

If you don't have a website yet, even a simple Notion page works for review.
Templates: <https://www.shopify.com/legal/policies>.

### 4.3 App listing copy

What Shopify wants:

| Field | Limit | Tip |
|---|---|---|
| App name | 30 chars | "VDelivers" works |
| Tagline | 70 chars | "AI-powered order confirmation for COD merchants in BD" |
| Short description | 100 chars | One-liner: what it does + who it's for |
| Long description | 1000 chars | What problem it solves, key features (3–5 bullets), how it works |
| Categories | pick 1–3 | Customer support / Orders / Reporting |
| Languages supported | list | English (+ Bangla if/when localized) |
| Countries supported | list | Bangladesh + others as you expand |

Worth A/B-testing copy after launch via Shopify Analytics.

### 4.4 Screenshots (1280×800 PNG, 4–6 of them)

Capture from your live SaaS:
1. `/settings/website` — the Connect Shopify banner (shows the install UX)
2. `/orders` with a filtered view — the merchant's order queue post-AI-call
3. The AI agent settings page
4. An order detail view showing the call transcript / status
5. The dashboard with KPIs (confirmation rate, courier status)

Keep them sharp, no PII, ideally with a fake but realistic Bangla store as the example.

### 4.5 Demo video (60–90s)

Show the install + first-confirmed-order flow. Voiceover in English. Host on
YouTube unlisted or Shopify's hosted video.

### 4.6 Banner image (1920×1080)

Lead-in image at the top of your listing. Brand-appropriate hero.

---

## 5. Submission checklist (ordered)

- [ ] **Code**: GDPR webhooks implemented + tested (§3.1)
- [ ] **Code**: privacy policy + terms + refund pages live on your domain (§4.2)
- [ ] **Code (optional)**: App Bridge for embedded mode (§3.3)
- [ ] **Code (optional)**: Shopify Billing API integration (§3.4)
- [ ] **Performance**: Lighthouse passes on `/settings/website` (§3.5)
- [ ] **Listing**: name + tagline + descriptions written (§4.3)
- [ ] **Listing**: 4–6 screenshots captured (§4.4)
- [ ] **Listing**: demo video recorded (§4.5)
- [ ] **Listing**: banner image (§4.6)
- [ ] **Listing**: pricing model selected (§4.1)
- [ ] **Partner Dashboard**: app moved from Custom → Public Distribution
- [ ] **Partner Dashboard**: Mandatory webhooks (3 URLs) configured
- [ ] **Partner Dashboard**: app submitted for review

After submission, Shopify reviewer feedback typically lands in 5–10 business days. Most apps need 1–3 rounds of fixes before approval. Common bounces:

- Missing GDPR webhooks
- Privacy policy doesn't mention Shopify customer data handling
- App doesn't gracefully handle scope re-grant
- Missing OAuth state validation
- Listing screenshots have non-English text or PII

---

## 6. The submission process step-by-step

### Step 1 — Switch the app to Public Distribution

In Partner Dashboard → app → **Distribution** → click **Choose distribution**
→ pick **Public Distribution** → Confirm.

This **disables your existing Custom Distribution installs** for new merchants
(existing installs keep working). You can technically have both Custom and
Public on the same app via "Custom Distribution + Public Listing" combo, but
it's cleaner to pick one.

### Step 2 — Fill out the listing

Partner Dashboard → app → **App listing** → fill every required field. The
"Create listing" workflow walks you through it. You can save drafts.

Sections:
- App store basics (name, icon, descriptions)
- Categories & tags
- Pricing
- App media (screenshots, video, banner)
- Demo store URL (your dev store works — `vdelivers-drvk9n7t.myshopify.com`)
- Languages & countries
- Privacy/terms/refund URLs
- Support email + URL
- Required scopes (must match what the OAuth flow asks for)

### Step 3 — Configure mandatory webhooks

Partner Dashboard → app → **Configuration** → **Mandatory webhooks**:

| Topic | URL |
|---|---|
| `customers/data_request` | `https://api.your-domain.com/webhooks/shopify/compliance/customers-data-request` |
| `customers/redact` | `https://api.your-domain.com/webhooks/shopify/compliance/customers-redact` |
| `shop/redact` | `https://api.your-domain.com/webhooks/shopify/compliance/shop-redact` |

These take immediate effect once saved — Shopify will start firing test webhooks
to verify they return 200.

### Step 4 — Submit

Partner Dashboard → app → click **Submit for review**.

Shopify emails you within 5–10 business days with the verdict. If approved,
your listing goes live within 24h. If revisions requested, address them and
re-submit (no separate fee per revision; reviews are free).

### Step 5 — Post-launch

After your listing goes live:
- Set up **Shopify App Insights** to track install funnel (impressions → clicks → installs → first-order).
- Watch for merchant reviews and respond within 7 days (matters for ranking).
- Apply for **Built for Shopify** badge (separate review, ~3 weeks; gives a green checkmark on your listing).

---

## 7. Estimated total effort

| Track | Hours | Calendar weeks |
|---|---|---|
| GDPR webhooks + tables | 12–16h | 1 week |
| Privacy/terms/refund pages | 4h | 1 day (text only) |
| Listing copy + screenshots + video | 8–12h | 1 week |
| Performance fixes (if needed) | 0–24h | 0–1 week |
| App Bridge (embedded mode, optional) | 30–40h | 1 week |
| Shopify Billing (optional) | 16–24h | 3–4 days |
| Submission + review feedback rounds | 4–8h spread over | 2–3 weeks |
| **Total (no embedded, no Shopify billing)** | **~30–60h** | **3–5 weeks** |
| **Total (with embedded + billing)** | **~80–120h** | **5–8 weeks** |

For your stage (just launched dev with 1 dev store), I'd:
1. Stay on Custom Distribution and onboard your first 5–10 paying clients manually.
2. Use that time to write privacy/terms, run Lighthouse, decide on pricing.
3. Implement GDPR webhooks **now** so you're not blocked when ready (12–16h, no merchant impact since they're inert until Shopify fires them).
4. Submit when you have 10+ active merchants + a polished UX you're confident in.

---

## 8. Cross-references

- App architecture: `docs/shopify_app.md`
- Partner Dashboard one-time setup: `docs/shopify_partner_setup.md`
- Implementation guide: `docs/shopify_implementation.md`
- Per-client onboarding (current Custom Distribution flow): `docs/client_onboarding.md`
- Status mapping: `docs/shopify_status_mapping.md`

---

## 9. Want me to implement the GDPR webhooks now?

The 3 mandatory compliance webhooks are the only **technical blocker** for App
Store submission. Adding them now is non-disruptive (they sit dormant until
Shopify starts firing them) and gets it out of the way.

Tell me to go and I'll add:
- New table `gdpr_compliance_jobs` (one row per data_request / redact / shop_redact)
- New router `apps/api/src/store/shopify_compliance.py` with the 3 endpoints
- HMAC verification (shared with the existing webhook handler)
- A simple background worker to drain the queue (export PII / anonymise on schedule)
- Updated `WEBHOOK_TOPICS` so per-shop webhooks include them
- A doc update in `docs/shopify_implementation.md`

Estimate: 2–3 hours of code + a smoke test against the dev-mock.
