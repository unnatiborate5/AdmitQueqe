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
const tools = require('../controllers/admin/toolsController');
const cap = require('../controllers/admin/capController');
const progressQueue = require('../controllers/admin/progressQueueController');
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
router.post('/students/:id/tasks/:taskKey/review', requirePermission('applications:review'), portal.reviewTask);
router.get('/students/:id/tasks/:taskKey/uploads/:fileId', requirePermission('applications:review'), portal.downloadTaskFile);

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

// permanent admission progress queue (Phase 6)
router.get('/progress-queue', requirePermission('queue:view'), progressQueue.list);
router.get('/progress-queue/:id', requirePermission('queue:view'), progressQueue.getStudent);
router.get('/admission-progress-queue', requirePermission('queue:view'), progressQueue.list);

// CAP allotment verification (trusted records, claims, corrections, audit)
router.get('/cap/records', requirePermission('cap:view'), cap.list);
router.post('/cap/records/import', requirePermission('cap:manage'), cap.importCsv);
router.post('/cap/records', requirePermission('cap:manage'), cap.create);
router.get('/cap/records/:id', requirePermission('cap:view'), cap.getOne);
router.put('/cap/records/:id', requirePermission('cap:manage'), cap.update);
router.post('/cap/records/:id/verify', requirePermission('cap:verify'), cap.verify);
router.post('/cap/records/:id/revoke', requirePermission('cap:verify'), cap.revoke);
router.post('/cap/records/:id/unlink', requirePermission('cap:manage'), cap.unlink);
router.get('/cap/claims', requirePermission('cap:view'), cap.listClaims);
router.post('/cap/claims/:id/approve', requirePermission('cap:manage'), cap.approveClaim);
router.post('/cap/claims/:id/reject', requirePermission('cap:manage'), cap.rejectClaim);
router.get('/cap/round-deadlines', requirePermission('cap:view'), cap.listRoundDeadlines);
router.get('/cap/round-deadlines/:round', requirePermission('cap:view'), cap.getRoundDeadlines);
router.put('/cap/round-deadlines/:round', requirePermission('cap:manage'), cap.setRoundDeadlines);

// Phase 5: searching, sorting, matrices and undo (stack)
router.get('/search', requirePermission('students:view'), tools.search);
router.get('/planner/unscheduled', requirePermission('students:view'), tools.unscheduled);
router.get('/planner/arrivals', requirePermission('students:view'), tools.arrivals);
router.get('/planner/load', requirePermission('students:view'), tools.load);
router.get('/planner/documents', requirePermission('students:view'), tools.documents);
router.get('/undo', requirePermission('applications:review'), tools.undoList);
router.post('/undo', requirePermission('applications:review'), tools.undo);

router.get('/activity', requirePermission('activity:view'), portal.activity);

module.exports = router;
