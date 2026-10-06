'use strict';
const asyncHandler = require('../../utils/asyncHandler');
const v = require('../../utils/adminValidators');
const ApiError = require('../../utils/ApiError');
const queueService = require('../../services/queueService');
const asObj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});
const note = (b) => {
  const n = typeof asObj(b).note === 'string' ? asObj(b).note.trim().replace(/\s+/g, ' ') : '';
  if (n.length > 200) throw new ApiError(400, 'Please correct the highlighted fields.', { note: 'Note can be at most 200 characters.' });
  return n || null;
};

const state = asyncHandler(async (req, res) => res.json({ success: true, data: await queueService.getState() }));
const eligible = asyncHandler(async (req, res) => res.json({ success: true, data: { students: queueService.listEligible(req.query.search) } }));
const lookup = asyncHandler(async (req, res) => res.json({ success: true, data: await queueService.lookup(req.query) }));

const checkIn = asyncHandler(async (req, res) => {
  const studentId = Number(asObj(req.body).studentId);
  if (!Number.isInteger(studentId) || studentId < 1) throw new ApiError(400, 'Please correct the highlighted fields.', { studentId: 'Choose a student.' });
  const token = await queueService.checkIn(req.admin, studentId);
  res.status(201).json({ success: true, message: `Token ${token.code} issued.`, data: { token } });
});

const callNext = asyncHandler(async (req, res) => {
  const token = await queueService.callNext(req.admin, v.parseId(req.params.id, 'Counter'));
  res.json({ success: true, message: `Token ${token.code} called to ${token.counter.name}.`, data: { token } });
});

const transition = (kind, message) => asyncHandler(async (req, res) => {
  const token = await queueService.transition(req.admin, v.parseId(req.params.id, 'Token'), kind, note(req.body));
  res.json({ success: true, message: message(token), data: { token } });
});

const setOpen = asyncHandler(async (req, res) => {
  const { isOpen } = asObj(req.body);
  if (typeof isOpen !== 'boolean') throw new ApiError(400, 'Please correct the highlighted fields.', { isOpen: 'Send true or false.' });
  const result = await queueService.setCounterOpen(req.admin, v.parseId(req.params.id, 'Counter'), isOpen);
  res.json({ success: true, message: `${result.counter.name} ${isOpen ? 'opened' : 'closed'}.`, data: result });
});

const addCounter = asyncHandler(async (req, res) => {
  const counter = await queueService.addCounter(req.admin, asObj(req.body).name);
  res.status(201).json({ success: true, message: `${counter.name} added.`, data: { counter } });
});

module.exports = {
  state, eligible, lookup, checkIn, callNext, setOpen, addCounter,
  start: transition('start', (t) => `${t.code} is being served.`),
  complete: transition('complete', (t) => `${t.code} completed.`),
  noShow: transition('no_show', (t) => `${t.code} marked as no-show.`),
  cancel: transition('cancel', (t) => `${t.code} cancelled.`),
};
