'use strict';
const authService = require('../services/authService');
const asyncHandler = require('../utils/asyncHandler');
const { assertValid, validateRegistration, validateLogin } = require('../utils/validators');
const { getSessionToken, setSessionCookie, clearSessionCookie } = require('../middleware/auth');

const register = asyncHandler(async (req, res) => {
  const { errors, values } = validateRegistration(req.body);
  assertValid(errors);
  const student = await authService.register(values);
  res.status(201).json({
    success: true,
    message: 'Account created successfully. Please log in.',
    data: { student },
  });
});

const login = asyncHandler(async (req, res) => {
  const { errors, values } = validateLogin(req.body);
  assertValid(errors);
  const { token, student } = await authService.login(values);
  setSessionCookie(res, token);
  res.json({ success: true, message: 'Login successful.', data: { student } });
});

const logout = asyncHandler(async (req, res) => {
  authService.destroySession(getSessionToken(req));
  clearSessionCookie(res);
  res.json({ success: true, message: 'You have been logged out.' });
});

const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { student: req.student } });
});

module.exports = { register, login, logout, me };
