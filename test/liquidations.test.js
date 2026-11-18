'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BinanceFuturesLiq, BybitLinearLiq } = require('../lib/venues/liquidations');

function collect(client, event) {
  const out = [];
  client.on(event, (...a) => out.push(a));
  return out;
}

test('binancef: forceOrder becomes a liquidation event', () => {
  const c = new BinanceFuturesLiq({ symbols: ['BTCUSDT'], symbolMap: { BTCUSDT: 'BTC-USD' } });
  const liqs = collect(c, 'liquidation');
  c._handle({
    e: 'forceOrder', E: 1591150968357,
    o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', q: '0.014', p: '9910', ap: '9910', X: 'FILLED', z: '0.014', T: 1591150968356 },
  });
  assert.equal(liqs.length, 1);
  const [symbol, liq, meta] = liqs[0];
  assert.equal(symbol, 'BTC-USD');
  assert.equal(liq.side, 'sell');
  assert.equal(liq.price, 9910);
  assert.equal(liq.size, 0.014);
  assert.equal(liq.status, 'FILLED');
  assert.equal(meta.venue, 'binancef');
  c._handle({ e: 'depthUpdate' });
  assert.equal(liqs.length, 1);
});

test('bybitlin: allLiquidation items become liquidation events', () => {
  const c = new BybitLinearLiq({ symbols: ['BTCUSDT'], symbolMap: { BTCUSDT: 'BTC-USD' } });
  const liqs = collect(c, 'liquidation');
  c._handle({
    topic: 'allLiquidation.BTCUSDT', type: 'snapshot', ts: 1720000000000,
    data: [
      { T: 1720000000000, s: 'BTCUSDT', S: 'Buy', v: '0.03', P: '21551.5', X: '' },
      { T: 1720000000100, s: 'BTCUSDT', S: 'Sell', v: '0.05', P: '21550.5', X: '' },
    ],
  });
  assert.equal(liqs.length, 2);
  assert.equal(liqs[0][0], 'BTC-USD');
  assert.equal(liqs[0][1].side, 'buy');
  assert.equal(liqs[1][1].side, 'sell');
  assert.equal(liqs[1][1].price, 21550.5);
  c._handle({ topic: 'orderbook.50.BTCUSDT', data: {} });
  assert.equal(liqs.length, 2);
});

test('liquidation venues: staleness relaxed and registry wired', () => {
  assert.ok(new BinanceFuturesLiq({}).stalenessMs >= 120000);
  assert.ok(new BybitLinearLiq({}).stalenessMs >= 120000);
  const { createVenue } = require('../lib/venues');
  const bf = createVenue('binancef', { symbols: ['BTC-USD'] });
  assert.equal(bf.venue, 'binancef');
  assert.deepEqual(bf.symbols, ['BTCUSDT']);
  const bl = createVenue('bybitlin', { symbols: ['ETH-USD'] });
  assert.deepEqual(bl.symbols, ['ETHUSDT']);
});
