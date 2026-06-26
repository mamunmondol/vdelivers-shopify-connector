const router = require('express').Router();
const config = require('../config');
const db = require('../db');
const { requireDashboardAuth } = require('../middleware/auth');
const { fullSync } = require('../services/sync');

// ── Auth ─────────────────────────────────────────────────────────────────────

// POST /api/auth/login
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === config.dashboard.username && password === config.dashboard.password) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// POST /api/auth/logout
router.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// All routes below this line require a valid session
router.use(requireDashboardAuth);

// ── Shops ─────────────────────────────────────────────────────────────────────

// GET /api/shops
router.get('/shops', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, shop_domain, scope, is_active, installed_at, last_synced_at, shop_info
       FROM shops
       ORDER BY installed_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shops/:id
router.get('/shops/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, shop_domain, scope, is_active, installed_at, last_synced_at, shop_info
       FROM shops WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/shops/:id — soft-disconnect (clears token, marks inactive)
router.delete('/shops/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE shops
       SET is_active = FALSE, access_token = '', updated_at = NOW()
       WHERE id = $1
       RETURNING id, shop_domain`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json({ ok: true, disconnected: rows[0].shop_domain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Orders ────────────────────────────────────────────────────────────────────

// GET /api/shops/:id/orders?limit=50&offset=0&status=open
router.get('/shops/:id/orders', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const params = [req.params.id, limit, offset];

  let statusClause = '';
  if (req.query.status) {
    params.push(req.query.status);
    statusClause = `AND status = $${params.length}`;
  }

  try {
    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      db.query(
        `SELECT id, shopify_id, order_number, status, financial_status, fulfillment_status,
                customer, total_price, currency, shopify_created_at, synced_at
         FROM orders
         WHERE shop_id = $1 ${statusClause}
         ORDER BY shopify_created_at DESC
         LIMIT $2 OFFSET $3`,
        params
      ),
      db.query(
        `SELECT COUNT(*) FROM orders WHERE shop_id = $1 ${statusClause}`,
        req.query.status ? [req.params.id, req.query.status] : [req.params.id]
      ),
    ]);
    res.json({ total: parseInt(countRows[0].count, 10), items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Products ──────────────────────────────────────────────────────────────────

// GET /api/shops/:id/products?limit=50&offset=0
router.get('/shops/:id/products', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);

  try {
    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      db.query(
        `SELECT id, shopify_id, title, vendor, product_type, status, tags,
                shopify_updated_at, synced_at
         FROM products
         WHERE shop_id = $1
         ORDER BY shopify_updated_at DESC
         LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) FROM products WHERE shop_id = $1`,
        [req.params.id]
      ),
    ]);
    res.json({ total: parseInt(countRows[0].count, 10), items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Customers ─────────────────────────────────────────────────────────────────

// GET /api/shops/:id/customers?limit=50&offset=0
router.get('/shops/:id/customers', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);

  try {
    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      db.query(
        `SELECT id, shopify_id, email, first_name, last_name, phone,
                orders_count, total_spent, synced_at
         FROM customers
         WHERE shop_id = $1
         ORDER BY synced_at DESC
         LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) FROM customers WHERE shop_id = $1`,
        [req.params.id]
      ),
    ]);
    res.json({ total: parseInt(countRows[0].count, 10), items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync logs ─────────────────────────────────────────────────────────────────

// GET /api/shops/:id/sync-logs?limit=100
router.get('/shops/:id/sync-logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

  try {
    const { rows } = await db.query(
      `SELECT id, event_type, resource_type, resource_id, status, message, metadata, created_at
       FROM sync_logs
       WHERE shop_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.params.id, limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Manual sync ───────────────────────────────────────────────────────────────

// POST /api/shops/:id/sync — trigger incremental sync immediately
router.post('/shops/:id/sync', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM shops WHERE id = $1 AND is_active = TRUE`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found or inactive' });

    // Respond before sync completes so the caller isn't left waiting
    res.json({ ok: true, message: 'Sync started', shop: rows[0].shop_domain });

    fullSync(rows[0]).catch((err) =>
      console.error(`[API] Manual sync failed for ${rows[0].shop_domain}:`, err.message)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
