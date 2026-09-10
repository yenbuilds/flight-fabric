export const $ = (id) => document.getElementById(id);

const appServices = {};

function resolveService(key) {
  return appServices[key] ?? null;
}

export function setAppService(key, value) {
  if (value == null) {
    delete appServices[key];
  } else {
    appServices[key] = value;
  }
  return value;
}

export function setAppServices(services = {}) {
  if (!services || typeof services !== 'object') {
    return appServices;
  }

  for (const [key, value] of Object.entries(services)) {
    setAppService(key, value);
  }

  return appServices;
}

export function getWs() {
  const getWsRef = resolveService('getWs');
  return typeof getWsRef === 'function' ? getWsRef() : null;
}

function getWsSend() {
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

export function getCabinAnnouncements() {
  const api = resolveService('cabinAnnouncements');
  return api && typeof api === 'object' ? api : null;
}

export function getReconnect() {
  const reconnect = resolveService('reconnect');
  return typeof reconnect === 'function' ? reconnect : null;
}
