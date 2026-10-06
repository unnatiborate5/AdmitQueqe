/* Login page. */
(function () {
  const form = document.getElementById('login-form');
  const button = document.getElementById('login-btn');
  const params = new URLSearchParams(window.location.search);

  Auth.redirectIfLoggedIn();

  if (params.get('registered')) UI.showAlert('success', 'Account created successfully. Please log in.');
  else if (params.get('loggedout')) UI.showAlert('info', 'You have been logged out.');
  if (params.get('email')) form.elements.email.value = params.get('email');

  function nextPage() {
    const next = params.get('next');
    return Auth.SAFE_NEXT.includes(next) ? next : 'dashboard.html'; // whitelist avoids open redirects
  }

  function validate(data) {
    const errors = {};
    if (!data.email) errors.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) errors.email = 'Enter a valid email address.';
    if (!data.password) errors.password = 'Password is required.';
    return errors;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.clearAlert();
    UI.clearFieldErrors(form);

    const data = { email: form.elements.email.value.trim(), password: form.elements.password.value };
    const errors = validate(data);
    if (Object.keys(errors).length) {
      UI.setFieldErrors(form, errors);
      return;
    }

    UI.setLoading(button, true, 'Logging in');
    try {
      await Api.post('/api/auth/login', data);
      window.location.href = nextPage();
    } catch (err) {
      UI.setFieldErrors(form, err.errors);
      UI.showAlert('danger', err.message);
      UI.setLoading(button, false);
    }
  });
})();
