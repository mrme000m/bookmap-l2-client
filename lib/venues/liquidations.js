'use strict';
// Liquidation-only feed clients: they emit `liquidation` events and keep no
// order book.
//
//   binancef  Binance USDT-M futures force-order stream  wss://fstream.binance.com/ws/!forceOrder@arr
//   bybitlin  Bybit v5 linear allLiquidation             wss://stream.bybit.com/v5/public/linear
//
// Both streams are quiet for long stretches, so the staleness watchdog is
// relaxed well beyond the data-adapter default.

const { VenueBase } = require('./base');

const BINANCEF_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const BYBITLIN_URL = 'wss://stream.bybit.com/v5/public/linear';

class BinanceFuturesLiq extends VenueBase {
  constructor(opts = {}) {
    super({ venue: 'binancef', ...opts, url: opts.url || BINANCEF_URL });
    this.stalenessMs = Math.max(this.stalenessMs, 120000);
  }

  canonical(native) {
    if (this.symbolMap[native]) return this.symbolMap[native];
    return native;
  }

  _subscribe() {}

  _handle(data) {
    if (!data || data.e !== 'forceOrder') return;
    const o = data.o || {};
    const size = Number(o.z != null ? o.z : o.q);
    if (!o.s || !Number.isFinite(size)) return;
    this.emit('liquidation', this.canonical(o.s), {
      side: String(o.S).toLowerCase() === 'sell' ? 'sell' : 'buy',
      price: Number(o.ap != null ? o.ap : o.p),
      size,
      status: o.X || null,
      orderType: o.o || null,
      time: Number(o.T) || Date.now(),
    }, { seq: null, ts: Number(data.E) || Date.now(), venue: this.venue });
  }
}

class BybitLinearLiq extends VenueBase {
  constructor(opts = {}) {
    super({ venue: 'bybitlin', ...opts, url: opts.url || BYBITLIN_URL });
    this.stalenessMs = Math.max(this.stalenessMs, 120000);
  }

  canonical(native) {
    if (this.symbolMap[native]) return this.symbolMap[native];
    return native;
  }

  static _topics(symbols) {
    return (symbols || []).map((s) => `allLiquidation.${s}`);
  }

  _subscribe() {
    const args = BybitLinearLiq._topics(this.symbols);
    if (args.length) this.send({ op: 'subscribe', args });
  }

  _subscribeSymbols(added) {
    const args = BybitLinearLiq._topics(added);
    if (args.length) this.send({ op: 'subscribe', args });
    return true;
  }

  _unsubscribeSymbols(removed) {
    const args = BybitLinearLiq._topics(removed);
    if (args.length) this.send({ op: 'unsubscribe', args });
    return true;
  }

  _keepalive() {
    this.send({ op: 'ping' });
  }

  _handle(msg) {
    if (msg && msg.op === 'pong') return;
    const topic = msg && msg.topic;
    if (!topic || !topic.startsWith('allLiquidation.')) return;
    for (const l of (msg.data || [])) {
      const size = Number(l.v);
      if (!l.s || !Number.isFinite(size)) continue;
      this.emit('liquidation', this.canonical(l.s), {
        side: String(l.S).toLowerCase() === 'sell' ? 'sell' : 'buy',
        price: Number(l.P),
        size,
        status: l.X || null,
        orderType: null,
        time: Number(l.T) || Date.now(),
      }, { seq: null, ts: Number(msg.ts) || Date.now(), venue: this.venue });
    }
  }
}

module.exports = { BinanceFuturesLiq, BybitLinearLiq, BINANCEF_URL, BYBITLIN_URL };
