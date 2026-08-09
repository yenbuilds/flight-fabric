// Stability scoring is a game rule, not an aircraft certification model.
// Keep the policy surface deliberately small: transport-category aircraft use
// one common, versioned ruleset; category-A aircraft retain their lighter GA
// profile limits. Aircraft profiles still own telemetry decoding and landing
// configuration semantics.

type AnyRecord = Record<string, any>;

const {
  STABILITY_VERDICT_POLICY_ID,
  STABILITY_VERDICT_POLICY_VERSION,
  STABILITY_VERDICT_MIN_OVERALL_SCORE,
  STABILITY_VERDICT_SEVERE_METRIC_FLOOR_PCT,
} = require('./stability-runner.js') as {
  STABILITY_VERDICT_POLICY_ID: string;
  STABILITY_VERDICT_POLICY_VERSION: number;
  STABILITY_VERDICT_MIN_OVERALL_SCORE: number;
  STABILITY_VERDICT_SEVERE_METRIC_FLOOR_PCT: number;
};

type StabilityPolicyResolution = {
  id: string;
  version: number;
  name: string;
  criteria: AnyRecord;
  profileCriteriaApplied: boolean;
};

const TRANSPORT_STABILITY_POLICY = Object.freeze({
  id: 'transport-v2',
  version: 2,
  name: 'Common transport rules',
});

const GA_STABILITY_POLICY = Object.freeze({
  id: 'ga-profile-v2',
  version: 2,
  name: 'General aviation profile rules',
});

function normalizedProfileId(profile: AnyRecord | null | undefined): string {
  const id = typeof profile?.id === 'string' ? profile.id.trim() : '';
  return id || 'generic';
}

function isGeneralAviationProfile(profile: AnyRecord | null | undefined): boolean {
  return String(profile?.aircraft?.category || '').trim().toUpperCase() === 'A';
}

function resolveStabilityPolicy({
  profile,
  commonCriteria,
  profileCriteria,
}: {
  profile?: AnyRecord | null;
  commonCriteria?: AnyRecord | null;
  profileCriteria?: AnyRecord | null;
}): StabilityPolicyResolution {
  const common = commonCriteria && typeof commonCriteria === 'object' ? commonCriteria : {};
  if (isGeneralAviationProfile(profile) && profileCriteria && typeof profileCriteria === 'object') {
    return {
      ...GA_STABILITY_POLICY,
      criteria: { ...common, ...profileCriteria },
      profileCriteriaApplied: true,
    };
  }

  return {
    ...TRANSPORT_STABILITY_POLICY,
    criteria: { ...common },
    profileCriteriaApplied: false,
  };
}

function buildStabilityScoringContext({
  scoreResult,
  profile,
  glidepathAngle,
  policy,
  criteriaSource = 'recorded',
}: {
  scoreResult?: AnyRecord | null;
  profile?: AnyRecord | null;
  glidepathAngle?: AnyRecord | null;
  policy?: StabilityPolicyResolution | null;
  criteriaSource?: string;
}): AnyRecord {
  const profileId = normalizedProfileId(profile);
  const reliability = typeof profile?.signalReliability?.stabilityScore === 'string'
    ? profile.signalReliability.stabilityScore
    : (profileId === 'generic' ? 'generic' : 'profile');
  const resolvedPolicy = policy || resolveStabilityPolicy({
    profile,
    commonCriteria: scoreResult?.criteria,
  });

  return {
    schemaVersion: 3,
    criteriaSource,
    policy: {
      id: resolvedPolicy.id,
      version: resolvedPolicy.version,
      name: resolvedPolicy.name,
      profileCriteriaApplied: resolvedPolicy.profileCriteriaApplied,
    },
    verdictPolicy: {
      id: STABILITY_VERDICT_POLICY_ID,
      version: STABILITY_VERDICT_POLICY_VERSION,
      minimumOverallScore: STABILITY_VERDICT_MIN_OVERALL_SCORE,
      severeMetricFloorPct: STABILITY_VERDICT_SEVERE_METRIC_FLOOR_PCT,
    },
    profile: {
      id: profileId,
      name: typeof profile?.name === 'string' && profile.name.trim()
        ? profile.name.trim()
        : (profileId === 'generic' ? 'Generic Aircraft' : profileId),
      reliability,
    },
    criteria: scoreResult?.criteria || resolvedPolicy.criteria || null,
    reference: scoreResult?.reference || null,
    coverage: scoreResult?.coverage || null,
    glidepath: {
      angleDeg: Number.isFinite(scoreResult?.criteria?.glidepathAngleDeg)
        ? scoreResult.criteria.glidepathAngleDeg
        : null,
      source: typeof glidepathAngle?.source === 'string' ? glidepathAngle.source : null,
    },
  };
}

module.exports = {
  TRANSPORT_STABILITY_POLICY,
  GA_STABILITY_POLICY,
  resolveStabilityPolicy,
  buildStabilityScoringContext,
  isGeneralAviationProfile,
};

export {};
