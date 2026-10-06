'use strict';
/**
 * Talks to the C++ queue engine process (cpp_engine/build/queue_engine) over stdin/stdout:
 * one request line -> one JSON reply line, answered in order.
 */
const { spawn } = require('child_process');

class EngineClient {
  constructor(binPath, fairness) {
    this.binPath = binPath;
    this.fairness = fairness;
    this.child = null;
    this.alive = false;
    this.pending = [];
    this.buffer = '';
  }

  start() {
    const child = spawn(this.binPath, [String(this.fairness)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.alive = true;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', () => { /* the engine writes nothing to stderr; ignore */ });
    child.stdin.on('error', () => { /* a dead engine is handled by the exit event */ });
    const down = (why) => { if (this.child === child) this._down(why); };
    child.on('error', (err) => down(err.message));
    child.on('exit', (code, signal) => down(`engine exited (${signal || code})`));
    // Do not keep Node alive just because of the engine.
    child.unref();
    [child.stdin, child.stdout, child.stderr].forEach((s) => s.unref && s.unref());
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const waiter = this.pending.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      try { waiter.resolve(JSON.parse(line)); } catch (err) { waiter.reject(new Error(`Bad engine reply: ${line.slice(0, 80)}`)); }
    }
  }

  _down(why) {
    this.alive = false;
    const waiting = this.pending.splice(0);
    waiting.forEach((w) => { clearTimeout(w.timer); w.reject(new Error(`ENGINE_DOWN: ${why}`)); });
  }

  /** Sends one command line and resolves with the parsed JSON reply. */
  send(line, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error('ENGINE_DOWN: not running')); return; }
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this._down('timed out');
        this.stop();
      }, timeoutMs);
      this.pending.push(waiter);
      this.child.stdin.write(`${line}\n`);
    });
  }

  stop() {
    const child = this.child;
    this.alive = false;
    if (child) { try { child.kill(); } catch (_) { /* already gone */ } }
    this.child = null;
  }
}

module.exports = EngineClient;
