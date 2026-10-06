'use strict';
const db = require('../config/db');

const PAYMENT_MODES = ['Online / Net Banking / UPI', 'Debit or Credit Card', 'Demand Draft', 'Bank Challan', 'Cash at College Counter'];

const INSTRUCTIONS = [
  "Check the fee amount and last date in your college's admission notice or on its website.",
  "Pay only through the college's official channels: its payment portal, bank challan, demand draft or the accounts counter.",
  'Do not pay any agent or person who is not named in the official notice.',
  'Keep the receipt or transaction ID. You will need it at the college.',
  'AdmitFlow does not collect payments. It only records the payment status you report.',
];

function get(studentId) {
  const r = db.prepare('SELECT * FROM fee_details WHERE student_id = ?').get(studentId);
  if (!r) return { totalFee: null, amountPaid: null, paymentMode: null, receiptNumber: null, paidOn: null, updatedAt: null };
  return {
    totalFee: r.total_fee,
    amountPaid: r.amount_paid,
    paymentMode: r.payment_mode,
    receiptNumber: r.receipt_number,
    paidOn: r.paid_on,
    updatedAt: r.updated_at,
  };
}

function save(studentId, v) {
  db.prepare(
    `INSERT INTO fee_details (student_id, total_fee, amount_paid, payment_mode, receipt_number, paid_on)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id) DO UPDATE SET
       total_fee = excluded.total_fee, amount_paid = excluded.amount_paid,
       payment_mode = excluded.payment_mode, receipt_number = excluded.receipt_number,
       paid_on = excluded.paid_on, updated_at = datetime('now')`
  ).run(studentId, v.totalFee, v.amountPaid, v.paymentMode, v.receiptNumber, v.paidOn);
}

module.exports = { PAYMENT_MODES, INSTRUCTIONS, get, save };
