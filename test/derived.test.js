'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { outsideLiquidity, correlation, DepthSignals } = require('../lib/derived');

test('outsideLiquidity: aggregates depth beyond the top N levels', () => {
  const snap = {
    bids: Array.from({ length: 8 }, (_, i) => ({ price: 100 - i, size: i + 1 })),
    asks: Array.from({ length: 8 }, (_, i) => ({ price: 101 + i, size: 1 })),
  };
  const r = outsideLiquidity(snap, 5);
  assert.equal(r.levels, 5);
  assert.equal(r.bidLevels, 3);
  assert.equal(r.askLevels, 3);
  assert.equal(r.bidDepth, 6 + 7 + 8);
  assert.equal(r.askDepth, 3);
  assert.ok(r.imbalance > 0);
  assert.equal(outsideLiquidity(null), null);
});

test('correlation: positive, negative and empty series', () => {
  const a = [{ price: 100 }, { price: 110 }, { price: 132 }, { price: 118.8 }, { price: 154.44 }];
  const b = [{ price: 100 }, { price: 110 }, { price: 132 }, { price: 118.8 }, { price: 154.44 }];
  const c = [{ price: 100 }, { price: 90 }, { price: 72 }, { price: 79.2 }, { price: 55.44 }];
  assert.ok(correlation(a, b) > 0.99);
  assert.ok(correlation(a, c) < -0.99);
  assert.equal(correlation([], b), null);
});

test('DepthSignals: depth changes produce liquidity markers', () => {
  const d = new DepthSignals();
  const now = 1000;
  const first = d.onDepth('BTC', { kind: 'depth', data: { side: 'bid', price: 100, size: 5 } }, now);
  const second = d.onDepth('BTC', { kind: 'depth', data: { side: 'bid', price: 100, size: 8 } }, now + 1);
  assert.equal(first.length, 1);
  assert.equal(first[0].delta, 5);
  assert.equal(second[0].delta, 3);
  assert.equal(second[0].kind, 'liquidity');
  assert.equal(d.markersFor('BTC').length, 2);
  d.removeSymbol('BTC');
  assert.equal(d.markersFor('BTC').length, 0);
});

test('DepthSignals: sell trade followed by depth replenishment is absorption', () => {
  const d = new DepthSignals({ absorptionFactor: 2 });
  const now = 1000;
  d.onTrade('BTC', { price: 100, size: 10, side: 'sell' }, now);
  const out = d.onDepth('BTC', { kind: 'depth', data: { side: 'bid', price: 100, size: 20 } }, now + 50);
  assert.ok(out.some((s) => s.kind === 'absorption'));
  assert.equal(d.absorptionFor('BTC').length, 1);
});
