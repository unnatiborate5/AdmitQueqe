/* Admin student list: search, filters, sorting, pagination. Filters live in the URL so views can be bookmarked. */
(async function () {
  const esc = UI.esc;
  const admin = await Admin.requireAdmin('students.html', 'students:view');
  if (!admin) return;

  const $ = (id) => document.getElementById(id);
  const rows = $('rows');
  const FIELDS = { search: 'f-search', status: 'f-status', verification: 'f-verification', appointment: 'f-appointment', round: 'f-round', sort: 'f-sort' };
  let page = 1;
  let requestNo = 0;

  const params = new URLSearchParams(window.location.search);
  page = Math.max(1, parseInt(params.get('page'), 10) || 1);

  function readFilters() {
    const f = {};
    Object.entries(FIELDS).forEach(([k, id]) => { f[k] = $(id).value; });
    return f;
  }

  function progressCell(p) {
    if (!p) return '<span class="text-muted">-</span>';
    return `<span class="mini-progress" aria-hidden="true"><span style="width:${p.percent}%"></span></span><span class="small">${p.completed}/${p.total}</span>`;
  }

  function renderRows(d) {
    if (!d.items.length) {
      rows.innerHTML = '<tr><td colspan="6"><div class="empty-state">No students match these filters.</div></td></tr>';
      return;
    }
    rows.innerHTML = d.items.map((s) => `
      <tr class="row-link" data-id="${s.id}" tabindex="0">
        <td><a class="fw-semibold text-decoration-none" href="student.html?id=${s.id}">${esc(s.fullName)}</a>
            <div class="cell-sub">${esc(s.email)} &middot; ${esc(s.phone)}</div></td>
        <td>${s.applicationId ? `<div class="fw-semibold">${esc(s.applicationId)}</div><div class="cell-sub">${esc(s.college)}, ${esc(s.branch)} &middot; ${esc(s.capRound)}</div>` : '<span class="text-muted">No CAP details</span>'}</td>
        <td>${Admin.reviewPill(s.reviewStatus)}</td>
        <td>${s.verificationStatus ? Admin.verifPill(s.verificationStatus) : '<span class="text-muted">-</span>'}</td>
        <td>${s.appointment ? `<div class="small fw-semibold">${esc(UI.formatDay(s.appointment.date))}</div><div class="cell-sub">${esc(UI.formatClock(s.appointment.time))}</div>` : '<span class="text-muted">-</span>'}</td>
        <td>${progressCell(s.progress)}</td>
      </tr>`).join('');
  }

  async function load() {
    const f = readFilters();
    const mine = ++requestNo;
    history.replaceState(null, '', `students.html${Admin.qs({ ...f, sort: f.sort === 'recent' ? '' : f.sort, page: page > 1 ? page : '' })}`);
    try {
      const d = (await Api.get(`/api/admin/students${Admin.qs({ ...f, page })}`)).data;
      if (mine !== requestNo) return; // a newer search is already running
      if (page > d.totalPages) { page = d.totalPages; load(); return; }
      UI.clearAlert();
      renderRows(d);
      Admin.renderPager($('pager'), d, (p) => { page = p; load(); window.scrollTo({ top: 0 }); });
    } catch (err) {
      Admin.handleError(err);
      rows.innerHTML = '<tr><td colspan="6"><div class="empty-state">Could not load students.</div></td></tr>';
    }
  }

  // restore filters from the URL
  Object.entries(FIELDS).forEach(([k, id]) => { if (params.get(k)) $(id).value = params.get(k); });
  const reload = () => { page = 1; load(); };
  $('f-search').addEventListener('input', Admin.debounce(reload, 300));
  ['f-status', 'f-verification', 'f-appointment', 'f-round', 'f-sort'].forEach((id) => $(id).addEventListener('change', reload));
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  $('f-reset').addEventListener('click', () => { Object.values(FIELDS).forEach((id) => { $(id).value = id === 'f-sort' ? 'recent' : ''; }); reload(); });

  const open = (tr) => { if (tr) window.location.href = `student.html?id=${tr.dataset.id}`; };
  rows.addEventListener('click', (e) => { if (!e.target.closest('a')) open(e.target.closest('tr[data-id]')); });
  rows.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e.target.closest('tr[data-id]')); });

  load();
})();
