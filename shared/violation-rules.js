// @ts-nocheck
'use strict';

(function initViolationRules(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = exports;
  }
  if (root && typeof root === 'object') {
    root.FlightFabricViolationRules = exports;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this),
  function createViolationRules() {
    const VIOLATION_RULE = Object.freeze({
      HIGH_SINK_RATE: 'high_sink_rate',
      EXCESS_IAS_DEVIATION: 'excess_ias_deviation',
      UNSTABLE_APPROACH: 'unstable_approach',
      EXCESSIVE_BANK: 'excessive_bank',
      GEAR_NOT_DOWN: 'gear_not_down',
      FLAPS_NOT_SET: 'flaps_not_set',
      GLIDEPATH_DEVIATION: 'glidepath_deviation',
      LATE_GO_AROUND: 'late_go_around',
      AP_DISCONNECT: 'ap_disconnect',
      AT_DISCONNECT: 'at_disconnect',
      CABIN_ALTITUDE_HIGH: 'cabin_altitude_high',
      ENGINE_ASYMMETRY: 'engine_asymmetry',
      UPSET_PITCH_NOSE_UP: 'upset_pitch_nose_up',
      UPSET_PITCH_NOSE_DOWN: 'upset_pitch_nose_down',
      UPSET_BANK: 'upset_bank',
      LOAD_FACTOR_ADVISORY: 'load_factor_advisory',
      GFORCE_HIGH: 'gforce_high',
      GFORCE_NEGATIVE: 'gforce_negative',
      APPROACH_OVERSPEED: 'approach_overspeed',
      // Retained only to recognize and suppress legacy recorded events.
      SPEEDBRAKE_DEPLOYED_IN_FLIGHT: 'speedbrake_deployed_in_flight',
      CONVECTIVE_EXPOSURE: 'convective_exposure',
    });

    return {
      VIOLATION_RULE,
    };
  }
);
