'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-sim-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.AUTH_MAX_ATTEMPTS = '5';
process.env.CAP_DEMO_LOGIN_MAX_ATTEMPTS = '5';

const app = require('../app');
const db = require('../config/db');
const adminAuthService = require('../services/adminAuthService');
const capRecordService = require('../services/capRecordService');
const queueService = require('../services/queueService');

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  queueService.shutdown();
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

async function call(method, url, body, cookie, headers = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + url, {
    method,
    headers: h,
    redirect: 'manual',
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const sc = res.headers.get('set-cookie');
  return {
    status: res.status,
    json: await res.json().catch(() => null),
    cookie: sc ? sc.split(';')[0] : null,
    setCookie: sc,
  };
}

const PW = 'AdminPass123';
let officerCookie;
let officerAdmin;
let superAdmin;

test('setup: admission officer and super admin accounts', async () => {
  officerAdmin = await adminAuthService.createAdmin({
    fullName: 'Ananya Officer',
    email: 'officer@admitflow.local',
    password: PW,
    role: 'admission_officer',
  });
  superAdmin = await adminAuthService.createAdmin({
    fullName: 'Siddharth Super',
    email: 'super@admitflow.local',
    password: PW,
    role: 'super_admin',
  });
  const res = await call('POST', '/api/admin/auth/login', { email: 'officer@admitflow.local', password: PW });
  assert.equal(res.status, 200);
  officerCookie = res.cookie;
});

// =============================================================================================== CSV Import
test('CSV Import: handles valid rows (6 and 7 columns), malformed rows, duplicate IDs in file, and existing records', async () => {
  // Pre-seed an existing verified record to test that imports NEVER overwrite an existing verified record
  const preRec = capRecordService.create(officerAdmin, {
    applicationId: 'MH2026-90001',
    candidateName: 'EXISTING CANDIDATE',
    allottedCollege: 'COEP Pune',
    courseBranch: 'Computer Engineering',
    capRound: 'Round 1',
    allotmentStatus: 'Allotted',
  });
  capRecordService.verify(superAdmin, preRec.id, { remarks: 'Verified test record' });

  const csv = [
    'application_id,candidate_name,allotted_college,course_branch,cap_round,allotment_status,demo_password',
    // Valid 6 columns (default password DemoPass123)
    'MH2026-90002,KALE SNEHAL,COEP Pune,Computer Engineering,Round 1,Allotted',
    // Valid 7 columns (custom demo password)
    'MH2026-90003,PATIL ARJUN,VJTI Mumbai,Information Technology,Round 2,Allotted (Float),CustomPass999',
    // Duplicate ID in this file (second occurrence)
    'MH2026-90002,DUPLICATE IN FILE,COEP Pune,Computer Engineering,Round 1,Allotted',
    // Conflicting ID already in database (verified record - must never be overwritten)
    'MH2026-90001,OVERWRITE ATTEMPT,COEP Pune,Civil Engineering,Round 3,Seat Cancelled',
    // Malformed: too few columns
    'MH2026-90004,INCOMPLETE,COEP',
    // Malformed: invalid application ID
    'BAD,INVALID ID,COEP Pune,Mechanical Engineering,Round 1,Allotted',
    // Malformed: invalid CAP round
    'MH2026-90005,DESHMUKH PRIYA,COEP Pune,Computer Engineering,Round 99,Allotted',
  ].join('\r\n');

  const res = await call('POST', '/api/admin/cap/records/import', { csv, sourceNote: 'Batch Import 2026' }, officerCookie);
  assert.equal(res.status, 201);
  const data = res.json.data;

  // Import summary checks
  assert.equal(data.total, 7);
  assert.equal(data.accepted, 2);
  assert.equal(data.created, 2);
  assert.equal(data.duplicates, 2);
  assert.equal(data.rejected, 3);
  assert.equal(data.skipped.length, 5);
  assert.equal(data.summary.accepted, 2);
  assert.equal(data.summary.duplicates, 2);
  assert.equal(data.summary.rejected, 3);

  // Check verified record was NOT overwritten
  const checkPre = db.prepare("SELECT candidate_name, status, allotted_college FROM cap_allotment_records WHERE application_id = 'MH2026-90001'").get();
  assert.equal(checkPre.candidate_name, 'EXISTING CANDIDATE');
  assert.equal(checkPre.status, 'verified');
  assert.equal(checkPre.allotted_college, 'COEP Pune');

  // Check custom demo password was hashed and saved in demo_cap_credentials
  const credRow = db.prepare("SELECT password_hash FROM demo_cap_credentials WHERE application_id = 'MH2026-90003'").get();
  assert.ok(credRow, 'demo credential row exists');
  assert.ok(!credRow.password_hash.includes('CustomPass999'), 'password is not stored in plaintext');
  assert.ok(capRecordService.verifyPasswordSync('CustomPass999', credRow.password_hash));

  // Check default demo password for 6-column row
  const credRow2 = db.prepare("SELECT password_hash FROM demo_cap_credentials WHERE application_id = 'MH2026-90002'").get();
  assert.ok(credRow2, 'default demo credential row exists');
  assert.ok(capRecordService.verifyPasswordSync('DemoPass123', credRow2.password_hash));
});

// =============================================================================================== CAP Registration & Login
test('Registration: successful student registration using CAP ID + demo password links to trusted record', async () => {
  // Register with CAP ID and default demo password
  const regRes = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-90001',
    password: 'DemoPass123',
  });

  assert.equal(regRes.status, 201);
  assert.equal(regRes.json.success, true);
  // Full name is trusted from the admission-cell record, never client supplied
  assert.equal(regRes.json.data.student.fullName, 'EXISTING CANDIDATE');
  assert.equal(regRes.json.data.student.applicationId, 'MH2026-90001');

  // Check database: record is linked to this student
  const stu = db.prepare("SELECT * FROM students WHERE application_id = 'MH2026-90001'").get();
  assert.ok(stu);
  assert.equal(stu.full_name, 'EXISTING CANDIDATE');
  const capRow = db.prepare('SELECT * FROM cap_details WHERE student_id = ?').get(stu.id);
  assert.ok(capRow);
  assert.equal(capRow.application_id, 'MH2026-90001');
  assert.equal(capRow.student_name, 'EXISTING CANDIDATE');
});

test('Persistent login: student logs in with CAP ID + demo password and receives HttpOnly session cookie', async () => {
  const loginRes = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-90001',
    password: 'DemoPass123',
  });

  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.success, true);
  assert.equal(loginRes.json.data.student.applicationId, 'MH2026-90001');
  assert.match(loginRes.setCookie, /HttpOnly/i);
  assert.match(loginRes.setCookie, /admitflow_sid=/i);

  // Verify authenticated session accesses protected route
  const meRes = await call('GET', '/api/auth/me', undefined, loginRes.cookie);
  assert.equal(meRes.status, 200);
  assert.equal(meRes.json.data.student.fullName, 'EXISTING CANDIDATE');
  assert.equal(meRes.json.data.student.applicationId, 'MH2026-90001');
});

test('Registration: pending record registers safely and remains clearly pending', async () => {
  // MH2026-90002 has status pending_verification from CSV import
  const recBefore = db.prepare("SELECT status FROM cap_allotment_records WHERE application_id = 'MH2026-90002'").get();
  assert.equal(recBefore.status, 'pending_verification');

  const regRes = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-90002',
    password: 'DemoPass123',
  });
  assert.equal(regRes.status, 201);
  assert.equal(regRes.json.data.student.fullName, 'KALE SNEHAL');
  assert.equal(regRes.json.data.student.applicationId, 'MH2026-90002');

  // Verify record in database remains pending_verification (NOT automatically verified)
  const recAfter = db.prepare("SELECT status, linked_student_id FROM cap_allotment_records WHERE application_id = 'MH2026-90002'").get();
  assert.equal(recAfter.status, 'pending_verification');
  assert.ok(recAfter.linked_student_id);

  // Student logs in
  const loginRes = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-90002',
    password: 'DemoPass123',
  });
  assert.equal(loginRes.status, 200);

  // Student views CAP details: allotment details are read-only and status is clearly pending
  const capRes = await call('GET', '/api/cap-details', undefined, loginRes.cookie);
  assert.equal(capRes.status, 200);
  assert.equal(capRes.json.data.capDetails.applicationId, 'MH2026-90002');
  assert.equal(capRes.json.data.capDetails.studentName, 'KALE SNEHAL');
  assert.equal(capRes.json.data.capDetails.allottedCollege, 'COEP Pune');
  assert.equal(capRes.json.data.capDetails.verified, false);
  assert.equal(capRes.json.data.verification.status, 'pending');
});

test('Custom demo password from CSV import succeeds, wrong password fails with 401', async () => {
  // MH2026-90003 was imported with CustomPass999
  // Wrong password fails
  const fail = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-90003',
    password: 'WrongPassword',
  });
  assert.equal(fail.status, 401);
  assert.equal(fail.json.code, 'INVALID_CREDENTIALS');

  // Correct custom demo password succeeds
  const ok = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-90003',
    password: 'CustomPass999',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.student.fullName, 'PATIL ARJUN');

  // Login with custom password
  const logOk = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-90003',
    password: 'CustomPass999',
  });
  assert.equal(logOk.status, 200);
});

// =============================================================================================== Failure Handling
test('Failure handling: unknown application ID returns 404 RECORD_NOT_FOUND', async () => {
  const res = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-00000',
    password: 'DemoPass123',
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.code, 'RECORD_NOT_FOUND');
});

test('Failure handling: revoked record rejects registration with 400 RECORD_REVOKED', async () => {
  const rec = capRecordService.create(officerAdmin, {
    applicationId: 'MH2026-90020',
    candidateName: 'SAWANT TUSHAR',
    allottedCollege: 'COEP Pune',
    courseBranch: 'Electrical Engineering',
    capRound: 'Round 1',
    allotmentStatus: 'Allotted',
  });
  capRecordService.revoke(superAdmin, rec.id, { remarks: 'Seat cancelled in Round 2' });

  const res = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-90020',
    password: 'DemoPass123',
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'RECORD_REVOKED');
});

test('Failure handling: duplicate claim / already registered ID returns 409 ALREADY_REGISTERED', async () => {
  // MH2026-90001 is already registered
  const res = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-90001',
    password: 'DemoPass123',
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'ALREADY_REGISTERED');
});

test('Security: rate limiting triggers after too many wrong credentials attempts', async () => {
  capRecordService.create(officerAdmin, {
    applicationId: 'MH2026-90040',
    candidateName: 'PROBE RATELIMIT',
    allottedCollege: 'COEP Pune',
    courseBranch: 'Computer Engineering',
    capRound: 'Round 1',
    allotmentStatus: 'Allotted',
  });

  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', '/api/auth/register', {
      applicationId: 'MH2026-90040',
      password: 'WrongPassword',
    });
    assert.equal(r.status, 401);
  }

  // 6th attempt should be rate limited
  const blocked = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-90040',
    password: 'WrongPassword',
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.code, 'RATE_LIMITED');
});

// =============================================================================================== Isolation, Dashboard & Read-Only Details
test('Student data isolation: authenticated student can only access their own details', async () => {
  // Student 1 (MH2026-90001) logs in
  const s1Log = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-90001',
    password: 'DemoPass123',
  });
  // Student 2 (MH2026-90003) logs in
  const s2Log = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-90003',
    password: 'CustomPass999',
  });

  const s1Details = await call('GET', '/api/cap-details', undefined, s1Log.cookie);
  const s2Details = await call('GET', '/api/cap-details', undefined, s2Log.cookie);

  assert.equal(s1Details.json.data.capDetails.applicationId, 'MH2026-90001');
  assert.equal(s1Details.json.data.capDetails.studentName, 'EXISTING CANDIDATE');

  assert.equal(s2Details.json.data.capDetails.applicationId, 'MH2026-90003');
  assert.equal(s2Details.json.data.capDetails.studentName, 'PATIL ARJUN');
});

test('Dashboard: returns authenticated student name and CAP Application ID matched from backend trusted record', async () => {
  const s1Log = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-90001',
    password: 'DemoPass123',
  });

  const dash = await call('GET', '/api/dashboard', undefined, s1Log.cookie);
  assert.equal(dash.status, 200);
  assert.equal(dash.json.data.student.fullName, 'EXISTING CANDIDATE');
  assert.equal(dash.json.data.student.applicationId, 'MH2026-90001');
});

test('Removed workflows: students cannot submit client-supplied allotment fields or modify read-only details', async () => {
  const s1Log = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-90001',
    password: 'DemoPass123',
  });

  // Attempting to send client-supplied allotment fields is rejected with 400 READ_ONLY_FIELDS
  const fakeEdit = await call('PUT', '/api/cap-details', {
    studentName: 'HACKED NAME',
    allottedCollege: 'FAKE COLLEGE',
  }, s1Log.cookie);
  assert.equal(fakeEdit.status, 400);
  assert.equal(fakeEdit.json.code, 'READ_ONLY_FIELDS');
});

test('Audit trail: student registrations and links are audited in cap_record_history', async () => {
  const rec = db.prepare("SELECT id FROM cap_allotment_records WHERE application_id = 'MH2026-90001'").get();
  const history = db.prepare('SELECT * FROM cap_record_history WHERE record_id = ? AND event = ?').get(rec.id, 'linked');
  assert.ok(history, 'history row for linked event exists');
  assert.equal(history.actor_type, 'student');
});
