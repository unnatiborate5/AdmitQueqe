# AdmitFlow API (Phase 2 - Student Portal, Phase 3 - Admin Portal, Phase 4 - Queue)

Base path: `/api`. All responses are JSON: `{ "success": true|false, "message"?, "data"?, "errors"?, "code"? }`.
Authentication uses an HttpOnly session cookie (`admitflow_sid`, 7 days) set by `POST /auth/login`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | no | Health check |
| POST | `/auth/register` | no | Create account (`fullName, email, phone, password, confirmPassword`). 201 / 400 / 409 (duplicate email) |
| POST | `/auth/login` | no | Log in (`email, password`). 200 / 400 / 401 |
| POST | `/auth/logout` | no | End session, clear cookie |
| GET | `/auth/me` | yes | Current student |
| GET | `/cap-details` | yes | Saved CAP details (or `null`) plus dropdown `options` |
| PUT | `/cap-details` | yes | Create/update CAP details. 400 / 409 (Application ID used by another account) |
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
| CAP details | `cap_details` row exists |
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
