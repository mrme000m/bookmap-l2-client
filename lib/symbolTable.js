'use strict';
// Bookmap's official symbol table, discovered in the shipped client:
//   https://bookmap.com/api/v1/symbols/symbols_v7.tsv
// One row per instrument with vendor-specific aliases, including the columns
// `dxFeed`, `dxFeed Exchange`, `BookmapData`, `BookmapData Type` and
// `BookmapData Exchange`. It lets the client resolve a human name to the exact
// symbol an upstream expects without guessing.

const SYMBOL_URL = 'https://bookmap.com/api/v1/symbols/symbols_v7.tsv';
const TTL_MS = 6 * 60 * 60 * 1000;

let cache = null;

function parseTsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return [];
  const header = lines[0].split('\t').map(s => s.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = (cells[i] || '').trim();
    rows.push(row);
  }
  return rows;
}

async function load(opts = {}) {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS && !opts.refresh) return cache.rows;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 20000);
  try {
    const r = await fetch(SYMBOL_URL, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`symbol table HTTP ${r.status}`);
    const rows = parseTsv(await r.text());
    cache = { at: now, rows };
    return rows;
  } finally { clearTimeout(timer); }
}

function find(rows, query, opts = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const limit = opts.limit || 25;
  const columns = opts.columns || ['Name', 'dxFeed', 'BookmapData'];
  const out = [];
  for (const row of rows || []) {
    const hit = columns.some(c => String(row[c] || '').toLowerCase().includes(q));
    if (!hit) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { SYMBOL_URL, parseTsv, load, find };
