'use strict';
// End-to-end API test: Register -> Login -> CAP details -> Dashboard -> Checklist -> Logout.
// Run with: npm test   (uses a temporary SQLite file, never your real database)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const app = require('../app');

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

async function call(method, url, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
}

const alice = { fullName: 'Alice Kulkarni', email: 'Alice@Example.com', phone: '9876543210', password: 'Passw0rd123', confirmPassword: 'Passw0rd123' };
const cap = {
  applicationId: 'mh2026-12345', studentName: 'Alice Kulkarni', allottedCollege: 'College of Engineering Pune',
  courseBranch: 'Computer Engineering', capRound: 'Round 1', allotmentStatus: 'Allotted',
};
let sid;

test('registration validation errors', async () => {
  const r = await call('POST', '/api/auth/register', { fullName: '', email: 'bad', phone: '123', password: 'abc', confirmPassword: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.json.success, false);
  for (const f of ['fullName', 'email', 'phone', 'password', 'confirmPassword']) assert.ok(r.json.errors[f], `missing error for ${f}`);
});

test('malformed JSON body returns 400', async () => {
  const res = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(res.status, 400);
});

test('register succeeds, duplicate email (any case) is rejected', async () => {
  const ok = await call('POST', '/api/auth/register', alice);
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.student.email, 'alice@example.com');
  assert.equal(ok.json.data.student.password_hash, undefined);
  const dup = await call('POST', '/api/auth/register', { ...alice, email: 'ALICE@example.com' });
  assert.equal(dup.status, 409);
  assert.match(dup.json.message, /already exists/i);
});

test('protected routes require login', async () => {
  for (const [m, u] of [['GET', '/api/auth/me'], ['GET', '/api/dashboard'], ['GET', '/api/cap-details'], ['GET', '/api/checklist']]) {
    const r = await call(m, u);
    assert.equal(r.status, 401, `${m} ${u}`);
  }
});

test('login rejects wrong password and unknown email with the same message', async () => {
  const a = await call('POST', '/api/auth/login', { email: 'alice@example.com', password: 'WrongPass1' });
  const b = await call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'WrongPass1' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.json.message, b.json.message);
});

test('login succeeds and sets an HttpOnly session cookie', async () => {
  const r = await call('POST', '/api/auth/login', { email: 'alice@example.com', password: 'Passw0rd123' });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  sid = r.cookie;
  assert.ok(sid && sid.startsWith('admitflow_sid='));
  const me = await call('GET', '/api/auth/me', undefined, sid);
  assert.equal(me.status, 200);
  assert.equal(me.json.data.student.fullName, 'Alice Kulkarni');
});

test('dashboard before CAP details shows getting started', async () => {
  const r = await call('GET', '/api/dashboard', undefined, sid);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.cap, null);
  assert.equal(r.json.data.overallStatus, 'Getting Started');
  assert.equal(r.json.data.progress.total, 6);
  assert.equal(r.json.data.progress.completed, 0);
  assert.equal(r.json.data.nextStep.key, 'cap_details');
});

test('checklist is blocked until CAP details exist', async () => {
  const r = await call('GET', '/api/checklist', undefined, sid);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'CAP_DETAILS_REQUIRED');
  const p = await call('PATCH', '/api/checklist/admission_form', { status: 'completed' }, sid);
  assert.equal(p.status, 409);
});

test('CAP details validation and save', async () => {
  const bad = await call('PUT', '/api/cap-details', { ...cap, applicationId: '!!', capRound: 'Round 9', allotmentStatus: 'Nope', allottedCollege: '' }, sid);
  assert.equal(bad.status, 400);
  for (const f of ['applicationId', 'capRound', 'allotmentStatus', 'allottedCollege']) assert.ok(bad.json.errors[f], f);

  const empty = await call('GET', '/api/cap-details', undefined, sid);
  assert.equal(empty.json.data.capDetails, null);
  assert.ok(empty.json.data.options.capRounds.includes('Round 1'));

  const ok = await call('PUT', '/api/cap-details', cap, sid);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.capDetails.applicationId, 'MH2026-12345');

  const edit = await call('PUT', '/api/cap-details', { ...cap, capRound: 'Round 2' }, sid);
  assert.equal(edit.status, 200);
  assert.equal(edit.json.data.capDetails.capRound, 'Round 2');
});

test('application ID cannot be shared between accounts', async () => {
  const bob = { fullName: 'Bob Patil', email: 'bob@example.com', phone: '9123456780', password: 'Passw0rd123', confirmPassword: 'Passw0rd123' };
  assert.equal((await call('POST', '/api/auth/register', bob)).status, 201);
  const login = await call('POST', '/api/auth/login', { email: bob.email, password: bob.password });
  const r = await call('PUT', '/api/cap-details', { ...cap, studentName: 'Bob Patil' }, login.cookie);
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.applicationId);
  // Bob must not see Alice's data
  assert.equal((await call('GET', '/api/cap-details', undefined, login.cookie)).json.data.capDetails, null);
});

test('checklist read and update, progress reflected on dashboard', async () => {
  const list = await call('GET', '/api/checklist', undefined, sid);
  assert.equal(list.status, 200);
  assert.equal(list.json.data.items.length, 5);
  assert.ok(list.json.data.items.every((i) => i.status === 'pending'));

  const u1 = await call('PATCH', '/api/checklist/allotment_acceptance', { status: 'completed' }, sid);
  assert.equal(u1.status, 200);
  assert.equal(u1.json.data.item.statusLabel, 'Seat Accepted');
  const u2 = await call('PATCH', '/api/checklist/fee_payment', { status: 'in_progress' }, sid);
  assert.equal(u2.json.data.item.statusLabel, 'Partially Paid');

  assert.equal((await call('PATCH', '/api/checklist/nope', { status: 'completed' }, sid)).status, 404);
  assert.equal((await call('PATCH', '/api/checklist/admission_form', { status: 'bogus' }, sid)).status, 400);
  assert.equal((await call('PATCH', '/api/checklist/admission_form', {}, sid)).status, 400);

  const dash = await call('GET', '/api/dashboard', undefined, sid);
  const p = dash.json.data.progress;
  assert.equal(p.completed, 2);            // CAP details + allotment acceptance
  assert.equal(p.inProgress, 1);
  assert.equal(p.pending, 3);
  assert.equal(p.percent, 33);
  assert.equal(dash.json.data.nextStep.key, 'admission_form');
  assert.equal(dash.json.data.overallStatus, 'In Progress');
});

test('logout invalidates the session', async () => {
  const out = await call('POST', '/api/auth/logout', {}, sid);
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await call('GET', '/api/auth/me', undefined, sid)).status, 401);
  assert.equal((await call('GET', '/api/dashboard', undefined, sid)).status, 401);
});

test('unknown API route returns JSON 404', async () => {
  const r = await call('GET', '/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.json.success, false);
});
