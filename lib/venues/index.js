'use strict';
// Venue registry: symbol normalization and adapter factory.

const { CoinbaseL2Client } = require('./coinbase');
const { BinanceL2Client } = require('./binance');
const { KrakenL2Client } = require('./kraken');
const { OkxL2Client } = require('./okx');
const { BybitL2Client } = require('./bybit');
const { BitstampL2Client } = require('./bitstamp');

function _ccy(symbol) {
  const parts = String(symbol).split('-');
  const base = parts[0].toUpperCase();
  const quote = (parts[1] || '').toUpperCase();
  if (quote === 'USD') return base + 'USDT';
  return base + quote;
}

const VENUES = {
  coinbase: {
    client: CoinbaseL2Client,
    normalize: s => String(s).toUpperCase(),
    aliases: () => [],
  },
  binance: {
    client: BinanceL2Client,
    normalize: _ccy,
    aliases: () => [],
  },
  kraken: {
    client: KrakenL2Client,
    normalize: s => {
      const parts = String(s).split('-');
      const base = parts[0].toUpperCase() === 'BTC' ? 'XBT' : parts[0].toUpperCase();
      return `${base}/${(parts[1] || '').toUpperCase()}`;
    },
    aliases: s => {
      const parts = String(s).split('-');
      return parts[0].toUpperCase() === 'BTC' ? [`BTC/${(parts[1] || '').toUpperCase()}`] : [];
    },
  },
  okx: {
    client: OkxL2Client,
    normalize: s => {
      const parts = String(s).split('-');
      const base = parts[0].toUpperCase();
      const quote = (parts[1] || '').toUpperCase();
      return `${base}-${quote === 'USD' ? 'USDT' : quote}`;
    },
    aliases: () => [],
  },
  bybit: {
    client: BybitL2Client,
    normalize: _ccy,
    aliases: () => [],
  },
  bitstamp: {
    client: BitstampL2Client,
    normalize: s => String(s).replace(/-/g, '').toLowerCase(),
    aliases: () => [],
  },
};

function normalizeSymbol(venue, symbol) {
  const def = VENUES[String(venue).toLowerCase()];
  if (!def) throw new Error(`unknown venue "${venue}"; known: ${Object.keys(VENUES).join(', ')}`);
  return def.normalize(symbol);
}

function buildSymbolMap(venue, canonicalSymbols) {
  const def = VENUES[String(venue).toLowerCase()];
  const map = {};
  for (const canonical of canonicalSymbols || []) {
    map[def.normalize(canonical)] = canonical;
    for (const alias of def.aliases(canonical)) map[alias] = canonical;
  }
  return map;
}

function createVenue(venue, opts = {}) {
  const name = String(venue).toLowerCase();
  const def = VENUES[name];
  if (!def) throw new Error(`unknown venue "${venue}"; known: ${Object.keys(VENUES).join(', ')}`);
  const canonical = opts.symbols || [];
  const symbols = canonical.map(s => def.normalize(s));
  return new def.client({
    ...opts,
    venue: name,
    symbols,
    symbolMap: buildSymbolMap(name, canonical),
  });
}

module.exports = { VENUES, createVenue, normalizeSymbol, buildSymbolMap };
