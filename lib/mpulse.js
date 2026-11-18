'use strict';
// Headless Market Pulse client. The meta API accepts a client-minted anonymous
// identity, so no Bookmap account and no activation seat are needed. Protocol
// details mirror fv00's verified bm/mpulse.py client.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { resolveWebSocket } = require('./ws');

const MPULSE_BASE = 'https://beta.mpulse.bookmap.com';
const AUTH_HEADER = 'x-bm-auth-token-mp';

const ALGOS = {
  priceChange: ['Price Change', 'Trades', 'SPOT'],
  'volumePressureImbalance/TP': ['Volume Pressure Imbalance', 'Trades', 'SPOT'],
  'volumePressureEMS/TP': ['Volume Pressure EMS', 'Trades', 'SPOT'],
  orderbookPressure: ['Orderbook Pressure', 'Orderbook Pressure', 'SPOT'],
  orderbookPressureImbalance: ['Orderbook Pressure Imbalance', 'Orderbook Pressure', 'SPOT'],
  paceOfTape: ['Pace of Tape', 'Pace of Tape', 'SPOT'],
  liquidationPressure: ['Liquidation Pressure', 'Liquidation Pressure', 'PERP'],
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
    instrumentType: opts.instrumentType || def[2],
    providerShortName: opts.provider || 'BMD',
    symbol,
    presetId: opts.presetId || 'Medium',
    viewId: opts.viewId || def[1],
    'external-refer': opts.refer || 'https://web.bookmap.com/',
  };
}

/** one widget socket frame -> {estimate,...} or {type:'...'} or null */
function parseFrame(text) {
  let env;
  try { env = JSON.parse(text); } catch { return null; }
  if (!env || typeof env !== 'object') return null;
  if (env.type && !env.event) return { type: String(env.type) };
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
  return m[1] === 'BTC' || m[1] === 'ETH' ? `${m[1]}-USDT` : `${m[1]}-USDT`;
}

class MPulseClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.base = opts.base || MPULSE_BASE;
    this.token = opts.token || mintAuthToken();
    this.symbol = opts.symbol;
    this.algos = opts.algos || ['priceChange', 'volumePressureImbalance/TP'];
    this.presetId = opts.presetId || 'Medium';
    this.timeoutMs = opts.timeoutMs || 15000;
    this.reconnectMs = opts.reconnectMs || 5000;
    this.stopped = false;
    this.ws = null;
    this.timer = null;
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
    const rows = await this._post('/meta/api/v1/endpoints/live', [req]);
    const array = Array.isArray(rows) ? rows : [rows];
    const row = array.find(r => r && r.endpoint && r.token) || array[0];
    if (!row || !row.endpoint || !row.token) {
      throw new Error(`no live endpoint for ${req.algoId}/${req.symbol}: ${JSON.stringify(row).slice(0, 160)}`);
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
      } catch (e) { this.emit('log', `mpulse ${req.algoId}: ${e.message}`); }
    }
    if (!endpoints.length) throw new Error('no Market Pulse endpoints available');
    for (const { req, ep } of endpoints) this._openSocket(req, ep);
    return endpoints.length;
  }

  _openSocket(req, ep) {
    const WebSocket = resolveWebSocket();
    let ws;
    try {
      ws = new WebSocket(ep.endpoint, { headers: this._headers() });
    } catch (e) {
      this.emit('log', `mpulse socket ${req.algoId}: ${e.message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'AUTH', liveToken: ep.token }));
      this.emit('state', 'connected', { algoId: req.algoId, symbol: req.symbol });
    };
    ws.onmessage = (msg) => {
      const text = typeof msg.data === 'string' ? msg.data : String(msg.data || '');
      if (text.trim() === 'ping') { if (ws.readyState === 1) ws.send('pong'); return; }
      const ev = parseFrame(text);
      if (!ev || ev.type === 'AUTH_SUCCESS') return;
      this.emit('estimate', { ...ev, algoId: req.algoId, symbol: req.symbol, venue: 'mpulse' });
    };
    ws.onerror = (e) => this.emit('log', `mpulse socket error: ${e && e.message || 'unknown'}`);
    ws.onclose = () => {
      this.emit('state', 'closed', { algoId: req.algoId });
      if (!this.stopped && this.reconnectMs > 0) {
        this.timer = setTimeout(() => this.liveEndpoint(req)
          .then(ep2 => this._openSocket(req, ep2))
          .catch(e => this.emit('log', `mpulse reconnect: ${e.message}`)), this.reconnectMs);
        if (this.timer.unref) this.timer.unref();
      }
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
  }
}

module.exports = {
  MPulseClient, MPULSE_BASE, ALGOS, mintAuthToken, widgetRequest, parseFrame, toMpulseSymbol,
};
