-- AdmitFlow database schema (Phase 2: Student Portal, Phase 3: College Admin Portal, Phase 4: Queue & Tokens)
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

-- ===========================================================================
-- Phase 3: College Admin Portal (purely additive; existing databases upgrade
-- automatically on start-up and no student data is touched).
-- ===========================================================================

-- College staff accounts. There is NO public sign-up: accounts are created with
-- `npm run create-admin` (or the dev-only `npm run seed:demo`).
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('super_admin', 'admission_officer', 'viewer')),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Admin sessions live in their own table (and cookie), so a student session can
-- never act as an admin session and the other way round. Only a SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT    PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,              -- epoch milliseconds
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);

-- The admin's decision on a student's application. One row per student; a missing
-- row means "pending" (nothing decided yet). Visible to the student on their dashboard.
CREATE TABLE IF NOT EXISTS application_reviews (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id          INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  status              TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'correction_requested')),
  remarks             TEXT,
  reviewed_by_name    TEXT,
  reviewed_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_at         TEXT,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON application_reviews(status);

-- Append-only history of every status change and remark on an application.
-- actor_name is a snapshot so the history stays readable if an admin is later removed.
CREATE TABLE IF NOT EXISTS application_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  event_type  TEXT    NOT NULL CHECK (event_type IN ('status_change', 'remark')),
  from_status TEXT,
  to_status   TEXT    NOT NULL,
  remarks     TEXT,
  actor_type  TEXT    NOT NULL CHECK (actor_type IN ('admin', 'student')),
  admin_id    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  actor_name  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_history_student ON application_status_history(student_id, id);

-- Physical document verification appointments (the verification itself stays manual).
CREATE TABLE IF NOT EXISTS appointments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  appointment_date TEXT    NOT NULL,          -- YYYY-MM-DD
  appointment_time TEXT    NOT NULL,          -- HH:MM (24h)
  venue            TEXT    NOT NULL,
  instructions     TEXT,
  status           TEXT    NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'completed', 'missed', 'cancelled')),
  status_note      TEXT,                      -- last reschedule reason / cancellation note
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  created_by_name  TEXT    NOT NULL,
  updated_by_name  TEXT    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appointments_student ON appointments(student_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date, status);
-- A student can have at most ONE active (scheduled) appointment. Enforced by the database,
-- so even two admins clicking "schedule" at the same moment cannot create a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_appointment
  ON appointments(student_id) WHERE status = 'scheduled';

-- Audit trail of administrative actions: who did what, to which student, and when.
CREATE TABLE IF NOT EXISTS admin_activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  admin_name TEXT    NOT NULL,
  admin_role TEXT    NOT NULL,
  action     TEXT    NOT NULL,                -- e.g. application.approve, appointment.schedule
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  student_name TEXT,
  summary    TEXT    NOT NULL,
  details    TEXT,                            -- JSON (old/new values)
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON admin_activity_log(id);
CREATE INDEX IF NOT EXISTS idx_activity_student ON admin_activity_log(student_id);
CREATE INDEX IF NOT EXISTS idx_activity_admin ON admin_activity_log(admin_id);

-- ===========================================================================
-- Phase 4: Queue & Token Management (additive).
-- The queue ENGINE (C++, cpp_engine/) keeps the live queues in memory; these tables are the durable
-- record. The engine can be rebuilt from them at any time (e.g. after a crash or server restart).
-- ===========================================================================

-- Physical verification counters (desks). Several can serve the same shared queue.
CREATE TABLE IF NOT EXISTS verification_counters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  is_open    INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per token issued at check-in. Tokens are numbered per day (token_number = arrival order).
CREATE TABLE IF NOT EXISTS queue_tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_date      TEXT    NOT NULL,                 -- YYYY-MM-DD (college time zone)
  token_number    INTEGER NOT NULL,                 -- arrival number for that day: 1, 2, 3 ...
  token_code      TEXT    NOT NULL,                 -- 'P003' (priority lane) or 'R004' (regular lane)
  lane            TEXT    NOT NULL CHECK (lane IN ('priority', 'regular')),
  priority_level  INTEGER NOT NULL CHECK (priority_level BETWEEN 1 AND 3),   -- 1 most urgent, 3 regular
  priority_reason TEXT    NOT NULL,                 -- why, in plain words (shown to staff and student)
  student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  application_id  TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'called', 'serving', 'completed', 'no_show', 'cancelled', 'expired')),
  counter_id      INTEGER REFERENCES verification_counters(id) ON DELETE SET NULL,
  issued_by_name  TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  called_at       TEXT,
  serving_at      TEXT,
  finished_at     TEXT,
  finish_reason   TEXT,
  UNIQUE (queue_date, token_number),
  UNIQUE (queue_date, token_code)
);
-- A student can hold at most ONE active token, and a counter can hold at most ONE active student.
-- Enforced by the database, on top of the engine's own hash-map check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_token_per_student
  ON queue_tokens(student_id) WHERE status IN ('waiting', 'called', 'serving');
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_student_per_counter
  ON queue_tokens(counter_id) WHERE status IN ('called', 'serving');
CREATE INDEX IF NOT EXISTS idx_queue_tokens_day ON queue_tokens(queue_date, status);
CREATE INDEX IF NOT EXISTS idx_queue_tokens_student ON queue_tokens(student_id, id);

-- Small key/value store (e.g. the fairness streak, so call order is identical after a restart).
CREATE TABLE IF NOT EXISTS queue_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
