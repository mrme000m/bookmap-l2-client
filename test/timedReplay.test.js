'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BookEngine } = require('../lib/book');
const { TimedReplay } = require('../lib/replay');

function makeFeed(dir, name, events) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

// 11 events, one per 100ms of stream time
const TS = Array.from({ length: 11 }, (_, i) => 1000 + i * 100);

function feedEvents(extra) {
  return TS.map((ts, i) => ({
    ts, symbol: 'BTC-USD', kind: 'trade', venue: 'binance',
    data: { price: 100 + i, size: 1, side: 'buy', seq: i },
    ...(extra ? extra(i, ts) : {}),
  }));
}

async function cleanup(dir) {
  await new Promise((r) => setTimeout(r, 60));
  fs.rmSync(dir, { recursive: true, force: true });
}

test('TimedReplay: paced playback honors speed multiplier', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-timed-'));
  const file = makeFeed(dir, 'feed.jsonl', feedEvents());
  try {
    const book = new BookEngine();
    const tr = new TimedReplay(() => ({ book }), { speed: 50, chunkMs: 20 });
    const t0 = Date.now();
    await tr.start(file);
    const elapsed = Date.now() - t0;
    assert.ok(tr.status().done, 'replay finished');
    // 1000ms of stream time at 50x should take far less than 1000ms of wall time
    assert.ok(elapsed < 900, `elapsed ${elapsed}ms should be < 900ms`);
    const snap = book.snapshot('BTC-USD');
    assert.equal(snap.trade.price, 110);
  } finally {
    await cleanup(dir);
  }
});

test('TimedReplay: speed 0 pauses, setSpeed resumes (app parity)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-timed-'));
  const file = makeFeed(dir, 'feed.jsonl', feedEvents());
  try {
    const book = new BookEngine();
    const tr = new TimedReplay(() => ({ book }), { speed: 0, chunkMs: 20 });
    const p = tr.start(file);
    await new Promise((r) => setTimeout(r, 120));
    let st = tr.status();
    assert.equal(st.speed, 0, 'effective speed is 0 while paused at start');
    assert.equal(st.paused, true);
    assert.ok(st.ts == null || st.ts <= 1000, 'no events applied while paused');
    assert.ok(tr.setSpeed(100));
    await p;
    st = tr.status();
    assert.ok(st.done, 'finished after resume');
    assert.equal(book.snapshot('BTC-USD').trade.price, 110);
  } finally {
    await cleanup(dir);
  }
});

test('TimedReplay: speedUp x2 clamped at maxSpeed, speedDown floored at minSpeed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-timed-'));
  const file = makeFeed(dir, 'feed.jsonl', feedEvents());
  try {
    const book = new BookEngine();
    const tr = new TimedReplay(() => ({ book }), { speed: 1, maxSpeed: 8192, minSpeed: 0.125, chunkMs: 20 });
    const p = tr.start(file);
    for (let i = 0; i < 20; i++) tr.speedUp();
    assert.equal(tr.status().targetSpeed, 8192);
    for (let i = 0; i < 25; i++) tr.speedDown();
    assert.equal(tr.status().targetSpeed, 0.125);
    tr.resetSpeed();
    assert.equal(tr.status().targetSpeed, 1);
    tr.stop();
    await p.catch(() => {});
  } finally {
    await cleanup(dir);
  }
});

test('TimedReplay: seek applies events up to target instantly then continues', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-timed-'));
  const file = makeFeed(dir, 'feed.jsonl', feedEvents());
  try {
    const book = new BookEngine();
    const tr = new TimedReplay(() => ({ book }), { speed: 1, chunkMs: 20 });
    const p = tr.start(file);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(await tr.seek(1800), 'seek succeeded');
    assert.ok(tr.status().ts >= 1800, `ts ${tr.status().ts} >= 1800`);
    await p;
    assert.equal(book.snapshot('BTC-USD').trade.price, 110);
    // exactly 11 trade events, no duplicates from the seek
    assert.equal(tr.events, 11);
  } finally {
    await cleanup(dir);
  }
});

test('TimedReplay: window filter and loop restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-timed-'));
  // a non-data kind so emit fires for every event
  const file = makeFeed(dir, 'feed.jsonl', feedEvents((i, ts) => ({ kind: 'alert', data: { i, ts } })));
  try {
    const book = new BookEngine();
    const emitted = [];
    const tr = new TimedReplay(() => ({ book }), {
      speed: 1000, chunkMs: 10, loop: true, startTs: 1300, endTs: 1500,
    });
    const p = tr.start(file, (evt) => emitted.push(evt));
    // window is 3 events (1300,1400,1500) at 1000x; each loop restart pays the
    // ~100ms file-handle release, so wait for several loops
    await new Promise((r) => setTimeout(r, 600));
    tr.stop();
    await p.catch(() => {});
    assert.ok(emitted.length >= 6, `looped over the window: got ${emitted.length}`);
    const seq = emitted.map((e) => e.data.i);
    assert.deepEqual(seq.slice(0, 3), [3, 4, 5]);
    assert.deepEqual(seq.slice(3, 6), [3, 4, 5]);
  } finally {
    await cleanup(dir);
  }
});

test('TimedReplay: backward seek rebuilds state from scratch (app parity rewind)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-timed-'));
  const file = makeFeed(dir, 'feed.jsonl', feedEvents());
  try {
    const book = new BookEngine();
    const reset = () => { for (const s of book.symbols()) book.removeSymbol(s); };
    const tr = new TimedReplay(() => ({ book }), { speed: 1, chunkMs: 20, resetState: reset });
    const p = tr.start(file);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(await tr.seek(1900));
    assert.equal(book.snapshot('BTC-USD').trade.price, 109);
    // now seek backwards: state is rebuilt from the start up to ts=1200
    assert.ok(await tr.seek(1200));
    assert.equal(book.snapshot('BTC-USD').trade.price, 102);
    await p;
    // state is fully consistent again after the rewind
    const snap = book.snapshot('BTC-USD');
    assert.equal(snap.trade.price, 110);
    assert.equal(snap.lastSeq, 10);
    assert.ok(tr.events >= 11, `all events applied (incl. rewind re-applies): ${tr.events}`);
  } finally {
    await cleanup(dir);
  }
});

test('TimedReplay: stop ends playback early', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-timed-'));
  const file = makeFeed(dir, 'feed.jsonl', feedEvents());
  try {
    const book = new BookEngine();
    const tr = new TimedReplay(() => ({ book }), { speed: 1, chunkMs: 20 });
    const p = tr.start(file);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(tr.stop(), 'stop accepted');
    await p;
    const st = tr.status();
    assert.ok(st.done && !st.playing, 'stopped and done');
    assert.ok(tr.events < 11, `stopped early: ${tr.events} events`);
  } finally {
    await cleanup(dir);
  }
});
