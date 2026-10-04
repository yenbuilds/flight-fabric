/** Recorded takeoff projection shared by Logbook and Timeline. No rescoring. */

type AnyRecord = Record<string, any>;
type MeasurementTimeBasis = 'simulator' | 'capture' | null;

export type TakeoffLogRecording = {
  bundleName?: string | null;
  recordingSessionId?: string | null;
  flightId?: string | null;
  /** Zero-based source row, used only by old CSVs without event/sample IDs. */
  rowIndex?: number | null;
};

export type TakeoffLogEntry = {
  id: string;
  eventId: string | null;
  sampleIndex: number | null;
  timestamp: string | null;
  timestampMs: number | null;
  flightStart: string | null;
  aircraft: string | null;
  aircraftProfileId: string | null;
  icao: string | null;
  runway: string | null;
  iasKts: number | null;
  gsKts: number | null;
  pitchDeg: number | null;
  flapsNotch: number | null;
  windSpeedKts: number | null;
  windDirDeg: number | null;
  xwindKts: number | null;
  rollDistanceFt: number | null;
  rollDurationS: number | null;
  rollDurationBasis: MeasurementTimeBasis;
  rollStartSource: string | null;
  liftoffDistanceFt: number | null;
  runwayRemainingFt: number | null;
  runwayUsedPct: number | null;
  runwayUseScore: number | null;
  runwayUseGrade: string | null;
  runwayUseZone: string | null;
  runwayLengthFt: number | null;
  runwayGeometrySource: string | null;
  screenHeightFt: number | null;
  screenHeightRemainingFt: number | null;
  screenHeightReached: boolean;
  screenHeightTimeBasis: MeasurementTimeBasis;
  rotationRateDegS: number | null;
  rotationTimeBasis: MeasurementTimeBasis;
  maxPitchDeg: number | null;
  lateralOffsetFt: number | null;
  lateralOffsetSide: string | null;
  lateralOffsetGrade: string | null;
  lateralOffsetSuspect: boolean;
  hopCount: number;
  assessment: string | null;
  runwayExcursion: boolean;
  flags: Array<{ code: string; label: string; severity: string }>;
  /** Original facts, findings and rule provenance; never replaced by current rules. */
  analysis: AnyRecord | null;
  recording: { bundleName: string | null; recordingSessionId: string | null; flightId: string | null };
};

function toNum(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toText(value: unknown, limit = 120): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, limit) || null;
}

function toBool(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function timeBasis(value: unknown): MeasurementTimeBasis {
  return value === 'simulator' || value === 'capture' ? value : null;
}

function parseAnalysis(value: unknown): AnyRecord | null {
  if (typeof value === 'string') {
    // The result contains summaries, never telemetry samples. Bound malformed
    // imported JSON before parsing it; ordinary recorded results are a few KB.
    if (value.length > 64 * 1024) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
}

function epochMs(value: unknown): number | null {
  const numeric = toNum(value);
  return numeric !== null && numeric >= 0 && numeric <= 8.64e15 ? numeric : null;
}

function sourceIndex(value: unknown): number | null {
  const numeric = toNum(value);
  return numeric !== null && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

/** Accept either a live takeoff:final payload or its recorded CSV row. */
export function extractRecordedTakeoff(
  payload: AnyRecord | null | undefined,
  recording: TakeoffLogRecording = {},
): TakeoffLogEntry | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (toBool(payload.takeoff_final) === false) return null;
  const rowTimestampMs = epochMs(payload.timestamp_ms) ?? epochMs(payload.ts);
  const liftoffTimestampMs = epochMs(payload.takeoff_liftoff_timestamp_ms);
  const timestampMs = liftoffTimestampMs !== null && (rowTimestampMs === null || liftoffTimestampMs <= rowTimestampMs)
    ? liftoffTimestampMs : rowTimestampMs;
  const timestamp = timestampMs !== null ? new Date(timestampMs).toISOString() : toText(payload.timestamp_utc, 40);
  const analysis = parseAnalysis(payload.takeoff_analysis);
  const eventId = toText(payload.event_id, 128) ?? toText(payload.eventId, 128)
    ?? (typeof payload.event_id === 'number' && Number.isFinite(payload.event_id) ? String(payload.event_id) : null);
  const sampleIndex = sourceIndex(payload.sample_index);
  const rowIndex = sourceIndex(recording.rowIndex);
  const recordingIdentity = {
    bundleName: toText(recording.bundleName, 200),
    recordingSessionId: toText(recording.recordingSessionId, 128) ?? toText(payload.recording_session_id, 128),
    flightId: toText(recording.flightId, 128) ?? toText(payload.flight_id, 128),
  };
  const scope = recordingIdentity.recordingSessionId ?? recordingIdentity.bundleName ?? recordingIdentity.flightId ?? 'unrecorded';
  // JSON string quoting preserves delimiters and even malformed Unicode from
  // imported identifiers without URI encoding throwing during history reads.
  const eventIdentity = eventId ? `event:${JSON.stringify(eventId)}`
    : sampleIndex !== null ? `sample:${sampleIndex}`
      : rowIndex !== null ? `row:${rowIndex}`
        : timestampMs !== null ? `time:${timestampMs}` : null;
  if (eventIdentity === null) return null;
  const flags = Array.isArray(analysis?.flags)
    ? analysis.flags.filter((flag: unknown) => flag && typeof flag === 'object').slice(0, 8)
      .map((flag: AnyRecord) => ({
        code: toText(flag.code, 48) || '',
        label: toText(flag.label, 160) || '',
        severity: toText(flag.severity, 16) || 'caution',
      })).filter((flag: { code: string; label: string }) => flag.code && flag.label)
    : [];
  return {
    id: `takeoff:${JSON.stringify(scope)}:${eventIdentity}`,
    eventId,
    sampleIndex,
    timestamp,
    timestampMs,
    flightStart: toText(payload.flight_start, 40) ?? toText(payload.flight_start_iso, 40),
    aircraft: toText(payload.aircraft, 200),
    aircraftProfileId: toText(payload.aircraft_profile_id, 200),
    icao: toText(payload.icao, 8),
    runway: toText(payload.runway, 16),
    iasKts: toNum(payload.ias_kts),
    gsKts: toNum(payload.gs_kts),
    pitchDeg: toNum(payload.pitch_deg),
    flapsNotch: toNum(payload.flaps_notch),
    windSpeedKts: toNum(payload.wind_speed_kts),
    windDirDeg: toNum(payload.wind_dir_deg),
    xwindKts: toNum(payload.xwind_kts),
    rollDistanceFt: toNum(payload.takeoff_roll_distance_ft),
    rollDurationS: toNum(payload.takeoff_roll_duration_s),
    rollDurationBasis: timeBasis(analysis?.rollDurationBasis),
    rollStartSource: toText(payload.takeoff_roll_start_source, 32),
    liftoffDistanceFt: toNum(payload.takeoff_liftoff_distance_ft),
    runwayRemainingFt: toNum(payload.takeoff_runway_remaining_ft),
    runwayUsedPct: toNum(payload.takeoff_runway_used_pct),
    runwayUseScore: toNum(payload.takeoff_runway_use_score),
    runwayUseGrade: toText(payload.takeoff_runway_use_grade, 32),
    runwayUseZone: toText(payload.takeoff_runway_use_zone, 64),
    runwayLengthFt: toNum(payload.runway_physical_length_ft) ?? toNum(payload.runway_length_ft),
    runwayGeometrySource: toText(payload.runway_geometry_source, 32),
    screenHeightFt: toNum(payload.takeoff_screen_height_ft),
    screenHeightRemainingFt: toNum(payload.takeoff_screen_height_remaining_ft),
    screenHeightReached: analysis?.screenHeight?.reached === true,
    screenHeightTimeBasis: timeBasis(analysis?.screenHeight?.timeBasis),
    rotationRateDegS: toNum(payload.takeoff_rotation_rate_deg_s),
    rotationTimeBasis: timeBasis(analysis?.rotation?.timeBasis),
    maxPitchDeg: toNum(payload.takeoff_max_pitch_deg),
    lateralOffsetFt: toNum(payload.lateral_offset_ft),
    lateralOffsetSide: toText(payload.lateral_offset_side, 16),
    lateralOffsetGrade: toText(payload.lateral_offset_grade, 32),
    lateralOffsetSuspect: toBool(payload.lateral_offset_suspect) !== false,
    hopCount: Math.max(0, Math.round(toNum(payload.takeoff_hop_count) ?? 0)),
    assessment: toText(payload.takeoff_assessment, 16),
    runwayExcursion: toBool(payload.runway_excursion) === true,
    flags,
    analysis,
    recording: recordingIdentity,
  };
}

/** Preserve the public marker field names while sharing their interpretation. */
export function buildTakeoffTimelineContext(entry: TakeoffLogEntry): AnyRecord {
  return {
    takeoff_id: entry.id,
    event_id: entry.eventId,
    sample_index: entry.sampleIndex,
    icao: entry.icao,
    runway: entry.runway,
    ias_kts: entry.iasKts,
    gs_kts: entry.gsKts,
    pitch_deg: entry.pitchDeg,
    xwind_kts: entry.xwindKts,
    runway_length_ft: entry.runwayLengthFt,
    roll_distance_ft: entry.rollDistanceFt,
    roll_duration_s: entry.rollDurationS,
    roll_duration_basis: entry.rollDurationBasis,
    liftoff_distance_ft: entry.liftoffDistanceFt,
    runway_remaining_ft: entry.runwayRemainingFt,
    runway_used_pct: entry.runwayUsedPct,
    runway_use_score: entry.runwayUseScore,
    runway_use_grade: entry.runwayUseGrade,
    runway_use_zone: entry.runwayUseZone,
    screen_height_ft: entry.screenHeightFt,
    screen_height_remaining_ft: entry.screenHeightRemainingFt,
    rotation_rate_deg_s: entry.rotationRateDegS,
    max_pitch_deg: entry.maxPitchDeg,
    lateral_offset_ft: entry.lateralOffsetFt,
    lateral_offset_side: entry.lateralOffsetSide,
    lateral_offset_grade: entry.lateralOffsetGrade,
    hop_count: entry.hopCount,
    assessment: entry.assessment,
    runway_excursion: entry.runwayExcursion,
    flags: entry.flags,
    takeoff_analysis: entry.analysis,
  };
}
