'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admitflow-progress-queue-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.AUTH_MAX_ATTEMPTS = '10';
process.env.CAP_CLAIM_MAX_ATTEMPTS = '10';

const app = require('../app');
const db = require('../config/db');
const authService = require('../services/authService');
const adminAuthService = require('../services/adminAuthService');
const capRecordService = require('../services/capRecordService');
const admissionTokenService = require('../services/admissionTokenService');
const admissionProgressQueueService = require('../services/admissionProgressQueueService');
const capRoundDeadlineService = require('../services/capRoundDeadlineService');
const taskWorkflowService = require('../services/taskWorkflowService');
const verificationAdminService = require('../services/verificationAdminService');
const appointmentService = require('../services/appointmentService');
const queueService = require('../services/queueService');
const time = require('../utils/time');
const capHelper = require('./helpers/capHelper');

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

test('setup: admission officer and admin cookie', async () => {
  officer = await adminAuthService.createAdmin({
    fullName: 'Admission Officer Progress',
    email: 'officer-prog@test.local',
    password: PW,
    role: 'admission_officer',
  });
  const loginRes = await call('POST', '/api/admin/auth/login', { email: officer.email, password: PW });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.cookie);
  officerCookie = loginRes.cookie;
});

test('1. Entry: trusted CAP-matched student enters automatically with AF-xxx token; unmatched student is excluded', async () => {
  // Create an unmatched student (no CAP record)
  const unmatched = await authService.register({
    fullName: 'Unmatched Student',
    email: 'unmatched@test.local',
    phone: '9820000010',
    password: STU_PW,
  });
  assert.ok(unmatched.id);
  assert.equal(unmatched.admissionToken, null);

  // Attempt to enroll unmatched student directly
  const unmatchedEnroll = admissionProgressQueueService.enrollStudent(unmatched.id, db);
  assert.equal(unmatchedEnroll, null, 'Unmatched student must be excluded from progress queue');

  // Verify unmatched student is not in the queue
  const queueBefore = admissionProgressQueueService.getQueue({}, db);
  const foundUnmatched = queueBefore.items.find((i) => i.student.id === unmatched.id);
  assert.equal(foundUnmatched, undefined, 'Unmatched student must not exist in progress queue');

  // Create a matched student
  const matchedStudent = await authService.register({
    fullName: 'Matched Student Alpha',
    email: 'matched-alpha@test.local',
    phone: '9820000011',
    password: STU_PW,
  });
  assert.ok(matchedStudent.id);

  // Link to a verified CAP record with Round 1
  capHelper.linkVerified(matchedStudent.id, {
    applicationId: 'EN26PROGRESS01',
    name: 'Matched Student Alpha',
    round: 'Round 1',
  });

  // Verify permanent token was allocated
  const token = admissionTokenService.getAdmissionToken(matchedStudent.id, db);
  assert.ok(token, 'Permanent admission token should be allocated');
  assert.match(token, /^AF-\d{3,}$/);

  // Auto-entry verification: student enters progress queue automatically
  admissionProgressQueueService.enrollStudent(matchedStudent.id, db);
  const queueAfter = admissionProgressQueueService.getQueue({}, db);
  const foundMatched = queueAfter.items.find((i) => i.student.id === matchedStudent.id);
  assert.ok(foundMatched, 'Matched student must enter the progress queue');
  assert.equal(foundMatched.token, token);
  assert.equal(foundMatched.status, 'active');
  assert.equal(foundMatched.capRound, 'Round 1');
  assert.equal(foundMatched.approvedCount, 1, 'cap_details task is approved');
  assert.equal(foundMatched.submittedCount, 0);
});

test('2. Duplicate Prevention: multiple enrollments or repeated calls do not create duplicates', async () => {
  const student = await authService.register({
    fullName: 'Duplicate Test Student',
    email: 'dup-test@test.local',
    phone: '9820000012',
    password: STU_PW,
  });
  capHelper.linkVerified(student.id, { applicationId: 'EN26PROGRESS02', name: student.fullName, round: 'Round 1' });

  // Call enroll multiple times
  const enroll1 = admissionProgressQueueService.enrollStudent(student.id, db);
  const enroll2 = admissionProgressQueueService.enrollStudent(student.id, db);
  const enroll3 = admissionProgressQueueService.enrollStudent(student.id, db);

  assert.ok(enroll1);
  assert.ok(enroll2);
  assert.ok(enroll3);

  // Verify database count for this student in queue table
  const countRow = db.prepare('SELECT COUNT(*) AS c FROM admission_progress_queue WHERE student_id = ?').get(student.id);
  assert.equal(countRow.c, 1, 'There must be exactly one queue row per student');
});

test('3. Submitted vs Approved Counts: submissions do not count as approvals; counts tracked separately', async () => {
  const student = await authService.register({
    fullName: 'Counts Test Student',
    email: 'counts-test@test.local',
    phone: '9820000013',
    password: STU_PW,
  });
  capHelper.linkVerified(student.id, { applicationId: 'EN26PROGRESS03', name: student.fullName, round: 'Round 1' });
  admissionProgressQueueService.enrollStudent(student.id, db);

  // Initial state: Task 1 (cap_details) approved, other 5 tasks not started
  let counts = admissionProgressQueueService.getStudentTaskCounts(student.id, db);
  assert.equal(counts.approvedCount, 1);
  assert.equal(counts.submittedCount, 0);

  // Student submits Task 2 (allotment_acceptance)
  taskWorkflowService.studentMove(student.id, 'allotment_acceptance', 'pending_review');
  counts = admissionProgressQueueService.getStudentTaskCounts(student.id, db);
  assert.equal(counts.approvedCount, 1, 'Submission must not increase approved count');
  assert.equal(counts.submittedCount, 1, 'Submission must increase submitted count');

  // Student submits Task 3 (admission_form)
  taskWorkflowService.studentMove(student.id, 'admission_form', 'submitted');
  counts = admissionProgressQueueService.getStudentTaskCounts(student.id, db);
  assert.equal(counts.approvedCount, 1, 'Approved count remains 1');
  assert.equal(counts.submittedCount, 2, 'Submitted count increases to 2');

  // Officer requests corrections on Task 3
  taskWorkflowService.officerReview(officer, student.id, 'admission_form', {
    action: 'request_corrections',
    remarks: 'Please re-upload a clearer copy of the form.',
  });
  counts = admissionProgressQueueService.getStudentTaskCounts(student.id, db);
  assert.equal(counts.approvedCount, 1, 'Approved count remains 1');
  assert.equal(counts.submittedCount, 1, 'Correction-required task is neither submitted nor approved');

  // Officer approves Task 2 (allotment_acceptance)
  taskWorkflowService.officerReview(officer, student.id, 'allotment_acceptance', {
    action: 'approve',
  });
  counts = admissionProgressQueueService.getStudentTaskCounts(student.id, db);
  assert.equal(counts.approvedCount, 2, 'Approved count increases to 2');
  assert.equal(counts.submittedCount, 0, 'Submitted count decreases when task is approved');
});

test('4. Deadline Discrimination: distinguishes seat-acceptance, institute-reporting, and cutoff dates; selects ONLY institute-reporting', async () => {
  // Configure distinct dates for Round 1
  capRoundDeadlineService.setDeadlines(officer, 'Round 1', {
    seatAcceptanceDeadline: '2026-10-23',
    instituteReportingDeadline: '2026-10-25',
    admissionCutoffDeadline: '2026-11-15',
  }, db);

  const student = await authService.register({
    fullName: 'Discrimination Test Student',
    email: 'discrim@test.local',
    phone: '9820000014',
    password: STU_PW,
  });
  capHelper.linkVerified(student.id, { applicationId: 'EN26DISCRIM01', name: student.fullName, round: 'Round 1' });

  const deadlineInfo = capRoundDeadlineService.getRelevantDeadlineForStudent(student.id, db);

  // Must explicitly distinguish and identify deadlines
  assert.equal(deadlineInfo.seatAcceptanceDeadline, '2026-10-23');
  assert.equal(deadlineInfo.deadline, '2026-10-25', 'Must select institute_reporting_deadline as the relevant deadline');
  assert.equal(deadlineInfo.deadlineType, 'institute_reporting');
  assert.equal(deadlineInfo.deadlineLabel, 'Institute Reporting Deadline');
  assert.equal(deadlineInfo.admissionCutoffDeadline, '2026-11-15');
  assert.notEqual(deadlineInfo.deadline, deadlineInfo.seatAcceptanceDeadline, 'Seat acceptance and reporting deadlines are NOT interchangeable');
  assert.notEqual(deadlineInfo.deadline, deadlineInfo.admissionCutoffDeadline, 'Cutoff and reporting deadlines are NOT interchangeable');
});

test('5. Missing Deadlines & Appointment Isolation: unavailable official deadline marks urgency unavailable; never substitutes appointment dates', async () => {
  // Configure Special Round with NO institute reporting deadline
  capRoundDeadlineService.setDeadlines(officer, 'Special Round', {
    seatAcceptanceDeadline: '2026-11-01',
    instituteReportingDeadline: null, // unavailable!
    admissionCutoffDeadline: '2026-11-15',
  }, db);

  const student = await authService.register({
    fullName: 'No Deadline Student',
    email: 'no-deadline@test.local',
    phone: '9820000015',
    password: STU_PW,
  });
  capHelper.linkVerified(student.id, { applicationId: 'EN26NODEADLINE01', name: student.fullName, round: 'Special Round' });
  admissionProgressQueueService.enrollStudent(student.id, db);

  // Schedule an appointment for tomorrow (to verify it is NEVER substituted)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  appointmentService.schedule(officer, {
    studentId: student.id,
    date: tomorrow,
    time: '11:00',
    venue: 'Verification Hall B',
    instructions: 'Test appointment',
  });

  // Evaluate student deadline: MUST be unavailable, MUST NOT substitute appointment date
  const deadlineInfo = admissionProgressQueueService.getStudentDeadline(student.id, db);
  assert.equal(deadlineInfo.deadline, null, 'Must not substitute appointment date for missing official deadline');
  assert.equal(deadlineInfo.isAvailable, false);

  // Urgency for null deadline must be null (marked unavailable)
  const urgency = admissionProgressQueueService.calculateUrgency(deadlineInfo.deadline);
  assert.equal(urgency, null, 'Urgency must be null when official deadline is unavailable');

  // Priority score must treat unavailable urgency consistently as 0.0 contribution:
  // S = 0.60 * 0.0 + 0.40 * (1/6) = 0.0667
  const score = admissionProgressQueueService.calculatePriorityScore(urgency, 1);
  assert.equal(score, 0.0667);

  // Check queue item representation
  const queue = admissionProgressQueueService.getQueue({}, db);
  const item = queue.items.find((i) => i.student.id === student.id);
  assert.ok(item);
  assert.equal(item.deadline, null);
  assert.equal(item.urgencyAvailable, false);
  assert.equal(item.urgency, null);
  assert.equal(item.priorityScore, 0.0667);
});

test('6. Priority Ranking: deterministic 60% deadline urgency + 40% approved-task progress across CAP rounds', async () => {
  const asOf = '2026-10-20';

  // Configure Round 1 (close deadline: 2026-10-22 -> delta = 2 days)
  capRoundDeadlineService.setDeadlines(officer, 'Round 1', {
    instituteReportingDeadline: '2026-10-22',
  }, db);

  // Configure Round 2 (farther deadline: 2026-11-01 -> delta = 12 days)
  capRoundDeadlineService.setDeadlines(officer, 'Round 2', {
    instituteReportingDeadline: '2026-11-01',
  }, db);

  // Student in Round 1 (urgent reporting deadline): U = (14 - 2)/14 = 0.8571
  // Approved tasks: 1/6 (P = 0.1667)
  // Score = 0.60 * 0.8571 + 0.40 * 0.1667 = 0.5143 + 0.0667 = 0.5810
  const u1 = admissionProgressQueueService.calculateUrgency('2026-10-22', asOf);
  assert.equal(u1, 0.8571);
  const scoreRound1 = admissionProgressQueueService.calculatePriorityScore(u1, 1);
  assert.equal(scoreRound1, 0.5809);

  // Student in Round 2 (distant reporting deadline): U = (14 - 12)/14 = 0.1429
  // Approved tasks: 3/6 (P = 0.5000)
  // Score = 0.60 * 0.1429 + 0.40 * 0.5000 = 0.0857 + 0.2000 = 0.2857
  const u2 = admissionProgressQueueService.calculateUrgency('2026-11-01', asOf);
  assert.equal(u2, 0.1429);
  const scoreRound2 = admissionProgressQueueService.calculatePriorityScore(u2, 3);
  assert.equal(scoreRound2, 0.2857);

  assert.ok(scoreRound1 > scoreRound2, 'Closer official round deadline outranks farther round even with more tasks');
});

test('7. FIFO Ties: equal scores broken by earlier queue-entry time (FIFO)', async () => {
  const student1 = await authService.register({
    fullName: 'FIFO Student One',
    email: 'fifo1@test.local',
    phone: '9820000021',
    password: STU_PW,
  });
  capHelper.linkVerified(student1.id, { applicationId: 'EN26FIFO01', name: student1.fullName, round: 'Round 1' });

  const student2 = await authService.register({
    fullName: 'FIFO Student Two',
    email: 'fifo2@test.local',
    phone: '9820000022',
    password: STU_PW,
  });
  capHelper.linkVerified(student2.id, { applicationId: 'EN26FIFO02', name: student2.fullName, round: 'Round 1' });

  // Explicitly set entered_at with student1 earlier than student2
  db.prepare(`
    INSERT INTO admission_progress_queue (student_id, admission_token, entered_at, status)
    VALUES (?, ?, '2026-10-20 09:00:00', 'active')
    ON CONFLICT(student_id) DO UPDATE SET entered_at = '2026-10-20 09:00:00', status = 'active'
  `).run(student1.id, admissionTokenService.getAdmissionToken(student1.id, db));

  db.prepare(`
    INSERT INTO admission_progress_queue (student_id, admission_token, entered_at, status)
    VALUES (?, ?, '2026-10-20 09:30:00', 'active')
    ON CONFLICT(student_id) DO UPDATE SET entered_at = '2026-10-20 09:30:00', status = 'active'
  `).run(student2.id, admissionTokenService.getAdmissionToken(student2.id, db));

  const queue = admissionProgressQueueService.getQueue({}, db);
  const item1 = queue.items.find((i) => i.student.id === student1.id);
  const item2 = queue.items.find((i) => i.student.id === student2.id);

  assert.ok(item1);
  assert.ok(item2);
  assert.equal(item1.priorityScore, item2.priorityScore, 'Scores must be identical');
  assert.ok(item1.position < item2.position, 'Student with earlier entered_at must have lower position number (FIFO)');
});

test('8. Automatic Reordering: positions update when round deadlines or task statuses change', async () => {
  // Round 2 deadline set to 10 days away
  capRoundDeadlineService.setDeadlines(officer, 'Round 2', {
    instituteReportingDeadline: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
  }, db);

  // Round 3 deadline set to 12 days away
  capRoundDeadlineService.setDeadlines(officer, 'Round 3', {
    instituteReportingDeadline: new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10),
  }, db);

  const studentA = await authService.register({
    fullName: 'Reorder Student A',
    email: 'reorder-a@test.local',
    phone: '9820000031',
    password: STU_PW,
  });
  capHelper.linkVerified(studentA.id, { applicationId: 'EN26REORDER01', name: studentA.fullName, round: 'Round 2' });
  admissionProgressQueueService.enrollStudent(studentA.id, db);

  const studentB = await authService.register({
    fullName: 'Reorder Student B',
    email: 'reorder-b@test.local',
    phone: '9820000032',
    password: STU_PW,
  });
  capHelper.linkVerified(studentB.id, { applicationId: 'EN26REORDER02', name: studentB.fullName, round: 'Round 3' });
  admissionProgressQueueService.enrollStudent(studentB.id, db);

  // Set entered_at so A is before B
  db.prepare("UPDATE admission_progress_queue SET entered_at = '2026-10-20 08:00:00' WHERE student_id = ?").run(studentA.id);
  db.prepare("UPDATE admission_progress_queue SET entered_at = '2026-10-20 08:05:00' WHERE student_id = ?").run(studentB.id);

  let q = admissionProgressQueueService.getQueue({}, db);
  let posA = q.items.find((i) => i.student.id === studentA.id).position;
  let posB = q.items.find((i) => i.student.id === studentB.id).position;
  assert.ok(posA < posB, 'A has closer deadline (Round 2) than B (Round 3) and ranks ahead');

  // Now student B gets 3 tasks approved
  taskWorkflowService.studentMove(studentB.id, 'allotment_acceptance', 'pending_review');
  taskWorkflowService.officerReview(officer, studentB.id, 'allotment_acceptance', { action: 'approve' });

  taskWorkflowService.studentMove(studentB.id, 'admission_form', 'pending_review');
  taskWorkflowService.officerReview(officer, studentB.id, 'admission_form', { action: 'approve' });

  taskWorkflowService.studentMove(studentB.id, 'document_preparation', 'pending_review');
  taskWorkflowService.officerReview(officer, studentB.id, 'document_preparation', { action: 'approve' });

  // Re-check queue: B should now have significantly higher score from approved tasks and overtake A
  q = admissionProgressQueueService.getQueue({}, db);
  posA = q.items.find((i) => i.student.id === studentA.id).position;
  posB = q.items.find((i) => i.student.id === studentB.id).position;
  assert.ok(posB < posA, 'B must overtake A due to newly approved tasks');

  // Now an official notification shifts Round 2 deadline to tomorrow (highly urgent!)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  capRoundDeadlineService.setDeadlines(officer, 'Round 2', {
    instituteReportingDeadline: tomorrow,
  }, db);

  // Re-check queue: A must immediately regain priority due to round deadline change
  q = admissionProgressQueueService.getQueue({}, db);
  posA = q.items.find((i) => i.student.id === studentA.id).position;
  posB = q.items.find((i) => i.student.id === studentB.id).position;
  assert.ok(posA < posB, 'A must regain priority after Round 2 official reporting deadline became urgent');
});

test('9. Completion: student removed from active queue only after all six tasks are approved', async () => {
  const student = await authService.register({
    fullName: 'Complete Student Six',
    email: 'complete-six@test.local',
    phone: '9820000041',
    password: STU_PW,
  });
  capHelper.linkVerified(student.id, { applicationId: 'EN26COMPLETE01', name: student.fullName, round: 'Round 1' });
  admissionProgressQueueService.enrollStudent(student.id, db);

  const token = admissionTokenService.getAdmissionToken(student.id, db);
  assert.ok(token);

  // Approve tasks 2, 3, 4, 5 (total 5 approved out of 6)
  const keys = ['allotment_acceptance', 'admission_form', 'document_preparation', 'physical_verification'];
  for (const k of keys) {
    if (k === 'physical_verification') {
      verificationAdminService.record(officer, student.id, { status: 'completed', remarks: 'All originals verified' });
    }
    taskWorkflowService.studentMove(student.id, k, 'pending_review');
    taskWorkflowService.officerReview(officer, student.id, k, { action: 'approve' });
  }

  // Check queue: student has 5/6 approved and must STILL be in active queue
  let activeQueue = admissionProgressQueueService.getQueue({ status: 'active' }, db);
  let activeStudent = activeQueue.items.find((i) => i.student.id === student.id);
  assert.ok(activeStudent, 'Student with 5/6 approved tasks must remain in active queue');
  assert.equal(activeStudent.approvedCount, 5);

  // Now approve task 6 (fee_payment) -> reaches 6/6!
  taskWorkflowService.studentMove(student.id, 'fee_payment', 'pending_review');
  taskWorkflowService.officerReview(officer, student.id, 'fee_payment', { action: 'approve' });

  // Student must now be REMOVED from active queue
  activeQueue = admissionProgressQueueService.getQueue({ status: 'active' }, db);
  activeStudent = activeQueue.items.find((i) => i.student.id === student.id);
  assert.equal(activeStudent, undefined, 'Student with 6/6 approved tasks must be removed from active queue');

  // Student must exist in completed queue
  const completedQueue = admissionProgressQueueService.getQueue({ status: 'completed' }, db);
  const completedStudent = completedQueue.items.find((i) => i.student.id === student.id);
  assert.ok(completedStudent, 'Student must appear in completed progress queue');
  assert.equal(completedStudent.status, 'completed');
  assert.equal(completedStudent.approvedCount, 6);
  assert.ok(completedStudent.completedAt);

  // Invariants: token and task records are permanently preserved
  assert.equal(completedStudent.token, token, 'Permanent token must be preserved');
  const tokenInDb = db.prepare('SELECT admission_token FROM students WHERE id = ?').get(student.id).admission_token;
  assert.equal(tokenInDb, token, 'Token in students table must be preserved');
});

test('10. Physical-Queue Isolation: queue_tokens (Rxxx/Pxxx) and counters are completely isolated', async () => {
  const student = await authService.register({
    fullName: 'Isolation Student',
    email: 'isolation@test.local',
    phone: '9820000051',
    password: STU_PW,
  });
  capHelper.linkVerified(student.id, { applicationId: 'EN26ISOLATE01', name: student.fullName, round: 'Round 1' });
  admissionProgressQueueService.enrollStudent(student.id, db);

  const admissionToken = admissionTokenService.getAdmissionToken(student.id, db);

  // Schedule an appointment and check in for a physical verification desk token (e.g. R001 / P001)
  appointmentService.schedule(officer, {
    studentId: student.id,
    date: time.today(),
    time: '09:30',
    venue: 'Desk 1',
    instructions: 'Bring originals',
  });

  const physicalToken = await queueService.checkIn(officer, student.id);
  assert.ok(physicalToken.code, 'Should issue temporary physical queue token (e.g. R001/P001)');
  assert.notEqual(physicalToken.code, admissionToken, 'Physical queue token must be separate from AF-xxx admission token');
  assert.match(physicalToken.code, /^[RP]\d{3}$/, 'Physical queue token format must be Rxxx or Pxxx');
  assert.match(admissionToken, /^AF-\d{3,}$/, 'Permanent admission token format must be AF-xxx');

  // Verify progress queue position and entry are unchanged
  const queue = admissionProgressQueueService.getQueue({}, db);
  const progItem = queue.items.find((i) => i.student.id === student.id);
  assert.ok(progItem);
  assert.equal(progItem.token, admissionToken);
});

test('11. Admin API: GET /api/admin/progress-queue exposes position, token, student, round, deadline, urgency, counts, and score', async () => {
  const res = await call('GET', '/api/admin/progress-queue', undefined, officerCookie);
  assert.equal(res.status, 200);
  assert.ok(res.json.success);
  assert.ok(res.json.data);
  assert.ok(Array.isArray(res.json.data.items));
  assert.ok(res.json.data.formula);
  assert.equal(res.json.data.formula.relevantDeadlineType, 'institute_reporting');

  if (res.json.data.items.length > 0) {
    const first = res.json.data.items[0];
    assert.equal(first.position, 1);
    assert.ok(first.token.startsWith('AF-'));
    assert.ok(first.student.id);
    assert.ok(first.student.fullName);
    assert.ok('capRound' in first);
    assert.ok('deadline' in first);
    assert.ok('deadlineType' in first);
    assert.ok('urgencyAvailable' in first);
    assert.ok('urgency' in first);
    assert.ok('submittedCount' in first);
    assert.ok('approvedCount' in first);
    assert.ok('priorityScore' in first);
    assert.equal(first.status, 'active');
  }

  // Verify round deadlines endpoints
  const listRounds = await call('GET', '/api/admin/cap/round-deadlines', undefined, officerCookie);
  assert.equal(listRounds.status, 200);
  assert.ok(Array.isArray(listRounds.json.data));

  const updateRound = await call('PUT', '/api/admin/cap/round-deadlines/Round%201', {
    seatAcceptanceDeadline: '2026-10-24',
    instituteReportingDeadline: '2026-10-26',
    admissionCutoffDeadline: '2026-11-15',
  }, officerCookie);
  assert.equal(updateRound.status, 200);
  assert.equal(updateRound.json.data.instituteReportingDeadline, '2026-10-26');
});

test('12. C++ Max-Heap Integration: C++ max-heap determines the order, recovers on crash, and updates dynamically', async () => {
  // 1. Call admin progress queue API (queries C++ max-heap)
  const apiRes = await call('GET', '/api/admin/progress-queue', undefined, officerCookie);
  assert.equal(apiRes.status, 200);
  const activeApiItems = apiRes.json.data.items.filter((i) => i.status === 'active');
  assert.ok(activeApiItems.length > 0, 'Active items must exist in progress queue');

  // 2. Query C++ engine directly to verify API order matches C++ max-heap 1-to-1
  const engineRanked = await queueService.withEngine(async ({ send }) => {
    return await send('PROGRESS_RANK');
  });
  assert.ok(engineRanked.ok, 'C++ engine must answer PROGRESS_RANK');
  assert.ok(Array.isArray(engineRanked.ranked));

  // Verify that active API items order matches the C++ engine ranked order
  assert.equal(activeApiItems.length, engineRanked.ranked.length);
  for (let idx = 0; idx < engineRanked.ranked.length; idx++) {
    const heapEntry = engineRanked.ranked[idx];
    const apiItem = activeApiItems[idx];
    assert.equal(apiItem.student.id, heapEntry.studentId, `Position ${idx + 1} must match C++ max-heap student ID`);
    assert.equal(apiItem.position, heapEntry.position, `Position ${idx + 1} must match C++ max-heap position`);
    assert.equal(apiItem.token, heapEntry.token, `Token at position ${idx + 1} must match C++ heap token`);
  }

  // 3. Crash recovery test: kill C++ engine and verify heap is restored with identical order
  queueService.__test.killEngine();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(queueService.__test.engineAlive(), false, 'Engine should be down');

  // Next call automatically restarts engine and onRestore rebuilds the C++ max-heap
  const restoredApiRes = await call('GET', '/api/admin/progress-queue', undefined, officerCookie);
  assert.equal(restoredApiRes.status, 200);
  const restoredItems = restoredApiRes.json.data.items.filter((i) => i.status === 'active');
  assert.equal(restoredItems.length, activeApiItems.length);
  for (let idx = 0; idx < restoredItems.length; idx++) {
    assert.equal(restoredItems[idx].student.id, activeApiItems[idx].student.id, `Restored order at ${idx + 1} must be identical`);
    assert.equal(restoredItems[idx].position, idx + 1);
  }
});

test('13. Regression: Descending priority order (score 0.5191 before 0.4524) and tie-breaking', async () => {
  // Test direct C++ heap upserts with the exact Rohan Joshi (0.5191) vs Sneha Patil (0.4524) scores
  const studentA = {
    studentId: 9101,
    token: 'AF-9101',
    score: 0.4524,
    enteredAt: '2026-10-20T10:00:00Z',
    version: 1,
  };
  const studentB = {
    studentId: 9102,
    token: 'AF-9102',
    score: 0.5191,
    enteredAt: '2026-10-20T10:05:00Z',
    version: 1,
  };
  const studentC = {
    studentId: 9103,
    token: 'AF-9103',
    score: 0.5191,
    enteredAt: '2026-10-20T10:01:00Z',
    version: 1,
  };
  const studentD = {
    studentId: 9104,
    token: 'AF-9104',
    score: 0.5191,
    enteredAt: '2026-10-20T10:01:00Z',
    version: 1,
  };

  const upsertRes = await queueService.withEngine(async ({ send }) => {
    // Insert studentA first (lower score 0.4524)
    await send(`PROGRESS_UPSERT ${studentA.studentId} ${studentA.token} ${studentA.score.toFixed(4)} ${studentA.enteredAt.replace(/\s+/g, '~')}`);
    // Insert studentB (higher score 0.5191)
    await send(`PROGRESS_UPSERT ${studentB.studentId} ${studentB.token} ${studentB.score.toFixed(4)} ${studentB.enteredAt.replace(/\s+/g, '~')}`);
    // Insert studentC (same score 0.5191, earlier enteredAt)
    await send(`PROGRESS_UPSERT ${studentC.studentId} ${studentC.token} ${studentC.score.toFixed(4)} ${studentC.enteredAt.replace(/\s+/g, '~')}`);
    // Insert studentD (same score 0.5191, same enteredAt, higher studentId)
    await send(`PROGRESS_UPSERT ${studentD.studentId} ${studentD.token} ${studentD.score.toFixed(4)} ${studentD.enteredAt.replace(/\s+/g, '~')}`);
    return await send('PROGRESS_RANK');
  });

  assert.ok(upsertRes.ok);
  const ranked = upsertRes.ranked;

  const idxC = ranked.findIndex((r) => r.studentId === 9103);
  const idxD = ranked.findIndex((r) => r.studentId === 9104);
  const idxB = ranked.findIndex((r) => r.studentId === 9102);
  const idxA = ranked.findIndex((r) => r.studentId === 9101);

  assert.ok(idxC !== -1 && idxD !== -1 && idxB !== -1 && idxA !== -1);
  // Student C (0.5191, entered 10:01, id 9103) must come before Student D (0.5191, entered 10:01, id 9104)
  assert.ok(idxC < idxD, 'Same score & enteredAt: smaller student ID must come first');
  // Student D (0.5191, entered 10:01) must come before Student B (0.5191, entered 10:05)
  assert.ok(idxD < idxB, 'Same score: earlier enteredAt must come first');
  // Student B (0.5191) must strictly come before Student A (0.4524) regardless of entry order/IDs
  assert.ok(idxB < idxA, 'Higher priority score (0.5191) must strictly precede lower score (0.4524)');

  // Clean up test entries from C++ heap
  await queueService.withEngine(async ({ send }) => {
    await send('PROGRESS_REMOVE 9101');
    await send('PROGRESS_REMOVE 9102');
    await send('PROGRESS_REMOVE 9103');
    await send('PROGRESS_REMOVE 9104');
  });

  // Verify via full API response that all active students are sorted in descending priorityScore order
  const apiRes = await call('GET', '/api/admin/progress-queue', undefined, officerCookie);
  assert.equal(apiRes.status, 200);
  const activeItems = apiRes.json.data.items.filter((i) => i.status === 'active');
  for (let i = 0; i < activeItems.length - 1; i++) {
    const cur = activeItems[i];
    const next = activeItems[i + 1];
    assert.ok(
      cur.priorityScore >= next.priorityScore - 1e-6,
      `Item at #${cur.position} (${cur.student.fullName}, score ${cur.priorityScore}) must have priority score >= item at #${next.position} (${next.student.fullName}, score ${next.priorityScore})`
    );
    assert.equal(cur.position, i + 1, `Item at index ${i} must have 1-based sequential position ${i + 1}`);
  }
});

