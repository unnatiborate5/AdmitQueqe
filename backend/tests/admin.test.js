'use strict';
// Phase 3 tests: admin authentication, RBAC, dashboard, student management, application review,
// appointments, activity history, student<->admin synchronisation and data persistence.
// Run with: npm test   (uses its own temporary SQLite file, never your real database)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-admin-test-'));
const DB_FILE = path.join(tmpDir, 'test.db');
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_LOGIN_MAX_FAILURES = '5';

const app = require('../app');
const db = require('../config/db');
const time = require('../utils/time');
const adminAuthService = require('../services/adminAuthService');

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

async function call(method, url, body, cookie, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, {
    method, headers, redirect: 'manual',
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const json = await res.json().catch(() => null);
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie, location: res.headers.get('location') };
}

const PW = 'AdminPass123';
const admins = {};
async function adminLogin(email, password = PW) {
  const r = await call('POST', '/api/admin/auth/login', { email, password });
  assert.equal(r.status, 200, `admin login ${email}: ${r.json && r.json.message}`);
  return r.cookie;
}
const sidOf = {};

let studentSeq = 0;
/** Registers + logs in a student through the real student API; optionally enters CAP details. */
async function makeStudent(name, { cap = true, college = 'College of Engineering Pune', round = 'Round 1' } = {}) {
  studentSeq += 1;
  const email = `student${studentSeq}@example.com`;
  const reg = await call('POST', '/api/auth/register', { fullName: name, email, phone: `98765432${String(studentSeq).padStart(2, '0')}`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123' });
  assert.equal(reg.status, 201);
  const login = await call('POST', '/api/auth/login', { email, password: 'Passw0rd123' });
  const cookie = login.cookie;
  const id = db.prepare('SELECT id FROM students WHERE email = ?').get(email).id;
  if (cap) {
    const r = await call('PUT', '/api/cap-details', {
      applicationId: `MH2026-${1000 + studentSeq}`, studentName: name, allottedCollege: college, courseBranch: 'Computer Engineering', capRound: round, allotmentStatus: 'Allotted',
    }, cookie);
    assert.equal(r.status, 200);
  }
  return { id, email, cookie, appId: `MH2026-${1000 + studentSeq}` };
}

const tomorrow = () => time.addDays(1);
const apptBody = (studentId, over = {}) => ({ studentId, date: tomorrow(), time: '10:30', venue: 'Admission Cell, Room 12', instructions: 'Bring originals', ...over });

let s1; let s2; let s3; let s4; let s5; let noCap;

// ---------------------------------------------------------------------------
test('setup: three admins (one per role) and an inactive one', async () => {
  admins.sa = await adminAuthService.createAdmin({ fullName: 'Sana Admin', email: 'super@college.edu', password: PW, role: 'super_admin' });
  admins.officer = await adminAuthService.createAdmin({ fullName: 'Omkar Officer', email: 'officer@college.edu', password: PW, role: 'admission_officer' });
  admins.viewer = await adminAuthService.createAdmin({ fullName: 'Vaidehi Viewer', email: 'viewer@college.edu', password: PW, role: 'viewer' });
  await adminAuthService.createAdmin({ fullName: 'Old Admin', email: 'old@college.edu', password: PW, role: 'viewer' });
  db.prepare("UPDATE admins SET is_active = 0 WHERE email = 'old@college.edu'").run();
  await assert.rejects(() => adminAuthService.createAdmin({ fullName: 'X', email: 'weak@college.edu', password: 'short1', role: 'viewer' }), /at least 10/);
  await assert.rejects(() => adminAuthService.createAdmin({ fullName: 'X', email: 'SUPER@college.edu', password: PW, role: 'viewer' }), /already exists/);
  await assert.rejects(() => adminAuthService.createAdmin({ fullName: 'X', email: 'x@college.edu', password: PW, role: 'god' }), /Role must be/);
});

// ---------------------------------------------------------------------------
// 1. Admin authentication & protected routes
test('admin API and admin pages are protected when not logged in', async () => {
  for (const [m, u] of [['GET', '/api/admin/auth/me'], ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/students'], ['GET', '/api/admin/students/1'],
    ['GET', '/api/admin/appointments'], ['GET', '/api/admin/activity'], ['POST', '/api/admin/appointments'], ['POST', '/api/admin/students/1/review'], ['PUT', '/api/admin/students/1/verification']]) {
    const r = await call(m, u, m === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${m} ${u}`);
    assert.equal(r.json.code, 'UNAUTHENTICATED');
  }
  for (const page of ['dashboard.html', 'students.html', 'student.html', 'appointments.html', 'activity.html']) {
    const r = await call('GET', `/admin/${page}`);
    assert.equal(r.status, 302, page);
    assert.match(r.location, /^\/admin\/login\.html\?next=/);
  }
  assert.equal((await call('GET', '/admin/')).status, 302);
  const login = await fetch(`${base}/admin/login.html`);
  assert.equal(login.status, 200);
});

test('admin login: validation, wrong credentials give one generic message, cookie flags', async () => {
  const bad = await call('POST', '/api/admin/auth/login', { email: 'nope', password: '' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.email && bad.json.errors.password);

  const a = await call('POST', '/api/admin/auth/login', { email: 'super@college.edu', password: 'WrongPass123' });
  const b = await call('POST', '/api/admin/auth/login', { email: 'ghost@college.edu', password: 'WrongPass123' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.json.message, b.json.message);

  // a student account is not an admin account
  const stu = await makeStudent('Login Probe', { cap: false });
  assert.equal((await call('POST', '/api/admin/auth/login', { email: stu.email, password: 'Passw0rd123' })).status, 401);

  const ok = await call('POST', '/api/admin/auth/login', { email: 'SUPER@college.edu', password: PW });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /^admitflow_admin_sid=/);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  assert.equal(ok.json.data.admin.role, 'super_admin');
  assert.equal(ok.json.data.admin.password_hash, undefined);
  assert.equal(ok.json.data.admin.passwordHash, undefined);
  sidOf.sa = ok.cookie;
  sidOf.officer = await adminLogin('officer@college.edu');
  sidOf.viewer = await adminLogin('viewer@college.edu');

  const me = await call('GET', '/api/admin/auth/me', undefined, sidOf.viewer);
  assert.equal(me.json.data.admin.role, 'viewer');
  assert.ok(!me.json.data.admin.permissions.includes('applications:review'));
  assert.ok(!JSON.stringify(me.json).includes('scrypt'));
  assert.ok(!JSON.stringify(me.json).match(/[0-9a-f]{64}:/));
});

test('inactive admins cannot log in, and deactivating kills an existing session', async () => {
  assert.equal((await call('POST', '/api/admin/auth/login', { email: 'old@college.edu', password: PW })).status, 401);
  const tmp = await adminAuthService.createAdmin({ fullName: 'Temp Viewer', email: 'temp@college.edu', password: PW, role: 'viewer' });
  const cookie = await adminLogin('temp@college.edu');
  assert.equal((await call('GET', '/api/admin/dashboard', undefined, cookie)).status, 200);
  db.prepare('UPDATE admins SET is_active = 0 WHERE id = ?').run(tmp.id);
  assert.equal((await call('GET', '/api/admin/dashboard', undefined, cookie)).status, 401);
});

test('repeated failed logins are rate limited, even for the right password afterwards', async () => {
  await adminAuthService.createAdmin({ fullName: 'Lock Test', email: 'lock@college.edu', password: PW, role: 'viewer' });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call('POST', '/api/admin/auth/login', { email: 'lock@college.edu', password: 'Wrong12345' })).status, 401);
  }
  const blocked = await call('POST', '/api/admin/auth/login', { email: 'lock@college.edu', password: PW });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.code, 'RATE_LIMITED');
  // other accounts are unaffected
  assert.equal((await call('POST', '/api/admin/auth/login', { email: 'viewer@college.edu', password: PW })).status, 200);
});

test('student and admin sessions are completely separate', async () => {
  s1 = await makeStudent('Alice Kulkarni');
  // a student cookie is useless on the admin API
  for (const u of ['/api/admin/dashboard', '/api/admin/students', '/api/admin/auth/me']) {
    assert.equal((await call('GET', u, undefined, s1.cookie)).status, 401, u);
  }
  // an admin cookie is useless on the student API
  for (const u of ['/api/dashboard', '/api/auth/me', '/api/cap-details']) {
    assert.equal((await call('GET', u, undefined, sidOf.sa)).status, 401, u);
  }
  // student pages still work for students
  assert.equal((await call('GET', '/api/dashboard', undefined, s1.cookie)).status, 200);
  // admin page is reachable with an admin cookie but not with a student cookie
  assert.equal((await call('GET', '/admin/dashboard.html', undefined, sidOf.sa)).status, 200);
  assert.equal((await call('GET', '/admin/dashboard.html', undefined, s1.cookie)).status, 302);
});

test('role-based access control', async () => {
  const id = s1.id;
  // viewer: read-only
  for (const u of ['/api/admin/dashboard', '/api/admin/students', `/api/admin/students/${id}`, '/api/admin/appointments']) {
    assert.equal((await call('GET', u, undefined, sidOf.viewer)).status, 200, `viewer GET ${u}`);
  }
  const denied = [
    ['POST', `/api/admin/students/${id}/review`, { action: 'approve' }],
    ['POST', `/api/admin/students/${id}/notes`, { remarks: 'hello there' }],
    ['PUT', `/api/admin/students/${id}/verification`, { status: 'completed' }],
    ['POST', '/api/admin/appointments', apptBody(id)],
    ['PUT', '/api/admin/appointments/1', {}],
    ['PATCH', '/api/admin/appointments/1/status', { status: 'cancelled' }],
  ];
  for (const [m, u, b] of denied) {
    const r = await call(m, u, b, sidOf.viewer);
    assert.equal(r.status, 403, `viewer ${m} ${u}`);
    assert.equal(r.json.code, 'FORBIDDEN');
  }
  // the activity log is for super admins only
  assert.equal((await call('GET', '/api/admin/activity', undefined, sidOf.viewer)).status, 403);
  assert.equal((await call('GET', '/api/admin/activity', undefined, sidOf.officer)).status, 403);
  assert.equal((await call('GET', '/api/admin/activity', undefined, sidOf.sa)).status, 200);
  // nothing the viewer tried changed anything
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM application_reviews').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 0);
});

test('state-changing admin requests reject cross-site origins and non-JSON bodies', async () => {
  const cross = await call('POST', '/api/admin/auth/logout', {}, sidOf.viewer, { Origin: 'http://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.code, 'CSRF');
  const sameOrigin = await call('POST', `/api/admin/students/${s1.id}/notes`, { remarks: 'same origin note' }, sidOf.officer, { Origin: base });
  assert.equal(sameOrigin.status, 201);
  const text = await call('POST', `/api/admin/students/${s1.id}/notes`, 'remarks=hello+there+friend', sidOf.officer, { 'Content-Type': 'text/plain' });
  assert.equal(text.status, 415);
  // the viewer is still logged in (the blocked logout did nothing)
  assert.equal((await call('GET', '/api/admin/auth/me', undefined, sidOf.viewer)).status, 200);
});

// ---------------------------------------------------------------------------
// 2. Dashboard with real data
test('dashboard counts are computed from the database', async () => {
  s2 = await makeStudent('Bob Patil', { college: 'Government College of Engineering Aurangabad', round: 'Round 2' });
  s3 = await makeStudent('Carol Joshi');
  s4 = await makeStudent('Dev Shaikh');
  s5 = await makeStudent('Esha Pawar');
  noCap = await makeStudent('Farhan Khan', { cap: false });

  // review decisions by the officer
  assert.equal((await call('POST', `/api/admin/students/${s2.id}/review`, { action: 'approve' }, sidOf.officer)).status, 200);
  assert.equal((await call('POST', `/api/admin/students/${s3.id}/review`, { action: 'reject', remarks: 'Not eligible for this category' }, sidOf.officer)).status, 200);
  assert.equal((await call('POST', `/api/admin/students/${s4.id}/review`, { action: 'request_corrections', remarks: 'HSC marksheet is unclear' }, sidOf.officer)).status, 200);
  // s1 and s5 stay pending; verify s2 physically (approved + verified)
  assert.equal((await call('PUT', `/api/admin/students/${s2.id}/verification`, { status: 'completed', remarks: 'All matched' }, sidOf.officer)).status, 200);

  const d = (await call('GET', '/api/admin/dashboard', undefined, sidOf.viewer)).json.data;
  const sql = (q) => db.prepare(q).get().n;
  // students: Login Probe + Alice, Bob, Carol, Dev, Esha + Farhan = 7; the two without CAP details have no application yet
  assert.deepEqual(
    [d.stats.totalStudents, d.stats.applications, d.stats.notStarted, d.stats.pending, d.stats.approved, d.stats.rejected, d.stats.correctionRequested],
    [7, 5, 2, 2, 1, 1, 1]
  );
  assert.equal(d.stats.totalStudents, sql('SELECT COUNT(*) AS n FROM students'));
  assert.equal(d.stats.applications, sql('SELECT COUNT(*) AS n FROM cap_details'));
  assert.equal(d.stats.applications + d.stats.notStarted, d.stats.totalStudents);
  assert.equal(d.stats.pending + d.stats.approved + d.stats.rejected + d.stats.correctionRequested, d.stats.applications);
  // verification pending = applications not verified and not rejected: s1, s4, s5 (s2 verified, s3 rejected)
  assert.equal(d.stats.verificationPending, 3);
  assert.equal(d.stats.verificationUnscheduled, 3);
  assert.equal(d.recentActivity, null); // viewers do not get the audit log
  const sa = (await call('GET', '/api/admin/dashboard', undefined, sidOf.sa)).json.data;
  assert.ok(sa.recentActivity.length > 0);
});

// ---------------------------------------------------------------------------
// 3. Student management
test('student list: search, filters, sorting and pagination', async () => {
  const get = async (qs) => (await call('GET', `/api/admin/students${qs}`, undefined, sidOf.viewer)).json.data;

  const all = await get('?pageSize=50');
  assert.equal(all.total, 7);
  assert.ok(all.items.every((i) => i.passwordHash === undefined && i.password_hash === undefined));

  assert.deepEqual((await get('?search=bob')).items.map((i) => i.fullName), ['Bob Patil']);
  assert.deepEqual((await get(`?search=${s3.email}`)).items.map((i) => i.fullName), ['Carol Joshi']);
  assert.deepEqual((await get(`?search=${s4.appId.toLowerCase()}`)).items.map((i) => i.fullName), ['Dev Shaikh']);
  assert.deepEqual((await get('?search=aurangabad')).items.map((i) => i.fullName), ['Bob Patil']);
  assert.equal((await get('?search=%25')).total, 0, 'a literal % must not match everything');
  assert.equal((await get('?search=_')).total, 0, 'a literal _ must not match everything');
  assert.equal((await get("?search=' OR 1=1 --")).total, 0);

  assert.deepEqual((await get('?status=approved')).items.map((i) => i.fullName), ['Bob Patil']);
  assert.deepEqual((await get('?status=rejected')).items.map((i) => i.fullName), ['Carol Joshi']);
  assert.deepEqual((await get('?status=correction_requested')).items.map((i) => i.fullName), ['Dev Shaikh']);
  assert.equal((await get('?status=pending')).total, 2);
  assert.deepEqual((await get('?status=not_started&pageSize=50')).items.map((i) => i.fullName).sort(), ['Farhan Khan', 'Login Probe']);
  assert.equal((await get('?verification=completed')).total, 1);
  assert.equal((await get('?verification=awaiting')).total, 3);
  assert.equal((await get('?round=Round%202')).total, 1);
  assert.equal((await get('?status=pending&verification=awaiting&round=Round%201')).total, 2);
  assert.equal((await get('?status=bogus')).total, 7, 'unknown filter values are ignored');

  const p1 = await get('?pageSize=3&page=1&sort=name');
  const p3 = await get('?pageSize=3&page=3&sort=name');
  assert.equal(p1.items.length, 3);
  assert.equal(p1.totalPages, 3);
  assert.equal(p3.items.length, 1);
  assert.deepEqual(p1.items.map((i) => i.fullName), [...p1.items.map((i) => i.fullName)].sort((a, b) => a.localeCompare(b)));
  assert.equal(p1.items.concat((await get('?pageSize=3&page=2&sort=name')).items, p3.items).length, 7);

  const alice = all.items.find((i) => i.fullName === 'Alice Kulkarni');
  assert.equal(alice.reviewStatus, 'pending');
  assert.equal(alice.progress.total, 6);
  assert.equal(all.items.find((i) => i.fullName === 'Farhan Khan').reviewStatus, 'not_started');
});

test('student detail shows the full application and never the password hash', async () => {
  // give Alice some task data through the STUDENT portal so we can check the admin sees the same records
  await call('PUT', '/api/tasks/fee_payment', { status: 'in_progress', totalFee: '100000', amountPaid: '40000', paymentMode: 'Demand Draft', receiptNumber: 'DD-9911', paidOn: time.today() }, s1.cookie);
  await call('PUT', '/api/tasks/document_preparation', { preparedDocs: ['ssc_marksheet', 'photo_id'] }, s1.cookie);

  const r = await call('GET', `/api/admin/students/${s1.id}`, undefined, sidOf.viewer);
  assert.equal(r.status, 200);
  const d = r.json.data;
  assert.equal(d.student.fullName, 'Alice Kulkarni');
  assert.equal(d.cap.applicationId, s1.appId);
  assert.equal(d.fee.amountPaid, 40000);
  assert.equal(d.fee.receiptNumber, 'DD-9911');
  assert.equal(d.documents.filter((x) => x.prepared).length, 2);
  assert.equal(d.tasks.find((t) => t.key === 'fee_payment').status, 'in_progress');
  assert.equal(d.review.status, 'pending');
  assert.equal(d.verification.status, 'pending');
  assert.equal(d.appointment, null);
  assert.ok(!JSON.stringify(d).includes('password'));

  assert.equal((await call('GET', '/api/admin/students/99999', undefined, sidOf.viewer)).status, 404);
  assert.equal((await call('GET', '/api/admin/students/abc', undefined, sidOf.viewer)).status, 404);
  assert.equal((await call('GET', '/api/admin/students/1;DROP', undefined, sidOf.viewer)).status, 404);
  const none = await call('GET', `/api/admin/students/${noCap.id}`, undefined, sidOf.viewer);
  assert.equal(none.json.data.hasApplication, false);
  assert.equal(none.json.data.review.status, 'not_started');
});

// ---------------------------------------------------------------------------
// 4. Application review
test('review: validation rules', async () => {
  const post = (id, b, cookie = sidOf.officer) => call('POST', `/api/admin/students/${id}/review`, b, cookie);
  assert.ok((await post(s1.id, {})).json.errors.action);
  assert.ok((await post(s1.id, { action: 'delete' })).json.errors.action);
  assert.ok((await post(s1.id, { action: 'reject' })).json.errors.remarks);
  assert.ok((await post(s1.id, { action: 'reject', remarks: 'no' })).json.errors.remarks);
  assert.ok((await post(s1.id, { action: 'request_corrections', remarks: '   ' })).json.errors.remarks);
  assert.ok((await post(s1.id, { action: 'approve', remarks: 'x'.repeat(1001) })).json.errors.remarks);
  const noApp = await post(noCap.id, { action: 'approve' });
  assert.equal(noApp.status, 409);
  assert.equal(noApp.json.code, 'NO_APPLICATION');
  assert.equal((await post(99999, { action: 'approve' })).status, 404);
  // nothing was written by any of the rejected attempts
  assert.equal(db.prepare('SELECT status FROM application_reviews WHERE student_id = ?').get(s1.id), undefined);
});

test('review: decisions, status history, duplicate and stale protection', async () => {
  const post = (b) => call('POST', `/api/admin/students/${s5.id}/review`, b, sidOf.officer);

  const corr = await post({ action: 'request_corrections', remarks: 'Upload a clearer photo ID' });
  assert.equal(corr.status, 200);
  assert.equal(corr.json.data.review.status, 'correction_requested');
  assert.equal(corr.json.data.review.reviewedBy, 'Omkar Officer');

  const dup = await post({ action: 'request_corrections', remarks: 'Upload a clearer photo ID' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'NO_CHANGE');

  const stale = await post({ action: 'approve', expectedStatus: 'pending' }); // page was loaded before the change above
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'STALE_STATUS');
  assert.equal(db.prepare('SELECT status FROM application_reviews WHERE student_id = ?').get(s5.id).status, 'correction_requested');

  const ok = await post({ action: 'approve', remarks: 'Corrections received', expectedStatus: 'correction_requested' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.review.status, 'approved');

  const reopen = await post({ action: 'reopen' });
  assert.equal(reopen.status, 400, 'reopening needs a reason');
  assert.equal((await post({ action: 'reopen', remarks: 'Approved by mistake' })).json.data.review.status, 'pending');

  const history = (await call('GET', `/api/admin/students/${s5.id}`, undefined, sidOf.viewer)).json.data.history;
  assert.deepEqual(history.map((h) => h.toStatus), ['pending', 'approved', 'correction_requested']); // newest first
  assert.deepEqual(history.map((h) => h.fromStatus), ['approved', 'correction_requested', 'pending']);
  assert.ok(history.every((h) => h.actorName === 'Omkar Officer' && h.createdAt));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM application_reviews WHERE student_id = ?').get(s5.id).n, 1, 'one review row per student');
});

test('internal notes are stored in the history but are not shown to the student', async () => {
  const note = await call('POST', `/api/admin/students/${s5.id}/notes`, { remarks: 'Parent called, will bring documents Monday' }, sidOf.officer);
  assert.equal(note.status, 201);
  assert.equal(note.json.data.history[0].type, 'remark');
  assert.equal((await call('POST', `/api/admin/students/${s5.id}/notes`, { remarks: 'x' }, sidOf.officer)).status, 400);
  assert.equal((await call('POST', `/api/admin/students/${noCap.id}/notes`, { remarks: 'valid note' }, sidOf.officer)).status, 409);
  const dash = (await call('GET', '/api/dashboard', undefined, s5.cookie)).json.data;
  assert.ok(!JSON.stringify(dash).includes('Parent called'));
});

// ---------------------------------------------------------------------------
// 5. Student <-> admin synchronisation
test('admin decisions appear on the student dashboard (and only the right student sees them)', async () => {
  const bob = (await call('GET', '/api/dashboard', undefined, s2.cookie)).json.data;
  assert.equal(bob.application.status, 'approved');
  assert.equal(bob.overallStatus, 'Admission Approved');
  assert.equal(bob.tasks.find((t) => t.key === 'physical_verification').status, 'completed');
  assert.equal(bob.tasks.find((t) => t.key === 'physical_verification').summary.startsWith('Verified on'), true);

  const carol = (await call('GET', '/api/dashboard', undefined, s3.cookie)).json.data;
  assert.equal(carol.application.status, 'rejected');
  assert.equal(carol.application.remarks, 'Not eligible for this category');
  assert.equal(carol.overallStatus, 'Application Rejected');
  assert.equal(carol.application.history[0].by, 'College'); // the admin's name is not exposed to students
  assert.ok(!JSON.stringify(carol).includes('Omkar'));

  const dev = (await call('GET', '/api/dashboard', undefined, s4.cookie)).json.data;
  assert.equal(dev.application.status, 'correction_requested');
  assert.equal(dev.application.canResubmit, true);
  assert.equal(dev.overallStatus, 'Corrections Requested');

  const alice = (await call('GET', '/api/dashboard', undefined, s1.cookie)).json.data;
  assert.equal(alice.application.status, 'pending');
  assert.equal(alice.application.remarks, null);
  assert.equal(alice.overallStatus, 'In Progress');
  // students who have no CAP details have no application block
  const farhan = (await call('GET', '/api/dashboard', undefined, noCap.cookie)).json.data;
  assert.equal(farhan.application, null);
  assert.equal(farhan.overallStatus, 'Getting Started');
});

test('a student can mark requested corrections as done, which re-queues the application', async () => {
  assert.equal((await call('POST', '/api/application/resubmit', {}, s1.cookie)).status, 409);
  assert.equal((await call('POST', '/api/application/resubmit', {})).status, 401);
  assert.equal((await call('POST', '/api/application/resubmit', { note: 'x'.repeat(301) }, s4.cookie)).status, 400);
  const ok = await call('POST', '/api/application/resubmit', { note: 'Uploaded a clear marksheet scan' }, s4.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.application.status, 'pending');
  assert.equal((await call('POST', '/api/application/resubmit', {}, s4.cookie)).status, 409);

  const detail = (await call('GET', `/api/admin/students/${s4.id}`, undefined, sidOf.viewer)).json.data;
  assert.equal(detail.review.status, 'pending');
  assert.equal(detail.history[0].actorType, 'student');
  assert.equal(detail.history[0].remarks, 'Uploaded a clear marksheet scan');
  // and the admin dashboard numbers moved with it
  const stats = (await call('GET', '/api/admin/dashboard', undefined, sidOf.viewer)).json.data.stats;
  assert.equal(stats.correctionRequested, 0);
  assert.equal(stats.pending, 3);
});

test('admin updates do not alter what the student entered', async () => {
  const fee = (await call('GET', '/api/tasks/fee_payment', undefined, s1.cookie)).json.data;
  assert.equal(fee.details.amountPaid, 40000);
  assert.equal(fee.task.status, 'in_progress');
  const cap = (await call('GET', '/api/cap-details', undefined, s1.cookie)).json.data.capDetails;
  assert.equal(cap.applicationId, s1.appId);
});

// ---------------------------------------------------------------------------
// 6. Appointments
test('appointments: validation', async () => {
  const post = (b) => call('POST', '/api/admin/appointments', b, sidOf.officer);
  const empty = await post({});
  for (const f of ['studentId', 'date', 'time', 'venue']) assert.ok(empty.json.errors[f], f);
  assert.ok((await post(apptBody(s1.id, { date: time.addDays(-1) }))).json.errors.date, 'past date');
  assert.ok((await post(apptBody(s1.id, { date: '2026-02-30' }))).json.errors.date, 'impossible date');
  assert.ok((await post(apptBody(s1.id, { date: 'tomorrow' }))).json.errors.date);
  assert.ok((await post(apptBody(s1.id, { date: time.addDays(400) }))).json.errors.date, 'too far ahead');
  assert.ok((await post(apptBody(s1.id, { time: '25:00' }))).json.errors.time);
  assert.ok((await post(apptBody(s1.id, { time: '9:30' }))).json.errors.time);
  assert.ok((await post(apptBody(s1.id, { venue: 'ab' }))).json.errors.venue);
  assert.ok((await post(apptBody(s1.id, { instructions: 'x'.repeat(301) }))).json.errors.instructions);
  if (time.nowTime() > '00:01') assert.ok((await post(apptBody(s1.id, { date: time.today(), time: '00:01' }))).json.errors.time, 'earlier today');
  assert.equal((await post(apptBody(99999))).status, 404);
  assert.equal((await post(apptBody(noCap.id))).json.code, 'NO_APPLICATION');
  assert.equal((await post(apptBody(s3.id))).json.code, 'APPLICATION_REJECTED');
  assert.equal((await post(apptBody(s2.id))).json.code, 'ALREADY_VERIFIED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 0, 'rejected requests created nothing');
});

test('appointments: schedule, duplicate protection and the student view', async () => {
  const ok = await call('POST', '/api/admin/appointments', apptBody(s1.id), sidOf.officer);
  assert.equal(ok.status, 201);
  const appt = ok.json.data.appointment;
  assert.equal(appt.status, 'scheduled');
  assert.equal(appt.createdBy, 'Omkar Officer');
  assert.equal(ok.json.data.student.appointment.id, appt.id);

  const dup = await call('POST', '/api/admin/appointments', apptBody(s1.id, { time: '14:00' }), sidOf.sa);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'ALREADY_SCHEDULED');

  // the database itself refuses a second active appointment, even if the application layer were bypassed
  assert.throws(
    () => db.prepare("INSERT INTO appointments (student_id, appointment_date, appointment_time, venue, created_by_name, updated_by_name) VALUES (?, ?, '09:00', 'Somewhere', 'x', 'x')").run(s1.id, tomorrow()),
    /UNIQUE/
  );

  // synchronisation: the student sees it on the dashboard and in the verification task window
  const dash = (await call('GET', '/api/dashboard', undefined, s1.cookie)).json.data;
  assert.equal(dash.appointment.date, tomorrow());
  assert.equal(dash.appointment.time, '10:30');
  assert.equal(dash.appointment.venue, 'Admission Cell, Room 12');
  assert.equal(dash.appointment.status, 'scheduled');
  assert.equal(JSON.stringify(dash).includes('Omkar'), false);
  const task = (await call('GET', '/api/tasks/physical_verification', undefined, s1.cookie)).json.data;
  assert.equal(task.details.appointment.venue, 'Admission Cell, Room 12');
  // other students do not
  assert.equal((await call('GET', '/api/dashboard', undefined, s5.cookie)).json.data.appointment, null);
  // students still cannot touch verification
  assert.equal((await call('PUT', '/api/tasks/physical_verification', { status: 'completed' }, s1.cookie)).status, 403);
  s1.apptId = appt.id;
});

test('two simultaneous "schedule" requests create exactly one appointment', async () => {
  const body = apptBody(s5.id);
  const [a, b] = await Promise.all([
    call('POST', '/api/admin/appointments', body, sidOf.officer),
    call('POST', '/api/admin/appointments', { ...body, time: '11:00' }, sidOf.sa),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE student_id = ? AND status = 'scheduled'").get(s5.id).n, 1);
});

test('appointments: reschedule', async () => {
  const put = (id, b, cookie = sidOf.officer) => call('PUT', `/api/admin/appointments/${id}`, b, cookie);
  const newDay = time.addDays(3);
  assert.ok((await put(s1.apptId, apptBody(s1.id, { date: newDay }))).json.errors.reason, 'reason is required');
  assert.ok((await put(s1.apptId, { ...apptBody(s1.id, { date: newDay }), reason: 'ab' })).json.errors.reason);
  assert.equal((await put(s1.apptId, { ...apptBody(s1.id), reason: 'Same slot' })).status, 400, 'no-op reschedule is rejected');
  assert.equal((await put(99999, { ...apptBody(s1.id), reason: 'Does not exist' })).status, 404);
  assert.ok((await put(s1.apptId, { ...apptBody(s1.id, { date: time.addDays(-2) }), reason: 'Past date' })).json.errors.date);

  const ok = await put(s1.apptId, { ...apptBody(s1.id, { date: newDay, time: '15:15', venue: 'Library Seminar Hall' }), reason: 'Hall unavailable on the original day' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.appointment.date, newDay);
  assert.equal(ok.json.data.appointment.rescheduleCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE student_id = ?').get(s1.id).n, 1, 'rescheduling updates the same record');

  const dash = (await call('GET', '/api/dashboard', undefined, s1.cookie)).json.data;
  assert.equal(dash.appointment.date, newDay);
  assert.equal(dash.appointment.time, '15:15');
  assert.equal(dash.appointment.venue, 'Library Seminar Hall');
  assert.equal(dash.appointment.rescheduled, true);
  assert.equal(dash.appointment.note, 'Hall unavailable on the original day');
});

test('appointments: status updates and rescheduling after a missed visit', async () => {
  const patch = (id, b, cookie = sidOf.officer) => call('PATCH', `/api/admin/appointments/${id}/status`, b, cookie);
  assert.ok((await patch(s1.apptId, { status: 'scheduled' })).json.errors.status);
  assert.ok((await patch(s1.apptId, { status: 'cancelled' })).json.errors.note, 'cancelling needs a reason');
  const early = await patch(s1.apptId, { status: 'completed' });
  assert.equal(early.status, 409);
  assert.equal(early.json.code, 'TOO_EARLY');
  assert.equal((await patch(s1.apptId, { status: 'missed' })).json.code, 'TOO_EARLY');

  // pretend the appointment day has arrived and the student did not turn up
  db.prepare('UPDATE appointments SET appointment_date = ? WHERE id = ?').run(time.addDays(-1), s1.apptId);
  const missed = await patch(s1.apptId, { status: 'missed', note: 'Did not attend' });
  assert.equal(missed.status, 200);
  assert.equal(missed.json.data.appointment.status, 'missed');
  assert.equal(missed.json.data.student.appointment, null, 'no active appointment any more');
  assert.equal((await patch(s1.apptId, { status: 'completed' })).json.code, 'NOT_SCHEDULED', 'ended appointments are final');
  assert.equal((await call('PUT', `/api/admin/appointments/${s1.apptId}`, { ...apptBody(s1.id), reason: 'Try again' }, sidOf.officer)).json.code, 'NOT_SCHEDULED');

  // the student sees the missed visit, and a fresh appointment can now be scheduled
  assert.equal((await call('GET', '/api/dashboard', undefined, s1.cookie)).json.data.appointment.status, 'missed');
  const again = await call('POST', '/api/admin/appointments', apptBody(s1.id, { date: time.addDays(5), time: '11:45' }), sidOf.officer);
  assert.equal(again.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE student_id = ?').get(s1.id).n, 2, 'history keeps both appointments');
  const dash = (await call('GET', '/api/dashboard', undefined, s1.cookie)).json.data;
  assert.equal(dash.appointment.status, 'scheduled');
  assert.equal(dash.appointment.time, '11:45');
  s1.apptId = again.json.data.appointment.id;

  // cancel with a reason, then schedule again
  const cancelled = await patch(s1.apptId, { status: 'cancelled', note: 'College closed that day' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.data.appointment.note, 'College closed that day');
  const third = await call('POST', '/api/admin/appointments', apptBody(s1.id, { date: time.addDays(6) }), sidOf.officer);
  assert.equal(third.status, 201);
  s1.apptId = third.json.data.appointment.id;
});

test('appointment list: filters, counts and search', async () => {
  const get = async (qs) => (await call('GET', `/api/admin/appointments${qs}`, undefined, sidOf.viewer)).json.data;
  const all = await get('');
  assert.equal(all.total, db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n);
  const scheduled = await get('?status=scheduled');
  assert.ok(scheduled.items.every((a) => a.status === 'scheduled'));
  assert.equal(scheduled.total, 2); // alice + esha
  assert.deepEqual(scheduled.items.map((a) => a.date), [...scheduled.items.map((a) => a.date)].sort());
  assert.equal(all.counts.scheduled, 2);
  assert.equal(all.counts.missed, 1);
  assert.equal(all.counts.cancelled, 1);
  assert.equal((await get('?search=alice')).total, 3);
  assert.equal((await get('?status=missed&search=alice')).total, 1);
  assert.equal((await get(`?date=${time.addDays(6)}`)).total, 1);
  assert.equal((await get('?status=nonsense')).total, all.total, 'unknown status is ignored');
  assert.ok(scheduled.items[0].student.name && scheduled.items[0].student.applicationId);
  const dash = (await call('GET', '/api/admin/dashboard', undefined, sidOf.viewer)).json.data;
  assert.equal(dash.upcomingAppointments.length, 2);
  assert.equal(dash.stats.verificationUnscheduled, dash.stats.verificationPending - 2);
});

// ---------------------------------------------------------------------------
// 7. Recording the manual verification outcome
test('verification outcome: validation, student sync, and appointment is closed automatically', async () => {
  const put = (id, b, cookie = sidOf.officer) => call('PUT', `/api/admin/students/${id}/verification`, b, cookie);
  assert.ok((await put(s1.id, {})).json.errors.status);
  assert.ok((await put(s1.id, { status: 'maybe' })).json.errors.status);
  assert.ok((await put(s1.id, { status: 'pending' })).json.errors.remarks);
  assert.ok((await put(s1.id, { status: 'completed', remarks: 'x'.repeat(301) })).json.errors.remarks);
  assert.equal((await put(noCap.id, { status: 'completed' })).json.code, 'NO_APPLICATION');
  assert.equal((await put(s3.id, { status: 'completed' })).json.code, 'APPLICATION_REJECTED');

  const prog = await put(s1.id, { status: 'in_progress', remarks: 'Checking originals' });
  assert.equal(prog.status, 200);
  assert.equal((await call('GET', '/api/dashboard', undefined, s1.cookie)).json.data.tasks.find((t) => t.key === 'physical_verification').status, 'in_progress');
  assert.equal(db.prepare("SELECT status FROM appointments WHERE id = ?").get(s1.apptId).status, 'scheduled');

  const done = await put(s1.id, { status: 'completed', remarks: 'All originals matched' });
  assert.equal(done.status, 200);
  assert.equal(done.json.data.verification.verifiedBy, 'Omkar Officer');
  assert.equal(done.json.data.verification.verifiedAt, time.today());
  assert.equal(done.json.data.appointment, null);
  assert.equal(db.prepare('SELECT status FROM appointments WHERE id = ?').get(s1.apptId).status, 'completed');

  const task = (await call('GET', '/api/tasks/physical_verification', undefined, s1.cookie)).json.data;
  assert.equal(task.task.status, 'completed');
  assert.equal(task.task.statusLabel, 'Verified at College');
  assert.equal(task.details.verifiedBy, 'Omkar Officer');
  assert.equal(task.details.remarks, 'All originals matched');
  assert.equal(task.details.appointment.status, 'completed');

  assert.equal((await put(s1.id, { status: 'completed', remarks: 'All originals matched' })).json.code, 'NO_CHANGE');
  assert.equal((await call('POST', '/api/admin/appointments', apptBody(s1.id), sidOf.officer)).json.code, 'ALREADY_VERIFIED');
  // students still cannot change it
  assert.equal((await call('PUT', '/api/tasks/physical_verification', { status: 'pending' }, s1.cookie)).status, 403);

  const stats = (await call('GET', '/api/admin/dashboard', undefined, sidOf.viewer)).json.data.stats;
  assert.equal(stats.verificationPending, 2); // s4 and s5 (s1, s2 verified; s3 rejected)
});

// ---------------------------------------------------------------------------
// 8. Activity history
test('activity history records who did what and when', async () => {
  const r = await call('GET', '/api/admin/activity?pageSize=100', undefined, sidOf.sa);
  assert.equal(r.status, 200);
  const items = r.json.data.items;
  assert.ok(items.length >= 20);
  assert.ok(items.every((i) => i.admin.name && i.admin.role && i.createdAt && i.summary));
  assert.deepEqual(items.map((i) => i.id), [...items.map((i) => i.id)].sort((a, b) => b - a), 'newest first');
  const actions = new Set(items.map((i) => i.action));
  for (const a of ['auth.login', 'application.approve', 'application.reject', 'application.request_corrections', 'application.reopen', 'application.note',
    'appointment.schedule', 'appointment.reschedule', 'appointment.missed', 'appointment.cancelled', 'appointment.completed', 'verification.record']) {
    assert.ok(actions.has(a), `missing ${a}`);
  }
  const approve = items.find((i) => i.action === 'application.approve' && i.student.name === 'Bob Patil');
  assert.equal(approve.admin.name, 'Omkar Officer');
  assert.equal(approve.admin.role, 'admission_officer');
  assert.deepEqual([approve.details.from, approve.details.to], ['pending', 'approved']);
  const resched = items.find((i) => i.action === 'appointment.reschedule');
  assert.equal(resched.details.reason, 'Hall unavailable on the original day');
  assert.equal(resched.details.to.venue, 'Library Seminar Hall');
  assert.match(approve.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // filters
  const byAdmin = (await call('GET', `/api/admin/activity?adminId=${admins.officer.id}&pageSize=100`, undefined, sidOf.sa)).json.data;
  assert.ok(byAdmin.items.length > 0 && byAdmin.items.every((i) => i.admin.id === admins.officer.id));
  const byGroup = (await call('GET', '/api/admin/activity?group=appointment&pageSize=100', undefined, sidOf.sa)).json.data;
  assert.ok(byGroup.items.length > 0 && byGroup.items.every((i) => i.action.startsWith('appointment.')));
  const byStudent = (await call('GET', `/api/admin/activity?studentId=${s3.id}`, undefined, sidOf.sa)).json.data;
  assert.ok(byStudent.items.every((i) => i.student.id === s3.id));
  assert.equal((await call('GET', '/api/admin/activity?search=%25', undefined, sidOf.sa)).json.data.total, 0);
  const paged = (await call('GET', '/api/admin/activity?pageSize=5&page=2', undefined, sidOf.sa)).json.data;
  assert.equal(paged.items.length, 5);
  assert.ok(paged.totalPages > 1);
  assert.ok(paged.admins.length >= 3);
});

test('failed or rejected actions leave no audit entry; logout is recorded', async () => {
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM admin_activity_log').get().n;
  const before = count();
  await call('POST', `/api/admin/students/${s5.id}/review`, { action: 'reject' }, sidOf.officer); // 400
  await call('POST', `/api/admin/students/${noCap.id}/review`, { action: 'approve' }, sidOf.officer); // 409
  await call('POST', `/api/admin/students/${s5.id}/review`, { action: 'approve' }, sidOf.viewer); // 403
  assert.equal(count(), before);

  const cookie = await adminLogin('officer@college.edu');
  const out = await call('POST', '/api/admin/auth/logout', {}, cookie);
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await call('GET', '/api/admin/auth/me', undefined, cookie)).status, 401);
  const last = db.prepare('SELECT action, admin_name FROM admin_activity_log ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([last.action, last.admin_name], ['auth.logout', 'Omkar Officer']);
});

// ---------------------------------------------------------------------------
// 9. Persistence
test('everything is persisted in the SQLite file (read back through a fresh connection)', async () => {
  const fresh = new Database(DB_FILE, { readonly: true });
  try {
    assert.equal(fresh.prepare("SELECT status FROM application_reviews WHERE student_id = ?").get(s2.id).status, 'approved');
    assert.equal(fresh.prepare("SELECT status FROM application_reviews WHERE student_id = ?").get(s3.id).status, 'rejected');
    assert.ok(fresh.prepare('SELECT COUNT(*) AS n FROM application_status_history').get().n >= 8);
    assert.equal(fresh.prepare("SELECT COUNT(*) AS n FROM appointments WHERE student_id = ?").get(s1.id).n, 3);
    assert.equal(fresh.prepare("SELECT status, verified_by FROM verification_records WHERE student_id = ?").get(s1.id).verified_by, 'Omkar Officer');
    assert.ok(fresh.prepare('SELECT COUNT(*) AS n FROM admin_activity_log').get().n >= 20);
    // passwords are hashed and sessions store only hashes
    const a = fresh.prepare("SELECT password_hash FROM admins WHERE email = 'super@college.edu'").get();
    assert.ok(!a.password_hash.includes(PW));
    assert.match(a.password_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
    assert.ok(fresh.prepare('SELECT token_hash FROM admin_sessions').all().every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  } finally { fresh.close(); }
});

test('the student session cookie flags are unchanged by Phase 3', async () => {
  const r = await call('POST', '/api/auth/login', { email: s1.email, password: 'Passw0rd123' });
  assert.match(r.setCookie, /^admitflow_sid=/);
  assert.match(r.setCookie, /SameSite=Lax/);
});
