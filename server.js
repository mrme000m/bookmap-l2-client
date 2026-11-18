#!/usr/bin/env node
'use strict';
// Bookmap-style persistent L2 market-data service over dxFeed dxLink, or live
// crypto L2 over the Coinbase Exchange feed, gated by emulated Bookmap
// app-level authentication.
//
// Auth (emulated from the shipped Bookmap client):
//   email + password -> scripts*.activation.bookmap.com /v1/inPlatformLogin/getKey.php
//   license key      -> public*.activation.bookmap.com/ActivationAPI-v1/login
//   license key      -> bookmap.com/api/v1/dxfeed/getToken-v11.php (dxFeed token)
//
// HTTP API:
//   GET /health            service/feed/auth status
//   GET /symbols           tracked symbols
//   GET /book/<symbol>     full L2 snapshot JSON
//   GET /top/<symbol>      L1 top of book
//   GET /stream            SSE stream of book deltas (?symbol= filter)

const http = require('http');
const { URL } = require('url');
const { DxLinkClient } = require('./lib/dxlink');
const { CoinbaseL2Client } = require('./lib/coinbase');
const { BookEngine } = require('./lib/book');
const { BookmapAuth } = require('./lib/bookmapAuth');

// crypto venue -> Bookmap adapter name (entitlement check)
const CRYPTO_ADAPTERS = { 'BTC-USD': 'CoinbasePro', 'ETH-USD': 'CoinbasePro' };

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
  cryptoSymbols: (args['crypto-symbols'] || 'BTC-USD,ETH-USD').split(',').map(s => s.trim()).filter(Boolean),
  authRequired,
  authOnly: !!args['auth-only'],
  noDxFeedToken: !!args['no-dxfeed-token'],
};

if (!cfg.http && !cfg.stdio && !cfg.authOnly) cfg.http = '127.0.0.1:8200';

// ---- engine ----
const book = new BookEngine();
const startedAt = new Date().toISOString();
let authState = authRequired ? 'authenticating' : 'anonymous';
let authInfo = null;
let sseClients = new Set();
let client = null; // DxLinkClient | CoinbaseL2Client

book.on('delta', (d) => {
  if (cfg.stdio) process.stdout.write(JSON.stringify(d) + '\n');
  const payload = `data: ${JSON.stringify(d)}\n\n`;
  for (const res of sseClients) {
    if (res.filterSymbol && res.filterSymbol !== d.symbol) continue;
    res.write(payload);
  }
});

function onLog(level, text) { console.error(`[${level}] ${text}`); }

function wireDxLink() {
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

function wireCoinbase() {
  client = new CoinbaseL2Client({ productIds: cfg.cryptoSymbols });
  client.on('log', onLog);
  client.on('snapshot', (productId, bids, asks) => {
    book.applyLevels({ symbol: productId, time: Date.now(), bids, asks, source: 'coinbase' });
  });
  client.on('update', (productId, side, price, size) => {
    book.applyLevel(productId, side === 'buy' ? 'bid' : 'ask', price, size, 'coinbase');
  });
  client.start();
  authState = authRequired ? 'authorized' : 'anonymous';
}

// ---- HTTP API ----
function bookJson(req, res, symbol) {
  const snap = book.snapshot(symbol);
  if (!snap) return json(res, 404, { error: 'unknown symbol', tracked: book.list() });
  json(res, 200, snap);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

if (cfg.http) {
  const [host, port] = cfg.http.split(':');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if (p === '/health') {
      return json(res, 200, {
        status: 'ok', startedAt,
        url: cfg.crypto ? null : cfg.url, authState,
        auth: authInfo ? {
          licenseKey: authInfo.licenseKey,
          activation: authInfo.activation.result,
          dxfeed: authInfo.dxfeed ? { filters: authInfo.dxfeed.filters, code: authInfo.dxfeed.code, hasToken: !!authInfo.dxfeed.token } : null,
          crypto: authInfo.crypto ? { adapters: authInfo.crypto.adapters, maxInstruments: authInfo.crypto.maxInstruments } : null,
        } : null,
        connected: client ? client.state : 'idle',
        serverProtocol: client && client.serverSetup && client.serverSetup.version,
        mode: cfg.crypto ? 'crypto' : 'dxfeed',
        tracked: book.list(),
      });
    }
    if (p === '/symbols') return json(res, 200, book.list());
    if (p.startsWith('/book/')) return bookJson(req, res, decodeURIComponent(p.slice(6)));
    if (p.startsWith('/top/')) {
      const snap = book.snapshot(decodeURIComponent(p.slice(5)));
      if (!snap) return json(res, 404, { error: 'unknown symbol' });
      return json(res, 200, { symbol: snap.symbol, depthSource: snap.depthSource, top: snap.top, quote: snap.quote, trade: snap.trade });
    }
    if (p === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      res.filterSymbol = u.searchParams.get('symbol');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    json(res, 404, { error: 'not found', endpoints: ['/health', '/symbols', '/book/<symbol>', '/top/<symbol>', '/stream'] });
  });
  server.listen(Number(port), host, () => console.error(`[http] listening on http://${host}:${port}`));
}

// ---- start ----
let authSession = null;
async function start() {
  if (authRequired) {
    authSession = new BookmapAuth({
      email, password, licenseKey,
      kick: true,
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
        const needed = new Set(cfg.cryptoSymbols.map(s => CRYPTO_ADAPTERS[s] || 'CoinbasePro'));
        if (adapters.length && ![...needed].every(a => adapters.includes(a))) {
          throw new Error(`license does not entitle the crypto adapter(s): ${[...needed].filter(a => !adapters.includes(a)).join(',')}`);
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

  if (cfg.crypto) wireCoinbase();
  else wireDxLink();

  if (cfg.crypto) {
    console.error(`[bookmap-l2-client] mode=crypto venue=coinbase symbols=${cfg.cryptoSymbols.join(',')} license=${authInfo ? authInfo.licenseKey : 'none'}`);
  } else {
    console.error(`[bookmap-l2-client] mode=dxfeed url=${cfg.url} symbols=${cfg.symbols.join(',')} events=${cfg.events.join(',')} token=${cfg.token ? 'yes' : 'no'}`);
  }
}

start().catch((e) => { console.error(`[fatal] ${e.stack || e.message}`); process.exitCode = 1; });

// graceful shutdown
function shutdown() {
  console.error('stopping');
  try { if (client) client.stop(); } catch { /* ignore */ }
  if (authSession) authSession.logout().catch(() => {});
  setTimeout(() => process.exit(0), 250);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
