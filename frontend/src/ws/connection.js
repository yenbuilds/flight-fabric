export function createConnection({
  windowRef = window,
  WebSocketRef = WebSocket,
  params = new URLSearchParams(windowRef.location.search),
  defaultWsPort = 8099,
  defaultHttpPort = 8100,
  reconnectDelay = 3000,
  setConnectionInfo = () => {},
  onConnecting = () => {},
  onOpen = () => {},
  onClose = () => {},
  onError = () => {},
  onMessage = () => {},
} = {}) {
  let ws = null;
  let reconnectTimer = null;
  let connectAttempt = 0;
  let resolvedWsPort = defaultWsPort;
  let resolvedHttpPort = defaultHttpPort;
  let resolvedHttpHost = '';
  let wsAuthToken = '';
  let aircraftControlToken = params.get('aircraftControlToken') || '';
  let authorizationScope = 'read-only';

  function getExplicitWsPort() {
    const value = Number(params.get('wsPort') || params.get('port') || params.get('ws'));
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
  }

  function applyBootstrapWsPort(payload) {
    if (getExplicitWsPort() != null) return;
    const value = Number(payload?.networkInfo?.wsPort);
    if (Number.isInteger(value) && value > 0 && value <= 65535) {
      resolvedWsPort = value;
    }
  }

  function getBackendHost() {
    const hostname = windowRef.location.hostname;
    return params.get('host') || params.get('ip') || (hostname && hostname.length > 0 ? hostname : null) || 'localhost';
  }

  async function resolveWsPort() {
    const explicitWsPort = getExplicitWsPort();
    if (explicitWsPort != null) {
      resolvedWsPort = explicitWsPort;
      return resolvedWsPort;
    }

    try {
      if (windowRef.electronAPI && typeof windowRef.electronAPI.getBackendWsPort === 'function') {
        const maybePort = Number(await windowRef.electronAPI.getBackendWsPort());
        if (Number.isFinite(maybePort) && maybePort > 0) {
          resolvedWsPort = maybePort;
        }
      }
    } catch {}
    return resolvedWsPort;
  }

  async function resolveBackendHttpPort() {
    const explicitPort = Number(params.get('httpPort') || params.get('http'));
    if (Number.isFinite(explicitPort) && explicitPort > 0) {
      resolvedHttpPort = explicitPort;
      return resolvedHttpPort;
    }

    try {
      if (windowRef.electronAPI && typeof windowRef.electronAPI.getBackendHttpPort === 'function') {
        const maybePort = Number(await windowRef.electronAPI.getBackendHttpPort());
        if (Number.isFinite(maybePort) && maybePort > 0) {
          resolvedHttpPort = maybePort;
          return resolvedHttpPort;
        }
      }
    } catch (err) {
      console.warn('[HTTP] Failed to resolve backend HTTP port from Electron:', err?.message || err);
    }

    const locationPort = Number(windowRef.location.port);
    if (
      (windowRef.location.protocol === 'http:' || windowRef.location.protocol === 'https:') &&
      Number.isFinite(locationPort) &&
      locationPort > 0
    ) {
      resolvedHttpPort = locationPort;
      return resolvedHttpPort;
    }

    // Last-resort fallback for non-Electron custom WS ports when no explicit
    // HTTP port is available. The backend uses this only when HTTP_PORT is unset.
    resolvedHttpPort = resolvedWsPort + 1;
    return resolvedHttpPort;
  }

  function getWsBaseUrl() {
    // When opening via file:// protocol, hostname is empty - use localhost.
    // Use localhost (not 127.0.0.1) to match backend binding.
    const host = getBackendHost();
    return `ws://${host}:${resolvedWsPort}`;
  }

  function getWsUrl() {
    const url = getWsBaseUrl();
    console.log('[WS] URL resolved:', { hostname: windowRef.location.hostname, url, protocol: windowRef.location.protocol });
    return url;
  }

  function getSocketUrl() {
    const url = getWsBaseUrl();
    const query = new URLSearchParams();
    if (wsAuthToken) query.set('token', wsAuthToken);
    if (aircraftControlToken) query.set('aircraftControlToken', aircraftControlToken);
    const serializedQuery = query.toString();
    return serializedQuery ? `${url}?${serializedQuery}` : url;
  }

  function getAuthorizationScope() {
    return authorizationScope;
  }

  function getBackendHttpBase() {
    const host = resolvedHttpHost || getBackendHost();
    return `http://${host}:${resolvedHttpPort}`;
  }

  function getBootstrapCandidates() {
    const host = getBackendHost();
    const candidates = [];
    const seen = new Set();
    const ports = [];

    function normalizeHost(value) {
      return String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
    }

    function loopbackAlternates(value) {
      const normalized = normalizeHost(value);
      if (normalized === 'localhost') return ['127.0.0.1'];
      if (normalized === '127.0.0.1' || normalized === '::1') return ['localhost'];
      return [];
    }

    function pushPort(port) {
      const numericPort = Number(port);
      if (!Number.isFinite(numericPort) || numericPort <= 0) return;
      if (!ports.includes(numericPort)) ports.push(numericPort);
    }

    function pushCandidate(candidateHost, port) {
      const numericPort = Number(port);
      if (!Number.isFinite(numericPort) || numericPort <= 0) return;
      const base = `http://${candidateHost}:${numericPort}`;
      if (seen.has(base)) return;
      seen.add(base);
      candidates.push({ base, host: candidateHost, port: numericPort });
    }

    pushPort(params.get('httpPort') || params.get('http'));
    pushPort(resolvedHttpPort);

    const locationPort = Number(windowRef.location.port);
    if (
      (windowRef.location.protocol === 'http:' || windowRef.location.protocol === 'https:') &&
      host === (windowRef.location.hostname || 'localhost')
    ) {
      pushPort(locationPort);
    }

    pushPort(resolvedWsPort + 1);

    for (const port of ports) {
      pushCandidate(host, port);
    }
    for (const alternateHost of loopbackAlternates(host)) {
      for (const port of ports) {
        pushCandidate(alternateHost, port);
      }
    }

    return candidates;
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocketRef.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch (err) {
        console.warn('[WS] Failed to send message:', err?.message || err);
        return false;
      }
    }
    return false;
  }

  function closeCurrentSocket() {
    authorizationScope = 'read-only';
    const socketToClose = ws;
    ws = null;
    if (!socketToClose) return;
    socketToClose.onopen = null;
    socketToClose.onclose = null;
    socketToClose.onerror = null;
    socketToClose.onmessage = null;
    try { socketToClose.close(); } catch (_) {}
  }

  async function resolveWsAuthToken(isCurrentAttempt = () => true) {
    // Electron already provides a sender-validated main-process proxy. Prefer
    // that path so browser-origin bootstrap requests never need session
    // secrets. Standalone browser clients retain the HTTP bootstrap below.
    if (typeof windowRef.electronAPI?.getBackendBootstrap === 'function') {
      try {
        const result = await windowRef.electronAPI.getBackendBootstrap();
        if (!isCurrentAttempt()) return '';
        const payload = result?.body && typeof result.body === 'object' ? result.body : result;
        applyBootstrapWsPort(payload);
        const token = typeof payload?.wsAuthToken === 'string' ? payload.wsAuthToken : '';
        const scopedToken = typeof payload?.aircraftControlToken === 'string' ? payload.aircraftControlToken : '';
        if (token || scopedToken) {
          wsAuthToken = token;
          if (scopedToken) aircraftControlToken = scopedToken;
          resolvedHttpHost = '127.0.0.1';
          const fallbackPort = Number(result?.port);
          if (Number.isFinite(fallbackPort) && fallbackPort > 0) {
            resolvedHttpPort = fallbackPort;
          }
          return wsAuthToken;
        }
      } catch (err) {
        if (!isCurrentAttempt()) return '';
        console.warn('[WS] Failed to resolve websocket auth token through Electron:', err?.message || err);
      }
    }

    const fetchImpl = windowRef.fetch || globalThis.fetch;
    if (typeof fetchImpl === 'function') {
      for (const candidate of getBootstrapCandidates()) {
        try {
          const response = await fetchImpl(`${candidate.base}/api/bootstrap`);
          if (!isCurrentAttempt()) return '';
          if (!response.ok) continue;

          const payload = await response.json();
          if (!isCurrentAttempt()) return '';
          applyBootstrapWsPort(payload);
          wsAuthToken = typeof payload?.wsAuthToken === 'string' ? payload.wsAuthToken : '';
          if (typeof payload?.aircraftControlToken === 'string' && payload.aircraftControlToken) {
            aircraftControlToken = payload.aircraftControlToken;
          }
          resolvedHttpHost = candidate.host;
          resolvedHttpPort = candidate.port;
          return wsAuthToken;
        } catch (err) {
          if (!isCurrentAttempt()) return '';
          console.warn('[WS] Failed to resolve websocket auth token from:', candidate.base, err?.message || err);
        }
      }
    }

    if (!isCurrentAttempt()) return '';
    wsAuthToken = '';
    return wsAuthToken;
  }

  async function connect() {
    const attempt = ++connectAttempt;
    // A credential in the URL is only a claim. Controls remain read-only until
    // the server acknowledges the scope granted for this exact socket.
    authorizationScope = 'read-only';

    // Stop the previous socket before resolving fresh connection metadata so
    // no stale acknowledged capability survives an asynchronous reconnect.
    closeCurrentSocket();
    onConnecting();
    await resolveWsAuthToken(() => attempt === connectAttempt);
    if (attempt !== connectAttempt) return;

    // The desktop renderer is expected to have full control, but it can load
    // a moment before the backend HTTP bootstrap listener is ready. Do not
    // silently settle into a read-only socket in that narrow startup window;
    // retry the sender-validated Electron bootstrap instead. Browser/mobile
    // clients have no such IPC bridge and continue to connect read-only.
    if (typeof windowRef.electronAPI?.getBackendBootstrap === 'function' && !wsAuthToken) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        void connect();
      }, reconnectDelay);
      return;
    }

    const wsUrl = getSocketUrl();
    setConnectionInfo(getWsUrl());

    ws = new WebSocketRef(wsUrl);

    ws.onopen = () => {
      clearTimeout(reconnectTimer);
      onOpen({ ws, send });
    };

    ws.onclose = (ev) => {
      authorizationScope = 'read-only';
      ws = null;
      onClose(ev);
      reconnectTimer = setTimeout(() => {
        void connect();
      }, reconnectDelay);
    };

    ws.onerror = (ev) => {
      authorizationScope = 'read-only';
      onError(ev);
    };

    ws.onmessage = (ev) => {
      try {
        const message = JSON.parse(ev.data);
        if (
          message?.type === 'authorizationScope'
          && ['read-only', 'aircraft-control', 'full-control'].includes(message.scope)
        ) {
          authorizationScope = message.scope;
        }
        onMessage(message);
      } catch (e) {
        console.error('[WS] Message handling error:', e, 'Data:', ev.data?.substring?.(0, 200));
      }
    };
  }

  function reconnect() {
    closeCurrentSocket();
    clearTimeout(reconnectTimer);
    void connect();
  }

  async function initialize() {
    await resolveWsPort();
    await resolveBackendHttpPort();
    await connect();
  }

  return {
    connect,
    getBackendHttpBase,
    getAuthorizationScope,
    getResolvedHttpPort: () => resolvedHttpPort,
    getWs: () => ws,
    getWsUrl,
    initialize,
    reconnect,
    send,
  };
}
