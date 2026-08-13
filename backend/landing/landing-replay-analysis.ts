'use strict';

type GenericRecord = Record<string, any>;

type LandingHeadline = {
  grade: string | null;
  vsFpm: number | null;
};

type LandingHeadlineOptions = {
  rescoreWithCurrentRules?: boolean;
};

type CombinedShallowBounceEvidence = {
  airborneDurationMs?: number | null;
  altitudeLiftFt?: number | null;
  maxUpwardVsFpm?: number | null;
  radioHeightLiftFt?: number | null;
  recontactVsFpm?: number | null;
};

type RecordedBounceEvidence = CombinedShallowBounceEvidence & {
  impactLoadG?: number | null;
};

type RecordedBounceAssessmentOptions = {
  minUpwardVsFpm?: number | null;
};

const RECORDED_BOUNCE_EVIDENCE_THRESHOLDS = Object.freeze({
  minAltitudeLiftFt: 1,
  minRadioHeightLiftFt: 2,
  minUpwardVsFpm: 50,
  minImpactLoadG: 1.20,
});

const SHALLOW_BOUNCE_EVIDENCE_THRESHOLDS = Object.freeze({
  minAirborneMs: 750,
  minRadioHeightLiftFt: 0.25,
  minAltitudeLiftFt: 0.5,
  minUpwardVsFpm: 25,
  minRecontactSinkFpm: 20,
  minSecondarySignals: 2,
});

const LEGACY_RUNWAY_EXCURSION_GRADE = 'RUNWAY EXCURSION';
const LANDING_RATE_CONTEXT_SCHEMA_VERSION = 1;
const RECORDED_LANDING_RATE_POLICIES = Object.freeze([
  Object.freeze({ id: 'landing-rate-v1', version: 1 }),
  Object.freeze({ id: 'landing-rate-v2', version: 2 }),
]);

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

function isLegacyRunwayExcursionGrade(value: unknown): boolean {
  return toNonEmptyString(value)?.toUpperCase() === LEGACY_RUNWAY_EXCURSION_GRADE;
}

function parseLandingRateContext(value: unknown): GenericRecord | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as GenericRecord;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as GenericRecord
      : null;
  } catch (_error) {
    return null;
  }
}

function hasRecordedLandingRateContext(row: GenericRecord | null | undefined): boolean {
  const context = parseLandingRateContext(row?.landing_rate_context ?? row?.landingRateContext);
  if (!context || context.schemaVersion !== LANDING_RATE_CONTEXT_SCHEMA_VERSION) return false;
  if (context.criteriaSource !== 'recorded') return false;
  if (toNonEmptyString(context.policy?.id) === null || !Number.isFinite(Number(context.policy?.version))) return false;
  if (toNonEmptyString(context.profile?.id) === null) return false;
  const thresholds = context.thresholds;
  if (!thresholds || typeof thresholds !== 'object') return false;
  const values = [
    thresholds.perfectMinFpm,
    thresholds.goodMinFpm,
    thresholds.firmMinFpm,
    thresholds.hardMinFpm,
  ].map(Number);
  return values.every(Number.isFinite)
    && values[0] > values[1]
    && values[1] > values[2]
    && values[2] > values[3];
}

function gradeLandingRateFromRecordedContext(
  vsFpm: number,
  row: GenericRecord | null | undefined,
): string | null {
  if (!hasRecordedLandingRateContext(row)) return null;
  const context = parseLandingRateContext(row?.landing_rate_context ?? row?.landingRateContext);
  const policyId = toNonEmptyString(context?.policy?.id);
  const policyVersion = Number(context?.policy?.version);
  const recognizedPolicy = RECORDED_LANDING_RATE_POLICIES.some(
    (policy) => policy.id === policyId && policy.version === policyVersion,
  );
  if (!recognizedPolicy) {
    return null;
  }
  const thresholds = context.thresholds as GenericRecord;
  // Keep the boundary semantics identical to the live grader: a value exactly
  // on a threshold belongs to the next band down.
  if (vsFpm > Number(thresholds.perfectMinFpm)) return 'PERFECT';
  if (vsFpm > Number(thresholds.goodMinFpm)) return 'GOOD';
  if (vsFpm > Number(thresholds.firmMinFpm)) return 'FIRM';
  if (vsFpm > Number(thresholds.hardMinFpm)) return 'HARD';
  return 'VERY HARD';
}

/**
 * Resolve the landing-rate headline for both detailed CSV replay and the
 * history/logbook index. Conventional recorded V/S is authoritative and
 * simulator touchdown normal velocity is deliberately diagnostic-only. A
 * persisted grade becomes an immutable snapshot once the row also contains the
 * exact landing-rate policy/profile/threshold context. Older rows without that
 * audit context remain legacy reconstruction inputs. Callers may explicitly ask
 * for a non-destructive current-rules rescore.
 */
function resolveLandingRateHeadline(
  row: GenericRecord | null | undefined,
  gradeFromVs: (vsFpm: number) => string | null,
  fallback: GenericRecord | null = null,
  options: LandingHeadlineOptions = {},
): LandingHeadline {
  const persistedVsFpm = toFiniteNumber(row?.vs_fpm);
  const fallbackVsFpm = toFiniteNumber(fallback?.vs_fpm ?? fallback?.vsFpm);
  const resolvedVsFpm = persistedVsFpm ?? fallbackVsFpm;
  const persistedGrade = isLegacyRunwayExcursionGrade(row?.grade)
    ? null
    : toNonEmptyString(row?.grade);
  const fallbackGrade = isLegacyRunwayExcursionGrade(fallback?.grade)
    ? null
    : toNonEmptyString(fallback?.grade);

  if (resolvedVsFpm !== null) {
    const recomputedGrade = gradeFromVs(resolvedVsFpm);
    const matchingRecordedGrade = persistedVsFpm !== null
      ? persistedGrade
      : fallbackGrade;
    const contextBackedGrade = persistedVsFpm !== null
      ? gradeLandingRateFromRecordedContext(resolvedVsFpm, row)
      : null;
    const hasRecordedContext = persistedVsFpm !== null
      && hasRecordedLandingRateContext(row);
    return {
      vsFpm: resolvedVsFpm,
      grade: options.rescoreWithCurrentRules === true || !hasRecordedContext
        ? (recomputedGrade ?? matchingRecordedGrade ?? persistedGrade)
        : (matchingRecordedGrade ?? contextBackedGrade ?? recomputedGrade ?? persistedGrade),
    };
  }

  return {
    vsFpm: null,
    grade: persistedGrade ?? fallbackGrade,
  };
}

/**
 * Shared weak-evidence gate for a sustained shallow hop. Hard bounce evidence
 * remains the responsibility of the live/replay detector; this only covers
 * the narrow sampled case which previously appeared as WOW chatter.
 */
function assessCombinedShallowBounceEvidence(
  evidence: CombinedShallowBounceEvidence,
): {
  confirmed: boolean;
  airborneDurationMs: number;
  hasWeakRadioHeightLift: boolean;
  secondarySignalCount: number;
} {
  const airborneDurationMs = Math.max(0, toFiniteNumber(evidence.airborneDurationMs) ?? 0);
  const radioHeightLiftFt = toFiniteNumber(evidence.radioHeightLiftFt);
  const altitudeLiftFt = toFiniteNumber(evidence.altitudeLiftFt);
  const maxUpwardVsFpm = toFiniteNumber(evidence.maxUpwardVsFpm);
  const recontactVsFpm = toFiniteNumber(evidence.recontactVsFpm);
  const hasWeakRadioHeightLift = radioHeightLiftFt !== null
    && radioHeightLiftFt >= SHALLOW_BOUNCE_EVIDENCE_THRESHOLDS.minRadioHeightLiftFt;
  const secondarySignalCount = [
    altitudeLiftFt !== null
      && altitudeLiftFt >= SHALLOW_BOUNCE_EVIDENCE_THRESHOLDS.minAltitudeLiftFt,
    maxUpwardVsFpm !== null
      && maxUpwardVsFpm >= SHALLOW_BOUNCE_EVIDENCE_THRESHOLDS.minUpwardVsFpm,
    recontactVsFpm !== null
      && recontactVsFpm <= -SHALLOW_BOUNCE_EVIDENCE_THRESHOLDS.minRecontactSinkFpm,
  ].filter(Boolean).length;

  return {
    confirmed: (
      airborneDurationMs >= SHALLOW_BOUNCE_EVIDENCE_THRESHOLDS.minAirborneMs
      && hasWeakRadioHeightLift
      && secondarySignalCount >= SHALLOW_BOUNCE_EVIDENCE_THRESHOLDS.minSecondarySignals
    ),
    airborneDurationMs,
    hasWeakRadioHeightLift,
    secondarySignalCount,
  };
}

/**
 * Full shared confirmation rule for a recorded WOW-off/WOW-on segment. Radio
 * height is runway-relative and authoritative when present; geometric lift and
 * upward V/S remain hard fallbacks only when radio height is unavailable.
 */
function assessRecordedBounceEvidence(
  evidence: RecordedBounceEvidence,
  gradeFromVs: (vsFpm: number) => string | null,
  options: RecordedBounceAssessmentOptions = {},
): {
  confirmed: boolean;
  airborneDurationMs: number;
  altitudeLiftFt: number | null;
  radioHeightLiftFt: number | null;
  radioHeightAuthoritative: boolean;
  hasPhysicalLift: boolean;
  hasPositiveMotion: boolean;
  hasMeaningfulImpact: boolean;
  hasWeakRadioHeightLift: boolean;
  hasCombinedShallowEvidence: boolean;
  impactGrade: string | null;
  shallowSecondarySignals: number;
} {
  const altitudeLiftFt = toFiniteNumber(evidence.altitudeLiftFt);
  const radioHeightLiftFt = toFiniteNumber(evidence.radioHeightLiftFt);
  const maxUpwardVsFpm = toFiniteNumber(evidence.maxUpwardVsFpm);
  const recontactVsFpm = toFiniteNumber(evidence.recontactVsFpm);
  const impactLoadG = toFiniteNumber(evidence.impactLoadG);
  const minUpwardVsFpm = Math.max(
    RECORDED_BOUNCE_EVIDENCE_THRESHOLDS.minUpwardVsFpm,
    toFiniteNumber(options.minUpwardVsFpm) ?? RECORDED_BOUNCE_EVIDENCE_THRESHOLDS.minUpwardVsFpm,
  );
  const radioHeightAuthoritative = radioHeightLiftFt !== null;
  const hasPhysicalLift = radioHeightAuthoritative
    ? radioHeightLiftFt >= RECORDED_BOUNCE_EVIDENCE_THRESHOLDS.minRadioHeightLiftFt
    : altitudeLiftFt !== null
      && altitudeLiftFt >= RECORDED_BOUNCE_EVIDENCE_THRESHOLDS.minAltitudeLiftFt;
  const hasPositiveMotion = !radioHeightAuthoritative
    && maxUpwardVsFpm !== null
    && maxUpwardVsFpm >= minUpwardVsFpm;
  const impactGrade = recontactVsFpm === null ? null : gradeFromVs(recontactVsFpm);
  const hasMeaningfulImpact = (
    impactGrade !== null && impactGrade.trim().toUpperCase() !== 'PERFECT'
  ) || (
    impactLoadG !== null
    && impactLoadG > 0
    && impactLoadG <= 10
    && impactLoadG >= RECORDED_BOUNCE_EVIDENCE_THRESHOLDS.minImpactLoadG
  );
  const shallowEvidence = assessCombinedShallowBounceEvidence(evidence);

  return {
    confirmed: hasPhysicalLift
      || hasPositiveMotion
      || hasMeaningfulImpact
      || shallowEvidence.confirmed,
    airborneDurationMs: shallowEvidence.airborneDurationMs,
    altitudeLiftFt,
    radioHeightLiftFt,
    radioHeightAuthoritative,
    hasPhysicalLift,
    hasPositiveMotion,
    hasMeaningfulImpact,
    hasWeakRadioHeightLift: shallowEvidence.hasWeakRadioHeightLift,
    hasCombinedShallowEvidence: shallowEvidence.confirmed,
    impactGrade,
    shallowSecondarySignals: shallowEvidence.secondarySignalCount,
  };
}

module.exports = {
  LANDING_RATE_CONTEXT_SCHEMA_VERSION,
  RECORDED_BOUNCE_EVIDENCE_THRESHOLDS,
  SHALLOW_BOUNCE_EVIDENCE_THRESHOLDS,
  assessCombinedShallowBounceEvidence,
  assessRecordedBounceEvidence,
  isLegacyRunwayExcursionGrade,
  hasRecordedLandingRateContext,
  gradeLandingRateFromRecordedContext,
  parseLandingRateContext,
  resolveLandingRateHeadline,
};

export {};
