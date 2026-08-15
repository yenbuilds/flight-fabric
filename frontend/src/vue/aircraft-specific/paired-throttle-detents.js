export const FENIX_THROTTLE_DETENTS = Object.freeze([
  Object.freeze({ id: 'toga', label: 'TOGA', value: 5, actionId: 'propulsion.throttle.toga' }),
  Object.freeze({ id: 'flexMct', label: 'FLX / MCT', value: 4, actionId: 'propulsion.throttle.flexMct' }),
  Object.freeze({ id: 'climb', label: 'CLB', value: 3, actionId: 'propulsion.throttle.climb' }),
  Object.freeze({ id: 'idle', label: 'IDLE', value: 2, actionId: 'propulsion.throttle.idle' }),
]);

export function normalizeFenixThrottlePosition(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatFenixThrottlePosition(value) {
  const numeric = normalizeFenixThrottlePosition(value);
  if (numeric === null) return '--';
  const detent = FENIX_THROTTLE_DETENTS.find((candidate) => Object.is(candidate.value, numeric));
  if (detent) return detent.label;
  if (Object.is(numeric, 1)) return 'REV IDLE';
  if (Object.is(numeric, 0)) return 'FULL REV';
  return `BETWEEN (${Number(numeric.toFixed(2))})`;
}

export function triggerFenixThrottleHaptic(navigatorRef = globalThis.navigator) {
  if (typeof navigatorRef?.vibrate !== 'function') return false;
  try {
    return navigatorRef.vibrate(12) === true;
  } catch {
    return false;
  }
}
