'use strict';
// Replay engines for recorded NDJSON streams (see lib/sink.js output format).
//
//   Replay      fast application: every event applied as fast as possible
//   TimedReplay Bookmap-style Record & Replay (mirrors the desktop app's
//               BookTraderReplayL1: jx reader + providers.s player):
//               paced playback with pause/resume/seek/stop, optional loop and
//               an optional [startTs, endTs] window. Speed steps match the
//               app: x2 up / :2 down, clamped to [0.125, maxSpeed(8192)];
//               speed 0 = pause. Seeking applies events up to the target
//               instantly (the app's rewind-by-state-rebuild), then resumes
//               paced playback from there.
//
// Passes are serialized through _runId/_passPromise/_busy so a seek can retire
// the in-flight paced pass, fast-forward exclusively, and let the run loop
// continue from the seek point (events with ts <= last applied are skipped).

const fs = require('fs');
const readline = require('readline');

const DATA_KINDS = new Set(['snapshot', 'depth', 'trade', 'quote']);

class Replay {
  /**
   * @param {(venue:string)=>object} ensureBook returns {book, metrics} for a venue
   */
  constructor(ensureBook) {
    this.ensureBook = ensureBook;
    this.events = 0;
    this.errors = 0;
  }

  async play(file, emit) {
    const input = fs.createReadStream(file);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = String(line).trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(':')) continue;
        let evt;
        try { evt = JSON.parse(trimmed); }
        catch { this.errors++; continue; }
        if (!evt || !evt.symbol || !evt.kind) continue;
        this.apply(evt);
        if (emit && !DATA_KINDS.has(evt.kind)) emit(evt);
        this.events++;
      }
    } finally {
      await _close(rl, input);
    }
    return { events: this.events, errors: this.errors };
  }

  apply(evt) {
    const venue = evt.venue || 'replay';
    const entry = this.ensureBook(venue);
    if (!entry) return;
    const { book } = entry;
    const d = evt.data || {};
    if (evt.kind === 'snapshot' && evt.levels) {
      const toLevels = (arr) => (arr || []).map((l) => (Array.isArray(l) ? l : [l.price, l.size]));
      book.applyLevels({
        symbol: evt.symbol,
        bids: toLevels(evt.levels.bids),
        asks: toLevels(evt.levels.asks),
        source: venue,
        seq: d.seq != null ? d.seq : null,
        time: d.time,
      });
    } else if (evt.kind === 'depth' && d.side) {
      book.applyLevel(evt.symbol, d.side, d.price, d.size, venue, { seq: d.seq });
    } else if (evt.kind === 'trade') {
      book.applyTrade({ ...d, eventSymbol: evt.symbol, venue });
    } else if (evt.kind === 'quote') {
      book.applyQuote({ ...d, eventSymbol: evt.symbol });
    }
  }
}

/** close a readline interface and its input stream, waiting for the handle to release (Windows) */
async function _close(rl, input) {
  await new Promise((resolve) => {
    rl.once('close', resolve);
    rl.close();
    if (input) input.destroy();
    setTimeout(resolve, 100);
  });
}

class TimedReplay extends Replay {
  /**
   * @param {object} opts
   * @param {number} [opts.speed] playback speed multiplier (default 1 = real time; 0 pauses)
   * @param {number} [opts.maxSpeed] speed-up clamp (default 8192, the app's `max_replay_speed`)
   * @param {number} [opts.minSpeed] speed-down clamp (default 0.125, the app's floor)
   * @param {boolean} [opts.loop] restart from the beginning when the file ends
   * @param {number} [opts.startTs] only play events with ts >= startTs (ms)
   * @param {number} [opts.endTs] only play events with ts <= endTs (ms)
   * @param {number} [opts.chunkMs] pacing granularity (default 250)
   * @param {()=>void} [opts.resetState] called on a backward seek before rebuilding
   *   state from the start (app parity: rewind re-emits the snapshot state)
   */
  constructor(ensureBook, opts = {}) {
    super(ensureBook);
    this.maxSpeed = opts.maxSpeed != null ? Number(opts.maxSpeed) : 8192;
    this.minSpeed = opts.minSpeed != null ? Number(opts.minSpeed) : 0.125;
    this.speed = opts.speed != null ? Math.max(Number(opts.speed) || 0, 0) : 1;
    this.loop = !!opts.loop;
    this.startTs = opts.startTs != null ? Number(opts.startTs) : null;
    this.endTs = opts.endTs != null ? Number(opts.endTs) : null;
    this.chunkMs = opts.chunkMs || 250;
    this.resetState = typeof opts.resetState === 'function' ? opts.resetState : null;
    this.file = null;
    this.emit = null;
    this.playing = false;      // run loop alive (not stopped)
    this.paused = this.speed === 0;
    this.done = false;
    this.ts = null;            // stream time of the last applied event
    this.firstTs = null;
    this._runId = 0;
    this._passPromise = null;
    this._busy = null;         // seek in progress
    this._resolvePause = null;
  }

  status() {
    return {
      file: this.file, playing: this.playing && !this.paused, paused: this.paused,
      done: this.done, seeking: !!this._busy,
      speed: this.paused ? 0 : this.speed, targetSpeed: this.speed,
      maxSpeed: this.maxSpeed, minSpeed: this.minSpeed,
      loop: this.loop,
      ts: this.ts, firstTs: this.firstTs, endTs: this.endTs,
      events: this.events, errors: this.errors,
    };
  }

  /** start paced playback; the returned promise resolves when stopped or exhausted */
  start(file, emit) {
    if (this.playing) throw new Error('replay already running');
    this.file = file;
    this.emit = emit;
    this.playing = true;
    this.done = false;
    this.paused = this.speed === 0;
    this.ts = null;
    this.firstTs = null;
    return this._loop();
  }

  pause() {
    if (!this.playing || this.paused) return false;
    this.paused = true;
    return true;
  }

  resume() {
    if (!this.playing || !this.paused) return false;
    this.paused = false;
    if (this._resolvePause) { const r = this._resolvePause; this._resolvePause = null; r(); }
    return true;
  }

  /** app parity: speed 0 pauses; a positive speed sets the pace and unpauses */
  setSpeed(speed) {
    if (!this.playing) return false;
    const s = Number(speed);
    if (!Number.isFinite(s) || s < 0) return false;
    if (s === 0) {
      this.paused = true;
    } else {
      this.speed = s;
      this.paused = false;
      if (this._resolvePause) { const r = this._resolvePause; this._resolvePause = null; r(); }
    }
    return true;
  }

  /** app parity (E.i): speed up x2, clamped at maxSpeed (default 8192) */
  speedUp() { return this.setSpeed(Math.min(this.speed * 2, this.maxSpeed)); }

  /** app parity (E.j): slow down :2, floored at minSpeed (default 0.125) */
  speedDown() { return this.setSpeed(Math.max(this.speed / 2, this.minSpeed)); }

  /** app parity (E.k): reset to 1.0x */
  resetSpeed() { return this.setSpeed(1); }

  stop() {
    if (!this.playing) return false;
    this.playing = false;
    this.paused = false;
    if (this._resolvePause) { const r = this._resolvePause; this._resolvePause = null; r(); }
    return true;
  }

  /**
   * Jump to a stream timestamp: apply every event with ts <= target instantly,
   * then continue paced playback from there.
   */
  async seek(ts) {
    if (!this.file || !this.playing || this._busy) return false;
    const target = Number(ts);
    if (!Number.isFinite(target)) return false;
    const wasPaused = this.paused;
    this.paused = true;
    this._runId++; // retire the in-flight paced pass at its next checkpoint
    this._busy = (async () => {
      const old = this._passPromise;
      if (old) { try { await old; } catch { /* retired pass */ } }
      if (!this.playing) return false;
      // the retired pass may have applied one event past our knowledge: its
      // last applied ts is this.ts; skip everything at or before it so no
      // event is applied twice
      const lastApplied = this.ts;
      let skipBefore = lastApplied;
      if (lastApplied != null && target < lastApplied) {
        // backward seek: state cannot be un-applied, rebuild it from scratch
        if (this.resetState) {
          try { this.resetState(); } catch { /* keep current state if reset fails */ }
        }
        skipBefore = null;
      }
      await this._fastForward(target, this._runId, skipBefore);
      return true;
    })();
    const ok = await this._busy.catch(() => false);
    this._busy = null;
    if (this.playing) {
      this.paused = wasPaused;
      if (!this.paused && this._resolvePause) {
        const r = this._resolvePause; this._resolvePause = null; r();
      }
    }
    return ok;
  }

  async _loop() {
    while (this.playing) {
      while (this._busy) { try { await this._busy; } catch { /* retired pass */ } }
      if (!this.playing) break;
      this._runId++;
      const runId = this._runId;
      this._passPromise = this._playPass(runId);
      const eof = await this._passPromise;
      if (!this.playing) break;
      if (eof) {
        if (!this.loop) break;
        this.ts = null; // natural restart from the beginning
      }
      // pass retired early by a seek: run another pass, skipping applied events
    }
    this.done = true;
    this.playing = false;
  }

  /**
   * One paced pass over the file.
   * @returns {boolean} true when the stream was exhausted, false when retired
   */
  async _playPass(runId) {
    const input = fs.createReadStream(this.file);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const skipBefore = this.ts; // events at or before this were applied by a seek
    try {
      for await (const line of rl) {
        if (!this.playing || runId !== this._runId) return false;
        const trimmed = String(line).trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(':')) continue;
        let evt;
        try { evt = JSON.parse(trimmed); }
        catch { this.errors++; continue; }
        if (!evt || !evt.symbol || !evt.kind) continue;
        const ts = Number(evt.ts) || 0;
        if (ts && this.firstTs == null) this.firstTs = ts;
        if (this.startTs != null && ts && ts < this.startTs) continue;
        if (this.endTs != null && ts && ts > this.endTs) return true;
        if (skipBefore != null && ts && ts <= skipBefore) continue;
        if (ts && this.ts != null) await this._sleepUntil(ts, runId);
        if (!this.playing || runId !== this._runId) return false;
        while (this.paused && this.playing && runId === this._runId) {
          await new Promise((r) => { this._resolvePause = r; setTimeout(r, this.chunkMs); });
        }
        if (!this.playing || runId !== this._runId) return false;
        if (ts) this.ts = ts;
        this.apply(evt);
        if (this.emit && !DATA_KINDS.has(evt.kind)) this.emit(evt);
        this.events++;
      }
      return true;
    } finally {
      await _close(rl, input);
    }
  }

  /** instant application of every event with skipBefore < ts <= target (one full read) */
  async _fastForward(target, runId, skipBefore) {
    const input = fs.createReadStream(this.file);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!this.playing || runId !== this._runId) return;
        const trimmed = String(line).trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(':')) continue;
        let evt;
        try { evt = JSON.parse(trimmed); }
        catch { this.errors++; continue; }
        if (!evt || !evt.symbol || !evt.kind) continue;
        const ts = Number(evt.ts) || 0;
        if (ts && ts > target) return;
        if (skipBefore != null && ts && ts <= skipBefore) continue;
        if (ts) this.ts = ts;
        this.apply(evt);
        this.events++;
      }
    } finally {
      await _close(rl, input);
    }
  }

  /** wait until stream time `ts` is reached; virtual time advances at `speed`, frozen while paused */
  async _sleepUntil(ts, runId) {
    let virtual = this.ts;
    let lastReal = Date.now();
    for (;;) {
      if (!this.playing || runId !== this._runId) return;
      const now = Date.now();
      if (!this.paused) virtual += (now - lastReal) * this.speed;
      lastReal = now;
      if (virtual >= ts) return;
      const wait = Math.min(this.chunkMs, Math.max(1, (ts - virtual) / this.speed));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

module.exports = { Replay, TimedReplay };
