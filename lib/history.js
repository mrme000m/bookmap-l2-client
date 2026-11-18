'use strict';
// Historical backfill service for the dxFeed path.
//
// The licence carries `Subscription.HistoricalDepthHours.*` entitlements (e.g.
// LOCAL=180h, per-exchange adapters 168h/24h) and
// `Subscription.DxFeed-HistoricalGranularity.*` entries; entitlementHours()
// distills the usable depth from the activation fields. The transport is the
// dxLink FEED channel with per-subscription `fromTime`: requesting `Candle`
// events from `now - hours` makes the server replay historical OHLCV before
// going live, which warms up the TA indicators and feeds GET /history.

const { EventEmitter } = require('events');

const HISTORY_DEPTH_PREFIX = 'Subscription.HistoricalDepthHours.';

/** max active `Subscription.HistoricalDepthHours.*` limit, in hours (0 = none) */
function entitlementHours(entitlements) {
  const none = { max: 0, found: [] };
  if (!entitlements) return none;
  let max = 0;
  const found = [];
  for (const [key, v] of Object.entries(entitlements)) {
    if (!key.startsWith(HISTORY_DEPTH_PREFIX) || !v || v.kind !== 'limit' || v.active !== true) continue;
    const hours = Number(v.value);
    if (Number.isFinite(hours) && hours > 0) {
      found.push({ key, hours });
      if (hours > max) max = hours;
    }
  }
  return { max, found };
}

class HistoryService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.barMs] candle granularity in ms (default 60000)
   * @param {number} [opts.maxCandles] per-symbol ring buffer size (default 5000)
   * @param {number} [opts.hours] requested history depth in hours (0 = live only)
   */
  constructor(opts = {}) {
    super();
    this.barMs = opts.barMs || 60000;
    this.maxCandles = opts.maxCandles || 5000;
    this.hours = Math.max(Number(opts.hours) || 0, 0);
    this.candles = new Map();   // symbol -> array of bars sorted by start
  }

  symbols() { return [...this.candles.keys()]; }

  count(symbol) { return (this.candles.get(symbol) || []).length; }

  /**
   * Ingest one dxFeed Candle event (dxLink FULL format).
   * @returns {{symbol:string, start:number, added:boolean, live:boolean}|null}
   */
  onCandle(ev) {
    if (!ev || !ev.eventSymbol) return null;
    const start = Number(ev.time);
    if (!Number.isFinite(start) || start <= 0) return null;
    const open = Number(ev.open), high = Number(ev.high);
    const low = Number(ev.low), close = Number(ev.close);
    if (![open, high, low, close].every(Number.isFinite)) return null;
    const bar = {
      start,
      end: start + this.barMs,
      open, high, low, close,
      volume: Number(ev.volume) || 0,
      count: Number(ev.count) || 0,
      vwap: Number.isFinite(Number(ev.vwap)) ? Number(ev.vwap) : null,
    };
    let arr = this.candles.get(ev.eventSymbol);
    if (!arr) { arr = []; this.candles.set(ev.eventSymbol, arr); }
    // candles arrive in order; replace the tail on aggregation updates
    const last = arr[arr.length - 1];
    let added;
    if (last && last.start === start) { arr[arr.length - 1] = bar; added = false; }
    else if (last && start < last.start) { return null; }
    else { arr.push(bar); added = true; }
    if (arr.length > this.maxCandles) arr.splice(0, arr.length - this.maxCandles);
    // bars older than the live window are indicator warm-up material
    return { symbol: ev.eventSymbol, start, added, live: start >= Date.now() - this.barMs };
  }

  candlesFor(symbol, limit) {
    const arr = this.candles.get(symbol) || [];
    const n = limit != null ? Math.max(Number(limit) || 0, 1) : arr.length;
    return arr.slice(-n);
  }
}

module.exports = { HistoryService, entitlementHours, HISTORY_DEPTH_PREFIX };
