'use strict';

const DEFAULTS = {
  markerWindow: 50,
  outsideLevels: 5,
  absorptionWindowMs: 3000,
  absorptionFactor: 2,
  correlationSamples: 60,
};

function outsideLiquidity(snap, levels) {
  if (!snap) return null;
  const n = levels == null ? DEFAULTS.outsideLevels : levels;
  const bids = snap.bids || [];
  const asks = snap.asks || [];
  const sum = (arr) => arr.reduce((a, l) => a + (Number(l.size) || 0), 0);
  const bidDepth = sum(bids.slice(n));
  const askDepth = sum(asks.slice(n));
  const total = bidDepth + askDepth;
  return {
    levels: n,
    bidDepth,
    askDepth,
    bidLevels: Math.max(0, bids.length - n),
    askLevels: Math.max(0, asks.length - n),
    imbalance: total > 0 ? (bidDepth - askDepth) / total : null,
  };
}

function pearson(xs, ys) {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function correlation(seriesA, seriesB, samples) {
  const n = samples == null ? DEFAULTS.correlationSamples : samples;
  if (!seriesA || !seriesB || !seriesA.length || !seriesB.length) return null;
  const returns = (arr) => {
    const out = [];
    for (let i = Math.max(1, arr.length - n - 1); i < arr.length; i++) {
      const prev = Number(arr[i - 1].price);
      const cur = Number(arr[i].price);
      if (Number.isFinite(prev) && Number.isFinite(cur) && prev !== 0) out.push((cur - prev) / prev);
    }
    return out;
  };
  const a = returns(seriesA);
  const b = returns(seriesB);
  const len = Math.min(a.length, b.length);
  if (!len) return null;
  return pearson(a.slice(-len), b.slice(-len));
}

class DepthSignals {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.levels = new Map();
    this.markers = new Map();
    this.trades = new Map();
    this.absorption = new Map();
  }

  _push(map, symbol, evt) {
    const arr = map.get(symbol) || [];
    arr.push(evt);
    while (arr.length > this.opts.markerWindow) arr.shift();
    map.set(symbol, arr);
  }

  onDepth(symbol, d, now) {
    if (!symbol || !d) return [];
    const out = [];
    const data = d.data || {};
    if (d.kind === 'snapshot') {
      this.levels.delete(symbol);
      return out;
    }
    if (d.kind !== 'depth') return out;
    const side = data.side || 'bid';
    const price = Number(data.price);
    const size = Number(data.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return out;
    const levels = this.levels.get(symbol) || new Map();
    const key = side + ':' + price;
    const prev = levels.has(key) ? levels.get(key) : 0;
    levels.set(key, size);
    this.levels.set(symbol, levels);
    const delta = size - prev;
    if (delta !== 0) {
      const marker = { ts: now, symbol, kind: 'liquidity', side, price, size, delta };
      this._push(this.markers, symbol, marker);
      out.push(marker);
    }
    if (delta > 0) {
      const trades = this.trades.get(symbol) || [];
      for (const t of trades) {
        if (t.absorbed) continue;
        if (now - t.ts > this.opts.absorptionWindowMs) continue;
        if (t.side !== 'sell') continue;
        if (Math.abs(t.price - price) > t.tick * 2) continue;
        if (size < t.size * this.opts.absorptionFactor) continue;
        t.absorbed = true;
        const evt = { ts: now, symbol, kind: 'absorption', price: t.price, size: t.size, side: 'sell', replenished: size };
        this._push(this.absorption, symbol, evt);
        out.push(evt);
        break;
      }
    }
    return out;
  }

  onTrade(symbol, t, now) {
    if (!symbol || !t) return [];
    const price = Number(t.price);
    const size = Number(t.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return [];
    const arr = this.trades.get(symbol) || [];
    arr.push({ ts: now, price, size, side: t.side || 'buy', tick: Math.max(price * 1e-6, 1e-9), absorbed: false });
    while (arr.length && now - arr[0].ts > this.opts.absorptionWindowMs) arr.shift();
    this.trades.set(symbol, arr);
    return [];
  }

  markersFor(symbol) { return (this.markers.get(symbol) || []).slice(); }
  absorptionFor(symbol) { return (this.absorption.get(symbol) || []).slice(); }

  removeSymbol(symbol) {
    this.levels.delete(symbol);
    this.markers.delete(symbol);
    this.trades.delete(symbol);
    this.absorption.delete(symbol);
  }
}

module.exports = {
  DEFAULTS: { ...DEFAULTS },
  outsideLiquidity,
  correlation,
  pearson,
  DepthSignals,
};
