# AdmitFlow API (Phase 2 - Student Portal, Phase 3 - Admin Portal, Phase 4 - Queue, Phase 5 - Search / Planner / Undo)

Base path: `/api`. All responses are JSON: `{ "success": true|false, "message"?, "data"?, "errors"?, "code"? }`.
Authentication uses an HttpOnly session cookie (`admitflow_sid`, 7 days) set by `POST /auth/login`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | no | Health check |
| POST | `/auth/register` | no | Create account (`fullName, email, phone, password, confirmPassword`). 201 / 400 / 409 (duplicate email) |
| POST | `/auth/login` | no | Log in (`email, password`). 200 / 400 / 401 |
| POST | `/auth/logout` | no | End session, clear cookie |
| GET | `/auth/me` | yes | Current student |
| GET | `/cap-details` | yes | `{ capDetails, verification }`. `capDetails` is the verified, read-only record (or `null`); `verification.status` is `verified`, `pending`, `rejected` or `none` (with a message) |
| PUT | `/cap-details` | yes | Body: **only** `applicationId`. Links a verified, unlinked record with a matching name (`data.result: "linked"`), otherwise records a claim (`"pending"`, same response whatever the reason). Any other field (college, branch, round, status, a password, ...) is refused with 400 `READ_ONLY_FIELDS`. 400 bad ID, 409 `ALREADY_LINKED`, 429 `RATE_LIMITED` |
| DELETE | `/cap-details` | yes | Withdraws the student's pending claim (404 `NO_PENDING_CLAIM` if none) |
| GET | `/checklist` | yes | The 5 checklist items (status, summary line) + progress. 409 `CAP_DETAILS_REQUIRED` until CAP details exist |
| GET | `/tasks/:taskKey` | yes | Everything a task window needs (current status + saved details). 404 / 409 |
| PUT | `/tasks/:taskKey` | yes | Save a task form. 400 / 403 / 404 / 409 |
| GET | `/dashboard` | yes | CAP summary, progress counts, task list, next required step |

Task keys: `allotment_acceptance`, `admission_form`, `document_preparation`, `physical_verification`, `fee_payment`.
(CAP details use `/cap-details`.)

## Task forms (`PUT /tasks/:taskKey`)

| Task | Body | Rules |
|---|---|---|
| `allotment_acceptance` | `status` (`pending`/`in_progress`/`completed`), `eventDate` (YYYY-MM-DD), `note` | Date required when `completed`, not in the future. Note up to 300 characters. Date is cleared for `pending`. |
| `admission_form` | same as above | same as above |
| `document_preparation` | `preparedDocs`: array of document keys | Unknown keys rejected. Status is **derived**: none ticked = pending, some = in progress, all 7 required = completed. |
| `physical_verification` | - | **Always 403 `COLLEGE_ONLY`.** Students can only read it. |
| `fee_payment` | `status`, `totalFee?`, `amountPaid`, `paymentMode`, `receiptNumber`, `paidOn` | Amounts: up to 2 decimals, max 1,00,00,000. `in_progress` and `completed` need amount, mode, receipt number and date. Partial must be below the total fee, paid must cover it. `pending` clears the payment fields. |

## Where each status comes from

| Task | Source of truth |
|---|---|
| CAP details | `cap_details` row exists (it exists only for a student linked to a VERIFIED record) |
| Allotment acceptance, Admission form, Fee payment | `checklist_items.status` (written by the task form) plus `task_records` / `fee_details` |
| Document preparation | derived from `document_status` |
| Physical verification | `verification_records` - never written by the student portal |

Progress counts six tasks: CAP details plus the five checklist items.

## Physical verification

The college verifies original documents in person. The student portal only displays the result.
Until a college-side tool exists (a later phase), the status stays "Not Verified". For a demo you can simulate the
college by running this against `database/admitflow.db`:

```sql
INSERT INTO verification_records (student_id, status, verified_by, verified_at, remarks)
VALUES (1, 'completed', 'Admission Cell', '2026-09-20', 'All originals matched')
ON CONFLICT(student_id) DO UPDATE SET status = excluded.status, verified_by = excluded.verified_by,
  verified_at = excluded.verified_at, remarks = excluded.remarks, updated_at = datetime('now');
```

## Changes from the first Phase 2 release
- Removed `PATCH /checklist/:itemKey`. It let a student set any status directly (including physical verification) and
  skipped validation. All updates now go through `PUT /tasks/:taskKey`.
- Status values stored by the old physical-verification quick toggle are ignored.
- New tables `task_records`, `document_status`, `fee_details`, `verification_records` are created automatically on start-up.
  Existing data is kept.


---

# Phase 3: Admin API (`/api/admin`)

Separate session cookie `admitflow_admin_sid` (HttpOnly, SameSite=Strict, 8 hours). Student cookies do not work here and admin cookies do not work on student routes. Mutating requests must be JSON and, when an `Origin` header is sent, same-origin (else 403 `CSRF`).
Errors: 401 `UNAUTHENTICATED`, 403 `FORBIDDEN` (role lacks the permission), 429 `RATE_LIMITED` (login).

## Roles and permissions

| Permission | super_admin | admission_officer | viewer |
|---|:-:|:-:|:-:|
| dashboard:view, students:view | yes | yes | yes |
| applications:review, appointments:manage, verification:record | yes | yes | - |
| activity:view | yes | - | - |

## Endpoints

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/auth/login` | - | `email, password`. 200 / 400 / 401 / 429 |
| POST | `/auth/logout` | - | End session (recorded in the activity log) |
| GET | `/auth/me` | any admin | Current admin with role and permissions |
| GET | `/dashboard` | dashboard:view | `stats` (see below), `upcomingAppointments`, `recentActivity` (super admin only) |
| GET | `/students` | students:view | Query: `search, status, verification, appointment, round, sort, page, pageSize` |
| GET | `/students/:id` | students:view | Full application detail, history, appointments |
| POST | `/students/:id/review` | applications:review | `action` (`approve`/`reject`/`request_corrections`/`reopen`), `remarks`, optional `expectedStatus`. Remarks required except for approve. 409 `NO_APPLICATION` / `NO_CHANGE` / `STALE_STATUS` |
| POST | `/students/:id/notes` | applications:review | Internal note `remarks` (never shown to the student) |
| PUT | `/students/:id/verification` | verification:record | `status` (`pending`/`in_progress`/`completed`), `remarks`. Writes the record students see read-only. `completed` closes a scheduled appointment |
| GET | `/appointments` | students:view | Query: `status, when (today/upcoming), date, search, page`. Returns per-status `counts` |
| POST | `/appointments` | appointments:manage | `studentId, date, time, venue, instructions?`. 409 `ALREADY_SCHEDULED` / `ALREADY_VERIFIED` / `APPLICATION_REJECTED` |
| PUT | `/appointments/:id` | appointments:manage | Reschedule: new `date, time, venue, instructions?` and `reason` (required) |
| PATCH | `/appointments/:id/status` | appointments:manage | `status` (`completed`/`missed`/`cancelled`), `note` (required for cancel). 409 `TOO_EARLY` for future dates |
| GET | `/activity` | activity:view | Query: `adminId, studentId, group (auth/application/appointment/verification), search, page, pageSize` |

Dashboard `stats`: `totalStudents`, `applications` (students with CAP details), `notStarted` (applications + notStarted = totalStudents), `pending`, `approved`, `rejected`, `correctionRequested` (these four add up to applications), `verificationPending` (applications not yet verified and not rejected), `verificationUnscheduled` (of those, without an appointment).

Filter values: `status` = `pending|approved|rejected|correction_requested|not_started`; `verification` = `awaiting` (the dashboard definition) `|pending|in_progress|completed`; `appointment` = `scheduled|none`; `sort` = `recent|name|appointment`. Unknown values are ignored.

## Student-side additions

| Method | Path | Purpose |
|---|---|---|
| POST | `/application/resubmit` | Student confirms requested corrections are done (`note?`). Application returns to Pending Review. 409 `NO_CORRECTIONS_PENDING` |
| GET | `/dashboard` | Now also returns `application` (`status, label, remarks, canResubmit, history`; admin names are hidden) and `appointment` |
| GET | `/tasks/physical_verification` | `details.appointment` added |

`overallStatus` on the student dashboard now follows the college decision: `Application Rejected`, `Corrections Requested`, `Admission Approved`.

## New tables

`admins`, `admin_sessions`, `application_reviews`, `application_status_history`, `appointments` (partial unique index: one `scheduled` row per student), `admin_activity_log`. All created automatically and additively on start-up.


---

# Phase 4: Queue & Token API

Admin routes are under `/api/admin/queue`. New permissions: `queue:view` (all roles), `queue:operate` (super_admin, admission_officer), `queue:configure` (super_admin).
If the C++ engine cannot be started the queue endpoints answer 503 `ENGINE_UNAVAILABLE`; every other endpoint keeps working.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/queue` | queue:view | Whole state for today: `counters` (with current token), `waiting` (in call order with `position`/`ahead`), `finished`, `stats`, `policy`, `streak` |
| GET | `/queue/eligible?search=` | queue:view | Students who can be checked in now (appointment today, no active token), with their priority level |
| GET | `/queue/lookup?token=R012` or `?applicationId=MH2026-1001` | queue:view | Find a token. Active tokens come from the engine (hash-map lookup, `source: "engine"`), finished ones from the database |
| POST | `/queue/check-in` | queue:operate | `{ studentId }`. Issues a token. 409: `NO_APPLICATION`, `APPLICATION_REJECTED`, `ALREADY_VERIFIED`, `NO_APPOINTMENT`, `NOT_TODAY`, `ALREADY_QUEUED`, `ALREADY_SERVED` |
| POST | `/queue/counters/:id/call-next` | queue:operate | Calls the next student. 409: `QUEUE_EMPTY`, `COUNTER_BUSY`, `COUNTER_CLOSED` |
| POST | `/queue/tokens/:id/start` | queue:operate | called -> serving |
| POST | `/queue/tokens/:id/complete` | queue:operate | serving -> completed |
| POST | `/queue/tokens/:id/no-show` | queue:operate | called -> no_show (optional `note`) |
| POST | `/queue/tokens/:id/cancel` | queue:operate | waiting or called -> cancelled (optional `note`). Not allowed while serving |
| PATCH | `/queue/counters/:id` | queue:operate | `{ isOpen: true/false }`. Closing returns a called (not yet serving) student to the queue; 409 `COUNTER_BUSY` while serving |
| POST | `/queue/counters` | queue:configure | `{ name }` adds a counter (max 10) |

Token statuses: `waiting`, `called`, `serving`, `completed`, `no_show`, `cancelled`, `expired` (unfinished at end of day).

## Student side

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard` | Now also returns `queue: { token, appointmentToday }`. `token` = `{ code, status, statusLabel, position, ahead, counter, priority, priorityReason, message, active }` or null |
| GET | `/queue/my-token` | Same `queue` object; polled every 10 s by the dashboard while a token is active |

Students only ever see their own token. Admin queue changes (call, start, no-show, ...) show up on the next poll.

## New tables

`verification_counters`, `queue_tokens` (unique token number per day; partial unique indexes: one active token per student, one active student per counter), `queue_meta` (fairness streak). Created automatically.

## Priority policy and call order

Level 1: verification status "in progress" (returning student). Level 2: CAP round "Round 3" or "Special Round". Level 3: everyone else.
Levels 1-2 use the priority lane (binary heap ordered by level then arrival); level 3 uses the regular lane (FIFO).
After `QUEUE_PRIORITY_BURST` (default 3) priority calls in a row, the oldest regular student is called next.


---

# Phase 5: Search, planner and undo (`/api/admin`)

All answered by the C++ engine. Same session cookie and CSRF rules as the rest of the admin API.
If the engine cannot start, these endpoints answer 503 `ENGINE_UNAVAILABLE`; everything else keeps working.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/search?q=` | students:view | 2-60 characters (letters, digits, spaces, `. ' -`). Runs token search (if `q` looks like `R012`), application-ID prefix search (binary search) and name search (linear search). Returns `results[]` (`id, name, applicationId, reviewStatus, token, matchedBy`), `total`, `truncated` (max 15 returned) and `algorithms[]` (`field, algorithm, comparisons, searched, matches`) |
| GET | `/planner/unscheduled` | students:view | Students still needing an appointment, merge-sorted by priority level, longest waiting, name. `items[]` have `rank, level, priorityReason, waitingSince`; `algorithm` = `{name, comparisons, items}` |
| GET | `/planner/arrivals?sort=time\|priority\|token` | students:view | Today's appointments, merge-sorted (default `time`; unknown values fall back to `time`). Items include the student's token and token status |
| GET | `/planner/load?from=YYYY-MM-DD&days=1-31` | students:view | Appointment load as a SPARSE matrix (days x 48 half-hour slots): `cells` (non-zero only), `dayTotals`, `slotTotals`, `busiest`, `suggestions` (least busy slot per day in office hours 09:00-17:00) and `matrix` (`storedCells`, `totalCells`, `density`, `lookupComparisons`). Defaults: today, 14 days |
| GET | `/planner/documents` | students:view | Document readiness as a DENSE matrix (9 documents x 4 CAP rounds): `documents[].ready/percent`, `rounds[].students`, `weakest[]` |
| GET | `/undo` | applications:review | The admin's own undo stack, newest first: `items[]` (`id, kind, summary, studentName, createdAt`), `size`, `capacity` (20), `next` |
| POST | `/undo` | applications:review | Undoes the newest entry. 409 `NOTHING_TO_UNDO`; 409 `STALE_UNDO` when the record changed since (the entry is removed from the stack) |

Reversible actions (recorded automatically): `POST /students/:id/review` and `PUT /appointments/:id` (reschedule).

## New table

`admin_undo_actions` (`kind` = review | reschedule, `before_json`, `after_json`, `status` = active | undone | discarded | expired). The stacks themselves live in the engine and are rebuilt from the active rows on start.

## Engine commands added (see `cpp_engine/include/toolkit.hpp`)

`INDEX_CLEAR/ADD/TOKENS/BUILD`, `SEARCH_APP/TOKEN/NAME`, `SORT <mode>`, `STACK_PUSH/POP/PEEK/LIST/CLEAR_ALL`, `APPT_LOAD`, `DOC_READINESS`. The Phase 4 queue commands are unchanged.


---

# CAP allotment verification (`/api/admin/cap`)

Trusted allotment records, student claims and an audit history. AdmitFlow is not connected to the official CAP portal and stores no CAP credentials.
New permissions: `cap:view`, `cap:manage` (add, import, correct, unlink, resolve claims), `cap:verify` (verify, revoke). Super admins and admission officers have all three; **viewers have none**.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/cap/records` | cap:view | Query: `status` (`pending_verification`/`verified`/`revoked`), `linked` (`yes`/`no`), `search` (application-ID prefix or name), `page`. Returns `items[]`, `counts`, `pendingClaims`, `options` |
| GET | `/cap/records/:id` | cap:view | Record plus its full audit `history` (event, admin/student/system, remarks, before/after `details`) |
| POST | `/cap/records` | cap:manage | `applicationId, candidateName, allottedCollege, courseBranch, capRound, allotmentStatus, sourceNote?`. Creates a **pending** record. 409 `DUPLICATE_APPLICATION_ID` |
| POST | `/cap/records/import` | cap:manage | `{ csv, sourceNote? }`: columns `application_id, candidate_name, allotted_college, course_branch, cap_round, allotment_status`, header optional, max 500 rows. Never overwrites. Returns `created` and `skipped[]` (`line`, `applicationId`, `reason`) |
| PUT | `/cap/records/:id` | cap:manage | A correction: the six fields + **`remarks` (required)**. Keeps a verified record verified and updates the linked student; a revoked record returns to pending. 400 `NO_CHANGE`, 409 `LINKED_ID_LOCKED` / `DUPLICATE_APPLICATION_ID` |
| POST | `/cap/records/:id/verify` | cap:verify | Optional `remarks`. Waiting students with a matching name are linked. 403 `FOUR_EYES` if you were the last to change it (super admins exempt); 409 `ALREADY_VERIFIED` / `REVOKED` |
| POST | `/cap/records/:id/revoke` | cap:verify | `remarks` required. 409 `UNLINK_FIRST` if a student is linked |
| POST | `/cap/records/:id/unlink` | cap:manage | `remarks` required. Removes the student's CAP details (and takes a waiting queue token out of the queue). 409 `NOT_LINKED` |
| GET | `/cap/claims` | cap:view | `status` (default `pending`). Each claim shows the student, the submitted ID, the reason it waits (`not_found`, `not_verified`, `revoked`, `name_mismatch`, `already_linked`) and the record's state |
| POST | `/cap/claims/:id/approve` | cap:manage | Links the student to the verified record; `remarks` required when the name differs |
| POST | `/cap/claims/:id/reject` | cap:manage | `note` required; shown to the student |

`GET /api/dashboard` (student) now also returns `capVerification` (the same object as `verification` above), and the CAP task shows `Verification Pending` while a claim waits. Every action is also written to the admin activity history (group `cap`). Tables: `cap_allotment_records` (UNIQUE `application_id`), `cap_record_history`, `cap_claims`.
