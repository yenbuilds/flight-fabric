// Severity ranks across the two grading axes the backend produces:
// - Touchdown VS grade ('PERFECT'..'VERY HARD' from backend/landing/landing.js)
// - Touchdown distance grade ('Outstanding'..'Dangerous' plus legacy labels)
const LANDING_GRADE_SEVERITY = Object.freeze({
  PERFECT: 0,
  BUTTER: 0,
  GOOD: 0,
  FIRM: 1,
  HARD: 2,
  'VERY HARD': 3,
  'RUNWAY EXCURSION': 3,
  SEVERE: 3,
  Outstanding: 0,
  Good: 0,
  Acceptable: 1,
  Marginal: 1,
  'Long Landing': 2,
  Poor: 2,
  Dangerous: 3,
  'Short Landing': 3,
});

const GRADE_COLOR_HEX = Object.freeze({
  3: '#ef4444',
  2: '#fb923c',
  1: '#f59e0b',
  0: '#10b981',
});

const VERDICT_COLORS = Object.freeze({
  good: '#00e070',
  warning: '#f59e0b',
  danger: '#ef4444',
  muted: '#888888',
});

const BOUNCE_GRADE_MIN_COUNTS = Object.freeze({
  'Single Bounce': 1,
  'Multiple Bounces': 2,
  'Repeated Bounces': 3,
  Porpoise: 4,
});

const LATERAL_GRADE_SEVERITY = Object.freeze({
  Perfect: 0,
  'On Centerline': 0,
  Good: 0,
  Marginal: 1,
  Poor: 1,
  Excursion: 3,
});

const TOUCHDOWN_ZONE_MAX_FT = 3000;
const TOUCHDOWN_TARGET_MAX_FT = 1000;

export function gradeSeverity(grade) {
  if (!grade) return -1;
  return LANDING_GRADE_SEVERITY[grade] ?? -1;
}

export function gradeHex(severity) {
  return GRADE_COLOR_HEX[severity] || '#9ca3af';
}

export function verdictColorForSeverity(severity, fallback = VERDICT_COLORS.muted) {
  if (severity >= 3) return VERDICT_COLORS.danger;
  if (severity >= 1) return VERDICT_COLORS.warning;
  if (severity === 0) return VERDICT_COLORS.good;
  return fallback;
}

export function verdictToneForSeverity(severity) {
  if (severity >= 3) return 'danger';
  if (severity >= 1) return 'warning';
  if (severity === 0) return 'good';
  return 'neutral';
}

export function textClassForSeverity(severity, {
  good = 'text-green-400',
  warning = 'text-amber-400',
  danger = 'text-red-400',
  neutral = 'text-gray-500',
  suffix = '',
} = {}) {
  const base = severity >= 3
    ? danger
    : severity >= 1
      ? warning
      : severity === 0
        ? good
        : neutral;
  return suffix ? `${base} ${suffix}` : base;
}

export function normalizeBooleanLike(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === 'no') return false;
  }
  return null;
}

export function inferBounceGradeFromCount(count) {
  if (count <= 0) return 'Clean';
  if (count === 1) return 'Single Bounce';
  if (count === 2) return 'Multiple Bounces';
  if (count === 3) return 'Repeated Bounces';
  return 'Porpoise';
}

export function normalizeBounceData(touchdownDistance = null) {
  if (!touchdownDistance || typeof touchdownDistance !== 'object') {
    return { bounceCount: 0, bounceGrade: null };
  }

  const rawCount = Number(touchdownDistance.bounceCount);
  let bounceCount = Number.isFinite(rawCount) ? Math.max(0, Math.round(rawCount)) : 0;
  let bounceGrade = typeof touchdownDistance.bounceGrade === 'string' && touchdownDistance.bounceGrade.trim()
    ? touchdownDistance.bounceGrade.trim()
    : null;

  if (bounceGrade && bounceGrade !== 'Clean') {
    bounceCount = Math.max(bounceCount, BOUNCE_GRADE_MIN_COUNTS[bounceGrade] || 0);
  } else if (bounceCount > 0) {
    bounceGrade = inferBounceGradeFromCount(bounceCount);
  }

  return { bounceCount, bounceGrade };
}

function scoreColor(score, high = 90, medium = 70, fallback = VERDICT_COLORS.muted) {
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) return fallback;
  if (numericScore >= high) return VERDICT_COLORS.good;
  if (numericScore >= medium) return VERDICT_COLORS.warning;
  return VERDICT_COLORS.danger;
}

function lateralSeverity(grade) {
  if (!grade) return -1;
  return LATERAL_GRADE_SEVERITY[grade] ?? -1;
}

function bounceSeverity(bounce) {
  if (!bounce?.bounceGrade && bounce?.bounceCount <= 0) return -1;
  if (bounce.bounceGrade === 'Clean') return 0;
  if (bounce.bounceGrade === 'Repeated Bounces' || bounce.bounceGrade === 'Porpoise' || bounce.bounceCount >= 3) return 3;
  if (bounce.bounceGrade || bounce.bounceCount > 0) return 1;
  return -1;
}

function stabilitySeverity(score, gateStable) {
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) return -1;
  if (gateStable === false) return 1;
  if (numericScore >= 80) return 0;
  if (numericScore >= 60) return 1;
  return 3;
}

export function isShortLanding(data = {}, touchdownDistance = null) {
  const tdz = touchdownDistance || data.touchdownDistance || null;
  return normalizeBooleanLike(data.shortLanding) === true
    || normalizeBooleanLike(tdz?.shortLanding) === true
    || tdz?.grade === 'Short Landing'
    || (Number.isFinite(Number(tdz?.distanceFt)) && Number(tdz.distanceFt) < 0);
}

export function isRunwayExcursion(data = {}) {
  return normalizeBooleanLike(data.runwayExcursion ?? data.runway_excursion) === true;
}

export function computeGrade(data = {}) {
  if (isRunwayExcursion(data)) {
    return {
      headlineGrade: 'RUNWAY EXCURSION',
      headlineSev: 3,
      headlineColor: gradeHex(3),
    };
  }

  const tdz = data.touchdownDistance || null;
  const vsGrade = data.grade || null;
  const rawTdzGrade = tdz && tdz.grade
    ? tdz.grade
    : null;
  const tdzGrade = isShortLanding(data, tdz) ? 'Short Landing' : rawTdzGrade;
  const vsSev = gradeSeverity(vsGrade);
  const tdzSev = gradeSeverity(tdzGrade);
  const computedSev = Math.max(vsSev, tdzSev);
  const computedGrade = tdzSev > vsSev ? tdzGrade : (vsGrade || tdzGrade);

  const explicitGrade = data.headlineGrade || null;
  const rawExplicitSeverity = data.headlineSev;
  const numericExplicitSeverity = Number(rawExplicitSeverity);
  const explicitSeverity = rawExplicitSeverity !== null
    && rawExplicitSeverity !== undefined
    && rawExplicitSeverity !== ''
    && Number.isFinite(numericExplicitSeverity)
    ? numericExplicitSeverity
    : null;
  const explicitColor = data.headlineColor || null;
  if (explicitGrade || explicitSeverity != null || explicitColor) {
    const headlineSev = explicitSeverity != null ? explicitSeverity : gradeSeverity(explicitGrade);
    if (computedSev > headlineSev) {
      return {
        headlineGrade: computedGrade,
        headlineSev: computedSev,
        headlineColor: gradeHex(computedSev),
      };
    }
    return {
      headlineGrade: explicitGrade,
      headlineSev,
      headlineColor: explicitColor || gradeHex(headlineSev),
    };
  }

  return {
    headlineGrade: computedGrade,
    headlineSev: computedSev,
    headlineColor: gradeHex(computedSev),
  };
}

export function buildLandingVerdict(data = {}, {
  touchdownDistance = data?.touchdownDistance || null,
  ultimateStability = data?.ultimateStability || null,
} = {}) {
  const grade = computeGrade({ ...data, touchdownDistance });
  const shortLanding = isShortLanding(data, touchdownDistance);
  const runwayExcursion = isRunwayExcursion(data);
  const explicitTdzAchieved = normalizeBooleanLike(touchdownDistance?.tdzAchieved);
  const touchdownDistanceFt = Number(touchdownDistance?.distanceFt);
  const hasTouchdownDistanceFt = touchdownDistance?.distanceFt != null && Number.isFinite(touchdownDistanceFt);
  // Keep the ideal first-1,000-ft target distinct from the formal 3,000-ft TDZ.
  // The backend's tdzAchieved field intentionally represents the latter.
  const touchdownTargetAchieved = touchdownDistance != null && !shortLanding
    && hasTouchdownDistanceFt
    && touchdownDistanceFt >= 0
    && touchdownDistanceFt <= TOUCHDOWN_TARGET_MAX_FT;
  const tdzAchievedEffective = touchdownDistance != null && !shortLanding && (
    explicitTdzAchieved != null
      ? explicitTdzAchieved
      : (hasTouchdownDistanceFt && touchdownDistanceFt >= 0 && touchdownDistanceFt <= TOUCHDOWN_ZONE_MAX_FT)
  );

  const gateStable = normalizeBooleanLike(ultimateStability?.gateStable);
  const stabilityScore = ultimateStability?.score != null
    ? Number(ultimateStability.score)
    : NaN;
  const stabilitySev = stabilitySeverity(stabilityScore, gateStable);
  const bounce = normalizeBounceData(touchdownDistance);
  const bounceSev = bounceSeverity(bounce);
  const criticalTouchdown = runwayExcursion || shortLanding;
  const touchdownSev = Math.max(criticalTouchdown ? 3 : -1, gradeSeverity(touchdownDistance?.grade));
  const lateralSev = lateralSeverity(touchdownDistance?.lateralOffsetGrade);

  return {
    normalized: {
      ...data,
      ...grade,
      touchdownTargetAchieved,
      tdzAchievedEffective,
    },
    headline: {
      grade: grade.headlineGrade,
      severity: grade.headlineSev,
      color: grade.headlineColor,
      tone: verdictToneForSeverity(grade.headlineSev),
      textClass: textClassForSeverity(grade.headlineSev),
    },
    flags: {
      runwayExcursion,
      shortLanding,
      touchdownTargetAchieved,
      tdzAchieved: tdzAchievedEffective,
      gateStable,
    },
    touchdown: {
      data: touchdownDistance,
      grade: touchdownDistance?.grade || null,
      severity: touchdownSev,
      tone: verdictToneForSeverity(touchdownSev),
      color: criticalTouchdown
        ? VERDICT_COLORS.danger
        : tdzAchievedEffective
        ? VERDICT_COLORS.good
        : (Number.isFinite(Number(touchdownDistance?.score))
          ? scoreColor(touchdownDistance.score)
          : verdictColorForSeverity(touchdownSev)),
      textClass: textClassForSeverity(touchdownSev),
    },
    lateral: {
      grade: touchdownDistance?.lateralOffsetGrade || null,
      severity: lateralSev,
      tone: verdictToneForSeverity(lateralSev),
      color: Number.isFinite(Number(touchdownDistance?.lateralOffsetScore))
        ? scoreColor(touchdownDistance.lateralOffsetScore)
        : verdictColorForSeverity(lateralSev),
      textClass: textClassForSeverity(lateralSev),
    },
    bounce: {
      ...bounce,
      severity: bounceSev,
      tone: verdictToneForSeverity(bounceSev),
      color: Number.isFinite(Number(touchdownDistance?.bounceScore))
        ? scoreColor(touchdownDistance.bounceScore)
        : verdictColorForSeverity(bounceSev),
      textClass: textClassForSeverity(bounceSev),
    },
    stability: {
      data: ultimateStability,
      score: Number.isFinite(stabilityScore) ? stabilityScore : null,
      gateStable,
      severity: stabilitySev,
      tone: verdictToneForSeverity(stabilitySev),
      color: Number.isFinite(stabilityScore)
        ? (gateStable === false ? VERDICT_COLORS.warning : scoreColor(stabilityScore, 80, 60))
        : VERDICT_COLORS.muted,
      textClass: textClassForSeverity(stabilitySev),
    },
  };
}

export function normalizeLandingData(data = {}) {
  return buildLandingVerdict(data).normalized;
}
