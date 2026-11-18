'use strict';
// Kraken WebSocket v1: book (L2, depth 100) + trade + ticker.
//   wss://ws.kraken.com/
// Messages are arrays: [chanId, payload, channelName, pair]. The initial book
// snapshot uses "bs"/"as"; later updates use "b"/"a" with a checksum.

const { VenueBase } = require('./base');

const WS_URL = 'wss://ws.kraken.com/';

class KrakenL2Client extends VenueBase {
  constructor(opts = {}) {
    super({ venue: 'kraken', ...opts, url: opts.url || WS_URL });
    this.depth = opts.depth || 100;
    this.channels = new Map(); // chanId -> {type, pair}
  }

  _subscribe() {
    const pairs = this.symbols;
    if (!pairs.length) return;
    this.send({ event: 'subscribe', pair: pairs, subscription: { name: 'book', depth: this.depth } });
    this.send({ event: 'subscribe', pair: pairs, subscription: { name: 'trade' } });
    this.send({ event: 'subscribe', pair: pairs, subscription: { name: 'ticker' } });
  }

  _keepalive() {
    this.send({ event: 'ping' });
  }

  _handle(msg) {
    if (Array.isArray(msg)) { this._onArray(msg); return; }
    if (msg.event === 'pong' || msg.event === 'heartbeat') return;
    if (msg.event === 'subscriptionStatus') {
      if (msg.channelID != null && msg.channelName) {
        this.channels.set(msg.channelID, { type: msg.channelName, pair: msg.pair });
      }
      this.emit('log', 'info', `subscribed ${msg.channelName} ${msg.pair} status=${msg.status}`);
      return;
    }
    if (msg.event === 'error') {
      this.emit('log', 'error', `kraken error: ${JSON.stringify(msg.error || msg)}`);
    }
  }

  _onArray(arr) {
    const chanId = arr[0];
    const payload = arr[1];
    const known = this.channels.get(chanId);
    const type = arr[2] || (known && known.type);
    const pair = arr[3] || (known && known.pair);
    if (payload === 'hb' || type === 'heartbeat') return;
    const symbol = this.canonical(pair);
    const ts = Date.now();
    if (type && type.startsWith('book')) this._onBook(symbol, payload, ts);
    else if (type === 'trade') this._onTrades(symbol, payload, ts);
    else if (type === 'ticker') this._onTicker(symbol, payload, ts);
  }

  _onBook(symbol, p, ts) {
    if (!p || typeof p !== 'object') return;
    if (p.bs || p.as) {
      this.emit('snapshot', symbol, _levels(p.bs), _levels(p.as), { seq: null, ts, venue: this.venue });
      return;
    }
    for (const [price, size] of _levels(p.b)) {
      this.emit('update', symbol, 'bid', price, size, { seq: null, ts, venue: this.venue });
    }
    for (const [price, size] of _levels(p.a)) {
      this.emit('update', symbol, 'ask', price, size, { seq: null, ts, venue: this.venue });
    }
  }

  _onTrades(symbol, arr, ts) {
    for (const t of arr || []) {
      // [price, qty, time, side("b"|"s"), orderType, misc]
      const side = t[3] === 's' ? 'sell' : 'buy';
      const tradeTs = Number(t[2]) ? Math.round(Number(t[2]) * 1000) : ts;
      this.emit('trade', symbol, side, Number(t[0]), Number(t[1]), tradeTs, { seq: null, ts, venue: this.venue });
    }
  }

  _onTicker(symbol, p) {
    if (!p) return;
    const bid = Array.isArray(p.b) ? p.b : [];
    const ask = Array.isArray(p.a) ? p.a : [];
    const last = Array.isArray(p.c) ? p.c : [];
    this.emit('ticker', symbol, {
      bidPrice: Number(bid[0]), bidSize: Number(bid[1]),
      askPrice: Number(ask[0]), askSize: Number(ask[1]),
      lastPrice: Number(last[0]), lastSize: Number(last[1]),
      time: new Date().toISOString(),
    }, { seq: null, venue: this.venue });
  }
}

function _levels(arr) {
  return (arr || []).map(x => Array.isArray(x)
    ? [Number(x[0]), Number(x[1])]
    : [Number(x.price), Number(x.qty != null ? x.qty : x.size)]);
}

module.exports = { KrakenL2Client, WS_URL };
