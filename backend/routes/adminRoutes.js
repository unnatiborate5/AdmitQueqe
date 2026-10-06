'use strict';
/**
 * College admin API, mounted at /api/admin. Every route except login/logout requires an admin session
 * (requireAdmin) AND a role permission (requirePermission).
 */
const express = require('express');
const auth = require('../controllers/admin/authController');
const portal = require('../controllers/admin/portalController');
const appointments = require('../controllers/admin/appointmentController');
const queue = require('../controllers/admin/queueController');
const { requireAdmin, requirePermission, protectMutations } = require('../middleware/adminAuth');

const router = express.Router();
router.use(protectMutations);

// authentication
router.post('/auth/login', auth.login);
router.post('/auth/logout', auth.logout);
router.get('/auth/me', requireAdmin, auth.me);

// everything below needs a logged-in admin
router.use(requireAdmin);

router.get('/dashboard', requirePermission('dashboard:view'), portal.dashboard);

router.get('/students', requirePermission('students:view'), portal.listStudents);
router.get('/students/:id', requirePermission('students:view'), portal.studentDetail);
router.post('/students/:id/review', requirePermission('applications:review'), portal.reviewApplication);
router.post('/students/:id/notes', requirePermission('applications:review'), portal.addNote);
router.put('/students/:id/verification', requirePermission('verification:record'), portal.recordVerification);

router.get('/appointments', requirePermission('students:view'), appointments.list);
router.post('/appointments', requirePermission('appointments:manage'), appointments.schedule);
router.put('/appointments/:id', requirePermission('appointments:manage'), appointments.reschedule);
router.patch('/appointments/:id/status', requirePermission('appointments:manage'), appointments.updateStatus);

// queue & tokens (Phase 4)
router.get('/queue', requirePermission('queue:view'), queue.state);
router.get('/queue/eligible', requirePermission('queue:view'), queue.eligible);
router.get('/queue/lookup', requirePermission('queue:view'), queue.lookup);
router.post('/queue/check-in', requirePermission('queue:operate'), queue.checkIn);
router.post('/queue/counters', requirePermission('queue:configure'), queue.addCounter);
router.patch('/queue/counters/:id', requirePermission('queue:operate'), queue.setOpen);
router.post('/queue/counters/:id/call-next', requirePermission('queue:operate'), queue.callNext);
router.post('/queue/tokens/:id/start', requirePermission('queue:operate'), queue.start);
router.post('/queue/tokens/:id/complete', requirePermission('queue:operate'), queue.complete);
router.post('/queue/tokens/:id/no-show', requirePermission('queue:operate'), queue.noShow);
router.post('/queue/tokens/:id/cancel', requirePermission('queue:operate'), queue.cancel);

router.get('/activity', requirePermission('activity:view'), portal.activity);

module.exports = router;
