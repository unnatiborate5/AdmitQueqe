/* Admin activity history (super admin only): every administrative action with who, what and when. */
(async function () {
  const esc = UI.esc;
  const loading = document.getElementById('loading');
  const root = document.getElementById('content');
  const admin = await Admin.requireAdmin('activity.html', 'activity:view');
  if (!admin) { loading.classList.add('d-none'); return; }

  const GROUP_LABELS = { auth: 'Log in / out', application: 'Applications', appointment: 'Appointments', verification: 'Verification', queue: 'Queue and tokens' };
  const state = { page: 1, adminId: '', group: '', search: '' };
  let built = false;
  let requestNo = 0;

  function detailText(a) {
    const d = a.details;
    if (!d) return '';
    const bits = [];
    if (d.from && d.to && typeof d.from === 'string') bits.push(`${d.from.replace(/_/g, ' ')} \u2192 ${d.to.replace(/_/g, ' ')}`);
    if (d.from && d.to && typeof d.from === 'object') bits.push(`${UI.formatDay(d.from.date)} ${d.from.time} \u2192 ${UI.formatDay(d.to.date)} ${d.to.time}, ${d.to.venue}`);
    if (d.remarks) bits.push(`Remarks: ${d.remarks}`);
    if (d.reason) bits.push(`Reason: ${d.reason}`);
    if (d.note) bits.push(`Note: ${d.note}`);
    if (d.automatic) bits.push('Closed automatically');
    return bits.join(' | ');
  }

  function build(d) {
    root.innerHTML = `
      <div class="mb-3"><h1 class="page-title mb-1">Activity history</h1>
        <p class="text-muted mb-0">A record of administrative actions: who did what, to which student, and when.</p></div>
      <section class="panel mb-3"><div class="filter-bar">
        <div class="search"><label class="form-label small fw-semibold mb-1" for="a-search">Search</label>
          <input class="form-control" type="search" id="a-search" placeholder="Admin, student or action text" maxlength="100"></div>
        <div><label class="form-label small fw-semibold mb-1" for="a-admin">Admin</label>
          <select class="form-select" id="a-admin"><option value="">Everyone</option>${d.admins.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
        <div><label class="form-label small fw-semibold mb-1" for="a-group">Type</label>
          <select class="form-select" id="a-group"><option value="">All actions</option>${d.groups.map((g) => `<option value="${g}">${esc(GROUP_LABELS[g] || g)}</option>`).join('')}</select></div>
      </div></section>
      <section class="panel table-panel" aria-live="polite">
        <div class="table-responsive"><table class="table admin-table align-middle">
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Student</th></tr></thead><tbody id="rows"></tbody></table></div>
        <div class="pager" id="pager"></div></section>`;
    const reload = () => { state.page = 1; load(); };
    document.getElementById('a-search').addEventListener('input', Admin.debounce((e) => { state.search = e.target.value; reload(); }, 300));
    document.getElementById('a-admin').addEventListener('change', (e) => { state.adminId = e.target.value; reload(); });
    document.getElementById('a-group').addEventListener('change', (e) => { state.group = e.target.value; reload(); });
    built = true;
  }

  function renderRows(d) {
    const rows = document.getElementById('rows');
    if (!d.items.length) { rows.innerHTML = '<tr><td colspan="4"><div class="empty-state">No activity matches these filters.</div></td></tr>'; return; }
    rows.innerHTML = d.items.map((a) => `<tr>
      <td class="text-nowrap small">${esc(UI.formatDate(a.createdAt))}</td>
      <td><div class="fw-semibold">${esc(a.admin.name)}</div><div class="cell-sub">${esc(a.admin.role.replace(/_/g, ' '))}</div></td>
      <td><div>${esc(a.summary)}</div>${detailText(a) ? `<div class="activity-detail">${esc(detailText(a))}</div>` : ''}</td>
      <td>${a.student ? `<a href="student.html?id=${a.student.id}">${esc(a.student.name)}</a>` : '<span class="text-muted">-</span>'}</td></tr>`).join('');
  }

  async function load() {
    const mine = ++requestNo;
    try {
      const d = (await Api.get(`/api/admin/activity${Admin.qs({ page: state.page, adminId: state.adminId, group: state.group, search: state.search })}`)).data;
      if (mine !== requestNo) return;
      if (!built) build(d);
      renderRows(d);
      Admin.renderPager(document.getElementById('pager'), d, (p) => { state.page = p; load(); });
      root.classList.remove('d-none');
    } catch (err) { Admin.handleError(err); } finally { loading.classList.add('d-none'); }
  }
  load();
})();
