'use strict';
// Bookmap app-level authentication, reconstructed from the shipped client:
//   1. email + password -> GET key via /v1/inPlatformLogin/getKey.php (scripts*.activation.bookmap.com)
//      (or accept a license key directly)
//   2. license key -> activation /login (public*.activation.bookmap.com/ActivationAPI-v1/)
//      returns {result, token, fields:{...entitlements...}}
//   3. (optional) dxFeed token via https://bookmap.com/api/v1/dxfeed/getToken-v11.php
//      POST login=<licenseKey>&password=&filters=<json array of lowercased filter names>
// The filters are the lowercased DxDataFilter names the app derives from the license fields.

const { resolveFeatures, resolveVenues, parseValue } = require('./features');

const SCRIPT_SERVERS = [
  'https://scripts1.activation.bookmap.com',
  'https://scripts2.activation.bookmap.com',
  'https://scripts3.activation.bookmap.com',
];
const ACTIVATION_SERVERS = [
  'https://public1.activation.bookmap.com/ActivationAPI-v1/',
  'https://public2.activation.bookmap.com/ActivationAPI-v1/',
  'https://public3.activation.bookmap.com/ActivationAPI-v1/',
];
const TOKEN_URL = 'https://bookmap.com/api/v1/dxfeed/getToken-v11.php';
const LICENSE_RE = /^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/;

const DXFILTERS = {
  NASDAQ: 'nasdaq_rt', EDGX: 'edgx_rt', NBBO: 'ctautp_rt',
  CME: 'cme_rt', CBOT: 'cbot_rt', NYMEX: 'nymex_rt', COMEX: 'comex_rt',
  ICE: 'ice_rt', CFE: 'cboe_fut_rt', XEUR: 'eurex_rt',
  INDICATORS: 'dxfeed_ind_rt', INDEXES: 'cboe_ind_rt',
};
const DEMO_FILTERS = ['nasdaq_demo', 'cme_demo'];

function form(obj) {
  return Object.entries(obj).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

async function postForm(url, obj, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form(obj),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

function parseJson(text, url) {
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 160)}`); }
}

async function tryServers(servers, fn) {
  let last;
  for (const s of servers) {
    try { return await fn(s); }
    catch (e) { last = e; }
  }
  throw last || new Error('No servers configured');
}

class BookmapAuth {
  /**
   * @param {object} opts
   * @param {string} [opts.email] @param {string} [opts.password]
   * @param {string} [opts.licenseKey] one of email/password or licenseKey is required
   * @param {boolean} [opts.kick] take over an existing activation session (default false)
   * @param {boolean} [opts.login] bind the activation seat (default false)
   * @param {object} [opts.machineInfo] sent to the activation server (default minimal)
   */
  constructor(opts = {}) {
    this.email = opts.email || '';
    this.password = opts.password || '';
    this.licenseKey = opts.licenseKey || '';
    // The activation seat is exclusive: "login:true" binds it and "kick:true"
    // kills a real user's live session. Both are opt-in; a plain entitlement
    // probe uses login:false and takes nothing.
    this.kick = opts.kick === true;
    this.login = opts.login === true;
    this.machineInfo = opts.machineInfo || {
      osName: 'node', osArch: process.arch, hostName: require('os').hostname(),
      javaVersion: 'bookmap-l2-client',
    };
    this.result = null;
  }

  /** email + password -> license key (code "OK") */
  async emailToKey() {
    if (!this.email || !this.password) throw new Error('email and password are required');
    const raw = await tryServers(SCRIPT_SERVERS, (s) =>
      postForm(s + '/v1/inPlatformLogin/getKey.php', { login: this.email, password: this.password }));
    const j = parseJson(raw, 'getKey.php');
    if (!j || j.code !== 'OK' || !j.key) {
      throw new Error(`Bookmap login failed (code=${j && j.code})`);
    }
    if (!LICENSE_RE.test(j.key)) throw new Error('Activation server returned a malformed license key');
    this.licenseKey = j.key;
    return j.key;
  }

  /**
   * license key -> activation fields (+ an activation token when the seat is bound)
   *
   * login:false is a status probe: it returns the entitlement fields without
   * taking the exclusive activation seat. login:true binds the seat, which is
   * what a real client session needs and what a read-only probe must avoid.
   */
  async activate() {
    if (!this.licenseKey) throw new Error('license key is required');
    const payload = {
      kick: this.kick,
      key: this.licenseKey,
      login: this.login,
      type: 'DESKTOP',
      machineInfo: typeof this.machineInfo === 'string' ? this.machineInfo : JSON.stringify(this.machineInfo),
    };
    const raw = await tryServers(ACTIVATION_SERVERS, (s) =>
      postForm(s + 'login', { json: JSON.stringify(payload) }));
    const j = parseJson(raw, 'activation login');
    if (j.result !== 'OK') {
      throw new Error(`Bookmap activation failed (result=${j.result})`);
    }
    this.activation = j;
    return j;
  }

  /**
   * Entitlement check. License fields are either a flag ("1"/"0") or an expiry
   * date ("YYYY-MM-DD HH:MM:SS", GMT). A date in the past means not entitled.
   *
   * Numeric values are LIMITS, not expiries ("20" = max 20 instruments,
   * "168" = 168 hours of history). They are entitled whenever positive.
   */
  _active(fields, key) {
    const v = fields && fields[key];
    if (v === undefined || v === null || v === '') return false;
    const s = String(v).trim();
    if (s === '1' || s.toLowerCase() === 'true') return true;
    if (s === '0' || s.toLowerCase() === 'false') return false;
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s) > 0;
    const t = Date.parse(s.replace(' ', 'T') + 'Z');
    return Number.isFinite(t) && t > Date.now();
  }

  /** derive dxFeed filters from the license entitlement fields */
  filtersFromLicense(fields) {
    const filters = [];
    if (this._active(fields, 'Subscription.DxFeed') || this._active(fields, 'Allow_DxFeed')) {
      for (const [field, filter] of Object.entries(DXFILTERS)) {
        const source = fields['Subscription.DxFeed.Source.' + field];
        if (source && this._active(fields, 'Subscription.DxFeed.Source.' + field)) filters.push(filter);
      }
    }
    return [...new Set(filters)];
  }

  /**
   * Crypto venues the license entitles (Bookmap calls them "adapters").
   * Live crypto L2 comes straight from the exchange, gated by these fields.
   * @returns {string[]} e.g. ['Binance','CoinbasePro']
   */
  cryptoAdapters(fields) {
    if (!this._active(fields, 'Allow_Crypto')) return [];
    const out = [];
    for (const [k, v] of Object.entries(fields || {})) {
      if (!k.startsWith('ADAPTER.')) continue;
      const name = k.slice('ADAPTER.'.length);
      if (name.includes('.')) continue; // sub-feature (e.g. ADAPTER.BookmapData.NASDAQ.enabled)
      if (!parseValue(v).active) continue;
      out.push(name);
    }
    return out.sort();
  }

  /** max number of crypto instruments the license allows (default 1) */
  maxCryptoInstruments(fields) {
    const v = Number((fields || {})['Crypto_Max_Instruments']);
    return Number.isFinite(v) && v > 0 ? v : 1;
  }

  /**
   * Full entitlement map from the activation response, with each feature resolved
   * to {active, expires, value}. Keys observed in the shipped Bookmap client:
   *   Allow_*                feature switches (Allow_Crypto, Allow_POC, Allow_LTracker,
   *                          Allow_Rithmic, Allow_Replay, Allow_Trading, Allow_SyncCharts, ...)
   *   Subscription.*         subscription scopes (Subscription.DxFeed.Source.*,
   *                          Subscription.MaxInstruments.*, Subscription.HistoricalDepthHours.*)
   *   ADAPTER.<venue>        crypto venue adapters
   *   *_Expiration_Date      dated entitlements
   * @returns {Object<string, {active:boolean, kind:string, expires:string|null, limit:number|null, value:string}>}
   */
  entitlements(fields) {
    const out = {};
    for (const [key, value] of Object.entries(fields || {})) {
      const parsed = parseValue(value);
      out[key] = {
        active: parsed.active,
        kind: parsed.kind,
        expires: parsed.expires || null,
        limit: parsed.limit != null ? parsed.limit : null,
        value: String(value).trim(),
      };
    }
    return out;
  }

  /** max number of instruments the license allows to be viewed at once */
  maxInstruments(fields) {
    const f = fields || {};
    const total = Number(f['Subscription.MaxInstruments.TOTAL']);
    if (Number.isFinite(total) && total > 0) return total;
    let max = 0;
    for (const [k, v] of Object.entries(f)) {
      if (!k.startsWith('Subscription.MaxInstruments.')) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max || 0;
  }

  /** POST to the dxFeed token server; returns {code, token}; code OK means success */
  async getDxFeedToken(filters) {
    if (!this.licenseKey) throw new Error('license key is required');
    const body = 'login=' + encodeURIComponent(this.licenseKey) + '&password=&filters=' +
      encodeURIComponent(JSON.stringify(filters));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body, signal: ctrl.signal,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} from token server: ${text.slice(0, 160)}`);
      return parseJson(text, TOKEN_URL);
    } finally {
      clearTimeout(t);
    }
  }

  /** release the activation session (best effort) */
  async logout() {
    if (!this.activation || !this.activation.token) return false;
    try {
      await tryServers(ACTIVATION_SERVERS, (s) =>
        postForm(s + 'logout', { json: JSON.stringify({ token: this.activation.token }) }));
      return true;
    } catch { return false; }
  }

  /**
   * Full app-level auth. Returns:
   * {licenseKey, activation:{result,token,fields}, dxfeed:{filters,token,code},
   *  crypto:{adapters,maxInstruments}}
   */
  async authenticate({ requestDxFeedToken = true, filters = null } = {}) {
    if (!this.licenseKey && this.email && this.password) await this.emailToKey();
    const activation = await this.activate();
    const derived = filters || this.filtersFromLicense(activation.fields);
    let dxfeed = null;
    if (requestDxFeedToken && derived.length) {
      const resp = await this.getDxFeedToken(derived);
      dxfeed = { filters: derived, code: resp.code, token: resp.token || null };
    }
    const crypto = {
      adapters: this.cryptoAdapters(activation.fields),
      maxInstruments: this.maxCryptoInstruments(activation.fields),
    };
    this.result = {
      licenseKey: this.licenseKey,
      activation,
      dxfeed,
      crypto,
      entitlements: this.entitlements(activation.fields),
      maxInstruments: this.maxInstruments(activation.fields),
      features: resolveFeatures(activation.fields),
      dataVenues: resolveVenues(activation.fields),
    };
    return this.result;
  }
}

module.exports = {
  BookmapAuth, SCRIPT_SERVERS, ACTIVATION_SERVERS, TOKEN_URL, LICENSE_RE,
  DXFILTERS, DEMO_FILTERS,
};
