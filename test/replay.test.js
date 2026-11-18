'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BookEngine } = require('../lib/book');
const { Replay } = require('../lib/replay');

test('replay: rebuilds book state from a recorded NDJSON stream', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-replay-'));
  const file = path.join(dir, 'feed.jsonl');
  const events = [
    { ts: 1, symbol: 'BTC-USD', kind: 'snapshot', venue: 'coinbase', data: { seq: 1 },
      levels: { bids: [{ price: 100, size: 2 }], asks: [{ price: 101, size: 3 }] } },
    { ts: 2, symbol: 'BTC-USD', kind: 'depth', venue: 'coinbase', data: { side: 'bid', price: 99, size: 4, seq: 2 } },
    { ts: 3, symbol: 'BTC-USD', kind: 'trade', venue: 'coinbase', data: { price: 101, size: 1, side: 'buy', seq: 3 } },
  ];
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  try {
    const book = new BookEngine();
    const replay = new Replay(() => ({ book }));
    const result = await replay.play(file);
    assert.equal(result.events, 3);
    assert.equal(result.errors, 0);
    const snap = book.snapshot('BTC-USD');
    assert.equal(snap.bids.length, 2);
    assert.equal(snap.asks.length, 1);
    assert.equal(snap.lastSeq, 3);
    assert.equal(snap.trade.size, 1);
  } finally {
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay: skips malformed lines and counts them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-replay-'));
  const file = path.join(dir, 'feed.jsonl');
  fs.writeFileSync(file, ': comment\n{nope\n{"symbol":"X","kind":"trade","data":{}}\n');
  try {
    const replay = new Replay(() => null);
    const result = await replay.play(file);
    assert.equal(result.events, 1);
    assert.equal(result.errors, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
