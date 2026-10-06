/* Schedule / reschedule / change-status windows, shared by the student page and the appointments page.
 * Exposes window.ApptDialogs. Each opener takes an onDone(responseData) callback. */
(function () {
  const esc = UI.esc;
  const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  const field = (label, html, hint) =>
    `<div class="mb-3"><label class="form-label fw-semibold" for="${html.id}">${esc(label)}</label>${html.html}<div class="invalid-feedback"></div>${hint ? `<div class="form-text">${esc(hint)}</div>` : ''}</div>`;
  const input = (id, name, type, value, attrs) => ({ id, html: `<input class="form-control" id="${id}" name="${name}" type="${type}" value="${esc(value || '')}" ${attrs || ''}>` });
  const textarea = (id, name, value, attrs) => ({ id, html: `<textarea class="form-control" id="${id}" name="${name}" rows="2" ${attrs || ''}>${esc(value || '')}</textarea>` });

  function footer(m, saveLabel) {
    m.footer.innerHTML = `<button type="button" class="btn btn-outline-secondary" data-act="cancel">Cancel</button>
      <button type="submit" class="btn btn-primary" form="appt-form">${esc(saveLabel)}</button>`;
    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
  }

  /** Wires the form: sends the request, shows field errors, closes and calls onDone on success. */
  function wire(m, request, onDone) {
    const form = m.body.querySelector('form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);
      m.alertArea.innerHTML = '';
      const btn = m.footer.querySelector('[type=submit]');
      UI.setLoading(btn, true, 'Saving');
      m.setBusy(true);
      try {
        const res = await request(Object.fromEntries(new FormData(form).entries()));
        m.setBusy(false);
        m.close();
        onDone(res);
      } catch (err) {
        m.setBusy(false);
        UI.setLoading(btn, false);
        if (err.status === 401) { window.location.replace('login.html?expired=1'); return; }
        UI.setFieldErrors(form, err.errors);
        UI.showAlertIn(m.alertArea, 'danger', err.message);
      }
    });
  }

  function slotFields(a) {
    return `
      <div class="row g-3">
        <div class="col-sm-6">${field('Date', input('ap-date', 'date', 'date', a && a.date, `min="${todayLocal()}" required`))}</div>
        <div class="col-sm-6">${field('Time', input('ap-time', 'time', 'time', a && a.time, 'required'))}</div>
      </div>
      ${field('Venue', input('ap-venue', 'venue', 'text', a && a.venue, 'maxlength="150" required placeholder="e.g. Admission Cell, Main Building, Room 12"'))}
      ${field('Instructions for the student (optional)', textarea('ap-instr', 'instructions', a && a.instructions, 'maxlength="300" placeholder="e.g. Bring all originals and two photocopies of each document."'))}`;
  }

  /** Student picker used when scheduling from the appointments page. */
  function picker(m) {
    const box = m.body.querySelector('#picker');
    const hidden = m.body.querySelector('#ap-student');
    const results = m.body.querySelector('#picker-results');
    const search = m.body.querySelector('#ap-search');
    let n = 0;
    const run = Admin.debounce(async () => {
      const mine = ++n;
      const q = search.value.trim();
      try {
        const d = (await Api.get(`/api/admin/students${Admin.qs({ search: q, verification: 'awaiting', appointment: 'none', pageSize: 6 })}`)).data;
        if (mine !== n) return;
        results.innerHTML = d.items.length ? d.items.map((s) =>
          `<button type="button" class="search-hit" data-id="${s.id}" data-name="${esc(s.fullName)}"><span class="fw-semibold">${esc(s.fullName)}</span><span class="d-block small text-muted">${esc(s.applicationId)} &middot; ${esc(s.college)}</span></button>`).join('')
          : '<div class="small text-muted">No matching student needs an appointment.</div>';
      } catch (err) { results.innerHTML = `<div class="small text-danger">${esc(err.message)}</div>`; }
    }, 250);
    search.addEventListener('input', run);
    results.addEventListener('click', (e) => {
      const hit = e.target.closest('.search-hit');
      if (!hit) return;
      hidden.value = hit.dataset.id;
      results.querySelectorAll('.search-hit').forEach((b) => b.classList.toggle('selected', b === hit));
      m.body.querySelector('#picked').textContent = `Selected: ${hit.dataset.name}`;
    });
    run();
    return box;
  }

  function openSchedule({ student, onDone }) {
    const m = Modal.open({ title: 'Schedule verification appointment' });
    m.body.innerHTML = `<form id="appt-form" novalidate>
      ${student
    ? `<input type="hidden" name="studentId" value="${student.id}"><p class="mb-3">Student: <strong>${esc(student.name)}</strong></p>`
    : `<div class="mb-3" id="picker"><label class="form-label fw-semibold" for="ap-search">Student</label>
         <input class="form-control" id="ap-search" type="search" placeholder="Search name, email or application ID" autocomplete="off">
         <input type="hidden" name="studentId" id="ap-student"><div class="invalid-feedback"></div>
         <div id="picker-results" class="mt-2"></div><div id="picked" class="small fw-semibold mt-1"></div>
         <div class="form-text">Only students who are awaiting verification and have no appointment are listed.</div></div>`}
      ${slotFields(null)}
      <p class="small text-muted mb-0">The student will see this on their dashboard. Document checking itself happens in person.</p>
    </form>`;
    footer(m, 'Schedule');
    if (!student) picker(m);
    wire(m, (v) => Api.post('/api/admin/appointments', { ...v, studentId: Number(v.studentId) || null }), onDone);
    Modal.focusFirst(m);
  }

  function openReschedule({ appointment, studentName, onDone }) {
    const m = Modal.open({ title: 'Reschedule appointment' });
    m.body.innerHTML = `<form id="appt-form" novalidate>
      <p class="mb-3">${studentName ? `Student: <strong>${esc(studentName)}</strong><br>` : ''}Current: ${esc(Admin.slot(appointment.date, appointment.time))}, ${esc(appointment.venue)}</p>
      ${slotFields(appointment)}
      ${field('Reason for rescheduling', textarea('ap-reason', 'reason', '', 'maxlength="300" required'), 'The student will see this reason.')}
    </form>`;
    footer(m, 'Reschedule');
    wire(m, (v) => Api.put(`/api/admin/appointments/${appointment.id}`, v), onDone);
    Modal.focusFirst(m);
  }

  const STATUS_COPY = {
    completed: { title: 'Mark appointment completed', intro: 'The student came to the college for the appointment. Record the verification result separately.', button: 'Mark completed', noteLabel: 'Note (optional)' },
    missed: { title: 'Mark appointment missed', intro: 'The student did not attend. You can schedule a new appointment afterwards.', button: 'Mark missed', noteLabel: 'Note (optional)' },
    cancelled: { title: 'Cancel appointment', intro: 'The student will see that the appointment was cancelled, with your reason.', button: 'Cancel appointment', noteLabel: 'Reason for cancelling' },
  };

  function openStatus({ appointment, status, studentName, onDone }) {
    const c = STATUS_COPY[status];
    const m = Modal.open({ title: c.title });
    m.body.innerHTML = `<form id="appt-form" novalidate>
      <input type="hidden" name="status" value="${esc(status)}">
      <p class="mb-3">${studentName ? `<strong>${esc(studentName)}</strong><br>` : ''}${esc(Admin.slot(appointment.date, appointment.time))}, ${esc(appointment.venue)}</p>
      <p class="text-muted">${esc(c.intro)}</p>
      ${field(c.noteLabel, textarea('ap-note', 'note', '', `maxlength="300" ${status === 'cancelled' ? 'required' : ''}`))}
    </form>`;
    footer(m, c.button);
    if (status === 'cancelled') m.footer.querySelector('[type=submit]').className = 'btn btn-danger';
    wire(m, (v) => Api.patch(`/api/admin/appointments/${appointment.id}/status`, v), onDone);
    Modal.focusFirst(m);
  }

  window.ApptDialogs = { openSchedule, openReschedule, openStatus };
})();
