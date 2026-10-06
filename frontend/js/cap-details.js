/* CAP details form. */
(async function () {
  const form = document.getElementById('cap-form');
  const button = document.getElementById('cap-btn');
  const FIELDS = ['applicationId', 'studentName', 'allottedCollege', 'courseBranch', 'capRound', 'allotmentStatus'];
  const LABELS = {
    applicationId: 'Application ID is required.',
    studentName: 'Student name is required.',
    allottedCollege: 'Allotted college is required.',
    courseBranch: 'Course / branch is required.',
    capRound: 'CAP round is required.',
    allotmentStatus: 'Allotment status is required.',
  };

  const student = await Auth.requireLogin('cap-details.html');
  if (!student) return;

  function fillSelect(select, values) {
    values.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
  }

  try {
    const res = await Api.get('/api/cap-details');
    const { capDetails, options } = res.data;
    fillSelect(form.elements.capRound, options.capRounds);
    fillSelect(form.elements.allotmentStatus, options.allotmentStatuses);

    if (capDetails) {
      FIELDS.forEach((name) => { form.elements[name].value = capDetails[name]; });
      document.getElementById('cap-updated').textContent = `Last saved ${UI.formatDate(capDetails.updatedAt)}.`;
    } else {
      form.elements.studentName.value = student.fullName; // sensible default, editable
    }
  } catch (err) {
    UI.showAlert('danger', err.message);
    button.disabled = true;
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.clearAlert();
    UI.clearFieldErrors(form);

    const data = {};
    FIELDS.forEach((name) => { data[name] = form.elements[name].value.trim(); });

    const errors = {};
    FIELDS.forEach((name) => { if (!data[name]) errors[name] = LABELS[name]; });
    if (data.applicationId && !/^[A-Za-z0-9][A-Za-z0-9-]{4,19}$/.test(data.applicationId)) {
      errors.applicationId = 'Application ID must be 5-20 characters (letters, numbers, hyphen).';
    }
    if (Object.keys(errors).length) {
      UI.setFieldErrors(form, errors);
      UI.showAlert('danger', 'Please correct the highlighted fields.');
      return;
    }

    UI.setLoading(button, true, 'Saving');
    try {
      const res = await Api.put('/api/cap-details', data);
      UI.showAlert('success', `${res.message} Taking you to your dashboard.`);
      setTimeout(() => { window.location.href = 'dashboard.html'; }, 1200);
    } catch (err) {
      if (err.status === 401) { window.location.replace('login.html?next=cap-details.html'); return; }
      UI.setFieldErrors(form, err.errors);
      UI.showAlert('danger', err.message);
      UI.setLoading(button, false);
    }
  });
})();
