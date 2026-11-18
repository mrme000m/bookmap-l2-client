'use strict';
// Coinbase Exchange public WebSocket L2 feed (level2_batch + ticker + heartbeat).
//   wss://ws-feed.exchange.coinbase.com
//   snapshot -> {type:"snapshot", product_id, bids:[[price,size]], asks:[[...]]}
//   update   -> {type:"l2update", product_id, changes:[["buy"|"sell",price,size]], sequence}
// Sequence gaps are repaired with the public REST book (level=2).

const { VenueBase } = require('./base');

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const REST_URL = 'https://api.exchange.coinbase.com';

class CoinbaseL2Client extends VenueBase {
  constructor(opts = {}) {
    super({ venue: 'coinbase', ...opts, url: opts.url || WS_URL });
    this.restUrl = opts.restUrl || REST_URL;
    this.seq = new Map();
    this.syncing = new Set();
  }

  _subscribe() {
    this.send({
      type: 'subscribe',
      product_ids: this.symbols,
      channels: ['level2_batch', 'ticker', 'matches', 'heartbeat'],
    });
  }

  _handle(msg) {
    switch (msg.type) {
      case 'snapshot': {
        const symbol = this.canonical(msg.product_id);
        this.seq.set(symbol, 0);
        this.emit('snapshot', symbol, _levels(msg.bids), _levels(msg.asks), {
          seq: 0, ts: Date.now(), venue: this.venue,
        });
        break;
      }
      case 'l2update': {
        const symbol = this.canonical(msg.product_id);
        if (this.syncing.has(symbol)) return;
        const seq = Number(msg.sequence) || 0;
        const prev = this.seq.get(symbol);
        if (prev != null && prev !== 0 && seq !== prev + 1) {
          this.emit('log', 'warn', `sequence gap ${symbol}: ${prev} -> ${seq}; resyncing`);
          this.emit('gap', symbol, { prev, seq });
          this._resync(msg.product_id);
          return;
        }
        this.seq.set(symbol, seq);
        for (const [side, price, size] of msg.changes || []) {
          this.emit('update', symbol, side === 'buy' ? 'bid' : 'ask', Number(price), Number(size), {
            seq, ts: Date.now(), venue: this.venue,
          });
        }
        break;
      }
      case 'ticker': {
        const symbol = this.canonical(msg.product_id);
        this.emit('ticker', symbol, {
          bidPrice: Number(msg.best_bid), bidSize: null,
          askPrice: Number(msg.best_ask), askSize: null,
          lastPrice: Number(msg.price), lastSize: Number(msg.last_size),
          time: msg.time || new Date().toISOString(),
        }, { seq: Number(msg.sequence), venue: this.venue });
        break;
      }
      case 'match':
      case 'last_match': {
        const symbol = this.canonical(msg.product_id);
        const ts = msg.time ? Date.parse(msg.time) : Date.now();
        this.emit('trade', symbol, msg.side === 'sell' ? 'sell' : 'buy',
          Number(msg.price), Number(msg.size), Number.isFinite(ts) ? ts : Date.now(),
          { seq: Number(msg.trade_id), venue: this.venue });
        break;
      }
      case 'heartbeat':
        break;
      case 'error':
        this.emit('log', 'error', `coinbase error: ${msg.message || msg.reason}`);
        break;
      case 'subscriptions':
        this.emit('log', 'info', `subscriptions confirmed: ${JSON.stringify(msg.channels)}`);
        break;
      default:
        break;
    }
  }

  async _resync(native) {
    const symbol = this.canonical(native);
    this.syncing.add(symbol);
    try {
      const j = await this._fetchJson(`${this.restUrl}/products/${native}/book?level=2`);
      const bids = (j.bids || []).map(([p, z]) => [Number(p), Number(z)]);
      const asks = (j.asks || []).map(([p, z]) => [Number(p), Number(z)]);
      const seq = Number(j.sequence) || 0;
      this.seq.set(symbol, seq);
      this.emit('snapshot', symbol, bids, asks, { seq, ts: Date.now(), venue: this.venue });
    } catch (e) {
      this.emit('log', 'error', `resync ${native} failed: ${e.message}`);
    } finally {
      this.syncing.delete(symbol);
    }
  }
}

function _levels(arr) {
  return (arr || []).map(([p, z]) => [Number(p), Number(z)]);
}

module.exports = { CoinbaseL2Client, WS_URL, REST_URL };
