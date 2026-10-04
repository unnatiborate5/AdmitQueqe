'use strict';
const db = require('../config/db');
const ApiError = require('../utils/ApiError');

const STATUSES = ['pending', 'in_progress', 'completed'];

/**
 * Admission checklist definition (in display order).
 * `labels` maps the three generic statuses to wording that fits each item.
 */
const ITEMS = [
  {
    key: 'allotment_acceptance',
    title: 'CAP Allotment Acceptance',
    description: 'Accept your allotted seat on the CAP portal within the schedule of your round.',
    guidance: 'Log in to the official CAP portal, choose your acceptance option, and download the allotment letter. Check the official schedule for the last date.',
    labels: { pending: 'Not Accepted', in_progress: 'Acceptance In Progress', completed: 'Seat Accepted' },
  },
  {
    key: 'admission_form',
    title: 'Admission Form',
    description: 'Fill in the college admission form along with the CAP-generated confirmation form.',
    guidance: 'Collect the form from the college website or admission desk, fill it carefully, and keep a signed printout ready.',
    labels: { pending: 'Not Filled', in_progress: 'Partially Filled', completed: 'Form Submitted' },
  },
  {
    key: 'document_preparation',
    title: 'Document Preparation',
    description: 'Arrange original documents and attested photocopies required by your college.',
    guidance: 'Typical items: CAP allotment letter, 10th and 12th marksheets, leaving certificate, entrance exam scorecard, photo ID, passport photos, and category/domicile certificates if applicable. Confirm the exact list on your college notice.',
    labels: { pending: 'Not Started', in_progress: 'Partially Ready', completed: 'All Documents Ready' },
  },
  {
    key: 'physical_verification',
    title: 'Physical Document Verification',
    description: 'Originals are verified in person at the college. Update this only after your visit.',
    guidance: 'Visit the college with originals and photocopies on your allotted date. The college verifies documents manually; AdmitFlow only records your status.',
    labels: { pending: 'Not Verified', in_progress: 'Verification In Progress', completed: 'Verified at College' },
  },
  {
    key: 'fee_payment',
    title: 'Fee / Payment Status',
    description: 'Track payment of the admission / tuition fee.',
    guidance: "Pay only through the college's official channel and keep the receipt. Mark Partially Paid or Paid as applicable.",
    labels: { pending: 'Not Paid', in_progress: 'Partially Paid', completed: 'Paid' },
  },
];

const findDef = (key) => ITEMS.find((i) => i.key === key);

function toItem(def, row) {
  const status = row ? row.status : 'pending';
  return {
    key: def.key,
    title: def.title,
    description: def.description,
    guidance: def.guidance,
    required: true,
    status,
    statusLabel: def.labels[status],
    statusOptions: STATUSES.map((s) => ({ value: s, label: def.labels[s] })),
    updatedAt: row ? row.updated_at : null,
  };
}

function getChecklist(studentId) {
  const rows = db.prepare('SELECT item_key, status, updated_at FROM checklist_items WHERE student_id = ?').all(studentId);
  const byKey = new Map(rows.map((r) => [r.item_key, r]));
  return ITEMS.map((def) => toItem(def, byKey.get(def.key)));
}

function updateItem(studentId, key, status) {
  const def = findDef(key);
  if (!def) throw new ApiError(404, 'Unknown checklist item.');
  if (!STATUSES.includes(status)) {
    throw new ApiError(400, 'Invalid status. Use pending, in_progress or completed.', { status: 'Invalid status.' });
  }
  db.prepare(
    `INSERT INTO checklist_items (student_id, item_key, status) VALUES (?, ?, ?)
     ON CONFLICT(student_id, item_key) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
  ).run(studentId, key, status);
  const row = db.prepare('SELECT item_key, status, updated_at FROM checklist_items WHERE student_id = ? AND item_key = ?')
    .get(studentId, key);
  return toItem(def, row);
}

module.exports = { STATUSES, getChecklist, updateItem };
