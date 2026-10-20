/* Admin planner: sorted worklists (merge sort), appointment load (sparse matrix), document readiness (dense matrix).
 * All computation is done by the C++ engine; this page only draws the results. */
(async function () {
  const esc = UI.esc;
  const admin = await Admin.requireAdmin('planner.html', 'students:view');
  if (!admin) return;
  const $ = (id) => document.getElementById(id);
  const canSchedule = Admin.can(admin, 'appointments:manage');
  const levelTag = (level, reason) => (level < 3 ? `<span class="priority-tag" title="${esc(reason)}">Priority ${level}</span> <span class="small text-muted">${esc(reason)}</span>` : '<span class="small text-muted">Regular</span>');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const algo = (a) => `Sorted with ${esc(a.name)}: ${plural(a.comparisons, 'comparison')} for ${plural(a.items, 'student')}.`;
  const fail = (err, rows, cols) => { if (!Admin.handleError(err) && rows) rows.innerHTML = `<tr><td colspan="${cols}"><div class="empty-state">Could not load this section.</div></td></tr>`; };

  // ---------------- 1. unscheduled (merge sort: priority, waiting time, name) ----------------
  async function loadUnscheduled() {
    try {
      const d = (await Api.get('/api/admin/planner/unscheduled')).data;
      $('unsched-count').textContent = `${d.items.length} student${d.items.length === 1 ? '' : 's'}`;
      $('unsched-rows').innerHTML = d.items.length ? d.items.map((s) => `<tr>
        <td><span class="pos-badge ${s.rank === 1 ? 'next' : ''}">${s.rank}</span></td>
        <td><a class="fw-semibold text-decoration-none" href="student.html?id=${s.id}">${esc(s.name)}</a><div class="cell-sub">${esc(s.applicationId)} &middot; ${esc(s.capRound)}</div></td>
        <td>${levelTag(s.level, s.priorityReason)}</td><td class="small">${esc(UI.formatDate(s.waitingSince))}</td>
        <td class="text-end">${canSchedule ? `<button class="btn btn-outline-primary btn-sm" data-schedule="${s.id}" data-name="${esc(s.name)}">Schedule</button>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="5"><div class="empty-state">Everyone who needs an appointment has one.</div></td></tr>';
      $('unsched-algo').textContent = `Order: ${d.sortedBy}. ${algo(d.algorithm)}`;
    } catch (err) { fail(err, $('unsched-rows'), 5); }
  }

  // ---------------- 2. today's arrivals (merge sort: time / priority / token) ----------------
  async function loadArrivals() {
    try {
      const d = (await Api.get(`/api/admin/planner/arrivals?sort=${$('arr-sort').value}`)).data;
      $('h-arr').textContent = `2. Today's appointments (${UI.formatDay(d.date)})`;
      $('arr-rows').innerHTML = d.items.length ? d.items.map((a) => `<tr>
        <td><span class="pos-badge">${a.position}</span></td><td class="text-nowrap fw-semibold">${esc(UI.formatClock(a.appointmentTime))}</td>
        <td><a class="fw-semibold text-decoration-none" href="student.html?id=${a.id}">${esc(a.name)}</a><div class="cell-sub">${esc(a.applicationId)}</div></td>
        <td>${levelTag(a.level, a.priorityReason)}</td>
        <td>${a.token ? `<span class="code-chip">${esc(a.token)}</span> ${Admin.tokenPill(a.tokenStatus)}` : '<span class="text-muted small">Not checked in</span>'}</td>
        <td>${Admin.apptPill(a.appointmentStatus)}</td></tr>`).join('')
        : '<tr><td colspan="6"><div class="empty-state">No appointments today.</div></td></tr>';
      $('arr-algo').textContent = `Order: ${d.sortedBy}. ${algo(d.algorithm)}`;
    } catch (err) { fail(err, $('arr-rows'), 6); }
  }

  // ---------------- 3. appointment load (sparse matrix) ----------------
  const heatClass = (n) => (n === 0 ? 'l0' : n === 1 ? 'l1' : n === 2 ? 'l2' : 'l3');
  async function loadLoad() {
    try {
      const d = (await Api.get(`/api/admin/planner/load?days=${$('load-days').value}`)).data;
      const slots = [];
      for (let m = 9 * 60; m < 17 * 60; m += d.slotMinutes) slots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
      const count = new Map(d.cells.map((c) => [`${c.date}|${c.time}`, c.count]));
      const best = new Map(d.suggestions.map((s) => [s.date, s.time]));
      const outside = d.cells.filter((c) => !slots.includes(c.time));
      $('load-table').innerHTML = `<thead><tr><th>Day</th>${slots.map((t) => `<th class="heat">${esc(t.endsWith(':00') ? t.slice(0, 2) : t.slice(3))}</th>`).join('')}<th>Total</th><th>Least busy</th></tr></thead><tbody>
        ${d.dayTotals.map((day) => `<tr><td class="text-nowrap small fw-semibold">${esc(UI.formatDay(day.date))}</td>
          ${slots.map((t) => { const n = count.get(`${day.date}|${t}`) || 0; return `<td class="heat ${heatClass(n)} ${best.get(day.date) === t ? 'best' : ''}" title="${esc(`${t}: ${n} booked`)}">${n || 0}</td>`; }).join('')}
          <td class="fw-bold">${day.count}</td><td class="small text-nowrap">${esc(best.get(day.date))}</td></tr>`).join('')}</tbody>`;
      const top = d.busiest.length ? d.busiest.map((b) => `${UI.formatDay(b.date)} ${UI.formatClock(b.time)} (${b.count})`).join(', ') : 'none';
      $('load-summary').innerHTML = `<p class="mb-1"><strong>${d.bookings}</strong> scheduled appointment${d.bookings === 1 ? '' : 's'} in the next ${d.days} days. Busiest slots: ${esc(top)}.</p>
        <p class="small text-muted mb-2">Columns are half-hour slots from ${esc(d.officeHours.from)} to ${esc(d.officeHours.to)} (hour or minutes past the hour). Outlined cells are the least busy slot of each day. ${outside.length ? `Outside office hours: ${esc(outside.map((c) => `${UI.formatDay(c.date)} ${c.time} (${c.count})`).join(', '))}.` : ''}</p>`;
      const m = d.matrix;
      $('load-algo').textContent = `Sparse matrix (${m.rows} days x ${m.cols} slots = ${m.totalCells} cells): only the ${m.storedCells} booked cell${m.storedCells === 1 ? '' : 's'} are stored (${(m.density * 100).toFixed(1)}% filled). Finding a cell is a binary search (${plural(m.lookupComparisons, 'step')} for this report).`;
    } catch (err) { Admin.handleError(err); }
  }

  // ---------------- 4. document readiness (dense matrix) ----------------
  async function loadDocs() {
    try {
      const d = (await Api.get('/api/admin/planner/documents')).data;
      $('docs-table').innerHTML = `<thead><tr><th>Document</th>${d.rounds.map((r) => `<th>${esc(r.name)}<div class="cell-sub fw-normal text-transform-none">${r.students} student${r.students === 1 ? '' : 's'}</div></th>`).join('')}<th>Total ready</th></tr></thead><tbody>
        ${d.documents.map((doc) => `<tr><td class="fw-semibold">${esc(doc.title)}${doc.required ? '' : ' <span class="text-muted small fw-normal">(if applicable)</span>'}</td>
          ${doc.ready.map((n, k) => `<td class="ready-cell">${n} <span class="text-muted small">(${doc.percent[k].toFixed(0)}%)</span><div class="ready-bar" aria-hidden="true"><span style="width:${Math.min(100, doc.percent[k])}%"></span></div></td>`).join('')}
          <td class="fw-bold">${doc.totalReady}</td></tr>`).join('')}</tbody>`;
      const weak = d.weakest.filter((w) => w.document).map((w) => `${esc(w.round)}: ${esc(w.document)} (${w.percent.toFixed(0)}%)`);
      $('docs-summary').innerHTML = `<p class="mb-2"><strong>Weakest document per round:</strong> ${weak.length ? weak.join('; ') : 'no students have entered CAP details yet'}.</p>`;
      $('docs-algo').textContent = `Dense matrix (${d.matrix.rows} documents x ${d.matrix.cols} rounds): every cell holds a real count, so the grid is stored as one contiguous array. Percentages are relative to the number of students in each round.`;
    } catch (err) { Admin.handleError(err); }
  }

  $('arr-sort').addEventListener('change', loadArrivals);
  $('load-days').addEventListener('change', loadLoad);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-schedule]');
    if (!b) return;
    ApptDialogs.openSchedule({ student: { id: Number(b.dataset.schedule), name: b.dataset.name }, onDone: () => { UI.showAlert('success', 'Appointment scheduled. The student can see it on their dashboard.'); loadUnscheduled(); loadArrivals(); loadLoad(); } });
  });
  loadUnscheduled(); loadArrivals(); loadLoad(); loadDocs();
})();
