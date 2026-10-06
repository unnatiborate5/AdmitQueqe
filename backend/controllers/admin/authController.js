'use strict';
const adminAuthService = require('../../services/adminAuthService');
const activityService = require('../../services/activityService');
const asyncHandler = require('../../utils/asyncHandler');
const { assertValid, validateLogin } = require('../../utils/validators');
const { getAdminToken, setAdminCookie, clearAdminCookie } = require('../../middleware/adminAuth');

const login = asyncHandler(async (req, res) => {
  const { errors, values } = validateLogin(req.body);
  assertValid(errors);
  const { token, admin } = await adminAuthService.login(values, req.ip);
  activityService.log(admin, { action: 'auth.login', summary: `${admin.fullName} logged in`, details: { ip: req.ip } });
  setAdminCookie(res, token);
  res.json({ success: true, message: 'Login successful.', data: { admin } });
});

const logout = asyncHandler(async (req, res) => {
  const token = getAdminToken(req);
  const admin = adminAuthService.getAdminBySession(token);
  if (admin) activityService.log(admin, { action: 'auth.logout', summary: `${admin.fullName} logged out` });
  adminAuthService.destroySession(token);
  clearAdminCookie(res);
  res.json({ success: true, message: 'You have been logged out.' });
});

const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { admin: req.admin } });
});

module.exports = { login, logout, me };
