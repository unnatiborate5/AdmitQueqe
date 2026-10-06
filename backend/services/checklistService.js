'use strict';
const db = require('../config/db');
const documentService = require('./documentService');
const verificationService = require('./verificationService');
const feeService = require('./feeService');

const STATUSES = ['pending', 'in_progress', 'completed'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Admission checklist definition (in display order).
 *  - labels:       wording for the three generic statuses
 *  - statusSource: who decides the status
 *      student   -> the student reports it through the task form
 *      documents -> derived from the document checklist
 *      college   -> set by the college after in-person verification (read-only for students)
 */
const ITEMS = [
  {
    key: 'allotment_acceptance',
    title: 'CAP Allotment Acceptance',
    description: 'Accept your allotted seat on the CAP portal within the schedule of your round.',
    guidance: 'Log in to the official CAP portal, choose your acceptance option, and download the allotment letter. Check the official schedule for the last date.',
    labels: { pending: 'Not Accepted', in_progress: 'Acceptance In Progress', completed: 'Seat Accepted' },
    statusSource: 'student',
  },
  {
    key: 'admission_form',
    title: 'Admission Form',
    description: 'Fill in the college admission form along with the CAP-generated confirmation form.',
    guidance: 'Collect the form from the college website or admission desk, fill it carefully, and keep a signed printout ready.',
    labels: { pending: 'Not Filled', in_progress: 'Partially Filled', completed: 'Form Submitted' },
    statusSource: 'student',
  },
  {
    key: 'document_preparation',
    title: 'Document Preparation',
    description: 'Arrange original documents and photocopies required by your college.',
    guidance: 'Tick each document once it is ready. The status updates automatically when all required documents are prepared. Confirm the exact list on your college notice.',
    labels: { pending: 'Not Started', in_progress: 'Partially Ready', completed: 'All Documents Ready' },
    statusSource: 'documents',
  },
  {
    key: 'physical_verification',
    title: 'Physical Document Verification',
    description: 'Originals are verified in person by the college. Only the college can update this status.',
    guidance: 'Visit the college with originals and photocopies on your allotted date. The college verifies documents manually; AdmitFlow only shows the result.',
    labels: { pending: 'Not Verified', in_progress: 'Verification In Progress', completed: 'Verified at College' },
    statusSource: 'college',
  },
  {
    key: 'fee_payment',
    title: 'Fee / Payment Status',
    description: 'Track payment of the admission / tuition fee.',
    guidance: "Pay only through the college's official channel and keep the receipt.",
    labels: { pending: 'Not Paid', in_progress: 'Partially Paid', completed: 'Paid' },
    statusSource: 'student',
  },
];

const getDefinition = (key) => ITEMS.find((i) => i.key === key);

// ---- formatting helpers for the short summary line shown under each task ----
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// ---- stored status (acceptance, admission form, fee) ----
function setStoredStatus(studentId, key, status) {
  db.prepare(
    `INSERT INTO checklist_items (student_id, item_key, status) VALUES (?, ?, ?)
     ON CONFLICT(student_id, item_key) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
  ).run(studentId, key, status);
}

// ---- date + note records (acceptance, admission form) ----
function getRecord(studentId, key) {
  const r = db.prepare('SELECT event_date, note, updated_at FROM task_records WHERE student_id = ? AND task_key = ?').get(studentId, key);
  return r ? { eventDate: r.event_date, note: r.note, updatedAt: r.updated_at } : { eventDate: null, note: null, updatedAt: null };
}

function saveRecord(studentId, key, { eventDate, note }) {
  db.prepare(
    `INSERT INTO task_records (student_id, task_key, event_date, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(student_id, task_key) DO UPDATE SET event_date = excluded.event_date, note = excluded.note, updated_at = datetime('now')`
  ).run(studentId, key, eventDate, note);
}

function toItem(def, status, summary, updatedAt) {
  return {
    key: def.key,
    title: def.title,
    description: def.description,
    guidance: def.guidance,
    required: true,
    status,
    statusLabel: def.labels[status],
    statusOptions: STATUSES.map((s) => ({ value: s, label: def.labels[s] })),
    statusSource: def.statusSource,
    editable: def.statusSource !== 'college',
    summary: summary || null,
    updatedAt: updatedAt || null,
  };
}

/** All five checklist items with their current status, resolved from the right source. */
function getChecklist(studentId) {
  const stored = new Map(
    db.prepare('SELECT item_key, status, updated_at FROM checklist_items WHERE student_id = ?').all(studentId)
      .map((r) => [r.item_key, r])
  );
  const storedStatus = (key) => (stored.get(key) ? stored.get(key).status : 'pending');
  const storedTime = (key) => (stored.get(key) ? stored.get(key).updated_at : null);

  const docs = documentService.getSummary(studentId);
  const verification = verificationService.get(studentId);
  const fee = feeService.get(studentId);

  return ITEMS.map((def) => {
    switch (def.key) {
      case 'allotment_acceptance': {
        const status = storedStatus(def.key);
        const rec = getRecord(studentId, def.key);
        const summary = status === 'completed' && rec.eventDate ? `Accepted on ${fmtDate(rec.eventDate)}` : null;
        return toItem(def, status, summary, storedTime(def.key));
      }
      case 'admission_form': {
        const status = storedStatus(def.key);
        const rec = getRecord(studentId, def.key);
        const summary = status === 'completed' && rec.eventDate ? `Submitted on ${fmtDate(rec.eventDate)}` : null;
        return toItem(def, status, summary, storedTime(def.key));
      }
      case 'document_preparation':
        return toItem(def, docs.status, `${docs.preparedRequired} of ${docs.requiredTotal} required documents prepared`, docs.updatedAt);
      case 'physical_verification': {
        const summary = verification.status === 'completed'
          ? `Verified${verification.verifiedAt ? ` on ${fmtDate(verification.verifiedAt)}` : ''} by the college`
          : 'Waiting for in-person verification at the college';
        return toItem(def, verification.status, summary, verification.updatedAt);
      }
      case 'fee_payment': {
        let summary = null;
        if (fee.amountPaid) {
          summary = fee.totalFee ? `${rupees(fee.amountPaid)} paid of ${rupees(fee.totalFee)}` : `${rupees(fee.amountPaid)} paid`;
        } else if (fee.totalFee) {
          summary = `Total fee ${rupees(fee.totalFee)}`;
        }
        return toItem(def, storedStatus(def.key), summary, storedTime(def.key));
      }
      default:
        return toItem(def, storedStatus(def.key), null, storedTime(def.key));
    }
  });
}

module.exports = { STATUSES, getDefinition, getChecklist, setStoredStatus, getRecord, saveRecord };
