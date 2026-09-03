const { MSG } = require('./message-types.js') as {
  MSG: {
    SIGNAL_RELIABILITY: string;
  };
};
const {
  deriveMagneticHeadingFromTrue,
  deriveTrueHeadingFromMagnetic,
  normalizeHeadingDegrees,
} = require('../utils/aviation-frames') as AviationFramesModule;

type UnknownRecord = Record<string, unknown>;
type SignalReliabilityMap = Record<string, string>;
type FdmFieldValue = number | boolean | string | null | undefined;
type FdmLike = Record<string, FdmFieldValue>;
type AviationFramesModule = {
  deriveMagneticHeadingFromTrue: (trueHeadingDeg: unknown, magvarDeg: unknown) => number | null;
  deriveTrueHeadingFromMagnetic: (magneticHeadingDeg: unknown, magvarDeg: unknown) => number | null;
  normalizeHeadingDegrees: (value: unknown) => number | null;
};

type ProfileLike = {
  id?: string | null;
  signalReliability?: SignalReliabilityMap | null;
  aircraft?: {
    engines?: {
      count?: unknown;
    } | null;
  } | null;
  engines?: {
    count?: unknown;
  } | null;
} | null | undefined;

type AutopilotReliability = {
  apReliable?: boolean | null;
  athrReliable?: boolean | null;
  reason?: string | null;
} | null | undefined;

type SimconnectLike = {
  fdm?: FdmLike | null;
  hdgTrueDeg?: number | null;
  hdgMagDeg?: number | null;
  magvarDeg?: number | null;
  simVersion?: string | null;
} | null | undefined;

type FrameLike = UnknownRecord & {
  wow?: unknown;
  paused?: unknown;
  inMenu?: unknown;
  engines?: UnknownRecord | null;
  throttle?: UnknownRecord | null;
  fdm?: FdmLike | null;
  yoke?: { x?: number | null; y?: number | null } | null;
  simconnect?: SimconnectLike;
  lat?: number | null;
  lon?: number | null;
  gforce?: number | null;
  brake?: number | null;
  assists?: unknown;
  surface?: {
    raw?: unknown;
    name?: unknown;
    class?: unknown;
    runwayLike?: unknown;
    onRunway?: unknown;
    onGround?: unknown;
    valid?: unknown;
  } | null;
  simTime?: {
    zuluSec?: unknown;
    localSec?: unknown;
    zuluHms?: unknown;
    localHms?: unknown;
    zuluDate?: unknown;
    localDate?: unknown;
    zuluIso?: unknown;
    localIso?: unknown;
    zuluYear?: unknown;
    zuluMonth?: unknown;
    zuluDay?: unknown;
    zuluDayOfYear?: unknown;
    zuluDayOfWeek?: unknown;
    localYear?: unknown;
    localMonth?: unknown;
    localDay?: unknown;
    localDayOfYear?: unknown;
    localDayOfWeek?: unknown;
    timezoneOffsetSec?: unknown;
    absoluteSec?: unknown;
    timeOfDay?: unknown;
    zuluSunriseSec?: unknown;
    zuluSunsetSec?: unknown;
    source?: unknown;
    valid?: unknown;
  } | null;
  ilsGsDeviation?: unknown;
  ilsLocDeviation?: unknown;
  ias?: unknown;
  vs?: unknown;
  ra?: unknown;
  gs?: unknown;
  heading?: unknown;
  alt_msl?: unknown;
  pitch?: unknown;
  bank?: unknown;
  gearDownLocked?: unknown;
  windSpeed?: unknown;
  windDir?: unknown;
};

type HeadingData = {
  hdgTrueDeg: number | null;
  hdgMagDeg: number | null;
  magvarDeg: number | null;
};

type RunwayContext = {
  icao: string | null;
  runway: string | null;
  approachType: string | null;
};

type GeometryLookupContext = {
  simulator?: string | null;
  dataSource?: string | null;
  offline?: boolean | null;
} | null | undefined;

type AircraftSpecificConfigLike = {
  templateId?: unknown;
} | null | undefined;

type AircraftSpecificProfileLike = {
  integration?: {
    presentation?: {
      aircraftSpecific?: {
        template?: unknown;
      } | null;
    } | null;
  } | null;
} | null | undefined;

type RunwayContextDetectorParams = {
  approachPhases: Set<string>;
  groundPhases: Set<string>;
  landingPhase: string;
  findRunwayByPosition: (
    _lat: number,
    _lon: number,
    _radiusNm: number,
    _headingDeg?: number | null,
    _context?: GeometryLookupContext,
  ) => UnknownRecord | null;
  findNearbyAirport: (_lat: number, _lon: number, _radiusNm: number, _context?: GeometryLookupContext) => UnknownRecord | null;
  lookupThresholdDeg?: number;
  approachDistanceNm?: number;
  airportLookupDistanceNm?: number;
};

type BuildVreEnrichedFrameParams = {
  frame: FrameLike;
  userId?: string | null;
  sessionId?: string | null;
  nowEpochMs: number;
  timestampIso: string;
  flightId?: string | null;
  flightStartIso?: string | null;
  flightStartEpochMs?: number | null;
  sampleRateHz?: number | null;
  escalationReason?: string | null;
  phase?: string | null;
  stability?: string | null;
  iasKnots?: number | null;
  gs?: number | null;
  vsFeetPerMin?: number | null;
  altMslFt?: number | null;
  raFeet?: number | null;
  xwind?: number | null;
  trend?: number | null;
  headingData: HeadingData;
  pitchDeg?: number | null;
  bankDeg?: number | null;
  maxPitchBankDeg?: number;
  windSpeed?: number | null;
  windDir?: number | null;
  gearDownLocked?: boolean | null;
  flapsNotch?: string | number | null;
  flaps?: UnknownRecord | null;
  flapsSource?: string | null;
  spoilerPct?: number | null;
  spoilerState?: string | null;
  spoilerSource?: string | null;
  spoilerAvailable?: boolean | null;
  brakePct?: number | null;
  thr1Pct?: number | null;
  thr2Pct?: number | null;
  thr3Pct?: number | null;
  thr4Pct?: number | null;
  profileId?: string | null;
  signalReliability?: unknown;
  dataSource?: string | null;
  aircraftName?: string | null;
  fdm?: FdmLike | null;
  autopilotReliability?: AutopilotReliability;
  elapsedMs?: number | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteNumberOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveLandingGeometryScoringInputs(payload: UnknownRecord | null | undefined) {
  const landing = payload && typeof payload === 'object' ? payload : {};
  const thresholdLat = finiteNumberOrNull(landing.runway_threshold_lat);
  const thresholdLon = finiteNumberOrNull(landing.runway_threshold_lon);
  const thresholdElevFt = finiteNumberOrNull(landing.runway_reference_elev_ft);
  const widthFt = finiteNumberOrNull(landing.runway_width_ft);
  const lengthFt = finiteNumberOrNull(landing.runway_length_ft);

  return {
    thresholdElevFt,
    runwayReferenceElevationSource: thresholdElevFt === null
      ? null
      : nonEmptyStringOrNull(landing.runway_reference_elevation_source),
    runwayReferenceElevationKind: thresholdElevFt === null
      ? null
      : nonEmptyStringOrNull(landing.runway_reference_elevation_kind),
    runwayHdg: finiteNumberOrNull(landing.runway_heading_true_deg),
    runwayWidthFt: widthFt !== null && widthFt > 20 ? widthFt : null,
    runwayLengthFt: lengthFt !== null && lengthFt > 1000 ? lengthFt : null,
    runwayThreshold: thresholdLat !== null && thresholdLon !== null
      ? { lat: thresholdLat, lon: thresholdLon }
      : null,
    runwayId: nonEmptyStringOrNull(landing.runway),
    airportIcao: nonEmptyStringOrNull(landing.icao),
  };
}

const DEFAULT_SIGNAL_RELIABILITY = Object.freeze({
  ias: 'generic',
  vs: 'generic',
  ra: 'generic',
  heading: 'generic',
  flapsNotch: 'generic',
  flapsFraction: 'generic',
  spoilersPercent: 'generic',
  spoilersArmed: 'unavailable',
  gearPosition: 'generic',
  n1: 'generic',
  autobrake: 'unavailable',
  vref: 'unavailable',
  stabilityScore: 'generic',
});

const AP_RECORDING_FIELDS = Object.freeze([
  'apMaster',
  'apAltHold',
  'apHdgHold',
  'apNavHold',
  'apApprHold',
  'apVsHold',
  'apFdActive',
  'apFlcHold',
  'apSpeedHold',
  'apAltTargetFt',
  'apHdgTargetDeg',
  'apVsTargetFpm',
  'apSpeedTargetKts',
  'apMachTarget',
  'apLnavHold',
  'apVnavHold',
  'apLocHold',
  'apLvlChgHold',
  'apExpedHold',
]);

const ATHR_RECORDING_FIELDS = Object.freeze([
  'athrActive',
  'athrArmed',
]);

const EMPTY_RUNWAY_CONTEXT: RunwayContext = Object.freeze({
  icao: null,
  runway: null,
  approachType: null,
});

function getGeometryLookupContextKey(context: GeometryLookupContext): string {
  if (!context || typeof context !== 'object') return '';
  const simulator = typeof context.simulator === 'string' ? context.simulator.trim().toLowerCase() : '';
  const dataSource = typeof context.dataSource === 'string' ? context.dataSource.trim().toLowerCase() : '';
  const offline = context.offline === true ? 'offline' : 'live';
  return `${simulator}|${dataSource}|${offline}`;
}

export function createRunwayContextDetector({
  approachPhases,
  groundPhases,
  landingPhase,
  findRunwayByPosition,
  findNearbyAirport,
  lookupThresholdDeg = 0.005,
  approachDistanceNm = 5,
  airportLookupDistanceNm = 10,
}: RunwayContextDetectorParams) {
  let cachedRunwayInfo: RunwayContext | null = null;
  let lastRunwayLookupLat: number | null = null;
  let lastRunwayLookupLon: number | null = null;
  let lastRunwayLookupContextKey: string | null = null;

  return function detectAirportRunway(
    lat: number | null,
    lon: number | null,
    hdgDeg: number | null,
    phase: string,
    context?: GeometryLookupContext,
  ): RunwayContext {
    if (!approachPhases.has(phase)) {
      const cachedResult = cachedRunwayInfo || EMPTY_RUNWAY_CONTEXT;
      if (groundPhases.has(phase) && phase !== landingPhase) {
        cachedRunwayInfo = null;
        lastRunwayLookupLat = null;
        lastRunwayLookupLon = null;
        lastRunwayLookupContextKey = null;
      }
      return cachedResult;
    }

    if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) {
      return EMPTY_RUNWAY_CONTEXT;
    }

    const contextKey = getGeometryLookupContextKey(context);
    const needsLookup = !cachedRunwayInfo ||
      cachedRunwayInfo.runway == null ||
      lastRunwayLookupLat == null ||
      lastRunwayLookupLon == null ||
      lastRunwayLookupContextKey !== contextKey ||
      Math.abs(lat - lastRunwayLookupLat) > lookupThresholdDeg ||
      Math.abs(lon - lastRunwayLookupLon) > lookupThresholdDeg;

    if (needsLookup) {
      const runwayMatch = findRunwayByPosition(lat, lon, approachDistanceNm, hdgDeg, context);
      if (runwayMatch) {
        cachedRunwayInfo = {
          icao: typeof runwayMatch.icao === 'string' ? runwayMatch.icao : null,
          runway: typeof runwayMatch.runway === 'string' ? runwayMatch.runway : null,
          approachType: null,
        };
      } else {
        const airportMatch = findNearbyAirport(lat, lon, airportLookupDistanceNm, context);
        cachedRunwayInfo = airportMatch
          ? { icao: typeof airportMatch.icao === 'string' ? airportMatch.icao : null, runway: null, approachType: null }
          : EMPTY_RUNWAY_CONTEXT;
      }
      lastRunwayLookupLat = lat;
      lastRunwayLookupLon = lon;
      lastRunwayLookupContextKey = contextKey;
    }

    return cachedRunwayInfo || EMPTY_RUNWAY_CONTEXT;
  };
}

function buildRecordingFdmSnapshot(fdm: FdmLike | null | undefined, autopilotReliability: AutopilotReliability): FdmLike {
  const snapshot: FdmLike = (fdm && typeof fdm === 'object') ? { ...fdm } : {};

  if (autopilotReliability?.apReliable === false) {
    for (const key of AP_RECORDING_FIELDS) {
      snapshot[key] = null;
    }
  }

  if (autopilotReliability?.athrReliable === false) {
    for (const key of ATHR_RECORDING_FIELDS) {
      snapshot[key] = null;
    }
  }

  return snapshot;
}

export function resolveAircraftSpecificTemplateId(
  aircraftSpecificConfig: AircraftSpecificConfigLike,
  profile: AircraftSpecificProfileLike = null,
): string | null {
  const effectiveTemplate = typeof aircraftSpecificConfig?.templateId === 'string'
    ? aircraftSpecificConfig.templateId.trim()
    : '';
  if (effectiveTemplate) return effectiveTemplate;

  const legacyTemplate = profile?.integration?.presentation?.aircraftSpecific?.template;
  if (typeof legacyTemplate !== 'string') return null;
  const normalizedLegacyTemplate = legacyTemplate.trim();
  return normalizedLegacyTemplate || null;
}

export function buildSignalReliabilityPayload(profile: ProfileLike): {
  type: string;
  signals: SignalReliabilityMap;
  profileId: string;
  source: 'profile';
} {
  const profileReliability = profile?.signalReliability || {};
  return {
    type: MSG.SIGNAL_RELIABILITY,
    signals: { ...DEFAULT_SIGNAL_RELIABILITY, ...profileReliability },
    profileId: profile?.id || 'generic',
    source: 'profile',
  };
}

export function computeSimStateMenuFlag({
  simconnectConnected,
  providerInMenu,
  lifecycleInMenu,
  simSystemInMenu,
  dialogInMenu,
  isGlobeView,
}: {
  simconnectConnected: boolean;
  providerInMenu?: unknown;
  lifecycleInMenu?: unknown;
  simSystemInMenu?: unknown;
  dialogInMenu?: unknown;
  isGlobeView?: unknown;
}): boolean {
  if (simconnectConnected !== true) return false;
  return Boolean(
    providerInMenu ||
    lifecycleInMenu ||
    simSystemInMenu ||
    dialogInMenu ||
    isGlobeView,
  );
}

const CURRENT_APPROACH_SCORING_CEILING_FT = 1500;
const CURRENT_APPROACH_SCORING_PHASES = new Set(['DESCENT', 'APPROACH', 'LANDING']);

export function shouldCollectCurrentApproachSample({
  phase,
  raFt,
  vsFpm,
  onGround,
  rolloutActive,
  collectionCeilingFt,
  warmup,
}: {
  phase?: string | null;
  raFt?: number | null;
  vsFpm?: number | null;
  onGround?: boolean | null;
  rolloutActive?: boolean | null;
  collectionCeilingFt?: number | null;
  warmup?: boolean | null;
}): boolean {
  if (warmup === true) return false;
  if (rolloutActive === true) return false;
  const ceilingFt = isFiniteNumber(collectionCeilingFt) && collectionCeilingFt > 0
    ? collectionCeilingFt
    : CURRENT_APPROACH_SCORING_CEILING_FT;
  return CURRENT_APPROACH_SCORING_PHASES.has(String(phase))
    && isFiniteNumber(raFt)
    && raFt > 0
    && raFt <= ceilingFt
    && isFiniteNumber(vsFpm)
    && onGround !== true;
}

export function shouldStartCurrentApproachScorer({
  flightActive,
  eligible,
  scorerPresent,
  hasScored,
}: {
  flightActive?: boolean | null;
  eligible?: boolean | null;
  scorerPresent?: boolean | null;
  hasScored?: boolean | null;
}): boolean {
  return flightActive === true
    && eligible === true
    && (scorerPresent !== true || hasScored === true);
}

export function shouldResetCurrentApproachScorerForParked({
  phase,
  scorerPresent,
  hasScored,
  sampleCount,
}: {
  phase?: string | null;
  scorerPresent?: boolean | null;
  hasScored?: boolean | null;
  sampleCount?: number | null;
}): boolean {
  if (String(phase) !== 'PARKED') return true;
  if (scorerPresent === true && hasScored !== true && isFiniteNumber(sampleCount) && sampleCount > 0) {
    return false;
  }
  return true;
}

/**
 * Reset every scoring component that is scoped to a single landing attempt.
 *
 * Keep this fan-out shared by the live core and replay regressions: adding a
 * new attempt-scoped component in one path but not the other would allow a
 * go-around to leak first-attempt state into the eventual landing score.
 */
export function resetGoAroundScoringState<T>({
  resetStability,
  landingRunner,
  createCurrentApproachScorer,
}: {
  resetStability: () => void;
  landingRunner: { reset: () => void };
  createCurrentApproachScorer: () => T;
}): T {
  resetStability();
  landingRunner.reset();
  return createCurrentApproachScorer();
}

export function computeHeadingAndMagvar({
  sc,
  fallbackTrueHeadingDeg,
  fallbackMagvarDeg,
}: {
  sc?: SimconnectLike;
  fallbackTrueHeadingDeg?: number | null;
  fallbackMagvarDeg?: number | null;
}): HeadingData {
  let hdgTrueDeg = null;
  let hdgMagDeg = null;
  let magvarDeg = null;

  if (sc && isFiniteNumber(sc.hdgTrueDeg)) {
    hdgTrueDeg = sc.hdgTrueDeg;
  }
  if (sc && isFiniteNumber(sc.hdgMagDeg)) {
    hdgMagDeg = sc.hdgMagDeg;
  }
  if (sc && isFiniteNumber(sc.magvarDeg)) {
    magvarDeg = sc.magvarDeg;
  }

  if (hdgTrueDeg == null && typeof fallbackTrueHeadingDeg === 'number') {
    hdgTrueDeg = fallbackTrueHeadingDeg;
  }
  if (magvarDeg == null && typeof fallbackMagvarDeg === 'number') {
    magvarDeg = fallbackMagvarDeg;
  }

  if (hdgTrueDeg == null && hdgMagDeg != null && magvarDeg != null) {
    hdgTrueDeg = deriveTrueHeadingFromMagnetic(hdgMagDeg, magvarDeg);
  }
  if (hdgMagDeg == null && hdgTrueDeg != null && magvarDeg != null) {
    hdgMagDeg = deriveMagneticHeadingFromTrue(hdgTrueDeg, magvarDeg);
  }

  return {
    hdgTrueDeg: normalizeHeadingDegrees(hdgTrueDeg),
    hdgMagDeg: normalizeHeadingDegrees(hdgMagDeg),
    magvarDeg,
  };
}

export function computeElapsedMs(nowEpochMs: number, startEpochMs: number | null | undefined): number | null {
  return startEpochMs != null ? Math.max(0, nowEpochMs - startEpochMs) : null;
}

export function formatElapsedHms(totalSeconds: unknown): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

export function mergeFdmData(frameFdm: FdmLike | null | undefined, sc: SimconnectLike): FdmLike {
  const fdm = frameFdm || {};
  const scFdm = sc?.fdm || {};

  const prefer = (scVal: FdmFieldValue, frameVal: FdmFieldValue): FdmFieldValue =>
    isFiniteNumber(scVal) ? scVal : frameVal;

  const preferBool = (scVal: FdmFieldValue, frameVal: FdmFieldValue): FdmFieldValue =>
    scVal != null ? scVal : frameVal;

  return {
    tasKts: prefer(scFdm.tasKts, fdm.tasKts),

    aileronPct: prefer(scFdm.aileronPct, fdm.aileronPct),
    elevatorPct: prefer(scFdm.elevatorPct, fdm.elevatorPct),
    rudderPct: prefer(scFdm.rudderPct, fdm.rudderPct),

    // Pilot control inputs (yoke/sidestick and rudder pedals), +/-100%
    yokeXPct: prefer(scFdm.yokeXPct, fdm.yokeXPct),
    yokeYPct: prefer(scFdm.yokeYPct, fdm.yokeYPct),
    rudderPedalPct: prefer(scFdm.rudderPedalPct, fdm.rudderPedalPct),

    pitchRateRadS: prefer(scFdm.pitchRateRadS, fdm.pitchRateRadS),
    rollRateRadS: prefer(scFdm.rollRateRadS, fdm.rollRateRadS),
    yawRateRadS: prefer(scFdm.yawRateRadS, fdm.yawRateRadS),

    oatC: prefer(scFdm.oatC, fdm.oatC),
    tatC: prefer(scFdm.tatC, fdm.tatC),
    pressureMb: prefer(scFdm.pressureMb, fdm.pressureMb),
    pressureAltFt: prefer(scFdm.pressureAltFt, fdm.pressureAltFt),
    altIndicatedFt: prefer(scFdm.altIndicatedFt, fdm.altIndicatedFt),
    altCalibratedFt: prefer(scFdm.altCalibratedFt, fdm.altCalibratedFt),
    altPlaneFt: prefer(scFdm.altPlaneFt, fdm.altPlaneFt),
    aircraftAglFt: prefer(scFdm.aircraftAglFt, fdm.aircraftAglFt),
    aircraftAboveObstaclesFt: prefer(scFdm.aircraftAboveObstaclesFt, fdm.aircraftAboveObstaclesFt),
    planeAglFt: prefer(scFdm.planeAglFt, fdm.planeAglFt),
    planeAglMinusCgFt: prefer(scFdm.planeAglMinusCgFt, fdm.planeAglMinusCgFt),
    kohlsmanSettingMb: prefer(scFdm.kohlsmanSettingMb, fdm.kohlsmanSettingMb),
    kohlsmanTunedMb: prefer(scFdm.kohlsmanTunedMb, fdm.kohlsmanTunedMb),
    kohlsmanStd: preferBool(scFdm.kohlsmanStd, fdm.kohlsmanStd),
    seaLevelPressureMb: prefer(scFdm.seaLevelPressureMb, fdm.seaLevelPressureMb),
    visibilityM: prefer(scFdm.visibilityM, fdm.visibilityM),
    precipRateMm: prefer(scFdm.precipRateMm, fdm.precipRateMm),
    precipState: prefer(scFdm.precipState, fdm.precipState),

    inCloud: preferBool(scFdm.inCloud, fdm.inCloud),
    surfaceCondition: prefer(scFdm.surfaceCondition, fdm.surfaceCondition),
    densityAltFt: prefer(scFdm.densityAltFt, fdm.densityAltFt),

    cabinAltFt: prefer(scFdm.cabinAltFt, fdm.cabinAltFt),
    cabinAltRateFpm: prefer(scFdm.cabinAltRateFpm, fdm.cabinAltRateFpm),
    cabinDeltaPPsi: prefer(scFdm.cabinDeltaPPsi, fdm.cabinDeltaPPsi),
    cabinAltTargetFt: prefer(scFdm.cabinAltTargetFt, fdm.cabinAltTargetFt),
    cabinDumpSwitch: preferBool(scFdm.cabinDumpSwitch, fdm.cabinDumpSwitch),

    eng1N1: prefer(scFdm.eng1N1, fdm.eng1N1),
    eng2N1: prefer(scFdm.eng2N1, fdm.eng2N1),
    eng3N1: prefer(scFdm.eng3N1, fdm.eng3N1),
    eng4N1: prefer(scFdm.eng4N1, fdm.eng4N1),

    eng1N2: prefer(scFdm.eng1N2, fdm.eng1N2),
    eng2N2: prefer(scFdm.eng2N2, fdm.eng2N2),
    eng3N2: prefer(scFdm.eng3N2, fdm.eng3N2),
    eng4N2: prefer(scFdm.eng4N2, fdm.eng4N2),

    eng1EgtC: prefer(scFdm.eng1EgtC, fdm.eng1EgtC),
    eng2EgtC: prefer(scFdm.eng2EgtC, fdm.eng2EgtC),
    eng3EgtC: prefer(scFdm.eng3EgtC, fdm.eng3EgtC),
    eng4EgtC: prefer(scFdm.eng4EgtC, fdm.eng4EgtC),

    eng1FfPph: prefer(scFdm.eng1FfPph, fdm.eng1FfPph),
    eng2FfPph: prefer(scFdm.eng2FfPph, fdm.eng2FfPph),
    eng3FfPph: prefer(scFdm.eng3FfPph, fdm.eng3FfPph),
    eng4FfPph: prefer(scFdm.eng4FfPph, fdm.eng4FfPph),

    fuelTotalGal: prefer(scFdm.fuelTotalGal, fdm.fuelTotalGal),
    fuelTotalPct: prefer(scFdm.fuelTotalPct, fdm.fuelTotalPct),
    fuelTotalWeightLbs: prefer(scFdm.fuelTotalWeightLbs, fdm.fuelTotalWeightLbs),
    fuelWeightPerGal: prefer(scFdm.fuelWeightPerGal, fdm.fuelWeightPerGal),

    grossWeightLbs: prefer(scFdm.grossWeightLbs, fdm.grossWeightLbs),
    cgPct: prefer(scFdm.cgPct, fdm.cgPct),

    apMaster: preferBool(scFdm.apMaster, fdm.apMaster),
    apAltHold: preferBool(scFdm.apAltHold, fdm.apAltHold),
    apHdgHold: preferBool(scFdm.apHdgHold, fdm.apHdgHold),
    apNavHold: preferBool(scFdm.apNavHold, fdm.apNavHold),
    apApprHold: preferBool(scFdm.apApprHold, fdm.apApprHold),
    apVsHold: preferBool(scFdm.apVsHold, fdm.apVsHold),
    apFlcHold: preferBool(scFdm.apFlcHold, fdm.apFlcHold),
    apSpeedHold: preferBool(scFdm.apSpeedHold, fdm.apSpeedHold),
    apFdActive: preferBool(scFdm.apFdActive ?? scFdm.apFlightDirector, fdm.apFdActive),
    athrActive: preferBool(scFdm.athrActive, fdm.athrActive),
    athrArmed: preferBool(scFdm.athrArmed, fdm.athrArmed),
    apAltTargetFt: prefer(scFdm.apAltTargetFt, fdm.apAltTargetFt),
    apHdgTargetDeg: prefer(scFdm.apHdgTargetDeg, fdm.apHdgTargetDeg),
    apVsTargetFpm: prefer(scFdm.apVsTargetFpm, fdm.apVsTargetFpm),
    apSpeedTargetKts: prefer(scFdm.apSpeedTargetKts, fdm.apSpeedTargetKts),
    apMachTarget: prefer(scFdm.apMachTarget, fdm.apMachTarget),

    mach: prefer(scFdm.mach, fdm.mach),
    aoaDeg: prefer(scFdm.aoaDeg, fdm.aoaDeg),
    sideslipDeg: prefer(scFdm.sideslipDeg, fdm.sideslipDeg),
    trackTrueDeg: prefer(scFdm.trackTrueDeg, fdm.trackTrueDeg),
    gForceLateral: prefer(scFdm.gForceLateral, fdm.gForceLateral),
    gForceLongitudinal: prefer(scFdm.gForceLongitudinal, fdm.gForceLongitudinal),

    elevTrimPct: prefer(scFdm.elevTrimPct, fdm.elevTrimPct),
    nav1GsiRaw: prefer(scFdm.nav1GsiRaw, fdm.nav1GsiRaw),
    nav1CdiRaw: prefer(scFdm.nav1CdiRaw, fdm.nav1CdiRaw),
    nav1HasGlideSlope: preferBool(scFdm.nav1HasGlideSlope, fdm.nav1HasGlideSlope),
    nav1HasLocalizer: preferBool(scFdm.nav1HasLocalizer, fdm.nav1HasLocalizer),
    nav1Signal: prefer(scFdm.nav1Signal, fdm.nav1Signal),
    gsDeviationDots: prefer(scFdm.gsDeviationDots, fdm.gsDeviationDots),
    locDeviationDots: prefer(scFdm.locDeviationDots, fdm.locDeviationDots),
  };
}

export function getEngineLevels(frame: FrameLike | null | undefined, maxEngines = 4): number[] {
  const levels: number[] = [];
  const engines = frame && frame.engines;
  if (engines && typeof engines === 'object') {
    for (let i = 1; i <= maxEngines; i++) {
      const v = engines[`eng${i}`];
      if (isFiniteNumber(v)) levels.push(v);
    }
  }

  const thr = frame && frame.throttle;
  if (levels.length === 0 && thr && typeof thr === 'object') {
    for (let i = 1; i <= maxEngines; i++) {
      const v = thr[`eng${i}Pct`];
      if (isFiniteNumber(v)) levels.push(v);
    }
  }

  return levels;
}

function normalizeEngineCount(value: unknown): number | null {
  if (value == null || value === '') return null;
  const count = Number(value);
  if (!Number.isFinite(count)) return null;
  const rounded = Math.trunc(count);
  if (rounded < 1 || rounded > 4) return null;
  return rounded;
}

export function getProfileEngineCount(profile: ProfileLike): number | null {
  if (!profile || typeof profile !== 'object') return null;
  const aircraftEngines = profile.aircraft && typeof profile.aircraft === 'object'
    ? profile.aircraft.engines
    : null;
  const legacyEngines = profile.engines && typeof profile.engines === 'object'
    ? profile.engines
    : null;
  return normalizeEngineCount(aircraftEngines && aircraftEngines.count)
    ?? normalizeEngineCount(legacyEngines && legacyEngines.count);
}

function formatPct(value: unknown): string {
  return isFiniteNumber(value) ? `${Math.round(value)}%` : '--';
}

function capEnginesPayload(engines: UnknownRecord, count: number | null): UnknownRecord {
  if (!count) return engines;
  const payload: UnknownRecord = {
    ...engines,
    count,
  };
  for (let engineNumber = count + 1; engineNumber <= 4; engineNumber++) {
    payload[`eng${engineNumber}`] = null;
    payload[`eng${engineNumber}Text`] = '--';
  }
  return payload;
}

export function buildEnginesBroadcastData(
  frame: FrameLike | null | undefined,
  options: { profile?: ProfileLike; maxEngines?: unknown } = {},
): UnknownRecord | null {
  if (!frame) return null;

  const configuredEngineCount = getProfileEngineCount(options.profile)
    ?? normalizeEngineCount(options.maxEngines);
  const engines = frame.engines;
  if (engines && typeof engines === 'object') {
    return capEnginesPayload(engines, configuredEngineCount);
  }

  const fdmMergedForEngines = mergeFdmData(frame.fdm, frame.simconnect);
  const throttle = frame.throttle && typeof frame.throttle === 'object'
    ? frame.throttle
    : {};

  const e1 = isFiniteNumber(fdmMergedForEngines.eng1N1)
    ? fdmMergedForEngines.eng1N1
    : (isFiniteNumber(throttle.eng1Pct) ? throttle.eng1Pct : null);
  const e2 = isFiniteNumber(fdmMergedForEngines.eng2N1)
    ? fdmMergedForEngines.eng2N1
    : (isFiniteNumber(throttle.eng2Pct) ? throttle.eng2Pct : null);
  const e3 = isFiniteNumber(fdmMergedForEngines.eng3N1)
    ? fdmMergedForEngines.eng3N1
    : (isFiniteNumber(throttle.eng3Pct) ? throttle.eng3Pct : null);
  const e4 = isFiniteNumber(fdmMergedForEngines.eng4N1)
    ? fdmMergedForEngines.eng4N1
    : (isFiniteNumber(throttle.eng4Pct) ? throttle.eng4Pct : null);

  const engineValues = [e1, e2, e3, e4];
  let inferredCount = 0;
  if (isFiniteNumber(e4)) inferredCount = 4;
  else if (isFiniteNumber(e3)) inferredCount = 3;
  else if (isFiniteNumber(e2)) inferredCount = 2;
  else if (isFiniteNumber(e1)) inferredCount = 1;
  const count = configuredEngineCount ?? inferredCount;
  if (count === 0 || !engineValues.some(isFiniteNumber)) return null;

  const hasN1 = fdmMergedForEngines.eng1N1 != null || fdmMergedForEngines.eng2N1 != null;
  const valueForEngine = (engineNumber: number): unknown => (
    engineNumber <= count ? engineValues[engineNumber - 1] : null
  );

  return {
    count,
    source: hasN1 ? 'n1' : 'throttle',
    eng1: valueForEngine(1),
    eng2: valueForEngine(2),
    eng3: valueForEngine(3),
    eng4: valueForEngine(4),
    eng1Text: count >= 1 ? formatPct(e1) : '--',
    eng2Text: count >= 2 ? formatPct(e2) : '--',
    eng3Text: count >= 3 ? formatPct(e3) : '--',
    eng4Text: count >= 4 ? formatPct(e4) : '--',
  };
}

export function computeGearBroadcastState({
  gear,
  gearHandleDown,
  previousGearState,
  previousParkingBrake,
}: {
  gear: UnknownRecord;
  gearHandleDown?: unknown;
  previousGearState?: unknown;
  previousParkingBrake?: unknown;
}): {
  payload: UnknownRecord;
  nextGearState: string;
  nextParkingBrake: unknown;
} {
  const gearPositions = [gear.nose, gear.left, gear.right];
  const allDown = gearPositions.every((position) => Number(position) >= 0.99);
  const allUp = gearPositions.every((position) => Number(position) <= 0.05);
  const locked = gear.locked === true;
  const handleDown = gearHandleDown === true || gearHandleDown === 1;
  const nextGearState = locked || allDown || (handleDown && allUp)
    ? 'DOWN'
    : allUp
      ? 'UP'
      : 'TRANSIT';
  const gearStateChanged = nextGearState !== previousGearState;
  const gearParkingBrakeChanged = gear.parkingBrake !== previousParkingBrake;

  return {
    payload: {
      ...gear,
      gearState: nextGearState,
      changed: gearStateChanged,
      parkingBrakeChanged: gearParkingBrakeChanged,
    },
    nextGearState,
    nextParkingBrake: gear.parkingBrake,
  };
}

export function deriveApproachConfigurationState({
  gearDownLocked,
  gearConfigurationAvailable = null,
  flaps,
  flapsConfigurationAvailable = null,
}: {
  gearDownLocked?: unknown;
  gearConfigurationAvailable?: boolean | null;
  flaps?: UnknownRecord | null;
  flapsConfigurationAvailable?: boolean | null;
}): boolean | null {
  const gearKnown = gearConfigurationAvailable !== false && (
    typeof gearDownLocked === 'boolean'
    || (typeof gearDownLocked === 'number' && Number.isFinite(gearDownLocked))
  );
  const gearConfigured = gearKnown ? Boolean(gearDownLocked) : null;

  const flapsNotch = typeof flaps?.notch === 'number' && Number.isFinite(flaps.notch)
    ? flaps.notch
    : null;
  const flapsPercent = typeof flaps?.percent === 'number' && Number.isFinite(flaps.percent)
    ? flaps.percent
    : null;
  // A profile LVAR is an independent flap source. The provider-level
  // availability bit only describes generic SimConnect flap channels, so it
  // must not invalidate a finite LVAR-derived state selected by the overlay.
  const hasIndependentLvarState = flaps?.source === 'lvar';
  const flapsKnown = (flapsConfigurationAvailable !== false || hasIndependentLvarState)
    && (flapsNotch !== null || flapsPercent !== null);
  const flapsConfigured = flapsKnown
    ? Math.max(flapsNotch ?? 0, flapsPercent ?? 0) > 0
    : null;

  if (gearConfigured === true || flapsConfigured === true) return true;
  if (gearConfigured === false && flapsConfigured === false) return false;
  return null;
}

export function advanceDebouncedChangeState({
  value,
  lastValue,
  pendingValue,
  pendingTicks,
  requiredTicks,
}: {
  value: unknown;
  lastValue: unknown;
  pendingValue?: unknown;
  pendingTicks?: number;
  requiredTicks: number;
}): {
  changed: boolean;
  nextLastValue: unknown;
  nextPendingValue: unknown;
  nextPendingTicks: number;
} {
  const neededTicks = Math.max(1, Math.floor(requiredTicks));
  let nextLastValue = lastValue;
  let nextPendingValue = pendingValue;
  let nextPendingTicks = Number.isFinite(pendingTicks) ? Number(pendingTicks) : 0;
  let changed = false;

  if (value !== lastValue) {
    if (value === pendingValue) {
      nextPendingTicks += 1;
    } else {
      nextPendingValue = value;
      nextPendingTicks = 1;
    }

    if (nextPendingTicks >= neededTicks) {
      changed = true;
      nextLastValue = value;
      nextPendingValue = undefined;
      nextPendingTicks = 0;
    }
  } else {
    nextPendingValue = undefined;
    nextPendingTicks = 0;
  }

  return { changed, nextLastValue, nextPendingValue, nextPendingTicks };
}

export function buildVreEvaluationFrame({
  frame,
  vsFeetPerMin,
  raFeet,
  pitchRateDeg,
  bankRateDeg,
  gs,
  gearDownLocked,
  flapsNotch,
  spoilerState,
  wow,
  pitch,
  bank,
  phase,
}: {
  frame: FrameLike;
  vsFeetPerMin?: number | null;
  raFeet?: number | null;
  pitchRateDeg?: number | null;
  bankRateDeg?: number | null;
  gs?: number | null;
  gearDownLocked?: boolean | null;
  flapsNotch?: string | number | null;
  spoilerState?: string | null;
  wow?: boolean | null;
  pitch?: number | null;
  bank?: number | null;
  phase?: string | null;
}): UnknownRecord {
  return {
    vs: vsFeetPerMin,
    ra: raFeet,
    gForce: frame.gforce ?? frame.fdm?.gForce ?? null,
    pitchRate: pitchRateDeg,
    rollRate: bankRateDeg,
    yawRate: (finiteNumberOrNull(frame.fdm?.yawRateRadS) ?? 0) * (180 / Math.PI),
    gs,
    gearDown: gearDownLocked,
    flapsNotch,
    spoilerState,
    wow: wow === true,
    pitch,
    bank,
    phase,
  };
}

/** Absolute CSV sample-rate ceiling, independent of evaluator or poll settings. */
export const MAX_VRE_CSV_SAMPLE_RATE_HZ = 10;

/**
 * Resolve the cadence the VRE logger can actually achieve from the evaluator's
 * target, the telemetry loop cadence, and the absolute CSV safety ceiling. VRE
 * can skip ticks, but it cannot manufacture fresh telemetry samples between
 * ticks or exceed the hard logger cap.
 */
export function resolveVreSamplingRate(
  targetRateHz: unknown,
  pollRateMs: unknown,
): {
  targetRateHz: number;
  effectiveRateHz: number;
  intervalMs: number;
} {
  const normalizedTargetRateHz = isFiniteNumber(targetRateHz) && targetRateHz > 0
    ? targetRateHz
    : 1;
  const normalizedPollRateMs = isFiniteNumber(pollRateMs)
    ? Math.max(1, pollRateMs)
    : 100;
  const cappedTargetRateHz = Math.min(normalizedTargetRateHz, MAX_VRE_CSV_SAMPLE_RATE_HZ);
  const intervalMs = Math.max(normalizedPollRateMs, 1000 / cappedTargetRateHz);

  return {
    targetRateHz: normalizedTargetRateHz,
    effectiveRateHz: 1000 / intervalMs,
    intervalMs,
  };
}

/**
 * Independent runtime admission gate for CSV sample write attempts. This keeps
 * the hard ceiling effective even if evaluator cadence regresses in the future.
 */
export function isVreCsvSampleDue(
  nowEpochMs: unknown,
  lastWriteAttemptTs: unknown,
  intervalMs: unknown,
): boolean {
  if (!isFiniteNumber(nowEpochMs)) return false;
  if (!isFiniteNumber(lastWriteAttemptTs)) return true;
  const normalizedIntervalMs = isFiniteNumber(intervalMs) && intervalMs > 0
    ? intervalMs
    : 1000 / MAX_VRE_CSV_SAMPLE_RATE_HZ;
  return nowEpochMs - lastWriteAttemptTs >= normalizedIntervalMs;
}

export function deriveOverallSignalReliability(
  profileReliability: SignalReliabilityMap | null | undefined,
  keySignals: string[] = ['ias', 'vs', 'ra', 'heading', 'flapsNotch'],
): string {
  const reliabilityLevels: Record<string, number> = { authoritative: 3, generic: 2, unavailable: 1 };
  let worstLevel = 'authoritative';
  const signals = profileReliability || {};

  for (const key of keySignals) {
    const level = signals[key] || 'generic';
    if ((reliabilityLevels[level] ?? reliabilityLevels.generic) < reliabilityLevels[worstLevel]) {
      worstLevel = level;
    }
  }

  return worstLevel;
}

export function normalizePitchBankDegrees({
  pitch,
  bank,
}: {
  pitch?: number | null;
  bank?: number | null;
}): { pitchDeg: number; bankDeg: number } {
  const pitchDeg = isFiniteNumber(pitch) && Math.abs(pitch) <= Math.PI * 2
    ? pitch * (180 / Math.PI)
    : (isFiniteNumber(pitch) ? pitch : 0);
  const bankDeg = isFiniteNumber(bank) && Math.abs(bank) <= Math.PI * 2
    ? bank * (180 / Math.PI)
    : (isFiniteNumber(bank) ? bank : 0);

  return { pitchDeg, bankDeg };
}

export function extractThrottlePercents(throttleSnapshot: UnknownRecord | null | undefined): {
  thr1Pct: number | null;
  thr2Pct: number | null;
  thr3Pct: number | null;
  thr4Pct: number | null;
} {
  const eng1Pct = throttleSnapshot?.eng1Pct;
  const eng2Pct = throttleSnapshot?.eng2Pct;
  const eng3Pct = throttleSnapshot?.eng3Pct;
  const eng4Pct = throttleSnapshot?.eng4Pct;

  return {
    thr1Pct: isFiniteNumber(eng1Pct) ? eng1Pct : null,
    thr2Pct: isFiniteNumber(eng2Pct) ? eng2Pct : null,
    thr3Pct: isFiniteNumber(eng3Pct) ? eng3Pct : null,
    thr4Pct: isFiniteNumber(eng4Pct) ? eng4Pct : null,
  };
}

export function computeBrakePct(frame: FrameLike | null | undefined): number | null {
  const brake = frame?.brake;
  if (!isFiniteNumber(brake) || brake <= 0) return null;
  return brake <= 1 ? brake * 100 : (brake / 32767) * 100;
}

export function extractActivityFields(frame: FrameLike | null | undefined): UnknownRecord | null {
  if (!frame) return null;
  return {
    ias: frame.ias,
    vs: frame.vs,
    ra: frame.ra,
    gs: frame.gs,
    heading: frame.heading,
    alt_msl: frame.alt_msl,
    lat: frame.lat,
    lon: frame.lon,
    pitch: frame.pitch,
    bank: frame.bank,
    gforce: frame.gforce,
    wow: frame.wow,
    gearDownLocked: frame.gearDownLocked,
    windSpeed: frame.windSpeed,
    windDir: frame.windDir,
    surface: frame.surface,
  };
}

export function countActiveTelemetryFields(
  currentFrame: UnknownRecord | null | undefined,
  previousFrame: UnknownRecord | null | undefined,
  {
    defaultThreshold = 0.01,
    gpsChangeThreshold,
    altitudeChangeThresholdFt,
    headingChangeThresholdDeg,
  }: {
    defaultThreshold?: number;
    gpsChangeThreshold?: number;
    altitudeChangeThresholdFt?: number;
    headingChangeThresholdDeg?: number;
  } = {},
): number {
  if (!currentFrame || !previousFrame) return 0;

  let activeCount = 0;
  const fieldsToCheck = [
    'ias', 'vs', 'ra', 'gs', 'heading', 'alt_msl', 'lat', 'lon',
    'pitch', 'bank', 'gforce', 'wow', 'gearDownLocked',
    'windSpeed', 'windDir', 'surface',
  ];

  for (const field of fieldsToCheck) {
    const current = currentFrame[field];
    const previous = previousFrame[field];

    if (current != null && previous != null && current !== previous) {
      if (typeof current === 'number' && typeof previous === 'number') {
        const delta = Math.abs(current - previous);
        let threshold = defaultThreshold;
        if (field === 'lat' || field === 'lon') threshold = gpsChangeThreshold ?? threshold;
        if (field === 'alt_msl') threshold = altitudeChangeThresholdFt ?? threshold;
        if (field === 'heading') threshold = headingChangeThresholdDeg ?? threshold;
        if (delta >= threshold) activeCount++;
      } else {
        activeCount++;
      }
    }
  }

  return activeCount;
}

export function buildVreEnrichedFrame({
  frame,
  userId,
  sessionId,
  nowEpochMs,
  timestampIso,
  flightId,
  flightStartIso,
  flightStartEpochMs,
  sampleRateHz,
  escalationReason,
  phase,
  stability,
  iasKnots,
  gs,
  vsFeetPerMin,
  altMslFt,
  raFeet,
  xwind,
  trend,
  headingData,
  pitchDeg,
  bankDeg,
  maxPitchBankDeg = 90,
  windSpeed,
  windDir,
  gearDownLocked,
  flapsNotch,
  flaps,
  flapsSource,
  spoilerPct,
  spoilerState,
  spoilerSource,
  spoilerAvailable,
  brakePct,
  thr1Pct,
  thr2Pct,
  thr3Pct,
  thr4Pct,
  profileId,
  signalReliability,
  dataSource,
  aircraftName,
  fdm,
  autopilotReliability,
  elapsedMs,
}: BuildVreEnrichedFrameParams): UnknownRecord {
  const recordingFdm = buildRecordingFdmSnapshot(fdm, autopilotReliability);

  return {
    schemaVersion: 3,
    userId,
    sessionId,
    timestampMs: nowEpochMs,
    timestampIso,
    ts: nowEpochMs,
    flightId,
    flightStartIso,
    flightStartEpochMs,
    flightElapsedMs: elapsedMs,
    timestampMonotonic: elapsedMs,
    sampleRateHz,
    escalationReason,
    flightPhaseHint: phase,
    phase,
    stability,
    stabilityScore: null,
    onGround: !!frame.wow,
    paused: frame.paused === true,
    inMenu: frame.inMenu === true,
    ias: iasKnots,
    tas: recordingFdm.tasKts,
    gs,
    vs: vsFeetPerMin,
    altMsl: altMslFt,
    ra: raFeet,
    altIndicatedFt: recordingFdm.altIndicatedFt ?? altMslFt ?? null,
    altCalibratedFt: recordingFdm.altCalibratedFt ?? null,
    altPlaneFt: recordingFdm.altPlaneFt ?? null,
    aircraftAglFt: recordingFdm.aircraftAglFt ?? null,
    aircraftAboveObstaclesFt: recordingFdm.aircraftAboveObstaclesFt ?? null,
    planeAglFt: recordingFdm.planeAglFt ?? null,
    planeAglMinusCgFt: recordingFdm.planeAglMinusCgFt ?? null,
    pressureAltFt: recordingFdm.pressureAltFt ?? null,
    kohlsmanSettingMb: recordingFdm.kohlsmanSettingMb ?? null,
    kohlsmanTunedMb: recordingFdm.kohlsmanTunedMb ?? null,
    kohlsmanStd: recordingFdm.kohlsmanStd ?? null,
    mach: frame.fdm?.mach,
    xwind,
    iasTrend: typeof trend === 'number' ? trend : null,
    lat: frame.lat,
    lon: frame.lon,
    hdgTrue: headingData.hdgTrueDeg,
    hdgMag: headingData.hdgMagDeg,
    magvar: headingData.magvarDeg,
    trackTrue: frame.fdm?.trackTrueDeg,
    pitch: Math.abs(finiteNumberOrNull(pitchDeg) ?? 0) <= maxPitchBankDeg ? pitchDeg : 0,
    bank: Math.abs(finiteNumberOrNull(bankDeg) ?? 0) <= maxPitchBankDeg ? bankDeg : 0,
    aoa: frame.fdm?.aoaDeg,
    sideslip: frame.fdm?.sideslipDeg,
    pitchRateRadS: recordingFdm.pitchRateRadS,
    rollRateRadS: recordingFdm.rollRateRadS,
    yawRateRadS: recordingFdm.yawRateRadS,
    gForce: frame.gforce,
    gForceLateral: frame.fdm?.gForceLateral,
    gForceLongitudinal: frame.fdm?.gForceLongitudinal,
    windSpeed,
    windDir,
    gearDownLocked,
    flapsNotch,
    flaps,
    flapsSource,
    spoilerPct,
    spoilerState,
    spoilerSource,
    spoilerAvailable,
    brakePct,
    // Pilot yoke/sidestick input: prefer SimConnect FDM (+/-100%), normalize to +/-1 for downstream
    yokeX: frame.yoke?.x ?? (finiteNumberOrNull(recordingFdm.yokeXPct) != null ? finiteNumberOrNull(recordingFdm.yokeXPct)! / 100 : null),
    yokeY: frame.yoke?.y ?? (finiteNumberOrNull(recordingFdm.yokeYPct) != null ? finiteNumberOrNull(recordingFdm.yokeYPct)! / 100 : null),
    rudderPedalPct: recordingFdm.rudderPedalPct,
    aileronPct: recordingFdm.aileronPct,
    elevatorPct: recordingFdm.elevatorPct,
    rudderPct: recordingFdm.rudderPct,
    elevTrimPct: recordingFdm.elevTrimPct,
    thr1: thr1Pct,
    thr2: thr2Pct,
    thr3: thr3Pct,
    thr4: thr4Pct,
    eng1N1: recordingFdm.eng1N1,
    eng2N1: recordingFdm.eng2N1,
    eng3N1: recordingFdm.eng3N1,
    eng4N1: recordingFdm.eng4N1,
    eng1N2: recordingFdm.eng1N2,
    eng2N2: recordingFdm.eng2N2,
    eng3N2: recordingFdm.eng3N2,
    eng4N2: recordingFdm.eng4N2,
    eng1Egt: recordingFdm.eng1EgtC,
    eng2Egt: recordingFdm.eng2EgtC,
    eng3Egt: recordingFdm.eng3EgtC,
    eng4Egt: recordingFdm.eng4EgtC,
    eng1FF: recordingFdm.eng1FfPph,
    eng2FF: recordingFdm.eng2FfPph,
    eng3FF: recordingFdm.eng3FfPph,
    eng4FF: recordingFdm.eng4FfPph,
    fuelTotal: recordingFdm.fuelTotalGal,
    fuelTotalWeightLbs: recordingFdm.fuelTotalWeightLbs,
    fuelWeightPerGal: recordingFdm.fuelWeightPerGal,
    grossWeightLbs: recordingFdm.grossWeightLbs,
    cgPct: recordingFdm.cgPct,
    apMaster: recordingFdm.apMaster,
    apAltHold: recordingFdm.apAltHold,
    apHdgHold: recordingFdm.apHdgHold,
    apNavHold: recordingFdm.apNavHold,
    apApprHold: recordingFdm.apApprHold,
    apVsHold: recordingFdm.apVsHold,
    apFdActive: recordingFdm.apFdActive,
    apFlcHold: recordingFdm.apLvlChgHold ?? recordingFdm.apFlcHold ?? null,
    apSpeedHold: recordingFdm.apSpeedHold,
    apReliable: typeof autopilotReliability?.apReliable === 'boolean' ? autopilotReliability.apReliable : null,
    athrReliable: typeof autopilotReliability?.athrReliable === 'boolean' ? autopilotReliability.athrReliable : null,
    apReliabilityReason: autopilotReliability?.reason ?? null,
    athrActive: recordingFdm.athrActive,
    athrArmed: recordingFdm.athrArmed,
    apMachTarget: recordingFdm.apMachTarget,
    oat: recordingFdm.oatC,
    tat: recordingFdm.tatC,
    pressure: recordingFdm.pressureMb,
    seaLevelPressureMb: recordingFdm.seaLevelPressureMb,
    visibility: recordingFdm.visibilityM,
    precipRateMm: recordingFdm.precipRateMm,
    precipState: recordingFdm.precipState,
    inCloud: recordingFdm.inCloud,
    surfaceCondition: recordingFdm.surfaceCondition,
    densityAltFt: recordingFdm.densityAltFt,
    cabinAltFt: recordingFdm.cabinAltFt,
    cabinAltRateFpm: recordingFdm.cabinAltRateFpm,
    cabinDeltaPPsi: recordingFdm.cabinDeltaPPsi,
    cabinAltTargetFt: recordingFdm.cabinAltTargetFt,
    cabinDumpSwitch: recordingFdm.cabinDumpSwitch,
    nav1GsiRaw: recordingFdm.nav1GsiRaw,
    nav1CdiRaw: recordingFdm.nav1CdiRaw,
    nav1HasGlideSlope: recordingFdm.nav1HasGlideSlope,
    nav1HasLocalizer: recordingFdm.nav1HasLocalizer,
    nav1Signal: recordingFdm.nav1Signal,
    gsDeviation: frame.ilsGsDeviation,
    locDeviation: frame.ilsLocDeviation,
    surfaceRaw: frame.surface?.raw,
    surfaceName: frame.surface?.name,
    surfaceClass: frame.surface?.class,
    surfaceRunwayLike: frame.surface?.runwayLike,
    surfaceOnRunway: frame.surface?.onRunway,
    surfaceOnGround: frame.surface?.onGround,
    surfaceValid: frame.surface?.valid,
    simTimeZuluSec: frame.simTime?.zuluSec,
    simTimeLocalSec: frame.simTime?.localSec,
    simTimeZuluHms: frame.simTime?.zuluHms,
    simTimeLocalHms: frame.simTime?.localHms,
    simDateZulu: frame.simTime?.zuluDate,
    simDateLocal: frame.simTime?.localDate,
    simDatetimeUtc: frame.simTime?.zuluIso,
    simDatetimeLocal: frame.simTime?.localIso,
    simLocalYear: frame.simTime?.localYear,
    simLocalMonth: frame.simTime?.localMonth,
    simLocalDay: frame.simTime?.localDay,
    simLocalDayOfYear: frame.simTime?.localDayOfYear,
    simLocalDayOfWeek: frame.simTime?.localDayOfWeek,
    simTimezoneOffsetSec: frame.simTime?.timezoneOffsetSec,
    simAbsoluteTimeSec: frame.simTime?.absoluteSec,
    simTimeOfDay: frame.simTime?.timeOfDay,
    simZuluSunriseSec: frame.simTime?.zuluSunriseSec,
    simZuluSunsetSec: frame.simTime?.zuluSunsetSec,
    simDatetimeSource: frame.simTime?.source,
    simDatetimeValid: frame.simTime?.valid,
    aircraft: aircraftName,
    simVersion: frame.simconnect?.simVersion || null,
    aircraftProfileId: profileId,
    signalReliability,
    dataSource,
    assists: frame.assists,
    fdm: recordingFdm,
  };
}
