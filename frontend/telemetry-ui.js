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

function booleanLike(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === 'no') return false;
  }
  return null;
}

function resolveStabilityVerdict(stability) {
  if (!stability || typeof stability !== 'object') return 'no_verdict';
  const explicit = typeof (stability.verdict ?? stability.stabilityVerdict) === 'string'
    ? String(stability.verdict ?? stability.stabilityVerdict).trim().toLowerCase().replace(/[\s-]+/g, '_')
    : '';
  if (['stable', 'marginal', 'unstable', 'no_verdict'].includes(explicit)) return explicit;

  const rawFailures = Array.isArray(stability.gateFailures)
    ? stability.gateFailures
    : typeof stability.gateFailures === 'string'
      ? stability.gateFailures.split('|')
      : [];
  const failures = rawFailures
    .map((failure) => String(failure || '').trim())
    .filter((failure) => failure && failure !== 'spoilers_moved_after_gate');
  if (failures.some((failure) => failure === 'insufficient_data' || failure === 'no_gate_sample')) {
    return 'no_verdict';
  }

  const score = stability.score != null && Number.isFinite(Number(stability.score))
    ? Number(stability.score)
    : null;
  const breakdown = stability.breakdown && typeof stability.breakdown === 'object'
    ? stability.breakdown
    : null;
  const finiteMetric = (key) => {
    const value = breakdown?.[key];
    return value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const gateStable = booleanLike(stability.gateStable);
  const hardFailures = new Set([
    'gear_not_down_at_gate',
    'gear_changed_after_gate',
    'flaps_not_set_at_gate',
    'flaps_changed_after_gate',
  ]);
  if (failures.some((failure) => hardFailures.has(failure))) return 'unstable';
  if (score !== null && score < 80) return 'unstable';
  if (['speed_ok', 'vs_ok', 'pitch_ok', 'bank_ok', 'lateral_offset_ok']
    .some((key) => finiteMetric(key) !== null && finiteMetric(key) < 60)) return 'unstable';
  if (['config_ok', 'gear_ok', 'flaps_ok']
    .some((key) => finiteMetric(key) !== null && finiteMetric(key) < 80)) return 'unstable';
  if (gateStable === true) return 'stable';
  const rawFailuresWereRecorded = Array.isArray(stability.gateFailures)
    || typeof stability.gateFailures === 'string';
  if (gateStable !== false && rawFailuresWereRecorded && failures.length === 0) return 'stable';
  if (gateStable === false || failures.length > 0) return 'marginal';
  return 'no_verdict';
}

function landingPresentation(data) {
  const landing = data && typeof data === 'object' ? data : {};
  const nestedTouchdown = landing.touchdownDistance && typeof landing.touchdownDistance === 'object'
    ? landing.touchdownDistance
    : null;
  const topLevelBounceCount = landing.bounceCount;
  const hasTopLevelBounce = (
    topLevelBounceCount !== null
    && topLevelBounceCount !== undefined
    && topLevelBounceCount !== ''
    && Number.isFinite(Number(topLevelBounceCount))
  ) || (typeof landing.bounceGrade === 'string' && landing.bounceGrade.trim().length > 0);
  const touchdown = hasTopLevelBounce
    ? {
        ...(nestedTouchdown || {}),
        bounceCount: nestedTouchdown?.bounceCount ?? landing.bounceCount,
        bounceGrade: nestedTouchdown?.bounceGrade ?? landing.bounceGrade,
      }
    : nestedTouchdown;
  const stability = landing.ultimateStability && typeof landing.ultimateStability === 'object'
    ? landing.ultimateStability
    : null;
  const distanceFt = Number(touchdown?.distanceFt);
  const hasDistance = touchdown?.distanceFt != null && Number.isFinite(distanceFt);
  const shortLanding = booleanLike(landing.shortLanding) === true
    || booleanLike(touchdown?.shortLanding) === true
    || String(touchdown?.grade || '').trim().toUpperCase() === 'SHORT LANDING'
    || (hasDistance && distanceFt < 0);
  const runwayExcursion = booleanLike(landing.runwayExcursion ?? landing.runway_excursion) === true;
  const touchdownZoneGrade = shortLanding ? 'Short Landing' : touchdown?.grade;
  const tdzGrade = touchdownZoneGrade ? String(touchdownZoneGrade).trim().toUpperCase() : '--';

  const rawBounceCount = touchdown?.bounceCount;
  const hasBounceCount = rawBounceCount !== null
    && rawBounceCount !== undefined
    && rawBounceCount !== ''
    && Number.isFinite(Number(rawBounceCount));
  const bounceGrade = typeof touchdown?.bounceGrade === 'string' && touchdown.bounceGrade.trim()
    ? touchdown.bounceGrade.trim()
    : null;
  const bounceKnown = hasBounceCount || Boolean(bounceGrade);
  let bounceCount = hasBounceCount ? Math.max(0, Math.round(Number(rawBounceCount))) : 0;
  const bounceMinimums = { 'Single Bounce': 1, 'Multiple Bounces': 2, 'Repeated Bounces': 3, Porpoise: 4 };
  if (bounceGrade && bounceGrade !== 'Clean') bounceCount = Math.max(bounceCount, bounceMinimums[bounceGrade] || 1);

  const stabilityScoreValue = Number(stability?.score);
  const stabilityScore = stability?.score != null && Number.isFinite(stabilityScoreValue)
    ? Math.round(stabilityScoreValue)
    : null;
  const touchdownRateGrade = String(landing.grade || '--').trim().toUpperCase();
  const stabilityVerdict = resolveStabilityVerdict(stability);
  const gateVerdict = stability
    ? ({ stable: 'STABLE', marginal: 'MARGINAL', unstable: 'UNSTABLE', no_verdict: 'NO VERDICT' }[stabilityVerdict])
    : null;
  const stabilityLabel = gateVerdict || (stabilityScore != null ? `${stabilityScore}%` : '--');
  const stabilityDetail = gateVerdict && stabilityScore != null ? `${stabilityScore}%` : '';
  const approachLabel = gateVerdict || (stabilityScore != null ? 'NO VERDICT' : '--');
  const approachScoreText = stabilityScore != null ? `${stabilityScore}% score` : '';
  const bounceLabel = bounceKnown ? (bounceCount === 0 ? 'CLEAN' : `${bounceCount}x`) : '--';

  return {
    touchdownGrade: touchdownRateGrade,
    touchdownGradeClass: touchdownRateGrade.replace(/\s+/g, '-'),
    tdzGrade,
    runwayExcursion,
    gateVerdict,
    stabilityScore,
    approachLabel,
    approachScoreText,
    approachClass: stabilityVerdict === 'unstable'
      ? 'low'
      : stabilityVerdict === 'marginal'
        ? 'medium'
        : stabilityVerdict === 'stable' ? 'high' : 'neutral',
    stabilityLabel,
    stabilityDetail,
    stabilityText: gateVerdict
      ? `${gateVerdict}${stabilityScore != null ? ` ${stabilityScore}%` : ''}`
      : (stabilityScore != null ? `${stabilityScore}%` : ''),
    stabilityClass: stabilityVerdict === 'unstable'
      ? 'low'
      : stabilityVerdict === 'marginal'
        ? 'medium'
        : stabilityVerdict === 'stable' ? 'high' : 'neutral',
    bounceKnown,
    bounceCount,
    bounceLabel,
    bounceClass: !bounceKnown ? 'neutral' : bounceCount === 0 ? 'high' : bounceCount >= 3 ? 'low' : 'medium',
    bounceText: bounceKnown ? (bounceCount === 0 ? 'CLEAN' : `${bounceCount}x`) : '',
  };
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

    /** Build the compact widgets' shared landing verdict presentation. */
    landingPresentation: landingPresentation,

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
