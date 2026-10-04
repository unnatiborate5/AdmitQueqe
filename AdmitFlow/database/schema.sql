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
CREATE TABLE IF NOT EXISTS checklist_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  item_key   TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'in_progress', 'completed')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, item_key)
);
