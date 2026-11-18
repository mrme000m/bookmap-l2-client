'use strict';
// Map Bookmap's product feature list onto the entitlement keys the activation
// server returns, so a license can be asked "is X enabled for me?".
//
// The activation `fields` map is the authoritative source. Two namespaces carry
// the feature information:
//
//   STRATEGY.*   the desktop application's indicators, addons and plugins
//   Allow_*      application-level switches (POC, Replay, SyncCharts, ...)
//   ADAPTER.*    the data venues the licence may stream
//
// Values are a flag ("1"/"0"), a numeric limit ("20", "168") or an expiry
// timestamp ("YYYY-MM-DD HH:MM:SS", GMT). A past timestamp means not entitled.

const FEATURES = [
  // ---- order flow / tape ----
  { id: 'cvd', name: 'Cumulative Volume Delta (CVD)', keys: ['STRATEGY.BM.CVD', 'STRATEGY.CvdIndicator'] },
  { id: 'large-trades-alert', name: 'Large Trades Alert', keys: ['STRATEGY.VoiceAlertsOnLargeTrades'] },
  { id: 'liquidity-marker', name: 'Liquidity Marker', keys: ['STRATEGY.BM.Indicators.LiquidityMarker'] },
  { id: 'market-pulse', name: 'Market Pulse', keys: ['STRATEGY.BM.Indicators.MarketPulse', 'STRATEGY.BM.Indicators.MarketPulse2'] },
  { id: 'price-change', name: 'Market Pulse Price Change', keys: ['STRATEGY.BM.Indicators.MarketPulse2.Algorithms.Expiration.priceChange'] },
  { id: 'orderbook-imbalance', name: 'Order Book Imbalance', keys: ['STRATEGY.BM.OrderbookImbalance'] },
  { id: 'volume-imbalance', name: 'Volume Imbalance', keys: ['STRATEGY.BM.VolumeImbalance'] },
  { id: 'trade-impact', name: 'Trade Impact', keys: ['STRATEGY.BM.Indicators.TradeImpact'] },
  { id: 'footprint', name: 'Footprint', keys: ['STRATEGY.MP.Indicators.387262.61.Footprint'] },
  { id: 'absorption', name: 'Absorption Indicator', keys: ['STRATEGY.BM.Indicators.Absorption'] },
  { id: 'sweeps', name: 'Sweep Indicator', keys: ['STRATEGY.BM.Indicators.Sweeps'] },
  { id: 'strength', name: 'Strength Indicator', keys: ['STRATEGY.BM.Indicators.StrengthLevel'] },
  { id: 'market-profile', name: 'Market Profile / DOM Pro', keys: ['STRATEGY.BM.Indicators.MarketProfile'] },
  { id: 'dom-pro', name: 'DOM Pro', keys: ['STRATEGY.MP.Addons.238554.130.Edge_Trader_DOM'] },
  { id: 'breakeven', name: 'Break Even Point', keys: ['STRATEGY.BM.Indicators.BreakevenPoint'] },
  { id: 'correlation', name: 'Correlation Tracker', keys: ['STRATEGY.BM.Indicators.CorrelationTracker'] },
  { id: 'liquidation', name: 'Liquidation Indicator', keys: ['STRATEGY.BM.Indicators.CryptocurrencyLiquidations', 'STRATEGY.BM.Indicators.LiquidationPredictor'] },
  { id: 'outside-liquidity', name: 'Outside Liquidity', keys: ['STRATEGY.BM.Indicators.OutsideLiquidity'] },
  { id: 'midpoint', name: 'Midpoint', keys: ['STRATEGY.BM.Indicators.Midpoint'] },
  { id: 'price-and-bbo', name: 'Cross BBO', keys: ['STRATEGY.BM.Indicators.PriceAndBBO'] },
  { id: 'vwap', name: 'AVWAP / VWAP', keys: ['STRATEGY.BM.Indicators.VWAP', 'Allow_VWAP'] },
  { id: 'setups', name: 'Setups Checklist', keys: ['STRATEGY.BM.Indicators.SetupsChecklist'] },
  { id: 'price-lines', name: 'Price Levels / Price Lines', keys: ['STRATEGY.MP.Indicators.257626.130.Price_Lines'] },
  { id: 'time-and-sales', name: 'Time & Sales', keys: ['STRATEGY.TimeAndSaleWindow'] },
  { id: 'price-alert', name: 'Price Alerts', keys: ['STRATEGY.MP.Indicators.2042765773603072096.1679001.Price_Alert'] },
  { id: 'notes', name: 'Notes Column', keys: ['STRATEGY.MP.Indicators.313457.61.Notes_Pro'] },

  // ---- technical analysis ----
  { id: 'ta-williamsr', name: 'Technical Analysis: Williams %R', keys: ['STRATEGY.BM.Indicators.TechnicalAnalysis.WilliamsR'] },
  { id: 'ta-rsi', name: 'Technical Analysis: RSI', keys: ['STRATEGY.BM.Indicators.TechnicalAnalysis.RSI'] },
  { id: 'ta-obv', name: 'Technical Analysis: OBV', keys: ['STRATEGY.BM.Indicators.TechnicalAnalysis.OBV'] },
  { id: 'ta-macd', name: 'Technical Analysis: MACD', keys: ['STRATEGY.BM.Indicators.TechnicalAnalysis.MACD'] },
  { id: 'ta-adx', name: 'Technical Analysis: ADX', keys: ['STRATEGY.BM.Indicators.TechnicalAnalysis.ADX'] },

  // ---- MBO bundle ----
  { id: 'mbo-stops-icebergs', name: 'MBO: Stops & Icebergs Tracker', keys: ['STRATEGY.BM.Indicators.StopsAndIcebergs'] },
  { id: 'mbo-liquidity-tracker', name: 'MBO: Liquidity Tracker Pro', keys: ['STRATEGY.MP.Indicators.2801.7.Liquidity_tracker_MBO'] },
  { id: 'mbo-tradermap', name: 'MBO: TraderMap Pro', keys: ['STRATEGY.BM.Indicators.TradermapPro'] },
  { id: 'mbo-xray', name: 'MBO: MBO X-Ray', keys: ['STRATEGY.MP.Indicators.-1509826352181832153.61.MBO_X_Ray'] },
  { id: 'mbo-icebergs-tracker', name: 'MBO: Icebergs Tracker', keys: ['STRATEGY.BM.Indicators.IcebergsTracker'] },
  { id: 'mbo-b3-icebergs', name: 'MBO: B3 Icebergs on Chart', keys: ['STRATEGY.BM.Indicators.B3_IcebergsOnChart'] },

  // ---- order flow tools / book views ----
  { id: 'multibook', name: 'Multibook (Consolidated Order Book)', keys: ['STRATEGY.BM.Indicators.ConsolidatedOrderBook', 'Multibook.enabled'] },
  { id: 'instrument-copy', name: 'Instrument Copy', keys: ['STRATEGY.BM.Indicators.InstrumentCopy'] },
  { id: 'large-orders-filter', name: 'Large Lot Tracker / Large Orders Filter', keys: ['STRATEGY.BmDemo-LargeOrdersFilter'] },
  { id: 'execution-statistics', name: 'Execution Pro (Statistics)', keys: ['STRATEGY.BM.Addons.ExecutionStatistics'] },
  { id: 'multi-account', name: 'Multi-Account Trading', keys: ['STRATEGY.BM.Addons.MultiAccountTrading'] },
  { id: 'multibrackets', name: 'Multibrackets', keys: ['STRATEGY.BM.Addons.Multibrackets'] },
  { id: 'trading-journal', name: 'Trading Journal', keys: ['TradingJournal.AITools.enabled'] },
  { id: 'options-gamma', name: 'Options: SPX Gamma Levels', keys: ['STRATEGY.BM.Indicators.SpotgammaOptions'] },
  { id: 'configure-columns', name: 'Volume / Quotes / Delta Columns', keys: ['Allow_ConfigureColumns'] },

  // ---- application switches ----
  { id: 'poc', name: 'Point of Control Indicator', keys: ['Allow_POC'] },
  { id: 'liquidity-tracker', name: 'Liquidity Tracker', keys: ['Allow_LTracker'] },
  { id: 'replay', name: 'Record & Replay', keys: ['Allow_Replay', 'INSTANCES.REPLAY'] },
  { id: 'recording', name: 'Recording', keys: ['Allow_Recording', 'Allow_OrdersRecording'] },
  { id: 'sync-charts', name: 'Sync Charts', keys: ['Allow_SyncCharts'] },
  { id: 'data-export', name: 'Data Export', keys: ['Allow_DataExport'] },
  { id: 'trading', name: 'Real-time Simulated Trading', keys: ['Allow_Trading'] },
  { id: 'crypto', name: 'Crypto data', keys: ['Allow_Crypto'] },
  { id: 'dxfeed', name: 'dxFeed data', keys: ['Allow_DxFeed'] },
  { id: 'rithmic', name: 'Rithmic data', keys: ['Allow_Rithmic'] },
  { id: 'bottom-panel', name: 'Bottom Panel', keys: ['Allow_BottomPanel'] },
];

const VENUE_FEATURES = [
  { id: 'bookmapdata', name: 'BookmapData', keys: ['ADAPTER.BookmapData'] },
  { id: 'cmegroup', name: 'CME Group (BookmapData)', keys: ['ADAPTER.BookmapData.CMEGROUP.enabled'] },
  { id: 'nasdaq', name: 'Nasdaq (BookmapData)', keys: ['ADAPTER.BookmapData.NASDAQ.enabled'] },
  { id: 'edgx', name: 'EDGX (BookmapData)', keys: ['ADAPTER.BookmapData.EDGX.enabled'] },
];

function parseValue(value) {
  const s = String(value).trim();
  if (s === '') return { kind: 'empty', active: false };
  if (s === '1' || s.toLowerCase() === 'true') return { kind: 'flag', active: true };
  if (s === '0' || s.toLowerCase() === 'false') return { kind: 'flag', active: false };
  // A bare number is a LIMIT ("20" instruments, "168" hours, "1000000" sessions).
  // It must be tested before Date.parse, which happily reads "168" as a year.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return { kind: 'limit', active: n > 0, limit: n };
  }
  const t = Date.parse(s.replace(' ', 'T') + 'Z');
  if (Number.isFinite(t)) {
    return { kind: 'expiry', active: t > Date.now(), expires: new Date(t).toISOString() };
  }
  return { kind: 'opaque', active: false };
}

/**
 * Resolve the product feature list against a licence's entitlement fields.
 * @param {Object<string,string>} fields activation response `fields`
 * @returns {Array<{id,name,entitled,keys,evidence}>}
 */
function resolveFeatures(fields) {
  const out = [];
  for (const feature of FEATURES) {
    const evidence = [];
    let entitled = false;
    for (const key of feature.keys) {
      if (!(key in (fields || {}))) continue;
      const parsed = parseValue(fields[key]);
      evidence.push({ key, value: String(fields[key]), ...parsed });
      if (parsed.active) entitled = true;
    }
    out.push({
      id: feature.id,
      name: feature.name,
      entitled,
      keys: feature.keys.filter((k) => k in (fields || {})),
      evidence,
    });
  }
  return out;
}

/** Data venues the licence may stream. */
function resolveVenues(fields) {
  const out = [];
  for (const venue of VENUE_FEATURES) {
    const evidence = [];
    let entitled = false;
    for (const key of venue.keys) {
      if (!(key in (fields || {}))) continue;
      const parsed = parseValue(fields[key]);
      evidence.push({ key, value: String(fields[key]), ...parsed });
      if (parsed.active) entitled = true;
    }
    out.push({ id: venue.id, name: venue.name, entitled, evidence });
  }
  return out;
}

module.exports = { FEATURES, VENUE_FEATURES, parseValue, resolveFeatures, resolveVenues };
