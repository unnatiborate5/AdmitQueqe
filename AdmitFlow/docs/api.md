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
| PUT | `/cap-details` | yes | Create/update CAP details (`applicationId, studentName, allottedCollege, courseBranch, capRound, allotmentStatus`). 400 / 409 (Application ID used by another account) |
| GET | `/checklist` | yes | 5 checklist items + progress. 409 `CAP_DETAILS_REQUIRED` until CAP details exist |
| PATCH | `/checklist/:itemKey` | yes | Set item status: `pending`, `in_progress` or `completed`. 400 / 404 / 409 |
| GET | `/dashboard` | yes | CAP summary, progress counts, task list, next required step |

Checklist item keys: `allotment_acceptance`, `admission_form`, `document_preparation`, `physical_verification`, `fee_payment`.

Progress counts six tasks: CAP details (done once saved) plus the five checklist items.
Physical verification is performed manually at the college; the portal only records the status the student reports.
