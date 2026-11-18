'use strict';
// Resolve a WebSocket constructor without npm dependencies.
// Node >= 22 exposes a global WebSocket; Node 20 can enable it with
// --experimental-websocket. The optional "undici"/"ws" packages are used if present.

let cached = null;

function resolveWebSocket() {
  if (cached) return cached;
  if (typeof globalThis.WebSocket !== 'undefined') {
    cached = globalThis.WebSocket;
    return cached;
  }
  for (const mod of ['undici', 'ws']) {
    try {
      const m = require(mod);
      const C = m && (m.WebSocket || m);
      if (typeof C === 'function') {
        cached = C;
        return cached;
      }
    } catch { /* not installed */ }
  }
  throw new Error(
    'No WebSocket implementation available. Run on Node.js >= 22, or start with ' +
    '`node --experimental-websocket server.js` (Node 20), or install the optional "ws" package.'
  );
}

module.exports = { resolveWebSocket };
