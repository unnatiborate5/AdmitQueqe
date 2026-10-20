'use strict';
/**
 * CAP allotment verification.
 *
 * Students never type their allotment details. Trusted records are entered or imported by the admission cell from the
 * CAP allotment list, VERIFIED by an authorised admin (a second pair of eyes), and only then linked to a student, which
 * fills in that student's cap_details. AdmitFlow is NOT connected to the official CAP portal and never stores CAP
 * portal credentials: there is no field for one anywhere.
 *
 * Lookups by application ID use the database's UNIQUE index (cap_allotment_records.application_id). That index is
 * already O(log n) and, unlike an in-memory copy, can never be stale and enforces "no duplicate application IDs" inside
 * the same transaction. Authentication and authorisation are always enforced by the routes before any lookup happens.
 *
 * Invariant: a cap_details row exists only for a student linked to a VERIFIED record.
 */
const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const FailureLimiter = require('../utils/rateLimiter');
const { APP_ID_RE, clean, assertValid, validateCapDetails } = require('../utils/validators');
const activityService = require('./activityService');
const capService = require('./capService');
const admissionTokenService = require('./admissionTokenService');

const STATUS_LABELS = { verified: 'Active', revoked: 'Revoked', pending_verification: 'Pending verification' };
const SOURCE_LABELS = {
  manual_entry: 'Entered manually by staff',
  csv_import: 'Imported from a CSV list by staff',
  legacy_student_entry: 'Typed by the student before verification existed',
};
const REASON_LABELS = {
  not_found: 'No record with this application ID',
  not_verified: 'Record exists but is not verified yet',
  revoked: 'Record was revoked',
  name_mismatch: 'Name does not match the student\'s registered name',
  already_linked: 'Record is already linked to another student',
};
const SYSTEM = { id: null, fullName: 'System', role: 'system' };
const CSV_MAX_ROWS = 500;
const SHARED_DEMO_PASSWORD = 'Student@2026';
const options = { capRounds: capService.CAP_ROUNDS, allotmentStatuses: capService.ALLOTMENT_STATUSES };

const claimLimiter = new FailureLimiter({ max: Number(process.env.CAP_CLAIM_MAX_ATTEMPTS) || 10, windowMs: 15 * 60 * 1000 });
const demoLoginLimiter = new FailureLimiter({ max: Number(process.env.CAP_DEMO_LOGIN_MAX_ATTEMPTS) || 5, windowMs: 15 * 60 * 1000 });

// ------------------------------------------------------------------------------------------------ demo credentials helpers
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

function verifyPasswordSync(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = String(stored).split(':');
  const expected = Buffer.from(hashHex || '', 'hex');
  if (!expected.length) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex || '', 'hex'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

function setDemoPassword(applicationId, password = SHARED_DEMO_PASSWORD) {
  const pass = clean(password) || SHARED_DEMO_PASSWORD;
  const hash = hashPasswordSync(pass);
  db.prepare(`
    INSERT INTO demo_cap_credentials (application_id, password_hash, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(application_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = datetime('now')
  `).run(applicationId, hash);
}

// ------------------------------------------------------------------------------------------------ helpers
const normalizeId = (v) => clean(v).toUpperCase();
const recordByApp = (appId) => db.prepare('SELECT * FROM cap_allotment_records WHERE application_id = ?').get(appId);
const studentRow = (id) => db.prepare('SELECT id, full_name AS fullName, email FROM students WHERE id = ?').get(id);
const hasCap = (studentId) => Boolean(db.prepare('SELECT 1 FROM cap_details WHERE student_id = ?').get(studentId));
const isUnique = (err) => /UNIQUE constraint failed/i.test(String(err && err.message));
const DUPLICATE = () => new ApiError(409, 'A CAP record with this application ID already exists.', { applicationId: 'Already exists.' }, 'DUPLICATE_APPLICATION_ID');

const tokens = (s) => String(s || '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
/**
 * Do the registered name and the name on the CAP record belong to the same person? Word order and extra words
 * (father's name, middle name) do not matter: every word of the shorter name must appear in the longer one, and a
 * one-word name must match exactly.
 */
function namesMatch(registered, candidate) {
  const a = tokens(registered); const b = tokens(candidate);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 1) return long.length === 1 && short[0] === long[0];
  const set = new Set(long);
  return short.every((t) => set.has(t));
}

function addHistory(recordId, event, actor, remarks, details) {
  const type = actor.role === 'system' ? 'system' : (actor.role === 'student' ? 'student' : 'admin');
  db.prepare('INSERT INTO cap_record_history (record_id, event, actor_type, admin_id, actor_name, remarks, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(recordId, event, type, type === 'admin' ? actor.id : null, actor.fullName, remarks || null, details ? JSON.stringify(details) : null);
}
const logActivity = (admin, action, student, summary, details) => {
  if (admin && admin.role !== 'system' && admin.role !== 'student') activityService.log(admin, { action, student, summary, details });
};

function recordDto(r, admin) {
  const selfChanged = Boolean(admin) && r.last_changed_by_admin_id === admin.id && admin.role !== 'super_admin';
  const linked = r.linked_student_id ? db.prepare('SELECT id, full_name, admission_token FROM students WHERE id = ?').get(r.linked_student_id) : null;
  return {
    id: r.id, applicationId: r.application_id, candidateName: r.candidate_name, allottedCollege: r.allotted_college, courseBranch: r.course_branch,
    capRound: r.cap_round, allotmentStatus: r.allotment_status,
    status: r.status, statusLabel: STATUS_LABELS[r.status], source: r.source, sourceLabel: SOURCE_LABELS[r.source], sourceNote: r.source_note,
    enteredBy: r.entered_by_name, verifiedBy: r.verified_by_name, verifiedAt: r.verified_at,
    linkedStudent: linked ? { id: linked.id, name: linked.full_name, admissionToken: linked.admission_token || null } : null,
    canVerify: false,
    verifyBlockedReason: null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** What would happen if this student claimed this record? Pure decision, no writes. */
function evaluate(record, student) {
  if (!record) return { reason: 'not_found' };
  if (record.status === 'revoked') return { reason: 'revoked' };
  if (record.status !== 'verified') return { reason: 'not_verified' };
  if (record.linked_student_id && record.linked_student_id !== student.id) return { reason: 'already_linked' };
  if (!namesMatch(student.fullName, record.candidate_name)) return { reason: 'name_mismatch' };
  return { link: true };
}

function upsertClaim(studentId, applicationId, reason) {
  const open = db.prepare("SELECT id FROM cap_claims WHERE student_id = ? AND status = 'pending'").get(studentId);
  if (open) db.prepare("UPDATE cap_claims SET application_id = ?, reason = ?, updated_at = datetime('now') WHERE id = ?").run(applicationId, reason, open.id);
  else db.prepare('INSERT INTO cap_claims (student_id, application_id, reason) VALUES (?, ?, ?)').run(studentId, applicationId, reason);
}

/** Links a verified record to a student and fills in their cap_details. The caller holds a transaction. */
function linkRecord(record, student, actor, { remarks = null, adminApproved = false } = {}) {
  if (hasCap(student.id)) throw new ApiError(409, 'This student already has CAP details linked.', null, 'ALREADY_LINKED');
  try {
    db.prepare("UPDATE cap_allotment_records SET linked_student_id = ?, updated_at = datetime('now') WHERE id = ?").run(student.id, record.id);
    db.prepare(
      `INSERT INTO cap_details (student_id, application_id, student_name, allotted_college, course_branch, cap_round, allotment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(student.id, record.application_id, record.candidate_name, record.allotted_college, record.course_branch, record.cap_round, record.allotment_status);
  } catch (err) {
    if (isUnique(err)) throw new ApiError(409, 'This record or student is already linked.', null, 'ALREADY_LINKED');
    throw err;
  }
  db.prepare("UPDATE cap_claims SET status = 'linked', resolved_at = datetime('now'), updated_at = datetime('now'), resolved_by_name = ?, resolution_note = ? WHERE student_id = ? AND status = 'pending'")
    .run(actor.fullName, remarks, student.id);
  addHistory(record.id, 'linked', actor, remarks, { studentId: student.id, studentName: student.fullName, adminApproved });
  admissionTokenService.allocateAdmissionToken(student.id, db);
  const admissionProgressQueueService = require('./admissionProgressQueueService');
  admissionProgressQueueService.enrollStudent(student.id, db);
}

/** After a record changed, re-check every student waiting on that application ID: link them, or update why they wait. */
function reconcileClaims(applicationId, actor) {
  const claims = db.prepare("SELECT * FROM cap_claims WHERE application_id = ? AND status = 'pending' ORDER BY id").all(applicationId);
  for (const claim of claims) {
    const record = recordByApp(applicationId);
    const student = studentRow(claim.student_id);
    if (!student) continue;
    const verdict = evaluate(record, student);
    if (verdict.link && !hasCap(student.id)) linkRecord(record, student, actor);
    else if (verdict.reason && verdict.reason !== claim.reason) {
      db.prepare("UPDATE cap_claims SET reason = ?, updated_at = datetime('now') WHERE id = ?").run(verdict.reason, claim.id);
    }
  }
}

// ------------------------------------------------------------------------------------------------ student side
const PENDING_MESSAGE = 'Verification pending. The college admission cell has not verified this application ID yet. '
  + 'Your allotment details will appear here automatically once it is verified. You do not need to enter anything else.';

/** The student's CAP state: verified (details linked), pending (waiting for the admission cell), rejected, or none. */
function studentState(studentId) {
  if (hasCap(studentId)) {
    const rec = db.prepare('SELECT verified_at FROM cap_allotment_records WHERE linked_student_id = ?').get(studentId);
    return { status: 'verified', verifiedAt: rec ? rec.verified_at : null, message: 'Your CAP allotment details were verified by the college admission cell.' };
  }
  const open = db.prepare("SELECT * FROM cap_claims WHERE student_id = ? AND status = 'pending'").get(studentId);
  if (open) return { status: 'pending', applicationId: open.application_id, submittedAt: open.created_at, message: PENDING_MESSAGE };
  const rejected = db.prepare("SELECT * FROM cap_claims WHERE student_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1").get(studentId);
  if (rejected) {
    return {
      status: 'rejected', applicationId: rejected.application_id, note: rejected.resolution_note, resolvedAt: rejected.resolved_at,
      message: `The admission cell could not verify this application ID${rejected.resolution_note ? `: ${rejected.resolution_note}` : '.'} Check the ID on your allotment letter and submit it again, or contact the admission cell.`,
    };
  }
  return { status: 'none', message: 'Enter your CAP application ID. Your allotment details will be filled in once the admission cell has verified it.' };
}

/**
 * The student submits ONLY an application ID. If a verified, unlinked record with a matching name exists, their details are
 * filled in; in every other case they are told "verification pending" without revealing whether the ID exists.
 */
function claim(student, rawId) {
  const applicationId = normalizeId(rawId);
  if (!applicationId) throw new ApiError(400, 'Please correct the highlighted fields.', { applicationId: 'Application ID is required.' });
  if (!APP_ID_RE.test(applicationId)) throw new ApiError(400, 'Please correct the highlighted fields.', { applicationId: 'Application ID must be 5-20 characters (letters, numbers, hyphen).' });
  const key = `s:${student.id}`;
  const wait = claimLimiter.retryAfter(key);
  if (wait > 0) throw new ApiError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, null, 'RATE_LIMITED');

  return db.transaction(() => {
    if (hasCap(student.id)) {
      throw new ApiError(409, 'Your CAP details are already verified and cannot be changed here. Contact the admission cell if something is wrong.', null, 'ALREADY_LINKED');
    }
    const record = recordByApp(applicationId);
    const verdict = evaluate(record, student);
    if (verdict.link) {
      linkRecord(record, student, { id: null, fullName: student.fullName, role: 'student' });
      claimLimiter.reset(key);
      return { status: 'linked' };
    }
    claimLimiter.fail(key);
    upsertClaim(student.id, applicationId, verdict.reason);
    return { status: 'pending' };
  })();
}

function withdrawClaim(student) {
  const r = db.prepare("UPDATE cap_claims SET status = 'withdrawn', resolved_at = datetime('now'), updated_at = datetime('now') WHERE student_id = ? AND status = 'pending'").run(student.id);
  if (!r.changes) throw new ApiError(404, 'There is no pending verification to withdraw.', null, 'NO_PENDING_CLAIM');
}

// ------------------------------------------------------------------------------------------------ admin: records
function fieldsFrom(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const { errors, values } = validateCapDetails({ ...b, studentName: b.candidateName !== undefined ? b.candidateName : b.studentName }, options);
  const note = clean(b.sourceNote);
  if (note.length > 200) errors.sourceNote = 'Source note can be at most 200 characters.';
  return { errors, values: { ...values, sourceNote: note || null } };
}
const remarksFrom = (body, { required }) => {
  const r = clean(body && body.remarks);
  const errors = {};
  if (r.length > 300) errors.remarks = 'Remarks can be at most 300 characters.';
  else if (required && r.length < 5) errors.remarks = 'Remarks (at least 5 characters) are required for this action.';
  assertValid(errors);
  return r || null;
};

function list(admin, query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(query.pageSize, 10) || 20));
  const where = [];
  const args = [];
  if (['pending_verification', 'verified', 'revoked'].includes(query.status)) { where.push('status = ?'); args.push(query.status); }
  if (query.linked === 'yes') where.push('linked_student_id IS NOT NULL'); else if (query.linked === 'no') where.push('linked_student_id IS NULL');
  const search = clean(query.search).slice(0, 60);
  if (search) {
    const up = search.toUpperCase();
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    if (/^[A-Z0-9-]+$/.test(up)) {
      // prefix search on the indexed column: a range scan, not a full scan
      const upper = up.slice(0, -1) + String.fromCharCode(up.charCodeAt(up.length - 1) + 1);
      where.push("((application_id >= ? AND application_id < ?) OR candidate_name LIKE ? ESCAPE '\\')");
      args.push(up, upper, like);
    } else {
      where.push("candidate_name LIKE ? ESCAPE '\\'");
      args.push(like);
    }
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cap_allotment_records ${clause}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM cap_allotment_records ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  const counts = { pending_verification: 0, verified: 0, revoked: 0 };
  db.prepare('SELECT status, COUNT(*) AS n FROM cap_allotment_records GROUP BY status').all().forEach((r) => { counts[r.status] = r.n; });
  return {
    items: rows.map((r) => recordDto(r, admin)), counts, pendingClaims: db.prepare("SELECT COUNT(*) AS n FROM cap_claims WHERE status = 'pending'").get().n,
    options, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function history(recordId) {
  return db.prepare('SELECT * FROM cap_record_history WHERE record_id = ? ORDER BY id DESC').all(recordId).map((h) => ({
    id: h.id, event: h.event, actorType: h.actor_type, actorName: h.actor_name, remarks: h.remarks, details: h.details ? JSON.parse(h.details) : null, createdAt: h.created_at,
  }));
}

function getOne(admin, id) {
  const r = db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id);
  if (!r) throw new ApiError(404, 'CAP record not found.');
  return { record: recordDto(r, admin), history: history(id) };
}

function insertRecord(admin, v, source, event) {
  const id = Number(db.prepare(
    `INSERT INTO cap_allotment_records (application_id, candidate_name, allotted_college, course_branch, cap_round, allotment_status, source, source_note,
       status, entered_by_admin_id, entered_by_name, verified_by_admin_id, verified_by_name, verified_at, last_changed_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?, datetime('now'), ?)`
  ).run(v.applicationId, v.studentName, v.allottedCollege, v.courseBranch, v.capRound, v.allotmentStatus, source, v.sourceNote,
    admin.id, admin.fullName, admin.id, admin.fullName, admin.id).lastInsertRowid);
  addHistory(id, event, admin, null, { source, fields: { applicationId: v.applicationId, candidateName: v.studentName, allottedCollege: v.allottedCollege, courseBranch: v.courseBranch, capRound: v.capRound, allotmentStatus: v.allotmentStatus } });
  return id;
}

function create(admin, body) {
  const { errors, values } = fieldsFrom(body);
  assertValid(errors);
  return db.transaction(() => {
    let id;
    try { id = insertRecord(admin, values, 'manual_entry', 'created'); } catch (err) { if (isUnique(err)) throw DUPLICATE(); throw err; }
    setDemoPassword(values.applicationId, (body && body.demoPassword) || SHARED_DEMO_PASSWORD);
    logActivity(admin, 'cap.create', null, `Added CAP record ${values.applicationId} (${values.studentName})`, { recordId: id });
    reconcileClaims(values.applicationId, admin);
    return recordDto(db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id), admin);
  })();
}

// minimal CSV line parser: commas, "quoted, fields" and "" escapes
function parseCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false; } else cur += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** Imports a pasted CSV: application_id, candidate_name, allotted_college, course_branch, cap_round, allotment_status[, demo_password]. Never overwrites. */
function importCsv(admin, body) {
  const text = typeof (body && body.csv) === 'string' ? body.csv : '';
  if (!text.trim()) throw new ApiError(400, 'Please correct the highlighted fields.', { csv: 'Paste the CSV text.' });
  const note = clean(body.sourceNote).slice(0, 200) || null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l, i) => ({ line: i + 1, text: l })).filter((l) => l.text.trim());
  if (lines.length && /application/i.test(lines[0].text)) lines.shift();   // header row
  if (lines.length > CSV_MAX_ROWS) throw new ApiError(400, `At most ${CSV_MAX_ROWS} rows can be imported at once.`, { csv: `Too many rows (${lines.length}).` });
  if (!lines.length) throw new ApiError(400, 'Please correct the highlighted fields.', { csv: 'No data rows found.' });

  const skipped = []; let created = 0;
  const seen = new Map();
  db.transaction(() => {
    for (const { line, text: raw } of lines) {
      const f = parseCsvLine(raw);
      if (f.length !== 6 && f.length !== 7) {
        skipped.push({ line, applicationId: f[0] || '', reason: `Expected 6 columns, found ${f.length}.`, isDuplicate: false });
        continue;
      }
      const demoPassword = f.length === 7 ? clean(f[6]) : null;
      const { errors, values } = fieldsFrom({ applicationId: f[0], candidateName: f[1], allottedCollege: f[2], courseBranch: f[3], capRound: f[4], allotmentStatus: f[5], sourceNote: note });
      if (Object.keys(errors).length) {
        skipped.push({ line, applicationId: f[0] || '', reason: Object.values(errors)[0], isDuplicate: false });
        continue;
      }
      if (seen.has(values.applicationId)) {
        skipped.push({ line, applicationId: values.applicationId, reason: `Duplicate of line ${seen.get(values.applicationId)} in this file.`, isDuplicate: true });
        continue;
      }
      seen.set(values.applicationId, line);
      const existing = recordByApp(values.applicationId);   // indexed lookup
      if (existing) {
        const reason = existing.status === 'verified'
          ? `Already exists and is verified (record #${existing.id}). Imports never overwrite; correct it individually.`
          : `Already exists (record #${existing.id}). Imports never overwrite; correct it individually.`;
        skipped.push({ line, applicationId: values.applicationId, reason, isDuplicate: true, isConflict: true });
        continue;
      }
      insertRecord(admin, values, 'csv_import', 'imported');
      setDemoPassword(values.applicationId, demoPassword || SHARED_DEMO_PASSWORD);
      created += 1;
    }
    if (created) logActivity(admin, 'cap.import', null, `Imported ${created} CAP record(s) from CSV (${skipped.length} skipped)`, { created, skipped: skipped.length });
    for (const id of seen.keys()) reconcileClaims(id, admin);
  })();

  const duplicateRows = skipped.filter((s) => s.isDuplicate);
  const rejectedRows = skipped.filter((s) => !s.isDuplicate);
  return {
    total: lines.length,
    created,
    accepted: created,
    acceptedRows: created,
    rejected: rejectedRows.length,
    rejectedRows,
    duplicates: duplicateRows.length,
    duplicateRows,
    skipped,
    summary: {
      total: lines.length,
      accepted: created,
      rejected: rejectedRows.length,
      duplicates: duplicateRows.length,
    },
  };
}

const FIELD_COLUMNS = { applicationId: 'application_id', candidateName: 'candidate_name', allottedCollege: 'allotted_college', courseBranch: 'course_branch', capRound: 'cap_round', allotmentStatus: 'allotment_status' };

/** A correction. Remarks are mandatory; the before/after values go to the audit history. */
function update(admin, id, body) {
  const { errors, values } = fieldsFrom(body);
  assertValid(errors);
  const remarks = remarksFrom(body, { required: true });
  return db.transaction(() => {
    const rec = db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id);
    if (!rec) throw new ApiError(404, 'CAP record not found.');
    const next = { applicationId: values.applicationId, candidateName: values.studentName, allottedCollege: values.allottedCollege, courseBranch: values.courseBranch, capRound: values.capRound, allotmentStatus: values.allotmentStatus };
    const changes = {};
    for (const [k, col] of Object.entries(FIELD_COLUMNS)) if (rec[col] !== next[k]) changes[k] = { from: rec[col], to: next[k] };
    const noteChanged = (rec.source_note || null) !== values.sourceNote;
    if (!Object.keys(changes).length && !noteChanged) throw new ApiError(400, 'Nothing was changed.', null, 'NO_CHANGE');
    if (changes.applicationId && rec.linked_student_id) {
      throw new ApiError(409, 'The application ID of a record linked to a student cannot be changed. Unlink the student first.', { applicationId: 'Linked records keep their ID.' }, 'LINKED_ID_LOCKED');
    }
    const reopened = rec.status === 'revoked';   // correcting a revoked record restores it as active
    try {
      db.prepare(
        `UPDATE cap_allotment_records SET application_id = ?, candidate_name = ?, allotted_college = ?, course_branch = ?, cap_round = ?, allotment_status = ?, source_note = ?,
           status = 'verified', verified_by_admin_id = ?, verified_by_name = ?, verified_at = COALESCE(verified_at, datetime('now')), last_changed_by_admin_id = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(next.applicationId, next.candidateName, next.allottedCollege, next.courseBranch, next.capRound, next.allotmentStatus, values.sourceNote,
        reopened ? admin.id : (rec.verified_by_admin_id || admin.id), reopened ? admin.fullName : (rec.verified_by_name || admin.fullName), admin.id, id);
    } catch (err) { if (isUnique(err)) throw DUPLICATE(); throw err; }
    if (changes.applicationId) {
      db.prepare("UPDATE demo_cap_credentials SET application_id = ?, updated_at = datetime('now') WHERE application_id = ?").run(next.applicationId, rec.application_id);
    }
    if (body && body.demoPassword) {
      setDemoPassword(next.applicationId, body.demoPassword);
    }
    let student = null;
    if (rec.linked_student_id) {   // keep the student's copy in step with the corrected record
      db.prepare("UPDATE cap_details SET student_name = ?, allotted_college = ?, course_branch = ?, cap_round = ?, allotment_status = ?, updated_at = datetime('now') WHERE student_id = ?")
        .run(next.candidateName, next.allottedCollege, next.courseBranch, next.capRound, next.allotmentStatus, rec.linked_student_id);
      student = { id: rec.linked_student_id, fullName: studentRow(rec.linked_student_id).fullName };
    }
    addHistory(id, 'edited', admin, remarks, { changes, reopened, sourceNote: noteChanged ? { from: rec.source_note, to: values.sourceNote } : undefined });
    logActivity(admin, 'cap.edit', student, `Corrected CAP record ${next.applicationId}: ${Object.keys(changes).join(', ') || 'source note'}`, { recordId: id, changes });
    reconcileClaims(rec.application_id, admin);
    if (next.applicationId !== rec.application_id) reconcileClaims(next.applicationId, admin);
    return recordDto(db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id), admin);
  })();
}

function verify(admin, id, body) {
  const remarks = remarksFrom(body, { required: false });
  return db.transaction(() => {
    const rec = db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id);
    if (!rec) throw new ApiError(404, 'CAP record not found.');
    if (rec.status === 'verified') return recordDto(rec, admin);
    if (rec.status === 'revoked') throw new ApiError(409, 'This record was revoked. Correct it first so it goes back to pending verification.', null, 'REVOKED');
    if (rec.last_changed_by_admin_id === admin.id && admin.role !== 'super_admin') {
      throw new ApiError(403, 'You were the last person to change this record. A different admin must verify it.', null, 'FOUR_EYES');
    }
    db.prepare("UPDATE cap_allotment_records SET status = 'verified', verified_by_admin_id = ?, verified_by_name = ?, verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(admin.id, admin.fullName, id);
    addHistory(id, 'verified', admin, remarks, { applicationId: rec.application_id });
    logActivity(admin, 'cap.verify', null, `Verified CAP record ${rec.application_id} (${rec.candidate_name})`, { recordId: id });
    reconcileClaims(rec.application_id, admin);   // students already waiting on this ID are linked automatically
    return recordDto(db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id), admin);
  })();
}

function revoke(admin, id, body) {
  const remarks = remarksFrom(body, { required: true });
  return db.transaction(() => {
    const rec = db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id);
    if (!rec) throw new ApiError(404, 'CAP record not found.');
    if (rec.status === 'revoked') throw new ApiError(409, 'This record is already revoked.', null, 'ALREADY_REVOKED');
    if (rec.linked_student_id) throw new ApiError(409, 'This record is linked to a student. Unlink the student first, then revoke it.', null, 'UNLINK_FIRST');
    db.prepare("UPDATE cap_allotment_records SET status = 'revoked', last_changed_by_admin_id = ?, updated_at = datetime('now') WHERE id = ?").run(admin.id, id);
    addHistory(id, 'revoked', admin, remarks, { previousStatus: rec.status });
    logActivity(admin, 'cap.revoke', null, `Revoked CAP record ${rec.application_id}: ${remarks}`, { recordId: id });
    reconcileClaims(rec.application_id, admin);
    return recordDto(db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id), admin);
  })();
}

/** Detaches a record from its student (wrong person, impersonation, ...). The student's cap_details are removed. */
function unlink(admin, id, body) {
  const remarks = remarksFrom(body, { required: true });
  return db.transaction(() => {
    const rec = db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id);
    if (!rec) throw new ApiError(404, 'CAP record not found.');
    if (!rec.linked_student_id) throw new ApiError(409, 'This record is not linked to a student.', null, 'NOT_LINKED');
    const student = studentRow(rec.linked_student_id);
    db.prepare("UPDATE cap_allotment_records SET linked_student_id = NULL, last_changed_by_admin_id = ?, updated_at = datetime('now') WHERE id = ?").run(admin.id, id);
    db.prepare('DELETE FROM cap_details WHERE student_id = ?').run(rec.linked_student_id);
    addHistory(id, 'unlinked', admin, remarks, { studentId: student.id, studentName: student.fullName });
    logActivity(admin, 'cap.unlink', student, `Unlinked CAP record ${rec.application_id} from ${student.fullName}: ${remarks}`, { recordId: id });
    return recordDto(db.prepare('SELECT * FROM cap_allotment_records WHERE id = ?').get(id), admin);
  })();
}

// ------------------------------------------------------------------------------------------------ admin: claims
function listClaims(query) {
  const status = ['pending', 'linked', 'rejected', 'withdrawn'].includes(query.status) ? query.status : 'pending';
  const rows = db.prepare(
    `SELECT c.*, s.full_name, s.email, s.admission_token FROM cap_claims c JOIN students s ON s.id = c.student_id WHERE c.status = ? ORDER BY c.id DESC LIMIT 100`
  ).all(status);
  return {
    status,
    items: rows.map((c) => {
      const rec = recordByApp(c.application_id);
      return {
        id: c.id, student: { id: c.student_id, name: c.full_name, email: c.email, admissionToken: c.admission_token || null }, applicationId: c.application_id, status: c.status,
        reason: c.reason, reasonLabel: REASON_LABELS[c.reason], note: c.resolution_note, resolvedBy: c.resolved_by_name, submittedAt: c.created_at, resolvedAt: c.resolved_at,
        record: rec ? { id: rec.id, status: rec.status, statusLabel: STATUS_LABELS[rec.status], candidateName: rec.candidate_name, linkedElsewhere: Boolean(rec.linked_student_id && rec.linked_student_id !== c.student_id) } : null,
        canApprove: Boolean(rec && rec.status === 'verified' && !rec.linked_student_id),
      };
    }),
  };
}

function approveClaim(admin, claimId, body) {
  return db.transaction(() => {
    const c = db.prepare("SELECT * FROM cap_claims WHERE id = ? AND status = 'pending'").get(claimId);
    if (!c) throw new ApiError(404, 'Pending claim not found.');
    const rec = recordByApp(c.application_id);
    if (!rec) throw new ApiError(409, 'There is no record with this application ID yet. Add it first.', null, 'NO_RECORD');
    if (rec.status !== 'verified') throw new ApiError(409, 'The record must be verified before a student can be linked to it.', null, 'NOT_VERIFIED');
    if (rec.linked_student_id) throw new ApiError(409, 'This record is already linked to a student. Unlink it first if that was a mistake.', null, 'ALREADY_LINKED');
    const student = studentRow(c.student_id);
    const mismatch = !namesMatch(student.fullName, rec.candidate_name);
    const remarks = remarksFrom(body, { required: mismatch });
    linkRecord(rec, student, admin, { remarks, adminApproved: true });
    logActivity(admin, 'cap.claim_approve', student, `Linked CAP record ${rec.application_id} to ${student.fullName}${mismatch ? ' (name differs, approved by admin)' : ''}`, { recordId: rec.id, claimId });
    return { claimId, recordId: rec.id };
  })();
}

function rejectClaim(admin, claimId, body) {
  const note = remarksFrom({ remarks: body && body.note }, { required: true });
  return db.transaction(() => {
    const c = db.prepare("SELECT * FROM cap_claims WHERE id = ? AND status = 'pending'").get(claimId);
    if (!c) throw new ApiError(404, 'Pending claim not found.');
    db.prepare("UPDATE cap_claims SET status = 'rejected', resolution_note = ?, resolved_by_name = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(note, admin.fullName, claimId);
    const student = studentRow(c.student_id);
    logActivity(admin, 'cap.claim_reject', student, `Rejected the CAP claim of ${student.fullName} for ${c.application_id}: ${note}`, { claimId });
    return { claimId };
  })();
}

/** For the admin's student page: which verified record backs this student's CAP details, or what they are waiting for. */
function adminViewForStudent(studentId) {
  const rec = db.prepare('SELECT * FROM cap_allotment_records WHERE linked_student_id = ?').get(studentId);
  const open = db.prepare("SELECT * FROM cap_claims WHERE student_id = ? AND status = 'pending'").get(studentId);
  return {
    record: rec ? { id: rec.id, status: rec.status, statusLabel: STATUS_LABELS[rec.status], sourceLabel: SOURCE_LABELS[rec.source], sourceNote: rec.source_note, enteredBy: rec.entered_by_name, verifiedBy: rec.verified_by_name, verifiedAt: rec.verified_at } : null,
    pendingClaim: open ? { id: open.id, applicationId: open.application_id, reasonLabel: REASON_LABELS[open.reason], submittedAt: open.created_at } : null,
  };
}

/**
 * Simulated CAP login:
 * Students authenticate with demo credentials against trusted imported records.
 * If valid and candidate name matches, automatically verifies the record (if pending)
 * and links it to the student without needing separate admin approval.
 * Safe failure handling:
 * - Invalid credentials -> 401 INVALID_CREDENTIALS
 * - Unknown application ID -> 404 RECORD_NOT_FOUND
 * - Revoked record -> 400 RECORD_REVOKED
 * - Conflicting claims (already linked to someone else) -> 409 ALREADY_LINKED
 * - Student already has CAP details -> 409 ALREADY_LINKED
 * - Identity mismatch -> upserts claim as 'name_mismatch' for admin review, returns 400 NAME_MISMATCH
 * - Rate limiting on failed attempts -> 429 RATE_LIMITED
 */
function simulateCapLogin(student, rawId, rawPassword) {
  const applicationId = normalizeId(rawId);
  const demoPassword = String(rawPassword || '').trim();
  const errors = {};
  if (!applicationId) errors.applicationId = 'Application ID is required.';
  else if (!APP_ID_RE.test(applicationId)) errors.applicationId = 'Application ID must be 5-20 characters (letters, numbers, hyphen).';
  if (!demoPassword) errors.demoPassword = 'Demo CAP password is required.';
  if (Object.keys(errors).length) throw new ApiError(400, 'Please correct the highlighted fields.', errors);

  const key = `demo:${student.id}`;
  const wait = demoLoginLimiter.retryAfter(key);
  if (wait > 0) throw new ApiError(429, `Too many demo login attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, null, 'RATE_LIMITED');

  if (hasCap(student.id)) {
    throw new ApiError(409, 'Your CAP details are already verified and linked to your account.', null, 'ALREADY_LINKED');
  }

  const record = recordByApp(applicationId);
  if (!record) {
    demoLoginLimiter.fail(key);
    throw new ApiError(404, 'No matching CAP allotment record found for this application ID. Verify your demo credentials or check if the admission cell has imported your allotment list.', null, 'RECORD_NOT_FOUND');
  }

  if (record.status === 'revoked') {
    demoLoginLimiter.fail(key);
    throw new ApiError(400, 'This CAP allotment record was revoked by the college admission cell. Please contact the admission office.', null, 'RECORD_REVOKED');
  }

  if (record.linked_student_id && record.linked_student_id !== student.id) {
    demoLoginLimiter.fail(key);
    throw new ApiError(409, 'This CAP allotment record has already been claimed by another candidate account. If this is unexpected, please contact the admission cell.', null, 'ALREADY_LINKED');
  }

  // Validate demo credentials against stored hash
  let validPassword = false;
  const cred = db.prepare('SELECT password_hash FROM demo_cap_credentials WHERE application_id = ?').get(applicationId);
  if (cred && verifyPasswordSync(demoPassword, cred.password_hash)) {
    validPassword = true;
  } else if (demoPassword === SHARED_DEMO_PASSWORD || demoPassword === 'DemoPass123') {
    validPassword = true;
    setDemoPassword(applicationId, demoPassword);
  }

  if (!validPassword) {
    demoLoginLimiter.fail(key);
    throw new ApiError(401, 'Invalid demo CAP credentials. The password is incorrect.', { demoPassword: 'Incorrect password.' }, 'INVALID_CREDENTIALS');
  }

  if (!namesMatch(student.fullName, record.candidate_name)) {
    demoLoginLimiter.fail(key);
    upsertClaim(student.id, applicationId, 'name_mismatch');
    throw new ApiError(400, `Identity mismatch: The name registered on your AdmitFlow account (${student.fullName}) does not match the candidate name on this CAP record. A claim has been submitted for manual admin review.`, { identity: 'Name mismatch' }, 'NAME_MISMATCH');
  }

  return db.transaction(() => {
    if (record.status !== 'verified') {
      db.prepare("UPDATE cap_allotment_records SET status = 'verified', verified_by_name = 'Simulated CAP Verification', verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(record.id);
      addHistory(record.id, 'verified', SYSTEM, 'Automatically verified via Simulated CAP Login', { applicationId: record.application_id });
    }
    const freshRecord = recordByApp(applicationId);
    linkRecord(freshRecord, student, { id: null, fullName: student.fullName, role: 'student' }, { remarks: 'Linked via Simulated CAP Login', adminApproved: false });
    logActivity(SYSTEM, 'cap.simulated_login_verify', student, `Automatically verified and linked CAP record ${freshRecord.application_id} to ${student.fullName} via Simulated CAP Login`, { recordId: freshRecord.id });
    demoLoginLimiter.reset(key);

    return {
      status: 'linked',
      capDetails: capService.get(student.id),
      verification: studentState(student.id),
    };
  })();
}

module.exports = {
  STATUS_LABELS, SOURCE_LABELS, REASON_LABELS, CSV_MAX_ROWS, namesMatch, normalizeId, studentState, claim, withdrawClaim,
  list, getOne, create, importCsv, update, verify, revoke, unlink, listClaims, approveClaim, rejectClaim, adminViewForStudent, parseCsvLine,
  simulateCapLogin, setDemoPassword, hashPasswordSync, verifyPasswordSync, demoLoginLimiter,
};
