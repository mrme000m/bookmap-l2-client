'use strict';
// Bitstamp WebSocket v2: order_book (snapshot) + diff_order_book (incremental)
// + trade. Channel names carry the lower-case pair, e.g. order_book_btcusd.
//   wss://ws.bitstamp.net

const { VenueBase } = require('./base');

const WS_URL = 'wss://ws.bitstamp.net';

class BitstampL2Client extends VenueBase {
  constructor(opts = {}) {
    super({ venue: 'bitstamp', ...opts, url: opts.url || WS_URL });
  }

  _subscribe() {
    for (const s of this.symbols) {
      this.send({ event: 'bts:subscribe', data: { channel: `order_book_${s}`, pair: s } });
      this.send({ event: 'bts:subscribe', data: { channel: `diff_order_book_${s}`, pair: s } });
      this.send({ event: 'bts:subscribe', data: { channel: `live_trades_${s}`, pair: s } });
    }
  }

  _handle(msg) {
    if (msg.event === 'bts:subscription_succeeded') {
      this.emit('log', 'info', `subscribed ${msg.channel}`);
      return;
    }
    if (msg.event === 'bts:error') {
      this.emit('log', 'error', `bitstamp error: ${JSON.stringify(msg)}`);
      return;
    }
    const channel = msg.channel || '';
    const data = msg.data;
    if (!channel || !data) return;
    const symbol = this.canonical(channel.split('_').pop());
    const ts = Number(data.microtimestamp || data.timestamp) || Date.now();
    if (channel.startsWith('order_book_')) {
      this.emit('snapshot', symbol, _levels(data.bids), _levels(data.asks), { seq: null, ts, venue: this.venue });
    } else if (channel.startsWith('diff_order_book_')) {
      for (const [p, q] of data.bids || []) {
        this.emit('update', symbol, 'bid', Number(p), Number(q), { seq: null, ts, venue: this.venue });
      }
      for (const [p, q] of data.asks || []) {
        this.emit('update', symbol, 'ask', Number(p), Number(q), { seq: null, ts, venue: this.venue });
      }
    } else if (channel.includes('trades')) {
      // type 0 = buy, 1 = sell
      const side = Number(data.type) === 1 ? 'sell' : 'buy';
      this.emit('trade', symbol, side, Number(data.price), Number(data.amount), ts,
        { seq: Number(data.id), venue: this.venue });
    }
  }
}

function _levels(arr) {
  return (arr || []).map(([p, q]) => [Number(p), Number(q)]);
}

module.exports = { BitstampL2Client, WS_URL };
