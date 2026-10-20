'use strict';
// CAP allotment verification tests: unauthorized changes, missing records, valid records, duplicate application IDs,
// audit history, the legacy-data migration, and the database lookup plan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-cap-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.CAP_CLAIM_MAX_ATTEMPTS = '10';

const app = require('../app');
const db = require('../config/db');
const time = require('../utils/time');
const adminAuthService = require('../services/adminAuthService');
const capRecordService = require('../services/capRecordService');
const queueService = require('../services/queueService');
const migrateLegacy = require('../config/capMigration');

let server; let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { queueService.shutdown(); server.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

async function call(method, url, body, cookie, headers = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + url, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const sc = res.headers.get('set-cookie');
  return { status: res.status, json: await res.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}

const PW = 'AdminPass123';
const A = {};
const Q = (p = '') => `/api/admin/cap${p}`;
const login = async (email) => (await call('POST', '/api/admin/auth/login', { email, password: PW })).cookie;
let seq = 0;
async function student(name) {
  seq += 1;
  const email = `capstu${seq}@example.com`;
  assert.equal((await call('POST', '/api/auth/register', { fullName: name, email, phone: `96000000${String(seq).padStart(2, '0')}`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123' })).status, 201);
  const cookie = (await call('POST', '/api/auth/login', { email, password: 'Passw0rd123' })).cookie;
  return { id: db.prepare('SELECT id FROM students WHERE email = ?').get(email).id, cookie, name };
}
const rec = (over = {}) => ({ applicationId: 'MH2026-50001', candidateName: 'KULKARNI ASHA', allottedCollege: 'College of Engineering Pune', courseBranch: 'Computer Engineering', capRound: 'Round 1', allotmentStatus: 'Allotted', ...over });
const create = (body, cookie = A.officerC) => call('POST', Q('/records'), body, cookie);
const verify = (id, cookie = A.sa2C, body = {}) => call('POST', Q(`/records/${id}/verify`, ), body, cookie);
const claim = (s, applicationId) => call('PUT', '/api/cap-details', { applicationId }, s.cookie);
const state = async (s) => (await call('GET', '/api/cap-details', undefined, s.cookie)).json.data;
const recordRow = (id) => db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id);

test('setup: admins (two officers, a super admin, a viewer)', async () => {
  await adminAuthService.createAdmin({ fullName: 'Omkar Officer', email: 'officer@college.edu', password: PW, role: 'admission_officer' });
  await adminAuthService.createAdmin({ fullName: 'Olga Officer', email: 'officer2@college.edu', password: PW, role: 'admission_officer' });
  await adminAuthService.createAdmin({ fullName: 'Sana Super', email: 'super@college.edu', password: PW, role: 'super_admin' });
  await adminAuthService.createAdmin({ fullName: 'Vaidehi Viewer', email: 'viewer@college.edu', password: PW, role: 'viewer' });
  A.officerC = await login('officer@college.edu'); A.officer2C = await login('officer2@college.edu'); A.saC = await login('super@college.edu'); A.viewerC = await login('viewer@college.edu');
  A.sa2C = A.officer2C;   // "a different admin": the second officer
});

// =============================================================================================== unauthorized modification
test('unauthenticated, student and viewer sessions cannot use the CAP admin API', async () => {
  const s = await student('Probe Student');
  const endpoints = [['GET', Q('/records')], ['GET', Q('/records/1')], ['POST', Q('/records')], ['POST', Q('/records/import')], ['PUT', Q('/records/1')],
    ['POST', Q('/records/1/verify')], ['POST', Q('/records/1/revoke')], ['POST', Q('/records/1/unlink')], ['GET', Q('/claims')], ['POST', Q('/claims/1/approve')], ['POST', Q('/claims/1/reject')]];
  for (const [m, u] of endpoints) {
    const body = m === 'GET' ? undefined : {};
    assert.equal((await call(m, u, body)).status, 401, `anonymous ${m} ${u}`);
    assert.equal((await call(m, u, body, s.cookie)).status, 401, `student ${m} ${u}`);
    const v = await call(m, u, body, A.viewerC);
    assert.equal(v.status, 403, `viewer ${m} ${u}`);
    assert.equal(v.json.code, 'FORBIDDEN');
  }
  assert.equal((await create(rec(), A.viewerC)).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cap_allotment_records').get().n, 0, 'nothing was created by unauthorized callers');
  // cross-site requests are refused even with a valid admin session
  assert.equal((await call('POST', Q('/records'), rec(), A.officerC, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('POST', Q('/records'), 'applicationId=1', A.officerC, { 'Content-Type': 'text/plain' })).status, 415);
  // student endpoints need a student session; an admin cookie is not one
  for (const [m, u] of [['GET', '/api/cap-details'], ['PUT', '/api/cap-details'], ['DELETE', '/api/cap-details']]) {
    assert.equal((await call(m, u, m === 'PUT' ? { applicationId: 'MH2026-50001' } : undefined)).status, 401, `anonymous ${m}`);
    assert.equal((await call(m, u, m === 'PUT' ? { applicationId: 'MH2026-50001' } : undefined, A.saC)).status, 401, `admin cookie ${m}`);
  }
});

test('students cannot write college, branch, round, status or anything else (and passwords are never accepted or stored)', async () => {
  const s = await student('Writer Student');
  const attempts = [
    { applicationId: 'MH2026-60001', allottedCollege: 'Elite College', courseBranch: 'Computer', capRound: 'Round 1', allotmentStatus: 'Allotted', studentName: 'X Y' },
    { applicationId: 'MH2026-60001', capRound: 'Round 3' },
    { applicationId: 'MH2026-60001', capPassword: 'Sup3r-Secret-CAP-Pass' },
    { applicationId: 'MH2026-60001', password: 'Sup3r-Secret-CAP-Pass', status: 'verified', verified: true, linkedStudentId: 1 },
  ];
  for (const body of attempts) {
    const r = await call('PUT', '/api/cap-details', body, s.cookie);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'READ_ONLY_FIELDS');
    assert.ok(!JSON.stringify(r.json).includes('Sup3r-Secret'), 'rejected values are never echoed');
    assert.ok(!JSON.stringify(r.json).includes('Elite College'));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cap_details').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cap_claims').get().n, 0, 'a refused request leaves nothing behind');
  // no table anywhere contains the secret, and the new tables have no credential column
  const secret = 'Sup3r-Secret-CAP-Pass';
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
    if (name.startsWith('cap_')) assert.ok(!cols.some((c) => /pass|secret|credential|pin|token/i.test(c)), `${name} has a credential-like column`);
    for (const row of db.prepare(`SELECT * FROM ${name}`).all()) assert.ok(!JSON.stringify(row).includes(secret), `${name} stores the secret`);
  }
  // the legitimate request still works
  assert.equal((await claim(s, 'MH2026-60001')).status, 200);
});

// =============================================================================================== validation
test('record input is validated', async () => {
  const bad = await create({ applicationId: '!!', candidateName: '', allottedCollege: 'ab', courseBranch: 'x', capRound: 'Round 9', allotmentStatus: 'Nope', sourceNote: 'x'.repeat(201) });
  assert.equal(bad.status, 400);
  for (const f of ['applicationId', 'studentName', 'allottedCollege', 'courseBranch', 'capRound', 'allotmentStatus', 'sourceNote']) assert.ok(bad.json.errors[f], f);
  for (const id of ['abc', 'a'.repeat(21), 'MH 2026', 'MH2026_1', '-MH20261', "MH2026';--"]) assert.equal((await create(rec({ applicationId: id }))).status, 400, id);
  assert.equal((await create({})).status, 400);
  assert.equal((await create(rec({ candidateName: '12345' }))).status, 400);
  assert.equal((await call('GET', Q('/records/abc'), undefined, A.officerC)).status, 404);
  assert.equal((await call('GET', Q('/records/99999'), undefined, A.officerC)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cap_allotment_records').get().n, 0);
  // IDs are normalised: whitespace trimmed, upper-cased
  const ok = await create(rec({ applicationId: '  mh2026-50077 ' }));
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.record.applicationId, 'MH2026-50077');
  assert.equal(ok.json.data.record.status, 'pending_verification');
  db.prepare("DELETE FROM cap_allotment_records WHERE application_id = 'MH2026-50077'").run();
});

test('a student must submit a well-formed application ID', async () => {
  const s = await student('Format Student');
  for (const id of ['', '   ', 'abc', 'x'.repeat(21), 'MH 2026 1', 'MH2026_1', '../etc/passwd', null, 12345, { $ne: 1 }, ['MH2026-1']]) {
    const r = await call('PUT', '/api/cap-details', { applicationId: id }, s.cookie);
    assert.equal(r.status, 400, JSON.stringify(id));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cap_claims WHERE student_id = ?").get(s.id).n, 0);
});

// =============================================================================================== valid records
test('valid record: staff add it, a DIFFERENT admin verifies it, the student sees read-only details', async () => {
  const s = await student('Asha Kulkarni');
  const created = await create(rec({ applicationId: 'MH2026-50001', candidateName: 'KULKARNI ASHA SANJAY' }));
  assert.equal(created.status, 201);
  const id = created.json.data.record.id;
  assert.equal(created.json.data.record.enteredBy, 'Omkar Officer');

  // before verification the student gets nothing, not even a hint that the record exists
  const early = await claim(s, 'mh2026-50001');
  assert.equal(early.status, 200);
  assert.equal(early.json.data.result, 'pending');
  assert.equal(early.json.data.capDetails, null);
  assert.ok(!JSON.stringify(early.json).includes('College of Engineering'));
  const d1 = (await call('GET', '/api/dashboard', undefined, s.cookie)).json.data;
  assert.equal(d1.cap, null);
  assert.equal(d1.capVerification.status, 'pending');
  assert.equal(d1.overallStatus, 'Getting Started');
  const task = d1.tasks.find((t) => t.key === 'cap_details');
  assert.deepEqual([task.status, task.statusLabel, task.editable], ['in_progress', 'Verification Pending', true]);
  assert.equal((await call('GET', '/api/checklist', undefined, s.cookie)).status, 409);

  // the admin who entered the record cannot verify it (four-eyes)...
  const self = await verify(id, A.officerC);
  assert.equal(self.status, 403);
  assert.equal(self.json.code, 'FOUR_EYES');
  assert.equal(recordRow(id).status, 'pending_verification');
  const listed = (await call('GET', Q('/records?status=pending_verification'), undefined, A.officerC)).json.data.items.find((r) => r.id === id);
  assert.deepEqual([listed.canVerify, !!listed.verifyBlockedReason], [false, true]);
  // ...a different admin can; the waiting student is linked automatically
  const ok = await verify(id, A.officer2C, { remarks: 'Checked against the CAP list' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.record.status, 'verified');
  assert.equal(ok.json.data.record.verifiedBy, 'Olga Officer');
  assert.equal(ok.json.data.record.linkedStudent.id, s.id);

  const mine = await state(s);
  assert.equal(mine.verification.status, 'verified');
  assert.deepEqual([mine.capDetails.applicationId, mine.capDetails.allottedCollege, mine.capDetails.courseBranch, mine.capDetails.capRound, mine.capDetails.allotmentStatus, mine.capDetails.verified],
    ['MH2026-50001', 'College of Engineering Pune', 'Computer Engineering', 'Round 1', 'Allotted', true]);
  const d2 = (await call('GET', '/api/dashboard', undefined, s.cookie)).json.data;
  assert.equal(d2.tasks.find((t) => t.key === 'cap_details').status, 'completed');
  assert.equal(d2.tasks.find((t) => t.key === 'cap_details').editable, false);
  assert.equal(d2.progress.total, 6);
  assert.equal((await call('GET', '/api/checklist', undefined, s.cookie)).status, 200, 'tasks unlock once verified');
  // admin view of the student shows what backs the details
  const detail = (await call('GET', `/api/admin/students/${s.id}`, undefined, A.officerC)).json.data;
  assert.equal(detail.cap.applicationId, 'MH2026-50001');
  assert.equal(detail.capVerification.record.verifiedBy, 'Olga Officer');
  assert.equal(detail.capVerification.record.sourceLabel, 'Entered manually by staff');
  // read-only for the student from now on
  assert.equal((await claim(s, 'MH2026-50002')).status, 409);
  assert.equal((await call('PUT', '/api/cap-details', { applicationId: 'MH2026-50001', capRound: 'Round 3' }, s.cookie)).status, 400);
  assert.equal((await state(s)).capDetails.capRound, 'Round 1');
  s.id1 = id; A.ashaStudent = s;
});

test('a record that is already verified links the student immediately; a super admin may verify their own entry', async () => {
  const sa = await create(rec({ applicationId: 'MH2026-50002', candidateName: 'Rao Bina' }), A.saC);
  assert.equal((await verify(sa.json.data.record.id, A.saC)).status, 200, 'super admins are exempt from the four-eyes rule');
  const s = await student('Bina Rao');
  const r = await claim(s, 'MH2026-50002');
  assert.equal(r.json.data.result, 'linked');
  assert.equal(r.json.data.capDetails.applicationId, 'MH2026-50002');
  assert.equal((await verify(sa.json.data.record.id, A.saC)).json.code, 'ALREADY_VERIFIED');
});

test('name matching: word order and father\'s name do not matter, other people\'s names do', () => {
  const m = capRecordService.namesMatch;
  assert.equal(m('Meera Kulkarni', 'KULKARNI MEERA SANJAY'), true);
  assert.equal(m('Meera Sanjay Kulkarni', 'Kulkarni Meera'), true);
  assert.equal(m('José García', 'GARCÍA JOSÉ'), true);
  assert.equal(m('Meera', 'Meera'), true);
  assert.equal(m('Meera', 'Meera Kulkarni'), false, 'a one-word name must match exactly');
  assert.equal(m('Meera K', 'Meera Kulkarni'), false);
  assert.equal(m('Ravi Kale', 'Ravi Kalyan'), false);
  assert.equal(m('Ravi Kale', 'Sunil Patil'), false);
  assert.equal(m('', 'Ravi Kale'), false);
  assert.equal(m('!!!', '???'), false);
});

// =============================================================================================== missing records / pending
test('missing, unverified, revoked, mismatched and taken IDs all look the same to the student', async () => {
  const mismatch = await create(rec({ applicationId: 'MH2026-50010', candidateName: 'SOMEONE ELSE' })); await verify(mismatch.json.data.record.id);
  const unverified = await create(rec({ applicationId: 'MH2026-50011', candidateName: 'Pending Person' }));
  const revoked = await create(rec({ applicationId: 'MH2026-50012', candidateName: 'Revoked Person' }));
  assert.equal((await call('POST', Q(`/records/${revoked.json.data.record.id}/revoke`), { remarks: 'Entered from the wrong list' }, A.officer2C)).status, 200);
  const taken = 'MH2026-50001';   // linked to Asha in the earlier test

  const outcomes = [];
  for (const [i, id] of ['MH2026-59999', 'MH2026-50010', 'MH2026-50011', 'MH2026-50012', taken].entries()) {
    const s = await student(`Outsider ${'ABCDE'[i]}`);
    const r = await claim(s, id);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.result, 'pending');
    assert.equal(r.json.data.capDetails, null);
    outcomes.push(JSON.stringify({ message: r.json.message, verification: { ...r.json.data.verification, applicationId: 'X', submittedAt: 'X' } }));
    assert.ok(!/SOMEONE ELSE|Pending Person|Revoked Person|Asha|College of Engineering/.test(JSON.stringify(r.json)), 'no record data leaks');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cap_details WHERE student_id = ?').get(s.id).n, 0);
  }
  assert.equal(new Set(outcomes).size, 1, 'identical responses: the student cannot probe which IDs exist');

  // the admin, however, sees exactly why each one is waiting
  const claims = (await call('GET', Q('/claims'), undefined, A.officerC)).json.data.items;
  const reason = (id) => claims.find((c) => c.applicationId === id).reason;
  assert.equal(reason('MH2026-59999'), 'not_found');
  assert.equal(reason('MH2026-50010'), 'name_mismatch');
  assert.equal(reason('MH2026-50011'), 'not_verified');
  assert.equal(reason('MH2026-50012'), 'revoked');
  assert.equal(reason(taken), 'already_linked');
  assert.equal(claims.find((c) => c.applicationId === taken).record.linkedElsewhere, true);
  // Asha's details were not touched by the second claim on her ID
  assert.equal((await state(A.ashaStudent)).capDetails.applicationId, taken);
  assert.equal(recordRow(A.ashaStudent.id1).linked_student_id, A.ashaStudent.id);
});

test('a student can change or withdraw a pending submission; one pending claim at a time', async () => {
  const s = await student('Changing Mind');
  await claim(s, 'MH2026-70001');
  await claim(s, 'MH2026-70002');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cap_claims WHERE student_id = ? AND status = 'pending'").get(s.id).n, 1);
  assert.equal((await state(s)).verification.applicationId, 'MH2026-70002');
  const w = await call('DELETE', '/api/cap-details', undefined, s.cookie);
  assert.equal(w.status, 200);
  assert.equal(w.json.data.verification.status, 'none');
  assert.equal((await call('DELETE', '/api/cap-details', undefined, s.cookie)).status, 404);
});

test('claims waiting on an ID are linked when a record is added and verified later (even from a CSV import)', async () => {
  const s = await student('Late Record');
  await claim(s, 'MH2026-70100');
  assert.equal((await state(s)).verification.status, 'pending');
  const imp = await call('POST', Q('/records/import'), { csv: 'MH2026-70100,LATE RECORD,COEP,Computer,Round 2,Allotted' }, A.officerC);
  assert.equal(imp.json.data.created, 1);
  assert.equal((await state(s)).verification.status, 'pending', 'imported records are pending too');
  assert.equal((await call('GET', Q('/claims'), undefined, A.officerC)).json.data.items.find((c) => c.student.id === s.id).reason, 'not_verified');
  const id = db.prepare("SELECT id FROM cap_allotment_records WHERE application_id = 'MH2026-70100'").get().id;
  await verify(id);
  assert.equal((await state(s)).capDetails.capRound, 'Round 2');
});

test('claims: admins approve a name mismatch (with remarks) or reject with a reason the student sees', async () => {
  const s = await student('Nickname Student');
  const r = await create(rec({ applicationId: 'MH2026-70200', candidateName: 'COMPLETELY DIFFERENT NAME' })); await verify(r.json.data.record.id);
  await claim(s, 'MH2026-70200');
  const c = (await call('GET', Q('/claims'), undefined, A.officerC)).json.data.items.find((x) => x.student.id === s.id);
  assert.equal(c.canApprove, true);
  const noRemarks = await call('POST', Q(`/claims/${c.id}/approve`), {}, A.officerC);
  assert.equal(noRemarks.status, 400, 'a name mismatch needs a reason');
  assert.equal((await call('POST', Q(`/claims/${c.id}/approve`), { remarks: 'Student showed the allotment letter at the desk' }, A.viewerC)).status, 403);
  assert.equal((await call('POST', Q(`/claims/${c.id}/approve`), { remarks: 'Student showed the allotment letter at the desk' }, A.officerC)).status, 200);
  assert.equal((await state(s)).verification.status, 'verified');
  const hist = (await call('GET', Q(`/records/${r.json.data.record.id}`), undefined, A.officerC)).json.data.history;
  assert.equal(hist[0].event, 'linked');
  assert.equal(hist[0].details.adminApproved, true);

  const t = await student('Rejected Student');
  await claim(t, 'MH2026-70999');
  const claimId = (await call('GET', Q('/claims'), undefined, A.officerC)).json.data.items.find((x) => x.student.id === t.id).id;
  assert.equal((await call('POST', Q(`/claims/${claimId}/reject`), {}, A.officerC)).status, 400, 'a reason is required');
  assert.equal((await call('POST', Q(`/claims/${claimId}/reject`), { note: 'ID not on the Round 1 list' }, A.officerC)).status, 200);
  const st = await state(t);
  assert.equal(st.verification.status, 'rejected');
  assert.match(st.verification.message, /ID not on the Round 1 list/);
  assert.equal((await claim(t, 'MH2026-70998')).json.data.verification.status, 'pending', 'they can submit again');
  assert.equal((await call('POST', Q(`/claims/${claimId}/reject`), { note: 'again again' }, A.officerC)).status, 404, 'already resolved');
});

test('too many wrong guesses are rate limited per student', async () => {
  const s = await student('Guessing Student');
  let last;
  for (let i = 0; i < 10; i += 1) last = await claim(s, `MH2026-8${String(i).padStart(4, '0')}`);
  assert.equal(last.status, 200);
  const blocked = await claim(s, 'MH2026-80099');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.code, 'RATE_LIMITED');
  const other = await student('Innocent Student');
  assert.equal((await claim(other, 'MH2026-80099')).status, 200, 'other students are unaffected');
});

// =============================================================================================== duplicates
test('duplicate application IDs are refused everywhere', async () => {
  const r = await create(rec({ applicationId: 'MH2026-51000', candidateName: 'First Entry' }));
  assert.equal(r.status, 201);
  for (const id of ['MH2026-51000', 'mh2026-51000', '  Mh2026-51000  ']) {
    const dup = await create(rec({ applicationId: id, candidateName: 'Second Entry' }), A.saC);
    assert.equal(dup.status, 409, id);
    assert.equal(dup.json.code, 'DUPLICATE_APPLICATION_ID');
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cap_allotment_records WHERE application_id = 'MH2026-51000'").get().n, 1);
  // the database itself refuses it, whatever the application code does
  assert.throws(() => db.prepare("INSERT INTO cap_allotment_records (application_id, candidate_name, allotted_college, course_branch, cap_round, allotment_status, source, entered_by_name) VALUES ('MH2026-51000', 'x', 'x', 'x', 'Round 1', 'Allotted', 'manual_entry', 'x')").run(), /UNIQUE/);
  // editing a record onto an ID that exists is refused
  const other = await create(rec({ applicationId: 'MH2026-51001', candidateName: 'Other Entry' }));
  const edit = await call('PUT', Q(`/records/${other.json.data.record.id}`), rec({ applicationId: 'MH2026-51000', candidateName: 'Other Entry', remarks: 'Fixing a typo in the ID' }), A.officerC);
  assert.equal(edit.status, 409);
  assert.equal(edit.json.code, 'DUPLICATE_APPLICATION_ID');
  assert.equal(recordRow(other.json.data.record.id).application_id, 'MH2026-51001');
  // a student can never be linked to two records, nor a record to two students
  const [a, b] = [await student('Double Link A'), await student('Double Link B')];
  for (const [i, s] of [[0, a], [1, b]]) { const x = await create(rec({ applicationId: `MH2026-5110${i}`, candidateName: s.name })); await verify(x.json.data.record.id); await claim(s, `MH2026-5110${i}`); }
  const ra = db.prepare("SELECT id FROM cap_allotment_records WHERE application_id = 'MH2026-51100'").get().id;
  assert.throws(() => db.prepare('UPDATE cap_allotment_records SET linked_student_id = ? WHERE application_id = ?').run(b.id, 'MH2026-51100'), /UNIQUE/);
  assert.equal(recordRow(ra).linked_student_id, a.id);
  // two students racing for the same verified record: exactly one wins
  const x = await create(rec({ applicationId: 'MH2026-51200', candidateName: 'Shared Name' })); await verify(x.json.data.record.id);
  const [p, q] = [await student('Shared Name'), await student('Shared Name')];
  const [rp, rq] = await Promise.all([claim(p, 'MH2026-51200'), claim(q, 'MH2026-51200')]);
  assert.deepEqual([rp.json.data.result, rq.json.data.result].sort(), ['linked', 'pending']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cap_details WHERE application_id = ?').get('MH2026-51200').n, 1);
});

test('CSV import: valid rows are created pending; bad rows and duplicates are skipped with reasons; nothing is overwritten', async () => {
  await create(rec({ applicationId: 'MH2026-52001', candidateName: 'Already Here' }));
  const csv = [
    'application_id,candidate_name,allotted_college,course_branch,cap_round,allotment_status',
    'MH2026-52002,"PATIL, ROHAN",College of Engineering Pune,Computer Engineering,Round 1,Allotted',
    '',
    'mh2026-52003,JOSHI MEERA,"Government College of Engineering, Aurangabad",Information Technology,Round 2,Allotted (Float)',
    'MH2026-52002,DUPLICATE IN FILE,COEP,Computer,Round 1,Allotted',
    'MH2026-52001,OVERWRITE ATTEMPT,COEP,Computer,Round 1,Allotted',
    'BAD,X,COEP,Computer,Round 1,Allotted',
    'MH2026-52004,ONLY,THREE,COLUMNS',
    'MH2026-52005,SHAH KABIR,COEP,Computer,Round 9,Allotted',
  ].join('\r\n');
  const r = await call('POST', Q('/records/import'), { csv, sourceNote: 'CET Cell list, Round 1' }, A.officerC);
  assert.equal(r.status, 201);
  assert.equal(r.json.data.created, 2);
  assert.equal(r.json.data.skipped.length, 5);
  const why = Object.fromEntries(r.json.data.skipped.map((s) => [s.line, s.reason]));
  assert.match(why[5], /Duplicate of line 2/);
  assert.match(why[6], /Already exists/);
  assert.match(why[7], /Application ID/);
  assert.match(why[8], /Expected 6 columns/);
  assert.match(why[9], /CAP round/);
  const rows = db.prepare("SELECT * FROM cap_allotment_records WHERE application_id IN ('MH2026-52002', 'MH2026-52003') ORDER BY application_id").all();
  assert.deepEqual(rows.map((x) => [x.candidate_name, x.status, x.source, x.source_note]), [['PATIL, ROHAN', 'pending_verification', 'csv_import', 'CET Cell list, Round 1'], ['JOSHI MEERA', 'pending_verification', 'csv_import', 'CET Cell list, Round 1']]);
  assert.equal(db.prepare("SELECT candidate_name FROM cap_allotment_records WHERE application_id = 'MH2026-52001'").get().candidate_name, 'Already Here');
  assert.equal(db.prepare("SELECT event FROM cap_record_history WHERE record_id = ?").get(rows[0].id).event, 'imported');
  assert.equal((await call('POST', Q('/records/import'), { csv: '' }, A.officerC)).status, 400);
  assert.equal((await call('POST', Q('/records/import'), {}, A.officerC)).status, 400);
  const many = Array.from({ length: 501 }, (_, i) => `MH2026-6${String(i).padStart(4, '0')},N${'a'.repeat(3)} Name,COEP,Computer,Round 1,Allotted`).join('\n');
  assert.equal((await call('POST', Q('/records/import'), { csv: many }, A.officerC)).status, 400, 'at most 500 rows');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cap_allotment_records WHERE application_id LIKE 'MH2026-6%'").get().n, 0, 'an oversized import creates nothing');
});

// =============================================================================================== corrections and audit
test('corrections need remarks, keep the student in step, and are audited with before/after values', async () => {
  const s = await student('Correction Student');
  const c = await create(rec({ applicationId: 'MH2026-53000', candidateName: 'Correction Student', capRound: 'Round 1' }));
  const id = c.json.data.record.id;
  await verify(id); await claim(s, 'MH2026-53000');
  const before = (await state(s)).capDetails;

  const put = (body, cookie = A.officerC) => call('PUT', Q(`/records/${id}`), body, cookie);
  assert.equal((await put(rec({ applicationId: 'MH2026-53000', candidateName: 'Correction Student', capRound: 'Round 2' }))).status, 400, 'remarks are mandatory');
  assert.equal((await put(rec({ applicationId: 'MH2026-53000', candidateName: 'Correction Student', capRound: 'Round 2', remarks: 'abc' }))).status, 400);
  assert.equal((await put(rec({ applicationId: 'MH2026-53000', candidateName: 'Correction Student', capRound: 'Round 2', remarks: 'Round corrected from the list' }), A.viewerC)).status, 403);
  const nochange = await put({ ...rec({ applicationId: 'MH2026-53000', candidateName: 'Correction Student', capRound: 'Round 1' }), remarks: 'Nothing to change really' });
  assert.equal(nochange.status, 400);
  assert.equal(nochange.json.code, 'NO_CHANGE');
  const ok = await put({ ...rec({ applicationId: 'MH2026-53000', candidateName: 'Correction Student', capRound: 'Round 2', allotmentStatus: 'Allotted (Float)', allottedCollege: 'Corrected College Name' }), remarks: 'Corrected from the Round 2 list' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.record.status, 'verified', 'a correction by an authorised admin keeps the record verified');

  const after = (await state(s)).capDetails;
  assert.deepEqual([after.capRound, after.allotmentStatus, after.allottedCollege], ['Round 2', 'Allotted (Float)', 'Corrected College Name']);
  assert.notEqual(after.capRound, before.capRound);
  const hist = (await call('GET', Q(`/records/${id}`), undefined, A.officerC)).json.data.history;
  assert.deepEqual(hist.map((h) => h.event), ['edited', 'linked', 'verified', 'created']);
  const edited = hist[0];
  assert.equal(edited.actorName, 'Omkar Officer');
  assert.equal(edited.remarks, 'Corrected from the Round 2 list');
  assert.deepEqual(edited.details.changes.capRound, { from: 'Round 1', to: 'Round 2' });
  assert.deepEqual(edited.details.changes.allotmentStatus, { from: 'Allotted', to: 'Allotted (Float)' });
  assert.ok(hist.every((h) => h.createdAt && h.actorName));
  assert.equal(hist.find((h) => h.event === 'linked').actorType, 'student');
  assert.equal(hist.find((h) => h.event === 'verified').actorName, 'Olga Officer');
  // the application ID of a linked record is locked
  const lock = await put({ ...rec({ applicationId: 'MH2026-53999', candidateName: 'Correction Student' }), remarks: 'Trying to change the ID' });
  assert.equal(lock.status, 409);
  assert.equal(lock.json.code, 'LINKED_ID_LOCKED');
  // the admin activity log also records it, with the admin's identity
  const log = (await call('GET', '/api/admin/activity?group=cap&pageSize=100', undefined, A.saC)).json.data.items;
  const act = log.find((i) => i.action === 'cap.edit' && i.summary.includes('MH2026-53000'));
  assert.equal(act.admin.name, 'Omkar Officer');
  assert.equal(act.student.name, 'Correction Student');
  assert.ok(['cap.create', 'cap.verify', 'cap.edit'].every((a) => log.some((i) => i.action === a)));
});

test('unlinking removes the student\'s details and their waiting queue token; revoke and re-verify follow the rules', async () => {
  const s = await student('Unlink Student');
  const r = await create(rec({ applicationId: 'MH2026-54000', candidateName: 'Unlink Student' }));
  const id = r.json.data.record.id;
  await verify(id); await claim(s, 'MH2026-54000');
  db.prepare("INSERT INTO appointments (student_id, appointment_date, appointment_time, venue, created_by_name, updated_by_name) VALUES (?, ?, '10:00', 'Admission Cell', 'seed', 'seed')").run(s.id, time.today());
  const token = (await call('POST', '/api/admin/queue/check-in', { studentId: s.id }, A.officerC)).json.data.token;
  assert.equal(token.status, 'waiting');

  assert.equal((await call('POST', Q(`/records/${id}/revoke`), { remarks: 'Wrong person linked to this ID' }, A.officer2C)).json.code, 'UNLINK_FIRST');
  assert.equal((await call('POST', Q(`/records/${id}/unlink`), {}, A.officerC)).status, 400, 'remarks required');
  assert.equal((await call('POST', Q(`/records/${id}/unlink`), { remarks: 'Linked to the wrong account' }, A.viewerC)).status, 403);
  const un = await call('POST', Q(`/records/${id}/unlink`), { remarks: 'Linked to the wrong account' }, A.officerC);
  assert.equal(un.status, 200);
  assert.equal(un.json.data.record.linkedStudent, null);
  assert.equal((await state(s)).capDetails, null);
  assert.equal((await state(s)).verification.status, 'none');
  assert.equal((await call('POST', Q(`/records/${id}/unlink`), { remarks: 'Doing it twice' }, A.officerC)).json.code, 'NOT_LINKED');
  const q = (await call('GET', '/api/admin/queue', undefined, A.officerC)).json.data;
  assert.equal(q.waiting.length, 0, 'the student left the verification queue');
  assert.match(db.prepare('SELECT finish_reason FROM queue_tokens WHERE id = ?').get(token.id).finish_reason, /CAP details are no longer linked/);

  // revoke -> students cannot link; correcting a revoked record sends it back to pending; it must be verified again
  const rv = await call('POST', Q(`/records/${id}/revoke`), { remarks: 'List had an error for this ID' }, A.officer2C);
  assert.equal(rv.json.data.record.status, 'revoked');
  assert.equal((await claim(s, 'MH2026-54000')).json.data.result, 'pending');
  assert.equal((await verify(id)).json.code, 'REVOKED');
  assert.equal((await call('POST', Q(`/records/${id}/revoke`), { remarks: 'Revoking again' }, A.officer2C)).json.code, 'ALREADY_REVOKED');
  const fix = await call('PUT', Q(`/records/${id}`), { ...rec({ applicationId: 'MH2026-54000', candidateName: 'Unlink Student', capRound: 'Round 2' }), remarks: 'Re-entered from the corrected list' }, A.officerC);
  assert.equal(fix.json.data.record.status, 'pending_verification');
  assert.equal((await verify(id, A.officerC)).json.code, 'FOUR_EYES');
  assert.equal((await verify(id, A.officer2C)).status, 200);
  assert.equal((await state(s)).capDetails.capRound, 'Round 2', 'the waiting student is linked again');
  const events = (await call('GET', Q(`/records/${id}`), undefined, A.officerC)).json.data.history.map((h) => h.event).reverse();
  assert.deepEqual(events, ['created', 'verified', 'linked', 'unlinked', 'revoked', 'edited', 'verified', 'linked']);
});

test('record list: filters and prefix search', async () => {
  const get = async (qs) => (await call('GET', Q(`/records${qs}`), undefined, A.officerC)).json.data;
  const all = await get('?pageSize=50');
  assert.equal(all.total, db.prepare('SELECT COUNT(*) AS n FROM cap_allotment_records').get().n);
  assert.deepEqual(all.counts, Object.fromEntries(['pending_verification', 'verified', 'revoked'].map((st) => [st, db.prepare('SELECT COUNT(*) AS n FROM cap_allotment_records WHERE status = ?').get(st).n])));
  assert.ok((await get('?status=verified')).items.every((i) => i.status === 'verified'));
  assert.ok((await get('?linked=yes')).items.every((i) => i.linkedStudent));
  assert.ok((await get('?linked=no')).items.every((i) => !i.linkedStudent));
  assert.deepEqual((await get('?search=mh2026-5300')).items.map((i) => i.applicationId), ['MH2026-53000']);
  assert.deepEqual((await get('?search=correction')).items.map((i) => i.applicationId), ['MH2026-53000']);
  assert.equal((await get('?search=%25')).total, 0);
  assert.equal((await get("?search='%20OR%201=1--")).total, 0);
  assert.ok((await get('?search=MH2026-5')).total >= 5);
  assert.equal((await get('?pageSize=3&page=2')).items.length, 3);
  assert.ok(typeof (await get('')).pendingClaims === 'number');
});

// =============================================================================================== legacy data
test('start-up migration: student-typed CAP rows become pending records and claims, nothing is lost, and it is idempotent', async () => {
  const s = await student('Legacy Student'); const t = await student('Legacy Mismatch');
  const legacy = (st, appId, nm) => db.prepare("INSERT INTO cap_details (student_id, application_id, student_name, allotted_college, course_branch, cap_round, allotment_status) VALUES (?, ?, ?, 'Typed College', 'Typed Branch', 'Round 3', 'Allotted')").run(st.id, appId, nm);
  legacy(s, 'MH2026-55001', 'Legacy Student'); legacy(t, 'MH2026-55002', 'Some Other Typed Name');
  const verifiedBefore = db.prepare("SELECT COUNT(*) AS n FROM cap_details").get().n - 2;

  assert.equal(migrateLegacy(db), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cap_details").get().n, verifiedBefore, 'only the verified, linked rows remain');
  assert.equal(migrateLegacy(db), 0, 'a second run changes nothing');
  const r = db.prepare("SELECT * FROM cap_allotment_records WHERE application_id = 'MH2026-55001'").get();
  assert.deepEqual([r.status, r.source, r.allotted_college, r.cap_round, r.candidate_name, r.linked_student_id], ['pending_verification', 'legacy_student_entry', 'Typed College', 'Round 3', 'Legacy Student', null]);
  assert.equal(db.prepare('SELECT event FROM cap_record_history WHERE record_id = ?').get(r.id).event, 'migrated');
  assert.equal((await state(s)).capDetails, null);
  assert.equal((await state(s)).verification.status, 'pending');
  assert.equal((await state(s)).verification.applicationId, 'MH2026-55001');

  // verifying the migrated record re-creates the student's details; a different typed name needs admin approval
  await verify(r.id);
  assert.equal((await state(s)).capDetails.allottedCollege, 'Typed College');
  const r2 = db.prepare("SELECT id FROM cap_allotment_records WHERE application_id = 'MH2026-55002'").get().id;
  await verify(r2);
  assert.equal((await state(t)).verification.status, 'pending');
  assert.equal((await call('GET', Q('/claims'), undefined, A.officerC)).json.data.items.find((c) => c.student.id === t.id).reason, 'name_mismatch');
});

// =============================================================================================== lookup design (DSA decision)
test('lookups by application ID use the database\'s unique index; the C++ engine is not on this path', async () => {
  const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((p) => p.detail).join(' | ');
  assert.match(plan('SELECT * FROM cap_allotment_records WHERE application_id = ?', 'MH2026-1'), /SEARCH .* USING INDEX sqlite_autoindex_cap_allotment_records_1 \(application_id=\?\)/);
  assert.match(plan('SELECT * FROM cap_allotment_records WHERE application_id >= ? AND application_id < ?', 'MH2026-5', 'MH2026-6'), /USING INDEX sqlite_autoindex_cap_allotment_records_1 \(application_id>\? AND application_id<\?\)/);
  assert.match(plan('SELECT * FROM cap_details WHERE application_id = ?', 'MH2026-1'), /USING INDEX/);
  assert.match(plan("SELECT * FROM cap_claims WHERE application_id = ? AND status = 'pending'", 'MH2026-1'), /USING INDEX idx_cap_claims_app/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'capRecordService.js'), 'utf8');
  assert.ok(!/queueService|withEngine|toolkit|QueueEngine/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'CAP verification never depends on the engine process');
});

test('the existing admin search (binary search in the C++ engine) needs an admin session and only knows verified, linked students', async () => {
  assert.equal((await call('GET', '/api/admin/search?q=MH2026-5')).status, 401);
  const s = await student('Search Student');
  const r = await create(rec({ applicationId: 'MH2026-56000', candidateName: 'Search Student' }));
  const hit = async (q) => (await call('GET', `/api/admin/search?q=${q}`, undefined, A.officerC)).json.data.results.map((x) => x.name);
  assert.deepEqual(await hit('MH2026-56000'), [], 'an unverified record is not searchable as a student');
  await verify(r.json.data.record.id);
  assert.deepEqual(await hit('MH2026-56000'), [], 'still not: nobody is linked to it yet');
  await claim(s, 'MH2026-56000');
  assert.deepEqual(await hit('MH2026-56000'), ['Search Student']);
  assert.equal((await call('GET', '/api/admin/search?q=MH2026-56000', undefined, A.viewerC)).status, 200, 'unchanged: viewers may search students (not CAP records)');
});
