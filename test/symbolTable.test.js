'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTsv, find, SYMBOL_URL } = require('../lib/symbolTable');
const { dxfeedSuccess } = require('../lib/bookmapAuth');

const TSV = [
  'Name\tPips\tdxFeed\tBookmapData\tBookmapData Exchange',
  'E-Mini S&P 500 Futures\t0.25\tES[M][YY]\tES[M][YY]\tCME',
  'Bitcoin / USD\t0.01\tBTC/USD\tBTC-USD\tMULTIBOOK',
].join('\n');

test('symbol table: TSV parsing and lookup', () => {
  assert.match(SYMBOL_URL, /symbols_v7\.tsv$/);
  const rows = parseTsv(TSV);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].BookmapData, 'BTC-USD');
  const hit = find(rows, 'bitcoin', { limit: 5 });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].dxFeed, 'BTC/USD');
  assert.equal(find(rows, '', { limit: 5 }).length, 0);
});

test('dxfeed: success code is the obfuscated "g" (or legacy "OK")', () => {
  assert.equal(dxfeedSuccess({ code: 'g', token: 't' }), true);
  assert.equal(dxfeedSuccess({ code: 'OK', token: 't' }), true);
  assert.equal(dxfeedSuccess({ token: 't' }), true);
  assert.equal(dxfeedSuccess({ code: 'NOT_ALLOWED_BY_LICENSE', token: '' }), false);
});
