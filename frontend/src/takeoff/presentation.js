// Takeoff card presentation: turns the backend `takeoff` message into the
// texts and tone classes the Takeoff panel and the Overview summary render.
// Pure, so the store, the share model and the tests read one contract.
import { buildLandingWindPresentation } from '../landing/wind.js';

const DEFAULT_GRADE_COLOR = '#4a5e74';
const GOOD_COLOR = '#00e070';
const WARNING_COLOR = '#f59e0b';
const ORANGE_COLOR = '#fb923c';
const DANGER_COLOR = '#ef4444';

// Severity ranks for the backend runway-use grades
// (backend/takeoff/takeoff-analysis.ts RUNWAY_USE_BANDS).
export const TAKEOFF_GRADE_SEVERITY = Object.freeze({
  Outstanding: 0,
  Good: 0,
  Acceptable: 1,
  'Late Liftoff': 2,
  Dangerous: 3,
  Overrun: 3,
});

const GRADE_COLOR_HEX = Object.freeze({
  3: DANGER_COLOR,
  2: ORANGE_COLOR,
  1: WARNING_COLOR,
  0: '#10b981',
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function takeoffGradeSeverity(grade) {
  if (!grade) return -1;
  const normalized = String(grade).trim();
  if (Object.prototype.hasOwnProperty.call(TAKEOFF_GRADE_SEVERITY, normalized)) {
    return TAKEOFF_GRADE_SEVERITY[normalized];
  }
  const match = Object.keys(TAKEOFF_GRADE_SEVERITY)
    .find((key) => key.toLowerCase() === normalized.toLowerCase());
  return match ? TAKEOFF_GRADE_SEVERITY[match] : -1;
}

export function takeoffGradeHex(severity) {
  return GRADE_COLOR_HEX[severity] || DEFAULT_GRADE_COLOR;
}

function toneClassForSeverity(severity, neutral = 'text-gray-100') {
  if (severity >= 3) return 'text-red-400';
  if (severity === 2) return 'text-orange-400';
  if (severity === 1) return 'text-amber-400';
  if (severity === 0) return 'text-green-400';
  return neutral;
}

function formatFeet(value) {
  const feet = finiteNumber(value);
  return feet === null ? '-- ft' : `${Math.round(feet).toLocaleString()} ft`;
}

function formatSide(side) {
  const normalized = String(side || '').toLowerCase();
  if (normalized === 'left') return 'L';
  if (normalized === 'right') return 'R';
  return '';
}

function buildReasonTag(text, color, index, tone) {
  return {
    key: `${index}:${text}`,
    text,
    color,
    tone,
    backgroundColor: `${color}22`,
    borderColor: `${color}44`,
  };
}

function reasonColorForSeverity(severity) {
  if (severity === 'critical' || severity === 'warning') return DANGER_COLOR;
  if (severity === 'caution') return WARNING_COLOR;
  return GOOD_COLOR;
}

function reasonToneForSeverity(severity) {
  if (severity === 'critical' || severity === 'warning') return 'danger';
  if (severity === 'caution') return 'warning';
  return 'good';
}

export function createDefaultTakeoffCardState() {
  return {
    gradeAnimationNonce: 0,
    capturedAtMs: null,
    excursionVisible: false,
    airportText: '--',
    runwayText: '--',
    gradeText: '--',
    gradeColor: DEFAULT_GRADE_COLOR,
    gradeDetailText: '--',
    scoreText: '',
    runwayUse: {
      remainingText: '-- ft',
      remainingTone: 'text-gray-100',
      remainingDetailText: '--',
      remainingDetailTone: 'text-gray-500',
      usedText: '--',
      liftoffDistanceText: '-- ft',
      runwayLengthText: '-- ft',
    },
    roll: {
      distanceText: '-- ft',
      durationText: '--',
      startNoteText: '',
    },
    liftoff: {
      iasText: '-- kt',
      gsText: 'GS: --',
      pitchText: '-- deg',
      pitchTone: 'text-gray-100',
      flapsText: '--',
      hopText: 'Clean',
      hopTone: 'text-gray-100',
      hopDetailText: '',
      hopDetailTone: 'text-gray-500',
    },
    climb: {
      screenText: '--',
      screenTone: 'text-gray-100',
      screenDetailText: '',
      screenDetailTone: 'text-gray-500',
      rotationText: '-- deg/s',
      rotationTone: 'text-gray-100',
      rotationDetailText: '',
      maxPitchText: '-- deg',
    },
    alignment: {
      lateralText: '-- ft',
      lateralTone: 'text-gray-100',
      lateralGradeText: '--',
      lateralGradeTone: 'text-gray-500',
      headingText: '-- deg',
      headingTone: 'text-gray-100',
      headingGradeText: '--',
      crosswindText: '-- kt',
      crosswindTone: 'text-gray-500',
      windTotalText: '--',
    },
    wind: buildLandingWindPresentation(),
    debrief: {
      reasons: [],
      confidenceText: 'High',
      confidenceReason: '',
      confidenceToneClass: 'text-green-400',
      visible: false,
    },
    flags: [],
  };
}

function buildRunwayUseState(msg, severity) {
  const use = msg.runwayUse || {};
  const remainingFt = finiteNumber(use.remainingFt);
  const lengthFt = finiteNumber(use.runwayLengthFt);
  const usedPct = finiteNumber(use.usedPct);
  const liftoffDistanceFt = finiteNumber(use.liftoffDistanceFt);
  const beyondEnd = use.beyondRunwayEnd === true || (remainingFt !== null && remainingFt <= 0);
  const state = {
    remainingText: remainingFt === null
      ? '-- ft'
      : beyondEnd
        ? `${Math.abs(Math.round(remainingFt)).toLocaleString()} ft past end`
        : formatFeet(remainingFt),
    remainingTone: remainingFt === null ? 'text-gray-100' : toneClassForSeverity(severity, 'text-gray-100'),
    remainingDetailText: msg.zone || use.zone || (remainingFt === null ? 'Runway geometry unavailable' : '--'),
    remainingDetailTone: remainingFt === null ? 'text-gray-500' : toneClassForSeverity(severity, 'text-gray-500'),
    usedText: usedPct === null ? '--' : `${Math.round(usedPct)}% of runway used`,
    liftoffDistanceText: formatFeet(liftoffDistanceFt),
    runwayLengthText: formatFeet(lengthFt),
  };
  return state;
}

function buildClimbState(msg) {
  const screen = msg.screenHeight || {};
  const rotation = msg.rotation || {};
  const heightFt = finiteNumber(screen.heightFt);
  const screenRemainingFt = finiteNumber(screen.remainingFt);
  const screenElapsedS = finiteNumber(screen.elapsedS);
  const rateDegS = finiteNumber(rotation.rateDegS);
  const maxPitchDeg = finiteNumber(rotation.maxPitchDeg);
  const heightLabel = heightFt === null ? 'Screen height' : `${Math.round(heightFt)} ft`;

  let screenText = '--';
  let screenTone = 'text-gray-100';
  let screenDetailText = '';
  let screenDetailTone = 'text-gray-500';
  if (screen.reached === true) {
    if (screenRemainingFt !== null) {
      screenText = screenRemainingFt < 0
        ? `${Math.abs(Math.round(screenRemainingFt)).toLocaleString()} ft past end`
        : `${Math.round(screenRemainingFt).toLocaleString()} ft left`;
      screenTone = screenRemainingFt < 0 ? 'text-red-400' : 'text-gray-100';
      screenDetailText = screenRemainingFt < 0
        ? `${heightLabel} reached beyond the runway end`
        : `Runway left at ${heightLabel}`;
      screenDetailTone = screenRemainingFt < 0 ? 'text-red-400' : 'text-gray-500';
    } else {
      screenText = screenElapsedS === null ? 'Reached' : `${screenElapsedS.toFixed(1)} s`;
      screenDetailText = `${heightLabel} after liftoff · runway position unavailable`;
    }
    if (screenElapsedS !== null && screenRemainingFt !== null) {
      screenDetailText += ` · ${screenElapsedS.toFixed(1)} s after liftoff`;
    }
  } else if (heightFt !== null) {
    screenText = 'Not reached';
    screenDetailText = `${heightLabel} not observed before scoring`;
  }

  return {
    screenText,
    screenTone,
    screenDetailText,
    screenDetailTone,
    rotationText: rateDegS === null ? '-- deg/s' : `${rateDegS.toFixed(1)} deg/s`,
    rotationTone: rateDegS !== null && rateDegS >= 5 ? 'text-amber-400' : 'text-gray-100',
    rotationDetailText: rateDegS === null
      ? 'Rotation not resolved'
      : rateDegS >= 5
        ? 'Rapid rotation'
        : rateDegS < 1.5
          ? 'Gentle rotation'
          : 'Steady rotation',
    maxPitchText: maxPitchDeg === null ? '-- deg' : `${maxPitchDeg > 0 ? '+' : ''}${maxPitchDeg.toFixed(1)} deg`,
  };
}

function buildAlignmentState(msg, wind) {
  const lateral = msg.lateral || {};
  const heading = msg.heading || {};
  const offsetFt = finiteNumber(lateral.liftoffOffsetFt);
  const lateralScore = finiteNumber(lateral.score);
  const verified = lateral.verified === true;
  const lateralGrade = lateral.grade || (verified ? '--' : 'Unverified');
  const deviationDeg = finiteNumber(heading.liftoffDeviationDeg);
  const deviationSide = formatSide(heading.liftoffDeviationSide);

  return {
    lateralText: offsetFt === null
      ? '-- ft'
      : offsetFt < 15
        ? 'ON CL'
        : `${Math.round(offsetFt)} ft ${formatSide(lateral.liftoffOffsetSide)}`.trim(),
    lateralTone: lateralGrade === 'Poor'
      ? 'text-amber-400'
      : lateralScore !== null && lateralScore < 70
        ? 'text-red-400'
        : 'text-gray-100',
    lateralGradeText: verified ? lateralGrade : 'Unverified',
    lateralGradeTone: !verified
      ? 'text-gray-500'
      : lateralScore === null
        ? 'text-gray-500'
        : lateralScore >= 90
          ? 'text-green-400'
          : lateralScore >= 70
            ? 'text-amber-500'
            : 'text-red-400',
    headingText: deviationDeg === null
      ? '-- deg'
      : deviationDeg < 0.5
        ? 'ALIGNED'
        : `${deviationDeg.toFixed(1)} deg ${deviationSide}`.trim(),
    headingTone: deviationDeg === null
      ? 'text-gray-100'
      : deviationDeg <= 5
        ? 'text-gray-100'
        : deviationDeg <= 10
          ? 'text-amber-400'
          : 'text-red-400',
    headingGradeText: deviationDeg === null
      ? '--'
      : deviationDeg <= 3
        ? 'Runway aligned'
        : deviationDeg <= 5
          ? 'Slight heading error'
          : deviationDeg <= 10
            ? 'Heading misaligned'
            : 'Major heading error',
    crosswindText: wind.crosswindText,
    crosswindTone: wind.crosswindText === '-- kt' ? 'text-gray-500' : 'text-gray-100',
    windTotalText: wind.totalText,
  };
}

export function buildTakeoffDebriefReasons(msg, { limit = 6 } = {}) {
  const reasons = [];
  if (!msg || typeof msg !== 'object') return reasons;
  const grade = msg.grade || msg.runwayUse?.grade || null;
  const severity = takeoffGradeSeverity(grade);
  if (grade && severity >= 0) {
    // Late Liftoff is the app's orange caution band, not an aviation-standard
    // failure; only the runway-end lines (severity 3) paint danger red.
    const color = severity >= 3
      ? DANGER_COLOR
      : severity === 2
        ? ORANGE_COLOR
        : severity === 1
          ? WARNING_COLOR
          : GOOD_COLOR;
    const tone = severity >= 3 ? 'danger' : severity >= 1 ? 'warning' : 'good';
    reasons.push(buildReasonTag(`${grade} runway use`, color, reasons.length, tone));
  }
  const flags = Array.isArray(msg.flags) ? msg.flags : [];
  for (const flag of flags) {
    if (!flag || !flag.label) continue;
    reasons.push(buildReasonTag(
      String(flag.label),
      reasonColorForSeverity(flag.severity),
      reasons.length,
      reasonToneForSeverity(flag.severity),
    ));
  }
  // Praise never sits beside a serious warning; the landing debrief keeps the
  // same rule so a critical card cannot read as mixed news.
  const assessment = String(msg.assessment || '').toLowerCase();
  const serious = severity >= 2 || assessment === 'warning' || assessment === 'critical';
  if (!serious) {
    const lateral = msg.lateral || {};
    if (lateral.verified === true && (lateral.grade === 'Perfect' || lateral.grade === 'Good')) {
      reasons.push(buildReasonTag('Lifted off on the centerline', GOOD_COLOR, reasons.length, 'good'));
    }
    const rotation = finiteNumber(msg.rotation?.rateDegS);
    if (rotation !== null && rotation >= 1.5 && rotation < 5) {
      reasons.push(buildReasonTag('Steady rotation', GOOD_COLOR, reasons.length, 'good'));
    }
  }
  return reasons.slice(0, limit);
}

export function buildTakeoffDebriefConfidence(msg) {
  const reasons = [];
  let rank = 0;
  function lower(nextRank, reason) {
    rank = Math.max(rank, nextRank);
    if (reason) reasons.push(reason);
  }
  if (finiteNumber(msg?.runwayUse?.remainingFt) === null) lower(2, 'No runway geometry');
  if (msg?.lateral && msg.lateral.verified !== true) lower(1, 'Runway alignment unverified');
  if (msg?.roll?.startSource === 'runway_aligned') lower(1, 'Rolling start; roll measured from runway alignment');
  if (msg?.screenHeight && msg.screenHeight.reached !== true) lower(1, 'Screen height not observed');
  if (String(msg?.finalizeReason || '').startsWith('timeout')) lower(1, 'Scored after a timeout');

  if (rank >= 2) {
    return { confidenceText: 'Low', confidenceReason: reasons.join(', '), confidenceToneClass: 'text-red-400' };
  }
  if (rank === 1) {
    return { confidenceText: 'Medium', confidenceReason: reasons.join(', '), confidenceToneClass: 'text-amber-400' };
  }
  return { confidenceText: 'High', confidenceReason: '', confidenceToneClass: 'text-green-400' };
}

/**
 * Build the complete card state for a final `takeoff` message.
 */
export function buildTakeoffPresentation(msg, { previousNonce = 0, capturedAtMs = null } = {}) {
  const card = createDefaultTakeoffCardState();
  if (!msg || typeof msg !== 'object') return card;

  const grade = msg.grade || msg.runwayUse?.grade || null;
  const severity = takeoffGradeSeverity(grade);
  const score = finiteNumber(msg.score ?? msg.runwayUse?.score);
  const timestampMs = finiteNumber(capturedAtMs) ?? finiteNumber(msg.timestampMs);

  card.gradeAnimationNonce = previousNonce + 1;
  card.capturedAtMs = timestampMs !== null && timestampMs > 0 ? timestampMs : Date.now();
  card.excursionVisible = msg.runwayExcursion === true;
  card.airportText = msg.icao || '--';
  card.runwayText = msg.runway ? `RWY ${msg.runway}` : '--';
  card.gradeText = grade && severity >= 0 ? String(grade).toUpperCase() : 'NO GRADE';
  card.gradeColor = severity >= 0 ? takeoffGradeHex(severity) : DEFAULT_GRADE_COLOR;
  card.gradeDetailText = msg.zone || msg.runwayUse?.zone || (severity >= 0 ? '--' : 'Runway geometry unavailable');
  card.scoreText = score === null ? '' : `Runway use ${Math.round(score)}%`;

  card.runwayUse = buildRunwayUseState(msg, severity);

  const roll = msg.roll || {};
  const rollDistanceFt = finiteNumber(roll.distanceFt);
  const rollDurationS = finiteNumber(roll.durationS);
  card.roll = {
    distanceText: formatFeet(rollDistanceFt),
    durationText: rollDurationS === null ? '--' : `${rollDurationS.toFixed(0)} s`,
    startNoteText: roll.startSource === 'standstill'
      ? 'From standstill'
      : roll.startSource === 'runway_aligned'
        ? 'Rolling start; measured from runway alignment'
        : rollDistanceFt === null ? 'Roll start not resolved' : '',
  };

  const liftoff = msg.liftoff || {};
  const iasKts = finiteNumber(liftoff.iasKts);
  const gsKts = finiteNumber(liftoff.gsKts);
  const pitchDeg = finiteNumber(liftoff.pitchDeg);
  const flapsNotch = finiteNumber(liftoff.flapsNotch);
  const hopCount = Math.max(0, Math.round(finiteNumber(msg.hopCount) ?? 0));
  card.liftoff = {
    iasText: iasKts === null ? '-- kt' : `${Math.round(iasKts)} kt`,
    gsText: gsKts === null ? 'GS: --' : `GS: ${Math.round(gsKts)}`,
    pitchText: pitchDeg === null ? '-- deg' : `${pitchDeg > 0 ? '+' : ''}${pitchDeg.toFixed(1)} deg`,
    pitchTone: pitchDeg !== null && pitchDeg < 0 ? 'text-amber-400' : 'text-gray-100',
    flapsText: flapsNotch === null ? '--' : `Flaps ${Math.round(flapsNotch)}`,
    hopText: hopCount === 0 ? 'Clean' : `${hopCount}x`,
    hopTone: hopCount === 0 ? 'text-gray-100' : 'text-amber-400',
    hopDetailText: hopCount === 0
      ? 'Stayed airborne'
      : hopCount === 1
        ? 'Settled back once'
        : `Settled back ${hopCount} times`,
    hopDetailTone: hopCount === 0 ? 'text-green-400' : 'text-amber-500',
  };

  card.climb = buildClimbState(msg);

  card.wind = buildLandingWindPresentation(msg);
  card.wind.ariaLabel = card.wind.ariaLabel.replace('Wind at touchdown', 'Wind at liftoff');
  card.alignment = buildAlignmentState(msg, card.wind);

  const reasons = buildTakeoffDebriefReasons(msg);
  const confidence = buildTakeoffDebriefConfidence(msg);
  card.debrief = {
    reasons,
    confidenceText: confidence.confidenceText,
    confidenceReason: confidence.confidenceReason,
    confidenceToneClass: confidence.confidenceToneClass,
    visible: reasons.length > 0 || confidence.confidenceText !== 'High',
  };
  card.flags = Array.isArray(msg.flags) ? msg.flags.slice() : [];
  return card;
}

/**
 * Compact preview for the Overview tab, derived from the same card state.
 */
export function buildTakeoffPreview(card, { available = false, pending = false, settled = false } = {}) {
  if (!available) {
    return {
      available: false,
      status: pending
        ? (settled
          ? 'Settled back onto the runway. Waiting for the next liftoff…'
          : 'Liftoff detected. Scoring the climb-out…')
        : 'Waiting for liftoff in this session.',
      grade: '--',
      gradeColor: DEFAULT_GRADE_COLOR,
      remaining: '--',
      remainingTone: 'text-gray-400',
      remainingDetail: '',
      roll: '--',
      liftoff: '--',
      screen: '--',
      screenTone: 'text-gray-400',
      runway: '--',
    };
  }
  return {
    available: true,
    status: 'Latest takeoff report is ready.',
    grade: card.gradeText,
    gradeColor: card.gradeColor,
    remaining: card.runwayUse.remainingText,
    remainingTone: card.runwayUse.remainingTone,
    remainingDetail: card.runwayUse.remainingDetailText,
    roll: card.roll.distanceText,
    liftoff: card.liftoff.iasText,
    screen: card.climb.screenText,
    screenTone: card.climb.screenTone,
    runway: card.airportText !== '--' && card.runwayText !== '--'
      ? `${card.airportText} ${card.runwayText.replace(/^RWY /, '')}`
      : card.airportText,
  };
}
