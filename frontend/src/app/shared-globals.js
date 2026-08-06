function getGlobalRoot() {
  if (typeof globalThis !== 'undefined') return globalThis;
  return typeof window !== 'undefined' ? window : {};
}

export function getGlobalRootObject() {
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

export function getPublishedFlightPhases({
  required = true,
  fallback = null,
} = {}) {
  const publishedPhases = getGlobalRoot().FlightPhases?.PUBLISHED_PHASES;
  if (Array.isArray(publishedPhases) && publishedPhases.length > 0) {
    return publishedPhases.slice();
  }

  const phases = getFlightPhases({ required, fallback: null });
  if (!phases) {
    return Array.isArray(fallback) ? fallback.slice() : fallback;
  }

  return Object.values(phases).filter((phase) => phase && phase !== phases.UNKNOWN);
}
