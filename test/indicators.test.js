'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IndicatorEngine } = require('../lib/indicators');

test('indicators: CVD, OBV, anchored VWAP, footprint, strength, alerts', () => {
  const eng = new IndicatorEngine({ barMs: 60000, largeTradeSize: 5 });
  const t0 = 1700000000000;
  eng.onTrade('BTC-USD', { price: 100, size: 2, side: 'buy' }, t0);
  eng.onTrade('BTC-USD', { price: 102, size: 3, side: 'sell' }, t0 + 10);
  const r = eng.onTrade('BTC-USD', { price: 101, size: 5, side: 'buy' }, t0 + 20);

  const s = eng.compute('BTC-USD');
  assert.equal(s.cvd, 4);                 // +2 -3 +5
  assert.equal(s.obv, -2);                // price up +3, then down -5
  assert.ok(Math.abs(s.anchoredVwap - 101.1) < 1e-9);
  assert.ok(Math.abs(s.strength - 0.4) < 1e-9);
  assert.equal(s.bar.volume, 10);
  assert.equal(s.bar.buyVolume, 7);
  assert.equal(s.bar.sellVolume, 3);
  assert.equal(s.bar.delta, 4);
  assert.equal(s.profile.poc.price, 101);
  assert.equal(s.profile.poc.volume, 5);
  assert.equal(s.alerts.length, 1);
  assert.equal(r.alert.kind, 'large-trade');
});

test('indicators: closes a bar when the window advances and emits it', () => {
  const eng = new IndicatorEngine({ barMs: 1000 });
  let closed = null;
  eng.on('bar', (b) => { closed = b; });
  eng.onTrade('X', { price: 10, size: 1, side: 'buy' }, 1000);
  eng.onTrade('X', { price: 11, size: 1, side: 'buy' }, 2000);
  assert.ok(closed);
  assert.equal(closed.bar.open, 10);
  assert.equal(closed.bar.close, 10);
  assert.equal(eng.compute('X').bars, 2);
});

test('indicators: TA values become available from closed bars', () => {
  const eng = new IndicatorEngine({ barMs: 1000 });
  for (let i = 0; i < 40; i++) {
    const price = 100 + (i % 5) * 2 - (i % 3);
    eng.onTrade('X', { price, size: 1, side: i % 2 ? 'buy' : 'sell' }, i * 1000);
  }
  const s = eng.compute('X');
  assert.ok(Number.isFinite(s.ta.rsi));
  assert.ok(s.ta.macd && Number.isFinite(s.ta.macd.macd));
  assert.ok(Number.isFinite(s.ta.adx));
  assert.ok(Number.isFinite(s.ta.williamsR));
});
