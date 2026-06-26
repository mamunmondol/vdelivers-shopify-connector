const db = require('../db');
const shopifyClient = require('./shopifyClient');
const config = require('../config');
const axios = require('axios');

async function log(shopId, eventType, resourceType, resourceId, status, message, metadata) {
  await db.query(
    `INSERT INTO sync_logs (shop_id, event_type, resource_type, resource_id, status, message, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [shopId, eventType, resourceType, resourceId, status, message, metadata ? JSON.stringify(metadata) : null]
  );
}

/**
 * Upsert a single order into the local DB.
 */
async function upsertOrder(shopId, order) {
  const customer = order.customer
    ? { id: order.customer.id, email: order.customer.email, name: `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() }
    : null;

  const lineItems = (order.line_items || []).map((li) => ({
    id: li.id, title: li.title, quantity: li.quantity,
    price: li.price, sku: li.sku, variant_id: li.variant_id,
  }));

  await db.query(
    `INSERT INTO orders
       (shop_id, shopify_id, order_number, status, financial_status, fulfillment_status,
        customer, line_items, shipping_address, total_price, currency, tags, note,
        raw_data, shopify_created_at, shopify_updated_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
     ON CONFLICT (shop_id, shopify_id)
     DO UPDATE SET
       order_number       = EXCLUDED.order_number,
       status             = EXCLUDED.status,
       financial_status   = EXCLUDED.financial_status,
       fulfillment_status = EXCLUDED.fulfillment_status,
       customer           = EXCLUDED.customer,
       line_items         = EXCLUDED.line_items,
       shipping_address   = EXCLUDED.shipping_address,
       total_price        = EXCLUDED.total_price,
       currency           = EXCLUDED.currency,
       tags               = EXCLUDED.tags,
       note               = EXCLUDED.note,
       raw_data           = EXCLUDED.raw_data,
       shopify_updated_at = EXCLUDED.shopify_updated_at,
       synced_at          = NOW()`,
    [
      shopId, order.id, order.name, order.cancel_reason ? 'cancelled' : 'open',
      order.financial_status, order.fulfillment_status,
      customer ? JSON.stringify(customer) : null,
      JSON.stringify(lineItems),
      order.shipping_address ? JSON.stringify(order.shipping_address) : null,
      order.total_price, order.currency, order.tags, order.note,
      JSON.stringify(order), order.created_at, order.updated_at,
    ]
  );
}

/**
 * Upsert a single product into the local DB.
 */
async function upsertProduct(shopId, product) {
  const variants = (product.variants || []).map((v) => ({
    id: v.id, title: v.title, price: v.price, sku: v.sku,
    inventory_quantity: v.inventory_quantity,
  }));

  const images = (product.images || []).map((img) => ({ id: img.id, src: img.src, alt: img.alt }));

  await db.query(
    `INSERT INTO products
       (shop_id, shopify_id, title, vendor, product_type, status, tags,
        variants, images, raw_data, shopify_created_at, shopify_updated_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (shop_id, shopify_id)
     DO UPDATE SET
       title              = EXCLUDED.title,
       vendor             = EXCLUDED.vendor,
       product_type       = EXCLUDED.product_type,
       status             = EXCLUDED.status,
       tags               = EXCLUDED.tags,
       variants           = EXCLUDED.variants,
       images             = EXCLUDED.images,
       raw_data           = EXCLUDED.raw_data,
       shopify_updated_at = EXCLUDED.shopify_updated_at,
       synced_at          = NOW()`,
    [
      shopId, product.id, product.title, product.vendor, product.product_type,
      product.status, product.tags, JSON.stringify(variants), JSON.stringify(images),
      JSON.stringify(product), product.created_at, product.updated_at,
    ]
  );
}

/**
 * Upsert a single customer into the local DB.
 */
async function upsertCustomer(shopId, customer) {
  await db.query(
    `INSERT INTO customers
       (shop_id, shopify_id, email, first_name, last_name, phone,
        orders_count, total_spent, raw_data, shopify_created_at, shopify_updated_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (shop_id, shopify_id)
     DO UPDATE SET
       email              = EXCLUDED.email,
       first_name         = EXCLUDED.first_name,
       last_name          = EXCLUDED.last_name,
       phone              = EXCLUDED.phone,
       orders_count       = EXCLUDED.orders_count,
       total_spent        = EXCLUDED.total_spent,
       raw_data           = EXCLUDED.raw_data,
       shopify_updated_at = EXCLUDED.shopify_updated_at,
       synced_at          = NOW()`,
    [
      shopId, customer.id, customer.email, customer.first_name, customer.last_name,
      customer.phone, customer.orders_count, customer.total_spent,
      JSON.stringify(customer), customer.created_at, customer.updated_at,
    ]
  );
}

/**
 * Full initial sync for a newly connected shop.
 */
async function fullSync(shop) {
  const { id: shopId, shop_domain, access_token, last_synced_at } = shop;
  const since = last_synced_at || null;
  let total = 0;

  console.log(`[Sync] Starting ${since ? 'incremental' : 'full'} sync for ${shop_domain}`);

  try {
    const orders = await shopifyClient.fetchOrders(shop_domain, access_token, since);
    for (const o of orders) await upsertOrder(shopId, o);
    total += orders.length;
    if (orders.length) await log(shopId, 'sync_orders', 'order', null, 'success', `Synced ${orders.length} orders`);
  } catch (err) {
    await log(shopId, 'sync_orders', 'order', null, 'error', err.message);
    console.error(`[Sync] Orders failed for ${shop_domain}:`, err.message);
  }

  try {
    const products = await shopifyClient.fetchProducts(shop_domain, access_token, since);
    for (const p of products) await upsertProduct(shopId, p);
    total += products.length;
    if (products.length) await log(shopId, 'sync_products', 'product', null, 'success', `Synced ${products.length} products`);
  } catch (err) {
    await log(shopId, 'sync_products', 'product', null, 'error', err.message);
    console.error(`[Sync] Products failed for ${shop_domain}:`, err.message);
  }

  try {
    const customers = await shopifyClient.fetchCustomers(shop_domain, access_token, since);
    for (const c of customers) await upsertCustomer(shopId, c);
    total += customers.length;
    if (customers.length) await log(shopId, 'sync_customers', 'customer', null, 'success', `Synced ${customers.length} customers`);
  } catch (err) {
    await log(shopId, 'sync_customers', 'customer', null, 'error', err.message);
    console.error(`[Sync] Customers failed for ${shop_domain}:`, err.message);
  }

  await db.query(`UPDATE shops SET last_synced_at = NOW() WHERE id = $1`, [shopId]);
  console.log(`[Sync] Done for ${shop_domain}: ${total} records processed`);

  // Optionally push to vDelivers API
  await pushToVDelivers(shopId, shop_domain);

  return total;
}

/**
 * Process a single incoming Shopify webhook event.
 */
async function processWebhookEvent(shop, topic, payload) {
  const { id: shopId, shop_domain } = shop;
  const [resource, action] = topic.split('/');

  try {
    if (resource === 'orders') {
      if (action === 'delete') {
        await db.query(`DELETE FROM orders WHERE shop_id=$1 AND shopify_id=$2`, [shopId, payload.id]);
      } else {
        await upsertOrder(shopId, payload);
      }
      await log(shopId, `webhook_${topic}`, 'order', String(payload.id), 'success', `Webhook ${topic}`);
    }

    if (resource === 'products') {
      if (action === 'delete') {
        await db.query(`DELETE FROM products WHERE shop_id=$1 AND shopify_id=$2`, [shopId, payload.id]);
      } else {
        await upsertProduct(shopId, payload);
      }
      await log(shopId, `webhook_${topic}`, 'product', String(payload.id), 'success', `Webhook ${topic}`);
    }

    if (resource === 'customers') {
      await upsertCustomer(shopId, payload);
      await log(shopId, `webhook_${topic}`, 'customer', String(payload.id), 'success', `Webhook ${topic}`);
    }

    if (topic === 'app/uninstalled') {
      await db.query(
        `UPDATE shops SET is_active = FALSE, access_token = '', updated_at = NOW() WHERE id = $1`,
        [shopId]
      );
      await log(shopId, 'app_uninstalled', null, null, 'success', `Shop ${shop_domain} uninstalled the app`);
      console.log(`[Webhook] ${shop_domain} uninstalled the app — connection deactivated`);
    }
  } catch (err) {
    await log(shopId, `webhook_${topic}`, resource, String(payload.id || ''), 'error', err.message);
    throw err;
  }
}

/**
 * Push synced orders to the shop's configured vDelivers account.
 * Falls back to global env vars if no per-shop credentials are set.
 */
async function pushToVDelivers(shopId, shopDomain) {
  const { rows: shopRows } = await db.query(
    `SELECT vdelivers_api_url, vdelivers_api_key FROM shops WHERE id=$1`, [shopId]
  );
  const apiUrl = shopRows[0]?.vdelivers_api_url || config.vdelivers.apiUrl;
  const apiKey = shopRows[0]?.vdelivers_api_key || config.vdelivers.apiKey;
  if (!apiUrl || !apiKey) return;

  try {
    const { rows: orders } = await db.query(
      `SELECT * FROM orders WHERE shop_id=$1 AND synced_at >= NOW() - INTERVAL '10 minutes'`,
      [shopId]
    );
    if (orders.length === 0) return;

    await axios.post(`${apiUrl}/shopify/ingest`, {
      shop: shopDomain, orders,
    }, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });

    console.log(`[vDelivers] Pushed ${orders.length} orders from ${shopDomain}`);
  } catch (err) {
    console.error(`[vDelivers] Push failed for ${shopDomain}:`, err.message);
  }
}

module.exports = { fullSync, processWebhookEvent, upsertOrder, upsertProduct, upsertCustomer };
