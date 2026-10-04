'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DUPLICATE_EMAIL_MESSAGE = 'An account with this email already exists. Please log in instead.';

const toPublic = (row) => ({ id: row.id, fullName: row.full_name, email: row.email, phone: row.phone });
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const isUniqueViolation = (err) => /UNIQUE constraint failed/i.test(String(err && err.message));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  const expected = Buffer.from(hashHex || '', 'hex');
  const key = await scrypt(password, Buffer.from(saltHex || '', 'hex'), expected.length || 64);
  return expected.length > 0 && crypto.timingSafeEqual(key, expected);
}

function findByEmail(email) {
  return db.prepare('SELECT * FROM students WHERE email = ?').get(email);
}

async function register({ fullName, email, phone, password }) {
  if (findByEmail(email)) {
    throw new ApiError(409, DUPLICATE_EMAIL_MESSAGE, { email: 'This email is already registered.' });
  }
  const passwordHash = await hashPassword(password);
  try {
    db.prepare('INSERT INTO students (full_name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
      .run(fullName, email, phone, passwordHash);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, DUPLICATE_EMAIL_MESSAGE, { email: 'This email is already registered.' });
    }
    throw err;
  }
  return toPublic(findByEmail(email));
}

function createSession(studentId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, student_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), studentId, Date.now() + SESSION_TTL_MS);
  return token;
}

async function login({ email, password }) {
  const row = findByEmail(email);
  // Verify against a dummy hash when the account does not exist, so response
  // time does not reveal which emails are registered.
  const stored = row ? row.password_hash : `${'00'.repeat(16)}:${'00'.repeat(64)}`;
  const ok = await verifyPassword(password, stored);
  if (!row || !ok) throw new ApiError(401, 'Invalid email or password.');
  return { token: createSession(row.id), student: toPublic(row) };
}

function getStudentBySession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(
    `SELECT s.id, s.full_name, s.email, s.phone, ss.expires_at
       FROM sessions ss JOIN students s ON s.id = ss.student_id
      WHERE ss.token_hash = ?`
  ).get(tokenHash);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return toPublic(row);
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

module.exports = { SESSION_TTL_MS, register, login, getStudentBySession, destroySession };
