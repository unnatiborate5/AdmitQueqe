'use strict';
const asyncHandler = require('../../utils/asyncHandler');
const v = require('../../utils/adminValidators');
const appointmentService = require('../../services/appointmentService');
const adminStudentService = require('../../services/adminStudentService');

const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: appointmentService.list(req.query) });
});

const schedule = asyncHandler(async (req, res) => {
  const { errors, values } = v.validateAppointment(req.body, { requireStudent: true });
  v.assertValid(errors);
  const appointment = appointmentService.schedule(req.admin, values);
  res.status(201).json({ success: true, message: 'Appointment scheduled.', data: { appointment, student: adminStudentService.getDetail(values.studentId) } });
});

const reschedule = asyncHandler(async (req, res) => {
  const id = v.parseId(req.params.id, 'Appointment');
  const { errors, values } = v.validateAppointment(req.body, { requireReason: true });
  v.assertValid(errors);
  const appointment = appointmentService.reschedule(req.admin, id, values);
  res.json({ success: true, message: 'Appointment rescheduled.', data: { appointment, student: adminStudentService.getDetail(appointment.studentId) } });
});

const updateStatus = asyncHandler(async (req, res) => {
  const id = v.parseId(req.params.id, 'Appointment');
  const { errors, values } = v.validateAppointmentStatus(req.body);
  v.assertValid(errors);
  const appointment = appointmentService.updateStatus(req.admin, id, values);
  res.json({ success: true, message: `Appointment marked ${appointment.statusLabel.toLowerCase()}.`, data: { appointment, student: adminStudentService.getDetail(appointment.studentId) } });
});

module.exports = { list, schedule, reschedule, updateStatus };
