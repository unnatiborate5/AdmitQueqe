/* Admin dashboard: live counts, upcoming appointments, recent activity. */
(async function () {
  const esc = UI.esc;
  const loading = document.getElementById('loading');
  const root = document.getElementById('content');

  const admin = await Admin.requireAdmin('dashboard.html', 'dashboard:view');
  if (!admin) { loading.classList.add('d-none'); return; }

  function card(cls, num, label, sub, href) {
    return `<div class="col-6 col-lg-4 col-xl"><a class="stat-card ${cls}" href="${href}">
      <div class="num">${num}</div><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</a></div>`;
  }

  function renderAppointments(list) {
    if (!list.length) return '<p class="text-muted mb-0">No upcoming appointments.</p>';
    return `<ul class="review-history">${list.map((a) => `<li>
      <div class="fw-semibold">${esc(Admin.slot(a.date, a.time))}</div>
      <div><a href="student.html?id=${a.student.id}">${esc(a.student.name)}</a> <span class="text-muted">- ${esc(a.venue)}</span></div></li>`).join('')}</ul>`;
  }

  function renderActivity(list) {
    if (!list.length) return '<p class="text-muted mb-0">No activity yet.</p>';
    return `<ul class="review-history">${list.map((a) => `<li>
      <div>${esc(a.summary)}</div>
      <div class="text-muted">${esc(a.admin.name)} &middot; ${esc(UI.formatDate(a.createdAt))}</div></li>`).join('')}</ul>`;
  }

  function render(d) {
    const s = d.stats;
    root.innerHTML = `
      <div class="mb-4">
        <h1 class="page-title mb-1">Admissions overview</h1>
        <p class="text-muted mb-0">Live numbers from the same records students see. Click a card to see the students behind it.</p>
      </div>
      <div class="row g-3 mb-3">
        ${card('total', s.totalStudents, 'Total students', `${s.applications} with CAP details`, 'students.html')}
        ${card('pending', s.pending, 'Pending applications', 'Waiting for your review', 'students.html?status=pending')}
        ${card('approved', s.approved, 'Approved', '', 'students.html?status=approved')}
        ${card('rejected', s.rejected, 'Rejected', '', 'students.html?status=rejected')}
        ${card('verification', s.verificationPending, 'Verification pending', `${s.verificationUnscheduled} without an appointment`, 'students.html?verification=awaiting')}
      </div>
      <div class="row g-3 mb-4">
        <div class="col-sm-6"><a class="stat-card pending" href="students.html?status=correction_requested"><div class="d-flex justify-content-between align-items-center"><span class="lbl">Corrections requested</span><span class="num fs-3">${s.correctionRequested}</span></div></a></div>
        <div class="col-sm-6"><a class="stat-card" href="students.html?status=not_started"><div class="d-flex justify-content-between align-items-center"><span class="lbl">Registered, CAP details not entered</span><span class="num fs-3">${s.notStarted}</span></div></a></div>
      </div>
      ${d.queue ? `<a class="stat-card verification mb-4" href="queue.html"><div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
        <span class="lbl">Verification queue today</span>
        <span><strong>${d.queue.waiting}</strong> waiting &middot; <strong>${d.queue.called + d.queue.serving}</strong> at counters &middot; <strong>${d.queue.completed}</strong> served &middot; <strong>${d.queue.no_show}</strong> no-show</span></div></a>` : ''}
      <div class="row g-4">
        <div class="col-lg-6"><section class="panel h-100">
          <div class="d-flex justify-content-between align-items-baseline mb-2"><h2 class="panel-title mb-0">Upcoming appointments</h2><a class="small" href="appointments.html?status=scheduled">View all</a></div>
          ${renderAppointments(d.upcomingAppointments)}
        </section></div>
        ${d.recentActivity ? `<div class="col-lg-6"><section class="panel h-100">
          <div class="d-flex justify-content-between align-items-baseline mb-2"><h2 class="panel-title mb-0">Recent activity</h2><a class="small" href="activity.html">View all</a></div>
          ${renderActivity(d.recentActivity)}
        </section></div>` : ''}
      </div>
      <p class="manual-note mt-4 mb-0"><strong>Reminder:</strong> original documents are verified in person by college staff. AdmitFlow records appointments and outcomes only; it does not check document authenticity.</p>`;
  }

  try {
    render((await Api.get('/api/admin/dashboard')).data);
    root.classList.remove('d-none');
  } catch (err) {
    Admin.handleError(err);
  } finally {
    loading.classList.add('d-none');
  }
})();
