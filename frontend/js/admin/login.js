/* Admin login page. */
(function () {
  const form = document.getElementById('login-form');
  const button = document.getElementById('login-btn');
  const params = new URLSearchParams(window.location.search);

  Api.get('/api/admin/auth/me').then(() => window.location.replace('dashboard.html')).catch(() => { /* not logged in */ });

  if (params.get('loggedout')) UI.showAlert('info', 'You have been logged out.');
  else if (params.get('expired')) UI.showAlert('warning', 'Your session ended. Please log in again.');

  const nextPage = () => {
    const next = params.get('next');
    return Admin.SAFE_NEXT.includes(next) ? next : 'dashboard.html'; // whitelist avoids open redirects
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.clearAlert();
    UI.clearFieldErrors(form);
    const data = { email: form.elements.email.value.trim(), password: form.elements.password.value };
    const errors = {};
    if (!data.email) errors.email = 'Email is required.';
    if (!data.password) errors.password = 'Password is required.';
    if (Object.keys(errors).length) { UI.setFieldErrors(form, errors); return; }

    UI.setLoading(button, true, 'Logging in');
    try {
      await Api.post('/api/admin/auth/login', data);
      window.location.href = nextPage();
    } catch (err) {
      UI.setFieldErrors(form, err.errors);
      UI.showAlert('danger', err.message);
      UI.setLoading(button, false);
    }
  });
})();
