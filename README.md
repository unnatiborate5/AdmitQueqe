# AdmitFlow
**Post-CAP College Admission Coordination & Queue Management System**

Helps students manage the process after CAP allotment until final college admission.
Physical original-document verification stays manual at the college; AdmitFlow manages the workflow,
checklist, and status around it.

## Status
- Phase 1: project structure - done
- Phase 2: Student Portal - done (registration, login/logout, dashboard, progress tracker, and a clickable form for each of the six admission tasks)
- **Phase 3: College Admin Portal - done** (admin login with roles, live dashboard, student search/filter/inspect, application review with remarks and status history, verification appointments, activity history)
- **Phase 4: Queue & Token Management - done** (C++ queue engine with FIFO queue, priority queue and hash maps; check-in tokens, priority policy, multiple counters, no-show handling; admin queue page and live student token card)
- Not yet built: admission workflow engine / graph algorithms (Phase 5), notifications, payments (later phases)

## Tech Stack
- Frontend: HTML, CSS, JavaScript, Bootstrap 5 (loaded from a CDN, so an internet connection is needed for styling)
- Backend: Node.js + Express
- Database: SQLite (via `better-sqlite3`)
- Queue engine: C++17 (GCC or Clang), compiled automatically on `npm start` / `npm test`

## Run it
Requires Node.js 20 or newer **and a C++ compiler** (g++ or clang++) for the queue engine.
Windows: install MinGW-w64 via MSYS2 and keep `g++` on PATH. macOS: `xcode-select --install`. Linux: `sudo apt install g++`.

```bash
cd AdmitFlow/backend
npm install
npm start
```

Open http://localhost:3000 (students) or http://localhost:3000/admin/login.html (college staff). The SQLite file `database/admitflow.db` is created automatically on first start.
To use another port: `PORT=4000 npm start` (macOS/Linux) or `set PORT=4000 && npm start` (Windows cmd).

## Admin portal (Phase 3)

Admin accounts are never created through the website. Create one first:

```bash
cd AdmitFlow/backend
npm run create-admin -- --name "Asha Rao" --email asha@college.edu --role super_admin
# you are asked for the password (min 10 characters, letters and numbers)
```

Or, for a quick local demo only, create demo admins plus sample students in different stages:

```bash
npm run seed:demo        # refuses to run when NODE_ENV=production
```

| Demo login (password `Demo@Admit2026`) | Role |
|---|---|
| superadmin@admitflow.local | Super Admin: everything, including the activity history |
| officer@admitflow.local | Admission Officer: review, appointments, verification outcome |
| viewer@admitflow.local | Viewer: read-only |

Demo students use the password `Student@2026` (aarav.demo@example.com, sneha.demo@..., rohan, meera, kabir, isha).

| Page | What it does |
|---|---|
| `/admin/dashboard.html` | Total, pending, approved, rejected and verification-pending counts from the database; upcoming appointments; recent activity |
| `/admin/students.html` | Search (name, email, phone, application ID, college), filter (review status, verification, appointment, CAP round), sort, paginate |
| `/admin/student.html?id=` | Full application: CAP details, task progress, documents, fee; approve / reject / request corrections with remarks; internal notes; record verification outcome; schedule, reschedule and update the appointment; status history |
| `/admin/appointments.html` | All appointments by status, schedule new, reschedule, mark completed / missed, cancel |
| `/admin/activity.html` | Every administrative action with admin name, role and timestamp (Super Admin only) |

How admin and student sides connect: both use the same SQLite database. A decision, remark, appointment or verification outcome saved by an admin shows on the student's dashboard on its next load. If the college requests corrections, the student fixes them and presses "I have made the corrections", which puts the application back in the review queue.

Physical verification stays manual. Staff check original documents in person; the admin portal only records the appointment and the outcome. No online authenticity checking exists, and queue/token allocation is not part of this phase.

Rules worth knowing:
- Reject, request corrections and reopen need remarks (the student sees them). Internal notes are staff-only.
- A student has at most one scheduled appointment (enforced by the database). Reschedule changes it; a missed or cancelled one can be replaced by a new one.
- A future appointment cannot be marked completed or missed. Recording verification as "Verified" closes the scheduled appointment automatically.
- Approving while verification is not yet recorded is allowed but warned about.

## Queue and tokens (Phase 4)

Physical verification now runs through a real queue. The queue logic is a C++ program (`cpp_engine/`) that the backend
starts as a child process; SQLite stores every token, so the queue survives restarts (the engine is rebuilt from the database).

How it works day to day:
1. A student with a verification appointment **today** arrives. Staff open **Admin > Queue** (or the student's page) and press **Issue token**.
2. The student gets a token such as `R004` (regular) or `P002` (priority) and sees it, with their queue position, on their dashboard. The card updates by itself every 10 seconds.
3. A free counter presses **Call next**. The student sees "go to Counter 2". Staff press **Start** when the student arrives and **Complete** when done, or **No-show** if they never come.
4. Staff then record the verification outcome on the student's page, exactly as in Phase 3.

Priority (simple and explainable): level 1 = verification already started and the student is returning; level 2 = CAP Round 3 / Special Round; level 3 = everyone else.
Priority students are called first, equal priorities are served in arrival order, and after 3 priority students in a row the oldest regular student is called, so nobody waits forever.
The Admin > Queue page shows this policy to staff.

Rules worth knowing:
- One active token per student (the engine and the database both enforce it). A student served for an appointment cannot be checked in again for the same appointment.
- Counters: two are created automatically; a super admin can add more (up to 10). Several counters share one queue. Closing a counter that has only *called* a student puts that student back in their original place; a counter that is serving cannot be closed.
- No-show: the token ends and the counter is free. The student can be given a new token and joins at the back.
- If the admin rejects an application, moves the appointment to another day, or records verification as completed while a student is waiting, that student leaves the queue automatically (shown in the activity history as "System").
- Tokens are numbered per day. Anything unfinished at the end of the day expires.
- Roles: everyone can view the queue, officers and super admins operate it, only super admins add counters.
- Where each data structure is and why: [`cpp_engine/README.md`](cpp_engine/README.md).

## The six tasks
Click any task on the dashboard (or on the Checklist page) to open its window:

| Task | What the student can do |
|---|---|
| CAP Details | Enter or edit application ID, college, branch, round and allotment status |
| CAP Allotment Acceptance | Record status, acceptance date and a note |
| Admission Form | Record status (not filled / partial / submitted), date and a note |
| Document Preparation | Tick prepared documents; status is worked out automatically |
| Physical Verification | **View only.** The college verifies originals in person and records the result |
| Fee / Payment Status | Read the fee instructions, record status, amount, mode, receipt number and date |

Everything is saved in SQLite and shown on the dashboard. Existing databases are upgraded automatically.

## Run the tests
```bash
cd AdmitFlow/backend
npm test
```
There are four test files: `api.test.js` (student portal), `admin.test.js` (admin portal), `queue.test.js` (tokens and queues) and `engine.cpp.test.js` (compiles and runs the C++ unit tests).
The student test covers Register, Login, CAP details, all five task forms (including validation and the rule that students cannot verify their own documents), Dashboard and Logout against a temporary database.

## Project Structure
```
AdmitFlow/
├── frontend/
│   ├── index.html, login.html, register.html
│   ├── dashboard.html, cap-details.html, checklist.html
│   ├── admin/         login, dashboard, students, student, appointments, activity (.html)
│   ├── css/           style.css, admin.css
│   └── js/            api.js, ui.js, auth.js, modal.js, tasks.js + one script per page
│       └── admin/     admin-common.js, appointment-dialogs.js + one script per admin page
├── backend/
│   ├── server.js      starts the server
│   ├── app.js         Express app (API + static frontend)
│   ├── config/        SQLite connection, applies database/schema.sql
│   ├── routes/        URL -> controller wiring
│   ├── controllers/   request/response handling
│   ├── services/      business logic and database queries
│   ├── middleware/    student auth guard, admin auth + roles, error handling
│   ├── scripts/       create-admin, seed:demo
│   ├── utils/         validators, ApiError, asyncHandler
│   └── tests/         API end-to-end test
├── cpp_engine/        C++ queue engine: include/dsa (FifoQueue, MinHeap, HashMap), engine, protocol, tests, Makefile
├── database/          schema.sql (the .db file is git-ignored)
├── docs/              api.md
├── README.md
└── .gitignore
```

## Security notes
Passwords are hashed with scrypt, sessions use random tokens stored as SHA-256 hashes in an HttpOnly, SameSite=Lax cookie (students) or SameSite=Strict cookie (admins, 8 hours, separate table and cookie name),
and all SQL uses parameterised queries. Set `NODE_ENV=production` behind HTTPS to add the `Secure` cookie flag.
Admin logins are rate limited (5 failures per email per 15 minutes), admin pages redirect to the login page without a session, every admin API route checks the role's permission, and state-changing admin requests must be same-origin JSON.
