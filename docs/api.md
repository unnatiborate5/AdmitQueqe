# AdmitFlow API (Phase 2 - Student Portal)

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
