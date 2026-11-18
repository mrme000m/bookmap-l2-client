'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryService, entitlementHours } = require('../lib/history');
const { IndicatorEngine } = require('../lib/indicators');

const DAY = 3600000;

function candle(start, close, extra) {
  return { eventSymbol: 'SPY', time: start, open: close - 1, high: close + 2, low: close - 2, close, volume: 100, count: 5, vwap: close, ...extra };
}

test('entitlementHours: max active limit entries, skips flags/opaques/inactive', () => {
  const ents = {
    'Subscription.HistoricalDepthHours.LOCAL': { kind: 'limit', value: '180', active: true },
    'Subscription.HistoricalDepthHours.EXT:a.BinanceProvider': { kind: 'limit', value: '168', active: true },
    'Subscription.HistoricalDepthHours.EXT:b.BinanceUSProvider': { kind: 'limit', value: '24', active: true },
    'Subscription.HistoricalDepthHours.US': { kind: 'flag', value: '0', active: false },
    'Subscription.HistoricalDepthHours': { kind: 'opaque', value: 'LOCAL:0,US:1', active: false },
    'Subscription.HistoricalDepthHours.Fallback.US': { kind: 'flag', value: '1', active: true },
  };
  const r = entitlementHours(ents);
  assert.equal(r.max, 180);
  assert.equal(r.found.length, 3);
  assert.equal(entitlementHours(null).max, 0);
});

test('HistoryService: ingests candles in order, dedupes aggregation updates', () => {
  const h = new HistoryService({ barMs: 60000 });
  const now = Date.now();
  assert.equal(h.onCandle(candle(now - 5 * 60000, 100)).added, true);
  assert.equal(h.onCandle(candle(now - 4 * 60000, 101)).added, true);
  // aggregation update for the newest candle replaces, does not add
  const upd = h.onCandle(candle(now - 4 * 60000, 101.5, { volume: 250 }));
  assert.equal(upd.added, false);
  assert.equal(h.candlesFor('SPY')[1].close, 101.5);
  // out-of-order late event is dropped
  assert.equal(h.onCandle(candle(now - 6 * 60000, 99)), null);
  assert.equal(h.count('SPY'), 2);
  // live window classification on a fresh service (starts are monotonic per service)
  const h2 = new HistoryService({ barMs: 60000 });
  assert.equal(h2.onCandle(candle(now - 9 * 3600000, 50)).live, false);
  assert.equal(h2.onCandle(candle(now, 105)).live, true);
  assert.equal(h2.onCandle({ eventSymbol: 'SPY' }), null);
  assert.equal(h.symbols()[0], 'SPY');
  h.onCandle({ eventSymbol: 'QQQ', time: now, open: 1, high: 1, low: 1, close: 1 });
  assert.equal(h.symbols().length, 2);
});

test('HistoryService: ring buffer trims to maxCandles', () => {
  const h = new HistoryService({ maxCandles: 3 });
  for (let i = 0; i < 5; i++) h.onCandle(candle(1000 + i * 60000, 10 + i));
  assert.equal(h.count('SPY'), 3);
  const arr = h.candlesFor('SPY');
  assert.equal(arr[0].start, 121000);
  assert.equal(arr[arr.length - 1].start, 241000);
});

test('IndicatorEngine.seedBars: only older bars, deduped, sorted for TA', () => {
  const eng = new IndicatorEngine({ barMs: 60000 });
  const hist = [
    { start: 60000, open: 9, high: 11, low: 8, close: 10, volume: 10 },
    { start: 120000, open: 10, high: 12, low: 9, close: 11, volume: 10 },
  ];
  assert.equal(eng.seedBars('X', hist), 2);
  // duplicate start is skipped
  assert.equal(eng.seedBars('X', [hist[0]]), 0);
  // live trade builds the current bar; a bar at or after the live start is rejected
  eng.onTrade('X', { price: 12, size: 2, side: 'buy' }, 400000);
  // live bar starts at floor(400000/60000)*60000 = 360000
  assert.equal(eng.seedBars('X', [{ start: 360000, open: 1, high: 1, low: 1, close: 1 }]), 0);
  assert.equal(eng.seedBars('X', [{ start: 300000, open: 11.5, high: 12, low: 11, close: 11.8 }]), 1);
  assert.equal(eng.compute('X').bar.close, 12);

  // fresh engine: 20 history bars + one late live trade warm up RSI
  const eng2 = new IndicatorEngine({ barMs: 60000 });
  const hist20 = Array.from({ length: 20 }, (_, i) => ({
    start: 60000 * (i + 1), open: 10, high: 10.5, low: 9.5, close: 10 + (i % 3) - 1, volume: 10,
  }));
  assert.equal(eng2.seedBars('X', hist20), 20);
  eng2.onTrade('X', { price: 11, size: 2, side: 'buy' }, 1200000 + 30000);
  const c = eng2.compute('X');
  assert.ok(c.ta.rsi != null, 'RSI warmed up from history + live trade');
  assert.ok(c.ta.williamsR != null);
  assert.equal(eng2.compute('X').bar.close, 11);
});
