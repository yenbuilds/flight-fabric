'use strict';

const {
  extractFuelWeightPerGal,
  selectFuelUsageRows,
  summarizeFuelUsage,
} = require('../events/timeline-csv-helpers.js') as {
  extractFuelWeightPerGal: (row: InsightInputRow | null | undefined) => number | null;
  selectFuelUsageRows: (rows: InsightInputRow[]) => {
    firstFuelRow: InsightInputRow | null;
    lastFuelRow: InsightInputRow | null;
  };
  summarizeFuelUsage: (
    firstFuelRow: InsightInputRow | null | undefined,
    lastFuelRow: InsightInputRow | null | undefined,
  ) => {
    fuelBurnGal: number | null;
    fuelBurnWeightLbs: number | null;
    fuelBurnSource: string | null;
  };
};

type InsightInputRow = {
  record_type?: unknown;
  ts?: unknown;
  timestamp_ms?: unknown;
  phase?: unknown;
  on_ground?: unknown;
  sim_paused?: unknown;
  sim_in_menu?: unknown;
  lat_deg?: unknown;
  lon_deg?: unknown;
  alt_msl_ft?: unknown;
  ra_ft?: unknown;
  gs_kts?: unknown;
  bank_deg?: unknown;
  g_force?: unknown;
  g_force_lateral?: unknown;
  g_force_longitudinal?: unknown;
  fuel_total_gal?: unknown;
  fuel_total_weight_lbs?: unknown;
  fuel_weight_per_gal?: unknown;
  ap_master?: unknown;
  ap_reliable?: unknown;
  in_cloud?: unknown;
  precip_rate_mm?: unknown;
  precip_state?: unknown;
  wind_speed_kts?: unknown;
  gear_down_locked?: unknown;
  flaps_notch?: unknown;
  flaps_pct?: unknown;
};

type InsightSample = {
  tsMs: number;
  phase: string | null;
  onGround: boolean | null;
  paused: boolean;
  lat: number | null;
  lon: number | null;
  raFt: number | null;
  gsKts: number | null;
  bankDeg: number | null;
  gForce: number | null;
  gForceLateral: number | null;
  gForceLongitudinal: number | null;
  apMaster: boolean | null;
  apReliable: boolean | null;
  inCloud: boolean | null;
  precipRateMm: number | null;
  precipState: number | null;
  windSpeedKts: number | null;
  gearDownLocked: boolean | null;
  flapsNotch: string | null;
  flapsPct: number | null;
};

type PostFlightInsights = {
  time: {
    recorded_time_ms: number;
    airborne_time_ms: number;
    taxi_time_ms: number;
    paused_time_ms: number;
  };
  route: {
    distance_nm: number;
    average_ground_speed_kts: number | null;
    coverage_percent: number;
  } | null;
  fuel: {
    burn_gal: number | null;
    burn_lbs: number | null;
    efficiency_gal_per_nm: number | null;
    efficiency_lbs_per_nm: number | null;
    source: string | null;
  } | null;
  automation: {
    autopilot_time_ms: number;
    hand_flown_time_ms: number;
    hand_flown_below_1000_ft_ms: number;
    autopilot_percent: number;
    coverage_percent: number;
  } | null;
  weather: {
    in_cloud_time_ms: number | null;
    precipitation_time_ms: number | null;
    max_wind_kts: number | null;
    coverage_percent: number;
  } | null;
  configuration: {
    gear_down_recorded: boolean;
    gear_down_ra_ft: number | null;
    landing_flaps_ra_ft: number | null;
    landing_flaps: string | null;
  } | null;
  comfort: {
    peak_g: number | null;
    minimum_g: number | null;
    max_bank_deg: number | null;
    rough_air_time_ms: number | null;
  } | null;
  approach: {
    duration_ms: number;
    attempt_count: number;
    established_distance_nm: number | null;
  } | null;
};

const EARTH_RADIUS_NM = 3440.065;
const MAX_INTERVAL_MS = 30000;
const MAX_PAUSED_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MAX_PLAUSIBLE_GROUND_SPEED_KTS = 750;
const MAX_PLAUSIBLE_WIND_KTS = 250;
const MIN_PLAUSIBLE_G = -2;
const MAX_PLAUSIBLE_G = 5;
const MAX_PLAUSIBLE_AXIS_G = 3;
const MAX_PLAUSIBLE_BANK_DEG = 90;
const MIN_SUMMARY_COVERAGE = 0.9;
const MIN_ROUTE_DISTANCE_NM = 0.1;
const ROUGH_VERTICAL_G_DEVIATION = 0.15;
const ROUGH_LATERAL_G = 0.1;
const ROUGH_LONGITUDINAL_G = 0.12;
// Historical CSVs do not persist the configured touchdown cooldown, so keep a
// fixed, conservative landing-sequence boundary instead of letting a current
// setting reinterpret old flights. Six seconds matches the detector default:
// a shorter, ground-bounded airborne run is a bounce/WOW dropout, not a new
// approach.
const MAX_LANDING_SEQUENCE_AIRBORNE_GAP_MS = 6000;

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === 'y') return true;
  if (normalized === 'false' || normalized === 'no' || normalized === 'n') return false;
  return null;
}

function toPhase(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toFlapNotch(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return toNonEmptyString(value);
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeSample(row: InsightInputRow): InsightSample | null {
  if (row.record_type != null && row.record_type !== 'SAMPLE') return null;
  const tsMs = toFiniteNumber(row.timestamp_ms) ?? toFiniteNumber(row.ts);
  if (tsMs === null) return null;
  return {
    tsMs,
    phase: toPhase(row.phase),
    onGround: toBoolean(row.on_ground),
    paused: toBoolean(row.sim_paused) === true || toBoolean(row.sim_in_menu) === true,
    lat: toFiniteNumber(row.lat_deg),
    lon: toFiniteNumber(row.lon_deg),
    raFt: toFiniteNumber(row.ra_ft),
    gsKts: toFiniteNumber(row.gs_kts),
    bankDeg: toFiniteNumber(row.bank_deg),
    gForce: toFiniteNumber(row.g_force),
    gForceLateral: toFiniteNumber(row.g_force_lateral),
    gForceLongitudinal: toFiniteNumber(row.g_force_longitudinal),
    apMaster: toBoolean(row.ap_master),
    apReliable: toBoolean(row.ap_reliable),
    inCloud: toBoolean(row.in_cloud),
    precipRateMm: toFiniteNumber(row.precip_rate_mm),
    precipState: toFiniteNumber(row.precip_state),
    windSpeedKts: toFiniteNumber(row.wind_speed_kts),
    gearDownLocked: toBoolean(row.gear_down_locked),
    flapsNotch: toFlapNotch(row.flaps_notch),
    flapsPct: toFiniteNumber(row.flaps_pct),
  };
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

function distanceNm(a: InsightSample, b: InsightSample): number | null {
  if (!isValidCoordinate(a.lat, a.lon) || !isValidCoordinate(b.lat, b.lon)) return null;
  const toRad = (degrees: number): number => degrees * Math.PI / 180;
  const lat1 = toRad(a.lat as number);
  const lat2 = toRad(b.lat as number);
  const dLat = lat2 - lat1;
  const dLon = toRad((b.lon as number) - (a.lon as number));
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function isAirborne(sample: InsightSample): boolean {
  if (sample.onGround !== null) return sample.onGround === false;
  return sample.raFt !== null && sample.raFt > 50;
}

function isTaxi(sample: InsightSample): boolean {
  if (isAirborne(sample)) return false;
  if (sample.phase && ['TAXI', 'TAXI-IN', 'TAXI_OUT', 'TAXI-OUT'].includes(sample.phase)) return true;
  return sample.onGround === true && sample.gsKts !== null && sample.gsKts >= 1 && sample.gsKts <= 50;
}

function isRoughAir(sample: InsightSample): boolean {
  const verticalRough = sample.gForce !== null
    && sample.gForce >= MIN_PLAUSIBLE_G
    && sample.gForce <= MAX_PLAUSIBLE_G
    && Math.abs(sample.gForce - 1) >= ROUGH_VERTICAL_G_DEVIATION;
  const lateralRough = sample.gForceLateral !== null
    && Math.abs(sample.gForceLateral) <= MAX_PLAUSIBLE_AXIS_G
    && Math.abs(sample.gForceLateral) >= ROUGH_LATERAL_G;
  const longitudinalRough = sample.gForceLongitudinal !== null
    && Math.abs(sample.gForceLongitudinal) <= MAX_PLAUSIBLE_AXIS_G
    && Math.abs(sample.gForceLongitudinal) >= ROUGH_LONGITUDINAL_G;
  return verticalRough || lateralRough || longitudinalRough;
}

function hasPlausibleRoughAirTelemetry(sample: InsightSample): boolean {
  return (sample.gForce !== null && sample.gForce >= MIN_PLAUSIBLE_G && sample.gForce <= MAX_PLAUSIBLE_G)
    || (sample.gForceLateral !== null && Math.abs(sample.gForceLateral) <= MAX_PLAUSIBLE_AXIS_G)
    || (sample.gForceLongitudinal !== null && Math.abs(sample.gForceLongitudinal) <= MAX_PLAUSIBLE_AXIS_G);
}

function findFinalTouchdownIndex(
  samples: InsightSample[],
  lastAirborneIndex: number,
): number | null {
  let finalGroundIndex = -1;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].onGround === true) {
      finalGroundIndex = index;
      break;
    }
  }
  // The recording ended airborne (for example, after a touch-and-go), so an
  // earlier ground contact must not be mistaken for the final touchdown.
  if (finalGroundIndex <= lastAirborneIndex) return null;

  let touchdownIndex = finalGroundIndex;
  let cursor = finalGroundIndex;
  while (cursor > 0) {
    const previousIndex = cursor - 1;
    const intervalMs = samples[cursor].tsMs - samples[previousIndex].tsMs;
    if (intervalMs > MAX_INTERVAL_MS) {
      // Pausing or sparse recording during rollout can leave a long interval
      // between parked/ground samples. Cross only explicit ground-to-ground
      // gaps; an observed airborne endpoint remains a hard session boundary.
      if (samples[cursor].onGround !== true || samples[previousIndex].onGround !== true) break;
      touchdownIndex = previousIndex;
      cursor = previousIndex;
      continue;
    }

    if (!isAirborne(samples[previousIndex])) {
      if (samples[previousIndex].onGround === true) touchdownIndex = previousIndex;
      cursor = previousIndex;
      continue;
    }

    let airborneStartIndex = previousIndex;
    while (
      airborneStartIndex > 0
      && isAirborne(samples[airborneStartIndex - 1])
      && samples[airborneStartIndex].tsMs - samples[airborneStartIndex - 1].tsMs <= MAX_INTERVAL_MS
    ) airborneStartIndex -= 1;

    const groundBeforeIndex = airborneStartIndex - 1;
    const airborneGapMs = samples[cursor].tsMs - samples[airborneStartIndex].tsMs;
    const isBriefGroundBoundedGap = groundBeforeIndex >= 0
      && samples[groundBeforeIndex].onGround === true
      && samples[airborneStartIndex].tsMs - samples[groundBeforeIndex].tsMs <= MAX_INTERVAL_MS
      && airborneGapMs < MAX_LANDING_SEQUENCE_AIRBORNE_GAP_MS;
    if (!isBriefGroundBoundedGap) break;

    touchdownIndex = groundBeforeIndex;
    cursor = groundBeforeIndex;
  }

  return touchdownIndex;
}

function findFinalApproachRange(
  samples: InsightSample[],
  lastHoldingEndTs: number | null,
): { startIndex: number; endIndex: number } | null {
  let lastAirborneIndex = -1;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (isAirborne(samples[index])) {
      lastAirborneIndex = index;
      break;
    }
  }
  if (lastAirborneIndex < 0) return null;

  const approachLike = (sample: InsightSample): boolean => isAirborne(sample)
    && (sample.phase === 'APPROACH' || (sample.raFt !== null && sample.raFt >= 0 && sample.raFt <= 3000));
  const finalTouchdownIndex = findFinalTouchdownIndex(samples, lastAirborneIndex);
  let approachEndAirborneIndex = lastAirborneIndex;
  let endIndex = lastAirborneIndex;
  if (
    finalTouchdownIndex !== null
    && finalTouchdownIndex > 0
    && isAirborne(samples[finalTouchdownIndex - 1])
    && samples[finalTouchdownIndex].tsMs - samples[finalTouchdownIndex - 1].tsMs <= MAX_INTERVAL_MS
  ) {
    approachEndAirborneIndex = finalTouchdownIndex - 1;
    endIndex = finalTouchdownIndex;
  }
  if (!approachLike(samples[approachEndAirborneIndex])) return null;

  let startIndex = approachEndAirborneIndex;
  while (startIndex > 0) {
    const previous = samples[startIndex - 1];
    const current = samples[startIndex];
    if (
      current.tsMs - previous.tsMs > MAX_INTERVAL_MS
      || !approachLike(previous)
      || (lastHoldingEndTs !== null && previous.tsMs < lastHoldingEndTs)
    ) break;
    startIndex -= 1;
  }

  if (finalTouchdownIndex === null && (
    samples[lastAirborneIndex + 1]
    && samples[lastAirborneIndex + 1].tsMs - samples[lastAirborneIndex].tsMs <= MAX_INTERVAL_MS
    && samples[lastAirborneIndex + 1].onGround === true
  )) {
    endIndex = lastAirborneIndex + 1;
  }
  return { startIndex, endIndex };
}

type ConfigurationMilestone = {
  sample: InsightSample;
  transitionObserved: boolean;
};

function findFinalGearDownSample(
  samples: InsightSample[],
  startIndex: number,
  endIndex: number,
): ConfigurationMilestone | null {
  let finalIndex = endIndex;
  while (finalIndex >= startIndex && samples[finalIndex].gearDownLocked === null) finalIndex -= 1;
  if (finalIndex < startIndex || samples[finalIndex].gearDownLocked !== true) return null;

  let runStart = finalIndex;
  while (
    runStart > startIndex
    && samples[runStart - 1].gearDownLocked === true
    && samples[runStart].tsMs - samples[runStart - 1].tsMs <= MAX_INTERVAL_MS
  ) runStart -= 1;

  const previous = samples[runStart - 1];
  return {
    sample: samples[runStart],
    transitionObserved: Boolean(
      previous
      && previous.gearDownLocked === false
      && samples[runStart].tsMs - previous.tsMs <= MAX_INTERVAL_MS,
    ),
  };
}

function flapIdentity(sample: InsightSample): string | null {
  if (sample.flapsNotch) return `notch:${sample.flapsNotch.toUpperCase()}`;
  if (sample.flapsPct !== null) return `pct:${round(sample.flapsPct, 0)}`;
  return null;
}

function flapLabel(sample: InsightSample): string | null {
  if (sample.flapsNotch) return sample.flapsNotch;
  return sample.flapsPct !== null ? `${round(sample.flapsPct, 0)}%` : null;
}

function findFinalFlapSample(
  samples: InsightSample[],
  startIndex: number,
  endIndex: number,
): ConfigurationMilestone | null {
  let finalIndex = endIndex;
  while (finalIndex >= startIndex && flapIdentity(samples[finalIndex]) === null) finalIndex -= 1;
  if (finalIndex < startIndex) return null;

  const finalIdentity = flapIdentity(samples[finalIndex]);
  if (finalIdentity === 'pct:0' || finalIdentity === 'notch:0' || finalIdentity === 'notch:UP') return null;
  let runStart = finalIndex;
  while (
    runStart > startIndex
    && flapIdentity(samples[runStart - 1]) === finalIdentity
    && samples[runStart].tsMs - samples[runStart - 1].tsMs <= MAX_INTERVAL_MS
  ) runStart -= 1;

  const previous = samples[runStart - 1];
  const previousIdentity = previous ? flapIdentity(previous) : null;
  return {
    sample: samples[runStart],
    transitionObserved: Boolean(
      previous
      && previousIdentity !== null
      && previousIdentity !== finalIdentity
      && samples[runStart].tsMs - previous.tsMs <= MAX_INTERVAL_MS,
    ),
  };
}

function buildFuelSummary(rows: InsightInputRow[], distance: number): PostFlightInsights['fuel'] {
  const { firstFuelRow, lastFuelRow } = selectFuelUsageRows(rows);
  const usage = summarizeFuelUsage(firstFuelRow, lastFuelRow);
  if (usage.fuelBurnGal === null && usage.fuelBurnWeightLbs === null) return null;

  const density = extractFuelWeightPerGal(firstFuelRow) ?? extractFuelWeightPerGal(lastFuelRow);
  const burnLbs = usage.fuelBurnWeightLbs
    ?? (usage.fuelBurnGal !== null && density !== null ? round(usage.fuelBurnGal * density) : null);
  return {
    burn_gal: usage.fuelBurnGal,
    burn_lbs: burnLbs,
    efficiency_gal_per_nm: usage.fuelBurnGal !== null && distance >= MIN_ROUTE_DISTANCE_NM
      ? round(usage.fuelBurnGal / distance, 2)
      : null,
    efficiency_lbs_per_nm: burnLbs !== null && distance >= MIN_ROUTE_DISTANCE_NM
      ? round(burnLbs / distance, 1)
      : null,
    source: usage.fuelBurnSource,
  };
}

function computePostFlightInsights(
  rows: InsightInputRow[],
  options: { goAroundCount?: number; lastHoldingEndTs?: number | null } = {},
): PostFlightInsights | null {
  const samples = rows
    .map(normalizeSample)
    .filter((sample): sample is InsightSample => sample !== null)
    .sort((a, b) => a.tsMs - b.tsMs);
  if (samples.length < 2) return null;

  let recordedTimeMs = 0;
  let airborneTimeMs = 0;
  let taxiTimeMs = 0;
  let pausedTimeMs = 0;
  let routeDistanceNm = 0;
  let routeAvailableTimeMs = 0;
  let autopilotTimeMs = 0;
  let handFlownTimeMs = 0;
  let handFlownBelow1000FtMs = 0;
  let automationAvailableTimeMs = 0;
  let inCloudTimeMs = 0;
  let inCloudAvailableTimeMs = 0;
  let precipitationTimeMs = 0;
  let precipitationAvailableTimeMs = 0;
  let roughAirTimeMs = 0;
  let roughAirAvailable = false;
  let windAvailableTimeMs = 0;
  let maxWindKts: number | null = null;
  let peakG: number | null = null;
  let minimumG: number | null = null;
  let maxBankDeg: number | null = null;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (isAirborne(sample)) {
      if (sample.windSpeedKts !== null && sample.windSpeedKts >= 0 && sample.windSpeedKts <= MAX_PLAUSIBLE_WIND_KTS) {
        maxWindKts = maxWindKts === null ? sample.windSpeedKts : Math.max(maxWindKts, sample.windSpeedKts);
      }
      if (sample.gForce !== null && sample.gForce >= MIN_PLAUSIBLE_G && sample.gForce <= MAX_PLAUSIBLE_G) {
        peakG = peakG === null ? sample.gForce : Math.max(peakG, sample.gForce);
        minimumG = minimumG === null ? sample.gForce : Math.min(minimumG, sample.gForce);
      }
      if (sample.bankDeg !== null && Math.abs(sample.bankDeg) <= MAX_PLAUSIBLE_BANK_DEG) {
        const absoluteBank = Math.abs(sample.bankDeg);
        maxBankDeg = maxBankDeg === null ? absoluteBank : Math.max(maxBankDeg, absoluteBank);
      }
    }

    if (index === 0) continue;
    const previous = samples[index - 1];
    const intervalMs = sample.tsMs - previous.tsMs;
    if (intervalMs <= 0) continue;
    if (previous.paused) {
      if (intervalMs <= MAX_PAUSED_INTERVAL_MS) {
        recordedTimeMs += intervalMs;
        pausedTimeMs += intervalMs;
      }
      continue;
    }
    if (intervalMs > MAX_INTERVAL_MS) continue;
    recordedTimeMs += intervalMs;
    if (isTaxi(previous)) taxiTimeMs += intervalMs;
    if (!isAirborne(previous)) continue;
    airborneTimeMs += intervalMs;

    const segmentDistance = distanceNm(previous, sample);
    if (segmentDistance !== null) {
      const maximumPlausibleDistance = (MAX_PLAUSIBLE_GROUND_SPEED_KTS * intervalMs) / 3600000;
      if (segmentDistance <= Math.max(0.15, maximumPlausibleDistance)) {
        routeDistanceNm += segmentDistance;
        routeAvailableTimeMs += intervalMs;
      }
    }

    if (previous.apMaster !== null && previous.apReliable !== false) {
      automationAvailableTimeMs += intervalMs;
      if (previous.apMaster) {
        autopilotTimeMs += intervalMs;
      } else {
        handFlownTimeMs += intervalMs;
        if (previous.raFt !== null && previous.raFt <= 1000) handFlownBelow1000FtMs += intervalMs;
      }
    }

    if (previous.inCloud !== null) {
      inCloudAvailableTimeMs += intervalMs;
      if (previous.inCloud) inCloudTimeMs += intervalMs;
    }
    if (previous.precipRateMm !== null || previous.precipState !== null) {
      precipitationAvailableTimeMs += intervalMs;
      if ((previous.precipRateMm ?? 0) > 0.01 || (previous.precipState ?? 0) > 0) {
        precipitationTimeMs += intervalMs;
      }
    }
    if (previous.windSpeedKts !== null && previous.windSpeedKts >= 0 && previous.windSpeedKts <= MAX_PLAUSIBLE_WIND_KTS) {
      windAvailableTimeMs += intervalMs;
    }
    if (hasPlausibleRoughAirTelemetry(previous)) {
      roughAirAvailable = true;
      if (isRoughAir(previous)) roughAirTimeMs += intervalMs;
    }
  }

  const distance = round(routeDistanceNm, 1);
  const routeCoverage = airborneTimeMs > 0 ? routeAvailableTimeMs / airborneTimeMs : 0;
  const route = distance >= MIN_ROUTE_DISTANCE_NM && routeCoverage >= MIN_SUMMARY_COVERAGE
    ? {
        distance_nm: distance,
        average_ground_speed_kts: routeAvailableTimeMs > 0
          ? round(routeDistanceNm / (routeAvailableTimeMs / 3600000))
          : null,
        coverage_percent: round(routeCoverage * 100),
      }
    : null;
  const automationCoverage = airborneTimeMs > 0 ? automationAvailableTimeMs / airborneTimeMs : 0;
  const automation = automationAvailableTimeMs > 0 && automationCoverage >= MIN_SUMMARY_COVERAGE
    ? {
        autopilot_time_ms: autopilotTimeMs,
        hand_flown_time_ms: handFlownTimeMs,
        hand_flown_below_1000_ft_ms: handFlownBelow1000FtMs,
        autopilot_percent: round((autopilotTimeMs / automationAvailableTimeMs) * 100),
        coverage_percent: round(automationCoverage * 100),
      }
    : null;
  const inCloudCoverage = airborneTimeMs > 0 ? inCloudAvailableTimeMs / airborneTimeMs : 0;
  const precipitationCoverage = airborneTimeMs > 0 ? precipitationAvailableTimeMs / airborneTimeMs : 0;
  const windCoverage = airborneTimeMs > 0 ? windAvailableTimeMs / airborneTimeMs : 0;
  const weatherCoverageValues: number[] = [];
  const inCloudSummary = inCloudCoverage >= MIN_SUMMARY_COVERAGE ? inCloudTimeMs : null;
  const precipitationSummary = precipitationCoverage >= MIN_SUMMARY_COVERAGE ? precipitationTimeMs : null;
  const maxWindSummary = maxWindKts !== null && windCoverage >= MIN_SUMMARY_COVERAGE ? round(maxWindKts) : null;
  if (inCloudSummary !== null) weatherCoverageValues.push(inCloudCoverage);
  if (precipitationSummary !== null) weatherCoverageValues.push(precipitationCoverage);
  if (maxWindSummary !== null) weatherCoverageValues.push(windCoverage);
  const weather = weatherCoverageValues.length > 0
    ? {
        in_cloud_time_ms: inCloudSummary,
        precipitation_time_ms: precipitationSummary,
        max_wind_kts: maxWindSummary,
        coverage_percent: round(Math.min(...weatherCoverageValues) * 100),
      }
    : null;
  const comfort = peakG !== null || maxBankDeg !== null || roughAirAvailable
    ? {
        peak_g: peakG !== null ? round(peakG, 2) : null,
        minimum_g: minimumG !== null ? round(minimumG, 2) : null,
        max_bank_deg: maxBankDeg !== null ? round(maxBankDeg, 1) : null,
        rough_air_time_ms: roughAirAvailable ? roughAirTimeMs : null,
      }
    : null;

  const lastHoldingEndTs = toFiniteNumber(options.lastHoldingEndTs);
  const approachRange = findFinalApproachRange(samples, lastHoldingEndTs);
  let configuration: PostFlightInsights['configuration'] = null;
  let approach: PostFlightInsights['approach'] = null;
  if (approachRange) {
    const gearSample = findFinalGearDownSample(samples, 0, approachRange.endIndex);
    const flapSample = findFinalFlapSample(samples, 0, approachRange.endIndex);
    if (gearSample || flapSample) {
      configuration = {
        gear_down_recorded: gearSample !== null,
        gear_down_ra_ft: gearSample?.transitionObserved === true && gearSample.sample.raFt !== null
          ? round(gearSample.sample.raFt)
          : null,
        landing_flaps_ra_ft: flapSample?.transitionObserved === true && flapSample.sample.raFt !== null
          ? round(flapSample.sample.raFt)
          : null,
        landing_flaps: flapSample ? flapLabel(flapSample.sample) : null,
      };
    }
    const startSample = samples[approachRange.startIndex];
    const endSample = samples[approachRange.endIndex];
    const establishedDistance = distanceNm(startSample, endSample);
    approach = {
      duration_ms: Math.max(0, endSample.tsMs - startSample.tsMs),
      attempt_count: Math.max(1, Math.round(Number(options.goAroundCount) || 0) + 1),
      established_distance_nm: establishedDistance !== null ? round(establishedDistance, 1) : null,
    };
  }

  return {
    time: {
      recorded_time_ms: recordedTimeMs,
      airborne_time_ms: airborneTimeMs,
      taxi_time_ms: taxiTimeMs,
      paused_time_ms: pausedTimeMs,
    },
    route,
    fuel: buildFuelSummary(rows, route ? routeDistanceNm : 0),
    automation,
    weather,
    configuration,
    comfort,
    approach,
  };
}

const postFlightInsightsSummaryApi = { computePostFlightInsights };

module.exports = postFlightInsightsSummaryApi;

export {};
