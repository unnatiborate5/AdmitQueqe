'use strict';
const applicationService = require('../services/applicationService');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

/** Student: "I have made the corrections the college asked for". */
const resubmit = asyncHandler(async (req, res) => {
  const raw = req.body && typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (raw.length > 300) throw new ApiError(400, 'Please correct the highlighted fields.', { note: 'Note can be at most 300 characters.' });
  const application = applicationService.resubmit(req.student, raw || null);
  res.json({ success: true, message: 'Thanks. Your application is back in the college review queue.', data: { application } });
});

module.exports = { resubmit };
