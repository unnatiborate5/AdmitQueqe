'use strict';
const authService = require('../services/authService');
const ApiError = require('../utils/ApiError');

const COOKIE_NAME = 'admitflow_sid';

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const name = part.slice(0, idx).trim();
    if (!name) return;
    try { out[name] = decodeURIComponent(part.slice(idx + 1).trim()); } catch (_) { /* ignore bad cookie */ }
  });
  return out;
}

const getSessionToken = (req) => parseCookies(req.headers.cookie)[COOKIE_NAME];

function cookieString(value, maxAgeSeconds) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

const setSessionCookie = (res, token) =>
  res.setHeader('Set-Cookie', cookieString(token, Math.floor(authService.SESSION_TTL_MS / 1000)));
const clearSessionCookie = (res) => res.setHeader('Set-Cookie', cookieString('', 0));

/** Protects a route: attaches req.student or responds 401. */
function requireAuth(req, res, next) {
  try {
    const student = authService.getStudentBySession(getSessionToken(req));
    if (!student) return next(new ApiError(401, 'Please log in to continue.', null, 'UNAUTHENTICATED'));
    req.student = student;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { parseCookies, getSessionToken, setSessionCookie, clearSessionCookie, requireAuth };
