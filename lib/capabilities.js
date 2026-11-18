'use strict';
// Capability manifest recovered from the shipped Bookmap artifacts with REA.
// It records what the adapter can do, which of those abilities this client
// actually implements, and the evidence ids for auditability.

const { FEATURE_STATUS, parseValue } = require('./features');

const ADAPTER_METADATA = {
  plugin_name: 'bookmapdata-adapter',
  plugin_version: '0.17.3',
  api_version: '2',
  bm_version_min: '8.0.0.1',
  bm_version_max: '8.1.1.9999',
  trading: true,
  mbo: true,
  adapter_entry_points: [{
    name: 'BookmapData',
    class_name: 'com.bookmap.datadelivery.client.BookmapDataProvider',
    license_name: 'BookmapData',
    trading: true,
    mbo: true,
  }],
  topic: 'production',
};

const EVIDENCE = {
  adapterArchive: 'b2ad37718464f21d88c63ee2720dd3c02686c3ad9142b3934d378c831dadc508',
  adapterInventory: 'ev_c2530bb365af1ffd6092291a1b8e29460187ea62628385750221ab992f530184',
  adapterResourceView: 'ev_84d9675c0f26e52f73c55e058b32e5bcfcdd85b20e09403adf62fd3f41923187',
  adapterExtraction: 'ev_75a92cb7006f9450ed2e1b8347b11d223fa6baea5645691abde3618f08248ef2',
  bookmapJarInventory: 'ev_349d1f5f0d0a9636dfdd07b21cef475aedf6d4f886916b707f59d881fa6685d5',
};

const RECOVERED_ENDPOINTS = {
  activation: ['login', 'keep-alive', 'logout', 'tokenList/GET', 'tokenList/KICK', 'embedded-activation/check-license-fields.php'],
  dxfeedToken: 'https://bookmap.com/api/v1/dxfeed/getToken-v11.php',
  symbolTable: 'https://bookmap.com/api/v1/symbols/symbols_v7.tsv',
  bookmapAuth: ['https://auth1.data.delivery.bookmap.com', 'https://auth2.data.delivery.bookmap.com', 'https://auths.data.delivery.bookmap.com'],
  mpulse: 'https://beta.mpulse.bookmap.com/meta/api/v1',
  historical: ['http://cme-real.hist.bookmap.com/', 'http://nasdaq-real-router.hist.bookmap.com/', 'http://multibook-real-v2.hist.bookmap.com/'],
};

const AGREEMENTS = [
  'Bookmap Data Subscriber Agreement',
  'CME Group Market Data Subscription Agreement',
  'NASDAQ OMX Global Subscriber Agreement',
  'CBOE Market Data Subscriber Agreement',
];

/** Static capability view, optionally refined by a live entitlement `fields` map. */
function capabilities(fields) {
  const implemented = Object.entries(FEATURE_STATUS)
    .filter(([, v]) => v[0] === 'yes')
    .map(([id, v]) => ({ id, note: v[1] }));
  const out = {
    adapter: ADAPTER_METADATA,
    agreements: AGREEMENTS,
    recoveredEndpoints: RECOVERED_ENDPOINTS,
    implemented,
    evidence: EVIDENCE,
    limitations: [
      'REA native analysis (Ghidra/IDA/Kuna/Hopper) is not configured on this host; findings are from artifact inventory and extracted resources.',
      'Trading, MBO and BookmapData delivery are capabilities of the shipped adapter, not of this headless client.',
      'The BookmapData SUBSCRIBE delivery path is not implemented (expired source entitlements and non-browser fingerprinting).',
    ],
  };
  if (fields) {
    out.license = {
      allowCrypto: parseValue(fields.Allow_Crypto || '0').active,
      allowDxFeed: parseValue(fields.Allow_DxFeed || '0').active,
      bookmapData: parseValue(fields['ADAPTER.BookmapData'] || '0').active,
    };
  }
  return out;
}

module.exports = { capabilities, ADAPTER_METADATA, EVIDENCE, RECOVERED_ENDPOINTS, AGREEMENTS };
