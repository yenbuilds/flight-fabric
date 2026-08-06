/**
 * Shared telemetry UI client for index.html and compact widget browser sources.
 * Handles WebSocket connection and provides message dispatch
 */

// Classic script loaded by standalone OBS widgets before their inline scripts.
// TelemetryUI is exported to window for widget inline scripts.

const DEFAULT_WS_PORT = 8099;
const DEFAULT_HTTP_PORT = 8100;

let ws = null;
let reconnectTimer = null;
let resolvedWsPort = DEFAULT_WS_PORT;
let resolvedHttpPort = DEFAULT_HTTP_PORT;
let wsAuthToken = '';
let resolvingWsPortPromise = null;
let messageHandlers = [];
let connectionHandlers = { connect: [], disconnect: [] };

function getParams() {
  try {
    return new URLSearchParams(window.location.search || '');
  } catch {
    return new URLSearchParams('');
  }
}

function getBackendHost() {
  const params = getParams();
  return params.get('host') || params.get('ip') || location.hostname || 'localhost';
}

async function resolveWsPort() {
  if (resolvingWsPortPromise) return resolvingWsPortPromise;

  resolvingWsPortPromise = Promise.resolve()
    .then(async () => {
      const params = getParams();
      const explicitPort = Number(params.get('port') || params.get('wsPort') || params.get('ws'));
      if (Number.isFinite(explicitPort) && explicitPort > 0) {
        resolvedWsPort = explicitPort;
        return;
      }

      if (window.electronAPI && typeof window.electronAPI.getBackendWsPort === 'function') {
        const maybePort = Number(await window.electronAPI.getBackendWsPort());
        if (Number.isFinite(maybePort) && maybePort > 0) {
          resolvedWsPort = maybePort;
        }
      }
    })
    .catch(() => {})
    .finally(() => {
      resolvingWsPortPromise = null;
    });

  return resolvingWsPortPromise;
}

async function resolveHttpPort() {
  const params = getParams();
  const explicitPort = Number(params.get('httpPort') || params.get('http'));
  if (Number.isFinite(explicitPort) && explicitPort > 0) {
    resolvedHttpPort = explicitPort;
    return resolvedHttpPort;
  }

  if (window.electronAPI && typeof window.electronAPI.getBackendHttpPort === 'function') {
    try {
      const maybePort = Number(await window.electronAPI.getBackendHttpPort());
      if (Number.isFinite(maybePort) && maybePort > 0) {
        resolvedHttpPort = maybePort;
        return resolvedHttpPort;
      }
    } catch {}
  }

  const locationPort = Number(location.port);
  if (
    (location.protocol === 'http:' || location.protocol === 'https:')
    && Number.isFinite(locationPort)
    && locationPort > 0
  ) {
    resolvedHttpPort = locationPort;
    return resolvedHttpPort;
  }

  resolvedHttpPort = DEFAULT_HTTP_PORT;
  return resolvedHttpPort;
}

function getBootstrapCandidates() {
  const params = getParams();
  const host = getBackendHost();
  const candidates = [];
  const seen = new Set();

  function pushCandidate(port) {
    const numericPort = Number(port);
    if (!Number.isFinite(numericPort) || numericPort <= 0) return;
    const base = `http://${host}:${numericPort}`;
    if (seen.has(base)) return;
    seen.add(base);
    candidates.push(base);
  }

  pushCandidate(params.get('httpPort') || params.get('http'));
  pushCandidate(resolvedHttpPort);
  pushCandidate(location.port);
  pushCandidate(DEFAULT_HTTP_PORT);

  return candidates;
}

async function resolveWsAuthToken() {
  const fetchImpl = window.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    wsAuthToken = '';
    return wsAuthToken;
  }

  await resolveHttpPort();

  for (const base of getBootstrapCandidates()) {
    try {
      const response = await fetchImpl(`${base}/api/bootstrap`);
      if (!response || !response.ok) continue;
      const payload = await response.json();
      wsAuthToken = typeof payload?.wsAuthToken === 'string' ? payload.wsAuthToken : '';
      return wsAuthToken;
    } catch (err) {
      console.warn('[TelemetryUI] Failed to resolve websocket token from:', base, err?.message || err);
    }
  }

  wsAuthToken = '';
  return wsAuthToken;
}

// ===== WebSocket Connection =====
async function connect() {
  await resolveWsPort();
  await resolveWsAuthToken();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = getBackendHost();
  const port = resolvedWsPort;
  const tokenQuery = wsAuthToken ? `?token=${encodeURIComponent(wsAuthToken)}` : '';
  
  try {
    ws = new WebSocket(`${protocol}//${host}:${port}${tokenQuery}`);
  } catch (err) {
    console.error('WebSocket connection failed:', err);
    scheduleReconnect();
    return;
  }
  
  ws.onopen = () => {
    clearTimeout(reconnectTimer);
    connectionHandlers.connect.forEach(fn => fn());
  };
  
  ws.onclose = () => {
    connectionHandlers.disconnect.forEach(fn => fn());
    scheduleReconnect();
  };
  
  ws.onerror = () => ws.close();
  
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      dispatch(msg);
    } catch (err) {
      console.error('Message parse error:', err);
    }
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

function dispatch(msg) {
  messageHandlers.forEach(fn => {
    try {
      fn(msg);
    } catch (err) {
      console.error('Handler error:', err);
    }
  });
}

// ===== Public API =====
const TelemetryUI = {
  /**
   * Start WebSocket connection
   */
  connect: connect,
  
  /**
   * Register a message handler
   * @param {function(msg: object): void} handler
   */
  onMessage: function(handler) {
    if (typeof handler === 'function') {
      messageHandlers.push(handler);
    }
  },
  
  /**
   * Register connection state handlers
   * @param {function(): void} onConnect
   * @param {function(): void} onDisconnect
   */
  onConnectionChange: function(onConnect, onDisconnect) {
    if (typeof onConnect === 'function') {
      connectionHandlers.connect.push(onConnect);
    }
    if (typeof onDisconnect === 'function') {
      connectionHandlers.disconnect.push(onDisconnect);
    }
  },
  
  /**
   * Send a message to the server
   * @param {object} msg
   */
  send: function(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  },
  
  /**
   * Check if connected
   * @returns {boolean}
   */
  isConnected: function() {
    return ws && ws.readyState === WebSocket.OPEN;
  },

  /**
   * Shared formatting / decoding helpers used by multiple strip files.
   */
  utils: {
    /** Left-pad a number to 2 digits. */
    pad2: function(n) { return String(n).padStart(2, '0'); },

    /**
     * Decompose milliseconds into hours / minutes / seconds.
     * @param {number} ms
     * @returns {{ h:number, m:number, s:number }}
     */
    decompose: function(ms) {
      const totalSec = Math.floor(ms / 1000);
      return {
        h: Math.floor(totalSec / 3600),
        m: Math.floor((totalSec % 3600) / 60),
        s: totalSec % 60,
      };
    },

    /**
     * Decode a gear telemetry object into a string state.
     * Uses position thresholds only — the `locked` field is unreliable because
     * SimConnect sets gearDownLocked to 0|1 (not a bitmask), so
     * `(gearDownLocked & 0b111) === 0b111` is always false from SimConnect.
     * Threshold >= 0.99 matches the compact widget and bottom strip.
     * @param {{ left:number, right:number, nose?:number }} data
     * @returns {'DOWN'|'UP'|'TRANSIT'}
     */
    gearState: function(data) {
      const allDown = data.left >= 0.99 && data.right >= 0.99 && (data.nose == null || data.nose >= 0.99);
      const allUp   = data.left <  0.01 && data.right <  0.01 && (data.nose == null || data.nose <  0.01);
      if (allDown) return 'DOWN';
      if (allUp)   return 'UP';
      return 'TRANSIT';
    },
  },
};

window.TelemetryUI = TelemetryUI;
