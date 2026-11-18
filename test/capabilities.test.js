'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { capabilities, ADAPTER_METADATA } = require('../lib/capabilities');

test('capabilities: REA-backed adapter manifest and client implementation list', () => {
  const c = capabilities({ Allow_Crypto: '1', Allow_DxFeed: '0', 'ADAPTER.BookmapData': '0' });
  assert.equal(c.adapter.api_version, '2');
  assert.equal(c.adapter.mbo, true);
  assert.equal(c.adapter.adapter_entry_points[0].class_name, 'com.bookmap.datadelivery.client.BookmapDataProvider');
  assert.ok(c.implemented.some(x => x.id === 'cvd'));
  assert.ok(c.implemented.some(x => x.id === 'price-and-bbo'));
  assert.equal(c.license.allowCrypto, true);
  assert.equal(c.license.allowDxFeed, false);
  assert.ok(ADAPTER_METADATA.evidence || Object.keys(c.evidence).length >= 4);
});
