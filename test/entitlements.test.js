'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { BookmapAuth } = require('../lib/bookmapAuth');
const { parseValue, resolveFeatures, resolveVenues } = require('../lib/features');

test('parseValue: numeric limits are not dates', () => {
  // Date.parse("168") yields year 168 -> a negative timestamp; a bare number
  // is a LIMIT (hours, instruments, sessions), not an expiry.
  const hours = parseValue('168');
  assert.equal(hours.kind, 'limit');
  assert.equal(hours.active, true);
  assert.equal(hours.limit, 168);
  assert.equal(hours.expires, undefined);

  assert.equal(parseValue('20').kind, 'limit');
  assert.equal(parseValue('20').active, true);
  assert.equal(parseValue('0').kind, 'flag');
  assert.equal(parseValue('0').active, false);
  assert.equal(parseValue('1').kind, 'flag');
  assert.equal(parseValue('1').active, true);
  assert.equal(parseValue('true').active, true);
  assert.equal(parseValue('').kind, 'empty');

  const expiry = parseValue('2038-01-01 23:59:59');
  assert.equal(expiry.kind, 'expiry');
  assert.equal(expiry.active, true);
  assert.equal(parseValue('2000-01-01 00:00:00').active, false);
});

test('_active: numeric limits are entitled, expired dates are not', () => {
  const auth = new BookmapAuth({});
  const fields = {
    'Crypto_Max_Instruments': '20',
    'Subscription.MaxInstruments.TOTAL': '20',
    'Multibook.maxConcurrentSessions': '1000000',
    'Allow_Crypto': '1',
    'Allow_DxFeed': '2038-01-01 23:59:59',
    'Subscription.DxFeed.Source.CME': '2000-01-01 00:00:00',
  };
  assert.equal(auth._active(fields, 'Crypto_Max_Instruments'), true);
  assert.equal(auth._active(fields, 'Subscription.MaxInstruments.TOTAL'), true);
  assert.equal(auth._active(fields, 'Multibook.maxConcurrentSessions'), true);
  assert.equal(auth._active(fields, 'Allow_Crypto'), true);
  assert.equal(auth._active(fields, 'Allow_DxFeed'), true);
  assert.equal(auth._active(fields, 'Subscription.DxFeed.Source.CME'), false);
});

test('entitlements(): exposes kind, limit and expiry', () => {
  const auth = new BookmapAuth({});
  const e = auth.entitlements({
    'Crypto_Max_Instruments': '20',
    'Allow_Crypto': '1',
    'Allow_DxFeed': '2038-01-01 23:59:59',
    'Expired': '2000-01-01 00:00:00',
  });
  assert.equal(e['Crypto_Max_Instruments'].kind, 'limit');
  assert.equal(e['Crypto_Max_Instruments'].limit, 20);
  assert.equal(e['Crypto_Max_Instruments'].active, true);
  assert.equal(e['Crypto_Max_Instruments'].expires, null);
  assert.equal(e['Allow_Crypto'].kind, 'flag');
  assert.equal(e['Allow_DxFeed'].kind, 'expiry');
  assert.ok(e['Allow_DxFeed'].expires);
  assert.equal(e['Expired'].active, false);
});

test('cryptoAdapters(): skips sub-features, keeps numeric and dated venues', () => {
  const auth = new BookmapAuth({});
  const adapters = auth.cryptoAdapters({
    'Allow_Crypto': '1',
    'ADAPTER.CoinbasePro': '2038-01-01 23:59:59',
    'ADAPTER.Binance': '2038-01-01 23:59:59',
    'ADAPTER.Bitstamp': '2038-01-01 23:59:59',
    'ADAPTER.BookmapData.NASDAQ.enabled': '2000-01-01 00:00:00',
    'ADAPTER.Dead': '2000-01-01 00:00:00',
  });
  assert.deepEqual(adapters, ['Binance', 'Bitstamp', 'CoinbasePro']);
});

test('seat safety: kick and login are opt-in', () => {
  assert.equal(new BookmapAuth({}).kick, false);
  assert.equal(new BookmapAuth({}).login, false);
  assert.equal(new BookmapAuth({ kick: true }).kick, true);
  assert.equal(new BookmapAuth({ login: true }).login, true);
  // legacy "kick !== false" semantics must not sneak the default back on
  assert.equal(new BookmapAuth({ kick: false }).kick, false);
});

test('resolveFeatures(): maps the product feature list onto entitlement keys', () => {
  const fields = {
    'STRATEGY.BM.CVD': '2040-01-01 00:00:00',
    'STRATEGY.BM.Indicators.Footprint': '2038-01-01 23:59:59',
    'STRATEGY.MP.Indicators.387262.61.Footprint': '2038-01-01 23:59:59',
    'STRATEGY.BM.Indicators.TechnicalAnalysis.RSI': '2040-01-01 00:00:00',
    'Allow_POC': '2038-01-01 23:59:59',
    'Allow_Crypto': '1',
    'ADAPTER.BookmapData': '2039-01-01 00:00:00',
    'ADAPTER.BookmapData.CMEGROUP.enabled': '2000-01-01 00:00:00',
  };
  const features = resolveFeatures(fields);
  const byId = Object.fromEntries(features.map((f) => [f.id, f]));
  assert.equal(byId.cvd.entitled, true);
  assert.equal(byId.footprint.entitled, true);
  assert.equal(byId['ta-rsi'].entitled, true);
  assert.equal(byId.poc.entitled, true);
  assert.equal(byId.crypto.entitled, true);
  assert.equal(byId['mbo-stops-icebergs'].entitled, false);
  assert.equal(byId['options-gamma'].entitled, false);

  const venues = resolveVenues(fields);
  const v = Object.fromEntries(venues.map((x) => [x.id, x]));
  assert.equal(v.bookmapdata.entitled, true);
  assert.equal(v.cmegroup.entitled, false);
});
