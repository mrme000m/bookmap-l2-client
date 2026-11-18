'use strict';
// Multi-venue best bid/offer. The books themselves stay isolated; this only
// reads their snapshots and picks the best price across venues for the
// "Cross BBO" / consolidated-book feature.

function aggregate(books) {
  const bySymbol = new Map();
  for (const [venue, entry] of books) {
    for (const symbol of entry.book.symbols()) {
      const snap = entry.book.snapshot(symbol);
      if (!snap || !snap.top) continue;
      let row = bySymbol.get(symbol);
      if (!row) {
        row = { symbol, bidPrice: null, bidSize: null, bidVenue: null,
          askPrice: null, askSize: null, askVenue: null, venues: [] };
        bySymbol.set(symbol, row);
      }
      row.venues.push(venue);
      const { bidPrice, bidSize, askPrice, askSize } = snap.top;
      if (Number.isFinite(bidPrice) && (row.bidPrice == null || bidPrice > row.bidPrice)) {
        row.bidPrice = bidPrice; row.bidSize = bidSize; row.bidVenue = venue;
      }
      if (Number.isFinite(askPrice) && (row.askPrice == null || askPrice < row.askPrice)) {
        row.askPrice = askPrice; row.askSize = askSize; row.askVenue = venue;
      }
    }
  }
  const out = [];
  for (const row of bySymbol.values()) {
    const hasTop = row.bidPrice != null && row.askPrice != null;
    out.push({
      ...row,
      spread: hasTop ? row.askPrice - row.bidPrice : null,
      mid: hasTop ? (row.askPrice + row.bidPrice) / 2 : null,
      ts: Date.now(),
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function forSymbol(books, symbol) {
  return aggregate(books).find(b => b.symbol === symbol) || null;
}

module.exports = { aggregate, forSymbol };
