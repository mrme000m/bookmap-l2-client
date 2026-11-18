'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { BookEngine } = require('../lib/book');
const { MetricsEngine } = require('../lib/metrics');

test('book engine keeps venue, sequence and trade metadata', () => {
  const book = new BookEngine();
  book.applyLevels({ symbol: 'BTC-USD', bids: [[100, 1]], asks: [[101, 2]], source: 'coinbase', seq: 7 });
  book.applyLevel('BTC-USD', 'bid', 100, 5, 'coinbase', { seq: 8 });
  book.applyTrade({ eventSymbol: 'BTC-USD', price: 100.5, size: 0.2, side: 'sell', venue: 'coinbase', seq: 9, time: Date.now() });

  const snap = book.snapshot('BTC-USD');
  assert.equal(snap.depthSource, 'coinbase');
  assert.equal(snap.lastSeq, 9);
  assert.equal(snap.trade.side, 'sell');
  assert.equal(snap.trade.notional, 20.1);
  assert.equal(snap.bids[0].size, 5);
});

test('applyDomConfigHint records the DOM channel without throwing', () => {
  const book = new BookEngine();
  book.applyDomConfigHint('AAPL');
  const snap = book.snapshot('AAPL');
  assert.equal(snap.symbol, 'AAPL');
  assert.equal(snap.domConfigured, true);
  assert.equal(snap.depthSource, 'none');
});

test('metrics: spread, mid, imbalance and rolling VWAP', () => {
  const book = new BookEngine();
  const m = new MetricsEngine({ book, intervalMs: 60000 });
  book.applyLevels({ symbol: 'BTC-USD', bids: [[100, 1], [99, 2]], asks: [[101, 3]], source: 'coinbase' });
  book.applyTrade({ eventSymbol: 'BTC-USD', price: 100, size: 1, side: 'buy', time: Date.now() });
  book.applyTrade({ eventSymbol: 'BTC-USD', price: 102, size: 1, side: 'sell', time: Date.now() });

  const x = m.compute('BTC-USD');
  assert.equal(x.spread, 1);
  assert.equal(x.mid, 100.5);
  assert.equal(x.microprice, 100.25);
  assert.equal(x.imbalance.top5, 0);
  assert.equal(x.depth.bidDepth, 3);
  assert.equal(x.depth.askDepth, 3);
  assert.equal(x.trade.count, 2);
  assert.equal(x.trade.volume, 2);
  assert.equal(x.trade.vwap, 101);
  assert.equal(x.trade.buyVolume, 1);
  assert.equal(x.trade.sellVolume, 1);
  assert.equal(x.trade.lastSide, 'sell');
  assert.equal(x.venue, 'coinbase');
});

test('metrics: unknown symbol returns null', () => {
  const book = new BookEngine();
  const m = new MetricsEngine({ book });
  assert.equal(m.compute('NOPE'), null);
});

test('metrics: trade window prunes old trades', () => {
  const book = new BookEngine();
  const m = new MetricsEngine({ book, windowMs: 1000 });
  const now = Date.now();
  book.applyLevels({ symbol: 'X', bids: [[1, 1]], asks: [[2, 1]], source: 'coinbase' });
  book.applyTrade({ eventSymbol: 'X', price: 10, size: 1, side: 'buy', time: now });
  m.trades.get('X')[0].ts = now - 5000;
  m.onDelta({ symbol: 'X', kind: 'trade', ts: now, data: { price: 20, size: 1, side: 'buy' } });
  const x = m.compute('X');
  assert.equal(x.trade.count, 1);
  assert.equal(x.trade.vwap, 20);
});
