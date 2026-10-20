'use strict';

const TOKEN_PREFIX = 'AF-';
const TOKEN_DIGITS = 3;

/**
 * Formats a sequence number into a permanent admission token.
 * e.g. 1 -> 'AF-001', 42 -> 'AF-042', 1000 -> 'AF-1000'
 */
function formatToken(sequenceNumber) {
  const numStr = String(sequenceNumber).padStart(TOKEN_DIGITS, '0');
  return `${TOKEN_PREFIX}${numStr}`;
}

/**
 * Finds the highest numeric sequence number in existing admission tokens.
 */
function getNextSequenceNumber(dbInstance) {
  const row = dbInstance.prepare(`
    SELECT MAX(CAST(SUBSTR(admission_token, 4) AS INTEGER)) AS maxSeq
      FROM students
     WHERE admission_token IS NOT NULL AND admission_token LIKE 'AF-%'
  `).get();
  return (row && row.maxSeq ? Number(row.maxSeq) : 0) + 1;
}

/**
 * Allocates a unique permanent admission token for a student if they don't already have one.
 * If the student already has a token, returns the existing token (strictly idempotent).
 *
 * @param {number} studentId
 * @param {import('better-sqlite3').Database} dbInstance
 * @returns {string|null} The permanent admission token (e.g. 'AF-001')
 */
function allocateAdmissionToken(studentId, dbInstance) {
  if (!studentId || !dbInstance) return null;

  const getExisting = () => {
    const row = dbInstance.prepare('SELECT admission_token FROM students WHERE id = ?').get(studentId);
    return row ? row.admission_token : null;
  };

  const existing = getExisting();
  if (existing) return existing;

  const performAllocation = () => {
    // Re-check under transaction
    const current = getExisting();
    if (current) return current;

    const nextSeq = getNextSequenceNumber(dbInstance);
    const token = formatToken(nextSeq);

    const result = dbInstance.prepare(`
      UPDATE students
         SET admission_token = ?
       WHERE id = ? AND admission_token IS NULL
    `).run(token, studentId);

    if (result.changes === 0) {
      // Race check: token might have been set by another concurrent call
      return getExisting();
    }
    return token;
  };

  if (dbInstance.inTransaction) {
    return performAllocation();
  }
  return dbInstance.transaction(performAllocation)();
}

/**
 * Returns the permanent admission token for a student, or null if unassigned.
 */
function getAdmissionToken(studentId, dbInstance) {
  if (!studentId || !dbInstance) return null;
  const row = dbInstance.prepare('SELECT admission_token FROM students WHERE id = ?').get(studentId);
  return row ? (row.admission_token || null) : null;
}

/**
 * Backfills permanent admission tokens for existing students who already have
 * a matched/verified CAP record but do not have an admission token yet.
 */
function backfillExistingTokens(dbInstance) {
  if (!dbInstance) return 0;

  const candidates = dbInstance.prepare(`
    SELECT s.id
      FROM students s
     WHERE s.admission_token IS NULL
       AND (
         EXISTS (SELECT 1 FROM cap_details c WHERE c.student_id = s.id)
         OR EXISTS (SELECT 1 FROM cap_allotment_records r WHERE r.linked_student_id = s.id AND r.status = 'verified')
       )
     ORDER BY s.id ASC
  `).all();

  if (!candidates.length) return 0;

  let assignedCount = 0;
  dbInstance.transaction(() => {
    for (const { id } of candidates) {
      const current = dbInstance.prepare('SELECT admission_token FROM students WHERE id = ?').get(id);
      if (!current || current.admission_token) continue;

      const nextSeq = getNextSequenceNumber(dbInstance);
      const token = formatToken(nextSeq);
      const res = dbInstance.prepare(`
        UPDATE students
           SET admission_token = ?
         WHERE id = ? AND admission_token IS NULL
      `).run(token, id);
      if (res.changes > 0) assignedCount++;
    }
  })();

  return assignedCount;
}

module.exports = {
  TOKEN_PREFIX,
  formatToken,
  getNextSequenceNumber,
  allocateAdmissionToken,
  getAdmissionToken,
  backfillExistingTokens,
};
