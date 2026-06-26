require('dotenv').config();

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};

module.exports = {
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'development',

  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY || '',
    apiSecret: process.env.SHOPIFY_API_SECRET || '',
    scopes: process.env.SHOPIFY_SCOPES ||
      'read_orders,write_orders,read_products,write_products,read_customers,write_customers,read_inventory,write_inventory',
    hostUrl: (process.env.HOST_URL || 'http://localhost:3000').replace(/\/$/, ''),
  },

  db: {
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/vdelivers_shopify',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-prod',
    expiresIn: '10m',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'dev-session-secret',
  },

  dashboard: {
    username: process.env.DASHBOARD_USERNAME || 'admin',
    password: process.env.DASHBOARD_PASSWORD || 'changeme',
  },

  vdelivers: {
    apiUrl: process.env.VDELIVERS_API_URL || '',
    apiKey: process.env.VDELIVERS_API_KEY || '',
  },

  sync: {
    pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '5'),
  },
};
