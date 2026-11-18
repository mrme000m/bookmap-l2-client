'use strict';
// Append-only NDJSON/CSV sink with a small queue that respects stream backpressure.

const fs = require('fs');

class Sink {
  /**
   * @param {string} file
   * @param {'jsonl'|'csv'} [format] defaults to csv for *.csv, else jsonl
   */
  constructor(file, format) {
    this.file = file;
    this.format = (format || (String(file).toLowerCase().endsWith('.csv') ? 'csv' : 'jsonl')).toLowerCase();
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    this.queue = [];
    this.drain = false;
    this.closed = false;
    this.stream.on('drain', () => { this.drain = false; this._flush(); });
    if (this.format === 'csv') this.stream.write('ts,symbol,kind,side,price,size,venue,seq\n');
  }

  write(evt) {
    if (this.closed) return;
    this.queue.push(evt);
    if (!this.drain) this._flush();
  }

  _flush() {
    while (this.queue.length) {
      const evt = this.queue.shift();
      const line = this.format === 'csv' ? this._csv(evt) : JSON.stringify(evt);
      if (!this.stream.write(line + '\n')) {
        this.drain = true;
        this.queue.unshift(evt);
        return;
      }
    }
  }

  _csv(evt) {
    const d = evt.data || {};
    return [
      evt.ts || '',
      _cell(evt.symbol),
      evt.kind || '',
      _cell(d.side),
      d.price != null ? d.price : '',
      d.size != null ? d.size : '',
      _cell(evt.venue || d.venue),
      d.seq != null ? d.seq : '',
    ].join(',');
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
    try { this.stream.end(); } catch { /* ignore */ }
  }
}

function _cell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { Sink };
