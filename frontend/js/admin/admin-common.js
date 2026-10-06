/* Shared admin-portal helpers: session guard, navbar, pills, pagination. Exposes window.Admin. */
(function () {
  const esc = UI.esc;
  const NAV = [
    ['dashboard.html', 'Dashboard', 'dashboard:view'],
    ['students.html', 'Students', 'students:view'],
    ['appointments.html', 'Appointments', 'students:view'],
    ['queue.html', 'Queue', 'queue:view'],
    ['activity.html', 'Activity', 'activity:view'],
  ];
  const SAFE_NEXT = ['dashboard.html', 'students.html', 'student.html', 'appointments.html', 'queue.html', 'activity.html'];

  const REVIEW_LABELS = { pending: 'Pending Review', approved: 'Approved', rejected: 'Rejected', correction_requested: 'Corrections Requested', not_started: 'Not Started' };
  const VERIF_LABELS = { pending: 'Not Verified', in_progress: 'In Progress', completed: 'Verified' };
  const TOKEN_LABELS = { waiting: 'Waiting', called: 'Called', serving: 'Being served', completed: 'Completed', no_show: 'No-show', cancelled: 'Cancelled', expired: 'Expired' };
  const tokenPill = (status) => UI.statusPill(status, TOKEN_LABELS[status] || status);
  const APPT_LABELS = { scheduled: 'Scheduled', completed: 'Completed', missed: 'Missed', cancelled: 'Cancelled' };

  const can = (admin, permission) => Boolean(admin && admin.permissions.includes(permission));
  const reviewPill = (status) => UI.statusPill(status, REVIEW_LABELS[status] || status);
  const verifPill = (status) => UI.statusPill(status, VERIF_LABELS[status] || status);
  const apptPill = (status) => UI.statusPill(status, APPT_LABELS[status] || status);
  const slot = (date, time) => `${UI.formatDay(date)}, ${UI.formatClock(time)}`;

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function logout() {
    try { await Api.post('/api/admin/auth/logout'); } catch (_) { /* leave regardless */ }
    window.location.href = 'login.html?loggedout=1';
  }

  function renderNavbar(admin, active) {
    const host = document.getElementById('app-navbar');
    if (!host) return;
    const links = NAV.filter(([, , perm]) => can(admin, perm)).map(([href, label]) =>
      `<li class="nav-item"><a class="nav-link ${href === active ? 'active' : ''}" href="${href}"${href === active ? ' aria-current="page"' : ''}>${label}</a></li>`).join('');
    host.innerHTML = `
      <header class="admin-nav">
        <div class="container d-flex flex-wrap align-items-center gap-2 gap-md-3">
          <a class="brand" href="dashboard.html">Admit<span class="brand-mark">Flow</span><span class="admin-badge">Admin</span></a>
          <ul class="nav flex-wrap me-md-auto">${links}</ul>
          <div class="d-flex align-items-center gap-2 ms-auto">
            <span class="small fw-semibold" id="nav-user">${esc(admin.fullName)}</span>
            <span class="role-chip">${esc(admin.roleLabel)}</span>
            <button type="button" class="btn btn-outline-primary btn-sm" id="logout-btn">Log out</button>
          </div>
        </div>
      </header>`;
    document.getElementById('logout-btn').addEventListener('click', logout);
  }

  /** Protects a page. Returns the admin, or null after redirecting to the login page. */
  async function requireAdmin(active, permission) {
    let admin = null;
    try {
      admin = (await Api.get('/api/admin/auth/me')).data.admin;
    } catch (err) {
      if (err.status !== 401) { UI.showAlert('danger', err.message); return null; }
    }
    if (!admin) { window.location.replace(`login.html?next=${encodeURIComponent(active)}`); return null; }
    renderNavbar(admin, active);
    if (permission && !can(admin, permission)) {
      const main = document.querySelector('main');
      if (main) main.innerHTML = '<div class="panel mt-3"><h1 class="page-title">Access denied</h1><p class="text-muted mb-3">Your role does not allow you to open this page.</p><a class="btn btn-primary" href="dashboard.html">Back to the dashboard</a></div>';
      return null;
    }
    return admin;
  }

  /** Shows an error; if the session ended, goes to the login page instead. Returns true when redirecting. */
  function handleError(err, areaFn) {
    if (err && err.status === 401) { window.location.replace('login.html?expired=1'); return true; }
    (areaFn || UI.showAlert)('danger', (err && err.message) || 'Something went wrong.');
    return false;
  }

  /** Renders "Showing 1-20 of 57" with Previous / Next into `container`. */
  function renderPager(container, data, onPage) {
    if (!data.total) { container.innerHTML = ''; return; }
    const from = (data.page - 1) * data.pageSize + 1;
    const to = Math.min(data.total, data.page * data.pageSize);
    container.innerHTML = `
      <div>Showing ${from}-${to} of ${data.total}</div>
      <div class="d-flex align-items-center gap-2">
        <button type="button" class="btn btn-outline-primary btn-sm" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${data.page} of ${data.totalPages}</span>
        <button type="button" class="btn btn-outline-primary btn-sm" data-page="${data.page + 1}" ${data.page >= data.totalPages ? 'disabled' : ''}>Next</button>
      </div>`;
    container.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => onPage(Number(b.dataset.page))));
  }

  const qs = (obj) => {
    const p = new URLSearchParams();
    Object.entries(obj).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) p.set(k, v); });
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  window.Admin = { SAFE_NEXT, REVIEW_LABELS, VERIF_LABELS, APPT_LABELS, can, reviewPill, verifPill, apptPill, tokenPill, slot, debounce, requireAdmin, handleError, renderPager, qs, logout };
})();
