const crypto = require('crypto');
const config = require('../config');

/**
 * Verifies the HMAC on an incoming Shopify OAuth callback.
 * All query params except `hmac` and `signature` are sorted, joined, and hashed.
 */
function verifyOAuthHmac(query) {
  const { hmac, signature: _sig, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', config.shopify.apiSecret)
    .update(message)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

/**
 * Express middleware that verifies the HMAC on Shopify webhook POST bodies.
 * Must be applied BEFORE body-parser so the raw body is available.
 */
function verifyWebhookHmac(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) {
    return res.status(401).json({ error: 'Missing HMAC header' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'No raw body captured' });
  }

  const digest = crypto
    .createHmac('sha256', config.shopify.apiSecret)
    .update(rawBody)
    .digest('base64');

  const safe =
    hmacHeader.length === digest.length &&
    crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));

  if (!safe) {
    return res.status(401).json({ error: 'Invalid HMAC' });
  }

  next();
}

/**
 * Raw-body capture middleware — must come before express.json() on webhook routes.
 */
function captureRawBody(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
}

module.exports = { verifyOAuthHmac, verifyWebhookHmac, captureRawBody };
