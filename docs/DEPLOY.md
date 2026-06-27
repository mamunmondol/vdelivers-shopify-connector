# Deployment Guide — vDelivers Shopify Connector

This guide covers everything needed to go from code to a live, webhook-receiving connector.

**Prerequisites:** A Shopify store, a Shopify Partner account, and a hosting provider.

---

## Overview

The connector is a Node.js/Express server that must be reachable over the public internet (HTTPS) so Shopify can deliver webhooks. The full setup has three phases:

1. Deploy the server and provision a PostgreSQL database
2. Register a Shopify app in the Partner Dashboard
3. Run the OAuth install to connect your store

---

## Phase 1 — Deploy the server

Choose one of the options below. All of them end with:
- A live HTTPS URL (your `HOST_URL`)
- A running PostgreSQL database (your `DATABASE_URL`)

---

### Option A — Railway (recommended)

Railway provisions both the server and database automatically and gives you HTTPS with zero config.

**Step 1 — Push your code to GitHub**

```bash
git init
git add .
git commit -m "initial commit"
gh repo create vdelivers-shopify-connector --private --push --source .
# or push to an existing repo
```

**Step 2 — Create a Railway project**

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Select your repository
4. Railway detects Node.js and runs `npm start` automatically

**Step 3 — Add a PostgreSQL database**

1. In your Railway project, click **New → Database → Add PostgreSQL**
2. Railway automatically adds `DATABASE_URL` to your service's environment

**Step 4 — Set environment variables**

In Railway: select your service → **Variables** → add each one:

```
SHOPIFY_API_KEY=         (fill after Part 2)
SHOPIFY_API_SECRET=      (fill after Part 2)
SHOPIFY_SCOPES=read_orders,write_orders,read_products,write_products,read_customers,write_customers,read_inventory,write_inventory
HOST_URL=                (fill after Railway assigns your domain)
JWT_SECRET=              (generate: openssl rand -hex 32)
SESSION_SECRET=          (generate: openssl rand -hex 32)
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=      (choose a strong password)
NODE_ENV=production
PORT=3000
POLL_INTERVAL_MINUTES=5
```

**Step 5 — Get your public URL**

In Railway: **Settings → Domains → Generate Domain**. Copy the URL (e.g. `https://vdelivers-shopify-connector.up.railway.app`) and set it as `HOST_URL`.

**Step 6 — Redeploy**

After setting all variables, trigger a redeploy: **Deployments → Redeploy**. Watch the logs — you should see:

```
[DB] Running migrations...
[DB] Migrations complete.
[Scheduler] Polling every 5 min (cron: */5 * * * *)
[Server] Listening on port 3000 (production)
```

---

### Option B — Render

Similar to Railway. Note: the free tier puts services to sleep after 15 minutes of inactivity, which causes Shopify webhooks to be lost. Use the **Starter plan ($7/mo)** or higher for production.

**Step 1 — Create a Web Service**

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Set:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`

**Step 2 — Create a PostgreSQL database**

1. **New → PostgreSQL** → create a database
2. Copy the **Internal Database URL** into `DATABASE_URL` in your web service's environment variables

**Step 3 — Set environment variables**

In your web service: **Environment → Add Environment Variables** — same list as Railway above.

**Step 4 — Get your URL**

Render assigns a URL like `https://vdelivers-shopify-connector.onrender.com`. Set this as `HOST_URL` and redeploy.

---

### Option C — VPS (DigitalOcean / Vultr / Hetzner)

Best for production workloads where you want full control. Uses PM2 (process manager) and Nginx (reverse proxy with SSL).

**Recommended specs:** 1 vCPU, 1 GB RAM (DigitalOcean Basic Droplet, ~$6/mo)

**Step 1 — Provision the server**

Create an Ubuntu 22.04 droplet. SSH in as root, then:

```bash
# Create a non-root user
adduser deploy
usermod -aG sudo deploy
su - deploy
```

**Step 2 — Install Node.js and PostgreSQL**

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib

# Create database and user
sudo -u postgres psql -c "CREATE USER vdelivers WITH PASSWORD 'your_db_password';"
sudo -u postgres psql -c "CREATE DATABASE vdelivers_shopify OWNER vdelivers;"
```

**Step 3 — Deploy the app**

```bash
git clone https://github.com/your-username/vdelivers-shopify-connector.git
cd vdelivers-shopify-connector
npm install --production
cp .env.example .env
nano .env   # fill in all values
```

**Step 4 — Run with PM2**

```bash
sudo npm install -g pm2
pm2 start server.js --name shopify-connector
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

**Step 5 — Nginx reverse proxy**

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/shopify-connector
```

Paste this config (replace `connector.yourdomain.com`):

```nginx
server {
    listen 80;
    server_name connector.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Increase for webhook payloads
        client_max_body_size 10M;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/shopify-connector /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

**Step 6 — SSL with Certbot**

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d connector.yourdomain.com
# Follow prompts — Certbot auto-renews via systemd timer
```

Your `HOST_URL` is `https://connector.yourdomain.com`.

---

## Phase 2 — Create the Shopify Partner app

This is a one-time setup done in the Shopify Partner Dashboard.

**Step 1 — Create the app**

1. Sign in at [partners.shopify.com](https://partners.shopify.com)
2. **Apps → Create app → Create app manually**
3. Fill in:
   - **App name:** vDelivers Connector (or any name)
   - **App URL:** `https://your-host-url.com`
4. Under **Distribution**, select **Custom distribution** (not App Store)

**Step 2 — Configure the OAuth callback**

1. In your app, go to **Configuration**
2. Under **URLs**, add to **Allowed redirection URLs:**
   ```
   https://your-host-url.com/shopify/oauth/callback
   ```
3. Save

**Step 3 — Copy your credentials**

Still in **Configuration**:

| Dashboard field | Environment variable |
|---|---|
| **Client ID** | `SHOPIFY_API_KEY` |
| **Client secret** | `SHOPIFY_API_SECRET` |

Update these in your hosting provider's environment variables and redeploy.

**Step 4 — Set API scopes** (optional — already set via `SHOPIFY_SCOPES`)

The app requests scopes dynamically from the env var. If you want to pre-declare them in the dashboard:

```
read_orders, write_orders, read_products, write_products,
read_customers, write_customers, read_inventory, write_inventory
```

---

## Phase 3 — Install on your store

**Step 1 — Run the install URL**

Open this URL in your browser, replacing the values:

```
https://your-host-url.com/shopify/oauth/install?shop=your-store.myshopify.com
```

**Step 2 — Approve permissions**

Shopify will show a permissions screen listing all requested scopes. Click **Install**.

**Step 3 — Confirm**

You'll be redirected to the admin dashboard at `https://your-host-url.com` with a green "connected" banner. The connector will:

1. Save your store's access token
2. Register 9 webhook topics on your store
3. Start an initial full sync of orders, products, and customers

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` | Yes | Client ID from Partner Dashboard |
| `SHOPIFY_API_SECRET` | Yes | Client secret — used for HMAC verification |
| `SHOPIFY_SCOPES` | Yes | Comma-separated API scopes |
| `HOST_URL` | Yes | Public HTTPS URL of this server (no trailing slash) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Random 32+ char string for signing OAuth state tokens |
| `SESSION_SECRET` | Yes | Random 32+ char string for Express session |
| `DASHBOARD_USERNAME` | Yes | Admin dashboard login username |
| `DASHBOARD_PASSWORD` | Yes | Admin dashboard login password |
| `NODE_ENV` | Yes | Set to `production` |
| `PORT` | No | HTTP port (default: 3000) |
| `POLL_INTERVAL_MINUTES` | No | Fallback polling cadence (default: 5) |
| `VDELIVERS_API_URL` | No | vDelivers backend URL — leave blank if not using |
| `VDELIVERS_API_KEY` | No | vDelivers API key — leave blank if not using |

**Generate secure secrets:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Run twice — once for JWT_SECRET, once for SESSION_SECRET
```

---

## Post-deployment checklist

- [ ] `https://your-host-url.com/health` returns `{"status":"ok"}`
- [ ] Dashboard login works at `https://your-host-url.com`
- [ ] OAuth install URL redirects to Shopify permissions screen
- [ ] After install, shop appears in the sidebar
- [ ] Orders tab loads real data from your store
- [ ] Server logs show `[Scheduler] Polling every 5 min`
- [ ] Shopify Admin → **Settings → Notifications → Webhooks** shows 9 registered webhooks

---

## Troubleshooting

**`HMAC verification failed` on OAuth callback**

Your `SHOPIFY_API_SECRET` doesn't match the app's Client secret. Double-check the value in your env vars — no extra spaces or quotes.

**Webhooks not arriving**

- Confirm `HOST_URL` has no trailing slash
- Check that the callback URL in the Partner Dashboard exactly matches `HOST_URL/shopify/oauth/callback`
- On Render free tier: the server may be sleeping — upgrade to a paid plan

**`Missing required environment variable` on startup**

The server exits immediately if a required env var is missing. Check your hosting provider's env var panel — all variables in the reference table marked "Yes" must be set.

**OAuth redirects to wrong URL after install**

`HOST_URL` is set incorrectly. It must be the exact public HTTPS base URL with no trailing slash (e.g. `https://vdelivers.up.railway.app`).

**Database migration error on boot**

The `DATABASE_URL` is wrong or the database server is unreachable. Verify the connection string and that the database exists. The server will not start until migrations succeed.

**Re-installing after disconnect**

Just visit the install URL again. The OAuth callback does an `ON CONFLICT ... DO UPDATE` upsert, so re-installing is safe and updates the stored token.

---

## Re-deploying / updating

```bash
# Pull latest code
git pull origin main

# Railway / Render: push to GitHub → auto-deploys on connected repos

# VPS with PM2:
npm install --production
pm2 restart shopify-connector
pm2 logs shopify-connector --lines 50
```

Migrations run automatically on every boot — they are idempotent (`CREATE TABLE IF NOT EXISTS`), so re-deploying never drops data.
