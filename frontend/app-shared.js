export const $ = (id) => document.getElementById(id);

const APP_SERVICE_KEYS = [
  'getWs',
  'getWsUrl',
  'getWsSend',
  'getAuthorizationScope',
  'sendWs',
  'getBackendHttpBase',
  'ui',
  'getAppSettings',
  'isValidCoord',
  'handleMessage',
  'showTimelineLanding',
  'cabinAnnouncements',
  'reconnect',
];

const appServices = Object.fromEntries(APP_SERVICE_KEYS.map((key) => [key, null]));
const compatibilityShared = {};

function getCompatibilityShared() {
  return compatibilityShared;
}

function syncCompatibilityShared() {
  const appShared = getCompatibilityShared();
  for (const key of APP_SERVICE_KEYS) {
    const value = appServices[key];
    if (value != null) {
      appShared[key] = value;
    } else {
      delete appShared[key];
    }
  }
  return appShared;
}

function resolveService(key) {
  const directValue = appServices[key];
  if (directValue != null) return directValue;
  const appShared = getCompatibilityShared();
  return appShared[key] ?? null;
}

export function setAppService(key, value) {
  appServices[key] = value ?? null;
  syncCompatibilityShared();
  return value;
}

export function setAppServices(services = {}) {
  if (!services || typeof services !== 'object') {
    return syncCompatibilityShared();
  }

  for (const [key, value] of Object.entries(services)) {
    appServices[key] = value ?? null;
  }

  return syncCompatibilityShared();
}

export function getAppShared() {
  return syncCompatibilityShared();
}

export function getWs() {
  const getWsRef = resolveService('getWs');
  return typeof getWsRef === 'function' ? getWsRef() : null;
}

export function getWsUrl() {
  const getWsUrlRef = resolveService('getWsUrl');
  return typeof getWsUrlRef === 'function' ? getWsUrlRef() : '';
}

export function getWsSend() {
  const getWsSendRef = resolveService('getWsSend');
  if (typeof getWsSendRef === 'function') {
    return getWsSendRef();
  }

  const sendWsRef = resolveService('sendWs');
  if (typeof sendWsRef === 'function') {
    return sendWsRef;
  }
  return null;
}

export function sendWs(message) {
  const send = getWsSend();
  if (typeof send === 'function') {
    return send(message) !== false;
  }

  const ws = getWs();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(JSON.stringify(message));
  return true;
}

export function getBackendHttpBase() {
  const getBackendHttpBaseRef = resolveService('getBackendHttpBase');
  return typeof getBackendHttpBaseRef === 'function' ? getBackendHttpBaseRef() : '';
}

export function getAuthorizationScope() {
  const getAuthorizationScopeRef = resolveService('getAuthorizationScope');
  return typeof getAuthorizationScopeRef === 'function'
    ? getAuthorizationScopeRef()
    : 'read-only';
}

export function getUiHelpers() {
  const uiHelpers = resolveService('ui');
  return uiHelpers && typeof uiHelpers === 'object' ? uiHelpers : {};
}

export function getAppSettings() {
  const appSettings = resolveService('getAppSettings');
  return typeof appSettings === 'function' ? appSettings() : appSettings || null;
}

export function getCoordValidator() {
  const isValidCoord = resolveService('isValidCoord');
  return typeof isValidCoord === 'function' ? isValidCoord : null;
}

export function getHandleMessage() {
  const handleMessage = resolveService('handleMessage');
  return typeof handleMessage === 'function' ? handleMessage : null;
}

export function getTimelineLandingHandler() {
  const handler = resolveService('showTimelineLanding');
  return typeof handler === 'function' ? handler : null;
}

export function showTimelineLanding(event) {
  const handler = getTimelineLandingHandler();
  if (typeof handler !== 'function') {
    return false;
  }
  handler(event);
  return true;
}

export function getCabinAnnouncements() {
  const api = resolveService('cabinAnnouncements');
  return api && typeof api === 'object' ? api : null;
}

export function getReconnect() {
  const reconnect = resolveService('reconnect');
  return typeof reconnect === 'function' ? reconnect : null;
}
