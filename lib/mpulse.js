'use strict';
// Headless Market Pulse client. The meta API accepts a client-minted anonymous
// identity, so no Bookmap account and no activation seat are needed. Protocol
// details mirror fv00's verified bm/mpulse.py client.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { resolveWebSocket } = require('./ws');

const MPULSE_BASE = 'https://beta.mpulse.bookmap.com';
const AUTH_HEADER = 'x-bm-auth-token-mp';

// name / default view / default instrument type / default preset, as
// provisioned server-side. The orderbook widgets only exist for the
// "Close range" and "Long range" presets -- "Medium" is refused upstream.
const ALGOS = {
  priceChange: { name: 'Price Change', view: 'Trades', type: 'SPOT', preset: 'Medium' },
  'volumePressureImbalance/TP': { name: 'Volume Pressure Imbalance', view: 'Trades', type: 'SPOT', preset: 'Medium' },
  'volumePressureEMS/TP': { name: 'Volume Pressure EMS', view: 'Trades', type: 'SPOT', preset: 'Medium' },
  orderbookPressure: { name: 'Orderbook Pressure', view: 'Orderbook Pressure', type: 'SPOT', preset: 'Close range' },
  orderbookPressureImbalance: { name: 'Orderbook Pressure Imbalance', view: 'Orderbook Pressure', type: 'SPOT', preset: 'Close range' },
  paceOfTape: { name: 'Pace of Tape', view: 'Pace of Tape', type: 'SPOT', preset: 'Medium' },
  liquidationPressure: { name: 'Liquidation Pressure', view: 'Liquidation Pressure', type: 'PERP', preset: 'Medium' },
};

function mintAuthToken(tsMs) {
  const ts = Number.isFinite(tsMs) ? tsMs : Date.now();
  const raw = `${ts}|${crypto.randomUUID()}||${crypto.createHash('sha1').update(crypto.randomUUID()).digest('hex')}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function widgetRequest(algoId, symbol, opts = {}) {
  const def = ALGOS[algoId];
  if (!def) throw new Error(`unknown Market Pulse algo "${algoId}"`);
  return {
    algoId,
    exchange: opts.exchange || 'MULTIBOOK',
    instrumentType: opts.instrumentType || def.type,
    providerShortName: opts.provider || 'BMD',
    symbol,
    presetId: opts.presetId || def.preset,
    viewId: opts.viewId || def.view,
    'external-refer': opts.refer || 'https://web.bookmap.com/',
  };
}

/** one widget socket frame -> {estimate,...} or {type:'...'} or null */
function parseFrame(text) {
  let env;
  try { env = JSON.parse(text); } catch { return null; }
  if (!env || typeof env !== 'object') return null;
  if (env.type && !env.event) {
    const out = { type: String(env.type) };
    if (env.error) out.error = String(env.error);
    if (env.message) out.message = String(env.message);
    return out;
  }
  const ev = env.event || {};
  const data = ev.data || {};
  const dtype = ev.dataType || '';
  const ts = Math.floor(Number(ev.time || 0) / 1e6);
  if (dtype === 'EstimateDataView') {
    return {
      type: 'estimate',
      dataType: dtype,
      ts,
      estimate: Number(data.estimate || 0),
      value: Number(data.value || 0),
    };
  }
  if (dtype === 'EstimatePairDataView' || dtype === 'BipolarEstimatePairDataView') {
    return {
      type: 'estimate-pair',
      dataType: dtype,
      ts,
      first: { name: data.firstValueName || '', value: Number(data.firstValue || 0), estimate: Number(data.firstEstimate || 0) },
      second: { name: data.secondValueName || '', value: Number(data.secondValue || 0), estimate: Number(data.secondEstimate || 0) },
      maxValue: Number(data.maxValue || 0),
    };
  }
  return null;
}

/** map our canonical crypto symbols to Bookmap's MULTIBOOK widget symbols */
function toMpulseSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  const m = s.match(/^([A-Z0-9]+)-(?:USD|USDT)$/);
  if (!m) return null;
  return `${m[1]}-USDT`;
}

class MPulseClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.base = opts.base || MPULSE_BASE;
    this.token = opts.token || mintAuthToken();
    this.fixedToken = !!opts.token;
    this.symbol = opts.symbol;
    this.algos = opts.algos || ['priceChange', 'volumePressureImbalance/TP'];
    this.presetId = opts.presetId || null;
    this.timeoutMs = opts.timeoutMs || 15000;
    this.handshakeMs = opts.handshakeMs || 8000;
    this.reconnectMs = opts.reconnectMs || 5000;
    this.stopped = false;
    this.state = 'connecting';
    this.lastError = null;
    this.sockets = new Set();
    this.readyAlgos = new Set();
    this.timers = new Set();
  }

  _schedule(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
    if (timer.unref) timer.unref();
  }

  _setState(state, meta) {
    this.state = state;
    this.emit('state', state, meta);
  }

  _refreshToken() {
    if (!this.fixedToken) this.token = mintAuthToken();
  }

  _headers(json = false) {
    const h = { [AUTH_HEADER]: this.token, 'Origin': this.base, 'mp-embedded': 'true' };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async _post(path, payload) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(this.base + path, {
        method: 'POST',
        headers: this._headers(true),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`MPulse ${path} -> HTTP ${r.status}: ${text.slice(0, 160)}`);
      return JSON.parse(text);
    } finally { clearTimeout(t); }
  }

  /** mint a private widget socket from the meta API */
  async liveEndpoint(req) {
    this._refreshToken();
    const rows = await this._post('/meta/api/v1/endpoints/live', [req]);
    const array = Array.isArray(rows) ? rows : [rows];
    const row = array.find(r => r && r.endpoint && r.token) || array[0];
    if (!row || row.error || !row.endpoint || !row.token) {
      const reason = row && (row.error || row.message) ? `: ${row.error || row.message}` : '';
      throw new Error(`no live endpoint for ${req.algoId}/${req.symbol}${reason}`);
    }
    return row;
  }

  async connect() {
    const reqs = this.algos.map(a => widgetRequest(a, this.symbol, { presetId: this.presetId }));
    const endpoints = [];
    for (const req of reqs) {
      try {
        const ep = await this.liveEndpoint(req);
        endpoints.push({ req, ep });
      } catch (e) {
        this.lastError = e.message;
        this.emit('log', `mpulse ${req.algoId}: ${e.message}`);
      }
    }
    if (!endpoints.length) throw new Error(this.lastError || 'no Market Pulse endpoints available');
    const results = await Promise.allSettled(endpoints.map(({ req, ep }) => this._openSocket(req, ep)));
    const ready = results.filter(r => r.status === 'fulfilled').length;
    if (!ready) {
      const first = results.find(r => r.status === 'rejected');
      throw new Error(first ? first.reason.message : 'Market Pulse handshake refused');
    }
    return ready;
  }

  _openSocket(req, ep) {
    const WebSocket = resolveWebSocket();
    let ws;
    try {
      // Node's built-in WebSocket and undici take only (url, protocols);
      // upstream does not require custom headers at the socket stage.
      ws = new WebSocket(ep.endpoint);
    } catch (e) {
      this.lastError = e.message;
      this.emit('log', `mpulse socket ${req.algoId}: ${e.message}`);
      return Promise.reject(e);
    }
    this.sockets.add(ws);
    let settled = false;
    let authTimer = null;
    return new Promise((resolve, reject) => {
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        if (err) reject(err); else resolve();
      };
      authTimer = setTimeout(() => {
        this.lastError = `AUTH timeout after ${this.handshakeMs}ms`;
        this.emit('log', `mpulse ${req.algoId}: ${this.lastError}`);
        finish(new Error(this.lastError));
        try { ws.close(4000, 'auth timeout'); } catch { /* ignore */ }
      }, this.handshakeMs);
      if (authTimer.unref) authTimer.unref();

      ws.onopen = () => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AUTH', liveToken: ep.token }));
      };
      ws.onmessage = (msg) => {
        const text = typeof msg.data === 'string' ? msg.data : String(msg.data || '');
        if (text.trim() === 'ping') { if (ws.readyState === 1) ws.send('pong'); return; }
        if (text.includes('AUTH_SUCCESS')) {
          this.readyAlgos.add(req.algoId);
          this.lastError = null;
          this._setState('connected', { algoId: req.algoId, symbol: req.symbol });
          finish();
          return;
        }
        const ev = parseFrame(text);
        if (!ev) return;
        if (ev.type && ev.type !== 'estimate' && ev.type !== 'estimate-pair') {
          if (ev.type === 'ERROR' || ev.type === 'AUTH_FAILED') {
            this.lastError = ev.error || ev.message || ev.type;
            this.emit('log', `mpulse ${req.algoId}: upstream ${this.lastError}`);
            finish(new Error(this.lastError));
            try { ws.close(4000, 'upstream refused'); } catch { /* ignore */ }
          }
          return;
        }
        this.emit('estimate', { ...ev, algoId: req.algoId, symbol: req.symbol, venue: 'mpulse' });
      };
      ws.onerror = (e) => {
        const message = (e && (e.message || e.error?.message || e.type)) || 'socket error';
        this.lastError = message;
        this.emit('log', `mpulse socket ${req.algoId}: ${message}`);
      };
      ws.onclose = (e) => {
        this.sockets.delete(ws);
        this.readyAlgos.delete(req.algoId);
        const code = e && e.code;
        const reason = e && e.reason;
        if (!this.stopped) {
          if (code && code !== 1000) {
            this.lastError = `handshake/socket closed ${code}${reason ? `: ${reason}` : ''}`;
            this.emit('log', `mpulse ${req.algoId}: ${this.lastError}`);
          }
          if (!this.readyAlgos.size) this._setState('closed', { algoId: req.algoId, code, reason });
            if (this.reconnectMs > 0) {
              this._schedule(() => this.liveEndpoint(req)
                .then(ep2 => this._openSocket(req, ep2))
                .catch(e => { this.lastError = e.message; this.emit('log', `mpulse reconnect: ${e.message}`); }), this.reconnectMs);
            }
        }
        finish(new Error(`closed ${code || '?'}${reason ? ` ${reason}` : ''}`));
      };
    });
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const ws of this.sockets) { try { ws.close(); } catch { /* ignore */ } }
    this.sockets.clear();
    this.readyAlgos.clear();
  }
}

module.exports = {
  MPulseClient, MPULSE_BASE, ALGOS, mintAuthToken, widgetRequest, parseFrame, toMpulseSymbol,
};
