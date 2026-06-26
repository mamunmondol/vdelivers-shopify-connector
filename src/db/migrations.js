const db = require('./index');

const SQL = `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  CREATE TABLE IF NOT EXISTS shops (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_domain    VARCHAR(255) UNIQUE NOT NULL,
    access_token   TEXT NOT NULL,
    scope          TEXT,
    shop_info      JSONB,
    is_active      BOOLEAN DEFAULT TRUE,
    installed_at   TIMESTAMPTZ DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id             UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    shopify_id          BIGINT NOT NULL,
    order_number        VARCHAR(50),
    status              VARCHAR(50),
    financial_status    VARCHAR(50),
    fulfillment_status  VARCHAR(50),
    customer            JSONB,
    line_items          JSONB,
    shipping_address    JSONB,
    total_price         NUMERIC(12,2),
    currency            VARCHAR(10),
    tags                TEXT,
    note                TEXT,
    raw_data            JSONB,
    shopify_created_at  TIMESTAMPTZ,
    shopify_updated_at  TIMESTAMPTZ,
    synced_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(shop_id, shopify_id)
  );

  CREATE INDEX IF NOT EXISTS orders_shop_id_idx ON orders(shop_id);
  CREATE INDEX IF NOT EXISTS orders_status_idx  ON orders(status);

  CREATE TABLE IF NOT EXISTS products (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id            UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    shopify_id         BIGINT NOT NULL,
    title              VARCHAR(500),
    vendor             VARCHAR(255),
    product_type       VARCHAR(255),
    status             VARCHAR(50),
    tags               TEXT,
    variants           JSONB,
    images             JSONB,
    raw_data           JSONB,
    shopify_created_at TIMESTAMPTZ,
    shopify_updated_at TIMESTAMPTZ,
    synced_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(shop_id, shopify_id)
  );

  CREATE INDEX IF NOT EXISTS products_shop_id_idx ON products(shop_id);

  CREATE TABLE IF NOT EXISTS customers (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id            UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    shopify_id         BIGINT NOT NULL,
    email              VARCHAR(255),
    first_name         VARCHAR(255),
    last_name          VARCHAR(255),
    phone              VARCHAR(50),
    orders_count       INTEGER DEFAULT 0,
    total_spent        NUMERIC(12,2),
    raw_data           JSONB,
    shopify_created_at TIMESTAMPTZ,
    shopify_updated_at TIMESTAMPTZ,
    synced_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(shop_id, shopify_id)
  );

  CREATE INDEX IF NOT EXISTS customers_shop_id_idx ON customers(shop_id);

  CREATE TABLE IF NOT EXISTS sync_logs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id       UUID REFERENCES shops(id) ON DELETE CASCADE,
    event_type    VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id   VARCHAR(100),
    status        VARCHAR(20) DEFAULT 'success',
    message       TEXT,
    metadata      JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS sync_logs_shop_id_idx  ON sync_logs(shop_id);
  CREATE INDEX IF NOT EXISTS sync_logs_created_idx  ON sync_logs(created_at DESC);

  ALTER TABLE shops ADD COLUMN IF NOT EXISTS vdelivers_api_url TEXT;
  ALTER TABLE shops ADD COLUMN IF NOT EXISTS vdelivers_api_key  TEXT;
`;

async function runMigrations() {
  console.log('[DB] Running migrations...');
  try {
    await db.query(SQL);
    console.log('[DB] Migrations complete.');
  } catch (err) {
    console.error('[DB] Migration failed:', err.message);
    throw err;
  }
}

module.exports = { runMigrations };
