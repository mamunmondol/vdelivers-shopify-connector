'use strict';

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
  loggedIn: false,
  shops: [],
  shop: null,           // currently selected shop
  tab: 'orders',
  data: { orders: [], products: [], customers: [], logs: [] },
  totals: { orders: 0, products: 0, customers: 0 },
  offsets: { orders: 0, products: 0, customers: 0 },
  loading: false,
  syncBusy: false,
  showModal: false,
  alert: null,          // { type: 'success'|'error', msg }
};

const LIMIT = 50;

// ─── API client ────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateShort(ts) {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function badge(text, cls) {
  if (!text && text !== 0) return '—';
  return `<span class="badge badge-${cls || 'default'}">${esc(text)}</span>`;
}

function orderBadge(s) {
  return badge(s, { open: 'open', cancelled: 'cancelled', closed: 'inactive', pending: 'pending' }[s] || 'default');
}

function financialBadge(s) {
  return badge(s, { paid: 'paid', pending: 'pending', refunded: 'refunded', voided: 'inactive', authorized: 'pending', partially_paid: 'pending' }[s] || 'default');
}

function flash(type, msg, ms = 4500) {
  state.alert = { type, msg };
  renderAlertBanner();
  clearTimeout(flash._timer);
  flash._timer = setTimeout(() => { state.alert = null; renderAlertBanner(); }, ms);
}

// ─── Data loading ──────────────────────────────────────────────────────────────

async function loadShops() {
  state.shops = await api('GET', '/api/shops');
}

async function loadTabData() {
  if (!state.shop) return;
  state.loading = true;
  renderMainContent();

  try {
    const { tab } = state;
    if (tab === 'logs') {
      state.data.logs = await api('GET', `/api/shops/${state.shop.id}/sync-logs?limit=100`);
    } else {
      const offset = state.offsets[tab] || 0;
      const res = await api('GET', `/api/shops/${state.shop.id}/${tab}?limit=${LIMIT}&offset=${offset}`);
      state.data[tab] = res.items;
      state.totals[tab] = res.total;
    }
  } catch (err) {
    flash('error', err.message);
  }

  state.loading = false;
  renderMainContent();
}

// ─── Actions ───────────────────────────────────────────────────────────────────

async function doLogin(username, password) {
  await api('POST', '/api/auth/login', { username, password });
  state.loggedIn = true;
  await loadShops();
  checkConnectedParam();
}

async function doLogout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  Object.assign(state, { loggedIn: false, shops: [], shop: null, alert: null });
  render();
}

async function selectShop(id) {
  state.shop = state.shops.find((s) => s.id === id) || null;
  state.tab = 'orders';
  state.offsets = { orders: 0, products: 0, customers: 0 };
  state.data = { orders: [], products: [], customers: [], logs: [] };
  state.totals = { orders: 0, products: 0, customers: 0 };
  renderSidebar();
  renderMainContent();
  await loadTabData();
}

async function changeTab(tab) {
  state.tab = tab;
  await loadTabData();
}

async function doSync() {
  if (!state.shop || state.syncBusy) return;
  state.syncBusy = true;
  renderMainContent();
  try {
    await api('POST', `/api/shops/${state.shop.id}/sync`);
    flash('success', `Sync started for ${state.shop.shop_domain} — data will update shortly`);
    // Refresh shop metadata after a delay to pick up updated last_synced_at
    setTimeout(async () => {
      await loadShops();
      if (state.shop) state.shop = state.shops.find((s) => s.id === state.shop.id) || state.shop;
      renderSidebar();
      renderMainContent();
    }, 4000);
  } catch (err) {
    flash('error', err.message);
  }
  state.syncBusy = false;
  renderMainContent();
}

async function doDisconnect() {
  if (!state.shop) return;
  if (!confirm(`Disconnect ${state.shop.shop_domain}?\n\nThis clears the access token and stops all syncs.`)) return;
  try {
    await api('DELETE', `/api/shops/${state.shop.id}`);
    const domain = state.shop.shop_domain;
    state.shop = null;
    await loadShops();
    renderSidebar();
    renderMainContent();
    flash('success', `${domain} disconnected`);
  } catch (err) {
    flash('error', err.message);
  }
}

function doConnect(rawDomain) {
  const domain = rawDomain.trim().toLowerCase();
  const shop = domain.includes('.myshopify.com') ? domain : `${domain}.myshopify.com`;
  window.location.href = `/shopify/oauth/install?shop=${encodeURIComponent(shop)}`;
}

function checkConnectedParam() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('connected');
  if (connected) {
    flash('success', `✓ ${connected} connected successfully!`);
    window.history.replaceState({}, '', '/');
  }
}

// ─── Partial renders (avoid full page rebuilds) ────────────────────────────────

function renderSidebar() {
  const el = document.querySelector('.sidebar-shops');
  if (el) el.innerHTML = shopsListHTML();
}

function renderMainContent() {
  const el = $('main-content');
  if (el) el.innerHTML = state.shop ? shopDetailHTML() : welcomeHTML();
}

function renderAlertBanner() {
  const el = $('alert-banner');
  if (!el) return;
  if (state.alert) {
    el.className = `alert-banner alert-${state.alert.type}`;
    el.textContent = state.alert.msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// Full rebuild — only called on login/logout or first render
function render() {
  $('app').innerHTML = state.loggedIn ? dashboardHTML() : loginHTML();
  attachEvents();
}

// ─── HTML templates ────────────────────────────────────────────────────────────

function loginHTML() {
  return `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">
          <h1>Shopify Connector</h1>
          <p>vDelivers Admin Dashboard</p>
        </div>
        <div id="login-error" class="alert alert-error" hidden></div>
        <form id="login-form">
          <div class="form-group">
            <label for="u-username">Username</label>
            <input id="u-username" type="text" name="username" autocomplete="username" required autofocus>
          </div>
          <div class="form-group">
            <label for="u-password">Password</label>
            <input id="u-password" type="password" name="password" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">
            Sign in
          </button>
        </form>
      </div>
    </div>`;
}

function dashboardHTML() {
  return `
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-title">Shopify Connector</div>
          <div class="sidebar-subtitle">vDelivers Admin</div>
        </div>
        <div class="sidebar-shops">${shopsListHTML()}</div>
        <div class="sidebar-footer">
          <button class="btn-connect" data-action="open-modal">＋ Connect Store</button>
        </div>
      </aside>
      <main class="content">
        <div class="topbar">
          <span class="topbar-title">${esc(state.shop?.shop_domain ?? 'Dashboard')}</span>
          <button class="btn btn-secondary btn-sm" data-action="logout">Logout</button>
        </div>
        <div id="alert-banner" class="alert-banner" hidden></div>
        <div class="content-scroll">
          <div id="main-content">
            ${state.shop ? shopDetailHTML() : welcomeHTML()}
          </div>
        </div>
      </main>
    </div>
    ${state.showModal ? connectModalHTML() : ''}`;
}

function shopsListHTML() {
  if (!state.shops.length) {
    return `<div class="no-shops">No stores connected yet</div>`;
  }
  return state.shops.map((s) => `
    <div class="shop-item${state.shop?.id === s.id ? ' active' : ''}"
         data-action="select-shop" data-id="${esc(s.id)}">
      <div class="shop-item-dot ${s.is_active ? 'active' : 'inactive'}"></div>
      <div style="overflow:hidden">
        <div class="shop-item-name">${esc(s.shop_domain)}</div>
        <div class="shop-item-meta">
          ${s.last_synced_at ? 'Synced ' + fmtDateShort(s.last_synced_at) : 'Not yet synced'}
        </div>
      </div>
    </div>`).join('');
}

function welcomeHTML() {
  const hasShops = state.shops.length > 0;
  return `
    <div class="welcome">
      <div class="welcome-icon">🛍️</div>
      <h2>Welcome to Shopify Connector</h2>
      <p>${hasShops
        ? 'Select a store from the sidebar to view its orders, products, and customers.'
        : 'Connect your first Shopify store to start syncing data.'
      }</p>
      <button class="btn btn-primary" data-action="open-modal">Connect a Store</button>
    </div>`;
}

function shopDetailHTML() {
  const s = state.shop;
  const activeBadge = s.is_active ? badge('Active', 'active') : badge('Inactive', 'inactive');

  return `
    <div class="content-inner">
      <div class="page-header">
        <div>
          <div class="page-title">${esc(s.shop_domain)}</div>
          <div class="page-subtitle">
            ${activeBadge}
            &nbsp;·&nbsp;Last synced: ${fmtDate(s.last_synced_at)}
          </div>
        </div>
        <div class="header-actions">
          <button class="btn btn-secondary" data-action="sync" ${state.syncBusy ? 'disabled' : ''}>
            ${state.syncBusy
              ? '<span class="spinner"></span>&nbsp;Syncing…'
              : '↻&nbsp;Sync Now'}
          </button>
          <button class="btn btn-danger" data-action="disconnect">Disconnect</button>
        </div>
      </div>

      <div class="tabs">
        ${['orders', 'products', 'customers', 'logs'].map((t) => {
          const label = t.charAt(0).toUpperCase() + t.slice(1);
          const count = t !== 'logs' && state.totals[t] ? `<span class="tab-count">${state.totals[t]}</span>` : '';
          return `<div class="tab${state.tab === t ? ' active' : ''}" data-action="tab" data-tab="${t}">${label}${count}</div>`;
        }).join('')}
      </div>

      ${state.loading ? loadingHTML() : tabContentHTML()}
    </div>`;
}

function loadingHTML() {
  return `<div class="loading-state"><span class="spinner"></span> Loading…</div>`;
}

function tabContentHTML() {
  switch (state.tab) {
    case 'orders':    return ordersHTML();
    case 'products':  return productsHTML();
    case 'customers': return customersHTML();
    case 'logs':      return logsHTML();
    default: return '';
  }
}

function paginationHTML(tab) {
  const total  = state.totals[tab] || 0;
  const offset = state.offsets[tab] || 0;
  const from   = total === 0 ? 0 : offset + 1;
  const to     = Math.min(offset + LIMIT, total);
  return `
    <div class="pagination">
      <span class="pagination-info">${total === 0 ? 'No results' : `${from}–${to} of ${total}`}</span>
      <button class="btn btn-secondary btn-sm" data-action="page-prev" data-tab="${tab}" ${offset === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="btn btn-secondary btn-sm" data-action="page-next" data-tab="${tab}" ${to >= total ? 'disabled' : ''}>Next →</button>
    </div>`;
}

function ordersHTML() {
  const rows = state.data.orders;
  if (!rows.length) return emptyHTML('No orders synced yet');
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Order</th><th>Status</th><th>Payment</th>
          <th>Customer</th><th>Total</th><th>Date</th>
        </tr></thead>
        <tbody>
          ${rows.map((o) => {
            const customer = o.customer ? (o.customer.name || o.customer.email || '—') : '—';
            const total = `${esc(o.currency || '')} ${parseFloat(o.total_price || 0).toFixed(2)}`;
            return `<tr>
              <td><strong>${esc(o.order_number || '#' + o.shopify_id)}</strong></td>
              <td>${orderBadge(o.status)}</td>
              <td>${financialBadge(o.financial_status)}</td>
              <td>${esc(customer)}</td>
              <td style="white-space:nowrap">${total}</td>
              <td style="white-space:nowrap;color:var(--c-muted)">${fmtDate(o.shopify_created_at)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${paginationHTML('orders')}
    </div>`;
}

function productsHTML() {
  const rows = state.data.products;
  if (!rows.length) return emptyHTML('No products synced yet');
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Title</th><th>Vendor</th><th>Type</th><th>Status</th><th>Last updated</th>
        </tr></thead>
        <tbody>
          ${rows.map((p) => `<tr>
            <td><strong>${esc(p.title)}</strong></td>
            <td>${esc(p.vendor || '—')}</td>
            <td>${esc(p.product_type || '—')}</td>
            <td>${badge(p.status, p.status === 'active' ? 'active' : 'inactive')}</td>
            <td style="color:var(--c-muted)">${fmtDate(p.shopify_updated_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${paginationHTML('products')}
    </div>`;
}

function customersHTML() {
  const rows = state.data.customers;
  if (!rows.length) return emptyHTML('No customers synced yet');
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Name</th><th>Email</th><th>Phone</th><th>Orders</th><th>Total spent</th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => {
            const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
            return `<tr>
              <td><strong>${esc(name)}</strong></td>
              <td>${esc(c.email || '—')}</td>
              <td>${esc(c.phone || '—')}</td>
              <td>${c.orders_count ?? 0}</td>
              <td>${parseFloat(c.total_spent || 0).toFixed(2)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${paginationHTML('customers')}
    </div>`;
}

function logsHTML() {
  const rows = state.data.logs;
  if (!rows.length) return emptyHTML('No sync activity logged yet');
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Time</th><th>Event</th><th>Resource</th><th>Status</th><th>Message</th>
        </tr></thead>
        <tbody>
          ${rows.map((l) => `<tr>
            <td style="white-space:nowrap;color:var(--c-muted)">${fmtDate(l.created_at)}</td>
            <td><code>${esc(l.event_type)}</code></td>
            <td>${esc(l.resource_type || '—')}${l.resource_id ? ' <span style="color:var(--c-muted)">#' + esc(l.resource_id) + '</span>' : ''}</td>
            <td>${badge(l.status, l.status === 'success' ? 'success' : 'error')}</td>
            <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.message)}">
              ${esc(l.message || '—')}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function emptyHTML(msg) {
  return `<div class="table-wrap"><div class="table-empty">${esc(msg)}</div></div>`;
}

function connectModalHTML() {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-title">Connect a Shopify Store</div>
        <p class="modal-hint">Enter your store's .myshopify.com domain to begin the OAuth install flow.</p>
        <form id="connect-form">
          <div class="form-group">
            <label for="connect-domain">Shop domain</label>
            <input id="connect-domain" type="text" placeholder="mystore.myshopify.com" autocomplete="off" required autofocus>
          </div>
          <div id="connect-error" class="alert alert-error" hidden></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Connect Store →</button>
          </div>
        </form>
      </div>
    </div>`;
}

// ─── Event wiring ──────────────────────────────────────────────────────────────

function attachEvents() {
  const root = $('app');
  root.addEventListener('click', handleClick);
  root.addEventListener('submit', handleSubmit);
}

async function handleClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, tab } = el.dataset;

  switch (action) {
    case 'logout':      await doLogout(); break;
    case 'select-shop': await selectShop(id); break;
    case 'tab':         await changeTab(tab); break;
    case 'sync':        await doSync(); break;
    case 'disconnect':  await doDisconnect(); break;
    case 'open-modal':
      state.showModal = true;
      render();
      break;
    case 'close-modal':
      state.showModal = false;
      render();
      break;
    case 'page-prev':
      state.offsets[tab] = Math.max(0, (state.offsets[tab] || 0) - LIMIT);
      await loadTabData();
      break;
    case 'page-next':
      state.offsets[tab] = (state.offsets[tab] || 0) + LIMIT;
      await loadTabData();
      break;
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  const form = e.target;

  if (form.id === 'login-form') {
    const errEl = $('login-error');
    errEl.hidden = true;
    try {
      await doLogin(form.username.value.trim(), form.password.value);
      render();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
    return;
  }

  if (form.id === 'connect-form') {
    const domain = $('connect-domain').value.trim().toLowerCase();
    const errEl = $('connect-error');
    if (!domain) return;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*/.test(domain.replace(/\.myshopify\.com$/, ''))) {
      errEl.textContent = 'Enter a valid Shopify domain (e.g. mystore.myshopify.com)';
      errEl.hidden = false;
      return;
    }
    state.showModal = false;
    doConnect(domain);
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    // If session is still alive (e.g. page refresh), load shops straight away
    await loadShops();
    state.loggedIn = true;
    checkConnectedParam();
  } catch {
    state.loggedIn = false;
  }
  render();
})();
