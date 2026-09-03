import { buildLandingPresentation, formatTouchdownRateGrade } from './scoring.js';

const GOOD_COLOR = '#00e070';
const WARNING_COLOR = '#f59e0b';
const DANGER_COLOR = '#ef4444';
const NOSE_DOWN_TOUCHDOWN_THRESHOLD_DEG = -1;

function buildReasonTag(text, color, index, tone = 'neutral') {
  return {
    key: `${index}:${text}`,
    text,
    color,
    tone,
    backgroundColor: `${color}22`,
    borderColor: `${color}44`,
  };
}

function addReason(reasons, text, color, tone = 'neutral') {
  reasons.push(buildReasonTag(text, color, reasons.length, tone));
}

function touchdownRateReason(presentation) {
  const label = formatTouchdownRateGrade(presentation?.touchdownGrade);
  if (!label) return null;

  const tone = presentation.touchdownTone;
  const color = tone === 'danger'
    ? DANGER_COLOR
    : tone === 'warning'
      ? WARNING_COLOR
      : GOOD_COLOR;
  return { text: `${label} touchdown rate`, color, tone };
}

export function buildDebriefReasons(data, {
  normalized = {},
  ultimateStability = null,
  touchdownDistance = null,
  limit = 6,
} = {}) {
  const reasons = [];
  if (!data || typeof data !== 'object') return reasons;

  const presentation = buildLandingPresentation(data, { touchdownDistance, ultimateStability });
  const verdict = presentation.verdict;
  const shortLanding = verdict.flags.shortLanding;
  const bounce = verdict.bounce;
  const touchdownReason = touchdownRateReason(presentation);
  if (touchdownReason) addReason(reasons, touchdownReason.text, touchdownReason.color, touchdownReason.tone);

  if (verdict.flags.runwayExcursion) addReason(reasons, 'Runway excursion', DANGER_COLOR, 'danger');
  const rolloutAssessment = String(data?.rolloutAnalysis?.assessment || '').toLowerCase();
  if (rolloutAssessment === 'critical') {
    addReason(reasons, 'Critical rollout-control event', DANGER_COLOR, 'danger');
  } else if (rolloutAssessment === 'warning') {
    addReason(reasons, 'Rollout-control warning', DANGER_COLOR, 'danger');
  } else if (rolloutAssessment === 'caution') {
    addReason(reasons, 'Rollout-control caution', WARNING_COLOR, 'warning');
  }
  if (shortLanding) addReason(reasons, 'Short of threshold', DANGER_COLOR, 'danger');
  if (data.pitchDeg != null && Number(data.pitchDeg) < NOSE_DOWN_TOUCHDOWN_THRESHOLD_DEG) {
    addReason(reasons, 'Nose-down touchdown', DANGER_COLOR, 'danger');
  }
  if (data.bankDeg != null && Math.abs(Number(data.bankDeg)) > 5) addReason(reasons, 'Bank at touchdown', WARNING_COLOR, 'warning');
  if (data.centerlineDev != null && Math.abs(Number(data.centerlineDev)) > 5) addReason(reasons, 'Runway heading misalignment', WARNING_COLOR, 'warning');

  if (touchdownDistance?.lateralOffsetGrade === 'Excursion') {
    addReason(reasons, 'Off runway edge', DANGER_COLOR, 'danger');
  } else if (touchdownDistance?.lateralOffsetGrade === 'Poor') {
    addReason(reasons, 'Near runway edge', WARNING_COLOR, 'warning');
  } else if (touchdownDistance?.lateralOffsetGrade === 'Perfect') {
    addReason(reasons, 'On centerline', GOOD_COLOR, 'good');
  }

  if (bounce.bounceCount > 0) {
    if (bounce.bounceGrade === 'Porpoise' || bounce.bounceCount >= 4) {
      addReason(reasons, `Porpoise (${bounce.bounceCount}x bounces)`, DANGER_COLOR, 'danger');
    } else if (bounce.bounceGrade === 'Repeated Bounces' || bounce.bounceCount === 3) {
      addReason(reasons, 'Repeated bounces', DANGER_COLOR, 'danger');
    } else if (bounce.bounceCount === 2) {
      addReason(reasons, 'Multiple bounces', WARNING_COLOR, 'warning');
    } else {
      addReason(reasons, 'Single bounce', WARNING_COLOR, 'warning');
    }
  } else if (bounce.bounceGrade === 'Clean') {
    addReason(reasons, 'Clean touchdown', GOOD_COLOR, 'good');
  }

  if (verdict.stability.verdict === 'unstable') {
    addReason(reasons, 'Unstable approach', DANGER_COLOR, 'danger');
  } else if (verdict.stability.verdict === 'marginal') {
    addReason(reasons, 'Marginal approach - soft/proxy miss', WARNING_COLOR, 'warning');
  } else if (verdict.stability.verdict === 'stable') {
    addReason(reasons, 'Stabilized approach', GOOD_COLOR, 'good');
  }
  if ((normalized.touchdownTargetAchieved ?? verdict.flags.touchdownTargetAchieved) && !shortLanding) {
    addReason(reasons, 'First 1,000 ft target', GOOD_COLOR, 'good');
  } else if ((normalized.tdzAchievedEffective ?? verdict.flags.tdzAchieved) && !shortLanding) {
    addReason(reasons, 'Inside formal 3,000 ft TDZ', GOOD_COLOR, 'good');
  }
  if (data.bankDeg != null && Math.abs(Number(data.bankDeg)) <= 3) addReason(reasons, 'Wings level', GOOD_COLOR, 'good');

  return reasons.slice(0, limit);
}

export function buildDebriefConfidence(data, ultimateStability, lastUltimateStability = null) {
  const reasons = [];
  let rank = 0; // 0 high, 1 medium, 2 low

  function lower(nextRank, reason) {
    rank = Math.max(rank, nextRank);
    if (reason) reasons.push(reason);
  }

  if (!ultimateStability || ultimateStability.score == null) {
    lower(1, 'No stability data');
  } else if (Number(lastUltimateStability?.samples ?? ultimateStability.samples) < 30) {
    lower(1, 'Limited samples');
  }

  if (!data?.touchdownDistance || data.touchdownDistance.distanceFt == null) {
    lower(rank === 0 ? 1 : 2, 'No touchdown position');
  }

  if (data?.touchdownDistance?.lateralOffsetSuspect === true) {
    lower(1, 'Runway geometry suspect');
  }

  if (data?.touchdownDistance?.runwayConditionConfident === false) {
    lower(1, 'Runway condition inferred');
  }

  if (rank >= 2) {
    return {
      confidenceText: 'Low',
      confidenceReason: reasons.join(', '),
      confidenceColor: DANGER_COLOR,
      confidenceToneClass: 'text-red-400',
    };
  }

  if (rank === 1) {
    return {
      confidenceText: 'Medium',
      confidenceReason: reasons.join(', '),
      confidenceColor: WARNING_COLOR,
      confidenceToneClass: 'text-amber-400',
    };
  }

  return {
    confidenceText: 'High',
    confidenceReason: '',
    confidenceColor: GOOD_COLOR,
    confidenceToneClass: 'text-green-400',
  };
}
