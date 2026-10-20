'use strict';
// Phase 5 admin endpoints: global search, planner (sorted worklists, appointment load, document readiness) and undo.
const asyncHandler = require('../../utils/asyncHandler');
const searchService = require('../../services/searchService');
const plannerService = require('../../services/plannerService');
const undoService = require('../../services/undoService');

const ok = (data, message) => ({ success: true, ...(message ? { message } : {}), data });

const search = asyncHandler(async (req, res) => res.json(ok(await searchService.search(req.query.q))));
const unscheduled = asyncHandler(async (req, res) => res.json(ok(await plannerService.unscheduled())));
const arrivals = asyncHandler(async (req, res) => res.json(ok(await plannerService.arrivals(req.query.sort))));
const load = asyncHandler(async (req, res) => res.json(ok(await plannerService.load({ from: req.query.from, days: req.query.days }))));
const documents = asyncHandler(async (req, res) => res.json(ok(await plannerService.documents())));
const undoList = asyncHandler(async (req, res) => res.json(ok(await undoService.list(req.admin))));
const undo = asyncHandler(async (req, res) => {
  const result = await undoService.undoLatest(req.admin);
  res.json(ok(result, `Undone: ${result.undone.summary}`));
});

module.exports = { search, unscheduled, arrivals, load, documents, undoList, undo };
