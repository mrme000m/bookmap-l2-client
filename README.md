# bookmap-l2-client

A persistent, dependency-free Node.js service that streams **realtime L2 market data** for
programmatic consumption.

Two data paths:

- **Live crypto L2** from several public exchange WebSocket feeds, gated by emulated
  Bookmap app-level authentication (email + password, or license key):
  Coinbase, Binance, Kraken, OKX, Bybit and Bitstamp.
- **dxFeed dxLink** (`MarketDepth`/`DOM` for full L2, `Quote` fallback) for stocks & futures.

## Requirements

- Node.js >= 22 (global `WebSocket`). On Node 20 run with `node --experimental-websocket server.js`.
  Uses **no npm dependencies** (an optional `ws` or `undici` install is picked up if present).

## Bookmap app-level authentication (emulated)

Reconstructed from the shipped Bookmap client (`C:\Program Files\Bookmap\Bookmap.jar`,
`lib/dxfeed-adapter.jar`). Three stages, all plain HTTPS:

| Stage | Endpoint | Request | Response |
|---|---|---|---|
| email+password → license key | `https://scripts{1,2,3}.activation.bookmap.com/v1/inPlatformLogin/getKey.php` | form `login=<email>&password=<pw>` | `{"code":"OK","key":"XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"}` |
| license key → activation | `https://public{1,2,3}.activation.bookmap.com/ActivationAPI-v1/login` | form `json={"kick":…,"key":…,"login":true,"type":"DESKTOP","machineInfo":…}` | `{"result":"OK","token":…,"fields":{…entitlements…}}` |
| license key → dxFeed token | `https://bookmap.com/api/v1/dxfeed/getToken-v11.php` | form `login=<licenseKey>&password=&filters=["nasdaq_rt",…]` | `{"code":"OK","token":"<base64url payload>.<sig>"}` |

Notes from the reverse engineering:

- The license key format is `([0-9A-Z]{4}-){6}[0-9A-Z]{4}`.
- `filters` must be the lowercased `DxDataFilter` names (`nasdaq_rt`, `edgx_rt`, `ctautp_rt`,
  `cme_rt`, `cboe_fut_rt`, `eurex_rt`, `nasdaq_demo`, …). Anything else → `INVALID_FILTERS`;
  valid filters without credentials → `INVALID_CREDENTIALS`; valid filters outside the
  license → `NOT_ALLOWED_BY_LICENSE`.
- The token payload decodes to `bookmap,nonpro,<id>,<expiry>,<issued>,<user>,<filters>`.
- The activation `fields` map carries the entitlements: `ADAPTER.<venue>` (crypto venues),
  `Subscription.DxFeed.Source.*` (dxFeed sources), `Allow_Crypto`, `Crypto_Max_Instruments`, …
  Values are either a flag (`"1"`) or an expiry date (`"YYYY-MM-DD HH:MM:SS"` GMT).
- The activation response is signed: `Activations-Server-Signature-Value` +
  `Activations-Server-Signature-Timestamp` headers carry an RSA signature over
  `SHA-512(timestamp + ";" + body)`. This client trusts TLS and skips that check.
- Live **crypto** L2 does not come from dxFeed — Bookmap connects straight to the exchange
  (Coinbase/Binance/…) and only uses the license to *gate* the adapter. dxFeed entitlements
  (`nasdaq_rt`, …) cover stocks & futures.
- The dxFeed entitlement hosts (`bookmap-auther-realtime[.us].dxfeed.com`) speak the native
  dxFeed QTP/RMI protocol on **plaintext** port `7300`, not dxLink-over-WebSocket. The token
  above is therefore consumable by the native client (as Bookmap does with `dxlib.jar`), not by
  a dxLink WebSocket client.

## Run

```bat
:: live crypto L2, authenticated with email + password
set BOOKMAP_EMAIL=you@example.com
set BOOKMAP_PASSWORD=your-password
"C:\path\to\node.exe" server.js --crypto --crypto-symbols BTC-USD,ETH-USD --http 127.0.0.1:8200

:: live crypto L2, authenticated with a license key
set BOOKMAP_LICENSE_KEY=XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
"C:\path\to\node.exe" server.js --crypto --crypto-symbols BTC-USD --http 127.0.0.1:8200

:: several crypto venues at once, with metrics + JSONL sink
"C:\path\to\node.exe" server.js --crypto --venues coinbase,binance,kraken --crypto-symbols BTC-USD --metrics-interval 1000 --sink deltas.jsonl

:: same feed as CSV for a single venue
"C:\path\to\node.exe" server.js --crypto --venues bitstamp --crypto-symbols BTC-USD --sink deltas.csv

:: NDJSON deltas on stdout (no HTTP)
"C:\path\to\node.exe" server.js --crypto --crypto-symbols BTC-USD --stdio

:: verify authentication only, then exit
"C:\path\to\node.exe" server.js --auth-only

:: dxFeed dxLink (demo endpoint; delayed, top-of-book only)
"C:\path\to\node.exe" server.js --symbols AAPL,MSFT,SPY --http 127.0.0.1:8200

:: dxFeed dxLink with a token obtained from the Bookmap token server
"C:\path\to\node.exe" server.js --url wss://<your-endpoint> --symbols ESZ26 --events MarketDepth,Quote,Trade --http 127.0.0.1:8200
```

The crypto feeds are public, so the service also runs anonymously. Credentials only add the
Bookmap entitlement check (`--venues` adapter names and instrument count) and are not required
to receive market data.

## Crypto venues

Each venue adapter normalizes its native feed into one event stream (`snapshot`, `depth`
updates, `trade`, `ticker`) and into one book keyed by the canonical symbol you pass in
(e.g. `BTC-USD`). Each venue keeps its **own** book, so books are never mixed across venues.

| Venue | L2 channel | Extra channels | Sequence gap repair |
|---|---|---|---|
| Coinbase | `level2_batch` | `ticker`, `matches`, `heartbeat` | REST `/products/<id>/book?level=2` |
| Binance | `<sym>@depth20@100ms` | `@trade`, `@bookTicker` | REST `/api/v3/depth` + buffered replay |
| Kraken | `book-100` | `trade`, `ticker` | reconnect |
| OKX | `books` | `trades`, `tickers` | resubscribe on `prevSeqId` break |
| Bybit | `orderbook.50` | `publicTrade`, `tickers` | reconnect |
| Bitstamp | `order_book` + `diff_order_book` | `live_trades` | reconnect |

Symbol translation is per venue: `BTC-USD` becomes `BTC-USD` (Coinbase), `BTCUSDT`
(Binance/Bybit), `XBT/USD` (Kraken), `BTC-USDT` (OKX) and `btcusd` (Bitstamp).

`--venues coinbase,binance` subscribes to several venues at once; each venue gets its own
client, reconnect state, staleness watchdog and book. Books are addressed as
`/book/<venue>/<symbol>` (explicit) or `/book/<symbol>` (first venue tracking it).

## Realtime metrics

`MetricsEngine` derives per-symbol analytics from the book and trade stream: `spread`,
`spreadBps`, `mid`, `microprice`, top-5/top-20 `imbalance`, depth totals, rolling `vwap` /
buy vs sell volume over a 60 s window, trade count and book `updatesPerSec`. Metrics are
available at `GET /metrics` and `GET /metrics/<symbol>` (or `/metrics/<venue>/<symbol>`),
and can be streamed over SSE with `GET /stream?metrics=1` or appended to the `--sink` file.

## HTTP API

| Endpoint | Description |
|---|---|
| `GET /health` | feed status: per-venue connection state/staleness, auth state, license, entitlements, tracked symbols |
| `GET /symbols` | tracked symbols per venue (`{venue, symbol, depthSource, updatedAt}`) |
| `GET /book/<symbol>` | full L2 snapshot: `bids[]` (desc), `asks[]` (asc), `top`, `quote`, `trade`, `lastSeq` |
| `GET /book/<venue>/<symbol>` | full L2 snapshot of one venue |
| `GET /top/<symbol>` | L1 top of book |
| `GET /metrics` | computed metrics for all tracked symbols |
| `GET /metrics/<symbol>` | computed metrics for one symbol |
| `GET /metrics/<venue>/<symbol>` | computed metrics for one venue/symbol |
| `GET /stream` | SSE deltas: `?symbol=` `?venue=` `?kinds=depth,trade,quote,snapshot` `?metrics=1` |

### Example snapshot

```json
{
  "symbol": "BTC-USD",
  "seq": 42,
  "depthSource": "coinbase",
  "top": { "bidPrice": 64268.48, "bidSize": 0.90, "askPrice": 64268.49, "askSize": 0.04 },
  "bids": [ { "price": 64268.48, "size": 0.90 }, { "price": 64268.36, "size": 0.0001 } ],
  "asks": [ { "price": 64268.49, "size": 0.04 }, { "price": 64269.05, "size": 0.0001 } ]
}
```

## Consuming programmatically (Node example)

```js
const base = 'http://127.0.0.1:8200';

// poll snapshots (per venue: /book/<venue>/<symbol>)
const book = await (await fetch(`${base}/book/coinbase/BTC-USD`)).json();
console.log(book.top, book.bids[0], book.asks[0]);

// stream deltas
const es = new EventSource(`${base}/stream?venue=coinbase&metrics=1`);
es.onmessage = (m) => {
  const d = JSON.parse(m.data); // {symbol, kind: 'depth'|'quote'|'trade'|'snapshot'|'metrics', data, ts, venue}
  if (d.kind === 'depth') console.log(d.symbol, d.data.side, d.data.price, d.data.size);
};
```

## CLI flags

```
--email <e>              Bookmap account email (or BOOKMAP_EMAIL)
--password <p>           Bookmap account password (or BOOKMAP_PASSWORD)
--license-key <k>        Bookmap license key (or BOOKMAP_LICENSE_KEY)
--auth-only              authenticate, print the result and exit
--no-dxfeed-token        skip the getToken-v11.php call
--crypto                 use the live crypto L2 feed
--venues a,b,c           crypto venues (default coinbase): coinbase,binance,kraken,okx,bybit,bitstamp
--crypto-symbols a,b     canonical symbols, e.g. BTC-USD,ETH-USD (translated per venue)
--url <wss>              dxLink endpoint (default demo)
--token <t>              dxFeed auth token (or DXFEED_TOKEN)
--symbols a,b,c          dxFeed subscriptions (dxFeed symbol syntax, e.g. ESZ26, AAPL)
--events a,b,c           Quote, Trade, MarketDepth
--http host:port         enable HTTP API (default 127.0.0.1:8200)
--stdio                  print NDJSON deltas to stdout
--metrics-interval ms    metrics emit interval (default 1000)
--sink <path>            append deltas/metrics to a file (.csv or .jsonl by extension)
--sink-format jsonl|csv  override the sink format
--sse-heartbeat ms       SSE comment heartbeat (default 15000, 0 disables)
--staleness-ms ms        force a reconnect after this much feed silence (default 15000)
--rest-timeout ms        REST snapshot timeout (default 10000)
--dom-sources s[,s]      also open DOM channels (e.g. ntv) for full-depth snapshots
--dom-depth n            DOM depth limit (default 20)
--aggregation <sec>      event aggregation period (default 0.1)
```

## Tests

```
npm test
```

Dependency-free `node:test` coverage for venue message parsing, symbol normalization,
sequence-gap handling, book metadata and the metrics engine.

## Notes

- Symbols use dxFeed syntax (`ESZ26` = ES Dec-2026 future, `AAPL` = stock) for the dxFeed path;
  the crypto path takes canonical symbols (`BTC-USD`, `ETH-USD`) and translates them per venue.
- Demo data is delayed and depth-limited by dxFeed; the code path is identical for production tokens.
- Venue adapters normalize to the same event names and book model, so switching venues (or
  running several at once) does not change the HTTP/SSE/sink contract.
- This client speaks public, documented protocols (dxFeed dxLink, Coinbase, Binance, Kraken, OKX,
  Bybit and Bitstamp websockets) plus the Bookmap activation/token endpoints required to
  authenticate. You must have rights to whatever market data you subscribe to.
