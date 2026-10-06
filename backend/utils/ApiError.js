'use strict';

/** An error that is safe to show to the client. */
class ApiError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} message Human-readable message
   * @param {object} [errors] Field-level errors, e.g. { email: 'Invalid email' }
   * @param {string} [code]  Machine-readable code for the frontend
   */
  constructor(status, message, errors = null, code = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
    this.code = code;
  }
}

module.exports = ApiError;
