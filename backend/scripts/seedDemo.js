'use strict';
/**
 * DEVELOPMENT ONLY: creates one demo admin per role and a few demo students in different stages,
 * so the admin portal has something to show. Safe to run more than once (existing accounts are skipped).
 *
 *   npm run seed:demo
 */
if (process.env.NODE_ENV === 'production') {
  console.error('seed:demo is for local development only and refuses to run when NODE_ENV=production.');
  process.exit(1);
}
const db = require('../config/db');
const time = require('../utils/time');
const authService = require('../services/authService');
const adminAuthService = require('../services/adminAuthService');
const capRecordService = require('../services/capRecordService');
const taskService = require('../services/taskService');
const applicationService = require('../services/applicationService');
const appointmentService = require('../services/appointmentService');
const verificationAdminService = require('../services/verificationAdminService');

const ADMIN_PASSWORD = 'Demo@Admit2026';
const STUDENT_PASSWORD = 'Student@2026';

const DEMO_ADMINS = [
  { fullName: 'Demo Super Admin', email: 'superadmin@admitflow.local', role: 'super_admin' },
  { fullName: 'Demo Admission Officer', email: 'officer@admitflow.local', role: 'admission_officer' },
  { fullName: 'Demo Viewer', email: 'viewer@admitflow.local', role: 'viewer' },
];

const REQUIRED_DOCS = ['cap_allotment_letter', 'ssc_marksheet', 'hsc_marksheet', 'leaving_certificate', 'entrance_scorecard', 'photo_id', 'passport_photos'];
const COLLEGE = 'College of Engineering Pune';
const done = (d) => ({ status: 'completed', eventDate: d });

const STUDENTS = [
  { name: 'Aarav Deshmukh', phone: '9811100001', app: 'MH2026-10001', branch: 'Computer Engineering', stage: 'ready' },
  { name: 'Sneha Patil', phone: '9811100002', app: 'MH2026-10002', branch: 'Information Technology', stage: 'cap_only' },
  { name: 'Rohan Joshi', phone: '9811100003', app: 'MH2026-10003', branch: 'Mechanical Engineering', stage: 'approved' },
  { name: 'Meera Kulkarni', phone: '9811100004', app: 'MH2026-10004', branch: 'Electronics & Telecommunication', stage: 'corrections' },
  { name: 'Kabir Shaikh', phone: '9811100005', app: 'MH2026-10005', branch: 'Civil Engineering', stage: 'appointment' },
  // Registered, submitted an application ID, and is waiting for the admission cell to verify it (try: Admin > CAP records > Verify)
  { name: 'Isha Pawar', phone: '9811100006', app: null, branch: null, stage: 'registered', pendingClaim: 'MH2026-10099' },
  // Appointment TODAY, so the verification queue (Admin > Queue) can be tried straight away:
  { name: 'Ravi Kale', phone: '9811100007', app: 'MH2026-10007', branch: 'Computer Engineering', stage: 'today', round: 'Round 1' },
  { name: 'Pooja Bhosale', phone: '9811100008', app: 'MH2026-10008', branch: 'Information Technology', stage: 'today', round: 'Round 3' },
  { name: 'Nikhil Gaikwad', phone: '9811100009', app: 'MH2026-10009', branch: 'Mechanical Engineering', stage: 'today', round: 'Round 1', returning: true },
  { name: 'Tanvi Jadhav', phone: '9811100010', app: 'MH2026-10010', branch: 'Civil Engineering', stage: 'today', round: 'Round 1' },
];

(async () => {
  const admins = {};
  for (const a of DEMO_ADMINS) {
    const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(a.email);
    if (!existing) await adminAuthService.createAdmin({ ...a, password: ADMIN_PASSWORD });
    const row = db.prepare('SELECT * FROM admins WHERE email = ?').get(a.email);
    admins[a.role] = { id: row.id, fullName: row.full_name, role: row.role };
  }
  const actor = admins.super_admin;
  const yesterday = time.addDays(-1);

  for (const s of STUDENTS) {
    const email = `${s.name.split(' ')[0].toLowerCase()}.demo@example.com`;
    if (db.prepare('SELECT 1 FROM students WHERE email = ?').get(email)) continue;
    const student = await authService.register({ fullName: s.name, email, phone: s.phone, password: STUDENT_PASSWORD });
    const me = db.prepare('SELECT id, full_name AS fullName FROM students WHERE id = ?').get(student.id);
    if (!s.app) {
      if (s.pendingClaim) capRecordService.claim(me, s.pendingClaim);
      continue;
    }

    // Allotment details are never typed by students: staff add the record, a DIFFERENT admin verifies it, the student claims the ID.
    const rec = capRecordService.create(admins.admission_officer, {
      applicationId: s.app, candidateName: s.name.toUpperCase(), allottedCollege: COLLEGE, courseBranch: s.branch, capRound: s.round || 'Round 1', allotmentStatus: 'Allotted', sourceNote: 'Demo data',
    });
    capRecordService.verify(actor, rec.id, { remarks: 'Demo: checked against the allotment list.' });
    capRecordService.claim(me, s.app);
    if (s.stage === 'cap_only') continue;

    taskService.saveTask(student.id, 'allotment_acceptance', done(yesterday));
    taskService.saveTask(student.id, 'admission_form', done(yesterday));
    taskService.saveTask(student.id, 'document_preparation', { preparedDocs: s.stage === 'corrections' ? REQUIRED_DOCS.slice(0, 4) : REQUIRED_DOCS });
    taskService.saveTask(student.id, 'fee_payment', {
      status: 'completed', totalFee: '95000', amountPaid: '95000', paymentMode: 'Demand Draft', receiptNumber: `DD-${s.app.slice(-5)}`, paidOn: yesterday,
    });

    if (s.stage === 'today') {
      appointmentService.schedule(actor, { studentId: student.id, date: time.today(), time: '10:30', venue: 'Admission Cell, Main Building, Room 12', instructions: 'Bring all originals and two photocopies of each document.' });
      if (s.returning) verificationAdminService.record(actor, student.id, { status: 'in_progress', remarks: 'One document missing; returning to complete.' });
    } else if (s.stage === 'approved') {
      verificationAdminService.record(actor, student.id, { status: 'completed', remarks: 'All originals matched.' });
      applicationService.review(actor, student.id, { action: 'approve', targetStatus: 'approved', remarks: 'Documents verified and fee received.' });
    } else if (s.stage === 'corrections') {
      applicationService.review(actor, student.id, {
        action: 'request_corrections', targetStatus: 'correction_requested', remarks: 'Please prepare your HSC marksheet, leaving certificate and Aadhaar copy.',
      });
    } else if (s.stage === 'appointment') {
      appointmentService.schedule(actor, {
        studentId: student.id, date: time.addDays(3), time: '10:30', venue: 'Admission Cell, Main Building, Room 12', instructions: 'Bring all originals and two photocopies of each document.',
      });
    }
  }

  // Pending records (not verified yet) so the CAP records page has something to verify.
  const pendingRecords = [
    { applicationId: 'MH2026-10099', candidateName: 'PAWAR ISHA', allottedCollege: COLLEGE, courseBranch: 'Computer Engineering', capRound: 'Round 2', allotmentStatus: 'Allotted', sourceNote: 'Demo data (Isha Pawar is waiting on this one)' },
    { applicationId: 'MH2026-10098', candidateName: 'UNCLAIMED CANDIDATE', allottedCollege: COLLEGE, courseBranch: 'Civil Engineering', capRound: 'Round 1', allotmentStatus: 'Allotted', sourceNote: 'Demo data' },
  ];
  for (const r of pendingRecords) {
    if (!db.prepare('SELECT 1 FROM cap_allotment_records WHERE application_id = ?').get(r.applicationId)) capRecordService.create(admins.admission_officer, r);
  }
  const isha = db.prepare("SELECT id FROM students WHERE email = 'isha.demo@example.com'").get();
  if (isha && !db.prepare("SELECT 1 FROM cap_claims WHERE student_id = ?").get(isha.id)) {
    capRecordService.claim(db.prepare('SELECT id, full_name AS fullName FROM students WHERE id = ?').get(isha.id), 'MH2026-10099');
  }

  console.log('Demo data ready.\n');
  console.log('Admin portal: http://localhost:3000/admin/login.html');
  DEMO_ADMINS.forEach((a) => console.log(`  ${a.role.padEnd(18)} ${a.email}   password: ${ADMIN_PASSWORD}`));
  console.log('\nStudent portal: http://localhost:3000/login.html');
  console.log(`  e.g. aarav.demo@example.com   password: ${STUDENT_PASSWORD}  (also sneha, rohan, meera, kabir, isha, ravi, pooja, nikhil, tanvi)`);
  console.log('\nCAP verification demo: isha.demo@example.com submitted MH2026-10099 and sees "verification pending". Log in as an admin, open CAP records and verify it (the officer entered it, so use the super admin) and her details appear.');
  console.log('\nQueue demo: ravi, pooja, nikhil and tanvi have a verification appointment TODAY. Open Admin > Queue and issue tokens.');
})().catch((err) => { console.error('Seeding failed:', err); process.exit(1); });
