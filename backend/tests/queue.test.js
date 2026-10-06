'use strict';
// Phase 4 tests: tokens, queues, priority, lookup, counters, duplicate prevention, no-show/completion,
// persistence (incl. rebuilding the C++ engine), admin/student synchronisation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-queue-test-'));
const DB_FILE = path.join(tmpDir, 'test.db');
process.env.DB_PATH = DB_FILE;
delete process.env.QUEUE_PRIORITY_BURST;   // default fairness burst = 3

const app = require('../app');
const db = require('../config/db');
const time = require('../utils/time');
const adminAuthService = require('../services/adminAuthService');
const queueService = require('../services/queueService');

let server; let base;
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
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + url, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  const sc = res.headers.get('set-cookie');
  return { status: res.status, json, cookie: sc ? sc.split(';')[0] : null };
}

const PW = 'AdminPass123';
const adm = {};
async function adminLogin(email) {
  const r = await call('POST', '/api/admin/auth/login', { email, password: PW });
  assert.equal(r.status, 200);
  return r.cookie;
}
const Q = (p) => `/api/admin/queue${p || ''}`;
const today = () => time.today();

let seq = 0;
/** Registers a student through the real API, enters CAP details and gives them an appointment (default: today). */
async function makeStudent(name, { round = 'Round 1', apptDate = today(), verification = null } = {}) {
  seq += 1;
  const email = `q${seq}@example.com`;
  assert.equal((await call('POST', '/api/auth/register', { fullName: name, email, phone: `97000000${String(seq).padStart(2, '0')}`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123' })).status, 201);
  const cookie = (await call('POST', '/api/auth/login', { email, password: 'Passw0rd123' })).cookie;
  const id = db.prepare('SELECT id FROM students WHERE email = ?').get(email).id;
  const appId = `MH2026-${5000 + seq}`;
  assert.equal((await call('PUT', '/api/cap-details', { applicationId: appId, studentName: name, allottedCollege: 'COEP', courseBranch: 'Computer', capRound: round, allotmentStatus: 'Allotted' }, cookie)).status, 200);
  let apptId = null;
  if (apptDate) {
    apptId = Number(db.prepare("INSERT INTO appointments (student_id, appointment_date, appointment_time, venue, created_by_name, updated_by_name) VALUES (?, ?, '10:00', 'Admission Cell', 'seed', 'seed')").run(id, apptDate).lastInsertRowid);
  }
  if (verification) db.prepare("INSERT INTO verification_records (student_id, status) VALUES (?, ?)").run(id, verification);
  return { id, email, cookie, appId, apptId, name };
}

const checkIn = (s, cookie = adm.officerC) => call('POST', Q('/check-in'), { studentId: s.id }, cookie);
const state = async (cookie = adm.officerC) => (await call('GET', Q(), undefined, cookie)).json.data;
const callNext = (counterId, cookie = adm.officerC) => call('POST', Q(`/counters/${counterId}/call-next`), {}, cookie);
const act = (tokenId, what, body = {}, cookie = adm.officerC) => call('POST', Q(`/tokens/${tokenId}/${what}`), body, cookie);
const order = async () => (await state()).waiting.map((t) => t.code);
/** Calls the next student at counter 1 and runs them through start + complete; returns the token code. */
async function serveNext(counterId = 1) {
  const c = await callNext(counterId);
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const { id, code } = c.json.data.token;
  assert.equal((await act(id, 'start')).status, 200);
  assert.equal((await act(id, 'complete')).status, 200);
  return code;
}

let counters;
test('setup: admins in three roles and the default counters', async () => {
  adm.sa = await adminAuthService.createAdmin({ fullName: 'Sana Admin', email: 'sa@college.edu', password: PW, role: 'super_admin' });
  adm.officer = await adminAuthService.createAdmin({ fullName: 'Omkar Officer', email: 'officer@college.edu', password: PW, role: 'admission_officer' });
  adm.viewer = await adminAuthService.createAdmin({ fullName: 'Vaidehi Viewer', email: 'viewer@college.edu', password: PW, role: 'viewer' });
  adm.saC = await adminLogin('sa@college.edu');
  adm.officerC = await adminLogin('officer@college.edu');
  adm.viewerC = await adminLogin('viewer@college.edu');
  const s = await state();
  counters = s.counters;
  assert.deepEqual(counters.map((c) => c.name), ['Counter 1', 'Counter 2']);
  assert.ok(counters.every((c) => c.isOpen && c.token === null));
  assert.equal(s.waiting.length, 0);
  assert.equal(s.policy.burst, 3);
});

// ------------------------------------------------------------------------------------------------
test('access control: viewers can look but not operate; only super admins add counters', async () => {
  assert.equal((await call('GET', Q())).status, 401);
  assert.equal((await call('GET', Q(), undefined, adm.viewerC)).status, 200);
  assert.equal((await call('GET', Q('/eligible'), undefined, adm.viewerC)).status, 200);
  for (const [m, u, b] of [['POST', Q('/check-in'), { studentId: 1 }], ['POST', Q('/counters/1/call-next'), {}], ['PATCH', Q('/counters/1'), { isOpen: false }],
    ['POST', Q('/tokens/1/start'), {}], ['POST', Q('/tokens/1/complete'), {}], ['POST', Q('/tokens/1/no-show'), {}], ['POST', Q('/tokens/1/cancel'), {}], ['POST', Q('/counters'), { name: 'X' }]]) {
    const r = await call(m, u, b, adm.viewerC);
    assert.equal(r.status, 403, `${m} ${u}`);
  }
  assert.equal((await call('POST', Q('/counters'), { name: 'Counter X' }, adm.officerC)).status, 403, 'officers cannot add counters');
  // a student session is not an admin session
  const stu = await makeStudent('Cookie Probe', { apptDate: null });
  assert.equal((await call('GET', Q(), undefined, stu.cookie)).status, 401);
  assert.equal((await call('GET', '/api/queue/my-token')).status, 401);
  assert.equal((await call('GET', '/api/queue/my-token', undefined, adm.officerC)).status, 401);
  assert.equal((await call('POST', Q('/check-in'), { studentId: 1 }, adm.officerC, { Origin: 'http://evil.example' })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_tokens').get().n, 0);
});

test('check-in eligibility rules', async () => {
  const none = await makeStudent('No Cap', { apptDate: null });
  db.prepare('DELETE FROM cap_details WHERE student_id = ?').run(none.id);
  const noAppt = await makeStudent('No Appointment', { apptDate: null });
  const later = await makeStudent('Appointment Tomorrow', { apptDate: time.addDays(1) });
  const rejected = await makeStudent('Rejected Student');
  const verified = await makeStudent('Verified Student', { verification: 'completed' });
  assert.equal((await call('POST', `/api/admin/students/${rejected.id}/review`, { action: 'reject', remarks: 'Not eligible for this seat' }, adm.officerC)).status, 200);

  const code = async (s) => { const r = await checkIn(s); return [r.status, r.json.code]; };
  assert.deepEqual(await code(none), [409, 'NO_APPLICATION']);
  assert.deepEqual(await code(noAppt), [409, 'NO_APPOINTMENT']);
  assert.deepEqual(await code(later), [409, 'NOT_TODAY']);
  assert.deepEqual(await code(rejected), [409, 'APPLICATION_REJECTED']);
  assert.deepEqual(await code(verified), [409, 'ALREADY_VERIFIED']);
  assert.equal((await call('POST', Q('/check-in'), { studentId: 99999 }, adm.officerC)).status, 404);
  assert.equal((await call('POST', Q('/check-in'), {}, adm.officerC)).status, 400);
  assert.equal((await call('POST', Q('/check-in'), { studentId: 'abc' }, adm.officerC)).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_tokens').get().n, 0, 'refused check-ins created nothing');
  // none of them are offered in the check-in picker
  assert.deepEqual((await call('GET', Q('/eligible?search=Student'), undefined, adm.officerC)).json.data.students, []);
});

// ------------------------------------------------------------------------------------------------
let alice; let bob; let carol; let dave; let erin; let frank;
test('token generation: unique, sequential, lane letter, persisted and logged', async () => {
  alice = await makeStudent('Alice Regular');                                   // Round 1 -> regular
  bob = await makeStudent('Bob Late', { round: 'Round 3' });                    // late round -> priority level 2
  carol = await makeStudent('Carol Returning', { verification: 'in_progress' }); // returning -> priority level 1
  const picker = (await call('GET', Q('/eligible'), undefined, adm.officerC)).json.data.students;
  assert.equal(picker.length, 3);
  assert.deepEqual(picker.find((p) => p.name === 'Carol Returning').level, 1);

  const a = await checkIn(alice);
  assert.equal(a.status, 201);
  assert.equal(a.json.data.token.code, 'R001');
  assert.equal(a.json.data.token.lane, 'regular');
  assert.equal(a.json.data.token.status, 'waiting');
  assert.equal(a.json.data.token.position, 1);
  const b = await checkIn(bob);
  assert.equal(b.json.data.token.code, 'P002');   // arrival number keeps counting across lanes
  assert.equal(b.json.data.token.lane, 'priority');
  assert.equal(b.json.data.token.level, 2);
  assert.match(b.json.data.token.priorityReason, /Late CAP round/);
  assert.equal(b.json.data.token.position, 1);
  const c = await checkIn(carol);
  assert.equal(c.json.data.token.code, 'P003');
  assert.equal(c.json.data.token.level, 1);
  assert.equal(c.json.data.token.position, 1, 'level 1 outranks level 2');

  const codes = [a, b, c].map((r) => r.json.data.token.code);
  assert.equal(new Set(codes).size, 3);
  const rows = db.prepare('SELECT token_code, token_number, status, issued_by_name, student_id, application_id FROM queue_tokens ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.token_code), ['R001', 'P002', 'P003']);
  assert.ok(rows.every((r) => r.status === 'waiting' && r.issued_by_name === 'Omkar Officer'));
  assert.equal(rows[0].application_id, alice.appId);
  const log = db.prepare("SELECT admin_name, student_name, summary FROM admin_activity_log WHERE action = 'queue.check_in' ORDER BY id").all();
  assert.equal(log.length, 3);
  assert.equal(log[1].admin_name, 'Omkar Officer');
  assert.equal(log[1].student_name, 'Bob Late');
  assert.match(log[1].summary, /P002/);
  // they have left the check-in picker
  assert.equal((await call('GET', Q('/eligible'), undefined, adm.officerC)).json.data.students.length, 0);
});

test('priority handling: queue order and positions', async () => {
  const s = await state();
  assert.deepEqual(s.waiting.map((t) => t.code), ['P003', 'P002', 'R001']);
  assert.deepEqual(s.waiting.map((t) => t.position), [1, 2, 3]);
  assert.deepEqual(s.waiting.map((t) => t.ahead), [0, 1, 2]);
  assert.equal(s.stats.priorityWaiting, 2);
  assert.equal(s.stats.regularWaiting, 1);
  assert.equal(s.stats.waiting, 3);
});

test('duplicate-token prevention: sequential, concurrent, database level, and after completion', async () => {
  const dup = await checkIn(alice);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'ALREADY_QUEUED');
  assert.match(dup.json.message, /R001/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_tokens').get().n, 3, 'no extra row');
  assert.equal((await state()).stats.issued, 3, 'no arrival number was burned');

  // two desks check the same student in at the same instant
  dave = await makeStudent('Dave Racer');
  const [x, y] = await Promise.all([checkIn(dave), checkIn(dave, adm.saC)]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM queue_tokens WHERE student_id = ?").get(dave.id).n, 1);

  // the database itself refuses a second active token and a second student on one counter
  assert.throws(() => db.prepare("INSERT INTO queue_tokens (queue_date, token_number, token_code, lane, priority_level, priority_reason, student_id, application_id, issued_by_name) VALUES (?, 99, 'R099', 'regular', 3, 'x', ?, 'MH-X', 'x')").run(today(), alice.id), /UNIQUE/);
});

test('FIFO within the regular lane and fairness between lanes', async () => {
  // currently waiting: P003 (L1), P002 (L2), R001 (alice), R004 (dave). Add priority arrivals to exercise the burst rule.
  erin = await makeStudent('Erin Priority', { round: 'Special Round' });
  frank = await makeStudent('Frank Priority', { round: 'Round 3' });
  await checkIn(erin);    // P005
  await checkIn(frank);   // P006
  const promised = await order();
  // 3 priority in a row (P003, P002, P005), then the oldest regular (R001), then priority P006, then R004
  assert.deepEqual(promised, ['P003', 'P002', 'P005', 'R001', 'P006', 'R004']);
  const served = [];
  for (let i = 0; i < 6; i += 1) served.push(await serveNext(1));
  assert.deepEqual(served, promised, 'the projected order is exactly the order students are called');
  const s = await state();
  assert.equal(s.stats.completed, 6);
  assert.equal(s.waiting.length, 0);
  assert.deepEqual(s.finished.map((t) => t.status), Array(6).fill('completed'));
});

test('a student who was served cannot be checked in again for the same appointment', async () => {
  const r = await checkIn(alice);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'ALREADY_SERVED');
});

// ------------------------------------------------------------------------------------------------
test('multiple counters share one queue; busy and closed counters are refused', async () => {
  const students = [];
  for (const n of ['Gita', 'Hari', 'Isha', 'Jay']) students.push(await makeStudent(`${n} Multi`));
  for (const s of students) assert.equal((await checkIn(s)).status, 201);
  const [c1, c2] = counters;

  const a = await callNext(c1.id);
  const b = await callNext(c2.id);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.json.data.token.code, b.json.data.token.code);
  assert.equal(a.json.data.token.counter.name, 'Counter 1');
  assert.equal(b.json.data.token.counter.name, 'Counter 2');
  assert.equal(a.json.data.token.status, 'called');
  assert.ok(a.json.data.token.calledAt);

  const busy = await callNext(c1.id);
  assert.equal(busy.status, 409);
  assert.equal(busy.json.code, 'COUNTER_BUSY');
  let s = await state();
  assert.equal(s.stats.called, 2);
  assert.equal(s.waiting.length, 2);
  assert.equal(s.counters[0].token.code, a.json.data.token.code);

  // a third counter, added by the super admin, immediately works
  const added = await call('POST', Q('/counters'), { name: 'Counter 3' }, adm.saC);
  assert.equal(added.status, 201);
  assert.equal((await call('POST', Q('/counters'), { name: 'counter 3' }, adm.saC)).status, 409, 'names are unique');
  assert.equal((await call('POST', Q('/counters'), { name: 'x' }, adm.saC)).status, 400);
  const c3 = added.json.data.counter;
  const c = await callNext(c3.id);
  assert.equal(c.status, 200);
  assert.ok(![a, b].some((r) => r.json.data.token.code === c.json.data.token.code), 'nobody is called twice');

  // closed counters cannot call
  assert.equal((await call('PATCH', Q(`/counters/${c3.id}`), { isOpen: true }, adm.officerC)).status, 409, 'already open');
  // finish everything at counters 1 and 2 so the later tests start clean
  for (const r of [a, b, c]) {
    const id = r.json.data.token.id;
    assert.equal((await act(id, 'start')).status, 200);
    assert.equal((await act(id, 'complete')).status, 200);
  }
  assert.equal((await serveNext(c1.id)) !== null, true);   // the last waiting student
  s = await state();
  assert.equal(s.waiting.length, 0);
  assert.equal(s.counters.length, 3);
  counters = s.counters;
});

test('closing a counter returns a called student to their original place', async () => {
  const [c1, c2] = counters;
  const people = [];
  for (const n of ['Kiran', 'Lata', 'Mohan']) people.push(await makeStudent(`${n} Return`));
  for (const p of people) await checkIn(p);
  const before = await order();
  const a = (await callNext(c1.id)).json.data.token;
  const b = (await callNext(c2.id)).json.data.token;
  assert.deepEqual((await order()), before.slice(2));

  // counter 1 is closed while its student was only called, not yet being served
  const close = await call('PATCH', Q(`/counters/${c1.id}`), { isOpen: false }, adm.officerC);
  assert.equal(close.status, 200);
  assert.deepEqual(close.json.data.returned, [a.code]);
  assert.equal(db.prepare('SELECT status, counter_id FROM queue_tokens WHERE id = ?').get(a.id).status, 'waiting');
  assert.equal(db.prepare('SELECT counter_id FROM queue_tokens WHERE id = ?').get(a.id).counter_id, null);
  assert.deepEqual((await order())[0], a.code, 'they are first again, not at the back');
  assert.equal((await callNext(c1.id)).json.code, 'COUNTER_CLOSED');

  // a counter that is serving someone cannot be closed
  await act(b.id, 'start');
  const refused = await call('PATCH', Q(`/counters/${c2.id}`), { isOpen: false }, adm.officerC);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'COUNTER_BUSY');
  await act(b.id, 'complete');
  assert.equal((await call('PATCH', Q(`/counters/${c1.id}`), { isOpen: true }, adm.officerC)).status, 200);
  assert.equal((await call('PATCH', Q(`/counters/${c1.id}`), { isOpen: 'yes' }, adm.officerC)).status, 400);
  // drain
  while ((await state()).waiting.length) await serveNext(c1.id);
});

// ------------------------------------------------------------------------------------------------
test('token lifecycle: invalid transitions, no-show, re-check-in goes to the back, cancel', async () => {
  const [c1, c2] = counters;
  const p = []; for (const n of ['Neha', 'Omi', 'Pia']) p.push(await makeStudent(`${n} Life`));
  const t = []; for (const s of p) t.push((await checkIn(s)).json.data.token);

  // cannot start/complete/no-show a student who was never called
  for (const w of ['start', 'complete', 'no-show']) assert.equal((await act(t[0].id, w)).status, 409, w);
  assert.equal((await act(99999, 'start')).status, 404);
  assert.equal((await act('abc', 'start')).status, 404);

  const called = (await callNext(c1.id)).json.data.token;
  assert.equal(called.code, t[0].code);
  assert.equal((await act(called.id, 'complete')).status, 409, 'must start first');
  const ns = await act(called.id, 'no-show', { note: 'Did not come to the counter' });
  assert.equal(ns.status, 200);
  assert.equal(ns.json.data.token.status, 'no_show');
  assert.equal(ns.json.data.token.finishReason, 'Did not come to the counter');
  assert.ok(ns.json.data.token.finishedAt);
  assert.equal((await state()).counters[0].token, null, 'the counter is free again');
  assert.equal((await act(called.id, 'no-show')).status, 409, 'already finished');

  // the no-show student may get a new token; it goes to the back so nobody is skipped
  const again = await checkIn(p[0]);
  assert.equal(again.status, 201);
  assert.notEqual(again.json.data.token.code, called.code);
  assert.deepEqual(await order(), [t[1].code, t[2].code, again.json.data.token.code]);
  assert.equal(again.json.data.token.position, 3);

  // cancel a waiting student
  const cancel = await act(t[1].id, 'cancel', { note: 'Left the campus' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.data.token.status, 'cancelled');
  assert.deepEqual(await order(), [t[2].code, again.json.data.token.code]);
  assert.equal((await call('GET', Q(`/lookup?token=${t[1].code}`), undefined, adm.officerC)).json.data.token.status, 'cancelled');

  // a student being served cannot be cancelled
  const next = (await callNext(c2.id)).json.data.token;
  await act(next.id, 'start');
  assert.equal((await act(next.id, 'cancel')).status, 409);
  assert.equal((await act(next.id, 'complete')).status, 200);
  while ((await state()).waiting.length) await serveNext(c1.id);
  const note = db.prepare("SELECT COUNT(*) AS n FROM admin_activity_log WHERE action IN ('queue.no_show','queue.cancel','queue.complete','queue.start','queue.call')").get().n;
  assert.ok(note >= 10);
});

test('lookup by token code and by application ID (active and finished tokens)', async () => {
  const s = await makeStudent('Quinn Lookup', { round: 'Round 3' });
  const t = (await checkIn(s)).json.data.token;
  const w = await makeStudent('Rhea Lookup');
  await checkIn(w);

  const byCode = await call('GET', Q(`/lookup?token=${t.code.toLowerCase()}`), undefined, adm.viewerC);
  assert.equal(byCode.status, 200);
  assert.equal(byCode.json.data.source, 'engine');
  assert.equal(byCode.json.data.token.student.name, 'Quinn Lookup');
  assert.equal(byCode.json.data.token.position, 1);
  const byApp = await call('GET', Q(`/lookup?applicationId=${s.appId}`), undefined, adm.viewerC);
  assert.equal(byApp.json.data.token.code, t.code);
  assert.equal((await call('GET', Q(`/lookup?applicationId=${w.appId}`), undefined, adm.viewerC)).json.data.token.position, 2);

  await serveNext(1);      // Quinn is served: no longer in the engine, still known to the database
  const done = await call('GET', Q(`/lookup?token=${t.code}`), undefined, adm.viewerC);
  assert.equal(done.json.data.source, 'database');
  assert.equal(done.json.data.token.status, 'completed');
  assert.equal((await call('GET', Q(`/lookup?applicationId=${s.appId}`), undefined, adm.viewerC)).json.data.token.status, 'completed');

  assert.equal((await call('GET', Q('/lookup?token=R999'), undefined, adm.viewerC)).status, 404);
  assert.equal((await call('GET', Q('/lookup?applicationId=NOPE-12345'), undefined, adm.viewerC)).status, 404);
  assert.equal((await call('GET', Q('/lookup?token=hello'), undefined, adm.viewerC)).status, 400);
  assert.equal((await call('GET', Q('/lookup'), undefined, adm.viewerC)).status, 400);
  assert.equal((await call('GET', Q('/lookup?token=R001%0ASNAPSHOT'), undefined, adm.viewerC)).status, 400, 'no command injection into the engine');
  while ((await state()).waiting.length) await serveNext(1);
});

// ------------------------------------------------------------------------------------------------
test('student dashboard shows token, position and status, and follows every admin action', async () => {
  const [c1] = counters;
  const s1 = await makeStudent('Sam Sync'); const s2 = await makeStudent('Tara Sync'); const s3 = await makeStudent('Uma Sync', { round: 'Round 3' });
  const dash = async (s) => (await call('GET', '/api/dashboard', undefined, s.cookie)).json.data;
  assert.equal((await dash(s1)).queue.token, null);
  assert.equal((await dash(s1)).queue.appointmentToday.venue, 'Admission Cell', 'student is told about today’s appointment');

  const t1 = (await checkIn(s1)).json.data.token; const t2 = (await checkIn(s2)).json.data.token; const t3 = (await checkIn(s3)).json.data.token;
  let q = (await dash(s1)).queue.token;
  assert.equal(q.code, t1.code);
  assert.equal(q.status, 'waiting');
  assert.equal(q.position, 2);     // Uma (priority) jumped ahead of Sam and Tara
  assert.equal(q.ahead, 1);
  assert.match(q.message, /number 2/);
  assert.equal((await dash(s3)).queue.token.position, 1);
  assert.equal((await dash(s3)).queue.token.priority, true);
  assert.match((await dash(s3)).queue.token.priorityReason, /Late CAP round/);
  assert.equal((await dash(s1)).queue.token.priority, false);
  // a student sees only their own token, never other students' names
  const raw = JSON.stringify((await call('GET', '/api/queue/my-token', undefined, s1.cookie)).json);
  assert.ok(!raw.includes('Tara') && !raw.includes('Uma'));
  assert.equal((await call('GET', '/api/queue/my-token', undefined, s2.cookie)).json.data.queue.token.position, 3);

  // admin calls: positions of the others move up, the called student is told where to go
  assert.equal((await callNext(c1.id)).json.data.token.code, t3.code);
  q = (await dash(s3)).queue.token;
  assert.equal(q.status, 'called');
  assert.equal(q.counter, 'Counter 1');
  assert.match(q.message, /go to Counter 1/);
  assert.equal((await dash(s1)).queue.token.position, 1);
  assert.equal((await dash(s2)).queue.token.position, 2);
  assert.match((await dash(s1)).queue.token.message, /You are next/);

  await act(t3.id, 'start');
  assert.equal((await dash(s3)).queue.token.status, 'serving');
  await act(t3.id, 'complete');
  q = (await dash(s3)).queue.token;
  assert.equal(q.status, 'completed');
  assert.equal(q.active, false);
  assert.equal((await dash(s3)).queue.token.position, null);

  // no-show is explained to the student
  await callNext(c1.id);    // Sam
  await act(t1.id, 'no-show');
  assert.match((await dash(s1)).queue.token.message, /did not reach the counter/);
  assert.equal((await dash(s1)).queue.token.status, 'no_show');
  // existing dashboard content is untouched
  const d = await dash(s1);
  assert.equal(d.cap.applicationId, s1.appId);
  assert.equal(d.progress.total, 6);
  await act(t2.id, 'cancel');
  assert.equal((await dash(s2)).queue.token.status, 'cancelled');
  while ((await state()).waiting.length) await serveNext(1);
});

test('admin views: dashboard counts, student detail and activity history', async () => {
  const dash = (await call('GET', '/api/admin/dashboard', undefined, adm.viewerC)).json.data;
  assert.ok(dash.queue.completed >= 10);
  assert.equal(dash.queue.waiting, 0);

  const v = await makeStudent('Vera Detail');
  let d = (await call('GET', `/api/admin/students/${v.id}`, undefined, adm.viewerC)).json.data;
  assert.equal(d.queue.canCheckIn, true);
  assert.deepEqual(d.queue.tokens, []);
  const t = (await checkIn(v)).json.data.token;
  d = (await call('GET', `/api/admin/students/${v.id}`, undefined, adm.viewerC)).json.data;
  assert.equal(d.queue.canCheckIn, false);
  assert.equal(d.queue.tokens[0].code, t.code);
  assert.match(d.queue.checkInProblem, /already has an active token/);

  const log = (await call('GET', '/api/admin/activity?group=queue&pageSize=100', undefined, adm.saC)).json.data;
  const actions = new Set(log.items.map((i) => i.action));
  for (const a of ['queue.check_in', 'queue.call', 'queue.start', 'queue.complete', 'queue.no_show', 'queue.cancel', 'queue.counter_add', 'queue.counter_close', 'queue.counter_open']) assert.ok(actions.has(a), a);
  const call1 = log.items.find((i) => i.action === 'queue.call');
  assert.equal(call1.admin.name, 'Omkar Officer');
  assert.ok(call1.createdAt && call1.student.name && call1.details.counter);
  assert.equal(log.items.find((i) => i.action === 'queue.counter_add').admin.name, 'Sana Admin');
  assert.ok(log.groups.includes('queue'));
  await act(t.id, 'cancel');
});

// ------------------------------------------------------------------------------------------------
test('changes made in the admin portal remove waiting students from the queue (call-next skips ineligible students)', async () => {
  const a = await makeStudent('Wendy Change'); const b = await makeStudent('Xavier Change'); const c = await makeStudent('Yash Change'); const d = await makeStudent('Zoya Change');
  for (const s of [a, b, c, d]) await checkIn(s);
  assert.equal((await order()).length, 4);

  // application rejected -> leaves the queue
  assert.equal((await call('POST', `/api/admin/students/${a.id}/review`, { action: 'reject', remarks: 'Documents are not valid' }, adm.officerC)).status, 200);
  // appointment moved to another day -> leaves the queue
  assert.equal((await call('PUT', `/api/admin/appointments/${b.apptId}`, { date: time.addDays(2), time: '11:00', venue: 'Library', reason: 'College closed today' }, adm.officerC)).status, 200);
  // verification recorded elsewhere -> leaves the queue
  assert.equal((await call('PUT', `/api/admin/students/${c.id}/verification`, { status: 'completed', remarks: 'Done at the dean office' }, adm.officerC)).status, 200);

  const s = await state();
  assert.deepEqual(s.waiting.map((t) => t.student.name), ['Zoya Change']);
  const rows = db.prepare("SELECT status, finish_reason FROM queue_tokens WHERE student_id IN (?, ?, ?) ORDER BY student_id").all(a.id, b.id, c.id);
  assert.deepEqual(rows.map((r) => r.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.deepEqual(rows.map((r) => r.finish_reason), ['Application was rejected', 'The appointment was cancelled or changed', 'Physical verification was already completed']);
  assert.equal((await call('GET', '/api/dashboard', undefined, a.cookie)).json.data.queue.token.status, 'cancelled');
  const sys = db.prepare("SELECT admin_name, admin_role FROM admin_activity_log WHERE action = 'queue.auto_cancel'").all();
  assert.equal(sys.length, 3);
  assert.deepEqual([sys[0].admin_name, sys[0].admin_role], ['System', 'system']);

  // and they can come back once the problem is fixed: reopen the application
  assert.equal((await call('POST', `/api/admin/students/${a.id}/review`, { action: 'reopen', remarks: 'Documents re-checked' }, adm.officerC)).status, 200);
  assert.equal((await checkIn(a)).status, 201);
  await serveNext(1); await serveNext(1);
  while ((await state()).waiting.length) await serveNext(1);
});

// ------------------------------------------------------------------------------------------------
test('persistence: the queue survives an engine crash and a server restart, with identical order', async () => {
  const people = [];
  for (const [n, r] of [['Aria', 'Round 1'], ['Bela', 'Round 3'], ['Chet', 'Round 1'], ['Dina', 'Round 1'], ['Elan', 'Round 3'], ['Fay', 'Round 1']]) people.push(await makeStudent(`${n} Persist`, { round: r }));
  for (const p of people) await checkIn(p);
  const [c1, c2] = counters;
  const served = (await callNext(c1.id)).json.data.token;      // priority call (streak 1)
  await act(served.id, 'start');
  const called = (await callNext(c2.id)).json.data.token;      // priority call (streak 2)
  const before = await state();
  const beforeView = before.waiting.map((t) => [t.code, t.position, t.ahead]);

  // 1) the engine process is killed
  queueService.__test.killEngine();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(queueService.__test.engineAlive(), false);
  const afterCrash = await state();
  assert.deepEqual(afterCrash.waiting.map((t) => [t.code, t.position, t.ahead]), beforeView);
  assert.equal(afterCrash.counters[0].token.code, served.code);
  assert.equal(afterCrash.counters[0].token.status, 'serving');
  assert.equal(afterCrash.counters[1].token.code, called.code);
  assert.equal(afterCrash.streak, before.streak, 'the fairness streak is restored too');

  // 2) the whole backend restarts (engine stopped, everything rebuilt from SQLite)
  queueService.shutdown();
  const afterRestart = await state();
  assert.deepEqual(afterRestart.waiting.map((t) => t.code), before.waiting.map((t) => t.code));
  // the engine keeps going where it left off: token numbers continue and duplicates are still refused
  const lastNumber = db.prepare('SELECT MAX(token_number) AS n FROM queue_tokens WHERE queue_date = ?').get(today()).n;
  const next = await makeStudent('Gus Persist');
  const t = (await checkIn(next)).json.data.token;
  assert.equal(t.number, lastNumber + 1);
  assert.equal((await checkIn(people[0])).json.code, 'ALREADY_QUEUED');

  // 3) a completely separate connection to the SQLite file sees the same state
  const fresh = new Database(DB_FILE, { readonly: true });
  try {
    const rows = fresh.prepare("SELECT token_code, status, counter_id FROM queue_tokens WHERE queue_date = ? AND status IN ('waiting','called','serving') ORDER BY token_number").all(today());
    assert.equal(rows.filter((r) => r.status === 'serving').length, 1);
    assert.equal(rows.filter((r) => r.status === 'called').length, 1);
    assert.equal(rows.filter((r) => r.status === 'waiting').length, before.waiting.length + 1);
    assert.ok(fresh.prepare('SELECT COUNT(*) AS n FROM verification_counters').get().n >= 3);
    assert.match(fresh.prepare("SELECT value FROM queue_meta WHERE key = 'priority_streak'").get().value, new RegExp(`^${today()}\\|\\d+$`));
  } finally { fresh.close(); }

  await act(served.id, 'complete'); await act(called.id, 'start'); await act(called.id, 'complete');
  while ((await state()).waiting.length) await serveNext(1);
});

test('a new day: unfinished tokens from yesterday expire and token numbers start again at 1', async () => {
  const p = await makeStudent('Hal Stale');
  const t = (await checkIn(p)).json.data.token;
  assert.ok(t.number > 1, 'earlier tests already issued tokens today');
  // simulate midnight: everything issued so far now belongs to yesterday
  db.prepare('UPDATE queue_tokens SET queue_date = ?').run(time.addDays(-1));
  const s = await state();
  assert.equal(s.waiting.length, 0);
  assert.equal(s.stats.issued, 0);
  const row = db.prepare('SELECT status, finish_reason FROM queue_tokens WHERE id = ?').get(t.id);
  assert.equal(row.status, 'expired');
  assert.match(row.finish_reason, /end of the day/);
  assert.equal((await call('GET', '/api/dashboard', undefined, p.cookie)).json.data.queue.token, null, 'yesterday\'s token is not shown today');

  // the new day starts at number 1, and the student with the expired token can queue again
  db.prepare("UPDATE appointments SET appointment_date = ? WHERE id = ?").run(today(), p.apptId);
  const first = await checkIn(p);
  assert.equal(first.status, 201);
  assert.equal(first.json.data.token.number, 1);
  assert.match(first.json.data.token.code, /^[PR]001$/);
  const q = await makeStudent('Ida Fresh');
  assert.equal((await checkIn(q)).json.data.token.number, 2);
  while ((await state()).waiting.length) await serveNext(1);
});

test('if the engine is unavailable the queue reports 503 but the student dashboard still works, then recovers', async () => {
  const p = await makeStudent('Jai Outage');
  await checkIn(p);
  queueService.shutdown();
  process.env.QUEUE_ENGINE_PATH = path.join(tmpDir, 'no-such-engine');
  try {
    const r = await call('GET', Q(), undefined, adm.officerC);
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'ENGINE_UNAVAILABLE');
    assert.equal((await call('POST', Q('/check-in'), { studentId: p.id }, adm.officerC)).status, 503);
    const dash = await call('GET', '/api/dashboard', undefined, p.cookie);
    assert.equal(dash.status, 200, 'Phase 2 dashboard is unaffected');
    assert.equal(dash.json.data.cap.applicationId, p.appId);
    assert.equal((await call('GET', '/api/admin/students', undefined, adm.officerC)).status, 200, 'Phase 3 pages are unaffected');
  } finally { delete process.env.QUEUE_ENGINE_PATH; }
  const back = await state();                      // recovers by itself and rebuilds from the database
  assert.deepEqual(back.waiting.map((t) => t.student.name), ['Jai Outage']);
  while ((await state()).waiting.length) await serveNext(1);
});

test('final consistency: no student ever held two active tokens, and every token has a unique number per day', async () => {
  const dup = db.prepare("SELECT student_id, COUNT(*) AS n FROM queue_tokens WHERE status IN ('waiting','called','serving') GROUP BY student_id HAVING n > 1").all();
  assert.deepEqual(dup, []);
  const dupNum = db.prepare('SELECT queue_date, token_number, COUNT(*) AS n FROM queue_tokens GROUP BY queue_date, token_number HAVING n > 1').all();
  assert.deepEqual(dupNum, []);
  const s = await state();
  assert.equal(s.stats.waiting + s.stats.called + s.stats.serving, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM queue_tokens WHERE status IN ('waiting','called','serving')").get().n, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM queue_tokens').get().n >= 20);
});
