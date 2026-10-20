'use strict';
const asyncHandler = require('../../utils/asyncHandler');
const v = require('../../utils/adminValidators');
const capRecordService = require('../../services/capRecordService');

const ok = (data, message) => ({ success: true, ...(message ? { message } : {}), data });

module.exports = {
  list: asyncHandler(async (req, res) => res.json(ok(capRecordService.list(req.admin, req.query)))),
  getOne: asyncHandler(async (req, res) => res.json(ok(capRecordService.getOne(req.admin, v.parseId(req.params.id, 'CAP record'))))),
  create: asyncHandler(async (req, res) => {
    const record = capRecordService.create(req.admin, req.body);
    res.status(201).json(ok({ record }, 'CAP record added. It must be verified before students can be linked to it.'));
  }),
  importCsv: asyncHandler(async (req, res) => {
    const result = capRecordService.importCsv(req.admin, req.body);
    res.status(result.created ? 201 : 200).json(ok(result, `Imported ${result.created} record(s); ${result.skipped.length} skipped.`));
  }),
  update: asyncHandler(async (req, res) => res.json(ok({ record: capRecordService.update(req.admin, v.parseId(req.params.id, 'CAP record'), req.body) }, 'Correction saved.'))),
  verify: asyncHandler(async (req, res) => res.json(ok({ record: capRecordService.verify(req.admin, v.parseId(req.params.id, 'CAP record'), req.body) }, 'Record verified. Students waiting on this application ID were linked.'))),
  revoke: asyncHandler(async (req, res) => res.json(ok({ record: capRecordService.revoke(req.admin, v.parseId(req.params.id, 'CAP record'), req.body) }, 'Record revoked.'))),
  unlink: asyncHandler(async (req, res) => res.json(ok({ record: capRecordService.unlink(req.admin, v.parseId(req.params.id, 'CAP record'), req.body) }, 'Student unlinked from the record.'))),
  listClaims: asyncHandler(async (req, res) => res.json(ok(capRecordService.listClaims(req.query)))),
  approveClaim: asyncHandler(async (req, res) => res.json(ok(capRecordService.approveClaim(req.admin, v.parseId(req.params.id, 'Claim'), req.body), 'Student linked to the record.'))),
  rejectClaim: asyncHandler(async (req, res) => res.json(ok(capRecordService.rejectClaim(req.admin, v.parseId(req.params.id, 'Claim'), req.body), 'Claim rejected.'))),
};
