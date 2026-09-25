'use strict';

// The map's downsampled track uses indicated altitude. Native playback must
// instead consume the original SAMPLE rows and physical PLANE ALTITUDE.
type Row = Record<string, any>;
export type ReplaySample = {
  timeMs: number;
  sourceTimestampMs: number;
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeFt: number;
  pitchDeg: number;
  bankDeg: number;
  headingDeg: number;
};
export type LandingReplayClip = {
  version: 1;
  title: string;
  profileId: string;
  livery: null;
  durationMs: number;
  touchdownMs: number;
  sourceTouchdownTimestampMs: number;
  markerSource: 'timeline-sample-contact';
  clock: 'recording-wall-time';
  limitations: string[];
  samples: ReplaySample[];
};
export type ReplayClipResult = { success: true; clip: LandingReplayClip } | { success: false; error: string };

function finite(value: unknown, field: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) {
    throw new Error(`Replay requires a finite ${field} in every sample`);
  }
  return Number(value);
}
function flag(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null || value === '') return null; // Legacy fields may be absent.
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw new Error(`Replay has an invalid ${field} flag`);
}

export function buildLandingReplayClip(rows: Row[], timeline: Row, landingIndex: number): LandingReplayClip {
  if (!Number.isSafeInteger(landingIndex) || landingIndex < 0) throw new Error('Invalid landing index');
  const landing = timeline.events.filter((event: Row) => event.type === 'landing')[landingIndex];
  // touchdownNumber is supplied by SAMPLE contact reconstruction. Standalone
  // LANDING rows have only a delayed result timestamp and cannot anchor a clip.
  if (!landing || !Number.isSafeInteger(landing.touchdownNumber)) {
    throw new Error('This landing has no reconstructed touchdown time');
  }
  const touchdownMs = finite(landing.timestampMs, 'touchdown timestamp');
  const source: Row[] = [];
  for (const row of rows) {
    if (String(row.record_type).trim().toUpperCase() !== 'SAMPLE') continue;
    // Do not silently discard malformed timestamps and interpolate across the
    // resulting hole: its position in the requested window is unknowable.
    const timestamp = finite(row.ts, 'sample timestamp');
    if (timestamp >= touchdownMs - 90_000 && timestamp <= touchdownMs + 30_000) {
      if (source.length === 1300) throw new Error('Replay clip sample count is outside its bounds');
      source.push(row);
    }
  }
  if (source.length < 2 || source.length > 1300) throw new Error('Replay clip sample count is outside its bounds');
  const title = String(source[0].aircraft || '').trim();
  const profileId = String(source[0].aircraft_profile_id || '').trim();
  if (!title || !['pmdg-737', 'fenix-a320'].includes(profileId)) {
    throw new Error('The replay proof requires a recorded PMDG 737 or Fenix A320 identity');
  }
  let previousTimestamp = -Infinity;
  let previousSourceClock = -Infinity;
  const firstTimestamp = finite(source[0].ts, 'timestamp');
  const samples: ReplaySample[] = source.map(row => {
    if (String(row.aircraft || '').trim() !== title || String(row.aircraft_profile_id || '').trim() !== profileId) {
      throw new Error('Aircraft identity changes or is missing inside the replay clip');
    }
    if (flag(row.sim_paused, 'pause') || flag(row.sim_in_menu, 'menu') || flag(row.assist_slew_active, 'slew')
      || flag(row.attitude_valid, 'attitude validity') === false) {
      throw new Error('This proof cannot replay paused, menu, slew or invalid-attitude segments');
    }
    const timestamp = finite(row.ts, 'timestamp');
    const sourceClock = finite(row.timestamp_monotonic ?? row.flight_elapsed_ms, 'recording clock');
    if (timestamp <= previousTimestamp || sourceClock <= previousSourceClock) throw new Error('Replay timestamps must increase');
    if (previousTimestamp !== -Infinity && (timestamp - previousTimestamp > 2500
      || Math.abs((timestamp - previousTimestamp) - (sourceClock - previousSourceClock)) > 5)) {
      throw new Error('Replay clip contains a clock discontinuity or a gap longer than 2.5 seconds');
    }
    previousTimestamp = timestamp;
    previousSourceClock = sourceClock;
    const sample = {
      timeMs: timestamp - firstTimestamp,
      sourceTimestampMs: timestamp,
      latitudeDeg: finite(row.lat_deg, 'latitude'),
      longitudeDeg: finite(row.lon_deg, 'longitude'),
      altitudeFt: finite(row.alt_plane_ft, 'physical altitude'),
      // CSV pitch/bank use FlightFabric's sign convention; the native writer
      // performs the one conversion to SimConnect's signs at its boundary.
      pitchDeg: finite(row.pitch_deg, 'pitch'),
      bankDeg: finite(row.bank_deg, 'bank'),
      headingDeg: finite(row.hdg_true_deg, 'true heading'),
    };
    if (Math.abs(sample.latitudeDeg) > 90 || Math.abs(sample.longitudeDeg) > 180
      || Math.abs(sample.pitchDeg) > 90 || Math.abs(sample.bankDeg) > 180
      || sample.headingDeg < 0 || sample.headingDeg > 360 || sample.altitudeFt < -2000 || sample.altitudeFt > 65000) {
      throw new Error('Replay sample position or attitude is outside its bounds');
    }
    return sample;
  });
  if (firstTimestamp >= touchdownMs || previousTimestamp <= touchdownMs) throw new Error('Clip must cover both sides of touchdown');
  return {
    version: 1,
    title,
    profileId,
    livery: null,
    durationMs: samples.at(-1)!.timeMs,
    touchdownMs: touchdownMs - firstTimestamp,
    sourceTouchdownTimestampMs: touchdownMs,
    markerSource: 'timeline-sample-contact',
    clock: 'recording-wall-time',
    limitations: ['Source simulation rate is not recorded; confirm this was a 1x flight.',
      'Livery identity is not recorded.', 'This motion proof does not replay control-surface or cockpit-system state.'],
    samples,
  };
}

module.exports = { buildLandingReplayClip };
