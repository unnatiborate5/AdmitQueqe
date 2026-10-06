'use strict';
/**
 * Tiny in-memory failed-login limiter (per process). Good enough for a single-server college
 * deployment; swap for a shared store if the app is ever run on several servers.
 */
class FailureLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> { count, first }
  }

  _live(key) {
    const rec = this.hits.get(key);
    if (!rec) return null;
    if (Date.now() - rec.first > this.windowMs) { this.hits.delete(key); return null; }
    return rec;
  }

  /** Seconds the caller must wait, or 0 when allowed. */
  retryAfter(key) {
    const rec = this._live(key);
    if (!rec || rec.count < this.max) return 0;
    return Math.max(1, Math.ceil((rec.first + this.windowMs - Date.now()) / 1000));
  }

  fail(key) {
    const rec = this._live(key);
    if (rec) rec.count += 1; else this.hits.set(key, { count: 1, first: Date.now() });
    if (this.hits.size > 5000) this.hits.clear(); // hard cap so memory cannot grow without bound
  }

  reset(key) { this.hits.delete(key); }
}

module.exports = FailureLimiter;
