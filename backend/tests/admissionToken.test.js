'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-token-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.AUTH_MAX_ATTEMPTS = '10';
process.env.CAP_CLAIM_MAX_ATTEMPTS = '10';

const app = require('../app');
const db = require('../config/db');
const authService = require('../services/authService');
const adminAuthService = require('../services/adminAuthService');
const capRecordService = require('../services/capRecordService');
const admissionTokenService = require('../services/admissionTokenService');
const queueService = require('../services/queueService');
const appointmentService = require('../services/appointmentService');
const time = require('../utils/time');

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
  };
}

let officer;
let officerCookie;
const PW = 'AdminPass123';
const STU_PW = 'DemoPass123';

test('setup: admission officer', async () => {
  officer = await adminAuthService.createAdmin({
    fullName: 'Aditi Officer',
    email: 'aditi.officer@admitflow.local',
    password: PW,
    role: 'admission_officer',
  });
  const res = await call('POST', '/api/admin/auth/login', { email: 'aditi.officer@admitflow.local', password: PW });
  assert.equal(res.status, 200);
  officerCookie = res.cookie;
});

// ------------------------------------------------------------------------------------------------
// 1. Successful matching generates unique AF-xxx token and persists it
// ------------------------------------------------------------------------------------------------
test('1. Successful CAP matching generates unique AF-xxx permanent token and persists it', async () => {
  // Pre-seed a trusted verified CAP record
  const rec1 = capRecordService.create(officer, {
    applicationId: 'MH2026-TOKEN1',
    candidateName: 'AARAV SHARMA',
    allottedCollege: 'VIT Pune',
    courseBranch: 'Computer Engineering',
    capRound: 'Round 1',
    allotmentStatus: 'Allotted',
  });
  assert.equal(rec1.status, 'verified');

  // Register student matching this record
  const regRes = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-TOKEN1',
    password: STU_PW,
  });
  assert.equal(regRes.status, 201);
  const studentData = regRes.json.data.student;
  assert.ok(studentData.admissionToken, 'admissionToken must be present upon successful registration match');
  assert.match(studentData.admissionToken, /^AF-\d{3,}$/, 'admissionToken format should be AF-001, etc.');
  assert.equal(studentData.admissionToken, 'AF-001', 'First allocated token should be AF-001');

  // Verify persistence in SQLite students table
  const row = db.prepare('SELECT id, application_id, admission_token FROM students WHERE id = ?').get(studentData.id);
  assert.equal(row.admission_token, 'AF-001');
  assert.equal(row.application_id, 'MH2026-TOKEN1');

  // Verify second student matching another record gets the next sequential token AF-002
  const rec2 = capRecordService.create(officer, {
    applicationId: 'MH2026-TOKEN2',
    candidateName: 'SNEHA PATIL',
    allottedCollege: 'VIT Pune',
    courseBranch: 'Information Technology',
    capRound: 'Round 1',
    allotmentStatus: 'Allotted',
  });
  const regRes2 = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-TOKEN2',
    password: STU_PW,
  });
  assert.equal(regRes2.status, 201);
  assert.equal(regRes2.json.data.student.admissionToken, 'AF-002');

  const row2 = db.prepare('SELECT admission_token FROM students WHERE id = ?').get(regRes2.json.data.student.id);
  assert.equal(row2.admission_token, 'AF-002');
});

// ------------------------------------------------------------------------------------------------
// 2. Unmatched students do NOT receive an admission token
// ------------------------------------------------------------------------------------------------
test('2. Unmatched students do not receive an admission token (null)', async () => {
  // Register a legacy student without a CAP application ID
  const legacyReg = await call('POST', '/api/auth/register', {
    fullName: 'Unmatched Student',
    email: 'unmatched@example.com',
    phone: '9800000001',
    password: 'Password@123',
    confirmPassword: 'Password@123',
  });
  assert.equal(legacyReg.status, 201);
  const student = legacyReg.json.data.student;
  assert.equal(student.admissionToken, null, 'Unmatched student should have null admissionToken');

  const loginRes = await call('POST', '/api/auth/login', {
    email: 'unmatched@example.com',
    password: 'Password@123',
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.data.student.admissionToken, null);
  const cookie = loginRes.cookie;

  // Check /api/auth/me
  const meRes = await call('GET', '/api/auth/me', undefined, cookie);
  assert.equal(meRes.status, 200);
  assert.equal(meRes.json.data.student.admissionToken, null);

  // Check /api/cap-details
  const capRes = await call('GET', '/api/cap-details', undefined, cookie);
  assert.equal(capRes.status, 200);
  assert.equal(capRes.json.data.admissionToken, null);
  assert.equal(capRes.json.data.capDetails, null);

  // Submit an unknown/non-existent application ID -> pending claim, still no admission token
  const claimRes = await call('PUT', '/api/cap-details', { applicationId: 'MH2026-UNKNOWN' }, cookie);
  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.json.data.result, 'pending');
  assert.equal(claimRes.json.data.admissionToken, null);

  const dbRow = db.prepare('SELECT admission_token FROM students WHERE id = ?').get(student.id);
  assert.equal(dbRow.admission_token, null, 'admission_token in DB must remain null for unmatched students');

  // Verify that registering with an unknown CAP ID directly fails
  const badReg = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-NOTFOUND',
    password: STU_PW,
  });
  assert.equal(badReg.status, 404);
});

// ------------------------------------------------------------------------------------------------
// 3. Repeated logins and requests return the exact same token (Idempotency)
// ------------------------------------------------------------------------------------------------
test('3. Repeated logins and requests return the exact same token without generating duplicates', async () => {
  // Login as student 1 (MH2026-TOKEN1)
  const login1 = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-TOKEN1',
    password: STU_PW,
  });
  assert.equal(login1.status, 200);
  assert.equal(login1.json.data.student.admissionToken, 'AF-001');
  const cookie = login1.cookie;

  // Repeated /api/auth/me
  const me1 = await call('GET', '/api/auth/me', undefined, cookie);
  assert.equal(me1.json.data.student.admissionToken, 'AF-001');

  const me2 = await call('GET', '/api/auth/me', undefined, cookie);
  assert.equal(me2.json.data.student.admissionToken, 'AF-001');

  // /api/cap-details
  const capDetails = await call('GET', '/api/cap-details', undefined, cookie);
  assert.equal(capDetails.json.data.admissionToken, 'AF-001');
  assert.equal(capDetails.json.data.capDetails.admissionToken, 'AF-001');

  // /api/dashboard
  const dash = await call('GET', '/api/dashboard', undefined, cookie);
  assert.equal(dash.json.data.student.admissionToken, 'AF-001');
  assert.equal(dash.json.data.admissionToken, 'AF-001');

  // Calling allocateAdmissionToken again directly returns the exact same token
  const tokenAgain = admissionTokenService.allocateAdmissionToken(login1.json.data.student.id, db);
  assert.equal(tokenAgain, 'AF-001');

  // Ensure total number of allocated tokens has not grown
  const count = db.prepare('SELECT count(*) as c FROM students WHERE admission_token IS NOT NULL').get().c;
  assert.equal(count, 2, 'Only 2 students were matched; count must not increase on repeated requests');
});

// ------------------------------------------------------------------------------------------------
// 4. Duplicate token prevention: uniqueness constraint and sequential numbering
// ------------------------------------------------------------------------------------------------
test('4. Duplicate token prevention: unique constraint and sequential allocation', async () => {
  // Pre-seed 3 more verified records
  const ids = ['MH2026-SEQ1', 'MH2026-SEQ2', 'MH2026-SEQ3'];
  const names = ['ROHAN JOSHI', 'PRIYA SHINDE', 'VIKRAM MORE'];
  const tokens = [];

  for (let i = 0; i < ids.length; i++) {
    capRecordService.create(officer, {
      applicationId: ids[i],
      candidateName: names[i],
      allottedCollege: 'VIT Pune',
      courseBranch: 'Mechanical Engineering',
      capRound: 'Round 2',
      allotmentStatus: 'Allotted',
    });
    const reg = await call('POST', '/api/auth/register', {
      applicationId: ids[i],
      password: STU_PW,
    });
    assert.equal(reg.status, 201);
    tokens.push(reg.json.data.student.admissionToken);
  }

  // Tokens must be strictly distinct: AF-003, AF-004, AF-005
  assert.deepEqual(tokens, ['AF-003', 'AF-004', 'AF-005']);

  // Check uniqueness across the entire table
  const allTokens = db.prepare('SELECT admission_token FROM students WHERE admission_token IS NOT NULL').all().map((r) => r.admission_token);
  const uniqueSet = new Set(allTokens);
  assert.equal(allTokens.length, uniqueSet.size, 'All assigned admission tokens must be completely unique');

  // Database unique index constraint test: inserting a duplicate token must throw SQLITE_CONSTRAINT
  const dummyStudent = db.prepare(
    "INSERT INTO students (full_name, email, phone, password_hash) VALUES ('Dummy Test', 'dummy@test.local', '9999999999', 'hash')"
  ).run().lastInsertRowid;

  assert.throws(
    () => {
      db.prepare('UPDATE students SET admission_token = ? WHERE id = ?').run('AF-001', dummyStudent);
    },
    (err) => /UNIQUE constraint failed/i.test(err.message),
    'Database unique index must prevent duplicate admission tokens'
  );
});

// ------------------------------------------------------------------------------------------------
// 5. Permanent admission token remains separate from temporary physical verification queue ticket
// ------------------------------------------------------------------------------------------------
test('5. Permanent admission token remains separate from temporary physical-verification queue ticket', async () => {
  // Get student 1 (MH2026-TOKEN1 with permanent token AF-001)
  const student = authService.findByApplicationId('MH2026-TOKEN1');
  assert.equal(student.admission_token, 'AF-001');

  // Book an appointment for today so check-in is allowed
  const today = time.today();
  appointmentService.schedule(officer, {
    studentId: student.id,
    date: today,
    time: '10:00',
    venue: 'Room 101',
    instructions: 'Bring original documents',
  });

  // Check student in for physical verification queue
  const queueToken = await queueService.checkIn(officer, student.id);
  assert.ok(queueToken, 'Queue ticket must be issued');
  assert.match(queueToken.code, /^[PR]\d{3}$/, 'Queue ticket has temporary code format like R001 / P001');
  assert.notEqual(queueToken.code, student.admission_token, 'Queue ticket code must differ from permanent admission token');

  // Verify students table admission_token has NOT changed
  const studentAfterQueue = authService.findByApplicationId('MH2026-TOKEN1');
  assert.equal(studentAfterQueue.admission_token, 'AF-001');

  // Verify dashboard returns both admissionToken and queue information separately
  const loginRes = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-TOKEN1',
    password: STU_PW,
  });
  const dashRes = await call('GET', '/api/dashboard', undefined, loginRes.cookie);
  assert.equal(dashRes.status, 200);
  assert.equal(dashRes.json.data.admissionToken, 'AF-001', 'Permanent admission token is AF-001');
  assert.ok(dashRes.json.data.queue, 'Queue ticket is active in dashboard');
  assert.equal(dashRes.json.data.queue.token.code, queueToken.code, 'Queue ticket code is separate');

  // Complete queue service at counter
  const called = await queueService.callNext(officer, 1);
  assert.equal(called.id, queueToken.id);
  await queueService.transition(officer, called.id, 'start');
  await queueService.transition(officer, called.id, 'complete');

  // Permanent admission token remains intact after queue ticket completion
  const studentFinal = authService.findByApplicationId('MH2026-TOKEN1');
  assert.equal(studentFinal.admission_token, 'AF-001');
});

// ------------------------------------------------------------------------------------------------
// 6. Admin student list & detail APIs return admissionToken for matched and null for unmatched
// ------------------------------------------------------------------------------------------------
test('6. Admin student list and detail APIs expose admissionToken for matched and null for unmatched', async () => {
  // Query admin students list
  const listRes = await call('GET', '/api/admin/students?pageSize=50', undefined, officerCookie);
  assert.equal(listRes.status, 200);
  const items = listRes.json.data.items;

  const matched = items.find((s) => s.applicationId === 'MH2026-TOKEN1');
  assert.ok(matched, 'Matched student should be in admin students list');
  assert.equal(matched.admissionToken, 'AF-001', 'Admin student list should have admissionToken AF-001');

  const unmatched = items.find((s) => s.email === 'unmatched@example.com');
  assert.ok(unmatched, 'Unmatched student should be in admin students list');
  assert.equal(unmatched.admissionToken, null, 'Unmatched student should have null admissionToken');

  // Query admin student detail for matched student
  const detailMatched = await call('GET', `/api/admin/students/${matched.id}`, undefined, officerCookie);
  assert.equal(detailMatched.status, 200);
  assert.equal(detailMatched.json.data.student.admissionToken, 'AF-001');
  assert.equal(detailMatched.json.data.cap.admissionToken, 'AF-001');

  // Query admin student detail for unmatched student
  const detailUnmatched = await call('GET', `/api/admin/students/${unmatched.id}`, undefined, officerCookie);
  assert.equal(detailUnmatched.status, 200);
  assert.equal(detailUnmatched.json.data.student.admissionToken, null);

  // Search by admission token in admin students query
  const searchRes = await call('GET', '/api/admin/students?search=AF-001', undefined, officerCookie);
  assert.equal(searchRes.status, 200);
  assert.equal(searchRes.json.data.items.length, 1);
  assert.equal(searchRes.json.data.items[0].admissionToken, 'AF-001');
});

// ------------------------------------------------------------------------------------------------
// 7. Admin CAP records, claims, and search APIs expose admissionToken
// ------------------------------------------------------------------------------------------------
test('7. Admin CAP records, claims, and search APIs expose linked admissionToken', async () => {
  // Query CAP records
  const recRes = await call('GET', '/api/admin/cap/records?pageSize=50', undefined, officerCookie);
  assert.equal(recRes.status, 200);
  const linkedRecord = recRes.json.data.items.find((r) => r.applicationId === 'MH2026-TOKEN1');
  assert.ok(linkedRecord);
  assert.ok(linkedRecord.linkedStudent);
  assert.equal(linkedRecord.linkedStudent.admissionToken, 'AF-001');

  // Query pending claims
  const claimsRes = await call('GET', '/api/admin/cap/claims?status=pending', undefined, officerCookie);
  assert.equal(claimsRes.status, 200);
  const pendingClaim = claimsRes.json.data.items.find((c) => c.applicationId === 'MH2026-UNKNOWN');
  assert.ok(pendingClaim);
  assert.equal(pendingClaim.student.admissionToken, null, 'Unmatched student claim has null admissionToken');

  // Global admin search for token
  const searchRes = await call('GET', '/api/admin/search?q=MH2026-TOKEN1', undefined, officerCookie);
  assert.equal(searchRes.status, 200);
  const searchHit = searchRes.json.data.results.find((r) => r.applicationId === 'MH2026-TOKEN1');
  assert.ok(searchHit);
  assert.equal(searchHit.admissionToken, 'AF-001');
});

// ------------------------------------------------------------------------------------------------
// 8. Demo Student Authentication & Permanent Admission Token Persistence
// ------------------------------------------------------------------------------------------------
test('8. Demo Student Login, Incorrect Passwords, Unmatched CAP IDs, Registration, and Token Persistence', async () => {
  const DEMO_PW = authService.SHARED_DEMO_PASSWORD; // 'Student@2026'
  assert.equal(DEMO_PW, 'Student@2026');

  // A. Create a trusted CAP record for testing demo student registration
  const demoRec = capRecordService.create(officer, {
    applicationId: 'MH2026-DEMOAUTH1',
    candidateName: 'PRIYA DESHMUKH',
    allottedCollege: 'VIT Pune',
    courseBranch: 'Information Technology',
    capRound: 'Round 1',
    allotmentStatus: 'Allotted',
  });
  assert.equal(demoRec.status, 'verified');

  // B. Registration with shared demo password 'Student@2026' succeeds and generates AF-xxx token
  const regRes = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-DEMOAUTH1',
    password: DEMO_PW,
  });
  assert.equal(regRes.status, 201);
  const registeredStudent = regRes.json.data.student;
  assert.ok(registeredStudent.admissionToken);
  assert.match(registeredStudent.admissionToken, /^AF-\d{3,}$/);
  const initialToken = registeredStudent.admissionToken;

  // C. Successful login with correct shared demo password
  const loginRes = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-DEMOAUTH1',
    password: DEMO_PW,
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.data.student.admissionToken, initialToken);
  assert.ok(loginRes.cookie, 'Login should set session cookie');

  // D. Token persistence: Repeated login returns the identical token without duplicates
  const repeatLoginRes = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-DEMOAUTH1',
    password: DEMO_PW,
  });
  assert.equal(repeatLoginRes.status, 200);
  assert.equal(repeatLoginRes.json.data.student.admissionToken, initialToken);

  // E. Login with incorrect password fails with 401 and error message
  const wrongPwRes = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-DEMOAUTH1',
    password: 'WrongPassword@999',
  });
  assert.equal(wrongPwRes.status, 401);
  assert.equal(wrongPwRes.json.message, 'Invalid CAP Application ID or password.');

  // F. Login with unmatched / non-existent CAP Application ID fails with 401
  const unmatchedLoginRes = await call('POST', '/api/auth/login', {
    applicationId: 'MH2026-UNMATCHED99',
    password: DEMO_PW,
  });
  assert.equal(unmatchedLoginRes.status, 401);
  assert.equal(unmatchedLoginRes.json.message, 'Invalid CAP Application ID or password.');

  // G. Registration with unmatched CAP Application ID fails with 404 RECORD_NOT_FOUND
  const unmatchedRegRes = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-NONEXISTENT',
    password: DEMO_PW,
  });
  assert.equal(unmatchedRegRes.status, 404);
  assert.equal(unmatchedRegRes.json.code, 'RECORD_NOT_FOUND');

  // H. Registration with wrong password fails with 401
  capRecordService.create(officer, {
    applicationId: 'MH2026-DEMOAUTH2',
    candidateName: 'ROHIT VERMA',
    allottedCollege: 'VIT Pune',
    courseBranch: 'Mechanical Engineering',
    capRound: 'Round 1',
    allotmentStatus: 'Allotted',
    demoPassword: 'CustomDemoPassword@2026',
  });
  const wrongRegPwRes = await call('POST', '/api/auth/register', {
    applicationId: 'MH2026-DEMOAUTH2',
    password: 'CompletelyWrongPassword',
  });
  assert.equal(wrongRegPwRes.status, 401);
  assert.equal(wrongRegPwRes.json.code, 'INVALID_CREDENTIALS');
});


