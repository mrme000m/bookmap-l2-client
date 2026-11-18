'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { CoinbaseL2Client } = require('../lib/venues/coinbase');
const { BinanceL2Client } = require('../lib/venues/binance');
const { KrakenL2Client } = require('../lib/venues/kraken');
const { OkxL2Client } = require('../lib/venues/okx');
const { BybitL2Client } = require('../lib/venues/bybit');
const { BitstampL2Client } = require('../lib/venues/bitstamp');
const { createVenue, normalizeSymbol, VENUES } = require('../lib/venues');

function capture(client) {
  const out = { snapshot: [], update: [], trade: [], ticker: [], gap: [] };
  for (const k of Object.keys(out)) client.on(k, (...a) => out[k].push(a));
  return out;
}

function send(client, obj) {
  client._onRaw(JSON.stringify(obj));
}

test('registry: symbol normalization and factory', () => {
  assert.equal(normalizeSymbol('coinbase', 'btc-usd'), 'BTC-USD');
  assert.equal(normalizeSymbol('binance', 'BTC-USD'), 'BTCUSDT');
  assert.equal(normalizeSymbol('kraken', 'BTC-USD'), 'XBT/USD');
  assert.equal(normalizeSymbol('okx', 'btc-usd'), 'BTC-USDT');
  assert.equal(normalizeSymbol('bybit', 'ETH-USD'), 'ETHUSDT');
  assert.equal(normalizeSymbol('bitstamp', 'BTC-USD'), 'btcusd');
  assert.throws(() => normalizeSymbol('nope', 'BTC-USD'), /unknown venue/);

  const c = createVenue('coinbase', { symbols: ['BTC-USD'] });
  assert.equal(c.venue, 'coinbase');
  assert.deepEqual(c.symbols, ['BTC-USD']);
  assert.equal(c.symbolMap['BTC-USD'], 'BTC-USD');
  assert.deepEqual(Object.keys(VENUES).sort(), ['binance', 'binancef', 'bitstamp', 'bybit', 'bybitlin', 'coinbase', 'kraken', 'okx']);
});

test('coinbase: snapshot, l2update and ticker', () => {
  const c = new CoinbaseL2Client({ symbols: ['BTC-USD'] });
  const ev = capture(c);
  send(c, { type: 'snapshot', product_id: 'BTC-USD', bids: [['100', '1']], asks: [['101', '2']] });
  send(c, { type: 'l2update', product_id: 'BTC-USD', changes: [['buy', '100.5', '3'], ['sell', '101.5', '0']], sequence: 1 });
  send(c, { type: 'ticker', product_id: 'BTC-USD', best_bid: '100', best_ask: '101', price: '100.2', last_size: '0.5', sequence: 2 });

  assert.equal(ev.snapshot.length, 1);
  assert.equal(ev.snapshot[0][0], 'BTC-USD');
  assert.deepEqual(ev.snapshot[0][1], [[100, 1]]);
  assert.equal(ev.update.length, 2);
  assert.deepEqual(ev.update[0], ['BTC-USD', 'bid', 100.5, 3, { seq: 1, ts: ev.update[0][4].ts, venue: 'coinbase' }]);
  assert.equal(ev.update[1][1], 'ask');
  assert.equal(ev.update[1][3], 0);
  assert.equal(ev.ticker.length, 1);
  assert.equal(ev.ticker[0][1].bidPrice, 100);
});

test('coinbase: matches channel becomes a trade event', () => {
  const c = new CoinbaseL2Client({ symbols: ['BTC-USD'] });
  const ev = capture(c);
  send(c, {
    type: 'match', trade_id: 12, maker_order_id: 'a', taker_order_id: 'b',
    side: 'sell', size: '0.25', price: '100.25', product_id: 'BTC-USD',
    sequence: 5, time: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(ev.trade.length, 1);
  assert.equal(ev.trade[0][0], 'BTC-USD');
  assert.equal(ev.trade[0][1], 'sell');
  assert.equal(ev.trade[0][2], 100.25);
  assert.equal(ev.trade[0][3], 0.25);
  assert.equal(ev.trade[0][4], Date.parse('2026-01-01T00:00:00.000Z'));
});

test('binance: buffered depth, trade side and book ticker', () => {
  const c = new BinanceL2Client({ symbols: ['BTCUSDT'], symbolMap: { BTCUSDT: 'BTC-USD' } });
  const ev = capture(c);
  c.ready.set('BTCUSDT', true);
  c.lastUpdateId.set('BTCUSDT', 10);

  send(c, { data: { e: 'depthUpdate', s: 'BTCUSDT', U: 11, u: 12, pu: 10, E: 111, b: [['100', '1']], a: [['101', '2']] } });
  send(c, { data: { e: 'trade', s: 'BTCUSDT', p: '100.5', q: '0.2', m: false, T: 112, t: 5 } });
  send(c, { data: { e: 'bookTicker', s: 'BTCUSDT', b: '100', B: '1', a: '101', A: '2', u: 12 } });
  // bookTicker in the live combined stream has no "e" field
  send(c, { stream: 'btcusdt@bookTicker', data: { u: 13, s: 'BTCUSDT', b: '100.1', B: '3', a: '101.1', A: '4' } });

  assert.equal(ev.update.length, 2);
  assert.equal(ev.update[0][1], 'bid');
  assert.equal(ev.update[0][2], 100);
  assert.equal(ev.update[0][4].seq, 12);
  assert.equal(ev.trade.length, 1);
  assert.equal(ev.trade[0][1], 'buy');
  assert.equal(ev.trade[0][2], 100.5);
  assert.equal(ev.trade[0][3], 0.2);
  assert.equal(ev.ticker.length, 2);
  assert.equal(ev.ticker[0][1].askPrice, 101);
  assert.equal(ev.ticker[1][1].bidPrice, 100.1);
});

test('binance: sequence gap re-primes and drops updates', () => {
  const c = new BinanceL2Client({ symbols: ['BTCUSDT'], symbolMap: { BTCUSDT: 'BTC-USD' } });
  const ev = capture(c);
  c.ready.set('BTCUSDT', true);
  c.lastUpdateId.set('BTCUSDT', 10);
  send(c, { data: { e: 'depthUpdate', s: 'BTCUSDT', U: 11, u: 12, pu: 10, E: 1, b: [['100', '1']], a: [] } });
  assert.equal(ev.update.length, 1);
  send(c, { data: { e: 'depthUpdate', s: 'BTCUSDT', U: 20, u: 21, pu: 12, E: 2, b: [['101', '1']], a: [] } });
  assert.equal(ev.gap.length, 1);
  assert.equal(c.ready.get('BTCUSDT'), false);
});

test('kraken: book snapshot, incremental update, trade and ticker', () => {
  const c = new KrakenL2Client({ symbols: ['XBT/USD'], symbolMap: { 'XBT/USD': 'BTC-USD', 'BTC/USD': 'BTC-USD' } });
  const ev = capture(c);
  send(c, [1, { bs: [['100', '1']], as: [['101', '2']] }, 'book-100', 'XBT/USD']);
  send(c, [1, { b: [['100', '0']], a: [] }, 'book-100', 'XBT/USD']);
  send(c, [2, [['100.5', '0.1', '1767225600', 's', 'limit', '']], 'trade', 'XBT/USD']);
  send(c, [3, { b: ['100', '1'], a: ['101', '2'], c: ['100.5', '0.1'] }, 'ticker', 'XBT/USD']);

  assert.equal(ev.snapshot.length, 1);
  assert.deepEqual(ev.snapshot[0][1], [[100, 1]]);
  assert.equal(ev.update.length, 1);
  assert.equal(ev.update[0][1], 'bid');
  assert.equal(ev.update[0][3], 0);
  assert.equal(ev.trade.length, 1);
  assert.equal(ev.trade[0][1], 'sell');
  assert.equal(ev.trade[0][2], 100.5);
  assert.equal(ev.ticker.length, 1);
  assert.equal(ev.ticker[0][1].askSize, 2);
});

test('okx: snapshot, seq update, trades and tickers', () => {
  const c = new OkxL2Client({ symbols: ['BTC-USDT'] });
  const ev = capture(c);
  send(c, { arg: { channel: 'books', instId: 'BTC-USDT' }, data: [{ bids: [['100', '1', '0', '1']], asks: [['101', '2', '0', '1']], ts: '111', seqId: 5, action: 'snapshot' }] });
  send(c, { arg: { channel: 'books', instId: 'BTC-USDT' }, data: [{ bids: [['100', '2', '0', '1']], asks: [], ts: '112', seqId: 6, prevSeqId: 5 }] });
  send(c, { arg: { channel: 'trades', instId: 'BTC-USDT' }, data: [{ px: '100.5', sz: '0.2', side: 'sell', ts: '113', tradeId: '9' }] });
  send(c, { arg: { channel: 'tickers', instId: 'BTC-USDT' }, data: [{ bidPx: '100', bidSz: '1', askPx: '101', askSz: '2', last: '100.5', lastSz: '0.2', ts: '113' }] });

  assert.equal(ev.snapshot.length, 1);
  assert.deepEqual(ev.snapshot[0][1], [[100, 1]]);
  assert.equal(ev.update.length, 1);
  assert.equal(ev.update[0][1], 'bid');
  assert.equal(ev.update[0][3], 2);
  assert.equal(ev.trade.length, 1);
  assert.equal(ev.trade[0][1], 'sell');
  assert.equal(ev.ticker.length, 1);
  assert.equal(ev.ticker[0][1].lastPrice, 100.5);
});

test('okx: prevSeqId gap triggers resubscribe', () => {
  const c = new OkxL2Client({ symbols: ['BTC-USDT'] });
  const ev = capture(c);
  let sent = 0;
  c.send = () => { sent++; return true; };
  c.lastSeq.set('BTC-USDT', 5);
  send(c, { arg: { channel: 'books', instId: 'BTC-USDT' }, data: [{ bids: [], asks: [], ts: '1', seqId: 7, prevSeqId: 4 }] });
  assert.equal(ev.gap.length, 1);
  assert.equal(sent, 1);
});

test('bybit: orderbook snapshot then delta, trades and tickers', () => {
  const c = new BybitL2Client({ symbols: ['BTCUSDT'], symbolMap: { BTCUSDT: 'BTC-USD' } });
  const ev = capture(c);
  send(c, { topic: 'orderbook.50.BTCUSDT', type: 'snapshot', ts: 111, data: { s: 'BTCUSDT', b: [['100', '1']], a: [['101', '2']], u: 5 } });
  send(c, { topic: 'orderbook.50.BTCUSDT', type: 'delta', ts: 112, data: { s: 'BTCUSDT', b: [['100', '2']], a: [], u: 6 } });
  send(c, { topic: 'publicTrade.BTCUSDT', type: 'trade', data: [{ s: 'BTCUSDT', S: 'Sell', p: '100.5', v: '0.2', T: 113, i: '9' }] });
  send(c, { topic: 'tickers.BTCUSDT', type: 'snapshot', data: { symbol: 'BTCUSDT', bid1Price: '100', bid1Size: '1', ask1Price: '101', ask1Size: '2', lastPrice: '100.5' } });

  assert.equal(ev.snapshot.length, 1);
  assert.deepEqual(ev.snapshot[0][1], [[100, 1]]);
  assert.equal(ev.update.length, 1);
  assert.equal(ev.update[0][3], 2);
  assert.equal(ev.trade.length, 1);
  assert.equal(ev.trade[0][1], 'sell');
  assert.equal(ev.ticker.length, 1);
  assert.equal(ev.ticker[0][1].bidSize, 1);
});

test('bitstamp: order book snapshot, diff and trade', () => {
  const c = new BitstampL2Client({ symbols: ['btcusd'], symbolMap: { btcusd: 'BTC-USD' } });
  const ev = capture(c);
  send(c, { event: 'data', channel: 'order_book_btcusd', data: { bids: [['100', '1']], asks: [['101', '2']], microtimestamp: '111000' } });
  send(c, { event: 'data', channel: 'diff_order_book_btcusd', data: { bids: [['100', '2']], asks: [], microtimestamp: '112000' } });
  send(c, { event: 'trade', channel: 'live_trades_btcusd', data: { price: '100.5', amount: '0.2', type: 1, id: 9, microtimestamp: '113000' } });

  assert.equal(ev.snapshot.length, 1);
  assert.deepEqual(ev.snapshot[0][1], [[100, 1]]);
  assert.equal(ev.update.length, 1);
  assert.equal(ev.update[0][1], 'bid');
  assert.equal(ev.trade.length, 1);
  assert.equal(ev.trade[0][1], 'sell');
  assert.equal(ev.trade[0][2], 100.5);
});

test('runtime subscription: add and remove symbols per venue', () => {
  const sent = [];
  const c = new CoinbaseL2Client({ symbols: ['BTC-USD'] });
  c.send = (m) => { sent.push(m); return true; };

  const added = c.addSymbols(['ETH-USD', 'BTC-USD']);
  assert.deepEqual(added, ['ETH-USD']);
  assert.deepEqual(c.symbols, ['BTC-USD', 'ETH-USD']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].product_ids, ['ETH-USD']);
  assert.ok(sent[0].channels.includes('level2_batch'));

  const removed = c.removeSymbols(['ETH-USD']);
  assert.deepEqual(removed, ['ETH-USD']);
  assert.deepEqual(c.symbols, ['BTC-USD']);
  assert.equal(sent[1].type, 'unsubscribe');
  assert.deepEqual(sent[1].product_ids, ['ETH-USD']);
  // coinbase rejects "unsubscribe" without a channels list
  assert.ok(Array.isArray(sent[1].channels) && sent[1].channels.includes('level2_batch'));

  // removing an unknown symbol is a no-op
  assert.deepEqual(c.removeSymbols(['NOPE-USD']), []);
});

test('runtime subscription: kraken/okx/bybit/bitstamp send incremental messages', () => {
  const mk = (Cls, opts, check) => {
    const sent = [];
    const c = new Cls(opts);
    c.send = (m) => { sent.push(m); return true; };
    c.addSymbols(opts.add);
    check(sent);
  };

  mk(KrakenL2Client, { symbols: ['XBT/USD'], add: ['ETH/USD'] }, (sent) => {
    assert.equal(sent.length, 3);
    assert.equal(sent[0].event, 'subscribe');
    assert.deepEqual(sent[0].pair, ['ETH/USD']);
  });
  mk(OkxL2Client, { symbols: ['BTC-USDT'], add: ['ETH-USDT'] }, (sent) => {
    assert.equal(sent.length, 1);
    assert.equal(sent[0].op, 'subscribe');
    assert.ok(sent[0].args.some(a => a.instId === 'ETH-USDT'));
  });
  mk(BybitL2Client, { symbols: ['BTCUSDT'], add: ['ETHUSDT'] }, (sent) => {
    assert.equal(sent.length, 1);
    assert.equal(sent[0].op, 'subscribe');
    assert.ok(sent[0].args.includes('orderbook.50.ETHUSDT'));
  });
  mk(BitstampL2Client, { symbols: ['btcusd'], add: ['ethusd'] }, (sent) => {
    assert.equal(sent.length, 3);
    assert.equal(sent[0].event, 'bts:subscribe');
    assert.equal(sent[0].data.channel, 'order_book_ethusd');
  });
});

test('runtime subscription: binance rebuilds the stream URL', () => {
  const c = new BinanceL2Client({ symbols: ['BTCUSDT'] });
  assert.ok(c.url.includes('btcusdt@depth20@100ms'));
  c.addSymbols(['ETHUSDT']);
  assert.ok(c.url.includes('ethusdt@depth20@100ms'));
  assert.ok(c.url.includes('btcusdt@depth20@100ms'));
});
