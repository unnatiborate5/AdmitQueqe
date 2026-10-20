'use strict';
/**
 * Officer-reviewed workflow for admission tasks 2–6.
 * Task 1 (CAP details) is not stored here: it is read-only once a verified CAP record is linked.
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');

const TASK_KEYS = [
  'allotment_acceptance',
  'admission_form',
  'document_preparation',
  'physical_verification',
  'fee_payment',
];

const STATUSES = ['not_started', 'submitted', 'pending_review', 'approved', 'correction_required'];

const LABELS = {
  not_started: 'Not Started',
  submitted: 'Submitted',
  pending_review: 'Pending Review',
  approved: 'Approved',
  correction_required: 'Correction Required',
};

const STUDENT_TRANSITIONS = {
  not_started: ['submitted', 'pending_review'],
  submitted: ['not_started', 'submitted', 'pending_review'],
  pending_review: ['pending_review', 'submitted'],
  correction_required: ['correction_required', 'submitted', 'pending_review'],
  approved: [],
};

const OFFICER_TRANSITIONS = {
  not_started: [],
  submitted: ['pending_review', 'approved', 'correction_required'],
  pending_review: ['approved', 'correction_required'],
  correction_required: ['pending_review'],
  approved: ['correction_required'],
};

const empty = () => ({
  status: 'not_started',
  correctionReason: null,
  reviewedBy: null,
  reviewedByAdminId: null,
  reviewedAt: null,
  updatedAt: null,
});

function requireTaskKey(key) {
  if (!TASK_KEYS.includes(key)) throw new ApiError(404, 'Unknown task.');
}

function get(studentId, key) {
  requireTaskKey(key);
  const r = db.prepare(
    `SELECT status, correction_reason, reviewed_by_name, reviewed_by_admin_id, reviewed_at, updated_at
       FROM task_reviews WHERE student_id = ? AND task_key = ?`
  ).get(studentId, key);
  if (!r) return empty();
  return {
    status: r.status,
    correctionReason: r.correction_reason || null,
    reviewedBy: r.reviewed_by_name || null,
    reviewedByAdminId: r.reviewed_by_admin_id || null,
    reviewedAt: r.reviewed_at || null,
    updatedAt: r.updated_at || null,
  };
}

function upsert(studentId, key, fields) {
  requireTaskKey(key);
  db.prepare(
    `INSERT INTO task_reviews (student_id, task_key, status, correction_reason, reviewed_by_name, reviewed_by_admin_id, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id, task_key) DO UPDATE SET
       status = excluded.status,
       correction_reason = excluded.correction_reason,
       reviewed_by_name = excluded.reviewed_by_name,
       reviewed_by_admin_id = excluded.reviewed_by_admin_id,
       reviewed_at = excluded.reviewed_at,
       updated_at = datetime('now')`
  ).run(
    studentId,
    key,
    fields.status,
    fields.correctionReason || null,
    fields.reviewedBy || null,
    fields.reviewedByAdminId || null,
    fields.reviewedAt || null
  );
}

function assertStudentTransition(from, to) {
  if (!(STUDENT_TRANSITIONS[from] || []).includes(to)) {
    throw new ApiError(409, `This task cannot move from "${LABELS[from]}" to "${LABELS[to]}".`, null, 'INVALID_TRANSITION');
  }
}

function assertOfficerTransition(from, to) {
  if (!(OFFICER_TRANSITIONS[from] || []).includes(to)) {
    throw new ApiError(409, `Officers cannot move this task from "${LABELS[from]}" to "${LABELS[to]}".`, null, 'INVALID_TRANSITION');
  }
}

/** Student save/submit. Never writes approved. */
function studentMove(studentId, key, toStatus) {
  requireTaskKey(key);
  if (toStatus === 'approved') {
    throw new ApiError(403, 'Students cannot approve tasks. An admission officer must review this.', null, 'STUDENT_CANNOT_APPROVE');
  }
  if (!STATUSES.includes(toStatus)) throw new ApiError(400, 'Unknown task status.', { status: 'Select a valid status.' });
  const current = get(studentId, key);
  if (current.status === 'approved') {
    throw new ApiError(403, 'This task is approved and can no longer be changed by you.', null, 'TASK_LOCKED');
  }
  assertStudentTransition(current.status, toStatus);
  const keepCorrection = toStatus === 'correction_required' || (toStatus !== 'pending_review' && current.status === 'correction_required');
  upsert(studentId, key, {
    status: toStatus,
    correctionReason: keepCorrection ? current.correctionReason : null,
    reviewedBy: current.reviewedBy,
    reviewedByAdminId: current.reviewedByAdminId,
    reviewedAt: current.reviewedAt,
  });
  return get(studentId, key);
}

function officerReview(admin, studentId, key, { action, remarks }) {
  requireTaskKey(key);
  const current = get(studentId, key);
  let next;
  let reason = null;
  if (action === 'approve') {
    next = 'approved';
  } else if (action === 'request_corrections') {
    next = 'correction_required';
    const text = typeof remarks === 'string' ? remarks.trim() : '';
    if (text.length < 5) {
      throw new ApiError(400, 'Please correct the highlighted fields.', {
        remarks: 'A correction reason (at least 5 characters) is required. The student will see it.',
      });
    }
    if (text.length > 1000) {
      throw new ApiError(400, 'Please correct the highlighted fields.', { remarks: 'Remarks can be at most 1000 characters.' });
    }
    reason = text;
  } else {
    throw new ApiError(400, 'Please correct the highlighted fields.', { action: 'Choose approve or request corrections.' });
  }
  assertOfficerTransition(current.status, next);
  upsert(studentId, key, {
    status: next,
    correctionReason: reason,
    reviewedBy: admin.fullName,
    reviewedByAdminId: admin.id,
    reviewedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  });
  return get(studentId, key);
}

function isCompleteStatus(status) {
  return status === 'completed' || status === 'approved';
}

module.exports = {
  TASK_KEYS, STATUSES, LABELS, STUDENT_TRANSITIONS, OFFICER_TRANSITIONS,
  get, studentMove, officerReview, isCompleteStatus, requireTaskKey,
};
