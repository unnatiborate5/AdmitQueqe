'use strict';
/**
 * ===========================================================================
 * CAP ROUND DEADLINES SERVICE
 * ===========================================================================
 *
 * Configures and tracks verified official deadlines for each CAP round.
 *
 * Distinct Official Deadlines:
 * 1. Seat Acceptance Deadline (seat_acceptance):
 *    The date by which a candidate must accept the allotted seat on the CAP portal.
 *    Relates only to online seat acceptance (Task 2).
 *
 * 2. Institute Reporting & Admission Confirmation Deadline (institute_reporting):
 *    The official date by which the candidate must report to the allotted institute
 *    in-person to submit documents, verify originals, and pay college fees.
 *    THIS IS THE OFFICIAL DEADLINE RELEVANT TO THE SIX-TASK ADMISSION WORKFLOW.
 *
 * 3. Overall Admission Cutoff Date (admission_cutoff):
 *    The system-wide final cutoff date across all rounds.
 *
 * IMPORTANT:
 * - These three deadlines are NEVER interchangeable.
 * - Exact dates are NEVER inferred from round numbers or invented.
 * - If the institute reporting deadline is unconfigured/unavailable for a round,
 *   it is marked unavailable. We NEVER substitute appointment dates.
 * ===========================================================================
 */

const getDb = (dbInstance) => dbInstance || require('../config/db');

const DEADLINE_TYPES = Object.freeze({
  SEAT_ACCEPTANCE: 'seat_acceptance',
  INSTITUTE_REPORTING: 'institute_reporting',
  ADMISSION_CUTOFF: 'admission_cutoff',
});

const DEADLINE_LABELS = Object.freeze({
  seat_acceptance: 'Seat Acceptance Deadline',
  institute_reporting: 'Institute Reporting Deadline',
  admission_cutoff: 'Admission Cutoff Date',
});

const WORKFLOW_RELEVANT_DEADLINE_TYPE = DEADLINE_TYPES.INSTITUTE_REPORTING;

function ensureTable(dbInstance) {
  const db = getDb(dbInstance);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cap_round_deadlines (
      id                           INTEGER PRIMARY KEY AUTOINCREMENT,
      cap_round                    TEXT    NOT NULL UNIQUE,
      seat_acceptance_deadline     TEXT,
      institute_reporting_deadline TEXT,
      admission_cutoff_deadline    TEXT,
      is_verified                  INTEGER NOT NULL DEFAULT 1 CHECK (is_verified IN (0, 1)),
      verified_by_name             TEXT,
      verified_at                  TEXT,
      notes                        TEXT,
      created_at                   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at                   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_round_deadlines_round ON cap_round_deadlines(cap_round);
  `);
}

function getDeadlines(capRound, dbInstance) {
  if (!capRound) return null;
  const db = getDb(dbInstance);
  ensureTable(db);
  const row = db.prepare('SELECT * FROM cap_round_deadlines WHERE cap_round = ?').get(capRound);
  if (!row) return null;
  return {
    id: row.id,
    capRound: row.cap_round,
    seatAcceptanceDeadline: row.seat_acceptance_deadline,
    instituteReportingDeadline: row.institute_reporting_deadline,
    admissionCutoffDeadline: row.admission_cutoff_deadline,
    isVerified: Boolean(row.is_verified),
    verifiedByName: row.verified_by_name,
    verifiedAt: row.verified_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getAllDeadlines(dbInstance) {
  const db = getDb(dbInstance);
  ensureTable(db);
  const rows = db.prepare('SELECT * FROM cap_round_deadlines ORDER BY id ASC').all();
  return rows.map((row) => ({
    id: row.id,
    capRound: row.cap_round,
    seatAcceptanceDeadline: row.seat_acceptance_deadline,
    instituteReportingDeadline: row.institute_reporting_deadline,
    admissionCutoffDeadline: row.admission_cutoff_deadline,
    isVerified: Boolean(row.is_verified),
    verifiedByName: row.verified_by_name,
    verifiedAt: row.verified_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function setDeadlines(admin, capRound, fields = {}, dbInstance) {
  if (!capRound) throw new Error('CAP round is required.');
  const db = getDb(dbInstance);
  ensureTable(db);

  const adminName = admin && admin.fullName ? admin.fullName : 'Admission Admin';
  const seatAcceptance = fields.seatAcceptanceDeadline || fields.seatAcceptance || null;
  const instituteReporting = fields.instituteReportingDeadline || fields.instituteReporting || null;
  const admissionCutoff = fields.admissionCutoffDeadline || fields.admissionCutoff || null;
  const isVerified = fields.isVerified !== false ? 1 : 0;
  const notes = fields.notes || null;

  db.prepare(`
    INSERT INTO cap_round_deadlines (
      cap_round, seat_acceptance_deadline, institute_reporting_deadline,
      admission_cutoff_deadline, is_verified, verified_by_name, verified_at, notes
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(cap_round) DO UPDATE SET
      seat_acceptance_deadline = excluded.seat_acceptance_deadline,
      institute_reporting_deadline = excluded.institute_reporting_deadline,
      admission_cutoff_deadline = excluded.admission_cutoff_deadline,
      is_verified = excluded.is_verified,
      verified_by_name = excluded.verified_by_name,
      verified_at = datetime('now'),
      notes = excluded.notes,
      updated_at = datetime('now')
  `).run(capRound, seatAcceptance, instituteReporting, admissionCutoff, isVerified, adminName, notes);

  return getDeadlines(capRound, db);
}

/**
 * Returns the relevant official deadline for a student's six-task admission workflow.
 * Selects only the institute reporting deadline for the student's actual CAP round.
 * Never substitutes appointment dates.
 */
function getRelevantDeadlineForStudent(studentId, dbInstance) {
  const db = getDb(dbInstance);
  ensureTable(db);

  // Look up student's actual CAP round
  const capRow = db.prepare(`
    SELECT cap_round FROM cap_details WHERE student_id = ?
    UNION
    SELECT cap_round FROM cap_allotment_records WHERE linked_student_id = ? AND status = 'verified'
  `).get(studentId, studentId);

  const capRound = capRow ? capRow.cap_round : null;
  if (!capRound) {
    return {
      capRound: null,
      deadlineType: WORKFLOW_RELEVANT_DEADLINE_TYPE,
      deadlineLabel: DEADLINE_LABELS[WORKFLOW_RELEVANT_DEADLINE_TYPE],
      deadline: null,
      seatAcceptanceDeadline: null,
      admissionCutoffDeadline: null,
      isAvailable: false,
      isVerified: false,
      notes: null,
      reason: 'Student has no linked CAP allotment round.',
    };
  }

  const roundData = getDeadlines(capRound, db);
  const relevantDeadline = roundData ? roundData.instituteReportingDeadline : null;

  return {
    capRound,
    deadlineType: WORKFLOW_RELEVANT_DEADLINE_TYPE,
    deadlineLabel: DEADLINE_LABELS[WORKFLOW_RELEVANT_DEADLINE_TYPE],
    deadline: relevantDeadline || null,
    seatAcceptanceDeadline: roundData ? roundData.seatAcceptanceDeadline : null,
    admissionCutoffDeadline: roundData ? roundData.admissionCutoffDeadline : null,
    isAvailable: Boolean(relevantDeadline),
    isVerified: roundData ? roundData.isVerified : false,
    notes: roundData ? roundData.notes : null,
    reason: relevantDeadline ? null : 'Official institute reporting deadline is unavailable for this CAP round.',
  };
}

/**
 * Seeds default verified round deadlines for demo rounds if not already set.
 * Round 1, 2, 3 have verified official schedules.
 * Special Round is left with institute_reporting as null to reflect real-world
 * unannounced schedule and validate unavailable-deadline handling.
 */
function seedDefaultRoundDeadlines(dbInstance) {
  const db = getDb(dbInstance);
  ensureTable(db);

  const defaults = [
    {
      capRound: 'Round 1',
      seatAcceptance: '2026-10-24',
      instituteReporting: '2026-10-25',
      admissionCutoff: '2026-11-15',
      isVerified: true,
      notes: 'Official Maharashtra CAP Round 1 schedule: Reporting to Allotted Institute and Confirmation of Admission.',
    },
    {
      capRound: 'Round 2',
      seatAcceptance: '2026-10-28',
      instituteReporting: '2026-10-29',
      admissionCutoff: '2026-11-15',
      isVerified: true,
      notes: 'Official Maharashtra CAP Round 2 schedule: Reporting to Allotted Institute and Confirmation of Admission.',
    },
    {
      capRound: 'Round 3',
      seatAcceptance: '2026-11-04',
      instituteReporting: '2026-11-05',
      admissionCutoff: '2026-11-15',
      isVerified: true,
      notes: 'Official Maharashtra CAP Round 3 schedule: Reporting to Allotted Institute and Confirmation of Admission.',
    },
    {
      capRound: 'Special Round',
      seatAcceptance: null,
      instituteReporting: null,
      admissionCutoff: '2026-11-15',
      isVerified: false,
      notes: 'Special Round reporting schedule not yet released by CET Cell.',
    },
  ];

  const stmt = db.prepare(`
    INSERT INTO cap_round_deadlines (
      cap_round, seat_acceptance_deadline, institute_reporting_deadline,
      admission_cutoff_deadline, is_verified, verified_by_name, notes
    ) VALUES (?, ?, ?, ?, ?, 'System / CET Cell Notification', ?)
    ON CONFLICT(cap_round) DO NOTHING
  `);

  db.transaction(() => {
    for (const d of defaults) {
      stmt.run(d.capRound, d.seatAcceptance, d.instituteReporting, d.admissionCutoff, d.isVerified ? 1 : 0, d.notes);
    }
  })();
}

module.exports = {
  DEADLINE_TYPES,
  DEADLINE_LABELS,
  WORKFLOW_RELEVANT_DEADLINE_TYPE,
  ensureTable,
  getDeadlines,
  getAllDeadlines,
  setDeadlines,
  getRelevantDeadlineForStudent,
  seedDefaultRoundDeadlines,
};
