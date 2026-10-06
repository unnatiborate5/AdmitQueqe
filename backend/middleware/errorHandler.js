'use strict';
const ApiError = require('../utils/ApiError');

function notFound(req, res) {
  res.status(404).json({ success: false, message: `API endpoint not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    return res.status(err.status).json({
      success: false,
      message: err.message,
      ...(err.errors ? { errors: err.errors } : {}),
      ...(err.code ? { code: err.code } : {}),
    });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid JSON in request body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body is too large.' });
  }

  console.error('Unexpected error:', err);
  return res.status(500).json({ success: false, message: 'Something went wrong on our side. Please try again.' });
}

module.exports = { notFound, errorHandler };
