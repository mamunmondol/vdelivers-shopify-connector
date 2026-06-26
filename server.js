require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./src/config');
const { runMigrations } = require('./src/db/migrations');
const scheduler = require('./src/services/scheduler');

const oauthRouter = require('./src/routes/oauth');
const webhookRouter = require('./src/routes/webhooks');
const apiRouter = require('./src/routes/api');

const app = express();

// Trust Railway's reverse proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

// Serve the admin dashboard SPA
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.nodeEnv === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// Webhook routes must be mounted BEFORE express.json() so captureRawBody
// can read the raw stream for HMAC verification.
app.use('/webhooks', webhookRouter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/shopify', oauthRouter);
app.use('/api', apiRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// SPA fallback — serve index.html for any non-API GET (enables page refresh)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/shopify/') || req.path.startsWith('/webhooks/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await runMigrations();
  scheduler.start();
  app.listen(config.port, () => {
    console.log(`[Server] Listening on port ${config.port} (${config.nodeEnv})`);
    console.log(`[Server] OAuth install:  ${config.shopify.hostUrl}/shopify/oauth/install?shop=<shop>`);
    console.log(`[Server] Webhook ingest: ${config.shopify.hostUrl}/webhooks/shopify`);
  });
}

start().catch((err) => {
  console.error('[Server] Fatal startup error:', err.message);
  process.exit(1);
});
