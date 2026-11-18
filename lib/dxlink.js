'use strict';
// DxLink WebSocket client: handshake, auth, FEED + DOM channels, keepalive, auto-reconnect.
// Protocol reference: dxFeed dxLink specification (asyncapi.yml).

const { EventEmitter } = require('events');

const PROTOCOL_VERSION = '0.1-js/1.0.0';

class DxLinkClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url              wss endpoint
   * @param {string} [opts.token]          dxLink auth token (empty for anonymous/demo)
   * @param {number} [opts.keepaliveMs]    client keepalive send interval
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.token = opts.token || '';
    this.keepaliveMs = opts.keepaliveMs || 10000;
    this.backoffMs = opts.backoffMs || 2000;
    this.maxBackoffMs = opts.maxBackoffMs || 60000;

    this.ws = null;
    this.state = 'idle'; // idle | connecting | connected | authed | closed
    this.serverSetup = null;
    this.feedChannel = null;
    this.domChannels = new Map(); // symbol -> channelId
    this.nextChannel = 1;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.backoff = this.backoffMs;
    this.stopped = false;

    // pending actions to replay after (re)connection
    this.feedPendingSub = null;      // array of {type, symbol}
    this.feedSetupConfig = null;     // {acceptAggregationPeriod, acceptDataFormat, acceptEventFields}
    this.domPending = new Map();     // symbol -> {sources, setup:{acceptAggregationPeriod, acceptDepthLimit}}
  }

  // ---- lifecycle ----

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
    this.emit('log', 'info', `connecting ${this.url}${this.token ? ' (auth)' : ' (anonymous)'}`);
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.emit('log', 'error', `connect failed: ${e.message}`); this._scheduleReconnect(); return; }
    this.ws = ws;

    const fail = (msg) => { this.emit('log', 'error', msg); this._scheduleReconnect(); };

    ws.onopen = () => {
      this.state = 'connected';
      this.backoff = this.backoffMs;
      this.feedChannel = null;
      this.domChannels.clear();
      // Current dxLink servers expect client SETUP first.
      this._send({ type: 'SETUP', channel: 0, version: PROTOCOL_VERSION, keepaliveTimeout: 30, acceptKeepaliveTimeout: 60, address: '' });
      if (this.token) this._send({ type: 'AUTH', channel: 0, token: this.token });
      this.keepaliveTimer = setInterval(() => {
        if (ws.readyState === 1) this._send({ type: 'KEEPALIVE', channel: 0 });
      }, this.keepaliveMs);
    };

    ws.onerror = () => { /* onclose follows */ };

    ws.onclose = (e) => {
      clearInterval(this.keepaliveTimer);
      if (this.state === 'authed' || this.state === 'connected') {
        this.state = 'idle';
        this.emit('disconnected', e && e.code);
        this._scheduleReconnect();
      } else {
        fail(`websocket closed before setup (code=${e && e.code})`);
      }
    };

    ws.onmessage = (m) => { this._onFrame(String(m.data)); };
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    this.state = 'idle';
    this.emit('log', 'warn', `reconnecting in ${Math.round(this.backoff / 1000)}s`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
  }

  // ---- frame handling ----

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  _onFrame(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { this.emit('log', 'warn', `non-json frame: ${raw.slice(0, 120)}`); return; }
    this.lastFrameAt = Date.now();
    switch (msg.type) {
      case 'SETUP':
        this.serverSetup = msg;
        this.emit('log', 'info', `server setup version=${msg.version}`);
        this.state = 'authed' === this.state ? this.state : 'connected';
        break;
      case 'AUTH_STATE':
        if (msg.state === 'UNAUTHORIZED') {
          this.emit('log', 'error', 'UNAUTHORIZED: token missing, invalid, or lacks entitlements for this endpoint');
        }
        this.emit('authState', msg.state);
        if (msg.state === 'AUTHORIZED') {
          this.state = 'authed';
          this.emit('ready');
          this._replaySubscriptions();
        }
        break;
      case 'KEEPALIVE':
        break;
      case 'CHANNEL_OPENED':
        this._onChannelOpened(msg);
        break;
      case 'CHANNEL_CLOSED':
        this.emit('log', 'info', `channel ${msg.channel} closed by server`);
        break;
      case 'FEED_CONFIG':
        this.emit('feedConfig', msg);
        break;
      case 'FEED_DATA':
        this.emit('feedData', msg.channel, msg.data);
        break;
      case 'DOM_CONFIG':
        this.emit('domConfig', msg);
        break;
      case 'DOM_SNAPSHOT':
        this.emit('domSnapshot', msg);
        break;
      case 'ERROR':
        this.emit('error', msg);
        break;
      default:
        this.emit('log', 'debug', `unhandled type=${msg.type}`);
    }
  }

  _onChannelOpened(msg) {
    if (msg.service === 'FEED') {
      this.feedChannel = msg.channel;
      const cfg = this.feedSetupConfig || {
        acceptAggregationPeriod: 0.1,
        acceptDataFormat: 'FULL',
        acceptEventFields: {
          Quote: ['eventType', 'eventSymbol', 'bidPrice', 'bidSize', 'askPrice', 'askSize'],
          Trade: ['eventType', 'eventSymbol', 'price', 'size', 'dayVolume'],
          MarketDepth: ['eventType', 'eventSymbol', 'bidAsk', 'market', 'price', 'size', 'eventFlags'],
          Candle: ['eventType', 'eventSymbol', 'eventTime', 'time', 'sequence', 'count', 'open', 'high', 'low', 'close', 'volume', 'vwap'],
        },
      };
      this._send({ type: 'FEED_SETUP', channel: msg.channel, ...cfg });
      if (this.feedPendingSub && this.feedPendingSub.length) {
        this._send({ type: 'FEED_SUBSCRIPTION', channel: msg.channel, add: this.feedPendingSub });
      }
      this.emit('log', 'info', `FEED channel ${msg.channel} opened`);
    } else if (msg.service === 'DOM') {
      const pending = this._domPendingFor(msg.channel);
      const symbol = pending && pending.symbol;
      if (symbol) {
        this.domChannels.set(symbol, msg.channel);
        const setup = (pending && pending.setup) || { acceptAggregationPeriod: 0, acceptDepthLimit: 20 };
        this._send({ type: 'DOM_SETUP', channel: msg.channel, ...setup });
        this.emit('log', 'info', `DOM channel ${msg.channel} opened for ${symbol}`);
      }
    }
  }

  _domPendingFor(channelId) {
    for (const [symbol, p] of this.domPending) {
      if (p.requestedChannel === channelId) return { symbol, sources: p.sources, setup: p.setup };
      if (!p.requestedChannel) {
        p.requestedChannel = channelId;
        return { symbol, sources: p.sources, setup: p.setup };
      }
    }
    return null;
  }

  _replaySubscriptions() {
    if (this.feedPendingSub && this.feedPendingSub.length) {
      this.openFeedChannel(this.feedPendingSub);
    }
    for (const [symbol, p] of this.domPending) {
      p.requestedChannel = null;
      this.openDomChannel(symbol, p.sources, p.setup);
    }
  }

  // ---- public actions ----

  /** @param {Array<{type:string,symbol:string}>} items */
  openFeedChannel(items) {
    this.feedPendingSub = items || this.feedPendingSub || [];
    if (this.state !== 'authed' || this.feedChannel) return;
    const ch = this.nextChannel++;
    this._send({ type: 'CHANNEL_REQUEST', channel: ch, service: 'FEED', parameters: { contract: 'AUTO' } });
  }

  sendFeedSetup(cfg) { this.feedSetupConfig = cfg; }

  subscribeFeed(items) {
    this.feedPendingSub = items;
    if (this.state === 'authed' && this.feedChannel) {
      this._send({ type: 'FEED_SUBSCRIPTION', channel: this.feedChannel, add: items });
    }
  }

  /** @param {string} symbol @param {string[]} sources @param {object} [setup] */
  openDomChannel(symbol, sources, setup) {
    this.domPending.set(symbol, { sources: sources || ['ntv'], setup: setup || { acceptAggregationPeriod: 0, acceptDepthLimit: 20 } });
    if (this.state !== 'authed') return;
    const ch = this.nextChannel++;
    this.domPending.get(symbol).requestedChannel = ch;
    this._send({ type: 'CHANNEL_REQUEST', channel: ch, service: 'DOM', parameters: { symbol, sources: this.domPending.get(symbol).sources } });
  }
}

module.exports = { DxLinkClient, PROTOCOL_VERSION };
