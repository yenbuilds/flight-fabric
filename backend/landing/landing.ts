const profileLoader = require('../aircraft/aircraft-profile-loader.js') as {
  getActiveProfile: () => Record<string, any> | null;
  loadProfile: (profileId: unknown) => {
    id?: string;
    name?: string;
    _qualifiedId?: string;
    _profileKey?: string;
    aircraft?: {
      landing?: {
        grades?: LandingGradeThresholds | null;
      } | null;
    } | null;
  } | null;
};
type LandingGradeThresholds = {
  perfectMinFpm: number;
  goodMinFpm: number;
  firmMinFpm: number;
  hardMinFpm: number;
};

type LandingGrade = {
  grade: 'PERFECT' | 'GOOD' | 'FIRM' | 'HARD' | 'VERY HARD';
  color: 'lime' | 'deepskyblue' | 'gold' | 'orange' | 'red';
};

type LandingRateScoringContext = {
  schemaVersion: 1;
  criteriaSource: 'recorded';
  policy: { id: string; version: number; name: string };
  profile: { id: string; name: string; resolved: boolean };
  thresholds: LandingGradeThresholds;
};

const COMMON_TRANSPORT_GRADES: LandingGradeThresholds = Object.freeze({
  perfectMinFpm: -150,
  goodMinFpm: -300,
  firmMinFpm: -400,
  hardMinFpm: -600,
});

const LANDING_RATE_POLICY = Object.freeze({
  id: 'landing-rate-v2',
  version: 2,
  name: 'Common transport bands with light-aircraft profile overrides',
});

function isLightAircraftProfile(profile: Record<string, any> | null | undefined): boolean {
  return String(profile?.aircraft?.category || '').trim().toUpperCase() === 'A';
}

function resolveGradesForProfile(
  profile: Record<string, any> | null | undefined,
): LandingGradeThresholds {
  const profileGrades = profile?.aircraft?.landing?.grades;
  return isLightAircraftProfile(profile) && profileGrades
    ? profileGrades
    : COMMON_TRANSPORT_GRADES;
}

function normalizeProfileId(profileId: unknown): string | null {
  if (profileId === null || profileId === undefined || profileId === '') return null;
  if (typeof profileId === 'string') return profileId.trim() || null;
  if (typeof profileId === 'number' && Number.isFinite(profileId)) return String(profileId);
  return null;
}

function copyLandingGrades(grades: LandingGradeThresholds): LandingGradeThresholds {
  return {
    perfectMinFpm: grades.perfectMinFpm,
    goodMinFpm: grades.goodMinFpm,
    firmMinFpm: grades.firmMinFpm,
    hardMinFpm: grades.hardMinFpm,
  };
}

function resolveLandingRateRules(profileId: unknown): {
  grades: LandingGradeThresholds;
  profile: Record<string, any> | null;
  profileId: string;
  resolved: boolean;
} | null {
  const requestedProfileId = normalizeProfileId(profileId);
  const legacyOrGeneric = requestedProfileId === null;
  const lookupId = requestedProfileId || 'generic';

  try {
    const profile = profileLoader.loadProfile(lookupId);
    if (!profile && !legacyOrGeneric) return null;
    return {
      grades: resolveGradesForProfile(profile),
      profile,
      profileId: requestedProfileId || profile?.id || 'generic',
      resolved: Boolean(profile),
    };
  } catch (_error) {
    if (!legacyOrGeneric) return null;
    return {
      grades: COMMON_TRANSPORT_GRADES,
      profile: null,
      profileId: 'generic',
      resolved: false,
    };
  }
}

function gradeLandingWithGrades(
  vs: number,
  grades: LandingGradeThresholds = COMMON_TRANSPORT_GRADES,
): LandingGrade {
  if (!Number.isFinite(vs)) {
    return { grade: 'FIRM', color: 'gold' };
  }

  if (vs > grades.perfectMinFpm) return { grade: 'PERFECT', color: 'lime' };
  if (vs > grades.goodMinFpm) return { grade: 'GOOD', color: 'deepskyblue' };
  if (vs > grades.firmMinFpm) return { grade: 'FIRM', color: 'gold' };
  if (vs > grades.hardMinFpm) return { grade: 'HARD', color: 'orange' };
  return { grade: 'VERY HARD', color: 'red' };
}

function gradeLanding(vs: number): LandingGrade {
  return gradeLandingWithGrades(vs, resolveGradesForProfile(profileLoader.getActiveProfile()));
}

/**
 * Grade using the profile identity persisted with the recording. Recordings
 * predating profile identity use the historical generic default. An explicit
 * but no-longer-resolvable profile returns null so history callers can preserve
 * its persisted rate grade instead of silently substituting generic bands.
 */
function gradeLandingForRecordedProfile(vs: number, profileId: unknown): LandingGrade | null {
  const rules = resolveLandingRateRules(profileId);
  return rules ? gradeLandingWithGrades(vs, rules.grades) : null;
}

/**
 * Grade historical/replayed data without consulting or mutating the process-wide
 * active aircraft. Unknown or retired profile ids use the stable generic bands.
 */
function gradeLandingForProfile(vs: number, profileId: unknown): LandingGrade {
  return gradeLandingForRecordedProfile(vs, profileId)
    || gradeLandingWithGrades(vs, COMMON_TRANSPORT_GRADES);
}

/**
 * Persist the exact, compact rule snapshot needed to explain a landing grade
 * after bundled profile thresholds evolve. Replay displays the recorded grade
 * by default; this context is an audit trail, not an instruction to rescore it.
 */
function buildLandingRateScoringContext(profileId: unknown): LandingRateScoringContext {
  const rules = resolveLandingRateRules(profileId) || {
    grades: COMMON_TRANSPORT_GRADES,
    profile: null,
    profileId: normalizeProfileId(profileId) || 'generic',
    resolved: false,
  };
  const resolvedId = rules.profile?.id || rules.profileId;
  return {
    schemaVersion: 1,
    criteriaSource: 'recorded',
    policy: { ...LANDING_RATE_POLICY },
    profile: {
      id: resolvedId,
      name: rules.profile?.name || (resolvedId === 'generic' ? 'Generic Aircraft' : resolvedId),
      resolved: rules.resolved,
    },
    thresholds: copyLandingGrades(rules.grades),
  };
}

const landingApi = {
  COMMON_TRANSPORT_GRADES,
  LANDING_RATE_POLICY,
  buildLandingRateScoringContext,
  gradeLanding,
  gradeLandingForProfile,
  gradeLandingForRecordedProfile,
};

module.exports = landingApi;

export {};
