'use strict';

const fs = require('fs');
const readline = require('readline');

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
        if (emit && !['snapshot', 'depth', 'trade', 'quote'].includes(evt.kind)) emit(evt);
        this.events++;
      }
    } finally {
      await new Promise((resolve) => {
        rl.once('close', resolve);
        rl.close();
        input.destroy();
        setTimeout(resolve, 100);
      });
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

module.exports = { Replay };
