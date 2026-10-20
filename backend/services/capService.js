'use strict';
const db = require('../config/db');

const CAP_ROUNDS = ['Round 1', 'Round 2', 'Round 3', 'Special Round'];
const ALLOTMENT_STATUSES = [
  'Allotted',
  'Allotted (Auto-Freeze)',
  'Allotted (Float)',
  'Allotted (Slide)',
  'Seat Cancelled',
];
const CANCELLED_STATUS = 'Seat Cancelled';

const toDto = (r) => ({
  applicationId: r.application_id,
  studentName: r.student_name,
  allottedCollege: r.allotted_college,
  courseBranch: r.course_branch,
  capRound: r.cap_round,
  allotmentStatus: r.allotment_status,
  updatedAt: r.updated_at,
  verified: true,   // a cap_details row only ever exists for a student linked to a VERIFIED record
});

/**
 * The student's CAP details, or null. This module is deliberately READ-ONLY: cap_details is written only by
 * capRecordService, when a verified record is linked to a student. There is no function here that accepts values
 * typed by a student.
 */
function get(studentId) {
  const row = db.prepare('SELECT * FROM cap_details WHERE student_id = ?').get(studentId);
  return row ? toDto(row) : null;
}

module.exports = { CAP_ROUNDS, ALLOTMENT_STATUSES, CANCELLED_STATUS, get };
