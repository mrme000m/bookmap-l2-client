'use strict';
// L2 order book engine.
// Depth sources, in priority order per symbol:
//   1. DOM service snapshots (full L2 replace)
//   2. MarketDepth events (incremental L2)
//   3. Quote events (top-of-book fallback)

const { EventEmitter } = require('events');

const DEPTH_REMOVE_FLAG = 0x02; // dxFeed EventFlag.REMOVE_EVENT

class BookEngine extends EventEmitter {
  constructor() {
    super();
    this.books = new Map(); // symbol -> state
    this.seq = 0;
  }

  _state(symbol) {
    let s = this.books.get(symbol);
    if (!s) {
      s = {
        symbol,
        depthSource: 'none',
        bids: new Map(), // price(number) -> size(number)
        asks: new Map(),
        quote: null,     // {bidPrice,bidSize,askPrice,askSize,time}
        trade: null,     // {price,size,dayVolume,time}
        updatedAt: 0,
      };
      this.books.set(symbol, s);
    }
    return s;
  }

  symbols() { return [...this.books.keys()]; }

  // ---- incremental MarketDepth ----

  /** @param {object} ev MarketDepth event: eventSymbol, bidAsk('B'|'A'), market, price, size, eventFlags */
  applyMarketDepth(ev) {
    const s = this._state(ev.eventSymbol);
    const side = ev.bidAsk === 'B' ? s.bids : ev.bidAsk === 'A' ? s.asks : null;
    if (!side) return;
    const price = Number(ev.price);
    if (!Number.isFinite(price)) return;
    const size = Number(ev.size);
    const flags = _flags(ev.eventFlags);
    const remove = (flags & DEPTH_REMOVE_FLAG) !== 0 || size === 0 || ev.size === 'NaN';

    if (remove) {
      // dxFeed semantics: REMOVE clears all depth entries at that price
      for (const p of side.keys()) {
        if (p === price) side.delete(p);
      }
    } else if ((flags & DEPTH_REMOVE_FLAG) === 0) {
      side.set(price, size);
    }
    s.depthSource = s.depthSource === 'none' ? 'marketdepth' : s.depthSource;
    s.updatedAt = Date.now();
    this._emitDelta(s, 'depth', { side: ev.bidAsk === 'B' ? 'bid' : 'ask', price, size: remove ? 0 : size, eventFlags: ev.eventFlags });
  }

  // ---- top of book ----

  /** @param {object} ev Quote event: eventSymbol, bidPrice, bidSize, askPrice, askSize, ... */
  applyQuote(ev) {
    const s = this._state(ev.eventSymbol);
    s.quote = {
      bidPrice: _num(ev.bidPrice), bidSize: _num(ev.bidSize),
      askPrice: _num(ev.askPrice), askSize: _num(ev.askSize),
      time: ev.eventTime || ev.time || Date.now(),
    };
    if (s.depthSource === 'none') s.depthSource = 'quote';
    s.updatedAt = Date.now();
    this._emitDelta(s, 'quote', s.quote);
  }

  /** @param {object} ev Trade event: eventSymbol, price, size, dayVolume, ... */
  applyTrade(ev) {
    const s = this._state(ev.eventSymbol);
    s.trade = { price: _num(ev.price), size: _num(ev.size), dayVolume: _num(ev.dayVolume), time: ev.eventTime || ev.time || Date.now() };
    s.updatedAt = Date.now();
    this._emitDelta(s, 'trade', s.trade);
  }

  // ---- full DOM snapshot ----

  /** @param {object} msg DOM_SNAPSHOT message {symbol,time,bids:[{price,size}],asks:[...]} */
  applyDomSnapshot(msg) {
    const symbol = msg.symbol;
    const s = this._state(symbol);
    s.bids = new Map((msg.bids || []).map(o => [Number(o.price), Number(o.size)]));
    s.asks = new Map((msg.asks || []).map(o => [Number(o.price), Number(o.size)]));
    s.depthSource = 'dom';
    s.updatedAt = Date.now();
    this._emitDelta(s, 'snapshot', { time: msg.time });
  }

  // ---- generic full-book snapshot (crypto venues) ----

  /**
   * Replace a whole book with level arrays.
   * @param {object} msg {symbol, time?, bids:[[price,size]], asks:[[price,size]], source?}
   */
  applyLevels(msg) {
    const s = this._state(msg.symbol);
    const toMap = (levels) => new Map((levels || []).map(([p, z]) => [Number(p), Number(z)]));
    s.bids = toMap(msg.bids);
    s.asks = toMap(msg.asks);
    if (msg.source) s.depthSource = msg.source;
    else if (s.depthSource === 'none') s.depthSource = 'levels';
    s.updatedAt = Date.now();
    this._emitDelta(s, 'snapshot', { time: msg.time || Date.now() });
  }

  /**
   * Apply a single level change.
   * @param {string} symbol @param {'bid'|'ask'} side @param {number} price @param {number} size size 0 removes
   * @param {string} [source]
   */
  applyLevel(symbol, side, price, size, source) {
    const s = this._state(symbol);
    const target = side === 'bid' ? s.bids : s.asks;
    const p = Number(price), z = Number(size);
    if (!Number.isFinite(p)) return;
    if (z === 0) target.delete(p); else target.set(p, z);
    if (source) s.depthSource = source;
    else if (s.depthSource === 'none') s.depthSource = 'levels';
    s.updatedAt = Date.now();
    this._emitDelta(s, 'depth', { side, price: p, size: z });
  }

  // ---- output ----

  /** Full L2 snapshot as sorted arrays: bids desc, asks asc. */
  snapshot(symbol) {
    const s = this.books.get(symbol);
    if (!s) return null;
    const bids = [...s.bids.entries()].filter(([, z]) => z > 0)
      .sort((a, b) => b[0] - a[0]).map(([price, size]) => ({ price, size }));
    const asks = [...s.asks.entries()].filter(([, z]) => z > 0)
      .sort((a, b) => a[0] - b[0]).map(([price, size]) => ({ price, size }));
    let top;
    if (bids.length || asks.length) {
      top = {
        bidPrice: bids.length ? bids[0].price : null, bidSize: bids.length ? bids[0].size : null,
        askPrice: asks.length ? asks[0].price : null, askSize: asks.length ? asks[0].size : null,
      };
    } else if (s.quote) {
      top = { bidPrice: s.quote.bidPrice, bidSize: s.quote.bidSize, askPrice: s.quote.askPrice, askSize: s.quote.askSize };
    }
    return {
      symbol: s.symbol, seq: ++this.seq, depthSource: s.depthSource,
      serverTime: s.updatedAt, top, bids, asks, quote: s.quote, trade: s.trade,
    };
  }

  list() { return [...this.books.values()].map(s => ({ symbol: s.symbol, depthSource: s.depthSource, updatedAt: s.updatedAt })); }

  _emitDelta(s, kind, data) {
    this.emit('delta', { symbol: s.symbol, kind, data, ts: Date.now(), depthSource: s.depthSource });
  }
}

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function _flags(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const f = v.toUpperCase();
    if (f.includes('REMOVE')) return DEPTH_REMOVE_FLAG;
    if (f.includes('UPDATE')) return 0;
    return 0; // NEW etc.
  }
  if (Array.isArray(v)) return v.reduce((acc, x) => acc | _flags(x), 0);
  return 0;
}

module.exports = { BookEngine };
