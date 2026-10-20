/* Shared admin-portal helpers: session guard, navbar, pills, pagination. Exposes window.Admin. */
(function () {
  const esc = UI.esc;
  const NAV = [
    ['dashboard.html', 'Dashboard', 'dashboard:view'],
    ['students.html', 'Students', 'students:view'],
    ['appointments.html', 'Appointments', 'students:view'],
    ['cap-records.html', 'CAP records', 'cap:view'],
    ['queue.html', 'Queue', 'queue:view'],
    ['planner.html', 'Planner', 'students:view'],
    ['activity.html', 'Activity', 'activity:view'],
  ];
  const SAFE_NEXT = ['dashboard.html', 'students.html', 'student.html', 'appointments.html', 'queue.html', 'planner.html', 'cap-records.html', 'activity.html'];

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
          ${can(admin, 'students:view') ? `<form class="admin-search" id="admin-search" role="search" autocomplete="off" aria-label="Search students, application IDs and tokens">
            <input type="search" class="form-control form-control-sm" id="admin-search-input" placeholder="Search name, application ID or token" maxlength="60" aria-controls="admin-search-results">
            <div class="search-dropdown d-none" id="admin-search-results" role="region" aria-live="polite"></div></form>` : ''}
          <div class="d-flex align-items-center gap-2 ms-auto">
            ${can(admin, 'applications:review') ? '<button type="button" class="btn btn-outline-secondary btn-sm d-none" id="undo-btn" title="Undo your most recent change">Undo</button>' : ''}
            <span class="small fw-semibold" id="nav-user">${esc(admin.fullName)}</span>
            <span class="role-chip">${esc(admin.roleLabel)}</span>
            <button type="button" class="btn btn-outline-primary btn-sm" id="logout-btn">Log out</button>
          </div>
        </div>
      </header>`;
    document.getElementById('logout-btn').addEventListener('click', logout);
    if (document.getElementById('admin-search')) initSearch();
    if (document.getElementById('undo-btn')) initUndo();
  }

  // ---------------- global search (binary search on application IDs / tokens, linear search on names, in the C++ engine) ----------------
  function initSearch() {
    const input = document.getElementById('admin-search-input');
    const box = document.getElementById('admin-search-results');
    const form = document.getElementById('admin-search');
    let n = 0;
    const hide = () => box.classList.add('d-none');
    const algoText = (list) => list.map((a) => `${a.field}: ${a.algorithm}, ${a.comparisons} ${a.algorithm === 'linear search' ? 'records checked' : 'steps'} of ${a.searched}`).join(' | ');

    const run = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { hide(); return; }
      const mine = ++n;
      try {
        const d = (await Api.get(`/api/admin/search${qs({ q })}`)).data;
        if (mine !== n) return;
        box.innerHTML = (d.results.length ? d.results.map((r) => `<a class="search-hit-row" href="student.html?id=${r.id}">
            <div class="d-flex justify-content-between gap-2"><span class="fw-semibold">${esc(r.name)}</span>${reviewPill(r.reviewStatus)}</div>
            <div class="small text-muted">${esc(r.applicationId || 'No application yet')}${r.token ? ` &middot; token <strong>${esc(r.token)}</strong>` : ''} &middot; matched by ${esc(r.matchedBy.join(', ').toLowerCase())}</div></a>`).join('')
          : '<div class="p-3 text-muted small">No student, application ID or token matches.</div>')
          + (d.truncated ? `<div class="search-meta">Showing the first ${d.results.length} of ${d.total}. Type more to narrow it down.</div>` : '')
          + `<div class="search-meta">${esc(algoText(d.algorithms))}</div>`;
        box.classList.remove('d-none');
      } catch (err) {
        if (err.status === 401) { window.location.replace('login.html?expired=1'); return; }
        box.innerHTML = `<div class="p-3 small text-danger">${esc(err.message)}</div>`;
        box.classList.remove('d-none');
      }
    }, 250);

    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hide(); input.blur(); } if (e.key === 'ArrowDown') { const a = box.querySelector('a'); if (a) { e.preventDefault(); a.focus(); } } });
    box.addEventListener('keydown', (e) => {
      const links = [...box.querySelectorAll('a')]; const i = links.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && i < links.length - 1) { e.preventDefault(); links[i + 1].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? links[i - 1] : input).focus(); }
      if (e.key === 'Escape') { hide(); input.focus(); }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); const a = box.querySelector('a'); if (a) window.location.href = a.getAttribute('href'); });
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) hide(); });
    input.addEventListener('focus', () => { if (box.innerHTML && input.value.trim().length >= 2) box.classList.remove('d-none'); });
  }

  // ---------------- undo (stack of the admin's recent reversible actions, in the C++ engine) ----------------
  let undoState = null;
  async function refreshUndo() {
    const btn = document.getElementById('undo-btn');
    if (!btn) return;
    try {
      undoState = (await Api.get('/api/admin/undo')).data;
      btn.classList.toggle('d-none', undoState.size === 0);
      btn.textContent = `Undo (${undoState.size})`;
      btn.title = undoState.next ? `Undo: ${undoState.next.summary}` : 'Nothing to undo';
    } catch (err) { /* the undo button is optional; ignore */ }
  }

  function initUndo() {
    const btn = document.getElementById('undo-btn');
    btn.addEventListener('click', async () => {
      await refreshUndo();
      if (!undoState || !undoState.size) { UI.showAlert('info', 'There is nothing to undo.'); return; }
      const m = Modal.open({ title: 'Undo recent changes' });
      m.body.innerHTML = `<p class="small text-muted">Your most recent changes, newest first. Undo always reverses the newest one first. If the application or appointment was changed again afterwards, the undo is refused so newer work is never overwritten.</p>
        <ol class="review-history ps-3">${undoState.items.map((i, k) => `<li${k === 0 ? ' class="fw-semibold"' : ''}>${esc(i.summary)}<div class="small text-muted fw-normal">${esc(i.studentName)} &middot; ${esc(UI.formatDate(i.createdAt))}</div></li>`).join('')}</ol>`;
      m.footer.innerHTML = '<button type="button" class="btn btn-outline-secondary" data-x="cancel">Close</button><button type="button" class="btn btn-primary" data-x="undo">Undo the newest change</button>';
      m.footer.querySelector('[data-x=cancel]').addEventListener('click', () => m.close());
      m.footer.querySelector('[data-x=undo]').addEventListener('click', async () => {
        const go = m.footer.querySelector('[data-x=undo]');
        go.disabled = true;
        try {
          const res = await Api.post('/api/admin/undo', {});
          m.close();
          UI.showAlert('success', res.message);
          await refreshUndo();
          document.dispatchEvent(new CustomEvent('admin:undone'));
          setTimeout(() => window.location.reload(), 900);
        } catch (err) {
          go.disabled = false;
          UI.showAlertIn(m.alertArea, 'danger', err.message);
          await refreshUndo();
          if (err.status === 401) window.location.replace('login.html?expired=1');
        }
      });
    });
    refreshUndo();
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

  window.Admin = { SAFE_NEXT, REVIEW_LABELS, VERIF_LABELS, APPT_LABELS, can, reviewPill, verifPill, apptPill, tokenPill, slot, debounce, requireAdmin, handleError, renderPager, qs, logout, refreshUndo };
})();
