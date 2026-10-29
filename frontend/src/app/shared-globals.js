function getGlobalRoot() {
  if (typeof globalThis !== 'undefined') return globalThis;
  return typeof window !== 'undefined' ? window : {};
}

function getGlobalRootObject() {
  return getGlobalRoot();
}

export function getFlightPhases({
  required = true,
  fallback = null,
} = {}) {
  const phases = getGlobalRoot().FlightPhases?.PHASES;
  if (phases) return phases;
  if (required) {
    throw new Error('FlightPhases.PHASES is required before runtime consumers');
  }
  return fallback;
}

export function getFlightFabricAppSettings() {
  const shared = getGlobalRootObject().FlightFabricAppSettings;
  if (!shared || typeof shared.normalizeAppSettings !== 'function') {
    throw new Error('FlightFabricAppSettings shared module is required before settings consumers');
  }
  return shared;
}
