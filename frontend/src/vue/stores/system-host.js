import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

function getElectronApi() {
  if (typeof window !== 'undefined' && window.electronAPI) return window.electronAPI;
  if (typeof globalThis !== 'undefined' && globalThis.electronAPI) return globalThis.electronAPI;
  return null;
}

function normalizeStatus(value, fallback = 'unknown') {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return status || fallback;
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

const PRIVATE_172_RE = /^172\.(1[6-9]|2[0-9]|3[01])\./;

function normalizeHost(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function isPhoneReachableHost(value) {
  const host = normalizeHost(value);
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
  if (host.startsWith('127.')) return false;
  if (host.includes(':')) return false;
  return true;
}

function scorePhoneHost(value) {
  const host = normalizeHost(value);
  if (host.startsWith('192.168.')) return 400;
  if (host.startsWith('10.')) return 300;
  if (PRIVATE_172_RE.test(host)) return 200;
  if (host.startsWith('169.254.')) return -1000;
  return -500;
}

function getBrowserLocation() {
  if (typeof window !== 'undefined' && window.location) return window.location;
  if (typeof globalThis !== 'undefined' && globalThis.location) return globalThis.location;
  return null;
}

function getBrowserLanHostFallback() {
  const location = getBrowserLocation();
  const hostname = location?.hostname;
  return isPhoneReachableHost(hostname) ? normalizeHost(hostname) : '';
}

function getBrowserBackendPortFallback() {
  const location = getBrowserLocation();
  if (!location || !isPhoneReachableHost(location.hostname)) return null;
  const pathname = String(location.pathname || '');
  if (pathname.startsWith('/frontend/')) return null;
  return normalizePort(location.port);
}

function getBrowserWsPortFallback() {
  const search = String(getBrowserLocation()?.search || '');
  if (!search) return null;
  try {
    const params = new URLSearchParams(search);
    return normalizePort(params.get('wsPort') || params.get('port') || params.get('ws'));
  } catch {
    return null;
  }
}

function currentBrowserUrlHasAircraftControlPairing() {
  const location = getBrowserLocation();
  const search = String(location?.search || '');
  if (!search) return false;
  try {
    return Boolean(new URLSearchParams(search).get('aircraftControlToken'));
  } catch {
    return false;
  }
}

function rankPhoneHosts(ips, fallbackHost = '') {
  const hosts = (Array.isArray(ips) ? ips : [])
    .concat(fallbackHost ? [fallbackHost] : [])
    .map(normalizeHost)
    .filter(isPhoneReachableHost)
    .map((host, index) => ({ host, score: scorePhoneHost(host), index }));
  const seen = new Set();
  return hosts
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .filter(({ host }) => {
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    })
    .map(({ host }) => host);
}

function getStatusTone(status) {
  if (status === 'running' || status === 'ready') return 'success';
  if (status === 'starting' || status === 'stopping' || status === 'connecting') return 'warning';
  if (status === 'stopped' || status === 'error') return 'danger';
  return 'muted';
}

async function callOptional(api, method, ...args) {
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

async function fetchBrowserBootstrap() {
  const location = getBrowserLocation();
  const fetchImpl = typeof window !== 'undefined' && typeof window.fetch === 'function'
    ? window.fetch.bind(window)
    : globalThis.fetch;
  if (!location || typeof fetchImpl !== 'function') return null;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;

  const origin = typeof location.origin === 'string' && location.origin !== 'null'
    ? location.origin
    : `${location.protocol}//${location.host}`;
  try {
    const response = await fetchImpl(`${origin}/api/bootstrap`);
    if (!response?.ok) return null;
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export const useSystemHostStore = defineStore('systemHost', () => {
  const backendStatus = ref('unknown');
  const frontendStatus = ref('unknown');
  const frontendPort = ref(null);
  const backendWsPort = ref(null);
  const backendHttpPort = ref(null);
  const startupHealth = ref(null);
  const networkInfo = ref({ ips: [], httpPort: null, wsPort: null });
  // null means the active backend binding is not known yet. The phone URL
  // stays fail-closed until bootstrap confirms trusted-LAN access is active.
  const remoteAccessEnabled = ref(null);
  // This token is issued only to a local browser/Electron host for building a
  // shareable phone URL. Never populate it from the current page query: a
  // paired phone may report its state, but its displayed share link stays
  // read-only instead of redistributing the token it received.
  const shareAircraftControlToken = ref('');
  const currentBrowserAircraftControlPaired = ref(currentBrowserUrlHasAircraftControlPairing());
  const settingsFile = ref('');
  const busyAction = ref('');
  const lastError = ref('');
  const initialized = ref(false);
  const lastUpdatedAt = ref(null);
  let unsubscribeBackendStatus = null;

  const electronApi = computed(() => getElectronApi());
  const isElectron = computed(() => Boolean(electronApi.value));
  const isBusy = computed(() => Boolean(busyAction.value));
  const backendStatusTone = computed(() => getStatusTone(backendStatus.value));
  const frontendStatusTone = computed(() => getStatusTone(frontendStatus.value));
  const backendStatusLabel = computed(() => {
    if (!isElectron.value) return 'Unavailable';
    if (backendStatus.value === 'unknown') return 'Unknown';
    return backendStatus.value.charAt(0).toUpperCase() + backendStatus.value.slice(1);
  });
  const frontendStatusLabel = computed(() => {
    if (!isElectron.value) return 'Browser-hosted';
    if (frontendStatus.value === 'unknown') return 'Unknown';
    return frontendStatus.value.charAt(0).toUpperCase() + frontendStatus.value.slice(1);
  });
  const desktopUrl = computed(() => {
    const port = frontendPort.value || 8000;
    return `http://127.0.0.1:${port}/frontend/index.html`;
  });
  const phoneHosts = computed(() => {
    const ips = Array.isArray(networkInfo.value?.ips) ? networkInfo.value.ips : [];
    return rankPhoneHosts(ips, getBrowserLanHostFallback());
  });
  const remoteViewerUrl = computed(() => {
    if (remoteAccessEnabled.value !== true) return '';
    const host = phoneHosts.value[0];
    if (!host) return '';
    const port = normalizePort(networkInfo.value?.httpPort)
      || backendHttpPort.value
      || getBrowserBackendPortFallback()
      || 8100;
    const wsPort = normalizePort(networkInfo.value?.wsPort)
      || backendWsPort.value
      || getBrowserWsPortFallback()
      || 8099;
    const baseUrl = `http://${host}:${port}/remote`;
    const query = new URLSearchParams({ wsPort: String(wsPort) });
    return `${baseUrl}?${query.toString()}`;
  });
  const remoteControlPairingUrl = computed(() => {
    if (!remoteViewerUrl.value || !shareAircraftControlToken.value) return '';
    const querySeparator = remoteViewerUrl.value.includes('?') ? '&' : '?';
    return `${remoteViewerUrl.value}${querySeparator}aircraftControlToken=${encodeURIComponent(shareAircraftControlToken.value)}`;
  });
  // Present one best phone URL to the user. A local desktop host includes the
  // current backend-session control token; a remote browser never redistributes
  // a token it received and therefore falls back to the read-only viewer URL.
  const remoteBrowserUrl = computed(() => remoteControlPairingUrl.value || remoteViewerUrl.value);
  const shareAircraftControlPaired = computed(() => Boolean(shareAircraftControlToken.value));
  const remoteAircraftControlPaired = shareAircraftControlPaired;
  const alternateIpsLabel = computed(() => {
    const ips = phoneHosts.value.slice(1);
    return ips.length ? ips.join(', ') : '';
  });
  const startupHealthLabel = computed(() => {
    if (!startupHealth.value) return 'Not checked';
    if (startupHealth.value.ok === false) return 'Attention needed';
    return 'Healthy';
  });

  function applyBackendStatus(result) {
    if (result && typeof result === 'object' && 'status' in result) {
      backendStatus.value = normalizeStatus(result.status);
      return;
    }
    if (typeof result === 'string') {
      backendStatus.value = normalizeStatus(result);
    }
  }

  function applyHttpStatus(result) {
    if (!result || typeof result !== 'object') return;
    frontendStatus.value = normalizeStatus(result.status);
    frontendPort.value = normalizePort(result.port) || frontendPort.value;
  }

  async function refresh() {
    const api = electronApi.value;
    initialized.value = true;
    lastError.value = '';

    if (!api) {
      const bootstrap = await fetchBrowserBootstrap();
      backendStatus.value = bootstrap ? 'running' : 'unavailable';
      frontendStatus.value = 'browser';
      remoteAccessEnabled.value = typeof bootstrap?.remoteAccessEnabled === 'boolean'
        ? bootstrap.remoteAccessEnabled
        : (bootstrap && getBrowserLanHostFallback() ? true : null);
      shareAircraftControlToken.value = typeof bootstrap?.aircraftControlToken === 'string'
        ? bootstrap.aircraftControlToken
        : '';
      const bootstrapNetwork = bootstrap?.networkInfo;
      networkInfo.value = {
        ips: Array.isArray(bootstrapNetwork?.ips) ? bootstrapNetwork.ips : [],
        httpPort: normalizePort(bootstrapNetwork?.httpPort),
        wsPort: normalizePort(bootstrapNetwork?.wsPort),
      };
      backendHttpPort.value = normalizePort(bootstrapNetwork?.httpPort);
      backendWsPort.value = normalizePort(bootstrapNetwork?.wsPort);
      lastUpdatedAt.value = Date.now();
      return Boolean(bootstrap);
    }

    const results = await Promise.allSettled([
      callOptional(api, 'getBackendStatus'),
      callOptional(api, 'getHttpStatus'),
      callOptional(api, 'getBackendWsPort'),
      callOptional(api, 'getBackendHttpPort'),
      callOptional(api, 'getStartupHealth'),
      callOptional(api, 'getNetworkInfo'),
      callOptional(api, 'getSettings'),
      callOptional(api, 'getBackendBootstrap'),
    ]);

    const [backend, http, wsPort, httpPort, health, network, settings, bootstrap] = results;
    if (backend.status === 'fulfilled') applyBackendStatus(backend.value);
    if (http.status === 'fulfilled') applyHttpStatus(http.value);
    if (wsPort.status === 'fulfilled') backendWsPort.value = normalizePort(wsPort.value) || backendWsPort.value;
    if (httpPort.status === 'fulfilled') backendHttpPort.value = normalizePort(httpPort.value) || backendHttpPort.value;
    if (health.status === 'fulfilled' && health.value) startupHealth.value = health.value;
    if (network.status === 'fulfilled' && network.value) {
      networkInfo.value = {
        ips: Array.isArray(network.value.ips) ? network.value.ips : [],
        httpPort: normalizePort(network.value.httpPort),
        wsPort: normalizePort(network.value.wsPort),
      };
    }
    if (settings.status === 'fulfilled') {
      if (settings.value?.settingsFile) settingsFile.value = settings.value.settingsFile;
      remoteAccessEnabled.value = settings.value?.settings?.remoteAccess === true;
    }
    if (bootstrap.status === 'fulfilled') {
      const payload = bootstrap.value?.body && typeof bootstrap.value.body === 'object'
        ? bootstrap.value.body
        : bootstrap.value;
      if (typeof payload?.remoteAccessEnabled === 'boolean') {
        remoteAccessEnabled.value = payload.remoteAccessEnabled;
      }
      shareAircraftControlToken.value = typeof payload?.aircraftControlToken === 'string'
        ? payload.aircraftControlToken
        : '';
    } else {
      shareAircraftControlToken.value = '';
    }

    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) {
      lastError.value = rejected.reason?.message || 'Could not refresh Electron host status.';
    }

    lastUpdatedAt.value = Date.now();
    return true;
  }

  async function runAction(actionName, method) {
    const api = electronApi.value;
    if (!api || typeof api[method] !== 'function') {
      lastError.value = 'This action is only available in the Electron app.';
      return false;
    }

    busyAction.value = actionName;
    lastError.value = '';
    try {
      const result = await api[method]();
      applyBackendStatus(result);
      await refresh();
      return true;
    } catch (error) {
      lastError.value = error?.message || `Could not ${actionName}.`;
      return false;
    } finally {
      busyAction.value = '';
    }
  }

  function startBackend() {
    return runAction('start backend', 'startBackend');
  }

  function stopBackend() {
    return runAction('stop backend', 'stopBackend');
  }

  function restartBackend() {
    return runAction('restart backend', 'restartBackend');
  }

  async function revealSettingsFile() {
    const api = electronApi.value;
    if (!api || typeof api.revealInExplorer !== 'function') {
      lastError.value = 'This action is only available in the Electron app.';
      return false;
    }
    if (!settingsFile.value) {
      await refresh();
    }
    if (!settingsFile.value) {
      lastError.value = 'Settings file path is not available yet.';
      return false;
    }

    busyAction.value = 'reveal settings';
    lastError.value = '';
    try {
      const result = await api.revealInExplorer(settingsFile.value);
      if (!result?.success) {
        lastError.value = result?.error || 'Could not reveal settings file.';
        return false;
      }
      return true;
    } catch (error) {
      lastError.value = error?.message || 'Could not reveal settings file.';
      return false;
    } finally {
      busyAction.value = '';
    }
  }

  function bindBackendStatusEvents() {
    const api = electronApi.value;
    if (!api || typeof api.onBackendStatus !== 'function' || unsubscribeBackendStatus) {
      return () => {};
    }

    unsubscribeBackendStatus = api.onBackendStatus((data) => {
      applyBackendStatus(data);
      lastUpdatedAt.value = Date.now();
    });

    return () => {
      if (typeof unsubscribeBackendStatus === 'function') {
        unsubscribeBackendStatus();
      }
      unsubscribeBackendStatus = null;
    };
  }

  return {
    alternateIpsLabel,
    aircraftControlToken: shareAircraftControlToken,
    backendHttpPort,
    backendStatus,
    backendStatusLabel,
    backendStatusTone,
    backendWsPort,
    bindBackendStatusEvents,
    busyAction,
    currentBrowserAircraftControlPaired,
    desktopUrl,
    electronApi,
    frontendPort,
    frontendStatus,
    frontendStatusLabel,
    frontendStatusTone,
    initialized,
    isBusy,
    isElectron,
    lastError,
    lastUpdatedAt,
    networkInfo,
    phoneHosts,
    refresh,
    remoteAccessEnabled,
    remoteBrowserUrl,
    remoteControlPairingUrl,
    remoteViewerUrl,
    remoteAircraftControlPaired,
    shareAircraftControlPaired,
    restartBackend,
    revealSettingsFile,
    settingsFile,
    startBackend,
    startupHealth,
    startupHealthLabel,
    stopBackend,
  };
});
