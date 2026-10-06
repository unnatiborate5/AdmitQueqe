'use strict';
const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const FailureLimiter = require('../utils/rateLimiter');
const { hashPassword, verifyPassword } = require('./authService');

const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day
const ROLES = ['super_admin', 'admission_officer', 'viewer'];
const ROLE_LABELS = { super_admin: 'Super Admin', admission_officer: 'Admission Officer', viewer: 'Viewer (read-only)' };

/** What each role may do. Every protected admin route names exactly one permission. */
const PERMISSIONS = {
  super_admin: ['dashboard:view', 'students:view', 'applications:review', 'appointments:manage', 'verification:record', 'queue:view', 'queue:operate', 'queue:configure', 'activity:view'],
  admission_officer: ['dashboard:view', 'students:view', 'applications:review', 'appointments:manage', 'verification:record', 'queue:view', 'queue:operate'],
  viewer: ['dashboard:view', 'students:view', 'queue:view'],
};

const emailLimiter = new FailureLimiter({
  max: Number(process.env.ADMIN_LOGIN_MAX_FAILURES) || 5,
  windowMs: 15 * 60 * 1000,
});
const ipLimiter = new FailureLimiter({
  max: Number(process.env.ADMIN_LOGIN_MAX_FAILURES_PER_IP) || 50,
  windowMs: 15 * 60 * 1000,
});

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const can = (role, permission) => (PERMISSIONS[role] || []).includes(permission);

const toPublic = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  role: row.role,
  roleLabel: ROLE_LABELS[row.role],
  permissions: PERMISSIONS[row.role] || [],
});

const findByEmail = (email) => db.prepare('SELECT * FROM admins WHERE email = ?').get(email);

/** Used by the create-admin script and the demo seeder. Never exposed over HTTP. */
async function createAdmin({ fullName, email, password, role }) {
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  if (!fullName || !email) throw new Error('Name and email are required.');
  if (typeof password !== 'string' || password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Admin password must be at least 10 characters and contain a letter and a number.');
  }
  const normalized = String(email).trim().toLowerCase();
  if (findByEmail(normalized)) throw new Error(`An admin with the email ${normalized} already exists.`);
  const passwordHash = await hashPassword(password);
  db.prepare('INSERT INTO admins (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(String(fullName).trim(), normalized, passwordHash, role);
  return toPublic(findByEmail(normalized));
}

async function login({ email, password }, ip) {
  const emailKey = `e:${email}`;
  const ipKey = `i:${ip}`;
  const wait = Math.max(emailLimiter.retryAfter(emailKey), ipLimiter.retryAfter(ipKey));
  if (wait > 0) {
    throw new ApiError(429, `Too many failed login attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, null, 'RATE_LIMITED');
  }

  const row = findByEmail(email);
  // Always run the hash comparison so response time does not reveal which emails are admin accounts.
  const stored = row ? row.password_hash : `${'00'.repeat(16)}:${'00'.repeat(64)}`;
  const ok = await verifyPassword(password, stored);
  if (!row || !ok || !row.is_active) {
    emailLimiter.fail(emailKey);
    ipLimiter.fail(ipKey);
    throw new ApiError(401, 'Invalid email or password.');
  }

  emailLimiter.reset(emailKey);
  db.prepare("UPDATE admins SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  return { token: createSession(row.id), admin: toPublic(row) };
}

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), adminId, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}

function getAdminBySession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(
    `SELECT a.*, s.expires_at FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`
  ).get(tokenHash);
  if (!row) return null;
  if (row.expires_at <= Date.now() || !row.is_active) {
    db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return toPublic(row);
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
}

module.exports = {
  ADMIN_SESSION_TTL_MS, ROLES, ROLE_LABELS, PERMISSIONS, can, createAdmin, login, getAdminBySession, destroySession,
};
