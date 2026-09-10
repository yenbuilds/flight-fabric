import '../../../shared/violation-rules.js';

export const { VIOLATION_RULE } = globalThis.FlightFabricViolationRules;

export const INSPECTOR_FILTER_OPTIONS = Object.freeze([
  { key: 'configuration_event', label: 'Configuration changes', detail: 'Flaps, gear and spoilers' },
  { key: 'automation_event', label: 'Automation', detail: 'Autopilot and autothrottle changes' },
  { key: 'flight_guidance_event', label: 'Flight guidance', detail: 'Selected targets and guidance modes' },
]);

export const TYPE_LABELS = Object.freeze({
  crash: 'Crash',
  phase_start: 'Phase',
  phase_end: 'Phase End',
  violation_start: 'Violation',
  violation_end: 'Violation End',
  score_change: 'Score',
  score_final: 'Final Score',
  automation_event: 'Automation',
  flight_guidance_event: 'Flight Guidance',
  configuration_event: 'Configuration',
  marker: 'Marker',
  worst_moment: 'Worst Moment',
  landing: 'Landing',
});

export const MARKER_LABELS = Object.freeze({
  altitude_1000: '1000ft',
  altitude_500: '500ft',
  altitude_200: '200ft',
  altitude_100: '100ft',
  altitude_50: '50ft',
  touchdown: 'Touchdown',
  rollout_start: 'Rollout',
  rollout_end: 'Stopped',
  go_around: 'Possible Go-Around',
  ap_disconnect: 'AP Disconnect',
  at_disconnect: 'A/T Disconnect',
});

export const RULE_LABELS = Object.freeze({
  approach_vertical_profile: 'Vertical approach profile',
  approach_airspeed: 'Approach airspeed',
  approach_bank: 'Approach bank angle',
  approach_pitch: 'Approach pitch',
  approach_localizer: 'Approach localizer',
  [VIOLATION_RULE.LATE_GO_AROUND]: 'Possible late go-around',
  below_glidepath: 'Path rate too steep',
});

export const RULE_END_LABELS = Object.freeze({
  approach_vertical_profile: 'Vertical profile recovered',
  approach_airspeed: 'Airspeed recovered',
  approach_bank: 'Bank angle recovered',
  approach_pitch: 'Pitch recovered',
  approach_localizer: 'Localizer recovered',
  below_glidepath: 'Path rate recovered',
});

export const RULE_DESCRIPTIONS = Object.freeze({
  approach_vertical_profile: 'Related sink-rate and path deviations share one episode and one vertical scoring contribution. Assessment starts at the recorded height gate. Path-rate and glideslope checks stop at 50 ft; sink rate continues to touchdown. A rate proxy does not establish position above or below the runway path.',
  approach_airspeed: 'Airspeed is compared with the IAS recorded at the height gate, not a verified VAPP. This estimate is advisory. Magnitude and elapsed time affect the speed score; speed checks stop at 50 ft for the flare.',
  approach_bank: 'Bank is assessed from the recorded height gate to touchdown. Small deviations have a gradual scoring effect. Sustained or severe breaches become red violations.',
  approach_pitch: 'Pitch is assessed from the recorded height gate to touchdown. Small deviations have a gradual scoring effect. Sustained or severe breaches become red violations.',
  approach_localizer: 'A valid localizer signal is assessed from the recorded height gate to 50 ft. The ideal band is within one dot; severe deviations exceed two dots. Entry and recovery use elapsed time.',
  [VIOLATION_RULE.HIGH_SINK_RATE]: 'Flight Fabric stability rule: vertical speed dropped below the configured threshold during APPROACH/FINAL. This differs from a GPWS "SINK RATE" aural callout, which uses a height-versus-rate envelope and may occur at a different time or not at all.',
  [VIOLATION_RULE.EXCESS_IAS_DEVIATION]: 'Indicated airspeed deviated from the reference speed by more than the configured tolerance during the approach.',
  [VIOLATION_RULE.GLIDEPATH_DEVIATION]: 'Glideslope deviation exceeded +/-1 dot during the approach.',
  localizer_deviation: 'Localizer deviation exceeded +/-1 dot during the approach.',
  [VIOLATION_RULE.EXCESSIVE_BANK]: 'Bank angle exceeded the configured limit during the approach.',
  [VIOLATION_RULE.UNSTABLE_APPROACH]: 'One or more stability criteria were not met during the approach after the recorded gate altitude (typically 1,000 ft RA).',
  [VIOLATION_RULE.LATE_GO_AROUND]: 'Possible go-around initiation was recorded below 200 ft AGL. This can indicate a very late missed-approach decision, but go-around detection is inferred from telemetry and may need review.',
  [VIOLATION_RULE.GEAR_NOT_DOWN]: 'Landing gear was not extended by the gate altitude.',
  [VIOLATION_RULE.FLAPS_NOT_SET]: 'Flaps were not in the landing configuration by the gate altitude.',
  [VIOLATION_RULE.CABIN_ALTITUDE_HIGH]: 'Cabin altitude exceeded the warning threshold (hypoxia risk without supplemental O2).',
  [VIOLATION_RULE.AP_DISCONNECT]: 'Autopilot disconnected. Recorded for awareness; whether this is a violation depends on phase and intent.',
  [VIOLATION_RULE.AT_DISCONNECT]: 'Autothrottle disconnected. Recorded for awareness; whether this is a violation depends on phase and intent.',
  [VIOLATION_RULE.ENGINE_ASYMMETRY]: 'Significant thrust asymmetry detected (runway-excursion risk on rollout).',
  GLIDESLOPE: 'ILS glideslope needle deviation exceeded +/-1 dot. MSFS does not document the raw NAV GSI polarity, so severity is based on absolute deviation: Caution above 1 dot and Warning above 2 dots.',
  below_glidepath: 'Visual/RNAV approach only (no ILS data): vertical speed was significantly steeper than the configured target path rate for the current groundspeed. This is a descent-rate proxy, not a position-based glideslope measurement, so it cannot establish that the aircraft was below the normal approach path or infer obstacle clearance.',
  dangerously_low_approach: 'Aircraft reached runway-height radio altitude (<=50 ft AGL) while still geometrically before the runway threshold - more than 500 ft short of it. This is the ILS-antenna / approach-light / terrain-strike scenario: the aircraft is at touchdown height but has not yet reached the runway. Detected by retroactive geometry scan at touchdown.',
  [VIOLATION_RULE.UPSET_PITCH_NOSE_UP]: 'In-flight upset: nose-up pitch exceeded 25 deg (FAA AC 120-111 / ICAO Doc 10011 threshold for transport category aircraft).',
  [VIOLATION_RULE.UPSET_PITCH_NOSE_DOWN]: 'In-flight upset: nose-down pitch exceeded 10 deg (FAA AC 120-111 / ICAO Doc 10011 threshold for transport category aircraft).',
  [VIOLATION_RULE.UPSET_BANK]: 'In-flight upset: bank angle exceeded 45 deg (FAA AC 120-111 / ICAO Doc 10011 threshold for transport category aircraft).',
  [VIOLATION_RULE.LOAD_FACTOR_ADVISORY]: 'Load factor advisory: measured vertical load factor exceeded the configured caution threshold but remained below the configured high-load threshold.',
  [VIOLATION_RULE.GFORCE_HIGH]: 'High load factor: measured vertical load factor exceeded the configured 2.5 g generic alert threshold. This is not an aircraft-specific structural-limit determination.',
  [VIOLATION_RULE.GFORCE_NEGATIVE]: 'Negative G: vertical load factor dropped below -0.3 g. Indicates a significant pushover, bunted maneuver, or severe negative turbulence. Risk of engine flameout, hydraulic issues, and physiological incapacitation.',
  [VIOLATION_RULE.APPROACH_OVERSPEED]: 'Approach overspeed: indicated airspeed exceeded the aircraft/category approach-speed envelope plus the configured buffer while descending below the approach gate.',
  [VIOLATION_RULE.CONVECTIVE_EXPOSURE]: 'Convective exposure likelihood: confidence-based proxy using aircraft response and available simulator weather indicators. This does not claim absolute thunderstorm-cell penetration.',
});
