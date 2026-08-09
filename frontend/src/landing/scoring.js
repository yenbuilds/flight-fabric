// Severity ranks across the two grading axes the backend produces:
// - Touchdown VS grade ('PERFECT'..'VERY HARD' from backend/landing/landing.js)
// - Touchdown distance grade ('Outstanding'..'Dangerous' plus legacy labels)
const LANDING_GRADE_SEVERITY = Object.freeze({
  PERFECT: 0,
  BUTTER: 0,
  SMOOTH: 0,
  GOOD: 0,
  FIRM: 1,
  HARD: 2,
  'VERY HARD': 3,
  'RUNWAY EXCURSION': 3,
  SEVERE: 3,
  Outstanding: 0,
  OUTSTANDING: 0,
  Good: 0,
  Acceptable: 1,
  ACCEPTABLE: 1,
  Marginal: 1,
  MARGINAL: 1,
  'Long Landing': 2,
  'LONG LANDING': 2,
  Poor: 2,
  POOR: 2,
  Dangerous: 3,
  DANGEROUS: 3,
  'Short Landing': 3,
  'SHORT LANDING': 3,
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
const RETIRED_STABILITY_FAILURES = new Set(['spoilers_moved_after_gate']);
const INSUFFICIENT_STABILITY_FAILURES = new Set(['insufficient_data', 'no_gate_sample']);
const HARD_STABILITY_FAILURES = new Set([
  'gear_not_down_at_gate',
  'gear_changed_after_gate',
  'flaps_not_set_at_gate',
  'flaps_changed_after_gate',
]);
const DIRECT_STABILITY_METRICS = Object.freeze([
  'speed_ok',
  'vs_ok',
  'pitch_ok',
  'bank_ok',
  'lateral_offset_ok',
]);
const HARD_CONFIGURATION_METRICS = Object.freeze(['config_ok', 'gear_ok', 'flaps_ok']);
const STABILITY_VERDICT_LABELS = Object.freeze({
  stable: 'STABLE',
  marginal: 'MARGINAL',
  unstable: 'UNSTABLE',
  no_verdict: 'NO VERDICT',
});
const TOUCHDOWN_RATE_GRADE_LABELS = Object.freeze({
  PERFECT: 'Perfect',
  GOOD: 'Good',
  FIRM: 'Firm',
  HARD: 'Hard',
  'VERY HARD': 'Very hard',
});

export function formatTouchdownRateGrade(grade) {
  const normalized = typeof grade === 'string' ? grade.trim().toUpperCase() : '';
  return TOUCHDOWN_RATE_GRADE_LABELS[normalized] || null;
}

export function gradeSeverity(grade) {
  if (!grade) return -1;
  const normalized = String(grade).trim();
  return LANDING_GRADE_SEVERITY[normalized]
    ?? LANDING_GRADE_SEVERITY[normalized.toUpperCase()]
    ?? -1;
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

function normalizeStabilityGateFailures(value) {
  const failures = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('|')
      : [];
  return failures
    .map((failure) => String(failure || '').trim())
    .filter((failure) => failure && !RETIRED_STABILITY_FAILURES.has(failure));
}

export function normalizeStabilityVerdict(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return Object.prototype.hasOwnProperty.call(STABILITY_VERDICT_LABELS, normalized)
    ? normalized
    : null;
}

function finiteStabilityNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Resolve the durable four-state approach verdict. New recordings persist the
 * verdict directly. The fallback keeps legacy strict gate failures auditable
 * without presenting every soft/proxy miss as a safety-significant failure.
 */
export function resolveStabilityVerdict(ultimateStability) {
  if (!ultimateStability || typeof ultimateStability !== 'object') return 'no_verdict';

  const explicit = normalizeStabilityVerdict(
    ultimateStability.verdict ?? ultimateStability.stabilityVerdict,
  );
  if (explicit) return explicit;

  const gateFailures = normalizeStabilityGateFailures(ultimateStability.gateFailures);
  if (gateFailures.some((failure) => INSUFFICIENT_STABILITY_FAILURES.has(failure))) {
    return 'no_verdict';
  }

  const gateStable = normalizeBooleanLike(ultimateStability.gateStable);
  const score = finiteStabilityNumber(ultimateStability.score);
  const samples = finiteStabilityNumber(ultimateStability.samples);
  const breakdown = ultimateStability.breakdown && typeof ultimateStability.breakdown === 'object'
    ? ultimateStability.breakdown
    : null;
  const metricValues = breakdown
    ? Object.values(breakdown).map(finiteStabilityNumber).filter((value) => value !== null)
    : [];
  const hasUsableResult = gateStable !== null
    || gateFailures.length > 0
    || score !== null
    || metricValues.length > 0;
  if (!hasUsableResult || (samples !== null && samples <= 0 && score === null && metricValues.length === 0)) {
    return 'no_verdict';
  }

  if (gateFailures.some((failure) => HARD_STABILITY_FAILURES.has(failure))) return 'unstable';
  if (score !== null && score < 80) return 'unstable';
  if (breakdown && DIRECT_STABILITY_METRICS.some((key) => {
    const value = finiteStabilityNumber(breakdown[key]);
    return value !== null && value < 60;
  })) return 'unstable';
  if (breakdown && HARD_CONFIGURATION_METRICS.some((key) => {
    const value = finiteStabilityNumber(breakdown[key]);
    return value !== null && value < 80;
  })) return 'unstable';

  if (gateStable === true) return 'stable';
  const rawFailuresWereRecorded = Array.isArray(ultimateStability.gateFailures)
    || typeof ultimateStability.gateFailures === 'string';
  if (gateStable !== false && rawFailuresWereRecorded && gateFailures.length === 0) return 'stable';
  if (gateStable === false || gateFailures.length > 0) return 'marginal';
  return 'no_verdict';
}

export function stabilityVerdictLabel(value) {
  return STABILITY_VERDICT_LABELS[normalizeStabilityVerdict(value) || 'no_verdict'];
}

export function getStabilityGateAltitudeFt(ultimateStability) {
  const value = finiteStabilityNumber(ultimateStability?.scoringContext?.criteria?.gateRaFt);
  return value !== null && value > 0 ? Math.round(value) : 1000;
}

export function getStabilityPassPct(ultimateStability) {
  const value = finiteStabilityNumber(ultimateStability?.scoringContext?.criteria?.passPct);
  return value !== null && value >= 0 && value <= 100 ? Math.round(value) : 80;
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

function stabilitySeverity(verdict) {
  if (verdict === 'stable') return 0;
  if (verdict === 'marginal') return 1;
  if (verdict === 'unstable') return 3;
  return -1;
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

export function buildLandingVerdict(data = {}, {
  touchdownDistance = data?.touchdownDistance || null,
  ultimateStability = data?.ultimateStability || null,
} = {}) {
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

  const gateFailures = normalizeStabilityGateFailures(ultimateStability?.gateFailures);
  const explicitGateStable = normalizeBooleanLike(ultimateStability?.gateStable);
  const gateStable = explicitGateStable ?? (gateFailures.length > 0 ? false : null);
  const stabilityScore = ultimateStability?.score != null
    ? Number(ultimateStability.score)
    : NaN;
  const stabilityVerdict = resolveStabilityVerdict(ultimateStability);
  const stabilitySev = stabilitySeverity(stabilityVerdict);
  const bounce = normalizeBounceData(touchdownDistance);
  const bounceSev = bounceSeverity(bounce);
  const criticalTouchdown = runwayExcursion || shortLanding;
  const touchdownSev = Math.max(criticalTouchdown ? 3 : -1, gradeSeverity(touchdownDistance?.grade));
  const lateralSev = lateralSeverity(touchdownDistance?.lateralOffsetGrade);

  return {
    normalized: {
      ...data,
      touchdownTargetAchieved,
      tdzAchievedEffective,
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
      verdict: stabilityVerdict,
      severity: stabilitySev,
      tone: verdictToneForSeverity(stabilitySev),
      color: stabilityVerdict === 'stable'
        ? VERDICT_COLORS.good
        : stabilityVerdict === 'marginal'
          ? VERDICT_COLORS.warning
          : stabilityVerdict === 'unstable'
            ? VERDICT_COLORS.danger
            : VERDICT_COLORS.muted,
      textClass: textClassForSeverity(stabilitySev),
    },
  };
}

function hasExplicitBounceResult(touchdownDistance) {
  if (!touchdownDistance || typeof touchdownDistance !== 'object') return false;
  const rawCount = touchdownDistance.bounceCount;
  const hasCount = rawCount !== null
    && rawCount !== undefined
    && rawCount !== ''
    && Number.isFinite(Number(rawCount));
  const hasGrade = typeof touchdownDistance.bounceGrade === 'string'
    && touchdownDistance.bounceGrade.trim().length > 0;
  return hasCount || hasGrade;
}

/**
 * Build the concise, user-facing landing summary shared by app surfaces.
 *
 * The explicit touchdownGrade, gateVerdict, approachScore and bounce fields are
 * independent facts. This presentation intentionally does not synthesize an
 * overall landing grade or rewrite the backend-resolved touchdown-rate grade.
 */
export function buildLandingPresentation(data = {}, options = {}) {
  const nestedTouchdownDistance = options.touchdownDistance ?? data?.touchdownDistance ?? null;
  const hasTopLevelBounce = (
    data?.bounceCount !== null
    && data?.bounceCount !== undefined
    && data?.bounceCount !== ''
    && Number.isFinite(Number(data.bounceCount))
  ) || (typeof data?.bounceGrade === 'string' && data.bounceGrade.trim().length > 0);
  const touchdownDistance = hasTopLevelBounce
    ? {
        ...(nestedTouchdownDistance || {}),
        bounceCount: nestedTouchdownDistance?.bounceCount ?? data.bounceCount,
        bounceGrade: nestedTouchdownDistance?.bounceGrade ?? data.bounceGrade,
      }
    : nestedTouchdownDistance;
  const ultimateStability = options.ultimateStability ?? data?.ultimateStability ?? null;
  const verdict = buildLandingVerdict(data, {
    touchdownDistance,
    ultimateStability,
  });

  const stabilityScore = verdict.stability.score != null
    ? Math.round(verdict.stability.score)
    : null;
  const gateFailures = normalizeStabilityGateFailures(ultimateStability?.gateFailures);
  const stabilityVerdict = verdict.stability.verdict;
  const approachVerdict = ultimateStability ? stabilityVerdictLabel(stabilityVerdict) : null;
  // Compatibility alias for older consumers. This is now the four-state
  // presentation verdict, not a rewrite of the strict gateStable audit flag.
  const gateVerdict = approachVerdict;
  const approachText = approachVerdict;
  const approachScoreText = stabilityScore != null ? `Approach score ${stabilityScore}%` : null;
  const stabilityPassPct = getStabilityPassPct(ultimateStability);
  const stabilityGateAltitudeFt = getStabilityGateAltitudeFt(ultimateStability);
  const approachDetailParts = [];
  if (gateFailures.length > 0) {
    if (stabilityVerdict === 'marginal') {
      approachDetailParts.push(`${gateFailures.length} strict ${gateFailures.length === 1 ? 'check' : 'checks'} below ${stabilityPassPct}%`);
    } else if (stabilityVerdict === 'unstable') {
      approachDetailParts.push(`${gateFailures.length} substantial/required ${gateFailures.length === 1 ? 'finding' : 'findings'}`);
    } else if (stabilityVerdict === 'no_verdict') {
      approachDetailParts.push('Insufficient stability data');
    }
  }
  if (approachScoreText) approachDetailParts.push(approachScoreText);

  const bounceKnown = hasExplicitBounceResult(touchdownDistance);
  const bounceText = bounceKnown
    ? (verdict.bounce.bounceCount === 0 ? 'CLEAN' : `${verdict.bounce.bounceCount}x`)
    : null;
  const rawTouchdownGrade = typeof data?.grade === 'string' && data.grade.trim()
    ? data.grade.trim()
    : null;
  const touchdownGrade = rawTouchdownGrade ? rawTouchdownGrade.toUpperCase() : '--';
  const touchdownSeverity = gradeSeverity(rawTouchdownGrade);
  const touchdownColor = data?.color
    || verdictColorForSeverity(touchdownSeverity, VERDICT_COLORS.muted);
  const touchdownDetailParts = [];
  const distanceFt = Number(touchdownDistance?.distanceFt);
  const distanceText = touchdownDistance?.distanceFt != null && Number.isFinite(distanceFt)
    ? (Math.abs(distanceFt) <= 15000
        ? `${Math.round(distanceFt).toLocaleString()} ft`
        : 'Off Airport')
    : null;
  const distanceGrade = touchdownDistance?.grade || null;
  const distanceDetail = [distanceText, distanceGrade].filter(Boolean).join(' · ');
  if (distanceDetail) touchdownDetailParts.push(`TDZ: ${distanceDetail}`);
  if (verdict.flags.runwayExcursion) touchdownDetailParts.push('Runway excursion');

  const breakdownParts = [];
  if (rawTouchdownGrade) breakdownParts.push(`Touchdown rate grade: ${rawTouchdownGrade}`);
  if (distanceGrade) breakdownParts.push(`TDZ: ${distanceGrade}`);
  if (approachText) breakdownParts.push(`Approach: ${approachText}`);
  if (approachScoreText) breakdownParts.push(approachScoreText);
  if (bounceText) breakdownParts.push(`Bounce: ${bounceText}`);

  return {
    verdict,
    touchdownGrade,
    touchdownColor,
    touchdownSeverity,
    touchdownTone: verdictToneForSeverity(touchdownSeverity),
    touchdownTextClass: textClassForSeverity(touchdownSeverity),
    touchdownDetailParts,
    touchdownDetailText: touchdownDetailParts.join(' - ') || '--',
    gateVerdict,
    approachVerdict,
    stabilityVerdict,
    stabilityPassPct,
    stabilityGateAltitudeFt,
    stabilityGateLabel: `${stabilityGateAltitudeFt.toLocaleString()} ft`,
    stabilityScore,
    failedCheckCount: gateFailures.length,
    approachText,
    approachScoreText,
    approachDetailParts,
    approachDetailText: approachDetailParts.join(' · '),
    bounceKnown,
    bounceCount: verdict.bounce.bounceCount,
    bounceText,
    breakdownParts,
    breakdownText: breakdownParts.join(' - ') || '--',
  };
}

export function normalizeLandingData(data = {}) {
  return buildLandingVerdict(data).normalized;
}
