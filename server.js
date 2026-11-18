#!/usr/bin/env node
'use strict';
// Bookmap-style persistent L2 market-data service.
//   - dxFeed dxLink (stocks/futures), or
//   - live crypto L2 from several venues (Coinbase, Binance, Kraken, OKX, Bybit,
//     Bitstamp), gated by emulated Bookmap app-level authentication.
//
// Every venue owns its own book and metrics engine, so books are never mixed.
// Books are addressed as "<symbol>" (first venue that tracks it) or "<venue>/<symbol>".
//
// HTTP API:
//   GET /health                      service/feed/auth status
//   GET /symbols                     tracked symbols per venue
//   GET /book/<symbol>               full L2 snapshot JSON
//   GET /book/<venue>/<symbol>       full L2 snapshot of one venue
//   GET /top/<symbol>                L1 top of book
//   GET /metrics                     computed metrics for all tracked symbols
//   GET /metrics/<symbol>            computed metrics for one symbol
//   GET /stream                      SSE stream of book deltas
//                                    (?symbol=&venue=&kinds=&metrics=1)

const http = require('http');
const { URL } = require('url');
const { DxLinkClient } = require('./lib/dxlink');
const { BookEngine } = require('./lib/book');
const { BookmapAuth } = require('./lib/bookmapAuth');
const { MetricsEngine } = require('./lib/metrics');
const { Sink } = require('./lib/sink');
const { createVenue, VENUES } = require('./lib/venues');
const { resolveWebSocket } = require('./lib/ws');
const { featureSummary } = require('./lib/features');
const { aggregate: aggregateBbo } = require('./lib/bbo');
const { MPulseClient, toMpulseSymbol } = require('./lib/mpulse');

// crypto venue -> Bookmap adapter name used for the entitlement check
const VENUE_ADAPTERS = {
  coinbase: 'CoinbasePro',
  binance: 'Binance',
  kraken: 'Kraken',
  okx: 'OKX',
  bybit: 'Bybit',
  bitstamp: 'Bitstamp',
};

const DXFEED_BOOK = 'dxfeed';

// ---- CLI ----
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
}

const email = args.email || process.env.BOOKMAP_EMAIL || '';
const password = args.password || process.env.BOOKMAP_PASSWORD || '';
const licenseKey = args['license-key'] || process.env.BOOKMAP_LICENSE_KEY || '';
const cryptoMode = !!args.crypto;
const authRequired = !!(email || password || licenseKey);

const venues = (args.venues || 'coinbase').split(',').map(s => s.trim()).filter(Boolean);
for (const v of venues) {
  if (!VENUES[v]) {
    console.error(`[fatal] unknown venue "${v}"; known: ${Object.keys(VENUES).join(', ')}`);
    process.exit(1);
  }
}
if (args.venues && !cryptoMode) console.error('[warn] --venues only applies with --crypto; ignoring');

const cfg = {
  url: args.url || 'wss://demo.dxfeed.com/market-data/dxlink-ws',
  token: args.token || process.env.DXFEED_TOKEN || '',
  symbols: (args.symbols || 'AAPL,MSFT,SPY').split(',').map(s => s.trim()).filter(Boolean),
  events: (args.events || 'Quote,Trade,MarketDepth').split(',').map(s => s.trim()).filter(Boolean),
  http: args.http || null,
  stdio: !!args.stdio,
  domSources: (args['dom-sources'] || '').split(',').filter(Boolean),
  domDepth: Number(args['dom-depth'] || 20),
  crypto: cryptoMode,
  venues,
  cryptoSymbols: (args['crypto-symbols'] || 'BTC-USD,ETH-USD').split(',').map(s => s.trim()).filter(Boolean),
  metricsInterval: Number(args['metrics-interval'] || 1000),
  sinkFile: args.sink || null,
  sinkFormat: args['sink-format'] || null,
  sseHeartbeatMs: Number(args['sse-heartbeat'] || 15000),
  stalenessMs: Number(args['staleness-ms'] || 15000),
  restTimeoutMs: Number(args['rest-timeout'] || 10000),
  authRequired,
  authOnly: !!args['auth-only'],
  noDxFeedToken: !!args['no-dxfeed-token'],
  kickSeat: !!args['kick-seat'],
  bindSeat: !!args['bind-seat'],
  barMs: Number(args['bar-ms'] || 60000),
  largeTradeSize: Number(args['large-trade-size'] || 0),
  mpulse: !!args.mpulse,
  mpulseAlgos: (args['mpulse-algos'] || 'priceChange,volumePressureImbalance/TP').split(',').map(s => s.trim()).filter(Boolean),
};

if (!cfg.http && !cfg.stdio && !cfg.authOnly && !cfg.sinkFile) cfg.http = '127.0.0.1:8200';

// ---- engine ----
const startedAt = new Date().toISOString();
let authState = authRequired ? 'authenticating' : 'anonymous';
let authInfo = null;
const sseClients = new Set();
let client = null;                    // DxLinkClient
const cryptoClients = new Map();      // venue -> adapter
const venueStates = new Map();        // venue -> {state, lastFrameAt, detail}
const books = new Map();              // venue -> {venue, book, metrics}
const mpulseClients = new Map();      // symbol -> MPulseClient
let sink = cfg.sinkFile ? new Sink(cfg.sinkFile, cfg.sinkFormat) : null;

function onLog(level, text) { console.error(`[${level}] ${text}`); }

function broadcast(d) {
  if (cfg.stdio) process.stdout.write(JSON.stringify(d) + '\n');
  if (sink) sink.write(d);
  const payload = `data: ${JSON.stringify(d)}\n\n`;
  for (const c of sseClients) {
    if (c.filterSymbol && c.filterSymbol !== d.symbol) continue;
    if (c.venueFilter && c.venueFilter !== d.venue) continue;
    if (c.kinds && !c.kinds.has(d.kind)) continue;
    c.res.write(payload);
  }
}

/** one book + metrics engine per venue, so books are never mixed */
function ensureBook(venue) {
  let entry = books.get(venue);
  if (entry) return entry;
  const book = new BookEngine();
  const metrics = new MetricsEngine({
    book, intervalMs: cfg.metricsInterval,
    barMs: cfg.barMs, largeTradeSize: cfg.largeTradeSize,
  });
  entry = { venue, book, metrics };
  books.set(venue, entry);

  book.on('delta', (d) => broadcast({ ...d, venue }));
  book.on('gap', (g) => broadcast({ symbol: g.symbol, kind: 'gap', data: g.detail, ts: g.ts, venue }));
  metrics.on('metrics', (m) => {
    const evt = { symbol: m.symbol, kind: 'metrics', data: m, ts: Date.now(), venue };
    if (cfg.stdio) process.stdout.write(JSON.stringify(evt) + '\n');
    if (sink) sink.write(evt);
    const payload = `data: ${JSON.stringify(evt)}\n\n`;
    for (const c of sseClients) {
      if (!c.metrics) continue;
      if (c.filterSymbol && c.filterSymbol !== evt.symbol) continue;
      if (c.venueFilter && c.venueFilter !== evt.venue) continue;
      if (c.kinds && !c.kinds.has('metrics')) continue;
      c.res.write(payload);
    }
  });
  metrics.on('bar', (b) => broadcast({ ...b, kind: 'bar', venue }));
  metrics.on('alert', (a) => broadcast({ ...a, kind: 'alert', venue }));
  metrics.start();
  return entry;
}

function wireVenueClient(venue, client) {
  const { book } = ensureBook(venue);
  venueStates.set(venue, { state: 'starting', lastFrameAt: 0, detail: null });
  const touch = () => {
    const st = venueStates.get(venue);
    if (st) st.lastFrameAt = Date.now();
  };
  // ignore late frames for symbols that have been unsubscribed
  const live = (symbol) => client.isSubscribed(symbol);
  client.on('log', onLog);
  client.on('state', (s, detail) => {
    const st = venueStates.get(venue) || {};
    st.state = s;
    st.detail = detail;
    st.lastFrameAt = Date.now();
    venueStates.set(venue, st);
  });
  client.on('snapshot', (symbol, bids, asks, meta) => {
    if (!live(symbol)) return;
    book.applyLevels({
      symbol, bids, asks, source: venue,
      seq: meta && meta.seq != null ? meta.seq : null,
      time: meta && meta.ts ? meta.ts : Date.now(),
    });
    touch();
  });
  client.on('update', (symbol, side, price, size, meta) => {
    if (!live(symbol)) return;
    book.applyLevel(symbol, side, price, size, venue, meta);
    touch();
  });
  client.on('trade', (symbol, side, price, size, ts, meta) => {
    if (!live(symbol)) return;
    book.applyTrade({
      eventSymbol: symbol, price, size, time: ts,
      side, venue, seq: meta && meta.seq != null ? meta.seq : null,
    });
    touch();
  });
  client.on('ticker', (symbol, t) => {
    if (!live(symbol)) return;
    book.applyQuote({
      eventSymbol: symbol,
      bidPrice: t.bidPrice, bidSize: t.bidSize,
      askPrice: t.askPrice, askSize: t.askSize,
      eventTime: t.time,
    });
  });
  client.on('gap', (symbol, detail) => {
    book.emit('gap', { symbol, venue, detail, ts: Date.now() });
  });
  client.on('stale', (info) => {
    onLog('warn', `${venue}: stale (${Math.round((info.idleMs || 0) / 1000)}s); forcing reconnect`);
  });
}

function wireDxLink() {
  const { book } = ensureBook(DXFEED_BOOK);
  client = new DxLinkClient({ url: cfg.url, token: cfg.token });
  client.on('log', onLog);
  client.on('authState', (s) => { authState = s; });
  client.on('error', (e) => console.error(`[feed-error] ${e.error}: ${e.message || ''} (channel=${e.channel})`));
  client.on('feedData', (channel, data) => {
    if (channel !== client.feedChannel || !Array.isArray(data)) return;
    for (const ev of data) {
      if (!ev || !ev.eventSymbol) continue;
      switch (ev.eventType) {
        case 'Quote': book.applyQuote(ev); break;
        case 'Trade': book.applyTrade(ev); break;
        case 'MarketDepth': book.applyMarketDepth(ev); break;
        default: book.emit('other', ev); break;
      }
    }
  });
  client.on('domSnapshot', (msg) => book.applyDomSnapshot(msg));
  client.on('domConfig', (msg) => {
    for (const [symbol, ch] of client.domChannels) {
      if (ch === msg.channel) { msg.symbol = symbol; book.applyDomConfigHint(symbol); break; }
    }
  });
  client.on('domSnapshot', (msg) => {
    if (msg.symbol) return;
    for (const [symbol, ch] of client.domChannels) {
      if (ch === msg.channel) { msg.symbol = symbol; return; }
    }
  });
  client.sendFeedSetup({
    acceptAggregationPeriod: Number(args['aggregation'] || 0.1),
    acceptDataFormat: 'FULL',
    acceptEventFields: {
      Quote: ['eventType', 'eventSymbol', 'bidPrice', 'bidSize', 'askPrice', 'askSize'],
      Trade: ['eventType', 'eventSymbol', 'price', 'size', 'dayVolume'],
      MarketDepth: ['eventType', 'eventSymbol', 'bidAsk', 'market', 'price', 'size', 'eventFlags'],
    },
  });
  client.openFeedChannel(cfg.symbols.flatMap(s => cfg.events.map(t => ({ type: t, symbol: s }))));
  for (const symbol of cfg.symbols) {
    if (cfg.domSources.length) client.openDomChannel(symbol, cfg.domSources, { acceptAggregationPeriod: 0, acceptDepthLimit: cfg.domDepth });
  }
  client.start();
}

// ---- HTTP API ----
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req, cb) {
  let raw = '';
  let done = false;
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 1e6 && !done) { done = true; cb(new Error('body too large')); req.destroy(); }
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    if (!raw.trim()) return cb(null, {});
    try { cb(null, JSON.parse(raw)); } catch (e) { cb(e); }
  });
  req.on('error', (e) => { if (!done) { done = true; cb(e); } });
}

/** split "<venue>/<symbol>" or "<symbol>" */
function splitPath(rest) {
  const parts = rest.split('/').filter(Boolean);
  if (parts.length >= 2) return { venue: decodeURIComponent(parts[0]), symbol: decodeURIComponent(parts.slice(1).join('/')) };
  return { venue: null, symbol: decodeURIComponent(rest) };
}

function findBook(venue, symbol) {
  if (venue) {
    const entry = books.get(venue);
    if (!entry) return null;
    const snap = entry.book.snapshot(symbol);
    return snap ? { venue, snap } : null;
  }
  for (const [v, entry] of books) {
    const snap = entry.book.snapshot(symbol);
    if (snap) return { venue: v, snap };
  }
  return null;
}

function allSymbols() {
  const out = [];
  for (const [venue, entry] of books) {
    for (const s of entry.book.list()) out.push({ venue, ...s });
  }
  return out;
}

/**
 * Runtime symbol subscription for crypto venues.
 * @param {string} venue
 * @param {string[]} canonicalSymbols canonical symbols, e.g. ["SOL-USD"]
 * @param {boolean} remove
 */
function changeSubscription(venue, canonicalSymbols, remove) {
  const client = cryptoClients.get(venue);
  if (!client) {
    return { ok: false, error: `unknown venue "${venue}"`, venues: [...cryptoClients.keys()] };
  }
  const def = VENUES[venue];
  const native = [];
  const canonical = [];
  for (const sym of canonicalSymbols) {
    const n = def.normalize(sym);
    if (!n) continue;
    native.push(n);
    canonical.push(sym);
  }
  const changed = remove ? client.removeSymbols(native) : client.addSymbols(native);
  const entry = books.get(venue);
  for (let i = 0; i < canonical.length; i++) {
    const sym = canonical[i];
    const nat = native[i];
    if (!remove) {
      // make sure the symbol map knows the canonical name for the new native symbol
      client.symbolMap[nat] = sym;
      for (const alias of def.aliases(sym)) client.symbolMap[alias] = sym;
    } else {
      delete client.symbolMap[nat];
      for (const alias of def.aliases(sym)) delete client.symbolMap[alias];
      if (entry) {
        entry.book.removeSymbol(sym);
        entry.metrics.removeSymbol(sym);
      }
    }
  }
  return { ok: true, venue, action: remove ? 'unsubscribe' : 'subscribe', added: changed.length, symbols: canonical };
}

function bookJson(req, res, venue, symbol) {
  const found = findBook(venue, symbol);
  if (!found) return json(res, 404, { error: 'unknown symbol', tracked: allSymbols() });
  json(res, 200, { venue: found.venue, ...found.snap });
}

function metricsJson(req, res, venue, symbol) {
  if (venue) {
    const entry = books.get(venue);
    if (!entry) return json(res, 404, { error: 'unknown venue', venues: [...books.keys()] });
    const m = entry.metrics.compute(symbol);
    if (!m) return json(res, 404, { error: 'unknown symbol', tracked: allSymbols() });
    return json(res, 200, { venue, ...m });
  }
  if (!symbol) {
    const out = [];
    for (const [v, entry] of books) {
      for (const s of entry.book.symbols()) {
        const m = entry.metrics.compute(s);
        if (m) out.push({ venue: v, ...m });
      }
    }
    return json(res, 200, out);
  }
  for (const [v, entry] of books) {
    const m = entry.metrics.compute(symbol);
    if (m) return json(res, 200, { venue: v, ...m });
  }
  return json(res, 404, { error: 'unknown symbol', tracked: allSymbols() });
}

function healthJson(res) {
  const venueHealth = {};
  for (const [name, st] of venueStates) {
    venueHealth[name] = {
      state: st.state,
      lastFrameAt: st.lastFrameAt,
      staleMs: st.lastFrameAt ? Date.now() - st.lastFrameAt : null,
      detail: st.detail || null,
    };
  }
  json(res, 200, {
    status: 'ok', startedAt,
    url: cfg.crypto ? null : cfg.url, authState,
    auth: authInfo ? {
      licenseKey: authInfo.licenseKey,
      activation: authInfo.activation.result,
      dxfeed: authInfo.dxfeed ? { filters: authInfo.dxfeed.filters, code: authInfo.dxfeed.code, hasToken: !!authInfo.dxfeed.token } : null,
      crypto: authInfo.crypto ? { adapters: authInfo.crypto.adapters, maxInstruments: authInfo.crypto.maxInstruments } : null,
    } : null,
    mode: cfg.crypto ? 'crypto' : 'dxfeed',
    venues: cfg.crypto ? venueHealth : null,
    connected: cfg.crypto ? (cryptoClients.size ? 'multi' : 'idle') : (client ? client.state : 'idle'),
    mpulse: mpulseClients.size ? Object.fromEntries([...mpulseClients].map(([s, c]) => [s, c.state || 'connecting'])) : null,
    serverProtocol: client && client.serverSetup && client.serverSetup.version,
    metricsIntervalMs: cfg.metricsInterval,
    tracked: allSymbols(),
  });
}

if (cfg.http) {
  const [host, port] = cfg.http.split(':');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if (p === '/health') return healthJson(res);
    if (p === '/symbols') return json(res, 200, allSymbols());
    if (p === '/entitlements') {
      return json(res, 200, {
        licenseKey: authInfo ? authInfo.licenseKey : null,
        authState,
        entitlements: authInfo ? authInfo.entitlements : null,
        maxInstruments: authInfo ? authInfo.maxInstruments : null,
        crypto: authInfo ? authInfo.crypto : null,
        dxfeed: authInfo && authInfo.dxfeed ? { filters: authInfo.dxfeed.filters, code: authInfo.dxfeed.code } : null,
      });
    }
    if (p === '/features') {
      // which product features the licence entitles, resolved from the activation fields
      if (!authInfo) return json(res, 200, { authState, features: null, dataVenues: null });
      const features = authInfo.features || [];
      return json(res, 200, {
        authState,
        tier: authInfo.activation && authInfo.activation.fields
          ? authInfo.activation.fields['Product.Type'] : null,
        entitled: features.filter((f) => f.entitled).map((f) => ({ id: f.id, name: f.name })),
        notEntitled: features.filter((f) => !f.entitled).map((f) => ({ id: f.id, name: f.name })),
        features,
        summary: featureSummary(features),
        dataVenues: authInfo.dataVenues || [],
        maxInstruments: authInfo.maxInstruments,
        crypto: authInfo.crypto,
      });
    }
    if (p === '/venues') {      return json(res, 200, [...cryptoClients.keys()].map(v => ({
        venue: v,
        nativeSymbols: cryptoClients.get(v).symbols,
        canonicalSymbols: Object.values(cryptoClients.get(v).symbolMap),
        state: (venueStates.get(v) || {}).state || 'unknown',
      })));
    }
    if (p === '/subscribe' && req.method === 'POST') {
      return readJsonBody(req, (err, body) => {
        if (err) return json(res, 400, { error: 'invalid JSON body' });
        const venue = body.venue || cfg.venues[0];
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];
        if (!symbols.length) return json(res, 400, { error: 'symbols[] required' });
        if (!cfg.crypto) return json(res, 400, { error: 'runtime subscribe is only available in --crypto mode' });
        const r = changeSubscription(venue, symbols, false);
        return json(res, r.ok ? 200 : 404, r);
      });
    }
    if (p === '/unsubscribe' && req.method === 'POST') {
      return readJsonBody(req, (err, body) => {
        if (err) return json(res, 400, { error: 'invalid JSON body' });
        const venue = body.venue || cfg.venues[0];
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];
        if (!symbols.length) return json(res, 400, { error: 'symbols[] required' });
        if (!cfg.crypto) return json(res, 400, { error: 'runtime subscribe is only available in --crypto mode' });
        const r = changeSubscription(venue, symbols, true);
        return json(res, r.ok ? 200 : 404, r);
      });
    }
    if (p === '/data') {
      // per-symbol data availability across venues
      return json(res, 200, allSymbols().map(s => {
        const entry = books.get(s.venue);
        const m = entry ? entry.metrics.compute(s.symbol) : null;
        return {
          venue: s.venue,
          symbol: s.symbol,
          depthSource: s.depthSource,
          kinds: s.kinds,
          lastSeq: m ? m.book.lastSeq : null,
          updatesPerSec: m ? m.book.updatesPerSec : null,
          trades: m ? m.trade.count : 0,
          hasDepth: s.kinds.includes('depth'),
          hasTrades: s.kinds.includes('trade'),
          hasQuote: s.kinds.includes('quote'),
        };
      }));
    }
    if (p === '/metrics') return metricsJson(req, res, null, null);
    if (p.startsWith('/metrics/')) {
      const { venue, symbol } = splitPath(p.slice(9));
      return metricsJson(req, res, venue, symbol);
    }
    if (p === '/bbo') return json(res, 200, aggregateBbo(books));
    if (p === '/mpulse') {
      return json(res, 200, [...mpulseClients.entries()].map(([symbol, c]) => ({
        symbol, state: c.state || 'connecting', endpoints: c.endpointCount || 0,
        lastEstimate: c.lastEstimate || null,
      })));
    }
    if (p.startsWith('/book/')) {
      const { venue, symbol } = splitPath(p.slice(6));
      return bookJson(req, res, venue, symbol);
    }
    if (p.startsWith('/top/')) {
      const { venue, symbol } = splitPath(p.slice(5));
      const found = findBook(venue, symbol);
      if (!found) return json(res, 404, { error: 'unknown symbol' });
      const snap = found.snap;
      return json(res, 200, {
        venue: found.venue, symbol: snap.symbol, depthSource: snap.depthSource,
        lastSeq: snap.lastSeq, top: snap.top, quote: snap.quote, trade: snap.trade,
      });
    }
    if (p === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      const kinds = u.searchParams.get('kinds');
      const kindSet = kinds ? new Set(kinds.split(',').map(s => s.trim()).filter(Boolean)) : null;
      sseClients.add({
        res,
        filterSymbol: u.searchParams.get('symbol'),
        venueFilter: u.searchParams.get('venue'),
        kinds: kindSet,
        metrics: u.searchParams.get('metrics') === '1' || (kindSet && kindSet.has('metrics')),
      });
      req.on('close', () => sseClients.delete(res));
      return;
    }
    json(res, 404, {
      error: 'not found',
      endpoints: [
        '/health', '/symbols', '/venues', '/data', '/entitlements', '/features',
        '/book/<symbol>', '/book/<venue>/<symbol>', '/top/<symbol>',
        '/metrics', '/metrics/<symbol>', '/metrics/<venue>/<symbol>', '/bbo', '/mpulse', '/stream',
        'POST /subscribe', 'POST /unsubscribe',
      ],
    });
  });
  server.listen(Number(port), host, () => console.error(`[http] listening on http://${host}:${port}`));
}

if (cfg.sseHeartbeatMs > 0) {
  setInterval(() => {
    for (const c of sseClients) c.res.write(': ping\n\n');
  }, cfg.sseHeartbeatMs).unref();
}

// ---- start ----
let authSession = null;
async function start() {
  if (authRequired) {
    authSession = new BookmapAuth({
      email, password, licenseKey,
      // The activation seat is exclusive and shared with the user's own
      // Bookmap app: binding or kicking it would kill their live session.
      // A read-only entitlement probe uses login:false and takes nothing.
      kick: cfg.kickSeat,
      login: cfg.bindSeat,
    });
    try {
      const res = await authSession.authenticate({ requestDxFeedToken: !cfg.noDxFeedToken && !cfg.crypto });
      authInfo = res;
      authState = 'authorized';
      console.error(`[auth] OK license=${res.licenseKey} activation=${res.activation.result}` +
        (res.dxfeed ? ` dxfeed=${res.dxfeed.code} filters=${res.dxfeed.filters.join(',')}` : '') +
        (res.crypto ? ` cryptoAdapters=${res.crypto.adapters.length} maxInstruments=${res.crypto.maxInstruments}` : ''));
      if (!cfg.crypto && res.dxfeed && res.dxfeed.code === 'OK' && res.dxfeed.token) cfg.token = res.dxfeed.token;
      if (cfg.crypto) {
        const adapters = res.crypto.adapters;
        const needed = [...new Set(cfg.venues.map(v => VENUE_ADAPTERS[v]).filter(Boolean))];
        if (adapters.length && needed.length && !needed.every(a => adapters.includes(a))) {
          throw new Error(`license does not entitle the crypto adapter(s): ${needed.filter(a => !adapters.includes(a)).join(',')}`);
        }
        if (cfg.cryptoSymbols.length > res.crypto.maxInstruments) {
          throw new Error(`license allows ${res.crypto.maxInstruments} crypto instrument(s), ${cfg.cryptoSymbols.length} requested`);
        }
      }
    } catch (e) {
      authState = 'failed';
      console.error(`[auth] FAILED: ${e.message}`);
      await authSession.logout().catch(() => {});
      process.exit(1);
    }
  }

  if (cfg.authOnly) {
    console.error('[auth-only] authentication verified; not starting feed');
    await authSession.logout().catch(() => {});
    process.exit(0);
  }

  try {
    resolveWebSocket();
  } catch (e) {
    console.error(`[fatal] ${e.message}`);
    process.exit(1);
  }

  if (cfg.crypto) {
    for (const venue of cfg.venues) {
      const venueClient = createVenue(venue, {
        symbols: cfg.cryptoSymbols,
        stalenessMs: cfg.stalenessMs,
        restTimeoutMs: cfg.restTimeoutMs,
      });
      cryptoClients.set(venue, venueClient);
      wireVenueClient(venue, venueClient);
      venueClient.start();
    }
    if (cfg.mpulse) {
      for (const symbol of cfg.cryptoSymbols) {
        const mpSymbol = toMpulseSymbol(symbol);
        if (!mpSymbol) continue;
        const c = new MPulseClient({ symbol: mpSymbol, algos: cfg.mpulseAlgos });
        mpulseClients.set(symbol, c);
        c.on('estimate', (e) => {
          c.lastEstimate = e;
          broadcast({ symbol, kind: 'mpulse', venue: 'mpulse', data: e, ts: Date.now() });
        });
        c.on('state', (s) => { c.state = s; });
        c.on('log', (msg) => onLog('mpulse', msg));
        c.connect()
          .then((n) => { c.endpointCount = n; c.state = 'connected'; })
          .catch((e) => { c.state = 'failed'; onLog('mpulse', e.message); });
      }
    }
    console.error(`[bookmap-l2-client] mode=crypto venues=${cfg.venues.join(',')} symbols=${cfg.cryptoSymbols.join(',')} license=${authInfo ? authInfo.licenseKey : 'none'}`);
  } else {
    wireDxLink();
    console.error(`[bookmap-l2-client] mode=dxfeed url=${cfg.url} symbols=${cfg.symbols.join(',')} events=${cfg.events.join(',')} token=${cfg.token ? 'yes' : 'no'}`);
  }
}

start().catch((e) => { console.error(`[fatal] ${e.stack || e.message}`); process.exitCode = 1; });

// graceful shutdown
function shutdown() {
  console.error('stopping');
  try { if (client) client.stop(); } catch { /* ignore */ }
  for (const c of cryptoClients.values()) { try { c.stop(); } catch { /* ignore */ } }
  for (const c of mpulseClients.values()) { try { c.stop(); } catch { /* ignore */ } }
  for (const entry of books.values()) { try { entry.metrics.stop(); } catch { /* ignore */ } }
  try { if (sink) sink.close(); } catch { /* ignore */ }
  if (authSession) authSession.logout().catch(() => {});
  setTimeout(() => process.exit(0), 250);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
