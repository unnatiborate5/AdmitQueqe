/* Appointment management: list by status, schedule, reschedule, complete / miss / cancel. */
(async function () {
  const esc = UI.esc;
  const admin = await Admin.requireAdmin('appointments.html', 'students:view');
  if (!admin) return;

  const $ = (id) => document.getElementById(id);
  const canManage = Admin.can(admin, 'appointments:manage');
  const TABS = [['scheduled', 'Scheduled'], ['completed', 'Completed'], ['missed', 'Missed'], ['cancelled', 'Cancelled'], ['', 'All']];
  const params = new URLSearchParams(window.location.search);
  const state = { status: TABS.some((t) => t[0] === params.get('status')) ? params.get('status') : 'scheduled', page: 1 };
  let items = [];
  let counts = {};
  let requestNo = 0;
  let serverToday = '';

  if (canManage) $('new-appt').classList.remove('d-none');

  function renderTabs() {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    $('tabs').innerHTML = TABS.map(([key, label]) =>
      `<button type="button" role="tab" aria-selected="${state.status === key}" class="${state.status === key ? 'active' : ''}" data-status="${key}">${label}<span class="count">${key ? (counts[key] || 0) : total}</span></button>`).join('');
  }

  function actions(a) {
    if (!canManage || a.status !== 'scheduled') return '';
    const future = a.date > serverToday;
    return `<div class="d-inline-flex flex-wrap gap-1 justify-content-end">
      <button class="btn btn-outline-primary btn-sm" data-act="reschedule" data-id="${a.id}">Reschedule</button>
      <button class="btn btn-outline-primary btn-sm" data-act="completed" data-id="${a.id}" ${future ? 'disabled title="Available on the appointment date"' : ''}>Completed</button>
      <button class="btn btn-outline-primary btn-sm" data-act="missed" data-id="${a.id}" ${future ? 'disabled title="Available on the appointment date"' : ''}>Missed</button>
      <button class="btn btn-outline-danger btn-sm" data-act="cancelled" data-id="${a.id}">Cancel</button></div>`;
  }

  function renderRows() {
    if (!items.length) { $('rows').innerHTML = '<tr><td colspan="5"><div class="empty-state">No appointments match these filters.</div></td></tr>'; return; }
    $('rows').innerHTML = items.map((a) => `<tr>
      <td class="text-nowrap"><div class="fw-semibold">${esc(UI.formatDay(a.date))}</div><div class="cell-sub">${esc(UI.formatClock(a.time))}</div></td>
      <td><a class="fw-semibold text-decoration-none" href="student.html?id=${a.student.id}">${esc(a.student.name)}</a><div class="cell-sub">${esc(a.student.applicationId || '')}</div></td>
      <td>${esc(a.venue)}${a.instructions ? `<div class="cell-sub">${esc(a.instructions)}</div>` : ''}</td>
      <td>${Admin.apptPill(a.status)}${a.rescheduleCount ? `<div class="cell-sub">Rescheduled ${a.rescheduleCount}x</div>` : ''}${a.note && a.status !== 'scheduled' ? `<div class="cell-sub">${esc(a.note)}</div>` : ''}</td>
      <td class="text-end">${actions(a)}</td></tr>`).join('');
  }

  async function load() {
    const mine = ++requestNo;
    const q = { status: state.status, search: $('f-search').value.trim(), when: $('f-when').value, date: $('f-date').value, page: state.page };
    try {
      const d = (await Api.get(`/api/admin/appointments${Admin.qs(q)}`)).data;
      if (mine !== requestNo) return;
      serverToday = d.today;
      items = d.items; counts = d.counts;
      UI.clearAlert();
      renderTabs(); renderRows();
      Admin.renderPager($('pager'), d, (p) => { state.page = p; load(); });
    } catch (err) {
      Admin.handleError(err);
      $('rows').innerHTML = '<tr><td colspan="5"><div class="empty-state">Could not load appointments.</div></td></tr>';
    }
  }

  const done = (message) => () => { UI.showAlert('success', message); load(); };

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b) { state.status = b.dataset.status; state.page = 1; load(); }
  });
  const reload = () => { state.page = 1; load(); };
  $('f-search').addEventListener('input', Admin.debounce(reload, 300));
  $('f-when').addEventListener('change', reload);
  $('f-date').addEventListener('change', reload);
  $('f-reset').addEventListener('click', () => { $('f-search').value = ''; $('f-when').value = ''; $('f-date').value = ''; reload(); });
  $('new-appt').addEventListener('click', () => ApptDialogs.openSchedule({ onDone: done('Appointment scheduled. The student can see it on their dashboard.') }));

  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const appointment = items.find((a) => a.id === Number(b.dataset.id));
    if (!appointment) return;
    const studentName = appointment.student.name;
    if (b.dataset.act === 'reschedule') ApptDialogs.openReschedule({ appointment, studentName, onDone: done('Appointment rescheduled. The student can see the new slot.') });
    else ApptDialogs.openStatus({ appointment, status: b.dataset.act, studentName, onDone: done(`Appointment marked ${b.dataset.act}.`) });
  });

  load();
})();
