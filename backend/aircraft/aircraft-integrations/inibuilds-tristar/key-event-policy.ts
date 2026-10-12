const TRISTAR_PROFILE_KEY = 'bundled/msfs/inibuilds-tristar';
const AFCS_PULSE_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  AP_AIRSPEED_HOLD: 'autothrottle',
  AP_VS_HOLD: 'verticalSpeedHold',
  AP_ALT_HOLD: 'altitudeHold',
  AP_MACH_HOLD: 'machHold',
  AP_HDG_HOLD: 'headingHold',
  TOGGLE_FLIGHT_DIRECTOR: 'flightDirector',
  AP_MASTER: 'apMaster',
  AUTOPILOT_OFF: 'apMaster',
  AP_APR_HOLD: 'app',
  AP_LOC_HOLD: 'loc',
  AP_NAV1_HOLD: 'nav1',
  TOGGLE_WATER_RUDDER: 'ins',
  AP_BC_HOLD: 'backcourse',
});

/**
 * Existing momentary AFCS button policy: mode-state readback is not reliable.
 * AP A and AP DISC share one physical group. The provider owns serialization
 * and timestamps so overlapping requests cannot double-fire a toggle.
 */
export function getTriStarKeyEventPolicy(profileKey: string, eventName: string) {
  const groupId = profileKey === TRISTAR_PROFILE_KEY ? AFCS_PULSE_GROUPS[eventName] : null;
  return groupId ? {
    groupId,
    cooldownMs: 600,
    inFlightError: 'The TriStar AFCS control is already being sent.',
    cooldownError: 'Wait briefly before sending the TriStar AFCS control again.',
  } : null;
}
