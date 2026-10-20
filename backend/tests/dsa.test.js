'use strict';
// Phase 5 tests: searching (binary + linear), sorting (merge sort), stack (undo), sparse and dense matrices,
// all served by the C++ engine. Results are cross-checked against independent JavaScript references.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-dsa-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const app = require('../app');
const db = require('../config/db');
const time = require('../utils/time');
const adminAuthService = require('../services/adminAuthService');
const queueService = require('../services/queueService');
const documentService = require('../services/documentService');
const { linkVerified } = require('./helpers/capHelper');

let server; let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { queueService.shutdown(); server.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

async function call(method, url, body, cookie) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + url, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  return { status: res.status, json: await res.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}

const PW = 'AdminPass123';
const A = {};
const today = () => time.today();
let seq = 0;

/** Fast direct insert (no password hashing) for bulk/scale data. */
function addStudent(name, { round = 'Round 1', appId, createdAt, cap = true, verification = null } = {}) {
  seq += 1;
  const id = Number(db.prepare("INSERT INTO students (full_name, email, phone, password_hash) VALUES (?, ?, '9000000000', 'x')").run(name, `d${seq}@example.com`).lastInsertRowid);
  const app_ = appId || `MH2026-${30000 + seq}`;
  if (cap) {
    db.prepare("INSERT INTO cap_details (student_id, application_id, student_name, allotted_college, course_branch, cap_round, allotment_status, created_at, updated_at) VALUES (?, ?, ?, 'COEP', 'Computer', ?, 'Allotted', COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))")
      .run(id, app_, name, round, createdAt || null, createdAt || null);
  }
  if (verification) db.prepare('INSERT INTO verification_records (student_id, status) VALUES (?, ?)').run(id, verification);
  return { id, appId: app_, name };
}
function addAppointment(studentId, date, hhmm, status = 'scheduled') {
  return Number(db.prepare("INSERT INTO appointments (student_id, appointment_date, appointment_time, venue, status, created_by_name, updated_by_name) VALUES (?, ?, ?, 'Admission Cell', ?, 'seed', 'seed')").run(studentId, date, hhmm, status).lastInsertRowid);
}
/** A student who can also log in (real API registration). */
async function apiStudent(name, round = 'Round 1') {
  seq += 1;
  const email = `api${seq}@example.com`;
  assert.equal((await call('POST', '/api/auth/register', { fullName: name, email, phone: '9700000000', password: 'Passw0rd123', confirmPassword: 'Passw0rd123' })).status, 201);
  const cookie = (await call('POST', '/api/auth/login', { email, password: 'Passw0rd123' })).cookie;
  const id = db.prepare('SELECT id FROM students WHERE email = ?').get(email).id;
  const appId = `MH2026-${70000 + seq}`;
  linkVerified(id, { applicationId: appId, name, college: 'COEP', branch: 'Computer', round });
  return { id, cookie, appId, name };
}
const login = async (email) => (await call('POST', '/api/admin/auth/login', { email, password: PW })).cookie;
const get = (url, cookie = A.officerC) => call('GET', url, undefined, cookie);
const review = (id, body, cookie = A.officerC) => call('POST', `/api/admin/students/${id}/review`, body, cookie);
const status = (id) => db.prepare("SELECT COALESCE((SELECT status FROM application_reviews WHERE student_id = ?), 'pending') AS s").get(id).s;
const maxSteps = (n) => 2 * Math.ceil(Math.log2(n + 1)) + 2;     // two binary searches (lower + upper bound)

test('setup: admins in three roles', async () => {
  await adminAuthService.createAdmin({ fullName: 'Sana Admin', email: 'sa@college.edu', password: PW, role: 'super_admin' });
  await adminAuthService.createAdmin({ fullName: 'Omkar Officer', email: 'officer@college.edu', password: PW, role: 'admission_officer' });
  await adminAuthService.createAdmin({ fullName: 'Vaidehi Viewer', email: 'viewer@college.edu', password: PW, role: 'viewer' });
  A.saC = await login('sa@college.edu'); A.officerC = await login('officer@college.edu'); A.viewerC = await login('viewer@college.edu');
  A.officerId = db.prepare("SELECT id FROM admins WHERE email = 'officer@college.edu'").get().id;
  A.saId = db.prepare("SELECT id FROM admins WHERE email = 'sa@college.edu'").get().id;
});

test('access control for the new endpoints', async () => {
  for (const u of ['/api/admin/search?q=ab', '/api/admin/planner/unscheduled', '/api/admin/planner/arrivals', '/api/admin/planner/load', '/api/admin/planner/documents', '/api/admin/undo']) {
    assert.equal((await call('GET', u)).status, 401, u);
  }
  for (const u of ['/api/admin/search?q=ab', '/api/admin/planner/unscheduled', '/api/admin/planner/arrivals', '/api/admin/planner/load', '/api/admin/planner/documents']) {
    assert.equal((await get(u, A.viewerC)).status, 200, `viewer may read ${u}`);
  }
  assert.equal((await get('/api/admin/undo', A.viewerC)).status, 403, 'viewers cannot undo');
  assert.equal((await call('POST', '/api/admin/undo', {}, A.viewerC)).status, 403);
  const stu = await apiStudent('Cookie Probe');
  assert.equal((await get('/api/admin/search?q=ab', stu.cookie)).status, 401, 'a student session is not an admin session');
});

// =============================================================================================== SEARCHING
test('search: validation and no command injection into the engine', async () => {
  for (const q of ['', 'a', ' ', 'x'.repeat(61)]) assert.equal((await get(`/api/admin/search?q=${encodeURIComponent(q)}`)).status, 400, q);
  assert.equal((await get('/api/admin/search')).status, 400);
  for (const q of ['a;b', 'a<b>', 'a$b', 'a%00b', 'a~b', 'a:b']) assert.equal((await get(`/api/admin/search?q=${encodeURIComponent(q)}`)).status, 400, q);
  // a newline cannot start a second engine command: it is collapsed into plain text and simply matches nothing
  const r = await get(`/api/admin/search?q=${encodeURIComponent('zz\nSNAPSHOT')}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.results, []);
  assert.equal((await get('/api/admin/queue')).status, 200, 'the engine is still healthy');
});

test('search by application ID uses binary search (exact and prefix, case-insensitive)', async () => {
  const a = addStudent('Meera Kulkarni', { appId: 'MH2026-10002' });
  const b = addStudent('Aarav Deshmukh', { appId: 'MH2026-10001' });
  const c = addStudent('Ravi Kale', { appId: 'MH2026-10010' });
  addStudent('Kavita Kulkarni', { appId: 'MH2027-20000' });
  addStudent('No Application Yet', { cap: false });

  let r = (await get('/api/admin/search?q=mh2026-10010')).json.data;
  assert.deepEqual(r.results.map((x) => x.id), [c.id]);
  assert.deepEqual(r.results[0].matchedBy, ['Application ID']);
  const app = r.algorithms.find((x) => x.field === 'Application ID');
  assert.equal(app.algorithm, 'binary search');
  assert.ok(app.comparisons <= maxSteps(app.searched), `${app.comparisons} steps for ${app.searched} records`);
  assert.equal(r.indexRebuilt, true, 'first search builds the index');

  r = (await get('/api/admin/search?q=MH2026-100')).json.data;          // prefix: a contiguous range, in ID order
  assert.deepEqual(r.results.map((x) => x.applicationId), ['MH2026-10001', 'MH2026-10002', 'MH2026-10010']);
  assert.deepEqual(r.results.map((x) => x.id), [b.id, a.id, c.id]);
  assert.equal(r.indexRebuilt, false, 'unchanged data: the index is reused');
  assert.equal((await get('/api/admin/search?q=MH2026-999')).json.data.results.length, 0);
  assert.equal((await get('/api/admin/search?q=MH2')).json.data.results.length, db.prepare("SELECT COUNT(*) AS n FROM cap_details WHERE application_id LIKE 'MH2%'").get().n);
  assert.equal(r.results[0].reviewStatus, 'pending');
});

test('search by name uses linear search and examines every record', async () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  const r = (await get('/api/admin/search?q=KUL')).json.data;
  const name = r.algorithms.find((x) => x.field === 'Name');
  assert.equal(name.algorithm, 'linear search');
  assert.equal(name.comparisons, n, 'linear search must look at all records');
  assert.equal(name.searched, n);
  const expected = db.prepare("SELECT id FROM students WHERE lower(full_name) LIKE '%kul%' ORDER BY id").all().map((x) => x.id);
  assert.deepEqual(r.results.map((x) => x.id).sort((x, y) => x - y), expected);
  assert.ok(expected.length >= 2);
  assert.deepEqual((await get('/api/admin/search?q=meera%20kul')).json.data.results.map((x) => x.name), ['Meera Kulkarni']);
  const none = (await get('/api/admin/search?q=No%20Application')).json.data.results[0];
  assert.equal(none.applicationId, null, 'students without CAP details are still found by name');
  assert.equal(none.reviewStatus, 'not_started');
});

test('search by token uses binary search over today\'s tokens', async () => {
  const s1 = await apiStudent('Token Ann'); const s2 = await apiStudent('Token Bob', 'Round 3');
  for (const s of [s1, s2]) addAppointment(s.id, today(), '10:00');
  const t1 = (await call('POST', '/api/admin/queue/check-in', { studentId: s1.id }, A.officerC)).json.data.token;
  const t2 = (await call('POST', '/api/admin/queue/check-in', { studentId: s2.id }, A.officerC)).json.data.token;
  const r = (await get(`/api/admin/search?q=${t2.code.toLowerCase()}`)).json.data;
  assert.equal(r.indexRebuilt, true, 'a new token changes the index fingerprint');
  assert.deepEqual(r.results.map((x) => x.name), ['Token Bob']);
  assert.equal(r.results[0].token, t2.code);
  assert.deepEqual(r.results[0].matchedBy, ['Token']);
  const alg = r.algorithms.find((x) => x.field === 'Token');
  assert.equal(alg.algorithm, 'binary search');
  assert.ok(alg.comparisons <= Math.ceil(Math.log2(alg.searched + 1)) + 1);
  // same number, other lane: not a match
  const other = (t2.code[0] === 'P' ? 'R' : 'P') + t2.code.slice(1);
  assert.equal((await get(`/api/admin/search?q=${other}`)).json.data.results.length, 0);
  assert.equal((await get('/api/admin/search?q=R9999')).json.data.results.length, 0);
  // cleanup so later queue-dependent tests start clean
  for (const t of [t1, t2]) await call('POST', `/api/admin/queue/tokens/${t.id}/cancel`, {}, A.officerC);
});

test('search scales: 600 more students still cost only ~log n steps for IDs, n for names; index follows changes', async () => {
  db.transaction(() => {
    for (let i = 0; i < 600; i += 1) addStudent(`Bulk Student ${i}`, { appId: `MH2026-${50000 + ((i * 37) % 600)}` });   // shuffled insertion order
  })();
  const N = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  let r = (await get('/api/admin/search?q=MH2026-50300')).json.data;
  assert.equal(r.indexRebuilt, true, 'new students trigger a rebuild');
  assert.equal(r.results.length, 1);
  const app = r.algorithms.find((x) => x.field === 'Application ID');
  assert.ok(app.comparisons <= maxSteps(N), `${app.comparisons} <= ${maxSteps(N)}`);
  assert.ok(app.comparisons < N / 20, 'orders of magnitude below a scan');
  r = (await get('/api/admin/search?q=bulk')).json.data;
  assert.equal(r.results.length, 15);
  assert.equal(r.total, 600);
  assert.equal(r.truncated, true);
  assert.equal(r.algorithms.find((x) => x.field === 'Name').comparisons, N);
  // a CAP change (new application ID) is searchable on the next query
  const id = db.prepare("SELECT id FROM students WHERE full_name = 'Bulk Student 5'").get().id;
  db.prepare("UPDATE cap_details SET application_id = 'ZZ2026-00001', updated_at = '2999-01-01 00:00:00' WHERE student_id = ?").run(id);
  r = (await get('/api/admin/search?q=zz2026')).json.data;
  assert.deepEqual(r.results.map((x) => x.id), [id]);
  db.prepare("DELETE FROM students WHERE full_name LIKE 'Bulk Student %'").run();
  assert.equal((await get('/api/admin/search?q=bulk')).json.data.total, 0, 'deleted students disappear from the index');
});

// =============================================================================================== SORTING
function referenceUnscheduled() {
  const rows = db.prepare(
    `SELECT s.id, s.full_name, c.cap_round, CAST(strftime('%s', c.created_at) AS INTEGER) AS since, COALESCE(v.status, 'pending') AS v, COALESCE(r.status, 'pending') AS r
       FROM students s JOIN cap_details c ON c.student_id = s.id LEFT JOIN verification_records v ON v.student_id = s.id LEFT JOIN application_reviews r ON r.student_id = s.id ORDER BY s.id`
  ).all().filter((x) => x.r !== 'rejected' && x.v !== 'completed' && !db.prepare("SELECT 1 FROM appointments WHERE student_id = ? AND status = 'scheduled'").get(x.id));
  const lvl = (x) => queueService.priorityFor(x.cap_round, x.v).level;
  return rows.sort((a, b) => (lvl(a) - lvl(b)) || (a.since - b.since) || (a.full_name.toLowerCase() < b.full_name.toLowerCase() ? -1 : a.full_name.toLowerCase() > b.full_name.toLowerCase() ? 1 : 0)).map((x) => x.id);
}

test('planner: students needing an appointment are ranked by priority, then waiting time, then name (merge sort)', async () => {
  addStudent('Zed Regular Old', { round: 'Round 1', createdAt: '2026-01-01 10:00:00' });
  addStudent('Amy Regular New', { round: 'Round 2', createdAt: '2026-09-01 10:00:00' });
  addStudent('Bea Late Round', { round: 'Round 3', createdAt: '2026-05-01 10:00:00' });
  addStudent('Cal Special Round', { round: 'Special Round', createdAt: '2026-04-01 10:00:00' });
  addStudent('Dan Returning', { round: 'Round 1', createdAt: '2026-08-01 10:00:00', verification: 'in_progress' });
  addStudent('Eve Same Time A', { round: 'Round 1', createdAt: '2026-03-03 10:00:00' });
  addStudent('Eve Same Time B', { round: 'Round 1', createdAt: '2026-03-03 10:00:00' });
  const booked = addStudent('Fay Already Booked', { round: 'Round 3' }); addAppointment(booked.id, time.addDays(3), '10:00');
  const verified = addStudent('Gus Verified', { verification: 'completed' });
  const rejected = addStudent('Hal Rejected'); db.prepare("INSERT INTO application_reviews (student_id, status) VALUES (?, 'rejected')").run(rejected.id);

  const r = (await get('/api/admin/planner/unscheduled')).json.data;
  assert.equal(r.algorithm.name, 'merge sort');
  assert.ok(r.algorithm.comparisons > 0 && r.algorithm.items === r.items.length);
  const ids = r.items.map((x) => x.id);
  assert.deepEqual(ids, referenceUnscheduled(), 'identical to an independent JavaScript sort');
  const names = r.items.map((x) => x.name);
  assert.equal(names[0], 'Dan Returning', 'level 1 (returning) first');
  assert.ok(names.indexOf('Cal Special Round') < names.indexOf('Bea Late Round'), 'level 2: Cal entered CAP details earlier, so has waited longer');
  assert.ok(names.indexOf('Cal Special Round') < names.indexOf('Zed Regular Old'), 'level 2 before level 3');
  assert.ok(names.indexOf('Zed Regular Old') < names.indexOf('Amy Regular New'), 'level 3: longest waiting first');
  assert.ok(names.indexOf('Eve Same Time A') < names.indexOf('Eve Same Time B'), 'ties are broken by name');
  for (const excluded of ['Fay Already Booked', 'Gus Verified', 'Hal Rejected']) assert.ok(!names.includes(excluded), `${excluded} is not listed`);
  assert.deepEqual(r.items.map((x) => x.rank), r.items.map((_, i) => i + 1));
  assert.ok(r.items.every((x) => x.level >= 1 && x.level <= 3 && x.priorityReason));
  // deterministic: asking twice gives the same order
  assert.deepEqual((await get('/api/admin/planner/unscheduled')).json.data.items.map((x) => x.id), ids);
});

test('planner: today\'s arrivals sorted by appointment time, priority or token', async () => {
  const day = today();
  const mk = (name, round, hhmm, v) => { const s = addStudent(name, { round, verification: v }); addAppointment(s.id, day, hhmm); return s; };
  const p1 = mk('Arr Nine Thirty', 'Round 1', '09:30');
  const p2 = mk('Arr Ten Late Round', 'Round 3', '10:00');
  const p3 = mk('Arr Ten Regular', 'Round 1', '10:00');
  const p4 = mk('Arr Ten Thirty Returning', 'Round 1', '10:30', 'in_progress');
  const p5 = mk('Arr Eleven', 'Round 2', '11:00');
  // two of them check in: p5 first (token lower), then p3
  const tk = async (s) => (await call('POST', '/api/admin/queue/check-in', { studentId: s.id }, A.officerC)).json.data.token;
  const t5 = await tk(p5); const t3 = await tk(p3);
  const names = (r) => r.json.data.items.map((x) => x.name);
  const mine = ['Arr Nine Thirty', 'Arr Ten Late Round', 'Arr Ten Regular', 'Arr Ten Thirty Returning', 'Arr Eleven'];
  const only = (list) => list.filter((n) => mine.includes(n));

  const byTime = await get('/api/admin/planner/arrivals?sort=time');
  assert.equal(byTime.json.data.algorithm.name, 'merge sort');
  assert.deepEqual(only(names(byTime)), ['Arr Nine Thirty', 'Arr Ten Late Round', 'Arr Ten Regular', 'Arr Ten Thirty Returning', 'Arr Eleven']);   // 10:00 tie: priority 2 before 3
  assert.deepEqual(only(names(await get('/api/admin/planner/arrivals'))), only(names(byTime)), 'time is the default');
  const byPriority = await get('/api/admin/planner/arrivals?sort=priority');
  assert.deepEqual(only(names(byPriority)), ['Arr Ten Thirty Returning', 'Arr Ten Late Round', 'Arr Nine Thirty', 'Arr Ten Regular', 'Arr Eleven']);
  const byToken = await get('/api/admin/planner/arrivals?sort=token');
  assert.deepEqual(only(names(byToken)), ['Arr Eleven', 'Arr Ten Regular', 'Arr Nine Thirty', 'Arr Ten Late Round', 'Arr Ten Thirty Returning'], 'checked-in students first by token, the rest by time');
  assert.ok(t5.number < t3.number);
  const row = byToken.json.data.items.find((x) => x.name === 'Arr Eleven');
  assert.equal(row.token, t5.code);
  assert.equal(row.tokenStatus, 'waiting');
  assert.equal(byToken.json.data.items.find((x) => x.name === 'Arr Nine Thirty').token, null);
  assert.equal((await get('/api/admin/planner/arrivals?sort=bubble')).json.data.sort, 'time', 'unknown sort falls back to time');
  // cross-check a different view of the same list against a JS reference
  const all = byPriority.json.data.items;
  const lvlSorted = [...all].sort((a, b) => (a.level - b.level) || (a.appointmentTime < b.appointmentTime ? -1 : a.appointmentTime > b.appointmentTime ? 1 : 0) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  assert.deepEqual(all.map((x) => x.id), lvlSorted.map((x) => x.id));
  // sorting the planner never reorders the real queue: both are regular-lane students, called first come, first served
  assert.deepEqual((await get('/api/admin/queue')).json.data.waiting.map((t) => t.code), [t5.code, t3.code]);
  for (const t of [t5, t3]) await call('POST', `/api/admin/queue/tokens/${t.id}/cancel`, {}, A.officerC);
  db.prepare("DELETE FROM appointments WHERE appointment_date = ? AND created_by_name = 'seed'").run(day);
});

// =============================================================================================== MATRICES
test('sparse matrix: appointment load per day and half-hour slot, with suggestions', async () => {
  const d = (n) => time.addDays(n);
  const seed = [[20, '10:00'], [20, '10:15'], [20, '10:29'], [20, '10:30'], [20, '14:00'], [22, '10:00'], [24, '09:00']];
  seed.forEach(([day, t], i) => addAppointment(addStudent(`Load ${i}`).id, d(day), t));
  addAppointment(addStudent('Load Done').id, d(20), '10:00', 'completed');         // only scheduled appointments count
  const r = (await get(`/api/admin/planner/load?from=${d(20)}&days=5`)).json.data;
  assert.equal(r.days, 5);
  assert.equal(r.bookings, 7);
  const cell = (date, t) => (r.cells.find((c) => c.date === date && c.time === t) || { count: 0 }).count;
  assert.equal(cell(d(20), '10:00'), 3, '10:00, 10:15 and 10:29 share the 10:00 slot');
  assert.equal(cell(d(20), '10:30'), 1);
  assert.equal(cell(d(20), '14:00'), 1);
  assert.equal(cell(d(22), '10:00'), 1);
  assert.equal(cell(d(24), '09:00'), 1);
  assert.equal(r.cells.length, 5, 'only non-zero cells are stored');
  assert.equal(r.matrix.storedCells, 5);
  assert.equal(r.matrix.totalCells, 5 * 48);
  assert.ok(r.matrix.density < 0.03 && r.matrix.representation.includes('sparse'));
  assert.deepEqual(r.dayTotals.map((x) => x.count), [5, 0, 1, 0, 1]);
  assert.deepEqual(r.slotTotals.find((s) => s.time === '10:00'), { time: '10:00', count: 4 });
  assert.deepEqual(r.busiest[0], { date: d(20), time: '10:00', count: 3 });
  assert.ok(r.busiest.length <= 5);
  // least-loaded slot inside office hours: earliest empty slot, 09:00 unless that is taken
  assert.deepEqual(r.suggestions.find((s) => s.date === d(20)), { date: d(20), time: '09:00', count: 0 });
  assert.deepEqual(r.suggestions.find((s) => s.date === d(24)), { date: d(24), time: '09:30', count: 0 }, '09:00 is booked on that day');
  assert.equal(r.officeHours.from, '09:00');
  // independent reference over a wider window
  const ref = new Map();
  for (const a of db.prepare("SELECT appointment_date AS d, appointment_time AS t FROM appointments WHERE status = 'scheduled' AND appointment_date >= ? AND appointment_date <= ?").all(d(0), d(30))) {
    const slot = Math.floor((Number(a.t.slice(0, 2)) * 60 + Number(a.t.slice(3, 5))) / 30);
    ref.set(`${a.d}|${slot}`, (ref.get(`${a.d}|${slot}`) || 0) + 1);
  }
  const wide = (await get(`/api/admin/planner/load?from=${d(0)}&days=31`)).json.data;
  assert.equal(wide.cells.reduce((s, c) => s + c.count, 0), [...ref.values()].reduce((a, b) => a + b, 0));
  assert.equal(wide.cells.length, ref.size);
  for (const c of wide.cells) { const slot = (Number(c.time.slice(0, 2)) * 60 + Number(c.time.slice(3, 5))) / 30; assert.equal(ref.get(`${c.date}|${slot}`), c.count); }
  assert.ok(wide.matrix.density < 0.02);
  // validation
  for (const q of ['days=0', 'days=32', 'days=abc', 'days=1.5', 'from=2026-13-40', 'from=tomorrow']) assert.equal((await get(`/api/admin/planner/load?${q}`)).status, 400, q);
  const empty = (await get(`/api/admin/planner/load?from=${d(200)}&days=3`)).json.data;
  assert.deepEqual([empty.bookings, empty.cells.length, empty.matrix.storedCells], [0, 0, 0]);
  assert.equal(empty.suggestions[0].time, '09:00');
  db.prepare("DELETE FROM appointments WHERE created_by_name = 'seed'").run();
});

test('dense matrix: document readiness per CAP round (documents x rounds)', async () => {
  const prep = (s, keys) => keys.forEach((k) => db.prepare('INSERT OR REPLACE INTO document_status (student_id, doc_key, prepared) VALUES (?, ?, 1)').run(s.id, k));
  const r1a = addStudent('Doc R1 A', { round: 'Round 1' }); const r1b = addStudent('Doc R1 B', { round: 'Round 1' });
  const r3 = addStudent('Doc R3', { round: 'Round 3' }); addStudent('Doc Sp Empty', { round: 'Special Round' });
  prep(r1a, ['ssc_marksheet', 'hsc_marksheet', 'photo_id']); prep(r1b, ['ssc_marksheet']); prep(r3, ['ssc_marksheet', 'category_certificate']);
  db.prepare('INSERT INTO document_status (student_id, doc_key, prepared) VALUES (?, ?, 0)').run(r1b.id, 'photo_id');   // explicitly NOT prepared

  const r = (await get('/api/admin/planner/documents')).json.data;
  assert.deepEqual([r.matrix.rows, r.matrix.cols], [documentService.DOCUMENTS.length, 4]);
  assert.ok(r.matrix.representation.includes('dense'));
  assert.deepEqual(r.rounds.map((x) => x.name), ['Round 1', 'Round 2', 'Round 3', 'Special Round']);
  // independent reference computed in JavaScript from the raw rows
  const rounds = r.rounds.map((x) => x.name);
  const students = db.prepare('SELECT student_id, cap_round FROM cap_details').all();
  const prepared = db.prepare('SELECT student_id, doc_key FROM document_status WHERE prepared = 1').all();
  r.documents.forEach((doc, di) => rounds.forEach((rd, k) => {
    const expected = students.filter((s) => s.cap_round === rd && prepared.some((p) => p.student_id === s.student_id && p.doc_key === doc.key)).length;
    assert.equal(doc.ready[k], expected, `${doc.title} / ${rd}`);
    const total = students.filter((s) => s.cap_round === rd).length;
    assert.equal(r.rounds[k].students, total);
    assert.ok(Math.abs(doc.percent[k] - (total ? (100 * expected) / total : 0)) < 0.06, 'percent');
  }));
  const ssc = r.documents.find((x) => x.key === 'ssc_marksheet');
  assert.equal(ssc.totalReady, ssc.ready.reduce((a, b) => a + b, 0), 'row sum');
  assert.ok(ssc.ready[0] >= 2 && ssc.ready[2] >= 1);
  assert.equal(r.documents.find((x) => x.key === 'photo_id').ready[0], 1, 'a document marked not prepared is not counted');
  const sp = r.weakest.find((w) => w.round === 'Special Round');
  assert.ok(sp.document !== null || r.rounds[3].students === 0);
  assert.equal(r.weakest.length, 4);
  const w1 = r.weakest.find((w) => w.round === 'Round 1');
  const minPct = Math.min(...r.documents.map((d) => d.percent[0]));
  assert.ok(Math.abs(w1.percent - minPct) < 1e-9, 'weakest document has the lowest percentage');
  db.prepare("DELETE FROM students WHERE full_name LIKE 'Doc %'").run();
  const after = (await get('/api/admin/planner/documents')).json.data;
  assert.ok(after.rounds.every((x, k) => x.students <= r.rounds[k].students));
});

// =============================================================================================== STACK / UNDO
const undoList = async (cookie = A.officerC) => (await get('/api/admin/undo', cookie)).json.data;
const undo = (cookie = A.officerC) => call('POST', '/api/admin/undo', {}, cookie);
const drain = async (cookie = A.officerC) => { while ((await undoList(cookie)).size) await undo(cookie); };

test('undo: the stack is empty at first', async () => {
  const l = await undoList();
  assert.deepEqual([l.size, l.items.length, l.next, l.capacity], [0, 0, null, 20]);
  const r = await undo();
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'NOTHING_TO_UNDO');
});

test('undo is last-in-first-out across application decisions and reschedules', async () => {
  const a = await apiStudent('Undo A'); const b = await apiStudent('Undo B'); const c = await apiStudent('Undo C');
  const apptB = addAppointment(b.id, time.addDays(2), '10:00');
  assert.equal((await review(a.id, { action: 'approve', remarks: 'Looks good' })).status, 200);      // 1st
  assert.equal((await review(c.id, { action: 'reject', remarks: 'Not eligible for the seat' })).status, 200);   // 2nd
  assert.equal((await call('PUT', `/api/admin/appointments/${apptB}`, { date: time.addDays(4), time: '11:00', venue: 'Library', reason: 'Hall is booked' }, A.officerC)).status, 200);   // 3rd

  const l = await undoList();
  assert.equal(l.size, 3);
  assert.deepEqual(l.items.map((x) => x.kind), ['reschedule', 'review', 'review'], 'newest first');
  assert.match(l.items[0].summary, /Rescheduled appointment/);
  assert.match(l.items[1].summary, /Rejected: application of Undo C/);
  assert.equal(l.next.id, l.items[0].id);

  const u1 = await undo();                                   // newest: the reschedule
  assert.equal(u1.status, 200);
  assert.equal(u1.json.data.undone.kind, 'reschedule');
  assert.equal(u1.json.data.remaining, 2);
  assert.equal(u1.json.data.next.kind, 'review');
  const ap = db.prepare('SELECT appointment_date, appointment_time, venue, reschedule_count, status_note FROM appointments WHERE id = ?').get(apptB);
  assert.deepEqual([ap.appointment_date, ap.appointment_time, ap.venue, ap.reschedule_count, ap.status_note], [time.addDays(2), '10:00', 'Admission Cell', 0, null]);
  assert.equal(status(c.id), 'rejected', 'older actions are untouched until their turn');

  const u2 = await undo();                                   // next: the rejection
  assert.equal(u2.json.data.undone.studentName, 'Undo C');
  assert.equal(status(c.id), 'pending');
  assert.equal((await call('GET', '/api/dashboard', undefined, c.cookie)).json.data.application.status, 'pending', 'the student sees the reversal');
  assert.equal(status(a.id), 'approved');

  const u3 = await undo();                                   // oldest: the approval
  assert.equal(u3.json.data.remaining, 0);
  assert.equal(u3.json.data.next, null);
  assert.equal(status(a.id), 'pending');
  assert.equal((await undo()).json.code, 'NOTHING_TO_UNDO');

  // the reversal is recorded openly: status history and the activity log
  const hist = (await get(`/api/admin/students/${c.id}`)).json.data.history;
  assert.deepEqual(hist.map((h) => h.toStatus), ['pending', 'rejected']);
  assert.match(hist[0].remarks, /reversed/);
  const log = (await get('/api/admin/activity?pageSize=100', A.saC)).json.data.items.map((i) => i.action);
  assert.ok(log.includes('application.undo') && log.includes('appointment.undo_reschedule'));
  assert.equal((await undoList()).size, 0, 'undo itself is not pushed onto the stack');
});

test('each admin has their own stack', async () => {
  const d = await apiStudent('Undo D');
  assert.equal((await review(d.id, { action: 'approve' }, A.saC)).status, 200);        // super admin's action
  assert.equal((await undoList(A.officerC)).size, 0);
  assert.equal((await undoList(A.saC)).size, 1);
  assert.equal((await undo(A.officerC)).json.code, 'NOTHING_TO_UNDO', 'an officer cannot undo the super admin\'s action');
  assert.equal(status(d.id), 'approved');
  assert.equal((await undo(A.saC)).status, 200);
  assert.equal(status(d.id), 'pending');
});

test('undo refuses (and clears the entry) when the application changed after the action', async () => {
  const e = await apiStudent('Undo E');
  await review(e.id, { action: 'approve', remarks: 'ok' }, A.officerC);
  await review(e.id, { action: 'reject', remarks: 'Found a problem later' }, A.saC);         // someone else changes it afterwards
  const r = await undo(A.officerC);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'STALE_UNDO');
  assert.match(r.json.message, /removed from your undo list/);
  assert.equal(status(e.id), 'rejected', 'the newer decision was not overwritten');
  assert.equal((await undoList(A.officerC)).size, 0, 'the stale entry no longer blocks the stack');
  // the super admin's own undo still works and restores what was there before THEIR action (approved)
  assert.equal((await undo(A.saC)).status, 200);
  assert.equal(status(e.id), 'approved');
  assert.equal(db.prepare("SELECT status FROM admin_undo_actions WHERE admin_id = ? ORDER BY id DESC LIMIT 1").get(A.officerId).status, 'discarded');
  await drain(A.saC);

  // a reschedule cannot be undone once the appointment was cancelled
  const f = addStudent('Undo F'); const appt = addAppointment(f.id, time.addDays(2), '10:00');
  await call('PUT', `/api/admin/appointments/${appt}`, { date: time.addDays(5), time: '12:00', venue: 'Room 9', reason: 'Clash with exam' }, A.officerC);
  await call('PATCH', `/api/admin/appointments/${appt}/status`, { status: 'cancelled', note: 'Student withdrew' }, A.officerC);
  const r2 = await undo(A.officerC);
  assert.equal(r2.json.code, 'STALE_UNDO');
  assert.equal(db.prepare('SELECT appointment_date, status FROM appointments WHERE id = ?').get(appt).status, 'cancelled');
  await drain();
});

test('the undo stack is bounded: the 21st action pushes the oldest off', async () => {
  const g = await apiStudent('Undo G');
  for (let i = 0; i < 21; i += 1) {
    const r = i % 2 === 0 ? await review(g.id, { action: 'approve' }) : await review(g.id, { action: 'reopen', remarks: 'Checking again' });
    assert.equal(r.status, 200, `action ${i}`);
  }
  const l = await undoList();
  assert.equal(l.size, 20);
  assert.equal(l.capacity, 20);
  const mine = db.prepare("SELECT status, COUNT(*) AS n FROM admin_undo_actions WHERE admin_id = ? AND student_id = ? GROUP BY status").all(A.officerId, g.id);
  assert.deepEqual(Object.fromEntries(mine.map((m) => [m.status, m.n])), { active: 20, expired: 1 });
  await drain();
  assert.equal(status(g.id), 'approved', 'the expired first action (approve) could not be undone, so its effect remains');
});

test('the undo stack survives an engine crash and a restart (rebuilt from the database, same order)', async () => {
  const h = await apiStudent('Undo H'); const i = await apiStudent('Undo I');
  await review(h.id, { action: 'approve' }); await review(i.id, { action: 'request_corrections', remarks: 'Photo is blurry' });
  const before = (await undoList()).items.map((x) => x.id);
  assert.equal(before.length, 2);

  queueService.__test.killEngine();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(queueService.__test.engineAlive(), false);
  assert.deepEqual((await undoList()).items.map((x) => x.id), before, 'same entries, same order, after a crash');

  queueService.shutdown();
  assert.deepEqual((await undoList()).items.map((x) => x.id), before, 'and after a full restart');
  const u = await undo();
  assert.equal(u.json.data.undone.studentName, 'Undo I', 'LIFO still holds after the restart');
  assert.equal(status(i.id), 'pending');
  // search index and Phase 4 queue also rebuilt cleanly after the restart
  assert.equal((await get('/api/admin/search?q=Undo%20H')).json.data.results[0].name, 'Undo H');
  assert.equal((await get('/api/admin/queue')).status, 200);
  await drain();
});

test('two simultaneous undo requests never undo the same action twice', async () => {
  const j = await apiStudent('Undo J'); const k = await apiStudent('Undo K');
  await review(j.id, { action: 'approve' }); await review(k.id, { action: 'approve' });
  const [x, y] = await Promise.all([undo(), undo()]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.notEqual(x.json.data.undone.id, y.json.data.undone.id);
  assert.deepEqual([status(j.id), status(k.id)], ['pending', 'pending']);
  await review(j.id, { action: 'approve' });
  const [p, q] = await Promise.all([undo(), undo()]);
  assert.deepEqual([p.status, q.status].sort(), [200, 409]);
});

// =============================================================================================== PHASE 3/4 INTACT
test('Phase 3 and Phase 4 features still work alongside Phase 5', async () => {
  const s = await apiStudent('Regression Rita', 'Round 3');
  addAppointment(s.id, today(), '10:00');
  const t = (await call('POST', '/api/admin/queue/check-in', { studentId: s.id }, A.officerC)).json.data.token;
  assert.equal(t.lane, 'priority');
  assert.equal((await call('POST', '/api/admin/queue/counters/1/call-next', {}, A.officerC)).json.data.token.code, t.code);
  assert.equal((await call('GET', '/api/dashboard', undefined, s.cookie)).json.data.queue.token.status, 'called');
  assert.equal((await call('POST', `/api/admin/queue/tokens/${t.id}/no-show`, {}, A.officerC)).status, 200);
  assert.equal((await get('/api/admin/students?search=Regression')).json.data.total, 1);
  assert.equal((await get('/api/admin/dashboard')).status, 200);
  assert.equal((await get(`/api/admin/search?q=${encodeURIComponent('Regression Rita')}`)).json.data.results[0].token, t.code);
});
