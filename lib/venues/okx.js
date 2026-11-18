'use strict';
// OKX v5 public WebSocket: books50-tbt (L2, tick-by-tick) + trades + tickers.
//   wss://ws.okx.com:8443/ws/v5/public
// Book messages carry seqId/prevSeqId; a discontinuity triggers a resubscribe.

const { VenueBase } = require('./base');

const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';

class OkxL2Client extends VenueBase {
  constructor(opts = {}) {
    super({ venue: 'okx', ...opts, url: opts.url || WS_URL });
    this.channel = opts.channel || 'books';
    this.lastSeq = new Map();
  }

  _subscribe() {
    const args = [];
    for (const s of this.symbols) {
      args.push({ channel: this.channel, instId: s });
      args.push({ channel: 'trades', instId: s });
      args.push({ channel: 'tickers', instId: s });
    }
    if (args.length) this.send({ op: 'subscribe', args });
  }

  _subscribeSymbols(added) {
    const args = [];
    for (const s of added) {
      args.push({ channel: this.channel, instId: s });
      args.push({ channel: 'trades', instId: s });
      args.push({ channel: 'tickers', instId: s });
    }
    this.send({ op: 'subscribe', args });
    return true;
  }

  _unsubscribeSymbols(removed) {
    const args = [];
    for (const s of removed) {
      args.push({ channel: this.channel, instId: s });
      args.push({ channel: 'trades', instId: s });
      args.push({ channel: 'tickers', instId: s });
    }
    this.send({ op: 'unsubscribe', args });
    return true;
  }

  _keepalive() {
    this.send('ping');
  }

  _handle(msg, raw) {
    if (raw === 'pong') return;
    if (msg.event === 'subscribe') {
      this.emit('log', 'info', `subscribed ${JSON.stringify(msg.arg && msg.arg.channel)}`);
      return;
    }
    if (msg.event === 'ping') { this.send('pong'); return; }
    if (msg.event === 'error') {
      this.emit('log', 'error', `okx error ${msg.code}: ${msg.msg}`);
      return;
    }
    const arg = msg.arg;
    if (!arg) return;
    const inst = arg.instId;
    const canonical = this.canonical(inst);
    if (arg.channel === this.channel) this._onBook(canonical, inst, (msg.data || [])[0]);
    else if (arg.channel === 'trades') this._onTrades(canonical, msg.data || []);
    else if (arg.channel === 'tickers') this._onTickers(canonical, msg.data || []);
  }

  _onBook(canonical, inst, d) {
    if (!d) return;
    const ts = Number(d.ts) || Date.now();
    const seqId = Number(d.seqId);
    if (d.action === 'snapshot') {
      this.lastSeq.set(inst, seqId);
      this.emit('snapshot', canonical, _levels(d.bids), _levels(d.asks), { seq: seqId, ts, venue: this.venue });
      return;
    }
    const prev = this.lastSeq.get(inst);
    if (prev != null && d.prevSeqId != null && Number(d.prevSeqId) !== prev) {
      this.emit('log', 'warn', `okx sequence gap ${inst}: prevSeqId=${d.prevSeqId} last=${prev}; resubscribing`);
      this.emit('gap', canonical, { prev, seq: Number(d.prevSeqId) });
      this._subscribe();
      return;
    }
    this.lastSeq.set(inst, seqId);
    for (const [p, z] of d.bids || []) {
      this.emit('update', canonical, 'bid', Number(p), Number(z), { seq: seqId, ts, venue: this.venue });
    }
    for (const [p, z] of d.asks || []) {
      this.emit('update', canonical, 'ask', Number(p), Number(z), { seq: seqId, ts, venue: this.venue });
    }
  }

  _onTrades(canonical, data) {
    for (const t of data) {
      this.emit('trade', canonical, t.side === 'sell' ? 'sell' : 'buy',
        Number(t.px), Number(t.sz), Number(t.ts) || Date.now(), { seq: Number(t.tradeId), venue: this.venue });
    }
  }

  _onTickers(canonical, data) {
    for (const t of data) {
      this.emit('ticker', canonical, {
        bidPrice: Number(t.bidPx), bidSize: Number(t.bidSz),
        askPrice: Number(t.askPx), askSize: Number(t.askSz),
        lastPrice: Number(t.last), lastSize: Number(t.lastSz),
        time: new Date(Number(t.ts) || Date.now()).toISOString(),
      }, { seq: null, venue: this.venue });
    }
  }
}

function _levels(arr) {
  return (arr || []).map(([p, z]) => [Number(p), Number(z)]);
}

module.exports = { OkxL2Client, WS_URL };
