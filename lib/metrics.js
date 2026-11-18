'use strict';
// Realtime per-symbol metrics derived from book deltas and trades:
// spread/mid/microprice, top-N imbalance, depth totals, rolling VWAP and
// buy/sell trade flow over a sliding window, and book update rate.

const { EventEmitter } = require('events');
const { IndicatorEngine } = require('./indicators');
const { outsideLiquidity, correlation, DepthSignals } = require('./derived');

const UPDATE_WINDOW_MS = 1000;

class MetricsEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./book').BookEngine} opts.book
   * @param {number} [opts.windowMs] trade rolling window (default 60000)
   * @param {number} [opts.intervalMs] emit interval (default 1000)
   */
  constructor(opts = {}) {
    super();
    this.book = opts.book;
    this.opts = opts;
    this.windowMs = opts.windowMs || 60000;
    this.intervalMs = opts.intervalMs || 1000;
    this.trades = new Map();
    this.prices = new Map();
    this.updateTimes = new Map();
    this.depthSignals = new DepthSignals(opts);
    this.timer = null;
    this.indicators = new IndicatorEngine(opts);
    this.indicators.on('bar', (b) => this.emit('bar', b));
    this.indicators.on('alert', (a) => this.emit('alert', a));
    this._onDelta = (d) => this.onDelta(d);
    this.book.on('delta', this._onDelta);
  }

  onDelta(d) {
    const now = d.ts || Date.now();
    if (d.kind === 'depth' || d.kind === 'snapshot') {
      const arr = this.updateTimes.get(d.symbol) || [];
      arr.push(now);
      this.updateTimes.set(d.symbol, arr);
      this._prune(this.updateTimes, d.symbol, now - UPDATE_WINDOW_MS);
      for (const sig of this.depthSignals.onDepth(d.symbol, d, now)) this.emit('signal', sig);
    }
    if (d.kind === 'trade') {
      const t = d.data || {};
      const price = Number(t.price);
      const size = Number(t.size);
      if (!Number.isFinite(price) || !Number.isFinite(size)) return;
      const arr = this.trades.get(d.symbol) || [];
      arr.push({
        ts: now, price, size,
        side: t.side || 'buy',
        notional: price * size,
      });
      this.trades.set(d.symbol, arr);
      this._prune(this.trades, d.symbol, now - this.windowMs);
      const prices = this.prices.get(d.symbol) || [];
      prices.push({ ts: now, price });
      this.prices.set(d.symbol, prices);
      this._prune(this.prices, d.symbol, now - this.windowMs);
      this.depthSignals.onTrade(d.symbol, { ...t, side: t.side || 'buy' }, now);
      this.indicators.onTrade(d.symbol, { ...t, side: t.side || 'buy' }, now);
    }
  }

  correlation(a, b) {
    return correlation(this.prices.get(a), this.prices.get(b), this.opts.correlationSamples);
  }

  /** drop all series for a symbol (called after an unsubscribe) */
  removeSymbol(symbol) {
    this.trades.delete(symbol);
    this.prices.delete(symbol);
    this.updateTimes.delete(symbol);
    this.depthSignals.removeSymbol(symbol);
    return this.indicators.removeSymbol(symbol);
  }

  _prune(map, symbol, cutoff) {
    const arr = map.get(symbol) || [];
    let i = 0;
    while (i < arr.length && arr[i].ts < cutoff) i++;
    if (i) arr.splice(0, i);
    map.set(symbol, arr);
  }

  compute(symbol) {
    const snap = this.book.snapshot(symbol);
    if (!snap) return null;
    const top = snap.top || {};
    const bidPrice = Number(top.bidPrice);
    const askPrice = Number(top.askPrice);
    const bidSize = Number(top.bidSize);
    const askSize = Number(top.askSize);
    const hasTop = Number.isFinite(bidPrice) && Number.isFinite(askPrice);

    const spread = hasTop ? askPrice - bidPrice : null;
    const mid = hasTop ? (bidPrice + askPrice) / 2 : null;
    const microprice = hasTop && Number.isFinite(bidSize) && Number.isFinite(askSize) && (bidSize + askSize) > 0
      ? (bidPrice * askSize + askPrice * bidSize) / (bidSize + askSize)
      : null;
    const spreadBps = spread != null && mid ? (spread / mid) * 10000 : null;

    const imbalance = (levels) => {
      let b = 0;
      let a = 0;
      for (let i = 0; i < Math.min(levels, snap.bids.length); i++) b += snap.bids[i].size;
      for (let i = 0; i < Math.min(levels, snap.asks.length); i++) a += snap.asks[i].size;
      const total = b + a;
      return total > 0 ? (b - a) / total : null;
    };

    let bidDepth = 0;
    let askDepth = 0;
    for (const l of snap.bids) bidDepth += l.size;
    for (const l of snap.asks) askDepth += l.size;

    const trades = this.trades.get(symbol) || [];
    let volume = 0;
    let notional = 0;
    let buyVolume = 0;
    let sellVolume = 0;
    let last = null;
    for (const t of trades) {
      volume += t.size;
      notional += t.notional;
      if (t.side === 'sell') sellVolume += t.size; else buyVolume += t.size;
      last = t;
    }

    const updates = this.updateTimes.get(symbol) || [];
    return {
      symbol,
      venue: snap.depthSource,
      ts: Date.now(),
      top: snap.top,
      spread,
      spreadBps,
      mid,
      microprice,
      imbalance: { top5: imbalance(5), top20: imbalance(20) },
      outsideLiquidity: outsideLiquidity(snap, this.opts.outsideLevels),
      liquidity: this.depthSignals.markersFor(symbol),
      absorption: this.depthSignals.absorptionFor(symbol),
      depth: {
        bidLevels: snap.bids.length,
        askLevels: snap.asks.length,
        bidDepth,
        askDepth,
      },
      trade: {
        windowMs: this.windowMs,
        count: trades.length,
        volume,
        notional,
        buyVolume,
        sellVolume,
        vwap: volume > 0 ? notional / volume : null,
        lastPrice: last ? last.price : null,
        lastSide: last ? last.side : null,
      },
      book: {
        updatesPerSec: updates.length,
        lastUpdateMs: snap.serverTime ? Date.now() - snap.serverTime : null,
        lastSeq: snap.lastSeq != null ? snap.lastSeq : null,
      },
      signals: this.indicators.compute(symbol),
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _tick() {
    for (const symbol of this.book.symbols()) {
      const m = this.compute(symbol);
      if (m) this.emit('metrics', m);
    }
  }
}

module.exports = { MetricsEngine, UPDATE_WINDOW_MS };
