'use strict';

type HoldingPatternInputRow = {
  record_type?: unknown;
  ts?: unknown;
  timestamp_ms?: unknown;
  on_ground?: unknown;
  sim_paused?: unknown;
  sim_in_menu?: unknown;
  lat_deg?: unknown;
  lon_deg?: unknown;
  alt_msl_ft?: unknown;
  gs_kts?: unknown;
  hdg_true_deg?: unknown;
  track_true_deg?: unknown;
};

type HoldingPoint = {
  tsMs: number;
  lat: number;
  lon: number;
  trackDeg: number;
  altFt: number | null;
};

type HoldingLoop = {
  startIndex: number;
  endIndex: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  centerLat: number;
  centerLon: number;
  confidence: 'MEDIUM' | 'HIGH';
  score: number;
};

type HoldingEpisode = {
  start_ts: number;
  end_ts: number;
  duration_ms: number;
  loop_count: number;
  center_lat: number;
  center_lon: number;
};

type HoldingPatternSummary = {
  detected: true;
  confidence: 'MEDIUM' | 'HIGH';
  loop_count: number;
  duration_ms: number;
  episode_count: number;
  start_ts: number;
  end_ts: number;
  episodes: HoldingEpisode[];
};

const EARTH_RADIUS_NM = 3440.065;
const MIN_GROUND_SPEED_KTS = 60;
const MIN_POINT_GAP_MS = 5000;
const MAX_SAMPLE_GAP_MS = 30000;
const MIN_LOOP_DURATION_MS = 2 * 60 * 1000;
const MAX_LOOP_DURATION_MS = 12 * 60 * 1000;
const MIN_LOOP_DISTANCE_NM = 3;
const MAX_LOOP_DISTANCE_NM = 80;
const MAX_CLOSURE_DISTANCE_NM = 1.25;
const MIN_SIGNED_TURN_DEG = 320;
const MAX_SIGNED_TURN_DEG = 410;
const MIN_TURN_CONSISTENCY = 0.68;
const MAX_ALTITUDE_RANGE_FT = 1500;
const STRAIGHT_TURN_RATE_DEG_S = 0.8;
const MIN_STRAIGHT_SHARE = 0.25;
const MIN_STRAIGHT_LEG_MS = 20000;
const MIN_RECIPROCAL_SHARE = 0.55;
const EPISODE_JOIN_GAP_MS = 90 * 1000;
const HEADING_BIN_COUNT = 36;
const HEADING_BIN_SIZE_DEG = 360 / HEADING_BIN_COUNT;
const RECIPROCAL_BIN_OFFSET = HEADING_BIN_COUNT / 2;
const STRAIGHT_AXIS_RADIUS_BINS = 3;

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function normalizeHeading(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function angleDeltaDeg(current: number, previous: number): number {
  let delta = ((current - previous + 540) % 360) - 180;
  if (Object.is(delta, -0)) delta = 0;
  return delta;
}

function isValidCoordinate(lat: number | null, lon: number | null): boolean {
  return lat !== null
    && lon !== null
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180
    && !(lat === 0 && lon === 0);
}

function distanceNm(a: HoldingPoint, b: HoldingPoint): number {
  const toRad = (degrees: number): number => degrees * Math.PI / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function toHoldingPoint(row: HoldingPatternInputRow): HoldingPoint | null {
  const recordType = typeof row.record_type === 'string' ? row.record_type : null;
  if (recordType && recordType !== 'SAMPLE') return null;
  if (toBoolean(row.on_ground) === true) return null;
  if (toBoolean(row.sim_paused) === true || toBoolean(row.sim_in_menu) === true) return null;

  const groundSpeed = toFiniteNumber(row.gs_kts);
  if (groundSpeed !== null && groundSpeed < MIN_GROUND_SPEED_KTS) return null;

  const tsMs = toFiniteNumber(row.timestamp_ms) ?? toFiniteNumber(row.ts);
  const lat = toFiniteNumber(row.lat_deg);
  const lon = toFiniteNumber(row.lon_deg);
  const track = toFiniteNumber(row.track_true_deg) ?? toFiniteNumber(row.hdg_true_deg);
  if (tsMs === null || track === null || !isValidCoordinate(lat, lon)) return null;

  return {
    tsMs,
    lat: lat as number,
    lon: lon as number,
    trackDeg: normalizeHeading(track),
    altFt: toFiniteNumber(row.alt_msl_ft),
  };
}

function buildSegments(rows: HoldingPatternInputRow[]): HoldingPoint[][] {
  const segments: HoldingPoint[][] = [];
  let current: HoldingPoint[] = [];

  const finishSegment = (): void => {
    if (current.length >= 2) segments.push(current);
    current = [];
  };

  for (const row of rows) {
    const point = toHoldingPoint(row);
    if (!point) {
      finishSegment();
      continue;
    }

    const previous = current[current.length - 1];
    if (previous) {
      const gapMs = point.tsMs - previous.tsMs;
      if (gapMs <= 0 || gapMs < MIN_POINT_GAP_MS) continue;
      if (gapMs > MAX_SAMPLE_GAP_MS) finishSegment();
    }
    current.push(point);
  }

  finishSegment();
  return segments;
}

function buildPrefixes(points: HoldingPoint[]): {
  signedTurn: number[];
  absoluteTurn: number[];
  pathDistance: number[];
} {
  const signedTurn = [0];
  const absoluteTurn = [0];
  const pathDistance = [0];
  for (let index = 1; index < points.length; index += 1) {
    const delta = angleDeltaDeg(points[index].trackDeg, points[index - 1].trackDeg);
    signedTurn[index] = signedTurn[index - 1] + delta;
    absoluteTurn[index] = absoluteTurn[index - 1] + Math.abs(delta);
    pathDistance[index] = pathDistance[index - 1] + distanceNm(points[index - 1], points[index]);
  }
  return { signedTurn, absoluteTurn, pathDistance };
}

function sumCircularBins(bins: number[], center: number, radius: number): number {
  let total = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    total += bins[(center + offset + bins.length) % bins.length];
  }
  return total;
}

function hasReciprocalStraightLegs(
  points: HoldingPoint[],
  startIndex: number,
  endIndex: number,
): boolean {
  const bins = Array.from({ length: HEADING_BIN_COUNT }, () => 0);
  let straightDurationMs = 0;

  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const durationMs = current.tsMs - previous.tsMs;
    if (durationMs <= 0) continue;
    const delta = angleDeltaDeg(current.trackDeg, previous.trackDeg);
    const turnRateDegS = Math.abs(delta) / (durationMs / 1000);
    if (turnRateDegS > STRAIGHT_TURN_RATE_DEG_S) continue;

    const midpointHeading = normalizeHeading(previous.trackDeg + (delta / 2));
    const binIndex = Math.floor(midpointHeading / HEADING_BIN_SIZE_DEG) % HEADING_BIN_COUNT;
    bins[binIndex] += durationMs;
    straightDurationMs += durationMs;
  }

  const loopDurationMs = points[endIndex].tsMs - points[startIndex].tsMs;
  if (straightDurationMs < loopDurationMs * MIN_STRAIGHT_SHARE) return false;

  for (let center = 0; center < bins.length; center += 1) {
    const primaryMs = sumCircularBins(bins, center, STRAIGHT_AXIS_RADIUS_BINS);
    const reciprocalMs = sumCircularBins(
      bins,
      (center + RECIPROCAL_BIN_OFFSET) % HEADING_BIN_COUNT,
      STRAIGHT_AXIS_RADIUS_BINS,
    );
    if (
      primaryMs >= MIN_STRAIGHT_LEG_MS
      && reciprocalMs >= MIN_STRAIGHT_LEG_MS
      && (primaryMs + reciprocalMs) >= straightDurationMs * MIN_RECIPROCAL_SHARE
    ) {
      return true;
    }
  }
  return false;
}

function altitudeIsStable(points: HoldingPoint[], startIndex: number, endIndex: number): boolean {
  let minAltitude = Number.POSITIVE_INFINITY;
  let maxAltitude = Number.NEGATIVE_INFINITY;
  let altitudeCount = 0;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const altitude = points[index].altFt;
    if (altitude === null) continue;
    minAltitude = Math.min(minAltitude, altitude);
    maxAltitude = Math.max(maxAltitude, altitude);
    altitudeCount += 1;
  }
  return altitudeCount < 2 || maxAltitude - minAltitude <= MAX_ALTITUDE_RANGE_FT;
}

function intervalCenter(points: HoldingPoint[], startIndex: number, endIndex: number): { lat: number; lon: number } {
  let lat = 0;
  let lon = 0;
  let count = 0;
  for (let index = startIndex; index <= endIndex; index += 1) {
    lat += points[index].lat;
    lon += points[index].lon;
    count += 1;
  }
  return { lat: lat / count, lon: lon / count };
}

function evaluateLoop(
  points: HoldingPoint[],
  prefixes: ReturnType<typeof buildPrefixes>,
  startIndex: number,
  endIndex: number,
): HoldingLoop | null {
  const start = points[startIndex];
  const end = points[endIndex];
  const durationMs = end.tsMs - start.tsMs;
  if (durationMs < MIN_LOOP_DURATION_MS || durationMs > MAX_LOOP_DURATION_MS) return null;

  const pathDistance = prefixes.pathDistance[endIndex] - prefixes.pathDistance[startIndex];
  if (pathDistance < MIN_LOOP_DISTANCE_NM || pathDistance > MAX_LOOP_DISTANCE_NM) return null;
  const closureThreshold = Math.min(MAX_CLOSURE_DISTANCE_NM, Math.max(0.65, pathDistance * 0.12));
  const closureDistance = distanceNm(start, end);
  if (closureDistance > closureThreshold) return null;

  const signedTurn = prefixes.signedTurn[endIndex] - prefixes.signedTurn[startIndex];
  const absoluteTurn = prefixes.absoluteTurn[endIndex] - prefixes.absoluteTurn[startIndex];
  const consistency = Math.abs(signedTurn) / Math.max(1, absoluteTurn);
  if (Math.abs(signedTurn) < MIN_SIGNED_TURN_DEG || Math.abs(signedTurn) > MAX_SIGNED_TURN_DEG) return null;
  if (consistency < MIN_TURN_CONSISTENCY) return null;
  if (!altitudeIsStable(points, startIndex, endIndex)) return null;
  if (!hasReciprocalStraightLegs(points, startIndex, endIndex)) return null;

  const center = intervalCenter(points, startIndex, endIndex);
  const highConfidence = closureDistance <= closureThreshold * 0.55
    && Math.abs(Math.abs(signedTurn) - 360) <= 35
    && consistency >= 0.8;
  return {
    startIndex,
    endIndex,
    startTs: start.tsMs,
    endTs: end.tsMs,
    durationMs,
    centerLat: center.lat,
    centerLon: center.lon,
    confidence: highConfidence ? 'HIGH' : 'MEDIUM',
    score: (closureDistance / closureThreshold)
      + (Math.abs(Math.abs(signedTurn) - 360) / 100)
      + (1 - consistency),
  };
}

function findLoops(points: HoldingPoint[]): HoldingLoop[] {
  if (points.length < 3) return [];
  const prefixes = buildPrefixes(points);
  const candidates: HoldingLoop[] = [];
  let earliestStartIndex = 0;

  for (let endIndex = 1; endIndex < points.length; endIndex += 1) {
    while (
      earliestStartIndex < endIndex
      && points[endIndex].tsMs - points[earliestStartIndex].tsMs > MAX_LOOP_DURATION_MS
    ) {
      earliestStartIndex += 1;
    }
    for (let startIndex = earliestStartIndex; startIndex < endIndex; startIndex += 1) {
      if (points[endIndex].tsMs - points[startIndex].tsMs < MIN_LOOP_DURATION_MS) break;
      const candidate = evaluateLoop(points, prefixes, startIndex, endIndex);
      if (candidate) candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => a.endTs - b.endTs || a.score - b.score);
  const selected: HoldingLoop[] = [];
  let nextLoopStartTs = Number.NEGATIVE_INFINITY;
  while (true) {
    const available = candidates.filter((candidate) => candidate.startTs >= nextLoopStartTs);
    if (available.length === 0) break;
    const earliestEndTs = available[0].endTs;
    const closureWindow = available
      .filter((candidate) => candidate.endTs <= earliestEndTs + 30000)
      .sort((a, b) => a.score - b.score || a.durationMs - b.durationMs);
    const chosen = closureWindow[0];
    selected.push(chosen);
    nextLoopStartTs = chosen.endTs - MIN_POINT_GAP_MS;
  }
  return selected;
}

function buildEpisodes(loops: HoldingLoop[]): HoldingEpisode[] {
  const episodes: HoldingEpisode[] = [];
  for (const loop of [...loops].sort((a, b) => a.startTs - b.startTs)) {
    const previous = episodes[episodes.length - 1];
    if (previous && loop.startTs - previous.end_ts <= EPISODE_JOIN_GAP_MS) {
      const priorLoops = previous.loop_count;
      const overlapMs = Math.max(0, previous.end_ts - loop.startTs);
      previous.end_ts = Math.max(previous.end_ts, loop.endTs);
      previous.duration_ms += Math.max(0, loop.durationMs - overlapMs);
      previous.loop_count += 1;
      previous.center_lat = ((previous.center_lat * priorLoops) + loop.centerLat) / previous.loop_count;
      previous.center_lon = ((previous.center_lon * priorLoops) + loop.centerLon) / previous.loop_count;
      continue;
    }
    episodes.push({
      start_ts: loop.startTs,
      end_ts: loop.endTs,
      duration_ms: loop.durationMs,
      loop_count: 1,
      center_lat: loop.centerLat,
      center_lon: loop.centerLon,
    });
  }
  return episodes;
}

function totalLoopDurationMs(loops: HoldingLoop[]): number {
  const ordered = [...loops].sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs);
  let totalMs = 0;
  let coveredUntil = Number.NEGATIVE_INFINITY;
  for (const loop of ordered) {
    const uncoveredStart = Math.max(loop.startTs, coveredUntil);
    totalMs += Math.max(0, loop.endTs - uncoveredStart);
    coveredUntil = Math.max(coveredUntil, loop.endTs);
  }
  return totalMs;
}

function detectHoldingPatternSummary(rows: HoldingPatternInputRow[]): HoldingPatternSummary | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const loops = buildSegments(rows).flatMap((segment) => findLoops(segment));
  if (loops.length === 0) return null;

  const episodes = buildEpisodes(loops);
  const durationMs = totalLoopDurationMs(loops);
  return {
    detected: true,
    confidence: loops.every((loop) => loop.confidence === 'HIGH') ? 'HIGH' : 'MEDIUM',
    loop_count: loops.length,
    duration_ms: durationMs,
    episode_count: episodes.length,
    start_ts: Math.min(...loops.map((loop) => loop.startTs)),
    end_ts: Math.max(...loops.map((loop) => loop.endTs)),
    episodes,
  };
}

const holdingPatternSummaryApi = { detectHoldingPatternSummary };

module.exports = holdingPatternSummaryApi;

export {};
