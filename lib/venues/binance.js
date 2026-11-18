'use strict';
// Binance spot combined-stream L2: <symbol>@depth20@100ms + @trade + @bookTicker.
//   wss://stream.binance.com:9443/stream?streams=...
// Depth streams are incremental; the local book is primed from the public REST
// snapshot (/api/v3/depth) and buffered depth events are replayed once it lands.
//
// binance.com returns HTTP 451 in some jurisdictions. The public market-data
// mirrors at binance.vision carry the same data, so use them by default; an
// explicit --url/--rest-url still wins.

const { VenueBase } = require('./base');

const WS_URL = 'wss://data-stream.binance.vision/stream';
const REST_URL = 'https://data-api.binance.vision';

class BinanceL2Client extends VenueBase {
  constructor(opts = {}) {
    const symbols = opts.symbols || [];
    super({ venue: 'binance', ...opts, symbols, url: opts.url || BinanceL2Client._streamUrl(symbols) });
    this.restUrl = opts.restUrl || REST_URL;
    this.customUrl = opts.url || null;
    this.ready = new Map();
    this.lastUpdateId = new Map();
    this.prevU = new Map();
    this.buffer = new Map();
  }

  static _streamUrl(symbols) {
    // Binance stream names are lower-case
    const streams = (symbols || []).flatMap(s => {
      const l = String(s).toLowerCase();
      return [`${l}@depth20@100ms`, `${l}@trade`, `${l}@bookTicker`];
    });
    return `${WS_URL}?streams=${streams.join('/')}`;
  }

  /** Binance sends the symbol upper-case in payloads but expects it lower-case in stream names */
  canonical(native) {
    if (this.symbolMap[native]) return this.symbolMap[native];
    const lower = String(native).toLowerCase();
    if (this.symbolMap[lower]) return this.symbolMap[lower];
    return native;
  }

  _restSymbol(native) {
    return String(native).toUpperCase();
  }

  _subscribe() {
    this._prime();
  }

  _reconnectWithSymbols() {
    // streams are encoded in the URL, so a reconnect is required
    if (!this.customUrl) this.url = BinanceL2Client._streamUrl(this.symbols);
    super._reconnectWithSymbols();
  }

  async _prime() {
    for (const symbol of this.symbols) await this._primeSymbol(symbol);
  }

  async _primeSymbol(symbol) {
    try {
      const j = await this._fetchJson(`${this.restUrl}/api/v3/depth?symbol=${this._restSymbol(symbol)}&limit=100`);
      const bids = (j.bids || []).map(([p, q]) => [Number(p), Number(q)]);
      const asks = (j.asks || []).map(([p, q]) => [Number(p), Number(q)]);
      const lastUpdateId = Number(j.lastUpdateId) || 0;
      this.lastUpdateId.set(symbol, lastUpdateId);
      this.prevU.set(symbol, null);
      this.ready.set(symbol, true);
      this.emit('snapshot', this.canonical(symbol), bids, asks, {
        seq: lastUpdateId, ts: Date.now(), venue: this.venue,
      });
      const buf = this.buffer.get(symbol) || [];
      this.buffer.set(symbol, []);
      for (const ev of buf) this._applyDepth(symbol, ev);
    } catch (e) {
      this.ready.set(symbol, false);
      this.emit('log', 'error', `snapshot ${symbol} failed: ${e.message}`);
    }
  }

  _handle(msg) {
    const data = msg && msg.data;
    if (!data) return;
    // bookTicker has no "e" field: it is identified by the stream name / b+a fields
    if (!data.e) {
      if (data.b != null && data.a != null) this._onBookTicker(data);
      return;
    }
    switch (data.e) {
      case 'depthUpdate': this._onDepth(data); break;
      case 'trade': this._onTrade(data); break;
      case 'bookTicker': this._onBookTicker(data); break;
      default: break;
    }
  }

  _onDepth(data) {
    const symbol = data.s;
    if (!this.ready.has(symbol)) this.ready.set(symbol, false);
    if (!this.ready.get(symbol)) {
      const buf = this.buffer.get(symbol) || [];
      buf.push(data);
      if (buf.length > 5000) buf.shift();
      this.buffer.set(symbol, buf);
      return;
    }
    this._applyDepth(symbol, data);
  }

  _applyDepth(symbol, data) {
    const last = this.lastUpdateId.get(symbol) || 0;
    if (data.u <= last) return;
    if (Number(data.U) > last + 1) {
      this._gap(symbol, `depth gap U=${data.U} last=${last}`);
      return;
    }
    const prevU = this.prevU.get(symbol);
    if (prevU != null && data.pu != null && Number(data.pu) !== prevU) {
      this._gap(symbol, `pu mismatch ${data.pu} != ${prevU}`);
      return;
    }
    const u = Number(data.u);
    this.lastUpdateId.set(symbol, u);
    this.prevU.set(symbol, u);
    const ts = Number(data.E) || Date.now();
    for (const [p, q] of data.b || []) {
      this.emit('update', this.canonical(symbol), 'bid', Number(p), Number(q), { seq: u, ts, venue: this.venue });
    }
    for (const [p, q] of data.a || []) {
      this.emit('update', this.canonical(symbol), 'ask', Number(p), Number(q), { seq: u, ts, venue: this.venue });
    }
  }

  _gap(symbol, detail) {
    this.emit('log', 'warn', `${symbol}: ${detail}; re-priming from REST`);
    this.emit('gap', this.canonical(symbol), { detail });
    this.ready.set(symbol, false);
    this.buffer.set(symbol, []);
    this._primeSymbol(symbol);
  }

  _onTrade(data) {
    // m = buyer is maker, so the taker side is the opposite
    const side = data.m ? 'sell' : 'buy';
    this.emit('trade', this.canonical(data.s), side, Number(data.p), Number(data.q),
      Number(data.T) || Date.now(), { seq: Number(data.t), venue: this.venue });
  }

  _onBookTicker(data) {
    this.emit('ticker', this.canonical(data.s), {
      bidPrice: Number(data.b), bidSize: Number(data.B),
      askPrice: Number(data.a), askSize: Number(data.A),
      lastPrice: null, lastSize: null, time: new Date().toISOString(),
    }, { seq: Number(data.u), venue: this.venue });
  }
}

module.exports = { BinanceL2Client, WS_URL, REST_URL };
