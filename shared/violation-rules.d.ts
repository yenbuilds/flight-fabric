export const VIOLATION_RULE: {
  readonly HIGH_SINK_RATE: 'high_sink_rate';
  readonly EXCESS_IAS_DEVIATION: 'excess_ias_deviation';
  readonly UNSTABLE_APPROACH: 'unstable_approach';
  readonly EXCESSIVE_BANK: 'excessive_bank';
  readonly GEAR_NOT_DOWN: 'gear_not_down';
  readonly FLAPS_NOT_SET: 'flaps_not_set';
  readonly GLIDEPATH_DEVIATION: 'glidepath_deviation';
  readonly LATE_GO_AROUND: 'late_go_around';
  readonly AP_DISCONNECT: 'ap_disconnect';
  readonly AT_DISCONNECT: 'at_disconnect';
  readonly CABIN_ALTITUDE_HIGH: 'cabin_altitude_high';
  readonly ENGINE_ASYMMETRY: 'engine_asymmetry';
  readonly UPSET_PITCH_NOSE_UP: 'upset_pitch_nose_up';
  readonly UPSET_PITCH_NOSE_DOWN: 'upset_pitch_nose_down';
  readonly UPSET_BANK: 'upset_bank';
  readonly LOAD_FACTOR_ADVISORY: 'load_factor_advisory';
  readonly GFORCE_HIGH: 'gforce_high';
  readonly GFORCE_NEGATIVE: 'gforce_negative';
  readonly APPROACH_OVERSPEED: 'approach_overspeed';
  readonly SPEEDBRAKE_DEPLOYED_IN_FLIGHT: 'speedbrake_deployed_in_flight';
  readonly CONVECTIVE_EXPOSURE: 'convective_exposure';
};

export type ViolationRuleMap = typeof VIOLATION_RULE;
export type ViolationRuleId = ViolationRuleMap[keyof ViolationRuleMap];

declare const violationRules: {
  readonly VIOLATION_RULE: typeof VIOLATION_RULE;
};

export default violationRules;
