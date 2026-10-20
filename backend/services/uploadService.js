'use strict';
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const workflow = require('./taskWorkflowService');

const MAX_BYTES = 5 * 1024 * 1024;
const SLOTS = {
  allotment_acceptance: ['receipt'],
  admission_form: ['form'],
  document_preparation: [
    'cap_allotment_letter', 'ssc_marksheet', 'hsc_marksheet', 'leaving_certificate',
    'entrance_scorecard', 'photo_id', 'passport_photos', 'category_certificate', 'domicile_certificate',
  ],
  physical_verification: [],
  fee_payment: ['receipt'],
};

const ALLOWED = {
  'application/pdf': { ext: ['.pdf'], magic: (b) => b.length >= 5 && b.slice(0, 5).toString('ascii') === '%PDF-' },
  'image/jpeg': { ext: ['.jpg', '.jpeg'], magic: (b) => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  'image/png': { ext: ['.png'], magic: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
};

function allowedSlots(taskKey) {
  return SLOTS[taskKey] || [];
}

function assertSlot(taskKey, slot) {
  workflow.requireTaskKey(taskKey);
  if (!allowedSlots(taskKey).includes(slot)) {
    throw new ApiError(400, 'Please correct the highlighted fields.', { slot: 'Unknown upload slot for this task.' });
  }
}

function sniffMime(buffer, declared, filename) {
  const name = String(filename || '').toLowerCase();
  const declaredType = String(declared || '').toLowerCase().split(';')[0].trim();
  for (const [mime, rule] of Object.entries(ALLOWED)) {
    if (!rule.magic(buffer)) continue;
    const extOk = rule.ext.some((e) => name.endsWith(e));
    const typeOk = !declaredType || declaredType === mime || declaredType === 'application/octet-stream';
    if (extOk && typeOk) return mime;
    if (extOk) return mime;
  }
  throw new ApiError(400, 'Please correct the highlighted fields.', {
    file: 'Only PDF, JPEG and PNG files up to 5 MB are allowed.',
  });
}

function sanitizeName(name) {
  const base = String(name || 'upload').replace(/^.*[\\/]/, '').replace(/[^\w.\- ()+]/g, '_').slice(0, 80);
  return base || 'upload';
}

function list(studentId, taskKey) {
  workflow.requireTaskKey(taskKey);
  return db.prepare(
    `SELECT id, student_id, task_key, slot, original_name, mime_type, size_bytes, created_at
       FROM task_uploads WHERE student_id = ? AND task_key = ? ORDER BY id`
  ).all(studentId, taskKey).map(toMeta);
}

function toMeta(r) {
  return {
    id: r.id,
    studentId: r.student_id,
    taskKey: r.task_key,
    slot: r.slot,
    originalName: r.original_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
  };
}

function hasSlot(studentId, taskKey, slot) {
  return Boolean(db.prepare(
    'SELECT 1 FROM task_uploads WHERE student_id = ? AND task_key = ? AND slot = ?'
  ).get(studentId, taskKey, slot));
}

function save(studentId, taskKey, { slot, filename, mime, buffer }) {
  workflow.requireTaskKey(taskKey);
  const current = workflow.get(studentId, taskKey);
  if (current.status === 'approved') {
    throw new ApiError(403, 'This task is approved and can no longer be changed by you.', null, 'TASK_LOCKED');
  }
  assertSlot(taskKey, slot);
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(400, 'Please correct the highlighted fields.', { file: 'Choose a file to upload.' });
  }
  if (buffer.length > MAX_BYTES) {
    throw new ApiError(413, 'File is too large (maximum 5 MB).', { file: 'File is too large (maximum 5 MB).' }, 'FILE_TOO_LARGE');
  }
  const detected = sniffMime(buffer, mime, filename);
  const originalName = sanitizeName(filename);
  db.prepare(
    `INSERT INTO task_uploads (student_id, task_key, slot, original_name, mime_type, size_bytes, content)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id, task_key, slot) DO UPDATE SET
       original_name = excluded.original_name,
       mime_type = excluded.mime_type,
       size_bytes = excluded.size_bytes,
       content = excluded.content,
       created_at = datetime('now')`
  ).run(studentId, taskKey, slot, originalName, detected, buffer.length, buffer);
  return list(studentId, taskKey).find((f) => f.slot === slot);
}

function getOwned(fileId, studentId) {
  const id = Number(fileId);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(404, 'File not found.');
  const row = db.prepare('SELECT * FROM task_uploads WHERE id = ?').get(id);
  if (!row || row.student_id !== studentId) {
    throw new ApiError(404, 'File not found.', null, 'FILE_NOT_FOUND');
  }
  return row;
}

/** Officers may read a student's file; mismatched student ids look like 404. */
function getForAdmin(fileId, studentId) {
  const id = Number(fileId);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(404, 'File not found.');
  const row = db.prepare('SELECT * FROM task_uploads WHERE id = ? AND student_id = ?').get(id, studentId);
  if (!row) throw new ApiError(404, 'File not found.', null, 'FILE_NOT_FOUND');
  return row;
}

function sendFile(res, row) {
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeName(row.original_name)}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(row.content);
}

module.exports = {
  MAX_BYTES, SLOTS, allowedSlots, list, hasSlot, save, getOwned, getForAdmin, sendFile,
};
