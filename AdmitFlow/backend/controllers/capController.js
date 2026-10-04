'use strict';
const capService = require('../services/capService');
const asyncHandler = require('../utils/asyncHandler');
const { assertValid, validateCapDetails } = require('../utils/validators');

const options = { capRounds: capService.CAP_ROUNDS, allotmentStatuses: capService.ALLOTMENT_STATUSES };

const getCapDetails = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: { capDetails: capService.get(req.student.id), options },
  });
});

const saveCapDetails = asyncHandler(async (req, res) => {
  const { errors, values } = validateCapDetails(req.body, options);
  assertValid(errors);
  const capDetails = capService.save(req.student.id, values);
  res.json({ success: true, message: 'CAP details saved successfully.', data: { capDetails } });
});

module.exports = { getCapDetails, saveCapDetails };
