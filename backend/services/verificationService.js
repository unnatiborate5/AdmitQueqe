'use strict';
const db = require('../config/db');

/**
 * Physical verification of original documents happens in person at the college.
 * This service is READ-ONLY on purpose: students can never mark themselves verified.
 */
function get(studentId) {
  const row = db.prepare('SELECT * FROM verification_records WHERE student_id = ?').get(studentId);
  if (!row) return { status: 'pending', verifiedBy: null, verifiedAt: null, remarks: null, updatedAt: null };
  return {
    status: row.status,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    remarks: row.remarks,
    updatedAt: row.updated_at,
  };
}

module.exports = { get };
