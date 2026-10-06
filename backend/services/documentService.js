'use strict';
const db = require('../config/db');

/** Documents a student typically needs. The college's own notice is always the final word. */
const DOCUMENTS = [
  { key: 'cap_allotment_letter', title: 'CAP Allotment Letter', note: 'Printout from the CAP portal', required: true },
  { key: 'ssc_marksheet', title: 'SSC (10th) Marksheet', note: 'Original and photocopies', required: true },
  { key: 'hsc_marksheet', title: 'HSC (12th) Marksheet', note: 'Original and photocopies', required: true },
  { key: 'leaving_certificate', title: 'School Leaving / Transfer Certificate', note: 'Original and photocopies', required: true },
  { key: 'entrance_scorecard', title: 'Entrance Exam Scorecard', note: 'MHT-CET / JEE Main / other exam used for CAP', required: true },
  { key: 'photo_id', title: 'Photo ID Proof', note: 'For example Aadhaar card; original and photocopy', required: true },
  { key: 'passport_photos', title: 'Passport-size Photographs', note: 'Recent colour photographs', required: true },
  { key: 'category_certificate', title: 'Caste / Category Certificate and Validity', note: 'Only if you claimed a reserved category', required: false },
  { key: 'domicile_certificate', title: 'Domicile / Nationality Certificate', note: 'Only if your college asks for it', required: false },
];

const KEYS = DOCUMENTS.map((d) => d.key);
const REQUIRED_COUNT = DOCUMENTS.filter((d) => d.required).length;

function getDocuments(studentId) {
  const rows = db.prepare('SELECT doc_key, prepared FROM document_status WHERE student_id = ?').all(studentId);
  const prepared = new Map(rows.map((r) => [r.doc_key, r.prepared === 1]));
  return DOCUMENTS.map((d) => ({ ...d, prepared: prepared.get(d.key) === true }));
}

/** Status is derived from the checklist: nothing -> pending, all required done -> completed, otherwise in progress. */
function getSummary(studentId) {
  const docs = getDocuments(studentId);
  const required = docs.filter((d) => d.required);
  const preparedRequired = required.filter((d) => d.prepared).length;
  const anyPrepared = docs.some((d) => d.prepared);
  let status = 'pending';
  if (preparedRequired === required.length) status = 'completed';
  else if (anyPrepared) status = 'in_progress';
  const last = db.prepare('SELECT MAX(updated_at) AS u FROM document_status WHERE student_id = ?').get(studentId);
  return {
    status,
    preparedRequired,
    requiredTotal: required.length,
    preparedTotal: docs.filter((d) => d.prepared).length,
    updatedAt: last && last.u ? last.u : null,
  };
}

/** Replaces the student's prepared-document selection. */
function savePrepared(studentId, preparedKeys) {
  const chosen = new Set(preparedKeys);
  const upsert = db.prepare(
    `INSERT INTO document_status (student_id, doc_key, prepared) VALUES (?, ?, ?)
     ON CONFLICT(student_id, doc_key) DO UPDATE SET prepared = excluded.prepared, updated_at = datetime('now')`
  );
  db.transaction(() => {
    KEYS.forEach((key) => upsert.run(studentId, key, chosen.has(key) ? 1 : 0));
  })();
}

module.exports = { DOCUMENTS, KEYS, REQUIRED_COUNT, getDocuments, getSummary, savePrepared };
