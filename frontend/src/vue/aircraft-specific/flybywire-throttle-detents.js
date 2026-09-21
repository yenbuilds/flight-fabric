export const FBW_THROTTLE_DETENTS = Object.freeze([
  Object.freeze({ id: 'toga', label: 'TOGA', engraving: 'TO GA', angle: 45, actionId: 'propulsion.throttle.toga' }),
  Object.freeze({ id: 'flexMct', label: 'FLX / MCT', engraving: 'FLX MCT', angle: 35, actionId: 'propulsion.throttle.flexMct' }),
  Object.freeze({ id: 'climb', label: 'CLB', engraving: 'CL', angle: 25, actionId: 'propulsion.throttle.climb' }),
  Object.freeze({ id: 'idle', label: 'IDLE', engraving: 'IDLE', angle: 0, actionId: 'propulsion.throttle.idle' }),
]);

// Reverse readback angles reported by the FlyByWire throttle lever axis. They
// are drawn in the locked reverse zone of the quadrant but never commanded.
export const FBW_THROTTLE_REVERSE = Object.freeze({ idle: -6, full: -20 });

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
  if (Object.is(numeric, FBW_THROTTLE_REVERSE.idle)) return 'REV IDLE';
  if (Object.is(numeric, FBW_THROTTLE_REVERSE.full)) return 'FULL REV';
  return `BETWEEN (${Number(numeric.toFixed(2))}°)`;
}

export function triggerFbwThrottleHaptic(navigatorRef = globalThis.navigator) {
  if (typeof navigatorRef?.vibrate !== 'function') return false;
  try {
    return navigatorRef.vibrate(12) === true;
  } catch {
    return false;
  }
}
