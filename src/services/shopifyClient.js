const axios = require('axios');

/**
 * Returns an axios instance pre-configured for a shop's Admin REST API.
 */
function shopifyApi(shopDomain, accessToken) {
  return axios.create({
    baseURL: `https://${shopDomain}/admin/api/2024-07`,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

/**
 * Exchange OAuth code for a permanent access token.
 */
async function exchangeCodeForToken(shopDomain, code, apiKey, apiSecret) {
  const res = await axios.post(`https://${shopDomain}/admin/oauth/access_token`, {
    client_id: apiKey,
    client_secret: apiSecret,
    code,
  });
  return res.data; // { access_token, scope }
}

/**
 * Fetch the shop's own metadata.
 */
async function getShopInfo(shopDomain, accessToken) {
  const api = shopifyApi(shopDomain, accessToken);
  const { data } = await api.get('/shop.json');
  return data.shop;
}

/**
 * Register a webhook topic on the shop.
 */
async function registerWebhook(shopDomain, accessToken, topic, callbackUrl) {
  const api = shopifyApi(shopDomain, accessToken);
  const { data } = await api.post('/webhooks.json', {
    webhook: { topic, address: callbackUrl, format: 'json' },
  });
  return data.webhook;
}

/**
 * Register all required webhooks for a shop.
 */
async function registerAllWebhooks(shopDomain, accessToken, baseUrl) {
  const topics = [
    'orders/create',
    'orders/updated',
    'orders/cancelled',
    'products/create',
    'products/update',
    'products/delete',
    'customers/create',
    'customers/update',
    'app/uninstalled',
  ];

  const callbackUrl = `${baseUrl}/webhooks/shopify`;
  const results = [];

  for (const topic of topics) {
    try {
      const wh = await registerWebhook(shopDomain, accessToken, topic, callbackUrl);
      results.push({ topic, id: wh.id, status: 'registered' });
    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      results.push({ topic, status: 'failed', error: msg });
      console.error(`[Shopify] Failed to register webhook ${topic}:`, msg);
    }
  }

  return results;
}

/**
 * Paginated fetch helper — iterates link-based pagination.
 */
async function fetchAllPages(api, endpoint, resourceKey, params = {}) {
  const items = [];
  let url = endpoint;
  let queryParams = { limit: 250, ...params };

  while (url) {
    const { data, headers } = await api.get(url, { params: url === endpoint ? queryParams : undefined });
    items.push(...(data[resourceKey] || []));

    const linkHeader = headers['link'] || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      const nextUrl = new URL(nextMatch[1]);
      url = nextUrl.pathname.replace('/admin/api/2024-07', '');
      queryParams = Object.fromEntries(nextUrl.searchParams);
    } else {
      url = null;
    }
  }

  return items;
}

/**
 * Fetch orders updated since a given timestamp.
 */
async function fetchOrders(shopDomain, accessToken, updatedAtMin = null) {
  const api = shopifyApi(shopDomain, accessToken);
  const params = { status: 'any' };
  if (updatedAtMin) params.updated_at_min = updatedAtMin;
  return fetchAllPages(api, '/orders.json', 'orders', params);
}

/**
 * Fetch products updated since a given timestamp.
 */
async function fetchProducts(shopDomain, accessToken, updatedAtMin = null) {
  const api = shopifyApi(shopDomain, accessToken);
  const params = {};
  if (updatedAtMin) params.updated_at_min = updatedAtMin;
  return fetchAllPages(api, '/products.json', 'products', params);
}

/**
 * Fetch customers updated since a given timestamp.
 */
async function fetchCustomers(shopDomain, accessToken, updatedAtMin = null) {
  const api = shopifyApi(shopDomain, accessToken);
  const params = {};
  if (updatedAtMin) params.updated_at_min = updatedAtMin;
  return fetchAllPages(api, '/customers.json', 'customers', params);
}

module.exports = {
  shopifyApi,
  exchangeCodeForToken,
  getShopInfo,
  registerAllWebhooks,
  fetchOrders,
  fetchProducts,
  fetchCustomers,
};
