import { buildLandingPresentation } from '../landing/scoring.js';
import {
  HIDDEN_STABILITY_METRICS,
  getStabilityContextSummary,
  getStabilityMetricShortCriterion,
} from '../landing/stability-context.js';

const STABILITY_FAILURE_LABELS = {
  glidepath_proxy_unstable_after_gate: 'vertical path-rate unstable after the gate',
  glidepath_too_low_after_gate: 'descent rate steeper than target after the gate',
};
const RETIRED_STABILITY_FAILURES = new Set(['spoilers_moved_after_gate']);

function stabilityFailureLabel(value) {
  const key = String(value || '').trim();
  return STABILITY_FAILURE_LABELS[key]
    || key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pushMetricRow(rows, key, label, value, valueClass = '') {
  if (value === null || value === undefined || value === '') return;
  rows.push({
    key,
    label,
    value: String(value),
    valueClass,
  });
}

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nonEmptyText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function formatRunway(runway) {
  if (!runway || typeof runway !== 'object') return null;
  const runwayId = nonEmptyText(runway.runway_id);
  const runwayLengthFt = finiteNumber(runway.length_ft);
  if (runwayId && runwayLengthFt != null) return `${runwayId} (${Math.round(runwayLengthFt)}ft)`;
  if (runwayId) return runwayId;
  if (runwayLengthFt != null) return `${Math.round(runwayLengthFt)}ft runway`;
  return null;
}

function getTouchdownGradeClass(touchdownDistance, verdict) {
  if (!touchdownDistance) return '';
  if (verdict.flags.runwayExcursion) return 'text-red-400 font-semibold';
  const severity = verdict.touchdown.severity;
  if (severity >= 3) return 'text-red-400 font-semibold';
  if (severity >= 2) return 'text-orange-400 font-semibold';
  if (severity >= 1) return 'text-yellow-400 font-semibold';
  const score = finiteNumber(touchdownDistance.score);
  if (score != null && score >= 90) return 'text-green-400 font-semibold';
  if (score != null && score >= 70) return 'text-yellow-400 font-semibold';
  return 'text-amber-400 font-semibold';
}

function getStabilityVerdictClass(verdict) {
  if (verdict === 'unstable') return 'text-red-400 font-semibold';
  if (verdict === 'marginal') return 'text-amber-400 font-semibold';
  if (verdict === 'stable') return 'text-green-400 font-semibold';
  return 'text-gray-400 font-semibold';
}

function getStabilityMetricClass(value) {
  const score = finiteNumber(value);
  if (score == null) return '';
  if (score < 60) return 'text-red-400 font-semibold';
  if (score < 80) return 'text-amber-400 font-semibold';
  return 'text-green-400 font-semibold';
}

export function buildLandingDetailSections(event) {
  const sections = [];
  if (!event || event.type !== 'landing') return sections;
  const presentation = buildLandingPresentation(event);

  const snapshotRows = [];
  pushMetricRow(
    snapshotRows,
    'touchdown-grade',
    'Touchdown Rate Grade',
    presentation.touchdownGrade,
    presentation.touchdownTextClass,
  );
  pushMetricRow(
    snapshotRows,
    'approach-verdict',
    'Approach',
    presentation.approachText,
    getStabilityVerdictClass(presentation.stabilityVerdict),
  );
  pushMetricRow(
    snapshotRows,
    'bounce',
    'Bounce',
    presentation.bounceKnown
      ? `${presentation.bounceText}${presentation.bounceCount > 0 && presentation.verdict.bounce.bounceGrade
        ? ` (${presentation.verdict.bounce.bounceGrade})`
        : ''}`
      : null,
    presentation.bounceCount > 0 ? presentation.verdict.bounce.textClass : 'text-green-400 font-semibold',
  );
  pushMetricRow(snapshotRows, 'approach-score', 'Approach Score', presentation.stabilityScore != null ? `${presentation.stabilityScore}%` : null);
  pushMetricRow(snapshotRows, 'ias', 'IAS', event.ias_kts != null ? `${Math.round(event.ias_kts)} kts` : null);
  pushMetricRow(snapshotRows, 'vs', 'Touchdown Rate', event.vs_fpm != null ? `${Math.round(event.vs_fpm)} fpm` : null);
  pushMetricRow(snapshotRows, 'pitch', 'Pitch', event.pitch_deg != null ? `${event.pitch_deg.toFixed(1)} deg` : null);
  pushMetricRow(snapshotRows, 'bank', 'Bank', event.bank_deg != null ? `${event.bank_deg.toFixed(1)} deg` : null);
  pushMetricRow(snapshotRows, 'heading', 'Heading', event.hdg_true_deg != null ? `${Math.round(event.hdg_true_deg)} deg` : null);
  pushMetricRow(
    snapshotRows,
    'position',
    'Position',
    event.lat != null && event.lon != null ? `${event.lat.toFixed(4)}, ${event.lon.toFixed(4)}` : null,
  );
  pushMetricRow(
    snapshotRows,
    'runway',
    'Runway',
    formatRunway(event.runway),
  );
  if (snapshotRows.length > 0) {
    sections.push({
      key: 'landing-snapshot',
      title: 'Landing Snapshot',
      rows: snapshotRows,
      noteText: '',
      emptyText: '',
    });
  }

  const tdz = event.touchdownDistance && typeof event.touchdownDistance === 'object'
    ? event.touchdownDistance
    : null;
  if (tdz || presentation.verdict.flags.runwayExcursion) {
    const touchdownRows = [];
    const distanceFt = finiteNumber(tdz?.distanceFt);
    const tdzGrade = nonEmptyText(tdz?.grade);
    const tdzZone = nonEmptyText(tdz?.zone);
    const touchdownScore = finiteNumber(tdz?.score);
    pushMetricRow(
      touchdownRows,
      'distance',
      'Distance',
      distanceFt != null ? `${Math.round(distanceFt)}ft from threshold` : null,
    );
    pushMetricRow(
      touchdownRows,
      'grade',
      'TDZ Grade',
      tdzGrade ? `${tdzGrade}${tdzZone ? ` (${tdzZone})` : ''}` : null,
      getTouchdownGradeClass(tdz, presentation.verdict),
    );
    pushMetricRow(touchdownRows, 'score', 'TDZ Score', touchdownScore != null ? `${Math.round(touchdownScore)}/100` : null);
    pushMetricRow(
      touchdownRows,
      'runway-excursion',
      'Runway Excursion',
      presentation.verdict.flags.runwayExcursion ? 'Yes' : null,
      'text-red-400 font-semibold',
    );

    const runwayLengthFt = finiteNumber(event.runway?.length_ft);
    if (distanceFt != null && runwayLengthFt != null && runwayLengthFt > 0) {
      const roundedDistance = Math.round(distanceFt);
      const remaining = Math.round(runwayLengthFt - distanceFt);
      const pctUsed = ((distanceFt / runwayLengthFt) * 100).toFixed(1);
      pushMetricRow(touchdownRows, 'remaining', 'Remaining', `${remaining}ft (${pctUsed}% down runway)`);
    }

    const lateralOffsetFt = finiteNumber(tdz?.lateralOffsetFt);
    if (lateralOffsetFt != null) {
      const side = nonEmptyText(tdz?.lateralOffsetSide);
      const lateralGrade = nonEmptyText(tdz?.lateralOffsetGrade);
      pushMetricRow(
        touchdownRows,
        'lateral',
        'Lateral',
        `${Math.abs(Math.round(lateralOffsetFt))}ft${side ? ` ${side}` : ''}${lateralGrade ? ` (${lateralGrade})` : ''}`,
      );
    }

    if (touchdownRows.length > 0) {
      sections.push({
        key: 'touchdown-zone-analysis',
        title: 'Touchdown Zone Analysis',
        rows: touchdownRows,
        noteText: '',
        emptyText: '',
      });
    }
  }

  if (event.rolloutAnalysis) {
    const rollout = event.rolloutAnalysis;
    const rolloutRows = [];
    const assessment = String(rollout.assessment || 'normal');
    pushMetricRow(
      rolloutRows,
      'assessment',
      'Assessment',
      assessment.charAt(0).toUpperCase() + assessment.slice(1),
      assessment === 'critical' || assessment === 'warning'
        ? 'text-red-400 font-semibold'
        : assessment === 'caution'
          ? 'text-amber-400 font-semibold'
          : 'text-green-400 font-semibold',
    );
    pushMetricRow(
      rolloutRows,
      'max-bank',
      'Peak Bank',
      rollout.maxBankDeg != null
        ? `${Number(rollout.maxBankDeg).toFixed(1)} deg${rollout.maxBankAtGsKts != null ? ` at ${Math.round(rollout.maxBankAtGsKts)} kts` : ''}`
        : null,
    );
    pushMetricRow(
      rolloutRows,
      'bank-rate',
      'Peak Bank Change',
      rollout.maxBankRateDegS != null
        ? `${Number(rollout.maxBankRateDegS).toFixed(1)} deg/s${rollout.maxBankRateAtGsKts != null ? ` at ${Math.round(rollout.maxBankRateAtGsKts)} kts` : ''}`
        : null,
    );
    pushMetricRow(
      rolloutRows,
      'heading-deviation',
      'Heading Deviation',
      rollout.maxHeadingDeviationDeg != null
        ? `${Number(rollout.maxHeadingDeviationDeg).toFixed(1)} deg ${rollout.maxHeadingDeviationSide || ''}`.trim()
        : null,
    );
    pushMetricRow(
      rolloutRows,
      'lateral-offset',
      'Peak Lateral Offset',
      rollout.maxLateralOffsetFt != null
        ? `${Math.round(rollout.maxLateralOffsetFt)} ft ${rollout.maxLateralOffsetSide || ''}`.trim()
        : null,
    );
    pushMetricRow(
      rolloutRows,
      'edge-margin',
      rollout.conservativeRunwayEdgeMarginFt != null ? 'Conservative Edge Margin' : 'Runway Edge Margin',
      (rollout.conservativeRunwayEdgeMarginFt ?? rollout.minRunwayEdgeMarginFt) != null
        ? `${Math.round(rollout.conservativeRunwayEdgeMarginFt ?? rollout.minRunwayEdgeMarginFt)} ft (aircraft reference point)`
        : null,
    );
    pushMetricRow(
      rolloutRows,
      'samples',
      'Coverage',
      Number.isFinite(Number(rollout.sampleCount))
        ? `${Math.round(rollout.sampleCount)} samples / ${Math.round(Number(rollout.durationMs || 0) / 1000)}s`
        : null,
    );

    const noteParts = ['Separate from the approach stability score.'];
    if (rollout.lateralDataQuality === 'low') {
      noteParts.push(`Lateral result is low precision (\u00b1${Math.round(Number(rollout.lateralUncertaintyFt || 0))} ft coordinate uncertainty).`);
    } else if (rollout.lateralDataQuality === 'medium') {
      noteParts.push('Lateral result has medium coordinate precision.');
    }
    if (Array.isArray(rollout.flags) && rollout.flags.length > 0) {
      noteParts.push(rollout.flags.map((flag) => flag.label).filter(Boolean).join('; '));
    }
    sections.push({
      key: 'rollout-analysis',
      title: 'Rollout Analysis',
      rows: rolloutRows,
      noteText: noteParts.join(' '),
      emptyText: '',
    });
  }

  if (event.ultimateStability) {
    const stability = event.ultimateStability;
    const contextSummary = getStabilityContextSummary(
      stability.scoringContext,
      event.aircraftProfileId || event.aircraft_profile_id,
    );
    const stabilityRows = [];
    pushMetricRow(
      stabilityRows,
      'gate-stable',
      'Approach Verdict',
      presentation.approachText,
      getStabilityVerdictClass(presentation.stabilityVerdict),
    );
    if (Array.isArray(stability.gateFailures) && stability.gateFailures.length > 0) {
      const visibleGateFailures = stability.gateFailures.filter((failure) => (
        !RETIRED_STABILITY_FAILURES.has(String(failure || '').trim())
      ));
      if (visibleGateFailures.length > 0) {
        pushMetricRow(
          stabilityRows,
          'gate-failures',
          'Strict Check Findings',
          visibleGateFailures.map(stabilityFailureLabel).join(', '),
        );
      }
    }
    pushMetricRow(stabilityRows, 'score', 'Approach Score', typeof stability.score === 'number' ? `${Math.round(stability.score)}%` : null);
    pushMetricRow(stabilityRows, 'samples', 'Samples', typeof stability.samples === 'number' ? stability.samples : null);
    pushMetricRow(stabilityRows, 'profile', 'Scoring Profile', contextSummary.label);

    const breakdown = stability.breakdown && typeof stability.breakdown === 'object' ? stability.breakdown : null;
    if (breakdown) {
      const metricMap = [
        ['config_ok', 'Config'],
        ['gear_ok', 'Gear'],
        ['flaps_ok', 'Flaps'],
        ['spoilers_ok', 'Spoilers'],
        ['speed_ok', 'Airspeed'],
        ['speed_trend_ok', 'Speed Trend'],
        ['vs_ok', 'V/S'],
        ['glidepath_ok', 'Path Rate'],
        ['glidepath_below_ok', 'Path Rate (Steep)'],
        ['glidepath_above_ok', 'Path Rate (Shallow)'],
        ['thrust_ok', 'Throttle Movement'],
        ['pitch_ok', 'Pitch'],
        ['bank_ok', 'Bank'],
        ['lateral_offset_ok', 'Lateral Offset'],
      ];
      for (const [key, label] of metricMap) {
        if (HIDDEN_STABILITY_METRICS.has(key)) continue;
        if (typeof breakdown[key] === 'number') {
          const criterion = getStabilityMetricShortCriterion(key, stability.scoringContext);
          pushMetricRow(
            stabilityRows,
            key,
            criterion ? `${label} (${criterion})` : label,
            `${Math.round(breakdown[key])}%`,
            getStabilityMetricClass(breakdown[key]),
          );
        }
      }
    }

    sections.push({
      key: 'retrospective-stability',
      title: 'Approach Stability',
      rows: stabilityRows,
      noteText: [
        contextSummary.detail,
        `Stable requires every applicable strict check to meet its recorded ${presentation.stabilityPassPct}% threshold after the ${presentation.stabilityGateLabel} gate. Marginal means only soft/proxy checks missed that strict threshold.`,
      ].filter(Boolean).join(' '),
      emptyText: '',
    });
  }

  return sections;
}

export function buildLandingApproachProfileHtml(event, approachProfileApi) {
  if (!approachProfileApi || typeof approachProfileApi.buildSvg !== 'function' || !Array.isArray(event?.approachProfile) || event.approachProfile.length < approachProfileApi.MIN_PROFILE_POINTS) {
    return '';
  }

  const presentation = buildLandingPresentation(event);
  const verdict = presentation.verdict;
  const landingForSvg = {
    vs_fpm: event.vs_fpm,
    pitch_deg: event.pitch_deg,
    touchdownDistance: event.touchdownDistance || null,
    ultimateStability: event.ultimateStability || null,
    grade: event.grade || null,
    color: presentation.touchdownColor,
    bounceCount: event.bounceCount,
    bounceGrade: event.bounceGrade,
    shortLanding: verdict.flags.shortLanding,
    runwayExcursion: verdict.flags.runwayExcursion,
    runwayReferenceElevFt: Number.isFinite(event.runwayReferenceElevFt)
      ? event.runwayReferenceElevFt
      : (Number.isFinite(event.thresholdElevFt) ? event.thresholdElevFt : null),
    thresholdElevFt: Number.isFinite(event.thresholdElevFt)
      ? event.thresholdElevFt
      : (Number.isFinite(event.runwayReferenceElevFt) ? event.runwayReferenceElevFt : null),
  };

  return approachProfileApi.buildSvg(event.approachProfile, landingForSvg, { idSuffix: '-tl' });
}

export function buildLandingTopdownProfileHtml(event, approachProfileApi) {
  if (!approachProfileApi || typeof approachProfileApi.buildTopDownSvg !== 'function' || !Array.isArray(event?.approachProfile) || event.approachProfile.length < approachProfileApi.MIN_PROFILE_POINTS) {
    return '';
  }

  const touchdownDistance = event.touchdownDistance
    ? {
        ...event.touchdownDistance,
        runwayLengthFt: event.touchdownDistance.runwayLengthFt
          ?? event.touchdownDistance.runwayPhysicalLengthFt
          ?? (Number.isFinite(event.runway?.length_ft) ? event.runway.length_ft : null),
        runwayWidthFt: event.touchdownDistance.runwayWidthFt
          ?? (Number.isFinite(event.runway?.width_ft) ? event.runway.width_ft : null),
      }
    : null;
  const runwayThreshold = touchdownDistance?.runwayThresholdLat != null && touchdownDistance?.runwayThresholdLon != null
    ? { lat: touchdownDistance.runwayThresholdLat, lon: touchdownDistance.runwayThresholdLon }
    : event.runway?.threshold || null;

  const landingForSvg = {
    runwayReferenceElevFt: Number.isFinite(event.runwayReferenceElevFt)
      ? event.runwayReferenceElevFt
      : (Number.isFinite(event.thresholdElevFt) ? event.thresholdElevFt : null),
    thresholdElevFt: Number.isFinite(event.thresholdElevFt)
      ? event.thresholdElevFt
      : (Number.isFinite(event.runwayReferenceElevFt) ? event.runwayReferenceElevFt : null),
    runwayHdg: Number.isFinite(touchdownDistance?.runwayHeadingTrueDeg)
      ? touchdownDistance.runwayHeadingTrueDeg
      : (Number.isFinite(event.runway?.heading) ? event.runway.heading : null),
    runway: event.runway?.runway_id || null,
    runwayThreshold,
    touchdownDistance,
    centerlineDev: Number.isFinite(event.centerlineDev) ? event.centerlineDev : null,
  };

  return approachProfileApi.buildTopDownSvg(event.approachProfile, landingForSvg, { idSuffix: '-tl-td' });
}

export function buildLandingDetailState(event, {
  approachProfileApi,
} = {}) {
  return {
    metricSections: buildLandingDetailSections(event),
    approachProfileHtml: buildLandingApproachProfileHtml(event, approachProfileApi),
    topdownProfileHtml: buildLandingTopdownProfileHtml(event, approachProfileApi),
  };
}
