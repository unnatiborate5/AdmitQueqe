'use strict';
/**
 * Admin decisions on student applications (approve / reject / request corrections) and
 * the append-only status history. The student dashboard reads the same rows.
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const activityService = require('./activityService');

const LABELS = {
  pending: 'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
  correction_requested: 'Corrections Requested',
  not_started: 'Not Started',
};
const ACTION_LOG = { approved: 'application.approve', rejected: 'application.reject', correction_requested: 'application.request_corrections', pending: 'application.reopen' };

const hasApplication = (studentId) => Boolean(db.prepare('SELECT 1 FROM cap_details WHERE student_id = ?').get(studentId));

function requireStudent(studentId) {
  const s = db.prepare('SELECT id, full_name AS fullName FROM students WHERE id = ?').get(studentId);
  if (!s) throw new ApiError(404, 'Student not found.');
  return s;
}

function requireApplication(studentId) {
  const student = requireStudent(studentId);
  const cap = db.prepare('SELECT application_id FROM cap_details WHERE student_id = ?').get(studentId);
  if (!cap) {
    throw new ApiError(409, 'This student has not entered CAP details yet, so there is no application to review.', null, 'NO_APPLICATION');
  }
  return { student, applicationId: cap.application_id };
}

function getReview(studentId) {
  const r = db.prepare('SELECT * FROM application_reviews WHERE student_id = ?').get(studentId);
  const status = r ? r.status : 'pending';
  return {
    status,
    label: LABELS[status],
    remarks: r ? r.remarks : null,
    reviewedBy: r ? r.reviewed_by_name : null,
    reviewedAt: r ? r.reviewed_at : null,
    updatedAt: r ? r.updated_at : null,
  };
}

/** Full history, newest first. Includes internal notes: admin-only. */
function getHistory(studentId) {
  return db.prepare('SELECT * FROM application_status_history WHERE student_id = ? ORDER BY id DESC').all(studentId).map((h) => ({
    id: h.id,
    type: h.event_type,
    fromStatus: h.from_status,
    toStatus: h.to_status,
    toLabel: LABELS[h.to_status],
    fromLabel: h.from_status ? LABELS[h.from_status] : null,
    remarks: h.remarks,
    actorType: h.actor_type,
    actorName: h.actor_name,
    createdAt: h.created_at,
  }));
}

/** What the student sees: the current decision and status changes only. No internal notes, no admin names. */
function getStudentView(studentId) {
  const review = getReview(studentId);
  const history = db.prepare(
    "SELECT * FROM application_status_history WHERE student_id = ? AND event_type = 'status_change' ORDER BY id DESC LIMIT 10"
  ).all(studentId).map((h) => ({
    toStatus: h.to_status,
    label: LABELS[h.to_status],
    remarks: h.remarks,
    by: h.actor_type === 'student' ? 'You' : 'College',
    createdAt: h.created_at,
  }));
  return {
    status: review.status,
    label: review.label,
    remarks: review.status === 'pending' ? null : review.remarks,
    decidedAt: review.status === 'pending' ? null : review.reviewedAt,
    canResubmit: review.status === 'correction_requested',
    history,
  };
}

function review(admin, studentId, { targetStatus, action, remarks, expectedStatus }) {
  return db.transaction(() => {
    const { student, applicationId } = requireApplication(studentId);
    const current = getReview(studentId).status;
    if (expectedStatus && expectedStatus !== current) {
      throw new ApiError(409, `This application was just changed by someone else (now "${LABELS[current]}"). Refresh and try again.`, null, 'STALE_STATUS');
    }
    if (current === targetStatus) {
      throw new ApiError(409, `This application is already "${LABELS[current]}".`, null, 'NO_CHANGE');
    }
    db.prepare(
      `INSERT INTO application_reviews (student_id, status, remarks, reviewed_by_name, reviewed_by_admin_id, reviewed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(student_id) DO UPDATE SET status = excluded.status, remarks = excluded.remarks,
         reviewed_by_name = excluded.reviewed_by_name, reviewed_by_admin_id = excluded.reviewed_by_admin_id,
         reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at`
    ).run(studentId, targetStatus, remarks, admin.fullName, admin.id);
    db.prepare(
      `INSERT INTO application_status_history (student_id, event_type, from_status, to_status, remarks, actor_type, admin_id, actor_name)
       VALUES (?, 'status_change', ?, ?, ?, 'admin', ?, ?)`
    ).run(studentId, current, targetStatus, remarks, admin.id, admin.fullName);
    activityService.log(admin, {
      action: ACTION_LOG[targetStatus],
      student,
      summary: `${LABELS[targetStatus]}: application ${applicationId} of ${student.fullName}`,
      details: { from: current, to: targetStatus, remarks },
    });
    return getReview(studentId);
  })();
}

/** Internal note: stored in the history and the audit log, never shown to the student. */
function addNote(admin, studentId, remarks) {
  return db.transaction(() => {
    const { student, applicationId } = requireApplication(studentId);
    const current = getReview(studentId).status;
    db.prepare(
      `INSERT INTO application_status_history (student_id, event_type, from_status, to_status, remarks, actor_type, admin_id, actor_name)
       VALUES (?, 'remark', ?, ?, ?, 'admin', ?, ?)`
    ).run(studentId, current, current, remarks, admin.id, admin.fullName);
    activityService.log(admin, {
      action: 'application.note',
      student,
      summary: `Added an internal note on application ${applicationId} of ${student.fullName}`,
      details: { remarks },
    });
  })();
}

/** Student side: "I have made the requested corrections" puts the application back in the review queue. */
function resubmit(student, note) {
  return db.transaction(() => {
    const current = getReview(student.id).status;
    if (current !== 'correction_requested') {
      throw new ApiError(409, 'There are no corrections pending on your application.', null, 'NO_CORRECTIONS_PENDING');
    }
    db.prepare(
      `UPDATE application_reviews SET status = 'pending', remarks = NULL, reviewed_by_name = NULL, reviewed_by_admin_id = NULL,
         reviewed_at = NULL, updated_at = datetime('now') WHERE student_id = ?`
    ).run(student.id);
    db.prepare(
      `INSERT INTO application_status_history (student_id, event_type, from_status, to_status, remarks, actor_type, actor_name)
       VALUES (?, 'status_change', 'correction_requested', 'pending', ?, 'student', ?)`
    ).run(student.id, note || 'Student marked the requested corrections as done.', student.fullName);
    return getStudentView(student.id);
  })();
}

module.exports = { LABELS, hasApplication, requireStudent, requireApplication, getReview, getHistory, getStudentView, review, addNote, resubmit };
