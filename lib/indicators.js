'use strict';
// Indicator substrate built from the L2/trade deltas the client already streams.
// Nothing here needs another feed or a Bookmap seat: it turns raw tape into the
// derived features listed in docs/GLOBAL_PLUS_GAP.md (CVD, OBV, anchored VWAP,
// bars/footprint/POC, RSI/MACD/ADX/Williams %R and large-trade alerts).

const { EventEmitter } = require('events');

const DEFAULTS = {
  barMs: 60000,
  maxBars: 240,
  maxTrades: 10000,
  largeTradeSize: 0,        // 0 disables alerts
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  adxPeriod: 14,
  wrPeriod: 14,
  profileLevels: 20,
};

function signedSize(side, size) {
  return String(side || '').toLowerCase() === 'sell' ? -Math.abs(size) : Math.abs(size);
}

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(closes, period) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function macd(closes, fast, slow, signal) {
  if (closes.length < slow + signal) return null;
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = ef.map((v, i) => v - es[i]);
  const sig = ema(line.slice(slow - 1), signal);
  return {
    macd: line[line.length - 1],
    signal: sig[sig.length - 1],
    histogram: line[line.length - 1] - sig[sig.length - 1],
  };
}

function williamsR(bars, period) {
  if (bars.length < period) return null;
  const win = bars.slice(-period);
  const high = Math.max(...win.map(b => b.high));
  const low = Math.min(...win.map(b => b.low));
  const close = win[win.length - 1].close;
  if (high === low) return 0;
  return -100 * (high - close) / (high - low);
}

function adx(bars, period) {
  if (bars.length <= period) return null;
  let tr = 0, plusDm = 0, minusDm = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    const up = b.high - prev.high;
    const down = prev.low - b.low;
    tr += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
    if (up > down && up > 0) plusDm += up;
    else if (down > up && down > 0) minusDm += down;
  }
  if (tr === 0) return 0;
  const plusDi = 100 * plusDm / tr;
  const minusDi = 100 * minusDm / tr;
  const dx = 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi || 1);
  return dx;
}

function newState() {
  return {
    trades: [],
    cvd: 0,
    obv: 0,
    lastPrice: null,
    vwap: { notional: 0, volume: 0 },
    bars: [],
    bar: null,
    alerts: [],
  };
}

class IndicatorEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.series = new Map();
  }

  _state(symbol) {
    let s = this.series.get(symbol);
    if (!s) { s = newState(); this.series.set(symbol, s); }
    return s;
  }

  removeSymbol(symbol) { return this.series.delete(symbol); }

  /**
   * Seed historical OHLCV bars (e.g. dxFeed Candles) for TA warm-up.
   * Only bars older than the live bar window are accepted; deduped by start.
   * @returns {number} bars added
   */
  seedBars(symbol, bars) {
    const s = this._state(symbol);
    const have = new Set(s.bars.map(b => b.start));
    const currentStart = s.bar ? s.bar.start : Infinity;
    let added = 0;
    for (const b of bars || []) {
      const start = Number(b.start);
      if (!Number.isFinite(start) || start >= currentStart || have.has(start)) continue;
      const volume = Number(b.volume) || 0;
      const close = Number(b.close);
      s.bars.push({
        start, end: b.end != null ? Number(b.end) : start,
        open: Number(b.open), high: Number(b.high), low: Number(b.low), close,
        volume, buyVolume: 0, sellVolume: 0, delta: 0,
        trades: Number(b.count) || 0,
        notional: volume * (Number.isFinite(Number(b.vwap)) && Number(b.vwap) > 0 ? Number(b.vwap) : close),
        footprint: new Map(),
      });
      have.add(start);
      added++;
    }
    if (added) {
      s.bars.sort((a, b) => a.start - b.start);
      if (s.bars.length > this.opts.maxBars) s.bars.splice(0, s.bars.length - this.opts.maxBars);
    }
    return added;
  }

  /** Feed one trade delta (book.js emits kind:'trade'). */
  onTrade(symbol, trade, now) {
    const price = Number(trade && trade.price);
    const size = Number(trade && trade.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    const s = this._state(symbol);
    const side = trade.side || 'buy';
    const signed = signedSize(side, size);
    const notional = price * size;

    s.cvd += signed;
    if (s.lastPrice != null) {
      if (price > s.lastPrice) s.obv += size;
      else if (price < s.lastPrice) s.obv -= size;
    }
    s.lastPrice = price;
    s.vwap.notional += notional;
    s.vwap.volume += size;

    const t = { ts: now, price, size, side, notional };
    s.trades.push(t);
    if (s.trades.length > this.opts.maxTrades) s.trades.splice(0, s.trades.length - this.opts.maxTrades);

    const closedBar = this._addToBar(s, symbol, t);
    let alert = null;
    if (this.opts.largeTradeSize > 0 && size >= this.opts.largeTradeSize) {
      alert = { symbol, kind: 'large-trade', price, size, side, ts: now, threshold: this.opts.largeTradeSize };
      s.alerts.push(alert);
      if (s.alerts.length > 20) s.alerts.shift();
      this.emit('alert', alert);
    }
    return { closedBar, alert };
  }

  _addToBar(s, symbol, t) {
    const start = Math.floor(t.ts / this.opts.barMs) * this.opts.barMs;
    if (!s.bar || start > s.bar.start) {
      if (s.bar) {
        s.bars.push(s.bar);
        if (s.bars.length > this.opts.maxBars) s.bars.shift();
        this.emit('bar', { symbol, bar: s.bar });
      }
      s.bar = {
        start, end: start + this.opts.barMs,
        open: t.price, high: t.price, low: t.price, close: t.price,
        volume: 0, buyVolume: 0, sellVolume: 0, delta: 0, trades: 0,
        notional: 0, footprint: new Map(),
      };
    }
    const b = s.bar;
    b.high = Math.max(b.high, t.price);
    b.low = Math.min(b.low, t.price);
    b.close = t.price;
    b.volume += t.size;
    b.notional += t.notional;
    b.trades++;
    if (t.side === 'sell') b.sellVolume += t.size; else b.buyVolume += t.size;
    b.delta += signedSize(t.side, t.size);
    const fp = b.footprint.get(t.price) || { buy: 0, sell: 0 };
    if (t.side === 'sell') fp.sell += t.size; else fp.buy += t.size;
    b.footprint.set(t.price, fp);
    return null;
  }

  /** Derived values for one symbol. Safe to call repeatedly. */
  compute(symbol) {
    const s = this.series.get(symbol);
    if (!s) return null;
    const bars = s.bars.concat(s.bar ? [s.bar] : []);
    const closes = bars.map(b => b.close);

    const volumeAtPrice = new Map();
    for (const t of s.trades) {
      volumeAtPrice.set(t.price, (volumeAtPrice.get(t.price) || 0) + t.size);
    }
    const levels = [...volumeAtPrice.entries()]
      .map(([price, volume]) => ({ price, volume }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, this.opts.profileLevels);
    const totalProfileVolume = [...volumeAtPrice.values()].reduce((a, b) => a + b, 0);
    let netDelta = 0;
    for (const t of s.trades) netDelta += signedSize(t.side, t.size);
    const strength = totalProfileVolume > 0 ? netDelta / totalProfileVolume : null;
    let acc = 0;
    const valueArea = [];
    for (const l of levels) {
      if (totalProfileVolume > 0 && acc / totalProfileVolume >= 0.7) break;
      valueArea.push(l.price);
      acc += l.volume;
    }

    const currentBar = s.bar ? {
      start: s.bar.start, end: s.bar.end, open: s.bar.open, high: s.bar.high,
      low: s.bar.low, close: s.bar.close, volume: s.bar.volume,
      buyVolume: s.bar.buyVolume, sellVolume: s.bar.sellVolume, delta: s.bar.delta,
      trades: s.bar.trades, notional: s.bar.notional,
      footprint: [...s.bar.footprint.entries()].map(([price, v]) => ({ price, ...v })),
    } : null;

    return {
      cvd: s.cvd,
      obv: s.obv,
      anchoredVwap: s.vwap.volume > 0 ? s.vwap.notional / s.vwap.volume : null,
      strength,
      bar: currentBar,
      bars: bars.length,
      ta: {
        rsi: rsi(closes, this.opts.rsiPeriod),
        macd: macd(closes, this.opts.macdFast, this.opts.macdSlow, this.opts.macdSignal),
        adx: adx(bars, this.opts.adxPeriod),
        williamsR: williamsR(bars, this.opts.wrPeriod),
      },
      profile: {
        poc: levels.length ? levels[0] : null,
        valueArea,
        priceLevels: levels,
      },
      alerts: s.alerts.slice(-5),
    };
  }
}

module.exports = {
  IndicatorEngine, DEFAULTS,
  rsi, macd, adx, williamsR, ema, signedSize,
};
