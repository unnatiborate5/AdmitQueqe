'use strict';
// End-to-end API test: Register -> Login -> CAP verification -> Dashboard -> Checklist -> Logout.
// Run with: npm test   (uses a temporary SQLite file, never your real database)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const app = require('../app');
const db = require('../config/db');
const { linkVerified, ensureActors } = require('./helpers/capHelper');
const capRecordService = require('../services/capRecordService');

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

async function upload(url, slot, filename, bytes, type, cookie) {
  const body = new FormData();
  body.append('slot', slot);
  body.append('file', new Blob([bytes], { type }), filename);
  const res = await fetch(base + url, { method: 'POST', headers: { Cookie: cookie }, body });
  return { status: res.status, json: await res.json().catch(() => null) };
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

test('checklist and task endpoints are blocked until CAP details exist', async () => {
  const r = await call('GET', '/api/checklist', undefined, sid);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'CAP_DETAILS_REQUIRED');
  assert.equal((await call('GET', '/api/tasks/admission_form', undefined, sid)).status, 409);
  const p = await call('PUT', '/api/tasks/admission_form', { status: 'completed', eventDate: '2026-09-01' }, sid);
  assert.equal(p.status, 409);
});

test('CAP details are read-only for students: only an application ID can be submitted, and it must be verified', async () => {
  // no free-text allotment fields are accepted, whatever they say
  const edit = await call('PUT', '/api/cap-details', cap, sid);
  assert.equal(edit.status, 400);
  assert.equal(edit.json.code, 'READ_ONLY_FIELDS');
  for (const f of ['studentName', 'allottedCollege', 'courseBranch', 'capRound', 'allotmentStatus']) assert.ok(edit.json.errors[f], f);
  assert.equal((await call('PUT', '/api/cap-details', { applicationId: '!!' }, sid)).status, 400);
  assert.equal((await call('PUT', '/api/cap-details', {}, sid)).status, 400);
  const empty = await call('GET', '/api/cap-details', undefined, sid);
  assert.equal(empty.json.data.capDetails, null);
  assert.equal(empty.json.data.verification.status, 'none');

  // an ID with no verified record -> "verification pending", no details
  const pending = await call('PUT', '/api/cap-details', { applicationId: 'mh2026-12345' }, sid);
  assert.equal(pending.status, 200);
  assert.equal(pending.json.data.result, 'pending');
  assert.equal(pending.json.data.capDetails, null);
  assert.equal(pending.json.data.verification.status, 'pending');
  assert.equal(pending.json.data.verification.applicationId, 'MH2026-12345');
  assert.match(pending.json.data.verification.message, /Verification pending/);
  assert.equal((await call('GET', '/api/checklist', undefined, sid)).status, 409, 'tasks stay locked while verification is pending');

  // staff add the record from the CAP list and a different admin verifies it: the student is linked automatically
  const a = ensureActors();
  const rec = capRecordService.create(a.entry, { applicationId: 'MH2026-12345', candidateName: 'KULKARNI ALICE', allottedCollege: 'College of Engineering Pune', courseBranch: 'Computer Engineering', capRound: 'Round 2', allotmentStatus: 'Allotted' });
  assert.equal((await call('GET', '/api/cap-details', undefined, sid)).json.data.capDetails, null, 'an unverified record is not trusted');
  capRecordService.verify(a.verifier, rec.id, {});
  const ok = await call('GET', '/api/cap-details', undefined, sid);
  assert.equal(ok.json.data.capDetails.applicationId, 'MH2026-12345');
  assert.equal(ok.json.data.capDetails.capRound, 'Round 2');
  assert.equal(ok.json.data.capDetails.verified, true);
  assert.equal(ok.json.data.verification.status, 'verified');

  // once verified the details cannot be changed by the student
  assert.equal((await call('PUT', '/api/cap-details', { applicationId: 'MH2026-99999' }, sid)).status, 409);
  assert.equal((await call('PUT', '/api/cap-details', { ...cap, capRound: 'Round 1' }, sid)).status, 400);
  assert.equal((await call('GET', '/api/cap-details', undefined, sid)).json.data.capDetails.capRound, 'Round 2');
});

test('an application ID cannot be taken over by another account', async () => {
  const bob = { fullName: 'Bob Patil', email: 'bob@example.com', phone: '9123456780', password: 'Passw0rd123', confirmPassword: 'Passw0rd123' };
  assert.equal((await call('POST', '/api/auth/register', bob)).status, 201);
  const login = await call('POST', '/api/auth/login', { email: bob.email, password: bob.password });
  const r = await call('PUT', '/api/cap-details', { applicationId: cap.applicationId }, login.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.result, 'pending', "Bob is not linked to Alice's record (and is not told whose it is)");
  assert.equal(r.json.data.capDetails, null);
  assert.ok(!JSON.stringify(r.json).includes('Kulkarni') && !JSON.stringify(r.json).includes('College of Engineering'));
  assert.equal((await call('GET', '/api/cap-details', undefined, login.cookie)).json.data.capDetails, null);
  assert.equal((await call('GET', '/api/cap-details', undefined, sid)).json.data.capDetails.applicationId, 'MH2026-12345', "Alice's link is untouched");
});

test('checklist lists five items with the right sources and no PATCH shortcut', async () => {
  const list = await call('GET', '/api/checklist', undefined, sid);
  assert.equal(list.status, 200);
  const items = list.json.data.items;
  assert.equal(items.length, 5);
  assert.ok(items.every((i) => i.status === 'not_started'));
  assert.equal(items.find((i) => i.key === 'physical_verification').editable, false);
  assert.equal(items.find((i) => i.key === 'document_preparation').statusSource, 'documents');
  // the old quick-status endpoint no longer exists, so nothing can bypass the task forms
  const patch = await call('PATCH', '/api/checklist/physical_verification', { status: 'completed' }, sid);
  assert.equal(patch.status, 404);
});

test('task evidence uploads validate content and stay inside the student session', async () => {
  const bad = await upload('/api/tasks/allotment_acceptance/uploads', 'receipt', 'receipt.txt', 'not a document', 'text/plain', sid);
  assert.equal(bad.status, 400);
  const good = await upload('/api/tasks/allotment_acceptance/uploads', 'receipt', 'receipt.pdf', Buffer.from('%PDF-1.4\nproof'), 'application/pdf', sid);
  assert.equal(good.status, 201);
  const file = good.json.data.file;
  const own = await fetch(base + `/api/tasks/uploads/${file.id}`, { headers: { Cookie: sid } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-disposition').startsWith('attachment;'), true);
  assert.equal((await fetch(base + `/api/tasks/uploads/${file.id}`)).status, 401);
});

test('Tasks 2 and 3 show completion evidence only for completed status', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'tasks.js'), 'utf8');
  const sandbox = { window: {}, UI: { esc: (value) => String(value) } };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.window.Tasks.requiresCompletionEvidence('completed'), true);
  assert.equal(sandbox.window.Tasks.requiresCompletionEvidence('pending'), false);
  assert.equal(sandbox.window.Tasks.requiresCompletionEvidence('in_progress'), false);
});

test('Task 5 only offers a new verification request before it is pending review', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'tasks.js'), 'utf8');
  const sandbox = { window: {}, UI: { esc: (value) => String(value) } };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.window.Tasks.canRequestVerification('not_started'), true);
  assert.equal(sandbox.window.Tasks.canRequestVerification('correction_required'), true);
  assert.equal(sandbox.window.Tasks.canRequestVerification('pending_review'), false);
  assert.equal(sandbox.window.Tasks.canRequestVerification('approved'), false);
});

test('completed queue tokens expose an officer outcome action wired to the verification API', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'admin', 'queue.js'), 'utf8');
  assert.match(source, /data-act="record-outcome"/);
  assert.match(source, /Api\.put\(`\/api\/admin\/students\/\$\{t\.student\.id\}\/verification`/);
});

test('Tasks 2 and 3 require evidence only when submitting their completed state', async () => {
  const student = { fullName: 'Conditional Evidence Student', email: 'conditional-evidence@example.com', phone: '9000000003', password: 'Passw0rd123', confirmPassword: 'Passw0rd123' };
  await call('POST', '/api/auth/register', student);
  const login = await call('POST', '/api/auth/login', { email: student.email, password: student.password });
  const id = db.prepare('SELECT id FROM students WHERE email = ?').get(student.email).id;
  linkVerified(id, { applicationId: 'MH-CONDITIONAL-1', name: student.fullName });

  const submit = (key, body) => call('PUT', `/api/tasks/${key}`, { ...body, action: 'submit' }, login.cookie);
  const acceptance = { status: 'completed', eventDate: '2026-09-12' };
  const form = { status: 'completed', eventDate: '2026-09-13' };
  for (const [key, body] of [['allotment_acceptance', acceptance], ['admission_form', form]]) {
    const missing = await submit(key, body);
    assert.equal(missing.status, 400);
    assert.match(missing.json.errors.file, /Upload/i);
  }

  assert.equal((await submit('allotment_acceptance', { status: 'in_progress' })).status, 200);
  assert.equal((await submit('admission_form', { status: 'in_progress' })).status, 200);

  const pdf = Buffer.from('%PDF-1.4\ncompletion-proof');
  assert.equal((await upload('/api/tasks/allotment_acceptance/uploads', 'receipt', 'receipt.pdf', pdf, 'application/pdf', login.cookie)).status, 201);
  assert.equal((await upload('/api/tasks/admission_form/uploads', 'form', 'form.pdf', pdf, 'application/pdf', login.cookie)).status, 201);
  assert.equal((await submit('allotment_acceptance', acceptance)).status, 200);
  assert.equal((await submit('admission_form', form)).status, 200);
});

test('allotment acceptance: validation, save, persistence', async () => {
  const bad = await call('PUT', '/api/tasks/allotment_acceptance', { status: 'completed' }, sid);
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.eventDate);
  const future = await call('PUT', '/api/tasks/allotment_acceptance', { status: 'completed', eventDate: '2999-01-01' }, sid);
  assert.match(future.json.errors.eventDate, /future/);
  const junk = await call('PUT', '/api/tasks/allotment_acceptance', { status: 'maybe' }, sid);
  assert.ok(junk.json.errors.status);
  const longNote = await call('PUT', '/api/tasks/allotment_acceptance', { status: 'in_progress', note: 'x'.repeat(301) }, sid);
  assert.ok(longNote.json.errors.note);

  const ok = await call('PUT', '/api/tasks/allotment_acceptance', { status: 'completed', eventDate: '2026-09-12', note: 'Accepted via CAP login' }, sid);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.task.statusLabel, 'Submitted');
  assert.equal(ok.json.data.task.summary, 'Accepted on 12 Sep 2026');

  const again = await call('GET', '/api/tasks/allotment_acceptance', undefined, sid);
  assert.equal(again.json.data.details.eventDate, '2026-09-12');
  assert.equal(again.json.data.details.note, 'Accepted via CAP login');
  assert.equal(again.json.data.task.status, 'submitted');
});

test('admission form: status can move back and the date is cleared for not-filled', async () => {
  const sub = await call('PUT', '/api/tasks/admission_form', { status: 'in_progress', note: 'Waiting for signature' }, sid);
  assert.equal(sub.status, 200);
  assert.equal(sub.json.data.task.status, 'submitted');
  const done = await call('PUT', '/api/tasks/admission_form', { status: 'completed', eventDate: '2026-09-14' }, sid);
  assert.equal(done.json.data.task.summary, 'Submitted on 14 Sep 2026');
  const reset = await call('PUT', '/api/tasks/admission_form', { status: 'pending', eventDate: '2026-09-14' }, sid);
  assert.equal(reset.json.data.task.status, 'not_started');
  assert.equal(reset.json.data.details.eventDate, null);
  // leave it submitted for the dashboard checks below
  await call('PUT', '/api/tasks/admission_form', { status: 'completed', eventDate: '2026-09-14' }, sid);
});

test('document preparation: status is derived from the ticked documents', async () => {
  const initial = await call('GET', '/api/tasks/document_preparation', undefined, sid);
  const docs = initial.json.data.details.documents;
  assert.equal(docs.length, 9);
  assert.equal(initial.json.data.details.requiredTotal, 7);
  assert.equal(initial.json.data.task.status, 'not_started');

  assert.equal((await call('PUT', '/api/tasks/document_preparation', { preparedDocs: ['not_a_doc'] }, sid)).status, 400);
  assert.equal((await call('PUT', '/api/tasks/document_preparation', {}, sid)).status, 400);

  const some = await call('PUT', '/api/tasks/document_preparation', { preparedDocs: ['ssc_marksheet', 'hsc_marksheet', 'ssc_marksheet'] }, sid);
  assert.equal(some.json.data.task.status, 'submitted');
  assert.equal(some.json.data.details.preparedRequired, 2);
  assert.equal(some.json.data.task.summary, '2 of 7 required documents prepared');

  const optionalOnly = await call('PUT', '/api/tasks/document_preparation', { preparedDocs: ['category_certificate'] }, sid);
  assert.equal(optionalOnly.json.data.task.status, 'submitted');

  const none = await call('PUT', '/api/tasks/document_preparation', { preparedDocs: [] }, sid);
  assert.equal(none.json.data.task.status, 'not_started');

  const requiredKeys = docs.filter((d) => d.required).map((d) => d.key);
  const all = await call('PUT', '/api/tasks/document_preparation', { preparedDocs: requiredKeys }, sid);
  assert.equal(all.json.data.task.status, 'submitted');
  // persisted
  const reread = await call('GET', '/api/tasks/document_preparation', undefined, sid);
  assert.equal(reread.json.data.details.documents.filter((d) => d.prepared).length, 7);
});

test('physical verification: students can request review without an upload but never verify originals', async () => {
  const view = await call('GET', '/api/tasks/physical_verification', undefined, sid);
  assert.equal(view.status, 200);
  assert.equal(view.json.data.task.status, 'not_started');
  assert.equal(view.json.data.task.editable, false);
  assert.equal(view.json.data.details.documentsPrepared, 7);

  for (const body of [{ status: 'completed' }, { status: 'completed', verifiedBy: 'me', verifiedAt: '2026-09-20' }, {}]) {
    const r = await call('PUT', '/api/tasks/physical_verification', body, sid);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'COLLEGE_ONLY');
  }
  const submitted = await call('PUT', '/api/tasks/physical_verification', { action: 'submit', note: 'Ready for in-person verification.' }, sid);
  assert.equal(submitted.status, 200);
  assert.match(submitted.json.message, /submitted successfully for officer review/i);
  assert.equal(submitted.json.data.task.status, 'pending_review');
  const duplicate = await call('PUT', '/api/tasks/physical_verification', { action: 'submit' }, sid);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, 'VERIFICATION_REQUEST_PENDING');
});

test('physical verification shows the college outcome once the college records it', async () => {
  const db = require('../config/db');
  const alicia = db.prepare('SELECT id FROM students WHERE email = ?').get('alice@example.com');
  db.prepare("INSERT INTO verification_records (student_id, status, verified_by, verified_at, remarks) VALUES (?, 'completed', 'Admission Cell', '2026-09-20', 'All originals matched')").run(alicia.id);
  const view = await call('GET', '/api/tasks/physical_verification', undefined, sid);
  assert.equal(view.json.data.task.status, 'pending_review');
  assert.equal(view.json.data.task.statusLabel, 'Pending Review');
  assert.equal(view.json.data.details.verifiedBy, 'Admission Cell');
  assert.equal(view.json.data.details.remarks, 'All originals matched');
  assert.equal(view.json.data.task.summary, 'Originals verified on 20 Sep 2026 by the college');
  // still read-only for the student
  assert.equal((await call('PUT', '/api/tasks/physical_verification', { status: 'pending' }, sid)).status, 403);
  // put it back so later progress counts are predictable
  db.prepare('DELETE FROM verification_records WHERE student_id = ?').run(alicia.id);
});

test('fee payment: validation rules', async () => {
  const put = (b) => call('PUT', '/api/tasks/fee_payment', b, sid);
  const paidBase = { status: 'completed', totalFee: '100000', amountPaid: '100000', paymentMode: 'Demand Draft', receiptNumber: 'DD-445566', paidOn: '2026-09-18' };

  const empty = await put({});
  assert.ok(empty.json.errors.status);

  const missing = await put({ status: 'completed' });
  for (const f of ['amountPaid', 'paymentMode', 'receiptNumber', 'paidOn']) assert.ok(missing.json.errors[f], f);

  assert.ok((await put({ ...paidBase, amountPaid: '-5' })).json.errors.amountPaid);
  assert.ok((await put({ ...paidBase, amountPaid: '10.999' })).json.errors.amountPaid);
  assert.ok((await put({ ...paidBase, amountPaid: 'abc' })).json.errors.amountPaid);
  assert.ok((await put({ ...paidBase, totalFee: 'x' })).json.errors.totalFee);
  assert.ok((await put({ ...paidBase, paymentMode: 'Bitcoin' })).json.errors.paymentMode);
  assert.ok((await put({ ...paidBase, receiptNumber: '!!' })).json.errors.receiptNumber);
  assert.ok((await put({ ...paidBase, paidOn: '2999-01-01' })).json.errors.paidOn);
  assert.ok((await put({ ...paidBase, paidOn: '2026-02-31' })).json.errors.paidOn);
  assert.match((await put({ ...paidBase, amountPaid: '50000' })).json.errors.amountPaid, /Partially Paid/);
  assert.match((await put({ ...paidBase, status: 'in_progress' })).json.errors.amountPaid, /Paid/);
});

test('fee payment: partial, full, reset, persistence', async () => {
  const put = (b) => call('PUT', '/api/tasks/fee_payment', b, sid);
  const base = { totalFee: '120000', paymentMode: 'Online / Net Banking / UPI', receiptNumber: 'UPI123456789', paidOn: '2026-09-18' };

  const part = await put({ ...base, status: 'in_progress', amountPaid: '50,000' });
  assert.equal(part.status, 200);
  assert.equal(part.json.data.task.statusLabel, 'Submitted');
  assert.equal(part.json.data.task.summary, '₹50,000 paid of ₹1,20,000');

  const full = await put({ ...base, status: 'completed', amountPaid: '120000' });
  assert.equal(full.json.data.task.statusLabel, 'Submitted');
  const again = await call('GET', '/api/tasks/fee_payment', undefined, sid);
  assert.equal(again.json.data.details.amountPaid, 120000);
  assert.equal(again.json.data.details.receiptNumber, 'UPI123456789');
  assert.ok(again.json.data.details.instructions.length >= 4);

  const reset = await put({ status: 'pending', totalFee: '120000', amountPaid: '5', receiptNumber: 'zzz' });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.data.details.amountPaid, null);
  assert.equal(reset.json.data.details.receiptNumber, null);
  assert.equal(reset.json.data.task.summary, 'Total fee ₹1,20,000');

  // leave the fee partially paid for the dashboard checks below
  await put({ ...base, status: 'in_progress', amountPaid: '50000' });
});

test('unknown task keys are rejected', async () => {
  assert.equal((await call('GET', '/api/tasks/nope', undefined, sid)).status, 404);
  assert.equal((await call('PUT', '/api/tasks/cap_details', {}, sid)).status, 404);
  assert.equal((await call('PUT', '/api/tasks/nope', {}, sid)).status, 404);
});

test("one student cannot see or change another student's task data", async () => {
  const carol = { fullName: 'Carol Joshi', email: 'carol@example.com', phone: '9000000001', password: 'Passw0rd123', confirmPassword: 'Passw0rd123' };
  await call('POST', '/api/auth/register', carol);
  const login = await call('POST', '/api/auth/login', { email: carol.email, password: carol.password });
  linkVerified(db.prepare('SELECT id FROM students WHERE email = ?').get(carol.email).id, { applicationId: 'MH-CAROL-1', name: 'Carol Joshi' });
  const fee = await call('GET', '/api/tasks/fee_payment', undefined, login.cookie);
  assert.equal(fee.json.data.details.amountPaid, null);
  assert.equal(fee.json.data.task.status, 'not_started');
  const docs = await call('GET', '/api/tasks/document_preparation', undefined, login.cookie);
  assert.equal(docs.json.data.details.preparedRequired, 0);
});

test('Tasks 2, 3 and 6 submit through the upload workflow and persist pending review', async () => {
  const student = { fullName: 'Submit Flow Student', email: 'submit-flow@example.com', phone: '9000000002', password: 'Passw0rd123', confirmPassword: 'Passw0rd123' };
  await call('POST', '/api/auth/register', student);
  const login = await call('POST', '/api/auth/login', { email: student.email, password: student.password });
  const id = db.prepare('SELECT id FROM students WHERE email = ?').get(student.email).id;
  linkVerified(id, { applicationId: 'MH-SUBMIT-1', name: student.fullName });

  const pdf = Buffer.from('%PDF-1.4\nsubmission-proof');
  const submit = async (key, slot, body) => {
    assert.equal((await upload(`/api/tasks/${key}/uploads`, slot, `${slot}.pdf`, pdf, 'application/pdf', login.cookie)).status, 201);
    const res = await call('PUT', `/api/tasks/${key}`, { ...body, action: 'submit' }, login.cookie);
    assert.equal(res.status, 200);
    assert.match(res.json.message, /submitted successfully for officer review/i);
    assert.equal(res.json.data.task.status, 'pending_review');
    assert.equal(res.json.data.task.statusLabel, 'Pending Review');
  };

  await submit('allotment_acceptance', 'receipt', { status: 'completed', eventDate: '2026-09-12' });
  await submit('admission_form', 'form', { status: 'completed', eventDate: '2026-09-13' });
  await submit('fee_payment', 'receipt', {
    status: 'completed', totalFee: '100000', amountPaid: '100000', paymentMode: 'Demand Draft', receiptNumber: 'DD-9988', paidOn: '2026-09-14',
  });

  for (const key of ['allotment_acceptance', 'admission_form', 'fee_payment']) {
    assert.equal((await call('GET', `/api/tasks/${key}`, undefined, login.cookie)).json.data.task.status, 'pending_review');
    assert.equal(db.prepare('SELECT status FROM task_reviews WHERE student_id = ? AND task_key = ?').get(id, key).status, 'pending_review');
  }
  const dashboard = (await call('GET', '/api/dashboard', undefined, login.cookie)).json.data;
  for (const key of ['allotment_acceptance', 'admission_form', 'fee_payment']) {
    assert.equal(dashboard.tasks.find((task) => task.key === key).status, 'pending_review');
  }
  assert.equal(dashboard.progress.completed, 1, 'only trusted CAP details count until an officer approves a task');
});

test('dashboard reflects every task', async () => {
  const dash = await call('GET', '/api/dashboard', undefined, sid);
  const byKey = Object.fromEntries(dash.json.data.tasks.map((t) => [t.key, t]));
  assert.equal(byKey.cap_details.status, 'completed');
  assert.equal(byKey.allotment_acceptance.status, 'submitted');
  assert.equal(byKey.admission_form.status, 'submitted');
  assert.equal(byKey.document_preparation.status, 'submitted');
  assert.equal(byKey.physical_verification.status, 'pending_review');
  assert.equal(byKey.fee_payment.status, 'submitted');
  assert.equal(byKey.fee_payment.summary, '₹50,000 paid of ₹1,20,000');
  const p = dash.json.data.progress;
  assert.equal(p.completed, 1);
  assert.equal(p.inProgress, 5);
  assert.equal(p.pending, 0);
  assert.equal(p.percent, 17);
  assert.equal(dash.json.data.nextStep.key, 'allotment_acceptance');
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
