'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mintAuthToken, widgetRequest, parseFrame, toMpulseSymbol } = require('../lib/mpulse');
const { aggregate: aggregateBbo } = require('../lib/bbo');
const { BookEngine } = require('../lib/book');

test('mpulse: anonymous token, widget request and frame parsing', () => {
  const token = mintAuthToken(1700000000000);
  const raw = Buffer.from(token, 'base64').toString('utf8');
  assert.match(raw, /^1700000000000\|[0-9a-f-]{36}\|\|[0-9a-f]{40}$/);

  const req = widgetRequest('priceChange', 'BTC-USDT');
  assert.equal(req.algoId, 'priceChange');
  assert.equal(req.instrumentType, 'SPOT');
  assert.equal(req.viewId, 'Trades');

  const e = parseFrame(JSON.stringify({
    event: { dataType: 'EstimateDataView', time: 1700000000000000000, data: { estimate: 0.5, value: 0.25 } },
  }));
  assert.equal(e.type, 'estimate');
  assert.equal(e.estimate, 0.5);
  assert.equal(parseFrame('{"type":"AUTH_SUCCESS"}').type, 'AUTH_SUCCESS');
  assert.equal(toMpulseSymbol('BTC-USD'), 'BTC-USDT');
});

test('bbo: picks best bid/ask across venue books without mixing them', () => {
  const a = new BookEngine();
  const b = new BookEngine();
  a.applyLevels({ symbol: 'BTC-USD', bids: [[100, 1]], asks: [[105, 1]], source: 'coinbase' });
  b.applyLevels({ symbol: 'BTC-USD', bids: [[101, 2]], asks: [[104, 2]], source: 'kraken' });
  const books = new Map([['coinbase', { book: a }], ['kraken', { book: b }]]);
  const rows = aggregateBbo(books);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bidPrice, 101);
  assert.equal(rows[0].bidVenue, 'kraken');
  assert.equal(rows[0].askPrice, 104);
  assert.equal(rows[0].askVenue, 'kraken');
  assert.equal(rows[0].spread, 3);
});
