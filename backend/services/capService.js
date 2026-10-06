'use strict';
const db = require('../config/db');
const ApiError = require('../utils/ApiError');

const CAP_ROUNDS = ['Round 1', 'Round 2', 'Round 3', 'Special Round'];
const ALLOTMENT_STATUSES = [
  'Allotted',
  'Allotted (Auto-Freeze)',
  'Allotted (Float)',
  'Allotted (Slide)',
  'Seat Cancelled',
];
const CANCELLED_STATUS = 'Seat Cancelled';

const DUPLICATE_APP_ID = {
  message: 'This Application ID is already registered to another account.',
  errors: { applicationId: 'This Application ID is already in use.' },
};

const toDto = (r) => ({
  applicationId: r.application_id,
  studentName: r.student_name,
  allottedCollege: r.allotted_college,
  courseBranch: r.course_branch,
  capRound: r.cap_round,
  allotmentStatus: r.allotment_status,
  updatedAt: r.updated_at,
});

function get(studentId) {
  const row = db.prepare('SELECT * FROM cap_details WHERE student_id = ?').get(studentId);
  return row ? toDto(row) : null;
}

function save(studentId, v) {
  const owner = db.prepare('SELECT student_id FROM cap_details WHERE application_id = ?').get(v.applicationId);
  if (owner && owner.student_id !== studentId) {
    throw new ApiError(409, DUPLICATE_APP_ID.message, DUPLICATE_APP_ID.errors);
  }
  try {
    db.prepare(
      `INSERT INTO cap_details
         (student_id, application_id, student_name, allotted_college, course_branch, cap_round, allotment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(student_id) DO UPDATE SET
         application_id = excluded.application_id,
         student_name = excluded.student_name,
         allotted_college = excluded.allotted_college,
         course_branch = excluded.course_branch,
         cap_round = excluded.cap_round,
         allotment_status = excluded.allotment_status,
         updated_at = datetime('now')`
    ).run(studentId, v.applicationId, v.studentName, v.allottedCollege, v.courseBranch, v.capRound, v.allotmentStatus);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err.message))) {
      throw new ApiError(409, DUPLICATE_APP_ID.message, DUPLICATE_APP_ID.errors);
    }
    throw err;
  }
  return get(studentId);
}

module.exports = { CAP_ROUNDS, ALLOTMENT_STATUSES, CANCELLED_STATUS, get, save };
