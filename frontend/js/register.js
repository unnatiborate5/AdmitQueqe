/* Registration page: CAP-based registration. */
(function () {
  const form = document.getElementById('register-form');
  const button = document.getElementById('register-btn');

  Auth.redirectIfLoggedIn();

  function validate(d) {
    const e = {};
    if (!d.applicationId) e.applicationId = 'CAP Application ID is required.';
    else if (!/^[A-Za-z0-9][A-Za-z0-9-]{4,19}$/.test(d.applicationId)) {
      e.applicationId = 'Application ID must be 5-20 characters (letters, numbers, hyphen).';
    }

    if (!d.password) e.password = 'CAP password is required.';
    return e;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.clearAlert();
    UI.clearFieldErrors(form);

    const f = form.elements;
    const data = {
      applicationId: f.applicationId.value.trim(),
      password: f.password.value,
    };
    const errors = validate(data);
    if (Object.keys(errors).length) {
      UI.setFieldErrors(form, errors);
      UI.showAlert('danger', 'Please correct the highlighted fields.');
      return;
    }

    UI.setLoading(button, true, 'Creating account');
    try {
      const res = await Api.post('/api/auth/register', data);
      const appId = encodeURIComponent(res.data.student.applicationId || data.applicationId);
      window.location.href = `login.html?registered=1&appId=${appId}`;
    } catch (err) {
      UI.setFieldErrors(form, err.errors);
      UI.showAlert('danger', err.message);
      UI.setLoading(button, false);
    }
  });
})();
