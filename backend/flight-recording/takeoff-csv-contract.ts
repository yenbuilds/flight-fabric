/**
 * Takeoff CSV Contract - bridge between takeoff-runner payloads and V1 CSV rows.
 *
 * The takeoff runner emits a `takeoff:final` payload. The CSV writer persists
 * only the fields that `schema-field-map.ts` extracts, so this module names the
 * takeoff fields that must survive that boundary. Tests use the list as a guard
 * against adding takeoff diagnostics that never reach the recorded CSV, in the
 * same way landing-csv-contract.ts guards the LANDING row.
 */
'use strict';

type GenericRecord = Record<string, any>;
type FieldMapping = {
  payloadKey: string;
  column: string;
};

const CRITICAL_TAKEOFF_CSV_MAPPINGS: readonly FieldMapping[] = Object.freeze([
  { payloadKey: 'schema_version', column: 'schema_version' },
  { payloadKey: 'user_id', column: 'user_id' },
  { payloadKey: 'session_id', column: 'session_id' },
  { payloadKey: 'timestamp_ms', column: 'ts' },
  { payloadKey: 'timestamp_utc', column: 'timestamp_utc' },
  { payloadKey: 'flight_start', column: 'flight_start_iso' },
  { payloadKey: 'flight_elapsed_ms', column: 'flight_elapsed_ms' },
  { payloadKey: 'aircraft', column: 'aircraft' },
  { payloadKey: 'sim_version', column: 'sim_version' },
  { payloadKey: 'aircraft_profile_id', column: 'aircraft_profile_id' },
  { payloadKey: 'data_source', column: 'data_source' },
  { payloadKey: 'assist_takeoff_enabled', column: 'assist_takeoff_enabled' },
  { payloadKey: 'assist_any_active', column: 'assist_any_active' },
  { payloadKey: 'icao', column: 'icao' },
  { payloadKey: 'runway', column: 'runway' },
  { payloadKey: 'ias_kts', column: 'ias_kts' },
  { payloadKey: 'gs_kts', column: 'gs_kts' },
  { payloadKey: 'lat_deg', column: 'lat_deg' },
  { payloadKey: 'lon_deg', column: 'lon_deg' },
  { payloadKey: 'hdg_true_deg', column: 'hdg_true_deg' },
  { payloadKey: 'hdg_mag_deg', column: 'hdg_mag_deg' },
  { payloadKey: 'alt_msl_ft', column: 'alt_msl_ft' },
  { payloadKey: 'ra_ft', column: 'ra_ft' },
  { payloadKey: 'pitch_deg', column: 'pitch_deg' },
  { payloadKey: 'bank_deg', column: 'bank_deg' },
  { payloadKey: 'flaps_notch', column: 'flaps_notch' },
  { payloadKey: 'wind_speed_kts', column: 'wind_speed_kts' },
  { payloadKey: 'wind_dir_deg', column: 'wind_dir_deg' },
  { payloadKey: 'xwind_kts', column: 'xwind_kts' },
  { payloadKey: 'phase', column: 'phase' },
  { payloadKey: 'surface_on_runway', column: 'surface_on_runway' },
  { payloadKey: 'surface_runway_like', column: 'surface_runway_like' },
  { payloadKey: 'runway_excursion', column: 'runway_excursion' },
  { payloadKey: 'runway_geometry_source', column: 'runway_geometry_source' },
  { payloadKey: 'runway_heading_true_deg', column: 'runway_heading_true_deg' },
  { payloadKey: 'runway_length_ft', column: 'runway_length_ft' },
  { payloadKey: 'runway_physical_length_ft', column: 'runway_physical_length_ft' },
  { payloadKey: 'runway_threshold_lat', column: 'runway_threshold_lat' },
  { payloadKey: 'runway_threshold_lon', column: 'runway_threshold_lon' },
  { payloadKey: 'runway_physical_threshold_lat', column: 'runway_physical_threshold_lat' },
  { payloadKey: 'runway_physical_threshold_lon', column: 'runway_physical_threshold_lon' },
  { payloadKey: 'runway_width_ft', column: 'runway_width_ft' },
  { payloadKey: 'lateral_offset_ft', column: 'lateral_offset_ft' },
  { payloadKey: 'lateral_offset_side', column: 'lateral_offset_side' },
  { payloadKey: 'lateral_offset_score', column: 'lateral_offset_score' },
  { payloadKey: 'lateral_offset_grade', column: 'lateral_offset_grade' },
  { payloadKey: 'lateral_offset_suspect', column: 'lateral_offset_suspect' },
  { payloadKey: 'takeoff_liftoff_timestamp_ms', column: 'takeoff_liftoff_timestamp_ms' },
  { payloadKey: 'takeoff_roll_distance_ft', column: 'takeoff_roll_distance_ft' },
  { payloadKey: 'takeoff_roll_duration_s', column: 'takeoff_roll_duration_s' },
  { payloadKey: 'takeoff_roll_start_source', column: 'takeoff_roll_start_source' },
  { payloadKey: 'takeoff_liftoff_distance_ft', column: 'takeoff_liftoff_distance_ft' },
  { payloadKey: 'takeoff_runway_remaining_ft', column: 'takeoff_runway_remaining_ft' },
  { payloadKey: 'takeoff_runway_used_pct', column: 'takeoff_runway_used_pct' },
  { payloadKey: 'takeoff_runway_use_score', column: 'takeoff_runway_use_score' },
  { payloadKey: 'takeoff_runway_use_grade', column: 'takeoff_runway_use_grade' },
  { payloadKey: 'takeoff_runway_use_zone', column: 'takeoff_runway_use_zone' },
  { payloadKey: 'takeoff_screen_height_ft', column: 'takeoff_screen_height_ft' },
  { payloadKey: 'takeoff_screen_height_distance_ft', column: 'takeoff_screen_height_distance_ft' },
  { payloadKey: 'takeoff_screen_height_remaining_ft', column: 'takeoff_screen_height_remaining_ft' },
  { payloadKey: 'takeoff_screen_height_elapsed_s', column: 'takeoff_screen_height_elapsed_s' },
  { payloadKey: 'takeoff_rotation_rate_deg_s', column: 'takeoff_rotation_rate_deg_s' },
  { payloadKey: 'takeoff_max_pitch_deg', column: 'takeoff_max_pitch_deg' },
  { payloadKey: 'takeoff_max_lateral_offset_ft', column: 'takeoff_max_lateral_offset_ft' },
  { payloadKey: 'takeoff_hop_count', column: 'takeoff_hop_count' },
  { payloadKey: 'takeoff_assessment', column: 'takeoff_assessment' },
  { payloadKey: 'takeoff_analysis', column: 'takeoff_analysis' },
  { payloadKey: 'takeoff_final', column: 'takeoff_final' },
]);

function getCriticalTakeoffCsvMappings(): FieldMapping[] {
  return CRITICAL_TAKEOFF_CSV_MAPPINGS.map((mapping) => ({ ...mapping }));
}

function buildTakeoffCsvEventData(payload: GenericRecord | null | undefined, eventId: string): GenericRecord {
  const source = payload && typeof payload === 'object' ? payload : {};
  const resolvedEventId = eventId || source.eventId || source.event_id || null;
  return {
    ...source,
    eventId: resolvedEventId,
    event_id: resolvedEventId,
    // The writer stamps every row with its own monotonic clock at write time,
    // which for a takeoff is the scoring moment a few seconds after liftoff.
    // Keep the liftoff time itself in its own column so replay places the
    // marker where and when the wheels left the ground.
    takeoff_liftoff_timestamp_ms: source.takeoff_liftoff_timestamp_ms ?? source.timestamp_ms ?? null,
    ias: source.ias_kts ?? source.ias ?? null,
    onGround: false,
    on_ground: false,
    flightPhaseHint: source.phase_at_liftoff ?? source.flightPhaseHint ?? null,
    flight_phase_hint: source.phase_at_liftoff ?? source.flight_phase_hint ?? null,
    phase: 'TAKEOFF',
  };
}

module.exports = {
  buildTakeoffCsvEventData,
  getCriticalTakeoffCsvMappings,
};

export {};
