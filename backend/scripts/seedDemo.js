'use strict';
/**
 * DEVELOPMENT ONLY: creates one demo admin per role and demo students in different stages,
 * so the admin portal, queue, and planner have realistic, varied data to show.
 * Safe to run more than once (existing accounts, records, and appointments are preserved).
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
const queueService = require('../services/queueService');

const ADMIN_PASSWORD = 'Demo@Admit2026';
const STUDENT_PASSWORD = 'Student@2026';

const DEMO_ADMINS = [
  { fullName: 'Demo Super Admin', email: 'superadmin@admitflow.local', role: 'super_admin' },
  { fullName: 'Demo Admission Officer', email: 'officer@admitflow.local', role: 'admission_officer' },
  { fullName: 'Demo Viewer', email: 'viewer@admitflow.local', role: 'viewer' },
];

const REQUIRED_DOCS = ['cap_allotment_letter', 'ssc_marksheet', 'hsc_marksheet', 'leaving_certificate', 'entrance_scorecard', 'photo_id', 'passport_photos'];
const COLLEGE = 'VIT Pune';
const done = (d) => ({ status: 'completed', eventDate: d });

const STUDENTS = [
  // --- Core baseline demo students ---
  { name: 'Aarav Deshmukh', phone: '9811100001', app: 'MH2026-10001', branch: 'Computer Engineering', stage: 'ready' },
  { name: 'Sneha Patil', phone: '9811100002', app: 'MH2026-10002', branch: 'Information Technology', stage: 'cap_only' },
  { name: 'Rohan Joshi', phone: '9811100003', app: 'MH2026-10003', branch: 'Mechanical Engineering', stage: 'approved' },
  { name: 'Meera Kulkarni', phone: '9811100004', app: 'MH2026-10004', branch: 'Electronics & Telecommunication', stage: 'corrections' },
  { name: 'Kabir Shaikh', phone: '9811100005', app: 'MH2026-10005', branch: 'Civil Engineering', stage: 'appointment' },
  { name: 'Isha Pawar', phone: '9811100006', app: null, branch: null, stage: 'registered', pendingClaim: 'MH2026-10099' },
  { name: 'Ravi Kale', phone: '9811100007', app: 'MH2026-10007', branch: 'Computer Engineering', stage: 'today', round: 'Round 1' },
  { name: 'Pooja Bhosale', phone: '9811100008', app: 'MH2026-10008', branch: 'Information Technology', stage: 'today', round: 'Round 3' },
  { name: 'Nikhil Gaikwad', phone: '9811100009', app: 'MH2026-10009', branch: 'Mechanical Engineering', stage: 'today', round: 'Round 1', returning: true },
  { name: 'Tanvi Jadhav', phone: '9811100010', app: 'MH2026-10010', branch: 'Civil Engineering', stage: 'today', round: 'Round 1' },

  // --- 18 additional demo students for realistic Dashboard, Queue, and Planner data ---
  // Unscheduled (ready for appointment, but unscheduled -> populates Planner Section 1)
  {
    name: 'Aditya Joshi', email: 'aditya.joshi.demo@example.com', phone: '9811100011',
    app: 'MH2026-81005', branch: 'Artificial Intelligence and Data Science', round: 'Round 1',
    stage: 'unscheduled_ready',
  },
  {
    name: 'Sneha Kulkarni', email: 'sneha.kulkarni.demo@example.com', phone: '9811100012',
    app: 'MH2026-81004', branch: 'Computer Science and Engineering (Artificial Intelligence and Machine Learning)', round: 'Round 2',
    stage: 'unscheduled_ready', returning: true,
  },
  {
    name: 'Divya Sawant', email: 'divya.sawant.demo@example.com', phone: '9811100013',
    app: 'MH2026-20002', branch: 'Mechanical Engineering', round: 'Round 3',
    stage: 'unscheduled_ready', preparedDocs: REQUIRED_DOCS.slice(0, 5),
  },
  {
    name: 'Kavita Thorat', email: 'kavita.thorat.demo@example.com', phone: '9811100014',
    app: 'MH2026-20004', branch: 'Civil Engineering', round: 'Special Round',
    stage: 'unscheduled_ready', preparedDocs: REQUIRED_DOCS.slice(0, 6),
  },

  // Appointments TODAY with queue activity (populates Queue page and Planner Section 2)
  {
    name: 'Aarav Sharma', email: 'aarav.sharma.demo@example.com', phone: '9811100015',
    app: 'MH2026-81001', branch: 'Computer Engineering', round: 'Round 1',
    stage: 'today_queue', time: '09:30',
  },
  {
    name: 'Omkar Jadhav', email: 'omkar.jadhav.demo@example.com', phone: '9811100016',
    app: 'MH2026-81007', branch: 'Computer Engineering', round: 'Round 2',
    stage: 'today_queue', time: '10:00', returning: true,
  },
  {
    name: 'Sanya Mirza', email: 'sanya.mirza.demo@example.com', phone: '9811100017',
    app: 'MH2026-20006', branch: 'Computer Engineering', round: 'Round 3',
    stage: 'today_queue', time: '11:30', preparedDocs: REQUIRED_DOCS.slice(0, 6),
  },
  {
    name: 'Ananya Patil', email: 'ananya.patil.demo@example.com', phone: '9811100018',
    app: 'MH2026-81002', branch: 'Information Technology', round: 'Round 1',
    stage: 'today_queue_serving', time: '09:00',
  },
  {
    name: 'Priya Shinde', email: 'priya.shinde.demo@example.com', phone: '9811100019',
    app: 'MH2026-81006', branch: 'Computer Science and Engineering (Data Science)', round: 'Round 2',
    stage: 'today_queue_completed', time: '09:00',
  },
  {
    name: 'Meera Chavan', email: 'meera.chavan.demo@example.com', phone: '9811100020',
    app: 'MH2026-81010', branch: 'Computer Science and Engineering (Artificial Intelligence and Machine Learning)', round: 'Round 1',
    stage: 'today_eligible', time: '14:00',
  },
  {
    name: 'Neha Gaikwad', email: 'neha.gaikwad.demo@example.com', phone: '9811100021',
    app: 'MH2026-81011', branch: 'Artificial Intelligence and Data Science', round: 'Round 2',
    stage: 'today_eligible', time: '15:30', preparedDocs: REQUIRED_DOCS.slice(0, 5),
  },

  // Future appointments across varied dates & time slots (populates Planner Section 3 load heatmap)
  {
    name: 'Unnati Borate', email: 'unnati.borate.demo@example.com', phone: '9811100022',
    app: 'MH2026-1700', branch: 'Computer Science and Engineering (Artificial Intelligence)', round: 'Special Round',
    stage: 'future_appt', daysAhead: 1, time: '10:00', preparedDocs: ['cap_allotment_letter', 'ssc_marksheet', 'hsc_marksheet', 'photo_id'],
  },
  {
    name: 'Isha Datt', email: 'isha.datt.demo@example.com', phone: '9811100023',
    app: 'MH2026-17000', branch: 'Computer Science and Engineering (Data Science)', round: 'Round 2',
    stage: 'future_appt', daysAhead: 1, time: '11:00', preparedDocs: REQUIRED_DOCS.slice(0, 6),
  },
  {
    name: 'Aditya Verma', email: 'aditya.verma.demo@example.com', phone: '9811100024',
    app: 'MH2026-70002', branch: 'Computer Engineering', round: 'Round 1',
    stage: 'future_appt', daysAhead: 2, time: '10:30', preparedDocs: REQUIRED_DOCS.slice(0, 5),
  },
  {
    name: 'Kunal Mohite', email: 'kunal.mohite.demo@example.com', phone: '9811100025',
    app: 'MH2026-20001', branch: 'Electronics & Telecommunication', round: 'Round 2',
    stage: 'future_appt', daysAhead: 2, time: '14:30', preparedDocs: ['cap_allotment_letter', 'ssc_marksheet', 'photo_id', 'passport_photos'],
  },
  {
    name: 'Pranav Jagtap', email: 'pranav.jagtap.demo@example.com', phone: '9811100026',
    app: 'MH2026-20003', branch: 'Computer Science and Engineering (Artificial Intelligence)', round: 'Round 1',
    stage: 'future_appt', daysAhead: 3, time: '09:30', preparedDocs: REQUIRED_DOCS.slice(0, 6),
  },
  {
    name: 'Vikram Salunkhe', email: 'vikram.salunkhe.demo@example.com', phone: '9811100027',
    app: 'MH2026-20005', branch: 'Information Technology', round: 'Round 2',
    stage: 'future_appt', daysAhead: 4, time: '11:00', preparedDocs: ['cap_allotment_letter', 'ssc_marksheet', 'entrance_scorecard'],
  },

  // In-progress / partial documents (populates Planner Section 4 document readiness stats)
  {
    name: 'Gaurav Mane', email: 'gaurav.mane.demo@example.com', phone: '9811100028',
    app: 'MH2026-20007', branch: 'Mechanical Engineering', round: 'Round 1',
    stage: 'partial_docs', preparedDocs: ['cap_allotment_letter', 'photo_id'],
  },
];

(async () => {
  try {
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
      const email = s.email || `${s.name.split(' ')[0].toLowerCase()}.demo@example.com`;
      if (db.prepare('SELECT 1 FROM students WHERE email = ?').get(email)) continue;
      const student = await authService.register({ fullName: s.name, email, phone: s.phone, password: STUDENT_PASSWORD });
      const me = db.prepare('SELECT id, full_name AS fullName FROM students WHERE id = ?').get(student.id);
      if (!s.app) {
        if (s.pendingClaim && !db.prepare('SELECT 1 FROM cap_claims WHERE student_id = ?').get(me.id)) {
          capRecordService.claim(me, s.pendingClaim);
        }
        continue;
      }

      // Check whether record already exists; if not, create it
      let rec = db.prepare('SELECT id FROM cap_allotment_records WHERE application_id = ?').get(s.app);
      if (!rec) {
        rec = capRecordService.create(admins.admission_officer, {
          applicationId: s.app,
          candidateName: s.name.toUpperCase(),
          allottedCollege: COLLEGE,
          courseBranch: s.branch,
          capRound: s.round || 'Round 1',
          allotmentStatus: 'Allotted',
          sourceNote: 'Demo data',
        });
      }

      // Link student to record if not yet linked
      if (!db.prepare('SELECT 1 FROM cap_details WHERE student_id = ?').get(me.id)) {
        capRecordService.claim(me, s.app);
      }
      if (s.stage === 'cap_only') continue;

      taskService.saveTask(student.id, 'allotment_acceptance', done(yesterday));
      taskService.saveTask(student.id, 'admission_form', done(yesterday));
      taskService.saveTask(student.id, 'document_preparation', {
        preparedDocs: s.preparedDocs || (s.stage === 'corrections' ? REQUIRED_DOCS.slice(0, 4) : REQUIRED_DOCS),
      });
      if (s.stage === 'partial_docs') continue;

      taskService.saveTask(student.id, 'fee_payment', {
        status: 'completed', totalFee: '95000', amountPaid: '95000', paymentMode: 'Demand Draft', receiptNumber: `DD-${s.app.slice(-5)}`, paidOn: yesterday,
      });

      if (s.stage === 'unscheduled_ready') {
        if (s.returning && !db.prepare('SELECT 1 FROM verification_records WHERE student_id = ?').get(student.id)) {
          verificationAdminService.record(actor, student.id, { status: 'in_progress', remarks: 'Returning student to complete verification.' });
        }
      } else if (s.stage === 'today' || s.stage === 'today_eligible') {
        if (!appointmentService.getActive(student.id)) {
          appointmentService.schedule(actor, {
            studentId: student.id,
            date: time.today(),
            time: s.time || '10:30',
            venue: 'Admission Cell, Main Building, Room 12',
            instructions: 'Bring all originals and two photocopies of each document.',
          });
        }
        if (s.returning && !db.prepare('SELECT 1 FROM verification_records WHERE student_id = ?').get(student.id)) {
          verificationAdminService.record(actor, student.id, { status: 'in_progress', remarks: 'One document missing; returning to complete.' });
        }
      } else if (s.stage === 'today_queue' || s.stage === 'today_queue_serving' || s.stage === 'today_queue_completed') {
        if (!appointmentService.getActive(student.id)) {
          appointmentService.schedule(actor, {
            studentId: student.id,
            date: time.today(),
            time: s.time || '10:30',
            venue: 'Admission Cell, Main Building, Room 12',
            instructions: 'Bring all originals and two photocopies of each document.',
          });
        }
        if (s.returning && !db.prepare('SELECT 1 FROM verification_records WHERE student_id = ?').get(student.id)) {
          verificationAdminService.record(actor, student.id, { status: 'in_progress', remarks: 'Returning student to complete verification.' });
        }

        const hasToken = db.prepare('SELECT id, token_code, status FROM queue_tokens WHERE student_id = ? AND queue_date = ?').get(student.id, time.today());
        if (!hasToken) {
          await queueService.checkIn(actor, student.id);
          if (s.stage === 'today_queue_serving') {
            try {
              const called = await queueService.callNext(actor, 1);
              await queueService.transition(actor, called.id, 'start');
            } catch (_) { /* ignore if counter occupied */ }
          } else if (s.stage === 'today_queue_completed') {
            try {
              const called = await queueService.callNext(actor, 2);
              await queueService.transition(actor, called.id, 'start');
              await queueService.transition(actor, called.id, 'complete');
            } catch (_) { /* ignore if counter occupied */ }
          }
        }
      } else if (s.stage === 'future_appt' || s.stage === 'appointment') {
        if (!appointmentService.getActive(student.id)) {
          appointmentService.schedule(actor, {
            studentId: student.id,
            date: time.addDays(s.daysAhead || 3),
            time: s.time || '10:30',
            venue: 'Admission Cell, Main Building, Room 12',
            instructions: 'Bring all originals and two photocopies of each document.',
          });
        }
      } else if (s.stage === 'approved') {
        if (!db.prepare('SELECT 1 FROM verification_records WHERE student_id = ?').get(student.id)) {
          verificationAdminService.record(actor, student.id, { status: 'completed', remarks: 'All originals matched.' });
        }
        if (applicationService.getReview(student.id).status !== 'approved') {
          applicationService.review(actor, student.id, { action: 'approve', targetStatus: 'approved', remarks: 'Documents verified and fee received.' });
        }
      } else if (s.stage === 'corrections') {
        if (applicationService.getReview(student.id).status !== 'correction_requested') {
          applicationService.review(actor, student.id, {
            action: 'request_corrections', targetStatus: 'correction_requested', remarks: 'Please prepare your HSC marksheet, leaving certificate and Aadhaar copy.',
          });
        }
      }
    }

    // Additional unlinked records so the CAP records page has unclaimed allotment records.
    const unclaimedRecords = [
      { applicationId: 'MH2026-10099', candidateName: 'PAWAR ISHA', allottedCollege: COLLEGE, courseBranch: 'Computer Engineering', capRound: 'Round 2', allotmentStatus: 'Allotted', sourceNote: 'Demo data' },
      { applicationId: 'MH2026-10098', candidateName: 'UNCLAIMED CANDIDATE', allottedCollege: COLLEGE, courseBranch: 'Civil Engineering', capRound: 'Round 1', allotmentStatus: 'Allotted', sourceNote: 'Demo data' },
    ];
    for (const r of unclaimedRecords) {
      if (!db.prepare('SELECT 1 FROM cap_allotment_records WHERE application_id = ?').get(r.applicationId)) {
        capRecordService.create(admins.admission_officer, r);
      }
    }
    const isha = db.prepare("SELECT id FROM students WHERE email = 'isha.demo@example.com'").get();
    if (isha && !db.prepare('SELECT 1 FROM cap_claims WHERE student_id = ?').get(isha.id)) {
      capRecordService.claim(db.prepare('SELECT id, full_name AS fullName FROM students WHERE id = ?').get(isha.id), 'MH2026-10099');
    }

    console.log('Demo data ready.\n');
    console.log('Admin portal: http://localhost:3000/admin/login.html');
    DEMO_ADMINS.forEach((a) => console.log(`  ${a.role.padEnd(18)} ${a.email}   password: ${ADMIN_PASSWORD}`));
    console.log('\nStudent portal: http://localhost:3000/login.html');
    console.log(`  e.g. aarav.demo@example.com   password: ${STUDENT_PASSWORD}`);
    console.log(`  18 additional students seeded across various stages (unscheduled, queue, future appointments, partial docs).`);
  } finally {
    queueService.shutdown();
  }
})().catch((err) => { console.error('Seeding failed:', err); process.exit(1); });
