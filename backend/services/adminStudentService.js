'use strict';
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const capService = require('./capService');
const documentService = require('./documentService');
const feeService = require('./feeService');
const checklistService = require('./checklistService');
const dashboardService = require('./dashboardService');
const verificationService = require('./verificationService');
const verificationAdminService = require('./verificationAdminService');
const applicationService = require('./applicationService');
const appointmentService = require('./appointmentService');
const queueService = require('./queueService');
const { parsePaging, pick, likeTerm } = require('../utils/adminValidators');

const REVIEW_FILTERS = ['pending', 'approved', 'rejected', 'correction_requested', 'not_started'];
const VERIFICATION_FILTERS = ['awaiting', 'pending', 'in_progress', 'completed'];
const SORTS = {
  recent: 's.id DESC',
  name: 's.full_name COLLATE NOCASE ASC, s.id ASC',
  appointment: '(a.appointment_date IS NULL), a.appointment_date ASC, a.appointment_time ASC, s.id ASC',
};

const REVIEW_SQL = "CASE WHEN c.id IS NULL THEN 'not_started' ELSE COALESCE(r.status, 'pending') END";
const VERIF_SQL = "COALESCE(v.status, 'pending')";
const FROM = `FROM students s
  LEFT JOIN cap_details c ON c.student_id = s.id
  LEFT JOIN application_reviews r ON r.student_id = s.id
  LEFT JOIN verification_records v ON v.student_id = s.id
  LEFT JOIN appointments a ON a.student_id = s.id AND a.status = 'scheduled'`;

function list(query) {
  const { page, pageSize, offset } = parsePaging(query);
  const where = [];
  const args = [];

  if (query.search && String(query.search).trim()) {
    const t = likeTerm(query.search);
    where.push(`(s.full_name LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\'
                 OR c.application_id LIKE ? ESCAPE '\\' OR c.allotted_college LIKE ? ESCAPE '\\')`);
    args.push(t, t, t, t, t);
  }
  const status = pick(query.status, REVIEW_FILTERS);
  if (status) { where.push(`${REVIEW_SQL} = ?`); args.push(status); }

  const verification = pick(query.verification, VERIFICATION_FILTERS);
  if (verification === 'awaiting') where.push(`c.id IS NOT NULL AND ${VERIF_SQL} <> 'completed' AND COALESCE(r.status, 'pending') <> 'rejected'`);
  else if (verification) { where.push(`c.id IS NOT NULL AND ${VERIF_SQL} = ?`); args.push(verification); }

  const appointment = pick(query.appointment, ['none', 'scheduled']);
  if (appointment === 'scheduled') where.push('a.id IS NOT NULL');
  else if (appointment === 'none') where.push('a.id IS NULL AND c.id IS NOT NULL');

  const round = pick(query.round, capService.CAP_ROUNDS);
  if (round) { where.push('c.cap_round = ?'); args.push(round); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} ${clause}`).get(...args).n;
  const order = SORTS[query.sort] || SORTS.recent;
  const rows = db.prepare(
    `SELECT s.id, s.full_name, s.email, s.phone, s.created_at,
            c.application_id, c.allotted_college, c.course_branch, c.cap_round, c.allotment_status,
            ${REVIEW_SQL} AS review_status, ${VERIF_SQL} AS verification_status,
            a.appointment_date, a.appointment_time
       ${FROM} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...args, pageSize, offset);

  return {
    items: rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      email: r.email,
      phone: r.phone,
      registeredAt: r.created_at,
      applicationId: r.application_id,
      college: r.allotted_college,
      branch: r.course_branch,
      capRound: r.cap_round,
      allotmentStatus: r.allotment_status,
      reviewStatus: r.review_status,
      reviewLabel: applicationService.LABELS[r.review_status],
      verificationStatus: r.application_id ? r.verification_status : null,
      appointment: r.appointment_date ? { date: r.appointment_date, time: r.appointment_time } : null,
      progress: r.application_id ? dashboardService.getProgress(r.id) : null,
    })),
    options: { rounds: capService.CAP_ROUNDS },
    page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Everything an admin needs to inspect one application. Never includes the password hash. */
function getDetail(studentId) {
  const s = db.prepare('SELECT id, full_name, email, phone, created_at FROM students WHERE id = ?').get(studentId);
  if (!s) throw new ApiError(404, 'Student not found.');
  const student = { id: s.id, fullName: s.full_name, email: s.email, phone: s.phone };
  const cap = capService.get(s.id);
  const summary = dashboardService.getSummary(student);
  const accept = checklistService.getRecord(s.id, 'allotment_acceptance');
  const form = checklistService.getRecord(s.id, 'admission_form');

  return {
    student: { ...student, registeredAt: s.created_at },
    cap,
    hasApplication: Boolean(cap),
    review: cap ? applicationService.getReview(s.id) : { status: 'not_started', label: applicationService.LABELS.not_started },
    history: applicationService.getHistory(s.id),
    progress: summary.progress,
    tasks: summary.tasks.map((t) => ({ key: t.key, title: t.title, status: t.status, statusLabel: t.statusLabel, summary: t.summary })),
    records: { allotmentAcceptance: accept, admissionForm: form },
    documents: documentService.getDocuments(s.id).map((d) => ({ key: d.key, title: d.title, required: d.required, prepared: d.prepared })),
    fee: feeService.get(s.id),
    verification: (() => { const v = verificationService.get(s.id); return { ...v, label: verificationAdminService.LABELS[v.status] }; })(),
    appointment: appointmentService.getActive(s.id),
    appointments: appointmentService.listForStudent(s.id),
    queue: cap ? (() => { const p = queueService.checkInProblem(s.id); return { tokens: queueService.tokensForStudentToday(s.id), canCheckIn: Boolean(p && p.ok), checkInProblem: p && !p.ok ? p.message : null }; })() : null,
  };
}

module.exports = { REVIEW_FILTERS, VERIFICATION_FILTERS, list, getDetail };
