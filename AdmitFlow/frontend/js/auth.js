/* Session helpers: login guard, navbar, logout. Exposes window.Auth. */
(function () {
  const NAV_PAGES = [
    ['dashboard.html', 'Dashboard'],
    ['cap-details.html', 'CAP Details'],
    ['checklist.html', 'Checklist'],
  ];
  const SAFE_NEXT = NAV_PAGES.map((p) => p[0]);

  /** Returns the logged-in student, or null when not logged in. Throws on network errors. */
  async function getCurrentStudent() {
    try {
      const res = await Api.get('/api/auth/me');
      return res.data.student;
    } catch (err) {
      if (err.status === 401) return null;
      throw err;
    }
  }

  async function logout() {
    try { await Api.post('/api/auth/logout'); } catch (_) { /* leave the page regardless */ }
    window.location.href = 'login.html?loggedout=1';
  }

  function renderNavbar(student, activePage) {
    const host = document.getElementById('app-navbar');
    if (!host) return;
    const links = NAV_PAGES.map(([href, label]) =>
      `<li class="nav-item"><a class="nav-link ${href === activePage ? 'active' : ''}" href="${href}"${href === activePage ? ' aria-current="page"' : ''}>${label}</a></li>`
    ).join('');
    host.innerHTML = `
      <header class="app-nav">
        <div class="container d-flex flex-wrap align-items-center gap-2 gap-md-3">
          <a class="brand" href="dashboard.html">Admit<span class="brand-mark">Flow</span></a>
          <ul class="nav flex-wrap me-md-auto">${links}</ul>
          <div class="d-flex align-items-center gap-3 ms-auto">
            <span class="text-muted small" id="nav-user">${UI.esc(student.fullName)}</span>
            <button type="button" class="btn btn-outline-primary btn-sm" id="logout-btn">Log out</button>
          </div>
        </div>
      </header>`;
    document.getElementById('logout-btn').addEventListener('click', logout);
  }

  /** Protects a page. Returns the student, or null after redirecting to login. */
  async function requireLogin(activePage) {
    let student;
    try {
      student = await getCurrentStudent();
    } catch (err) {
      UI.showAlert('danger', err.message);
      return null;
    }
    if (!student) {
      window.location.replace('login.html?next=' + encodeURIComponent(activePage));
      return null;
    }
    renderNavbar(student, activePage);
    return student;
  }

  async function redirectIfLoggedIn() {
    try {
      if (await getCurrentStudent()) window.location.replace('dashboard.html');
    } catch (_) { /* server unreachable: stay on the page */ }
  }

  window.Auth = { SAFE_NEXT, getCurrentStudent, requireLogin, redirectIfLoggedIn, logout };
})();
