'use strict';
// Coinbase Exchange public WebSocket L2 feed (level2_batch channel).
// Official public API, no credentials required for market data.
//   wss://ws-feed.exchange.coinbase.com
// Messages:
//   {type:"snapshot", product_id, bids:[[price,size],...], asks:[[price,size],...]}
//   {type:"l2update", product_id, changes:[[side("buy"|"sell"), price, size],...]}  size "0" => remove
//   {type:"heartbeat"} / {type:"subscriptions"} / {type:"error", message}

const { EventEmitter } = require('events');

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';

class CoinbaseL2Client extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string[]} opts.productIds e.g. ["BTC-USD","ETH-USD"]
   * @param {number} [opts.backoffMs] @param {number} [opts.maxBackoffMs]
   */
  constructor(opts) {
    super();
    this.productIds = opts.productIds;
    this.backoffMs = opts.backoffMs || 2000;
    this.maxBackoffMs = opts.maxBackoffMs || 60000;
    this.backoff = this.backoffMs;
    this.ws = null;
    this.state = 'idle';
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  start() { this.stopped = false; this._connect(); }

  stop() {
    this.stopped = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(1000, 'client stop'); } catch { /* ignore */ } }
    this.state = 'closed';
  }

  _connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    this.emit('log', 'info', `connecting ${WS_URL} products=${this.productIds.join(',')}`);
    let ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { this.emit('log', 'error', `connect failed: ${e.message}`); return this._reconnect(); }
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'connected';
      this.backoff = this.backoffMs;
      this.emit('log', 'info', `subscribing ${this.productIds.join(',')} (level2_batch)`);
      ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: this.productIds,
        channels: ['level2_batch', 'heartbeat'],
      }));
      this.keepaliveTimer = setInterval(() => {
        // level2_batch pushes data continuously; send ping frame to keep the socket warm
        if (ws.readyState === 1) { try { ws.ping && ws.ping(); } catch { /* ignore */ } }
      }, 15000);
    };

    ws.onerror = () => { /* onclose follows */ };

    ws.onclose = (e) => {
      clearInterval(this.keepaliveTimer);
      this.state = 'idle';
      this.emit('disconnected', e && e.code);
      this._reconnect();
    };

    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      this.lastFrameAt = Date.now();
      switch (msg.type) {
        case 'snapshot':
          this.state = 'authed';
          this.emit('snapshot', msg.product_id, msg.bids, msg.asks);
          break;
        case 'l2update':
          for (const [side, price, size] of msg.changes || []) {
            this.emit('update', msg.product_id, side, price, size);
          }
          break;
        case 'heartbeat':
          break;
        case 'error':
          this.emit('log', 'error', `coinbase error: ${msg.message || msg.reason}`);
          break;
        case 'subscriptions':
          this.emit('log', 'info', `subscriptions confirmed: ${JSON.stringify(msg.channels)}`);
          break;
      }
    };
  }

  _reconnect() {
    if (this.stopped) return;
    this.emit('log', 'warn', `reconnecting in ${Math.round(this.backoff / 1000)}s`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
  }
}

module.exports = { CoinbaseL2Client, WS_URL };
