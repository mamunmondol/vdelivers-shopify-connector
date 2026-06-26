const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const db = require('../db');
const { verifyOAuthHmac } = require('../middleware/hmac');
const { exchangeCodeForToken, getShopInfo, registerAllWebhooks } = require('../services/shopifyClient');
const { fullSync } = require('../services/sync');

const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

// GET /shopify/oauth/install?shop=mystore.myshopify.com
router.get('/oauth/install', (req, res) => {
  const { shop } = req.query;

  if (!shop || !SHOP_DOMAIN_RE.test(shop)) {
    return res.status(400).json({ error: 'Missing or invalid shop parameter. Expected format: mystore.myshopify.com' });
  }

  const state = jwt.sign(
    { shop, nonce: uuidv4() },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${config.shopify.apiKey}` +
    `&scope=${encodeURIComponent(config.shopify.scopes)}` +
    `&redirect_uri=${encodeURIComponent(`${config.shopify.hostUrl}/shopify/oauth/callback`)}` +
    `&state=${encodeURIComponent(state)}`;

  res.redirect(installUrl);
});

// GET /shopify/oauth/callback?code=…&shop=…&hmac=…&state=…&timestamp=…
router.get('/oauth/callback', async (req, res) => {
  const { shop, code, hmac, state } = req.query;

  if (!shop || !code || !hmac || !state) {
    return res.status(400).json({ error: 'Missing required OAuth callback parameters' });
  }

  // 1. Verify Shopify HMAC over the callback query string
  if (!verifyOAuthHmac(req.query)) {
    return res.status(401).json({ error: 'HMAC verification failed' });
  }

  // 2. Verify and decode the signed state JWT
  let decoded;
  try {
    decoded = jwt.verify(state, config.jwt.secret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired state token' });
  }

  if (decoded.shop !== shop) {
    return res.status(401).json({ error: 'State/shop mismatch' });
  }

  try {
    // 3. Exchange the code for a permanent access token
    const { access_token, scope } = await exchangeCodeForToken(
      shop, code, config.shopify.apiKey, config.shopify.apiSecret
    );

    // 4. Fetch shop metadata for storage
    const shopInfo = await getShopInfo(shop, access_token);

    // 5. Upsert shop — safe to re-run if merchant re-installs
    const { rows } = await db.query(
      `INSERT INTO shops (shop_domain, access_token, scope, shop_info, is_active, installed_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW())
       ON CONFLICT (shop_domain) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         scope        = EXCLUDED.scope,
         shop_info    = EXCLUDED.shop_info,
         is_active    = TRUE,
         updated_at   = NOW()
       RETURNING *`,
      [shop, access_token, scope, JSON.stringify(shopInfo)]
    );
    const savedShop = rows[0];

    // 6. Register webhooks (9 topics — see shopifyClient.js)
    const webhookResults = await registerAllWebhooks(shop, access_token, config.shopify.hostUrl);
    const failed = webhookResults.filter((w) => w.status === 'failed');
    if (failed.length) {
      console.warn(`[OAuth] ${failed.length} webhook(s) failed to register for ${shop}:`, failed);
    }

    // 7. Initial sync runs in the background — don't block the redirect
    fullSync(savedShop).catch((err) =>
      console.error(`[OAuth] Initial sync failed for ${shop}:`, err.message)
    );

    res.redirect(`${config.shopify.hostUrl}/?connected=${encodeURIComponent(shop)}`);
  } catch (err) {
    console.error(`[OAuth] Callback error for ${shop}:`, err.message);
    res.status(500).json({ error: 'OAuth exchange failed', detail: err.message });
  }
});

module.exports = router;
