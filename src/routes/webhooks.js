const router = require('express').Router();
const db = require('../db');
const { captureRawBody, verifyWebhookHmac } = require('../middleware/hmac');
const { processWebhookEvent } = require('../services/sync');

// POST /webhooks/shopify
// captureRawBody must run first (reads stream), then HMAC verification, then processing.
// We respond 200 before async processing so Shopify doesn't retry on our latency.
router.post('/shopify', captureRawBody, verifyWebhookHmac, (req, res) => {
  res.status(200).json({ received: true });

  const shopDomain = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');

  if (!shopDomain || !topic) {
    console.warn('[Webhook] Missing X-Shopify-Shop-Domain or X-Shopify-Topic header');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(req.rawBody);
  } catch (err) {
    console.error('[Webhook] Failed to parse body:', err.message);
    return;
  }

  db.query('SELECT * FROM shops WHERE shop_domain = $1 AND is_active = TRUE', [shopDomain])
    .then(({ rows }) => {
      if (!rows.length) {
        console.warn(`[Webhook] Unknown or inactive shop: ${shopDomain}`);
        return;
      }
      return processWebhookEvent(rows[0], topic, payload);
    })
    .then(() => console.log(`[Webhook] Processed ${topic} for ${shopDomain}`))
    .catch((err) => console.error(`[Webhook] Error processing ${topic} for ${shopDomain}:`, err.message));
});

module.exports = router;
