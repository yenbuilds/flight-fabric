import type { PhaseMap, PhaseValue } from '../../shared/flight-phases';

'use strict';

type IcaoCategory = 'A' | 'B' | 'C' | 'D' | 'E';

type ThresholdKey =
  | 'taxi_max_kts'
  | 'parked_max_kts'
  | 'takeoff_roll_min_ias_kts'
  | 'takeoff_min_ias_kts'
  | 'takeoff_min_vs_fpm'
  | 'takeoff_max_ra_ft'
  | 'climb_min_vs_fpm'
  | 'climb_min_ra_ft'
  | 'cruise_min_ra_ft'
  | 'cruise_min_msl_ft'
  | 'cruise_max_vs_abs_fpm'
  | 'descent_min_ra_ft'
  | 'descent_min_vs_fpm'
  | 'approach_max_ra_ft'
  | 'approach_min_vs_fpm'
  | 'landing_max_ra_ft'
  | 'landing_min_vs_fpm'
  | 'taxi_in_max_kts'
  | 'max_approach_kts';

type ProfileThresholdKey =
  | 'taxiMaxKts'
  | 'parkedMaxKts'
  | 'takeoffRollMinIasKts'
  | 'takeoffMinIasKts'
  | 'takeoffMinVsFpm'
  | 'takeoffMaxRaFt'
  | 'climbMinVsFpm'
  | 'climbMinRaFt'
  | 'cruiseMinRaFt'
  | 'cruiseMinMslFt'
  | 'cruiseMaxVsAbsFpm'
  | 'descentMinRaFt'
  | 'descentMinVsFpm'
  | 'approachMaxRaFt'
  | 'approachMinVsFpm'
  | 'maxApproachKts'
  | 'landingMaxRaFt'
  | 'landingMinVsFpm'
  | 'taxiInMaxKts';

type PhaseThresholds = {
  taxi_max_kts: number;
  parked_max_kts: number;
  takeoff_roll_min_ias_kts: number;
  takeoff_min_ias_kts: number;
  takeoff_min_vs_fpm: number;
  takeoff_max_ra_ft: number;
  climb_min_vs_fpm: number;
  climb_min_ra_ft: number;
  cruise_min_ra_ft: number;
  cruise_min_msl_ft?: number;
  cruise_max_vs_abs_fpm: number;
  descent_min_ra_ft: number;
  descent_min_vs_fpm: number;
  approach_max_ra_ft: number;
  approach_min_vs_fpm: number;
  landing_max_ra_ft: number;
  landing_min_vs_fpm: number;
  taxi_in_max_kts: number;
  max_approach_kts: number;
};

type DetectFlightPhaseInput = {
  ias?: unknown;
  gs?: unknown;
  wow?: unknown;
  vs?: unknown;
  ra?: unknown;
  altMsl?: unknown;
};

type ConfigModule = {
  phase: {
    levelBandFpm: number;
  };
  phaseThresholds: Partial<Record<ProfileThresholdKey, number>>;
};

type ProfileLoaderModule = {
  getAircraftCategory?: () => unknown;
  getPhaseConfig: () => Record<string, unknown> | null;
};

const config = require('../core/config') as ConfigModule;
const profileLoader = require('../aircraft/aircraft-profile-loader') as ProfileLoaderModule;
const { PHASES } = require('./phases') as { PHASES: PhaseMap };

const ICAO_CATEGORY_THRESHOLDS: Record<IcaoCategory, PhaseThresholds> = {
  A: {
    taxi_max_kts: 40,
    parked_max_kts: 2,
    takeoff_roll_min_ias_kts: 30,
    takeoff_min_ias_kts: 50,
    takeoff_min_vs_fpm: 400,
    takeoff_max_ra_ft: 150,
    climb_min_vs_fpm: 500,
    climb_min_ra_ft: 150,
    cruise_min_ra_ft: 3000,
    cruise_max_vs_abs_fpm: 600,
    descent_min_ra_ft: 1000,
    descent_min_vs_fpm: 300,
    approach_max_ra_ft: 800,
    approach_min_vs_fpm: 150,
    landing_max_ra_ft: 30,
    landing_min_vs_fpm: 50,
    taxi_in_max_kts: 35,
    max_approach_kts: 90,
  },
  B: {
    taxi_max_kts: 50,
    parked_max_kts: 2,
    takeoff_roll_min_ias_kts: 45,
    takeoff_min_ias_kts: 80,
    takeoff_min_vs_fpm: 500,
    takeoff_max_ra_ft: 180,
    climb_min_vs_fpm: 600,
    climb_min_ra_ft: 180,
    cruise_min_ra_ft: 4000,
    cruise_max_vs_abs_fpm: 700,
    descent_min_ra_ft: 1200,
    descent_min_vs_fpm: 400,
    approach_max_ra_ft: 900,
    approach_min_vs_fpm: 180,
    landing_max_ra_ft: 40,
    landing_min_vs_fpm: 80,
    taxi_in_max_kts: 45,
    max_approach_kts: 120,
  },
  C: {
    taxi_max_kts: 80,
    parked_max_kts: 2,
    takeoff_roll_min_ias_kts: 60,
    takeoff_min_ias_kts: 120,
    takeoff_min_vs_fpm: 600,
    takeoff_max_ra_ft: 200,
    climb_min_vs_fpm: 700,
    climb_min_ra_ft: 200,
    cruise_min_ra_ft: 5000,
    cruise_max_vs_abs_fpm: 800,
    descent_min_ra_ft: 1500,
    descent_min_vs_fpm: 450,
    approach_max_ra_ft: 1000,
    approach_min_vs_fpm: 200,
    landing_max_ra_ft: 50,
    landing_min_vs_fpm: 100,
    taxi_in_max_kts: 60,
    max_approach_kts: 140,
  },
  D: {
    taxi_max_kts: 80,
    parked_max_kts: 2,
    takeoff_roll_min_ias_kts: 70,
    takeoff_min_ias_kts: 140,
    takeoff_min_vs_fpm: 700,
    takeoff_max_ra_ft: 250,
    climb_min_vs_fpm: 800,
    climb_min_ra_ft: 250,
    cruise_min_ra_ft: 5000,
    cruise_max_vs_abs_fpm: 800,
    descent_min_ra_ft: 1500,
    descent_min_vs_fpm: 500,
    approach_max_ra_ft: 1200,
    approach_min_vs_fpm: 250,
    landing_max_ra_ft: 60,
    landing_min_vs_fpm: 120,
    taxi_in_max_kts: 60,
    max_approach_kts: 165,
  },
  E: {
    taxi_max_kts: 80,
    parked_max_kts: 2,
    takeoff_roll_min_ias_kts: 80,
    takeoff_min_ias_kts: 160,
    takeoff_min_vs_fpm: 800,
    takeoff_max_ra_ft: 300,
    climb_min_vs_fpm: 900,
    climb_min_ra_ft: 300,
    cruise_min_ra_ft: 5000,
    cruise_max_vs_abs_fpm: 900,
    descent_min_ra_ft: 2000,
    descent_min_vs_fpm: 600,
    approach_max_ra_ft: 1500,
    approach_min_vs_fpm: 300,
    landing_max_ra_ft: 70,
    landing_min_vs_fpm: 150,
    taxi_in_max_kts: 60,
    max_approach_kts: 210,
  },
};

const PROFILE_KEY_MAP: Record<ProfileThresholdKey, ThresholdKey> = {
  taxiMaxKts: 'taxi_max_kts',
  parkedMaxKts: 'parked_max_kts',
  takeoffRollMinIasKts: 'takeoff_roll_min_ias_kts',
  takeoffMinIasKts: 'takeoff_min_ias_kts',
  takeoffMinVsFpm: 'takeoff_min_vs_fpm',
  takeoffMaxRaFt: 'takeoff_max_ra_ft',
  climbMinVsFpm: 'climb_min_vs_fpm',
  climbMinRaFt: 'climb_min_ra_ft',
  cruiseMinRaFt: 'cruise_min_ra_ft',
  cruiseMinMslFt: 'cruise_min_msl_ft',
  cruiseMaxVsAbsFpm: 'cruise_max_vs_abs_fpm',
  descentMinRaFt: 'descent_min_ra_ft',
  descentMinVsFpm: 'descent_min_vs_fpm',
  approachMaxRaFt: 'approach_max_ra_ft',
  approachMinVsFpm: 'approach_min_vs_fpm',
  maxApproachKts: 'max_approach_kts',
  landingMaxRaFt: 'landing_max_ra_ft',
  landingMinVsFpm: 'landing_min_vs_fpm',
  taxiInMaxKts: 'taxi_in_max_kts',
};

const NON_NEGATIVE_THRESHOLD_KEYS: readonly ThresholdKey[] = [
  'taxi_max_kts',
  'parked_max_kts',
  'takeoff_roll_min_ias_kts',
  'takeoff_min_ias_kts',
  'takeoff_min_vs_fpm',
  'takeoff_max_ra_ft',
  'climb_min_vs_fpm',
  'climb_min_ra_ft',
  'cruise_min_ra_ft',
  'cruise_min_msl_ft',
  'cruise_max_vs_abs_fpm',
  'descent_min_ra_ft',
  'descent_min_vs_fpm',
  'approach_max_ra_ft',
  'approach_min_vs_fpm',
  'max_approach_kts',
  'landing_max_ra_ft',
  'landing_min_vs_fpm',
  'taxi_in_max_kts',
];

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeCategory(value: unknown): IcaoCategory {
  const category = typeof value === 'string' ? value.trim().toUpperCase() : '';
  switch (category) {
    case 'A':
    case 'B':
    case 'C':
    case 'D':
    case 'E':
      return category;
    default:
      return 'C';
  }
}

function applyThresholdOverrides(
  thresholds: PhaseThresholds,
  overrides: Record<string, unknown> | null | undefined,
): void {
  if (!overrides) {
    return;
  }

  for (const [profileKey, internalKey] of Object.entries(PROFILE_KEY_MAP)) {
    const value = overrides[profileKey];
    if (typeof value === 'number' && Number.isFinite(value)) {
      thresholds[internalKey] = value;
    }
  }
}

function clampThresholdsNonNegative(thresholds: PhaseThresholds): void {
  for (const key of NON_NEGATIVE_THRESHOLD_KEYS) {
    const value = thresholds[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      thresholds[key] = Math.max(0, value);
    }
  }
}

function getPhaseThresholds(): PhaseThresholds {
  const category = normalizeCategory(profileLoader.getAircraftCategory?.());
  const thresholds: PhaseThresholds = { ...ICAO_CATEGORY_THRESHOLDS[category] };

  applyThresholdOverrides(thresholds, profileLoader.getPhaseConfig());

  return thresholds;
}

function getEffectivePhaseThresholds(): PhaseThresholds {
  const thresholds = getPhaseThresholds();
  applyThresholdOverrides(
    thresholds,
    config.phaseThresholds as Record<string, unknown>,
  );
  clampThresholdsNonNegative(thresholds);
  return thresholds;
}

function getCategoryThresholds(category: unknown): PhaseThresholds {
  return ICAO_CATEGORY_THRESHOLDS[normalizeCategory(category)];
}

function detectFlightPhase({
  ias,
  gs,
  wow,
  vs,
  ra,
  altMsl,
}: DetectFlightPhaseInput): PhaseValue {
  const thresholds = getEffectivePhaseThresholds();

  const vsValue = toFiniteNumber(vs);
  const raValue = toFiniteNumber(ra);
  if (vsValue === null || raValue === null) {
    return PHASES.UNKNOWN;
  }

  const altMslFt = toFiniteNumber(altMsl);
  const cruiseMslFt = typeof thresholds.cruise_min_msl_ft === 'number'
    && Number.isFinite(thresholds.cruise_min_msl_ft)
    ? thresholds.cruise_min_msl_ft
    : 10000;

  const cruiseMaxVsAbsFpm = Number.isFinite(thresholds.cruise_max_vs_abs_fpm)
    ? thresholds.cruise_max_vs_abs_fpm
    : 300;
  const levelBandEnv = config.phase.levelBandFpm;
  const levelBandFpm = Number.isFinite(levelBandEnv)
    ? Math.max(0, levelBandEnv)
    : Math.max(250, cruiseMaxVsAbsFpm);

  const climbGateFpm = Math.max(thresholds.climb_min_vs_fpm ?? 0, levelBandFpm);
  const descentGateFpm = Math.max(thresholds.descent_min_vs_fpm ?? 0, levelBandFpm);

  const iasRaw = toFiniteNumber(ias);
  const iasSpeed = iasRaw !== null && iasRaw >= 0 ? iasRaw : 0;
  const gsValue = toFiniteNumber(gs);
  const hasGroundSpeed = gsValue !== null && gsValue >= 0;
  const groundSpeed = hasGroundSpeed ? gsValue : 0;
  const wowOnGround = Boolean(wow);
  const airborneSpeed = hasGroundSpeed ? groundSpeed : iasSpeed;
  const speed = wowOnGround
    ? groundSpeed
    : airborneSpeed;

  if (!wowOnGround && speed < thresholds.parked_max_kts && raValue <= 5 && Math.abs(vsValue) <= 50) {
    return PHASES.PARKED;
  }

  if (wowOnGround) {
    if (groundSpeed < thresholds.parked_max_kts) {
      return PHASES.PARKED;
    }

    if (
      groundSpeed >= thresholds.taxi_in_max_kts
      && raValue <= thresholds.landing_max_ra_ft
    ) {
      return PHASES.LANDING;
    }

    const isTakeoffRoll = iasSpeed >= (thresholds.takeoff_roll_min_ias_kts ?? 0);
    if (
      !isTakeoffRoll
      && groundSpeed < thresholds.taxi_in_max_kts
      && raValue < thresholds.landing_max_ra_ft
    ) {
      return PHASES.TAXI_IN;
    }

    if (groundSpeed < thresholds.taxi_max_kts) {
      return PHASES.TAXI;
    }

    return PHASES.TAXI;
  }

  if (raValue <= thresholds.landing_max_ra_ft && Math.abs(vsValue) <= levelBandFpm) {
    return speed < thresholds.parked_max_kts ? PHASES.PARKED : PHASES.UNKNOWN;
  }

  if (
    hasGroundSpeed
    && groundSpeed < thresholds.parked_max_kts
    && raValue <= thresholds.takeoff_max_ra_ft
  ) {
    return PHASES.UNKNOWN;
  }

  const isCruiseAltitude = altMslFt !== null
    ? altMslFt >= cruiseMslFt
    : raValue > thresholds.cruise_min_ra_ft;
  if (isCruiseAltitude && Math.abs(vsValue) <= levelBandFpm) {
    return PHASES.CRUISE;
  }

  if (
    iasSpeed > thresholds.takeoff_min_ias_kts
    && (!hasGroundSpeed || groundSpeed >= thresholds.parked_max_kts)
    && vsValue > thresholds.takeoff_min_vs_fpm
    && raValue < thresholds.takeoff_max_ra_ft
  ) {
    return PHASES.TAKEOFF;
  }

  // Radio altitude is the authoritative signal for final approach. Check it
  // before the broad MSL-based climb/descent branches so high-elevation
  // airports do not remain classified as DESCENT all the way to touchdown.
  if (raValue < thresholds.approach_max_ra_ft && vsValue < -thresholds.approach_min_vs_fpm) {
    return PHASES.APPROACH;
  }

  const isHighAltitude = altMslFt !== null
    ? altMslFt > 3000
    : raValue > thresholds.climb_min_ra_ft;
  if (vsValue > climbGateFpm && isHighAltitude) {
    return PHASES.CLIMB;
  }
  if (vsValue < -descentGateFpm && isHighAltitude) {
    return PHASES.DESCENT;
  }

  const isBelowCruise = altMslFt !== null
    ? altMslFt < cruiseMslFt
    : raValue <= thresholds.cruise_min_ra_ft;

  if (isBelowCruise) {
    if (vsValue > thresholds.climb_min_vs_fpm) {
      return PHASES.CLIMB;
    }
    if (vsValue < -thresholds.descent_min_vs_fpm) {
      return PHASES.DESCENT;
    }
    if (Math.abs(vsValue) <= levelBandFpm) {
      return PHASES.UNKNOWN;
    }
    if (vsValue > 0) {
      return PHASES.CLIMB;
    }
    if (vsValue < 0) {
      return PHASES.DESCENT;
    }
    return PHASES.UNKNOWN;
  }

  if (Math.abs(vsValue) < Math.max(500, thresholds.cruise_max_vs_abs_fpm)) {
    return PHASES.CRUISE;
  }
  if (vsValue > thresholds.climb_min_vs_fpm) {
    return PHASES.CLIMB;
  }
  if (vsValue < -thresholds.descent_min_vs_fpm) {
    return PHASES.DESCENT;
  }

  return PHASES.CRUISE;
}

module.exports = {
  detectFlightPhase,
  getCategoryThresholds,
  getEffectivePhaseThresholds,
  ICAO_CATEGORY_THRESHOLDS,
};

export {};
