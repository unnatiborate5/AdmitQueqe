'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const FailureLimiter = require('../utils/rateLimiter');
const { APP_ID_RE, clean } = require('../utils/validators');
const admissionTokenService = require('./admissionTokenService');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DUPLICATE_EMAIL_MESSAGE = 'An account with this email already exists. Please log in instead.';
const SHARED_DEMO_PASSWORD = 'Student@2026';

const toPublic = (row) => ({
  id: row.id,
  fullName: row.full_name,
  applicationId: row.application_id || null,
  admissionToken: row.admission_token || null,
  email: row.email,
  phone: row.phone,
});

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const isUniqueViolation = (err) => /UNIQUE constraint failed/i.test(String(err && err.message));

// Rate limit failed auth attempts per application ID / account
const authLimiter = new FailureLimiter({ max: Number(process.env.AUTH_MAX_ATTEMPTS) || 5, windowMs: 15 * 60 * 1000 });

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = String(stored).split(':');
  const expected = Buffer.from(hashHex || '', 'hex');
  if (!expected.length) return false;
  const key = await scrypt(password, Buffer.from(saltHex || '', 'hex'), expected.length || 64);
  return crypto.timingSafeEqual(key, expected);
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

function verifyPasswordSync(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = String(stored).split(':');
  const expected = Buffer.from(hashHex || '', 'hex');
  if (!expected.length) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex || '', 'hex'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

function setDemoPassword(applicationId, password = SHARED_DEMO_PASSWORD) {
  const pass = clean(password) || SHARED_DEMO_PASSWORD;
  const hash = hashPasswordSync(pass);
  db.prepare(`
    INSERT INTO demo_cap_credentials (application_id, password_hash, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(application_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = datetime('now')
  `).run(applicationId, hash);
}

function findByEmail(email) {
  return db.prepare('SELECT * FROM students WHERE email = ?').get(email);
}

function findByApplicationId(applicationId) {
  if (!applicationId) return null;
  return db.prepare('SELECT * FROM students WHERE application_id = ?').get(clean(applicationId).toUpperCase());
}

function createSession(studentId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, student_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), studentId, Date.now() + SESSION_TTL_MS);
  return token;
}

/**
 * Student registration:
 * Supports primary CAP ID + CAP password flow.
 * Matches against trusted admission-cell records (cap_allotment_records) and validates against demo credentials.
 * If legacy { fullName, email, phone, password } is supplied without applicationId, falls back to legacy handler.
 */
async function register(params) {
  const b = params && typeof params === 'object' ? params : {};
  if (b.applicationId !== undefined || !b.email) {
    const applicationId = clean(b.applicationId).toUpperCase();
    const password = typeof b.password === 'string' ? b.password : '';
    const errors = {};

    if (!applicationId) errors.applicationId = 'Application ID is required.';
    else if (!APP_ID_RE.test(applicationId)) {
      errors.applicationId = 'Application ID must be 5-20 characters (letters, numbers, hyphen).';
    }
    if (!password) errors.password = 'CAP password is required.';
    if (Object.keys(errors).length) {
      throw new ApiError(400, 'Please correct the highlighted fields.', errors);
    }

    const key = `auth:${applicationId}`;
    const wait = authLimiter.retryAfter(key);
    if (wait > 0) {
      throw new ApiError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, null, 'RATE_LIMITED');
    }

    const existingStudent = findByApplicationId(applicationId);
    if (existingStudent) {
      authLimiter.fail(key);
      throw new ApiError(409, 'An account has already been registered for this CAP Application ID. Please log in instead.', { applicationId: 'Already registered.' }, 'ALREADY_REGISTERED');
    }

    const record = db.prepare('SELECT * FROM cap_allotment_records WHERE application_id = ?').get(applicationId);
    if (!record) {
      authLimiter.fail(key);
      throw new ApiError(404, 'No matching CAP allotment record found for this application ID. Contact the college admission cell.', { applicationId: 'Record not found.' }, 'RECORD_NOT_FOUND');
    }

    if (record.status === 'revoked') {
      authLimiter.fail(key);
      throw new ApiError(400, 'This CAP allotment record was revoked by the college admission cell.', { applicationId: 'Record revoked.' }, 'RECORD_REVOKED');
    }

    if (record.linked_student_id) {
      authLimiter.fail(key);
      throw new ApiError(409, 'This CAP allotment record has already been registered by another account.', { applicationId: 'Already claimed.' }, 'ALREADY_LINKED');
    }

    // Validate password against demo credentials
    let validPassword = false;
    const cred = db.prepare('SELECT password_hash FROM demo_cap_credentials WHERE application_id = ?').get(applicationId);
    if (cred && verifyPasswordSync(password, cred.password_hash)) {
      validPassword = true;
    } else if (password === SHARED_DEMO_PASSWORD || password === 'DemoPass123') {
      validPassword = true;
      setDemoPassword(applicationId, password);
    }

    if (!validPassword) {
      authLimiter.fail(key);
      throw new ApiError(401, 'Invalid CAP credentials. The password is incorrect.', { password: 'Incorrect password.' }, 'INVALID_CREDENTIALS');
    }

    authLimiter.reset(key);

    const fullName = record.candidate_name; // Trusted identity data matched with admission cell record
    const email = `${applicationId.toLowerCase()}@student.admitflow.local`;
    const phone = '';
    const passwordHash = hashPasswordSync(password);

    return db.transaction(() => {
      let insertResult;
      try {
        insertResult = db.prepare(
          'INSERT INTO students (full_name, application_id, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)'
        ).run(fullName, applicationId, email, phone, passwordHash);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError(409, 'An account has already been registered for this CAP Application ID. Please log in instead.', { applicationId: 'Already registered.' }, 'ALREADY_REGISTERED');
        }
        throw err;
      }

      const studentId = Number(insertResult.lastInsertRowid);

      if (record.status === 'verified') {
        db.prepare("UPDATE cap_allotment_records SET linked_student_id = ?, updated_at = datetime('now') WHERE id = ?").run(studentId, record.id);
        db.prepare(
          `INSERT INTO cap_details (student_id, application_id, student_name, allotted_college, course_branch, cap_round, allotment_status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(studentId, record.application_id, record.candidate_name, record.allotted_college, record.course_branch, record.cap_round, record.allotment_status);
        db.prepare("INSERT INTO cap_record_history (record_id, event, actor_type, actor_name, remarks, details) VALUES (?, 'linked', 'student', ?, 'Linked upon student registration', ?)")
          .run(record.id, fullName, JSON.stringify({ studentId, studentName: fullName }));
        admissionTokenService.allocateAdmissionToken(studentId, db);
        const admissionProgressQueueService = require('./admissionProgressQueueService');
        admissionProgressQueueService.enrollStudent(studentId, db);
      } else {
        // Pending verification: keep record pending, link student, record pending claim
        db.prepare("UPDATE cap_allotment_records SET linked_student_id = ?, updated_at = datetime('now') WHERE id = ?").run(studentId, record.id);
        db.prepare("INSERT INTO cap_claims (student_id, application_id, reason, status) VALUES (?, ?, 'not_verified', 'pending')").run(studentId, applicationId);
        db.prepare("INSERT INTO cap_record_history (record_id, event, actor_type, actor_name, remarks, details) VALUES (?, 'linked', 'student', ?, 'Student registered with pending verification record', ?)")
          .run(record.id, fullName, JSON.stringify({ studentId, studentName: fullName }));
      }

      return toPublic(findByApplicationId(applicationId));
    })();
  }

  // Legacy registration
  const { fullName, email, phone, password } = b;
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

/**
 * Student login:
 * Supports primary CAP ID + demo password login.
 * If legacy { email, password } is supplied without applicationId, falls back to legacy email login.
 */
async function login(params) {
  const b = params && typeof params === 'object' ? params : {};
  if (b.applicationId !== undefined || !b.email) {
    const applicationId = clean(b.applicationId).toUpperCase();
    const password = typeof b.password === 'string' ? b.password : '';
    const errors = {};

    if (!applicationId) errors.applicationId = 'Application ID is required.';
    if (!password) errors.password = 'Password is required.';
    if (Object.keys(errors).length) {
      throw new ApiError(400, 'Please correct the highlighted fields.', errors);
    }

    const key = `auth:${applicationId}`;
    const wait = authLimiter.retryAfter(key);
    if (wait > 0) {
      throw new ApiError(429, `Too many login attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, null, 'RATE_LIMITED');
    }

    const row = findByApplicationId(applicationId);
    let validPassword = false;
    const cred = db.prepare('SELECT password_hash FROM demo_cap_credentials WHERE application_id = ?').get(applicationId);
    if (cred && verifyPasswordSync(password, cred.password_hash)) {
      validPassword = true;
    } else if (row && row.password_hash && verifyPasswordSync(password, row.password_hash)) {
      validPassword = true;
    } else if (password === SHARED_DEMO_PASSWORD || password === 'DemoPass123') {
      const record = db.prepare('SELECT id FROM cap_allotment_records WHERE application_id = ?').get(applicationId);
      if (record && row) {
        validPassword = true;
        setDemoPassword(applicationId, password);
      }
    }

    if (!row || !validPassword) {
      authLimiter.fail(key);
      throw new ApiError(401, 'Invalid CAP Application ID or password.', { password: 'Incorrect ID or password.' }, 'INVALID_CREDENTIALS');
    }

    authLimiter.reset(key);
    return { token: createSession(row.id), student: toPublic(row) };
  }

  // Legacy email login
  const email = clean(b.email).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const row = findByEmail(email);
  const stored = row ? row.password_hash : `${'00'.repeat(16)}:${'00'.repeat(64)}`;
  const ok = await verifyPassword(password, stored);
  if (!row || !ok) throw new ApiError(401, 'Invalid email or password.');
  return { token: createSession(row.id), student: toPublic(row) };
}

function getStudentBySession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  let row = db.prepare(
    `SELECT s.id, s.full_name, s.application_id, s.admission_token, s.email, s.phone, ss.expires_at
       FROM sessions ss JOIN students s ON s.id = ss.student_id
      WHERE ss.token_hash = ?`
  ).get(tokenHash);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  if (!row.admission_token) {
    const hasVerifiedCap = db.prepare(`
      SELECT 1 FROM cap_details WHERE student_id = ?
      UNION
      SELECT 1 FROM cap_allotment_records WHERE linked_student_id = ? AND status = 'verified'
    `).get(row.id, row.id);
    if (hasVerifiedCap) {
      row.admission_token = admissionTokenService.allocateAdmissionToken(row.id, db);
      const admissionProgressQueueService = require('./admissionProgressQueueService');
      admissionProgressQueueService.enrollStudent(row.id, db);
    }
  }
  return toPublic(row);
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

module.exports = {
  SESSION_TTL_MS,
  register,
  login,
  getStudentBySession,
  destroySession,
  hashPassword,
  verifyPassword,
  hashPasswordSync,
  verifyPasswordSync,
  setDemoPassword,
  findByEmail,
  findByApplicationId,
  authLimiter,
  SHARED_DEMO_PASSWORD,
};
