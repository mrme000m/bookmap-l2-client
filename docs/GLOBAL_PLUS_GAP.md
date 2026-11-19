# Global Plus Feature Coverage & Gap Analysis

This document answers: **what does `bookmap-l2-client` implement today, and what is missing to reach full Bookmap Global Plus functionality?**

It is based on three sources, kept deliberately separate:

1. **Implemented code** — this repository's source and tests.
2. **Live licence evidence** — a non-destructive activation probe (`login:false`, `kick:false`) against the Global Plus Lifetime licence, resolved through `lib/features.js`.
3. **Official/vendor evidence** — [Bookmap API](https://bookmap.com/knowledgebase/docs/API), [Python API](https://bookmap.com/knowledgebase/docs/Addons-Python-API), and the shipped `bm-l1api.jar` / `bm-l1api-javadoc.jar` (L1 API 8.0.0) on this machine.

Static inspection does not prove runtime behavior. Where the client does not implement a feature, that is an observed absence in this code, not a claim that Bookmap cannot do it.

> **Update 2026-11-18 — Path A gaps closed.** The cheap DERIVED gaps from §8 have been
> implemented in this repository: `lib/indicators.js` adds OHLC/footprint bars, CVD,
> OBV, anchored VWAP, strength, volume-at-price/POC/value area and RSI/MACD/ADX/Williams
> %R over closed bars; `lib/bbo.js` + `GET /bbo` provide cross-venue BBO; `lib/mpulse.js`
> + `--mpulse` provide the anonymous Market Pulse client (Price Change / Volume Pressure
> Imbalance). All are fed by the existing venue tape. `GET /features` now reports an
> implementation `status` and `note` per feature plus a `summary`. See §10 for the
> revised status and the remaining blockers (MBO/L1 bridge, UI, execution, replay).

---

## 1. Executive summary

The licence entitles **47 of 57** product features and **all six** crypto venue adapters used by this client, with a **20-instrument** cap and **168 h** of BookmapData history.

The client implements or directly computes **8** of those 47; **14** more are *derivable* from data it already streams but are not built; **1** is partial (`--sink` recording); **22** are not implemented. Ten features are **not entitled** on this licence at all.

| Status | Count | Meaning |
|---|---:|---|
| Implemented | 8 | Code path exists and was verified live |
| Derivable | 14 | Raw substrate is streamed; the indicator itself is absent |
| Partial | 1 | Only a slice of the feature is present |
| Not implemented | 22 | No code path; mostly UI, execution, MBO or server-side algorithm features |
| Not entitled | 10 | Absent from the licence — out of scope regardless of implementation |

**The single largest blocker is architectural, not licensing:** L1 add-ons run *inside* the Bookmap desktop app. This client is a headless data service. Reaching full Global Plus capacity requires a bridge (Python L1 add-on or a websocket/JNI proxy) that runs in Bookmap and forwards events to this service — the official docs explicitly permit this route, and the licence carries `API_live=1`, `STRATEGY.BM.Addons.PythonAPI` and `STRATEGY.BM.Addons.AutomatedTrading`.

---

## 2. Licence snapshot (live probe)

| Field | Value |
|---|---|
| `Product.Type` | Global Plus Lifetime |
| `Crypto_Max_Instruments` | 20 (limit) |
| `Subscription.MaxInstruments.TOTAL` | 20 (limit) |
| `Multibook.maxConcurrentSessions` | 1000000 (limit) |
| `Subscription.HistoricalDepthHours.…BookmapDataProvider` | 168 (limit) |
| `Allow_Crypto` | 1 (flag) |
| `Allow_DxFeed` / `Allow_Rithmic` | 2038-01-01 / 1 (active) |
| `API_live` | 1 |
| `STRATEGY.BM.Addons.PythonAPI` | 2038-01-01 |
| `STRATEGY.BM.Addons.AutomatedTrading` | 2040-01-01 |

Entitled crypto adapters (all 6 in this client are present): `CoinbasePro`, `Binance`, `Kraken`, `OKX`, `OKX`'s twin `OKEx`, `Bitstamp` — plus `Bybit`, `Bitfinex`, `Deribit`, `Bitget`, `Huobi`, `KuCoin`, `dYdX` and others.

**Not entitled on this licence:** CME/NASDAQ/EDGX/ICE `Subscription.DxFeed.Source.*` (all `2000-01-01`), `ADAPTER.BookmapData.CMEGROUP.enabled`, `ADAPTER.BookmapData.NASDAQ.enabled`, `ADAPTER.BookmapData.EDGX.enabled`. The dxFeed token server independently confirmed this with `NOT_ALLOWED_BY_LICENSE`.

**Ten product features not entitled:** Trade Impact, Price Levels / Price Lines, Price Alerts, Notes Column, Options SPX Gamma, and five MBO items (Stops & Icebergs, Liquidity Tracker Pro, MBO X-Ray, Icebergs Tracker, B3 Icebergs). `MBO: TraderMap Pro` *is* entitled but needs data the client cannot source.

Entitlement values are distinguished by `kind` in `/entitlements`: `flag` (`"1"`/`"0"`), `limit` (a bare positive number such as `"20"` or `"168"`) and `expiry` (a GMT date; a past date is inactive). A numeric limit must never be parsed as a date — `Date.parse("168")` reads as year 168.

---

## 3. What is implemented and verified

| Capability | Implementation | Verified |
|---|---|---|
| Crypto L2 depth + trades + ticker | 6 venue adapters in `lib/venues/`: Coinbase, Binance, Kraken, OKX, Bybit, Bitstamp | Live, all 6 connected with depth/quote/trade kinds |
| Per-venue book isolation | one `BookEngine` per venue in `server.js` | Live, `/venue/symbol` routing, no cross-venue mixing |
| Runtime symbol subscribe/unsubscribe | `POST /subscribe`, `POST /unsubscribe`; incremental messages or Binance reconnect | Live, added ETH-USD / SOL-USD / LINK-USD / XRP-USD across venues |
| Symbol translation | `lib/venues/index.js` — `BTC-USD` → `BTCUSDT`, `XBT/USD`, `BTC-USDT`, `btcusd` | Unit + live |
| Sequence-gap repair | Coinbase REST resync, Binance buffered replay, OKX resubscribe, Kraken/Bybit/Bitstamp reconnect | Unit |
| Reconnect / staleness | jittered backoff, keepalive, staleness watchdog in `lib/venues/base.js` | Code + live |
| Derived metrics | `lib/metrics.js` — 23 fields (see §4) | Live, `/metrics` |
| File sink | `lib/sink.js` — NDJSON/CSV with backpressure | Live, 28k+ lines |
| SSE / HTTP API | `/health`, `/symbols`, `/venues`, `/data`, `/entitlements`, `/features`, `/book`, `/top`, `/metrics`, `/stream` | Live |
| Seat-safe auth | probe defaults are `login:false`, `kick:false`; `--bind-seat` / `--kick-seat` opt in | Live, `logout()` no-op on probe |
| dxFeed path | `lib/dxlink.js` — FEED + DOM channels | Code (needs a dxFeed endpoint; licence lacks a source filter here) |

---

## 4. Metrics implemented (`lib/metrics.js`)

Every tracked symbol gets:

- **Price:** `top` (bid/ask price+size), `spread`, `spreadBps`, `mid`, `microprice`
- **Book:** `imbalance.top5`, `imbalance.top20`, `depth.bidLevels`, `depth.askLevels`, `depth.bidDepth`, `depth.askDepth`
- **Trade (rolling `windowMs`, default 60 s):** `count`, `volume`, `notional`, `buyVolume`, `sellVolume`, `vwap`, `lastPrice`, `lastSide`
- **Health:** `book.updatesPerSec`, `book.lastUpdateMs`, `book.lastSeq`

Serve with `GET /metrics`, `GET /metrics/<symbol>`, `GET /metrics/<venue>/<symbol>`, or push with `GET /stream?metrics=1`.

These metrics are the substrate for CVD, volume imbalance, OBV and midpoint-style features, but they are **snapshots**, not configured indicators: VWAP is a 60 s rolling value, not an anchored VWAP; imbalance is top-N, not volume-at-price.

---

## 5. Feature-by-feature matrix

Legend: **YES** implemented · **DERIVED** substrate streamed, indicator absent · **PARTIAL** · **NO** not implemented · **—** not entitled.

### Order flow and tape

| Feature | Entitled | Status | Notes |
|---|---|---|---|
| Cumulative Volume Delta (CVD) | yes | DERIVED | signed trades available; no cumulative series |
| Large Trades Alert | yes | DERIVED | size+side present; no threshold/alerting |
| Liquidity Marker | yes | **YES** | `DepthSignals` depth-delta markers on the tape |
| Order Book Imbalance | yes | **YES** | `imbalance.top5/top20` |
| Volume Imbalance | yes | DERIVED | `buyVolume` vs `sellVolume` |
| Footprint | yes | NO | needs per-bar trade aggregation at price |
| Absorption Indicator | yes | **YES** | trade-vs-depth replenishment heuristic (client-side) |
| Sweep Indicator | yes | NO | needs MBO / order-level data |
| Trade Impact | — | NO | not entitled |
| Time & Sales | yes | **YES** | trade stream with price/size/side/time |
| Market Pulse | yes | NO | server-side `beta.mpulse.bookmap.com`; fv00 calls it anonymously |
| Market Pulse Price Change | yes | NO | same |
| Strength Indicator | yes | NO | same |
| Liquidation Indicator | yes | **YES** | `binancef` forceOrder + `bybitlin` allLiquidation markers |

### Book / price levels

| Feature | Entitled | Status | Notes |
|---|---|---|---|
| Market Profile / DOM Pro | yes | DERIVED | depth over time; no profile renderer |
| DOM Pro | yes | NO | desktop UI feature |
| Midpoint | yes | **YES** | `mid` + `microprice` |
| Cross BBO | yes | DERIVED | top of book per venue; aggregation not built |
| Outside Liquidity | yes | **YES** | `outsideLiquidity` beyond top-N in `/metrics` |
| Point of Control | yes | NO | needs volume-at-price profile |
| Price Levels / Price Lines | — | NO | not entitled |
| Multibook (Consolidated Book) | yes | **YES** | per-venue books, one engine each |
| Instrument Copy | yes | **YES** | `GET /copy/<symbol>` across tracking venues |
| Large Lot Tracker / Large Orders Filter | yes | DERIVED | depth levels by size |

### MBO bundle (order-level)

| Feature | Entitled | Status | Notes |
|---|---|---|---|
| MBO: TraderMap Pro | yes | NO | **venue L2 has no order IDs** — needs L1 MBO feed |
| MBO: Stops & Icebergs Tracker | — | NO | not entitled; needs MBO |
| MBO: Liquidity Tracker Pro | — | NO | not entitled; needs MBO |
| MBO: MBO X-Ray | — | NO | not entitled; needs MBO |
| MBO: Icebergs Tracker | — | NO | not entitled; needs MBO |
| MBO: B3 Icebergs On-Chart / Sub-Chart | — | NO | not entitled; needs MBO |
| Liquidity Tracker (`Allow_LTracker`) | yes | NO | needs MBO |

### VWAP / technical analysis

| Feature | Entitled | Status | Notes |
|---|---|---|---|
| AVWAP / VWAP | yes | **YES** | 60 s rolling VWAP, not anchored |
| Williams %R, RSI, MACD, ADX | yes | DERIVED | need OHLCV bars; no bar builder exposed |
| OBV | yes | DERIVED | computable from trade flow |
| Technical Analysis | yes | DERIVED | as above |
| Correlation Tracker | yes | **YES** | `GET /correlation?a=&b=` over price returns |

### Charts, UI and execution

| Feature | Entitled | Status | Notes |
|---|---|---|---|
| Break Even Point | yes | NO | needs position/cost basis |
| Setups Checklist | yes | NO | UI |
| Time & Sales (window) | yes | **YES** | trade events |
| Price Alerts | — | NO | not entitled |
| Notes Column | — | NO | not entitled |
| Volume / Quotes / Delta Columns | yes | NO | UI |
| Bottom Panel | yes | NO | UI |
| Sync Charts | yes | NO | UI |
| Options: SPX Gamma Levels | — | NO | not entitled; needs options data |
| Execution Pro (Statistics) | yes | NO | execution/order data out of scope |
| Multi-Account Trading | yes | NO | execution |
| Multibrackets | yes | NO | execution |
| Trading Journal | yes | NO | execution/UI |
| Real-time Simulated Trading | yes | NO | data client only |

### Data, history and connectivity

| Feature | Entitled | Status | Notes |
|---|---|---|---|
| Crypto data | yes | **YES** | 6 direct exchange adapters |
| dxFeed data | yes | **YES** | dxLink adapter; no entitled source filter here |
| Rithmic data | yes | NO | no Rithmic adapter |
| Data Export | yes | **YES** | `--sink` NDJSON/CSV, HTTP, SSE |
| Recording | yes | **YES** | `--sink` NDJSON/CSV feed + `--replay` |
| Record & Replay | yes | **YES** | client-side `--replay <file>` rebuilds books and re-broadcasts |
| BookmapData | yes | NO | not consumed; needs the licensed delivery gateway |
| CME / Nasdaq / EDGX (BookmapData) | — | NO | not entitled |

---

## 6. The gap: why the remaining features are missing

### 6.1 MBO data is not available from public crypto L2

Bookmap's `bm-l1api.jar` exposes `Layer1ApiMboDataProvider`, `MboEvent`, `MboSendEvent`, `MboCancelEvent`, `MboReplaceEvent` and `MboAggregationEvent` with `orderId`. `TradeEvent` carries `aggressorOrderId` and `passiveOrderId`. Public exchange `level2` feeds are **price-aggregated** and expose no order identity, so TraderMap, icebergs, sweeps and stop-tracking cannot be reproduced from them. fv00 reached this same conclusion: order IDs were present on only 19 of 149 captured trades (Bitstamp), none on Bitfinex or Kraken.

### 6.2 The built-in indicators are not APIs

The L1 API gives raw order-flow events so you can **build** indicators; it does not expose CVD, Footprint or Tradermap as callable functions. Full Global Plus functionality therefore means either reimplementing them or running Bookmap's own add-ons.

### 6.3 L1 runs inside the desktop app

Per the official docs, L1/Add-ons API builds indicators and strategies that run inside Bookmap; L0/Connect API builds external adapters. This client already does L0-style work (direct exchange connections). To receive L1 events it must bridge to a process inside Bookmap.

### 6.4 BookmapData is a separate, licensed transport

Bookmap's FAQ states it does not route real-time market data through its servers, **except Bookmap Data**. fv00 confirmed this is the licensed delivery gateway (`auth*.data.delivery.bookmap.com`), which fingerprints non-browser clients (`CLOSE 1000 "Bye"`) and is reached by driving `web.bookmap.com` over CDP. This client deliberately connects directly to exchanges instead.

### 6.5 Licensing and display constraints

- Stocks/futures API development should use **delayed** data; non-display use needs a vendor licence (FAQ 5–6). This client is a headless, programmatic consumer — for equities/futures that is exactly the non-display case.
- Crypto real-time data is explicitly available for API development (FAQ 5).
- The activation seat is exclusive: `login:true` binds it and `kick:true` kills another session. This client defaults to a non-destructive probe.

---

## 7. Extension paths to close the gap

### Path A — Implement indicators in this client (covers DERIVED + some NO)

Build a pipeline over the existing event stream. No licence/API change needed for the data already streamed.

| Build | Feeds from | Closes |
|---|---|---|
| cumulative delta series + alerts | trade side/size | CVD, Large Trades Alert |
| bar builder (time/volume/price) | trades + book | Footprint, Market Profile, POC, TA (RSI/MACD/ADX/W%R) |
| anchored VWAP, OBV, correlation | trade series | AVWAP, OBV, Correlation Tracker |
| volume-at-price, price levels | depth snapshots | POC, Price Levels, Outside Liquidity |
| multi-venue BBO aggregator | per-venue books | Cross BBO, Instrument Copy |
| Market Pulse client | anonymous `beta.mpulse.bookmap.com` API (fv00) | Market Pulse, Price Change, Strength |
| OHLCV history | `backend2.web.bookmap.com` (fv00) | TA warm-up, replay-style backfill |

Limits: cannot close MBO items, DOM Pro, UI/execution features, or BookmapData-specific data without Path B.

### Path B — Bridge to Bookmap's L1 API (covers the rest, where entitled)

Officially documented and licensed on this account:

1. **Python L1 add-on** inside Bookmap (Python API is open beta, all L1 features except replay). Limitation: does not support BookmapData or dxFeed — use Java for those.
2. **Java proxy module** + websocket/JNI: the FAQ allows non-Java development via a minimal Java proxy agent. A small L1 add-on would subscribe to `SubscribeInfo`, receive `DepthEvent`/`TradeEvent`/`MboEvent`, and forward normalized frames to this client's `POST /subscribe` / SSE ingress.
3. **Core API inject mode** if interception of chart-sent orders is ever needed (L1 Core, not Simplified).
4. **L0 Connect API** only if the goal is to make this client's venue adapters loadable *inside* Bookmap rather than external.

Bridge scope, mapped to features:

- `DepthEvent` + `MboEvent` → TraderMap Pro, stops/icebergs (entitled where the entitlement exists), sweeps, liquidity tracker.
- BookmapData via Java L1 → CME/Nasdaq/EDGX depth — **but those source entitlements are expired on this licence**, so this does not add usable symbols here.
- Replay via Java L1 (Python excludes it) → Record & Replay.

### Path C — Consume the licensed delivery gateway (fv00 route)

fv00's `services/data-hub/.../adapters/bookmap/` taps `web.bookmap.com` over CDP, mints channels from an existing delivery session and maintains a hub-owned socket. This obtains the same L2/MBO tape the app sees, but:

- it spends/protects the exclusive activation seat;
- the gateway rejects non-browser clients;
- it is operationally heavy (browser container, ~139% CPU on 2 vCPUs in fv00's incident notes).

Prefer Path A + Path B over reimplementing Path C.

---

## 8. Recommended roadmap

1. ~~**Close the cheap DERIVED gaps first**~~ — **DONE**: `lib/indicators.js`, `lib/bbo.js`, `GET /bbo`. No seat risk.
2. ~~**Add a Market Pulse client**~~ — **DONE**: `lib/mpulse.js`, `--mpulse`, `GET /mpulse`. No licence session. Refused upstream handshakes were traced to invalid default presets for the orderbook widgets and to reporting sockets connected before `AUTH_SUCCESS`; both are fixed, and retries mint a fresh token.
3. **Prototype the L1 websocket bridge** with a minimal Python add-on for MBO events — this is the only route to the entitled TraderMap Pro on crypto.
4. **Do not pursue** BookmapData/CME/Nasdaq/EDGX until those source entitlements are renewed; the current probe shows them expired.
5. **Never enable `--kick-seat`** in an automated deployment; the seat is shared with the user's own Bookmap app.

---

## 9. Evidence and limitations

- Feature entitlements resolved by `lib/features.js` from the live activation `fields` map; `/features` exposes the resolution.
- Client capabilities verified by live probes against `coinbase`, `binance`, `kraken`, `bybit`, `bitstamp`.
- API surface from the official knowledge-base pages (last updated Oct 2026 / Aug 2026) and the shipped L1 API 8.0.0 javadoc.
- **REA was unavailable** on this host (no registered tools/CLI; all `rea-agents` releases require Node ≥22, host has Node 20.18.0). No REA Evidence was produced. The jar/javadoc findings above come from ordinary shell inspection (`System.IO.Compression.ZipFile`) and are labelled as such.
- fv00 statements are cited from its checked-out source at `C:\Windows\TEMP\opencode\fv00` (clone of `mrme000m/fv00`); they are that project's findings, not independent verification here.

---

## 10. Revised status after Path A (2026-11-18)

Now implemented from the existing venue tape (no extra licence, no seat): CVD, large-trade
alerts, footprint, market profile / POC / value area, RSI / MACD / ADX / Williams %R, OBV,
anchored VWAP, strength, cross-venue BBO, and Market Pulse Price Change / Volume Pressure
Imbalance (opt-in with `--mpulse`).

Still open, unchanged by Path A:

- **MBO features** (TraderMap Pro, stops/icebergs, sweeps, MBO X-Ray, liquidity tracker):
  public crypto L2 has no order IDs. Only a Java/Python L1 bridge inside Bookmap can
  supply `MboEvent` / `MboSendEvent` / `MboCancelEvent` (§7 Path B).
- **UI/execution features** (DOM Pro, columns, bottom panel, sync charts, brackets,
  execution statistics, trading journal, break-even, setups): out of scope for a
  headless data service.
- **Record & Replay**: closed in wave 2 — see §12.
- **Rithmic, BookmapData, CME/Nasdaq/EDGX**: no adapter or expired source entitlements;
  do not pursue until the source filters are renewed.
- **Historical backfill (wave 3)**: the dxFeed path now requests `Candle` events with a
  per-subscription `fromTime` derived from the licence's max active
  `Subscription.HistoricalDepthHours.*` entitlement (`LOCAL=180` on the current key),
  warms up the TA indicator bars and serves `GET /history`. Depth beyond the live
  candle requires an entitled dxFeed token (the anonymous demo serves the live candle
  only). Depth-history replay (L2 beyond recordings) remains exclusive to the
  app's exchange adapters and BookmapData delivery.

`/features` is now the authoritative in-code status: each feature carries
`status` (`yes` / `derived` / `partial` / `no` / `not-entitled`) and a short `note`.

---

## 11. Additional binary findings folded into the client (2026-11-18)

- **dxFeed success code**: `DxFeedUtils$e.g.name()` in `dxfeed-adapter.jar` is the literal
  string `"g"`; `getToken-v11.php` therefore signals success with `code:"g"`, not `"OK"`.
  `lib/bookmapAuth.js` now recognises both, and `dxfeed.ok` drives the dxLink token wiring.
- **Activation keep-alive**: `velox.activation.p` shows a dedicated `keep-alive` endpoint
  next to `login`/`logout`/`tokenList/<GET|KICK>`. `BookmapAuth.keepAlive()` /
  `--keep-alive-ms` uses it, but only when the seat is explicitly bound.
- **Official symbol table**: the shipped client fetches
  `https://bookmap.com/api/v1/symbols/symbols_v7.tsv`. `lib/symbolTable.js` parses and caches
  it and exposes `GET /symbols/catalog?q=…` for canonical ↔ vendor symbol lookups
  (`dxFeed`, `BookmapData`, Rithmic, CQG, IB, …).
- Still deliberately not implemented: the BookmapData `SUBSCRIBE` delivery path (expired
  source entitlements; non-browser fingerprinting) and activation-response signature
  verification (the client relies on TLS instead).
- REA artifact inventory of both JARs (11,487 + 4,887 entries) and extraction of the
  locale/manifest resources produced no further capability manifests. Native REA
  analysis (Ghidra/IDA/Kuna/Hopper) is not configured on this host, so no native
  strings/functions were inspected. The recovered capability matrix is exposed at
  `GET /capabilities` with its REA evidence ids.

---

## 12. Wave 2 — code-closable gaps closed (2026-11-18)

The remaining Group 1 items from the gap-closure plan are now implemented and unit
tested (41 tests, `node --test test/`):

| Feature | Implementation |
|---|---|
| Liquidity Marker | `lib/derived.js` `DepthSignals` — depth-delta markers emitted as `kind:"liquidity"` |
| Absorption Indicator | `DepthSignals` — sell trade followed by bid replenishment ⇒ `kind:"absorption"` (heuristic; no order-level proof) |
| Outside Liquidity | `lib/derived.js` `outsideLiquidity()` — depth beyond top-N, in `/metrics` |
| Correlation Tracker | `lib/derived.js` `correlation()` + `GET /correlation?a=&b=&venue=` over rolling price returns |
| Instrument Copy | `GET /copy/<symbol>` — one book per tracking venue |
| Liquidation Indicator | `lib/venues/liquidations.js` — venue `binancef` (Binance USDT-M `!forceOrder@arr`) and venue `bybitlin` (Bybit v5 linear `allLiquidation`); events broadcast as `kind:"liquidation"` and buffered for `GET /liquidations` |
| Recording / Record & Replay | `--sink` NDJSON recording + `lib/replay.js` `--replay <file>`: `TimedReplay` mirrors the desktop app's replay engine (speed steps x2/:2 clamped [0.125, 8192], pause = speed 0, seek with forward fast-forward and backward state-rebuild, loop, time windows); live controls via `GET /replay` + `POST /replay/ctrl` |

New HTTP endpoints: `/correlation`, `/copy/<symbol>`, `/liquidations`.
New venues: `binancef`, `bybitlin` (feed-only; no order book, relaxed staleness).
`/features` status notes and the §5 matrix rows were updated accordingly.

Scope notes:

- Absorption is a heuristic over aggregated L2; real limit-order absorption needs MBO.
- Liquidation feeds are exchange-published fills (`forceOrder`, `allLiquidation`);
  Bookmap's *Liquidation Predictor* semantics are not reproduced.
- Replay is client-side NDJSON of this service's own recorded stream, not Bookmap's
  Java L1 replay module. Wave 3 aligned it with the app: REA inspection of the
  installed `C:\Program Files\Bookmap` artifacts (`BookmapRecorder.jar`,
  `bm-l1api.jar` `jx` reader, `Bookmap.jar` `providers.s` player / `velox.ib.E`) shows
  the app's replay is a fast file reader into a time-ordered event tree plus a player
  thread that owns virtual nanosecond time, ticks in 1 ms steps, treats pause as
  speed 0, steps speed x2 (up) / :2 (down) clamped to [0.125, `max_replay_speed`
  (default 8192)], and seeks by state-rebuild from the start. `TimedReplay`
  (`lib/replay.js`) mirrors all of these, controlled live via `GET /replay` and
  `POST /replay/ctrl`, and broadcasts `kind:"replay-time"` each second like the
  app's `CurrentTimeUserMessage`. The app's recording format (`DataRecorder`: one-char
  record tags `f/c/T/r/L/S/U/C/E/F`, nanosecond monotonic timestamps, `.bmf` feed +
  `.bmo` orders files with a 1016-byte metadata sidecar) documents the semantics our
  NDJSON sink covers with `kind`/`symbol`/`venue` fields.

Remaining blockers are unchanged: MBO features (§6.1, Path B bridge), UI/execution
features, and data venues without entitlements (BookmapData, CME/Nasdaq/EDGX,
Rithmic).
