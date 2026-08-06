// Stability scoring is a game rule, not an aircraft certification model.
// Keep the policy surface deliberately small: transport-category aircraft use
// one common, versioned ruleset; category-A aircraft retain their lighter GA
// profile limits. Aircraft profiles still own telemetry decoding and landing
// configuration semantics.

type AnyRecord = Record<string, any>;

type StabilityPolicyResolution = {
  id: string;
  version: number;
  name: string;
  criteria: AnyRecord;
  profileCriteriaApplied: boolean;
};

const TRANSPORT_STABILITY_POLICY = Object.freeze({
  id: 'transport-v1',
  version: 1,
  name: 'Common transport rules',
});

const GA_STABILITY_POLICY = Object.freeze({
  id: 'ga-profile-v1',
  version: 1,
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
    schemaVersion: 2,
    criteriaSource,
    policy: {
      id: resolvedPolicy.id,
      version: resolvedPolicy.version,
      name: resolvedPolicy.name,
      profileCriteriaApplied: resolvedPolicy.profileCriteriaApplied,
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
