export const FBW_THROTTLE_DETENTS = Object.freeze([
  Object.freeze({ id: 'toga', label: 'TOGA', angle: 45, actionId: 'propulsion.throttle.toga' }),
  Object.freeze({ id: 'flexMct', label: 'FLX / MCT', angle: 35, actionId: 'propulsion.throttle.flexMct' }),
  Object.freeze({ id: 'climb', label: 'CLB', angle: 25, actionId: 'propulsion.throttle.climb' }),
  Object.freeze({ id: 'idle', label: 'IDLE', angle: 0, actionId: 'propulsion.throttle.idle' }),
]);

export function normalizeFbwThrottleAngle(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatFbwThrottleAngle(value) {
  const numeric = normalizeFbwThrottleAngle(value);
  if (numeric === null) return '--';
  const detent = FBW_THROTTLE_DETENTS.find((candidate) => Object.is(candidate.angle, numeric));
  if (detent) return detent.label;
  if (Object.is(numeric, -6)) return 'REV IDLE';
  if (Object.is(numeric, -20)) return 'FULL REV';
  return `BETWEEN (${Number(numeric.toFixed(2))}\u00b0)`;
}

export function triggerFbwThrottleHaptic(navigatorRef = globalThis.navigator) {
  if (typeof navigatorRef?.vibrate !== 'function') return false;
  try {
    return navigatorRef.vibrate(12) === true;
  } catch {
    return false;
  }
}
