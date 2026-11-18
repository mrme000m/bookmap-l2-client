'use strict';
// Shared WebSocket venue adapter: connect, subscribe hook, auto-reconnect with
// jittered exponential backoff, keepalive, and a staleness watchdog that forces
// a reconnect (and therefore a fresh snapshot) when the feed goes quiet.

const { EventEmitter } = require('events');
const { resolveWebSocket } = require('../ws');

class VenueBase extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string[]} opts.symbols native venue symbols
   * @param {Object<string,string>} [opts.symbolMap] native -> canonical symbol
   * @param {number} [opts.backoffMs] @param {number} [opts.maxBackoffMs]
   * @param {number} [opts.jitterRatio] @param {number} [opts.stalenessMs]
   * @param {number} [opts.keepaliveMs] @param {number} [opts.restTimeoutMs]
   */
  constructor(opts = {}) {
    super();
    this.url = opts.url;
    this.symbols = (opts.symbols || []).slice();
    this.symbolMap = opts.symbolMap || {};
    this.venue = opts.venue || this.constructor.name.replace(/Client$/, '').toLowerCase();

    this.backoffMs = opts.backoffMs || 2000;
    this.maxBackoffMs = opts.maxBackoffMs || 60000;
    this.jitterRatio = opts.jitterRatio == null ? 0.25 : opts.jitterRatio;
    this.stalenessMs = opts.stalenessMs || 15000;
    this.keepaliveMs = opts.keepaliveMs == null ? 20000 : opts.keepaliveMs;
    this.restTimeoutMs = opts.restTimeoutMs || 10000;

    this.backoff = this.backoffMs;
    this.ws = null;
    this.state = 'idle'; // idle | connecting | connected | closed | stale
    this.stopped = false;
    this.started = false;
    this.lastFrameAt = 0;
    this.keepaliveTimer = null;
    this.stalenessTimer = null;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this.started = true;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this._clearTimers();
    if (this.ws) { try { this.ws.close(1000, 'client stop'); } catch { /* ignore */ } }
    this._setState('closed');
  }

  _clearTimers() {
    clearInterval(this.keepaliveTimer); this.keepaliveTimer = null;
    clearInterval(this.stalenessTimer); this.stalenessTimer = null;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
  }

  _setState(state, detail) {
    this.state = state;
    this.emit('state', state, detail);
  }

  _connect() {
    if (this.stopped) return;
    this._setState('connecting');
    let WS;
    try {
      WS = resolveWebSocket();
    } catch (e) {
      this.emit('log', 'error', e.message);
      this._scheduleReconnect();
      return;
    }
    let ws;
    try {
      ws = new WS(this.url);
    } catch (e) {
      this.emit('log', 'error', `connect failed: ${e.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = this.backoffMs;
      this.lastFrameAt = Date.now();
      this._setState('connected');
      this.emit('open');
      this._startKeepalive();
      this._startStaleness();
      try { this._subscribe(); } catch (e) { this.emit('log', 'error', `subscribe failed: ${e.message}`); }
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (e) => {
      this._stopLoops();
      this._setState('closed', e && e.code);
      this.emit('disconnected', e && e.code);
      this._scheduleReconnect();
    };
    ws.onmessage = (m) => {
      this.lastFrameAt = Date.now();
      this._onFrame(m && m.data);
    };
  }

  _onFrame(data) {
    if (typeof data === 'string') { this._onRaw(data); return; }
    try { this._onRaw(Buffer.from(data).toString('utf8')); } catch { /* ignore binary */ }
  }

  _onRaw(raw) {
    if (typeof raw !== 'string') return;
    if (raw === 'ping') { this.send('pong'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { this._handle(msg, raw); } catch (e) { this.emit('log', 'error', `handler error: ${e.message}`); }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
        return true;
      } catch (e) {
        this.emit('log', 'error', `send failed: ${e.message}`);
      }
    }
    return false;
  }

  canonical(native) {
    return this.symbolMap[native] || native;
  }

  /** @param {string} canonicalSymbol @returns {boolean} whether it is still subscribed */
  isSubscribed(canonicalSymbol) {
    for (const v of Object.values(this.symbolMap)) {
      if (v === canonicalSymbol) return true;
    }
    return false;
  }

  /**
   * Add native symbols to the live subscription at runtime.
   * Adapters that support incremental subscribe override `_subscribeSymbols`;
   * the default falls back to reconnecting with the enlarged symbol set.
   * @param {string[]} nativeSymbols
   * @returns {string[]} the symbols actually added
   */
  addSymbols(nativeSymbols) {
    const added = [];
    for (const s of nativeSymbols || []) {
      if (!s || this.symbols.includes(s)) continue;
      this.symbols.push(s);
      added.push(s);
    }
    if (!added.length) return [];
    if (this._subscribeSymbols(added)) return added;
    this._reconnectWithSymbols();
    return added;
  }

  /**
   * Remove native symbols from the live subscription at runtime.
   * @param {string[]} nativeSymbols
   * @returns {string[]} the symbols actually removed
   */
  removeSymbols(nativeSymbols) {
    const removed = [];
    for (const s of nativeSymbols || []) {
      const i = this.symbols.indexOf(s);
      if (i === -1) continue;
      this.symbols.splice(i, 1);
      removed.push(s);
    }
    if (!removed.length) return [];
    if (this._unsubscribeSymbols(removed)) return removed;
    this._reconnectWithSymbols();
    return removed;
  }

  /** @returns {boolean} true when handled incrementally, false to force a reconnect */
  _subscribeSymbols() { return false; }
  /** @returns {boolean} true when handled incrementally, false to force a reconnect */
  _unsubscribeSymbols() { return false; }

  _reconnectWithSymbols() {
    if (!this.started) {
      // not connected yet: the new symbol set applies on the next connect
      this.emit('log', 'info', `symbol set updated: ${this.symbols.join(',')}`);
      return;
    }
    this.emit('log', 'info', `reconnecting to apply symbol set: ${this.symbols.join(',')}`);
    this.backoff = this.backoffMs;
    if (this.ws) { try { this.ws.close(1000, 'symbol change'); } catch { /* ignore */ } }
    else this._scheduleReconnect();
  }

  async _fetchJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.restTimeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}: ${text.slice(0, 160)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(t);
    }
  }

  _subscribe() {}
  _handle() {}
  _keepalive() {}

  _startKeepalive() {
    clearInterval(this.keepaliveTimer);
    if (!this.keepaliveMs) return;
    this.keepaliveTimer = setInterval(() => {
      try { this._keepalive(); } catch { /* ignore */ }
    }, this.keepaliveMs);
  }

  _startStaleness() {
    clearInterval(this.stalenessTimer);
    if (!this.stalenessMs) return;
    this.stalenessTimer = setInterval(() => {
      if (!this.lastFrameAt) return;
      const idle = Date.now() - this.lastFrameAt;
      if (idle > this.stalenessMs) {
        this.emit('log', 'warn', `no data for ${Math.round(idle / 1000)}s; reconnecting`);
        this._setState('stale', { idleMs: idle });
        this.emit('stale', { idleMs: idle });
        try { if (this.ws) this.ws.close(1000, 'stale'); } catch { /* ignore */ }
      }
    }, Math.max(1000, Math.round(this.stalenessMs / 2)));
  }

  _stopLoops() {
    clearInterval(this.keepaliveTimer); this.keepaliveTimer = null;
    clearInterval(this.stalenessTimer); this.stalenessTimer = null;
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    this._setState('idle');
    const jitter = this.backoff * this.jitterRatio * (Math.random() * 2 - 1);
    const delay = Math.max(100, Math.round(this.backoff + jitter));
    this.emit('log', 'warn', `reconnecting in ${Math.round(delay / 1000)}s`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
  }
}

module.exports = { VenueBase };
