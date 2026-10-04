# AdmitFlow
**Post-CAP College Admission Coordination & Queue Management System**

Helps students manage the process after CAP allotment until final college admission.
Physical original-document verification stays manual at the college; AdmitFlow manages the workflow,
checklist, and status around it.

## Status
- Phase 1: project structure - done
- **Phase 2: Student Portal - done** (registration, login/logout, dashboard, CAP details, checklist, progress tracker)
- Not yet built: admin portal, queue/token system, C++ engine, notifications, payments (later phases)

## Tech Stack
- Frontend: HTML, CSS, JavaScript, Bootstrap 5 (loaded from a CDN, so an internet connection is needed for styling)
- Backend: Node.js + Express
- Database: SQLite (via `better-sqlite3`)
- Core engine: C++ (GCC) - planned

## Run it
Requires Node.js 20 or newer.

```bash
cd AdmitFlow/backend
npm install
npm start
```

Open http://localhost:3000. The SQLite file `database/admitflow.db` is created automatically on first start.
To use another port: `PORT=4000 npm start` (macOS/Linux) or `set PORT=4000 && npm start` (Windows cmd).

## Run the tests
```bash
cd AdmitFlow/backend
npm test
```
The API test walks through Register, Login, CAP details, Dashboard, Checklist and Logout against a temporary database.

## Project Structure
```
AdmitFlow/
├── frontend/
│   ├── index.html, login.html, register.html
│   ├── dashboard.html, cap-details.html, checklist.html
│   ├── css/style.css
│   └── js/            api.js, ui.js, auth.js + one script per page
├── backend/
│   ├── server.js      starts the server
│   ├── app.js         Express app (API + static frontend)
│   ├── config/        SQLite connection, applies database/schema.sql
│   ├── routes/        URL -> controller wiring
│   ├── controllers/   request/response handling
│   ├── services/      business logic and database queries
│   ├── middleware/    auth guard, error handling
│   ├── utils/         validators, ApiError, asyncHandler
│   └── tests/         API end-to-end test
├── cpp_engine/        reserved for a later phase
├── database/          schema.sql (the .db file is git-ignored)
├── docs/              api.md
├── README.md
└── .gitignore
```

## Security notes
Passwords are hashed with scrypt, sessions use random tokens stored as SHA-256 hashes in an HttpOnly, SameSite=Lax cookie,
and all SQL uses parameterised queries. Set `NODE_ENV=production` behind HTTPS to add the `Secure` cookie flag.
