-- AdmitFlow database schema (Phase 2: Student Portal)
-- Applied automatically (idempotently) when the backend starts.

CREATE TABLE IF NOT EXISTS students (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  phone         TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Login sessions. Only a SHA-256 hash of the session token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,              -- epoch milliseconds
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);

-- One CAP allotment record per student.
CREATE TABLE IF NOT EXISTS cap_details (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id       INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  application_id   TEXT    NOT NULL UNIQUE,
  student_name     TEXT    NOT NULL,
  allotted_college TEXT    NOT NULL,
  course_branch    TEXT    NOT NULL,
  cap_round        TEXT    NOT NULL,
  allotment_status TEXT    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Per-student status of each admission checklist item.
-- Item definitions (titles, labels) live in backend/services/checklistService.js.
-- physical_verification and document_preparation are NOT read from here any more
-- (see verification_records / document_status below).
CREATE TABLE IF NOT EXISTS checklist_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  item_key   TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'in_progress', 'completed')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, item_key)
);

-- ---------------------------------------------------------------------------
-- Task detail tables (added after the first Phase 2 release; purely additive,
-- so existing databases are upgraded automatically on start-up).
-- ---------------------------------------------------------------------------

-- Optional date + note for student-reported tasks
-- (allotment_acceptance, admission_form). The status itself stays in checklist_items.
CREATE TABLE IF NOT EXISTS task_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  task_key   TEXT    NOT NULL,
  event_date TEXT,                           -- YYYY-MM-DD
  note       TEXT,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, task_key)
);

-- Which documents the student has prepared (Document Preparation task).
CREATE TABLE IF NOT EXISTS document_status (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  doc_key    TEXT    NOT NULL,
  prepared   INTEGER NOT NULL DEFAULT 0 CHECK (prepared IN (0, 1)),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, doc_key)
);

-- Payment details the student reports (Fee / Payment Status task).
CREATE TABLE IF NOT EXISTS fee_details (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  total_fee      REAL,
  amount_paid    REAL,
  payment_mode   TEXT,
  receipt_number TEXT,
  paid_on        TEXT,                       -- YYYY-MM-DD
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outcome of the in-person original-document verification.
-- READ-ONLY for students: the student portal never writes to this table.
-- It is meant to be written by the college side (a later phase).
CREATE TABLE IF NOT EXISTS verification_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'in_progress', 'completed')),
  verified_by TEXT,
  verified_at TEXT,
  remarks     TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
