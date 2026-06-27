# Shopify Connector — Task List

---

## Connector App (Railway)

- [x] Shopify OAuth install + callback flow
- [x] Embedded app auto-auth (`/shopify/auth`) — no login screen after install
- [x] Per-shop vDelivers credentials (stored in DB per merchant)
- [x] vDelivers credentials auto-applied via install URL params
- [x] Webhooks registered on install (orders, products, customers, uninstall)
- [x] Full order/product/customer sync on install
- [x] Incremental sync (uses `last_synced_at`)
- [x] 5-minute polling fallback scheduler
- [x] Shopify pagination support (handles large stores)
- [x] Dashboard UI — shop list, orders, products, customers, logs
- [x] Manual sync trigger from dashboard
- [x] Sync logs view
- [x] vDelivers credentials update from dashboard
- [x] Shop disconnect
- [x] Deployed to Railway (`noble-intuition-production.up.railway.app`)
- [x] Docs organized into `docs/` folder

---

## vDelivers Backend Team

- [ ] Fix "Install" button URL on `/settings/website` — redirect to connector install URL instead of generating Shopify OAuth URL directly (see `docs/INTEGRATION_GUIDE.md` Section 4)
- [ ] Implement `POST /shopify/ingest` endpoint to receive orders from connector
- [ ] Generate per-merchant API keys and expose them in merchant settings
- [ ] Handle `?connected=SHOP` return param on `/settings/website` to show connection as active

---

## Optional Improvements (future)

- [ ] Retry queue for failed `/shopify/ingest` calls (currently logs and continues)
- [ ] Persistent session store (`connect-pg-simple`) — only needed if scaling to multiple replicas
- [ ] GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) — only needed for Shopify App Store listing
- [ ] Regenerate Shopify API secret in Partner Dashboard (old secret was exposed in chat)

---

## Notes

- Custom distribution app — not listed on Shopify App Store
- Connector is live at: `https://noble-intuition-production.up.railway.app`
- vDelivers backend is at: `http://35.255.120.233:3001`
- GitHub repo: `https://github.com/mamunmondol/vdelivers-shopify-connector`
