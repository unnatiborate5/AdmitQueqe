/* Registration page. */
(function () {
  const form = document.getElementById('register-form');
  const button = document.getElementById('register-btn');

  Auth.redirectIfLoggedIn();

  function validate(d) {
    const e = {};
    if (!d.fullName) e.fullName = 'Full name is required.';
    else if (!/^\p{L}[\p{L} .'-]{1,99}$/u.test(d.fullName)) e.fullName = "Enter a valid name (2-100 letters; spaces, . ' - allowed).";

    if (!d.email) e.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) e.email = 'Enter a valid email address.';

    const phone = d.phone.replace(/[\s()-]/g, '').replace(/^\+91/, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
    if (!d.phone) e.phone = 'Mobile number is required.';
    else if (!/^[6-9]\d{9}$/.test(phone)) e.phone = 'Enter a valid 10-digit Indian mobile number.';

    if (!d.password) e.password = 'Password is required.';
    else if (d.password.length < 8) e.password = 'Password must be at least 8 characters.';
    else if (!/[A-Za-z]/.test(d.password) || !/\d/.test(d.password)) e.password = 'Password must contain at least one letter and one number.';

    if (!d.confirmPassword) e.confirmPassword = 'Please confirm your password.';
    else if (d.confirmPassword !== d.password) e.confirmPassword = 'Passwords do not match.';
    return e;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.clearAlert();
    UI.clearFieldErrors(form);

    const f = form.elements;
    const data = {
      fullName: f.fullName.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim(),
      password: f.password.value,
      confirmPassword: f.confirmPassword.value,
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
      const email = encodeURIComponent(res.data.student.email);
      window.location.href = `login.html?registered=1&email=${email}`;
    } catch (err) {
      UI.setFieldErrors(form, err.errors);
      UI.showAlert('danger', err.message);
      UI.setLoading(button, false);
    }
  });
})();
