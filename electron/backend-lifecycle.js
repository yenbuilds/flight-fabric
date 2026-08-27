'use strict';

function normalizeBackendPort(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseConfiguredTcpPort(value, fallback) {
  const candidate = value === undefined || value === null || String(value).trim() === ''
    ? fallback
    : value;
  const port = normalizeBackendPort(candidate);
  return port === null ? Number.NaN : port;
}

function createBackendPortSnapshot(wsPort, httpPort) {
  const normalizedWsPort = normalizeBackendPort(wsPort);
  const normalizedHttpPort = normalizeBackendPort(httpPort);
  if (normalizedWsPort === null) {
    throw new RangeError('Backend WebSocket port must be an integer from 1 to 65535');
  }
  if (normalizedHttpPort === null) {
    throw new RangeError('Backend HTTP port must be an integer from 1 to 65535');
  }
  if (normalizedWsPort === normalizedHttpPort) {
    throw new RangeError('Backend WebSocket and HTTP ports must be distinct');
  }
  return Object.freeze({
    wsPort: normalizedWsPort,
    httpPort: normalizedHttpPort,
  });
}

function selectBackendRuntimePorts(configuredPorts, activeLaunch, managedProcess) {
  if (activeLaunch?.process && activeLaunch.process === managedProcess && activeLaunch.ports) {
    return activeLaunch.ports;
  }
  return configuredPorts;
}

function shouldOfferWindowsPortFallback(portStates) {
  if (!Array.isArray(portStates)) return false;
  const unavailable = portStates.filter((state) => state?.probe?.available !== true);
  return unavailable.length > 0 && unavailable.every((state) => (
    String(state?.probe?.errorCode || '').toUpperCase() === 'EACCES'
      && Array.isArray(state?.listenerPids)
      && state.listenerPids.length === 0
  ));
}

function isExactReadinessLine(line, marker) {
  return typeof marker === 'string' && marker.length > 0 && String(line ?? '').trim() === marker;
}

function createBoundedLineBuffer(onLine, options = {}) {
  if (typeof onLine !== 'function') throw new TypeError('onLine must be a function');
  const maxBufferLength = Number.isFinite(options.maxBufferLength)
    ? Math.max(256, Math.trunc(options.maxBufferLength))
    : 64 * 1024;
  let buffer = '';

  const emitCompleteLines = () => {
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      let line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > maxBufferLength) line = line.slice(-maxBufferLength);
      onLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  };

  return Object.freeze({
    push(chunk) {
      if (chunk === undefined || chunk === null) return;
      buffer += String(chunk);
      emitCompleteLines();
      if (buffer.length > maxBufferLength) {
        // Retain the newest bounded tail. Startup markers are short and emitted
        // normally when newline-delimited; a peer that never sends a newline
        // cannot grow Electron's memory without bound.
        buffer = buffer.slice(-maxBufferLength);
      }
    },
    flush() {
      if (!buffer) return;
      const line = buffer.replace(/\r$/, '');
      buffer = '';
      onLine(line);
    },
    getBufferedLength() {
      return buffer.length;
    },
  });
}

function createStartupReadinessGate(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, Math.trunc(options.timeoutMs))
    : 30000;
  const scheduleTimeout = options.scheduleTimeout || setTimeout;
  const cancelTimeout = options.cancelTimeout || clearTimeout;
  const onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : () => {};
  let terminal = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const timer = scheduleTimeout(() => {
    if (terminal) return;
    terminal = true;
    Promise.resolve()
      .then(() => onTimeout())
      .catch(() => {})
      .finally(() => resolvePromise(false));
  }, timeoutMs);
  timer?.unref?.();

  const finish = (result) => {
    if (terminal) return false;
    terminal = true;
    cancelTimeout(timer);
    resolvePromise(result === true);
    return true;
  };

  return Object.freeze({
    promise,
    ready: () => finish(true),
    fail: () => finish(false),
    cancel: () => finish(false),
    isSettled: () => terminal,
  });
}

module.exports = {
  createBackendPortSnapshot,
  createBoundedLineBuffer,
  createStartupReadinessGate,
  isExactReadinessLine,
  parseConfiguredTcpPort,
  selectBackendRuntimePorts,
  shouldOfferWindowsPortFallback,
};
