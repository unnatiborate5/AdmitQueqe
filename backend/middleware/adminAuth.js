'use strict';
const adminAuthService = require('../services/adminAuthService');
const ApiError = require('../utils/ApiError');
const { parseCookies } = require('./auth');

// Separate cookie from the student one: the two kinds of session can never be mixed up.
const ADMIN_COOKIE = 'admitflow_admin_sid';

const getAdminToken = (req) => parseCookies(req.headers.cookie)[ADMIN_COOKIE];

function cookieString(value, maxAgeSeconds) {
  const parts = [`${ADMIN_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}
const setAdminCookie = (res, token) =>
  res.setHeader('Set-Cookie', cookieString(token, Math.floor(adminAuthService.ADMIN_SESSION_TTL_MS / 1000)));
const clearAdminCookie = (res) => res.setHeader('Set-Cookie', cookieString('', 0));

/** Attaches req.admin or responds 401. */
function requireAdmin(req, res, next) {
  try {
    const admin = adminAuthService.getAdminBySession(getAdminToken(req));
    if (!admin) return next(new ApiError(401, 'Please log in as an admin to continue.', null, 'UNAUTHENTICATED'));
    req.admin = admin;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Role-based access: the admin's role must grant `permission`, otherwise 403. */
const requirePermission = (permission) => (req, res, next) => {
  if (!req.admin || !adminAuthService.can(req.admin.role, permission)) {
    return next(new ApiError(403, 'Your role does not allow this action.', null, 'FORBIDDEN'));
  }
  return next();
};

/**
 * Cheap CSRF defence for state-changing admin requests (on top of SameSite=Strict cookies):
 * the browser's Origin header, when present, must match this server, and bodies must be JSON.
 */
function protectMutations(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (_) { /* malformed origin */ }
    if (host !== req.headers.host) return next(new ApiError(403, 'Cross-site request blocked.', null, 'CSRF'));
  }
  const hasBody = Number(req.headers['content-length'] || 0) > 0;
  if (hasBody && !req.is('application/json')) return next(new ApiError(415, 'Requests must be sent as JSON.'));
  return next();
}

/** For the static admin pages: redirect to the login page instead of returning JSON. */
function adminPageGuard(req, res, next) {
  const page = req.path.replace(/^\/+/, '');
  if (page === '' ) return res.redirect('/admin/dashboard.html');
  if (page === 'login.html' || !page.endsWith('.html')) return next();
  const admin = adminAuthService.getAdminBySession(getAdminToken(req));
  if (!admin) return res.redirect(`/admin/login.html?next=${encodeURIComponent(page)}`);
  return next();
}

module.exports = { ADMIN_COOKIE, getAdminToken, setAdminCookie, clearAdminCookie, requireAdmin, requirePermission, protectMutations, adminPageGuard };
