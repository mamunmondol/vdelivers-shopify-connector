const config = require('../config');

function requireDashboardAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path === '/auth/login') return next();
  // Allow unauthenticated access to public assets
  if (req.path.startsWith('/public/')) return next();
  return res.status(401).json({ error: 'Unauthorized — please log in via /api/auth/login' });
}

module.exports = { requireDashboardAuth };
