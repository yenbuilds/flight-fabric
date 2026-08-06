const signalListeners = {
  appSettings: new Set(),
  appSettingsSaved: new Set(),
  debugFrame: new Set(),
  landingReceived: new Set(),
  telemetryReset: new Set(),
  wsClose: new Set(),
  wsConnecting: new Set(),
  wsError: new Set(),
  wsMessage: new Set(),
  wsOpen: new Set(),
};

function subscribeSignal(signalName, handler) {
  if (typeof handler !== 'function') {
    return () => {};
  }

  const listeners = signalListeners[signalName];
  if (!listeners) {
    throw new Error(`Unknown runtime signal: ${signalName}`);
  }

  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

function emitSignal(signalName, payload) {
  const listeners = signalListeners[signalName];
  if (!listeners) {
    throw new Error(`Unknown runtime signal: ${signalName}`);
  }

  for (const handler of [...listeners]) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[runtime-signals] ${signalName} listener failed:`, error);
    }
  }
}

export const subscribeAppSettings = (handler) => subscribeSignal('appSettings', handler);
export const subscribeAppSettingsSaved = (handler) => subscribeSignal('appSettingsSaved', handler);
export const subscribeDebugFrame = (handler) => subscribeSignal('debugFrame', handler);
export const subscribeLandingReceived = (handler) => subscribeSignal('landingReceived', handler);
export const subscribeTelemetryReset = (handler) => subscribeSignal('telemetryReset', handler);
export const subscribeWsClose = (handler) => subscribeSignal('wsClose', handler);
export const subscribeWsConnecting = (handler) => subscribeSignal('wsConnecting', handler);
export const subscribeWsError = (handler) => subscribeSignal('wsError', handler);
export const subscribeWsMessage = (handler) => subscribeSignal('wsMessage', handler);
export const subscribeWsOpen = (handler) => subscribeSignal('wsOpen', handler);

export const emitAppSettings = (detail) => emitSignal('appSettings', detail);
export const emitAppSettingsSaved = (detail) => emitSignal('appSettingsSaved', detail);
export const emitDebugFrame = (detail) => emitSignal('debugFrame', detail);
export const emitLandingReceived = (detail) => emitSignal('landingReceived', detail);
export const emitTelemetryReset = (detail) => emitSignal('telemetryReset', detail);
export const emitWsClose = (detail) => emitSignal('wsClose', detail);
export const emitWsConnecting = (detail) => emitSignal('wsConnecting', detail);
export const emitWsError = (detail) => emitSignal('wsError', detail);
export const emitWsMessage = (detail) => emitSignal('wsMessage', detail);
export const emitWsOpen = (detail) => emitSignal('wsOpen', detail);
