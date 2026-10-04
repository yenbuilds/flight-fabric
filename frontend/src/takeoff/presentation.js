// Takeoff card presentation: turns the backend `takeoff` message into the
// texts and tone classes the Takeoff panel and the Overview summary render.
// Pure, so the store, the share model and the tests read one contract.
import { buildLandingWindPresentation } from '../landing/wind.js';

const DEFAULT_GRADE_COLOR = '#4a5e74';
const GOOD_COLOR = '#00e070';
const WARNING_COLOR = '#f59e0b';
const ORANGE_COLOR = '#fb923c';
const DANGER_COLOR = '#ef4444';

// Historical runway-use grades stay readable; new records have no quality score.
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

const FINDING_RANK = Object.freeze({ critical: 3, warning: 2, caution: 1 });

function takeoffFindings(msg) {
  const findings = new Map();
  for (const flag of Array.isArray(msg.flags) ? msg.flags : []) {
    const label = typeof flag?.label === 'string' ? flag.label.trim() : '';
    if (!label) continue;
    const key = String(flag.code || label).trim().toLowerCase();
    const previous = findings.get(key);
    if (!previous || (FINDING_RANK[flag.severity] || 0) > (FINDING_RANK[previous.severity] || 0)) {
      findings.set(key, { ...flag, label });
    }
  }
  if (msg.runwayExcursion === true && !findings.has('runway_excursion')) {
    findings.set('runway_excursion', { code: 'runway_excursion', label: 'Runway excursion', severity: 'critical' });
  }
  const assessment = String(msg.assessment || '').toLowerCase();
  const assessmentRank = FINDING_RANK[assessment] || 0;
  if (assessmentRank && ![...findings.values()].some((flag) => (FINDING_RANK[flag.severity] || 0) >= assessmentRank)) {
    findings.set('recorded_assessment', {
      label: `${assessment[0].toUpperCase()}${assessment.slice(1)} assessment recorded`, severity: assessment,
    });
  }
  // Stable ordering keeps serious findings ahead of informational context, even
  // for older recordings whose flags were written in a different order.
  return [...findings.values()].sort((left, right) => (FINDING_RANK[right.severity] || 0) - (FINDING_RANK[left.severity] || 0));
}

export function createDefaultTakeoffCardState() {
  return {
    gradeAnimationNonce: 0,
    capturedAtMs: null,
    excursionVisible: false,
    assessmentText: '',
    assessmentTone: 'text-muted-fg',
    airportText: '--',
    runwayText: '--',
    gradeText: '--',
    gradeLabel: 'Takeoff record',
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
      label: 'Ground roll',
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
      hopText: 'None observed',
      hopTone: 'text-gray-100',
      hopDetailText: '',
      hopDetailTone: 'text-gray-500',
    },
    climb: {
      screenLabel: 'Screen height',
      screenText: '--',
      screenTone: 'text-gray-100',
      screenDetailText: '',
      screenDetailTone: 'text-gray-500',
      rotationText: '-- deg/s',
      rotationTone: 'text-gray-100',
      rotationDetailText: '',
      maxPitchText: '-- deg',
      maxPitchIntervalText: 'During capture',
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
  const positionUncertain = use.notScoredReason === 'liftoff_position_uncertain'
    || (Array.isArray(msg.flags) && msg.flags.some((flag) => flag?.code === 'liftoff_position_uncertain'));
  const remainingFt = finiteNumber(use.remainingFt);
  const lengthFt = finiteNumber(use.runwayLengthFt);
  const usedPct = finiteNumber(use.usedPct);
  const liftoffDistanceFt = finiteNumber(use.liftoffDistanceFt);
  const beyondEnd = use.beyondRunwayEnd === true || (remainingFt !== null && remainingFt < 0);
  const state = {
    remainingText: positionUncertain ? 'Uncertain' : remainingFt === null
      ? '-- ft'
      : beyondEnd
        ? `${Math.abs(Math.round(remainingFt)).toLocaleString()} ft past end`
        : formatFeet(remainingFt),
    remainingTone: remainingFt === null ? 'text-gray-100' : toneClassForSeverity(severity, 'text-gray-100'),
    remainingDetailText: msg.zone || use.zone || (remainingFt === null ? 'Runway geometry unavailable' : 'At liftoff'),
    remainingDetailTone: remainingFt === null ? 'text-gray-500' : toneClassForSeverity(severity, 'text-gray-500'),
    usedText: usedPct === null ? '--' : `${Math.round(usedPct)}% from runway start`,
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
  const priorRateDegS = finiteNumber(rotation.priorMaxRateDegS);
  const recordedRotationCaution = Array.isArray(msg.flags) && msg.flags.some((flag) => flag?.code === 'rapid_rotation');
  const maxPitchDeg = finiteNumber(rotation.maxPitchDeg);
  const screenLabel = screen.heightSource === 'baro' || screen.heightSource === 'plane' ? 'Height gained' : 'Screen height';
  const heightReference = screen.heightSource === 'radio' ? ' radio height'
    : screen.heightSource === 'baro' ? ' height gained since liftoff'
      : screen.heightSource === 'plane' ? ' geometric height gained since liftoff' : '';
  const heightLabel = heightFt === null ? screenLabel : `${Math.round(heightFt)} ft${heightReference}`;

  let screenText = '--';
  let screenTone = 'text-gray-100';
  let screenDetailText = '';
  let screenDetailTone = 'text-gray-500';
  if (screen.reached === true) {
    if (screenRemainingFt !== null) {
      screenText = screenRemainingFt < 0
        ? `${Math.abs(Math.round(screenRemainingFt)).toLocaleString()} ft past end`
        : `${Math.round(screenRemainingFt).toLocaleString()} ft left`;
      screenDetailText = screenRemainingFt < 0
        ? `${heightLabel} reached beyond the runway end`
        : `Runway left at ${heightLabel}`;
    } else {
      screenText = screenElapsedS === null ? 'Reached' : `${screenElapsedS.toFixed(1)} s`;
      screenDetailText = `${heightLabel} after liftoff · runway position unavailable`;
    }
    if (screenElapsedS !== null && screenRemainingFt !== null) {
      screenDetailText += ` · ${screenElapsedS.toFixed(1)} s after liftoff`;
    }
    if (screen.timeBasis === 'capture') screenDetailText += ' · Time measured in real time';
  } else if (heightFt !== null) {
    screenText = 'Not observed';
    screenDetailText = `${heightLabel} not observed during capture`;
  }

  const rotationDetail = rateDegS === null
    ? 'Rotation not resolved'
    : rotation.timeBasis === 'capture' ? 'Measured average in real time to liftoff' : 'Measured average to liftoff';

  return {
    screenLabel,
    screenText,
    screenTone,
    screenDetailText,
    screenDetailTone,
    rotationText: rateDegS === null ? '-- deg/s' : `${rateDegS.toFixed(1)} deg/s`,
    rotationTone: recordedRotationCaution ? 'text-amber-400' : 'text-gray-100',
    rotationDetailText: priorRateDegS !== null
      ? `${rotationDetail} · Earlier liftoff: ${priorRateDegS.toFixed(1)} deg/s`
      : rotationDetail,
    maxPitchText: maxPitchDeg === null ? '-- deg' : `${maxPitchDeg > 0 ? '+' : ''}${maxPitchDeg.toFixed(1)} deg`,
    maxPitchIntervalText: 'During capture',
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
      : `${Math.round(offsetFt)} ft ${formatSide(lateral.liftoffOffsetSide)}`.trim(),
    lateralTone: !verified ? 'text-gray-100' : lateralGrade === 'Poor'
      ? 'text-amber-400'
      : lateralScore !== null && lateralScore < 70
        ? 'text-red-400'
        : 'text-gray-100',
    lateralGradeText: !verified ? 'Unverified' : lateralScore === null ? 'Measured at liftoff' : `Recorded grade: ${lateralGrade}`,
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
      : `${deviationDeg.toFixed(1)} deg ${deviationSide}`.trim(),
    // Liftoff heading is not ground track; roll findings are shown separately.
    headingTone: 'text-gray-100',
    headingGradeText: !verified
      ? 'Unverified'
      : deviationDeg === null
      ? '--'
      : 'Measured at liftoff',
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
  const flags = takeoffFindings(msg);
  const assessment = String(msg.assessment || '').toLowerCase();
  const serious = severity >= 2 || msg.runwayExcursion === true
    || assessment === 'warning' || assessment === 'critical'
    || flags.some((flag) => flag?.severity === 'warning' || flag?.severity === 'critical');
  // The recorded grade has its own summary. These chips explain specific
  // findings instead of repeating that grade as another assessment.
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
  if (!serious) {
    const lateral = msg.lateral || {};
    if (lateral.verified === true && (lateral.grade === 'Perfect' || lateral.grade === 'Good')) {
      reasons.push(buildReasonTag('Lifted off on the centerline', GOOD_COLOR, reasons.length, 'good'));
    }
  }
  const seriousCount = flags.filter((flag) => (FINDING_RANK[flag.severity] || 0) >= 2).length;
  return reasons.slice(0, Math.max(limit, seriousCount));
}

export function buildTakeoffDebriefConfidence(msg) {
  const reasons = [];
  let rank = 0;
  function lower(nextRank, reason) {
    rank = Math.max(rank, nextRank);
    if (reason) reasons.push(reason);
  }
  const positionUncertain = msg?.runwayUse?.notScoredReason === 'liftoff_position_uncertain'
    || (Array.isArray(msg?.flags) && msg.flags.some((flag) => flag?.code === 'liftoff_position_uncertain'));
  if (positionUncertain) lower(2, 'Liftoff position uncertain at runway end');
  else if (finiteNumber(msg?.runwayUse?.remainingFt) === null) lower(2, 'No runway geometry');
  if (msg?.runwayUse?.verified === false) lower(2, 'Runway geometry unverified or conflicting');
  if (msg?.lateral && msg.lateral.verified !== true) lower(1, 'Runway alignment unverified');
  if (msg?.roll?.startSource === 'runway_aligned') lower(1, 'Rolling start; roll measured from runway alignment');
  if (msg?.screenHeight?.reached !== true) lower(1, 'Climb-out incomplete: screen height not observed');
  if (msg?.finalizeReason === 'telemetry_gap') lower(2, 'Telemetry gap during climb-out');
  if (Array.isArray(msg?.flags) && msg.flags.some((flag) => flag?.code === 'ground_contact_uncertain')) lower(1, 'Brief ground contact not confirmed');
  if (String(msg?.finalizeReason || '').startsWith('timeout')) lower(1, 'Capture ended after a timeout');

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
  const flags = Array.isArray(msg.flags) ? msg.flags : [];
  const findings = takeoffFindings(msg).filter((flag) => FINDING_RANK[flag.severity]);
  card.assessmentText = findings.map((flag) => flag.label).join(' · ')
    || '';
  card.assessmentTone = Math.max(FINDING_RANK[msg.assessment] || 0, ...findings.map((flag) => FINDING_RANK[flag.severity])) >= 2
    ? 'text-danger' : 'text-warning';
  card.airportText = msg.icao || '--';
  card.runwayText = msg.runway ? `RWY ${msg.runway}` : '--';
  card.gradeText = grade === 'Recorded' ? 'RECORDED' : grade && severity >= 0 ? String(grade).toUpperCase() : 'NO GRADE';
  card.gradeLabel = score === null ? 'Takeoff record' : 'Recorded runway-use grade';
  card.gradeColor = grade === 'Recorded' ? 'rgb(var(--foreground))' : severity >= 0 ? takeoffGradeHex(severity) : DEFAULT_GRADE_COLOR;
  card.gradeDetailText = msg.zone || msg.runwayUse?.zone || (severity >= 0 ? '--' : 'Runway geometry unavailable');
  card.scoreText = score === null ? '' : `Recorded runway-use score ${Math.round(score)}%`;

  card.runwayUse = buildRunwayUseState(msg, severity);

  const roll = msg.roll || {};
  const rollDistanceFt = finiteNumber(roll.distanceFt);
  const rollDurationS = finiteNumber(roll.durationS);
  const rollStartNote = roll.startSource === 'standstill'
    ? 'From low speed (8 kt or less)'
    : roll.startSource === 'runway_aligned'
      ? 'Rolling start; measured from runway alignment'
      : rollDistanceFt === null ? 'Roll start not resolved' : '';
  card.roll = {
    label: finiteNumber(msg.hopCount) > 0 ? 'Distance to final liftoff' : 'Ground roll',
    distanceText: formatFeet(rollDistanceFt),
    durationText: rollDurationS === null ? '--' : `${rollDurationS.toFixed(0)} s${roll.durationBasis === 'capture' ? ' (real time)' : ''}`,
    startNoteText: finiteNumber(msg.hopCount) > 0
      ? [rollStartNote, 'Includes airborne intervals before settling back'].filter(Boolean).join(' · ')
      : rollStartNote,
  };

  const liftoff = msg.liftoff || {};
  const iasKts = finiteNumber(liftoff.iasKts);
  const gsKts = finiteNumber(liftoff.gsKts);
  const pitchDeg = finiteNumber(liftoff.pitchDeg);
  const flapsNotch = finiteNumber(liftoff.flapsNotch);
  const hopCount = Math.max(0, Math.round(finiteNumber(msg.hopCount) ?? 0));
  const contactUncertain = flags.some((flag) => flag?.code === 'ground_contact_uncertain');
  const incompleteCapture = msg.screenHeight?.reached !== true || msg.finalizeReason === 'telemetry_gap'
    || String(msg.finalizeReason || '').startsWith('timeout');
  card.liftoff = {
    iasText: iasKts === null ? '-- kt' : `${Math.round(iasKts)} kt`,
    gsText: gsKts === null ? 'GS: --' : `GS: ${Math.round(gsKts)}`,
    pitchText: pitchDeg === null ? '-- deg' : `${pitchDeg > 0 ? '+' : ''}${pitchDeg.toFixed(1)} deg`,
    pitchTone: 'text-gray-100',
    flapsText: flapsNotch === null ? '--' : `Flaps ${Math.round(flapsNotch)}`,
    hopText: hopCount === 0 ? (contactUncertain ? 'Uncertain' : 'None observed') : `${hopCount}x`,
    hopTone: hopCount === 0 && !contactUncertain ? 'text-gray-100' : 'text-amber-400',
    hopDetailText: hopCount === 0
      ? (contactUncertain ? 'Brief ground contact not confirmed'
        : incompleteCapture ? 'No confirmed contacts; climb-out capture incomplete' : 'No confirmed ground contacts during capture')
      : hopCount === 1
        ? 'Settled back once'
        : `Settled back ${hopCount} times`,
    hopDetailTone: hopCount === 0 && !contactUncertain ? 'text-gray-500' : 'text-amber-500',
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
          : 'Liftoff detected. Measuring the climb-out…')
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
    assessment: card.assessmentText,
    assessmentTone: card.assessmentTone,
    confidence: `${card.debrief.confidenceText} confidence${card.debrief.confidenceReason ? ` · ${card.debrief.confidenceReason}` : ''}`,
    grade: card.gradeText,
    gradeLabel: card.gradeLabel,
    gradeColor: card.gradeColor,
    remaining: card.runwayUse.remainingText,
    remainingTone: card.runwayUse.remainingTone,
    remainingDetail: card.runwayUse.remainingDetailText,
    roll: card.roll.distanceText,
    rollLabel: card.roll.label,
    liftoff: card.liftoff.iasText,
    screen: card.climb.screenText,
    screenLabel: card.climb.screenLabel,
    screenDetail: card.climb.screenDetailText,
    screenTone: card.climb.screenTone,
    runway: card.airportText !== '--' && card.runwayText !== '--'
      ? `${card.airportText} ${card.runwayText.replace(/^RWY /, '')}`
      : card.airportText,
  };
}
