'use strict';
// Bybit v5 public spot WebSocket: orderbook.50 + publicTrade + tickers.
//   wss://stream.bybit.com/v5/public/spot
// The first orderbook message per topic is a snapshot; later ones are deltas.

const { VenueBase } = require('./base');

const WS_URL = 'wss://stream.bybit.com/v5/public/spot';

class BybitL2Client extends VenueBase {
  constructor(opts = {}) {
    super({ venue: 'bybit', ...opts, url: opts.url || WS_URL });
    this.lastType = new Map();
  }

  _subscribe() {
    const args = [];
    for (const s of this.symbols) {
      args.push(`orderbook.50.${s}`, `publicTrade.${s}`, `tickers.${s}`);
    }
    if (args.length) this.send({ op: 'subscribe', args });
  }

  _subscribeSymbols(added) {
    const args = [];
    for (const s of added) {
      args.push(`orderbook.50.${s}`, `publicTrade.${s}`, `tickers.${s}`);
    }
    this.send({ op: 'subscribe', args });
    return true;
  }

  _unsubscribeSymbols(removed) {
    const args = [];
    for (const s of removed) {
      args.push(`orderbook.50.${s}`, `publicTrade.${s}`, `tickers.${s}`);
    }
    this.send({ op: 'unsubscribe', args });
    return true;
  }

  _keepalive() {
    this.send({ op: 'ping' });
  }

  _handle(msg) {
    if (msg.op === 'pong') return;
    if (msg.op === 'subscribe') {
      this.emit('log', 'info', `subscribe success=${msg.success}`);
      return;
    }
    const topic = msg.topic;
    if (!topic) return;
    const symbol = (msg.data && (msg.data.s || msg.data.symbol)) || topic.split('.').pop();
    const canonical = this.canonical(symbol);
    if (topic.startsWith('orderbook.')) this._onBook(canonical, topic, msg);
    else if (topic.startsWith('publicTrade.')) this._onTrades(canonical, msg.data || []);
    else if (topic.startsWith('tickers.')) this._onTicker(canonical, msg.data || []);
  }

  _onBook(canonical, topic, msg) {
    const d = msg.data;
    if (!d) return;
    const ts = Number(msg.ts) || Date.now();
    const seq = Number(d.u);
    if (msg.type === 'snapshot' || !this.lastType.has(topic)) {
      this.lastType.set(topic, 'snapshot');
      this.emit('snapshot', canonical, _levels(d.b), _levels(d.a), { seq, ts, venue: this.venue });
      return;
    }
    this.lastType.set(topic, msg.type);
    for (const [p, q] of d.b || []) {
      this.emit('update', canonical, 'bid', Number(p), Number(q), { seq, ts, venue: this.venue });
    }
    for (const [p, q] of d.a || []) {
      this.emit('update', canonical, 'ask', Number(p), Number(q), { seq, ts, venue: this.venue });
    }
  }

  _onTrades(canonical, data) {
    for (const t of data) {
      const side = String(t.S).toLowerCase() === 'sell' ? 'sell' : 'buy';
      this.emit('trade', canonical, side, Number(t.p), Number(t.v),
        Number(t.T) || Date.now(), { seq: Number(t.i), venue: this.venue });
    }
  }

  _onTicker(canonical, d) {
    this.emit('ticker', canonical, {
      bidPrice: Number(d.bid1Price), bidSize: Number(d.bid1Size),
      askPrice: Number(d.ask1Price), askSize: Number(d.ask1Size),
      lastPrice: Number(d.lastPrice), lastSize: null,
      time: new Date().toISOString(),
    }, { seq: null, venue: this.venue });
  }
}

function _levels(arr) {
  return (arr || []).map(([p, q]) => [Number(p), Number(q)]);
}

module.exports = { BybitL2Client, WS_URL };
