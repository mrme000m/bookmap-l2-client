# bookmap-l2-client

A persistent, dependency-free Node.js service that streams **realtime L2 market data** for
programmatic consumption.

Two data paths:

- **Live crypto L2** over the Coinbase Exchange `level2_batch` WebSocket feed, gated by
  emulated Bookmap app-level authentication (email + password, or license key).
- **dxFeed dxLink** (`MarketDepth`/`DOM` for full L2, `Quote` fallback) for stocks & futures.

## Requirements

- Node.js >= 22 (global `WebSocket`). Uses **no npm dependencies**.

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

:: NDJSON deltas on stdout (no HTTP)
"C:\path\to\node.exe" server.js --crypto --crypto-symbols BTC-USD --stdio

:: verify authentication only, then exit
"C:\path\to\node.exe" server.js --auth-only

:: dxFeed dxLink (demo endpoint; delayed, top-of-book only)
"C:\path\to\node.exe" server.js --symbols AAPL,MSFT,SPY --http 127.0.0.1:8200

:: dxFeed dxLink with a token obtained from the Bookmap token server
"C:\path\to\node.exe" server.js --url wss://<your-endpoint> --symbols ESZ26 --events MarketDepth,Quote,Trade --http 127.0.0.1:8200
```

If no credentials are supplied the service still runs (anonymous), but the crypto mode requires
a successful authentication first.

## HTTP API

| Endpoint | Description |
|---|---|
| `GET /health` | feed status: connection state, auth state, license, entitlements, tracked symbols |
| `GET /symbols` | tracked symbols + depth source (`coinbase` / `dom` / `marketdepth` / `quote`) |
| `GET /book/<symbol>` | full L2 snapshot: `bids[]` (desc), `asks[]` (asc), `top`, `quote`, `trade` |
| `GET /top/<symbol>` | L1 top of book |
| `GET /stream` | SSE stream of all book deltas (`?symbol=AAPL` to filter) |

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

// poll snapshots
const book = await (await fetch(`${base}/book/BTC-USD`)).json();
console.log(book.top, book.bids[0], book.asks[0]);

// stream deltas
const es = new EventSource(`${base}/stream`);
es.onmessage = (m) => {
  const d = JSON.parse(m.data); // {symbol, kind: 'depth'|'quote'|'trade'|'snapshot', data, ts}
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
--crypto                 use the live crypto (Coinbase) L2 feed
--crypto-symbols a,b     crypto products, e.g. BTC-USD,ETH-USD
--url <wss>              dxLink endpoint (default demo)
--token <t>              dxFeed auth token (or DXFEED_TOKEN)
--symbols a,b,c          dxFeed subscriptions (dxFeed symbol syntax, e.g. ESZ26, AAPL)
--events a,b,c           Quote, Trade, MarketDepth
--http host:port         enable HTTP API (default 127.0.0.1:8200)
--stdio                  print NDJSON deltas to stdout
--dom-sources s[,s]      also open DOM channels (e.g. ntv) for full-depth snapshots
--dom-depth n            DOM depth limit (default 20)
--aggregation <sec>      event aggregation period (default 0.1)
```

## Notes

- Symbols use dxFeed syntax (`ESZ26` = ES Dec-2026 future, `AAPL` = stock) for the dxFeed path;
  the crypto path uses exchange product ids (`BTC-USD`, `ETH-USD`).
- Demo data is delayed and depth-limited by dxFeed; the code path is identical for production tokens.
- This client speaks the public, documented protocols (dxFeed dxLink, Coinbase Exchange
  websocket) plus the Bookmap activation/token endpoints required to authenticate. You must have
  rights to whatever market data you subscribe to.
