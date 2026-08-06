import { buildLandingVerdict } from '../landing/scoring.js';
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

function getTouchdownGradeClass(event) {
  if (!event?.touchdownDistance) return '';
  const verdict = buildLandingVerdict(event, { touchdownDistance: event.touchdownDistance });
  if (verdict.flags.runwayExcursion) return 'text-red-400 font-semibold';
  const severity = verdict.touchdown.severity;
  if (severity >= 3) return 'text-red-400 font-semibold';
  if (severity >= 2) return 'text-orange-400 font-semibold';
  if (severity >= 1) return 'text-yellow-400 font-semibold';
  if (event.touchdownDistance.score >= 90) return 'text-green-400 font-semibold';
  if (event.touchdownDistance.score >= 70) return 'text-yellow-400 font-semibold';
  return 'text-amber-400 font-semibold';
}

export function buildLandingDetailSections(event) {
  const sections = [];
  if (!event || event.type !== 'landing') return sections;

  const snapshotRows = [];
  pushMetricRow(snapshotRows, 'ias', 'IAS', event.ias_kts != null ? `${Math.round(event.ias_kts)} kts` : null);
  pushMetricRow(snapshotRows, 'vs', 'V/S', event.vs_fpm != null ? `${Math.round(event.vs_fpm)} fpm` : null);
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
    event.runway ? `${event.runway.runway_id} (${event.runway.length_ft}ft)` : null,
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

  if (event.touchdownDistance) {
    const tdz = event.touchdownDistance;
    const touchdownRows = [];
    pushMetricRow(touchdownRows, 'distance', 'Distance', `${Math.round(tdz.distanceFt)}ft from threshold`);
    pushMetricRow(
      touchdownRows,
      'grade',
      'Grade',
      `${tdz.grade}${tdz.zone ? ` (${tdz.zone})` : ''}`,
      getTouchdownGradeClass(event),
    );
    const touchdownScore = Number(tdz.score);
    pushMetricRow(touchdownRows, 'score', 'Score', Number.isFinite(touchdownScore) ? `${Math.round(touchdownScore)}/100` : null);
    pushMetricRow(
      touchdownRows,
      'runway-excursion',
      'Runway Excursion',
      buildLandingVerdict(event, { touchdownDistance: tdz }).flags.runwayExcursion ? 'Yes' : null,
      'text-red-400 font-semibold',
    );

    if (event.runway && event.runway.length_ft) {
      const roundedDistance = Math.round(tdz.distanceFt);
      const remaining = event.runway.length_ft - roundedDistance;
      const pctUsed = ((roundedDistance / event.runway.length_ft) * 100).toFixed(1);
      pushMetricRow(touchdownRows, 'remaining', 'Remaining', `${remaining}ft (${pctUsed}% down runway)`);
    }

    if (tdz.lateralOffsetFt != null) {
      const side = tdz.lateralOffsetSide || 'center';
      pushMetricRow(
        touchdownRows,
        'lateral',
        'Lateral',
        `${Math.abs(Math.round(tdz.lateralOffsetFt))}ft ${side} (${tdz.lateralOffsetGrade || '--'})`,
      );
    }

    sections.push({
      key: 'touchdown-zone-analysis',
      title: 'Touchdown Zone Analysis',
      rows: touchdownRows,
      noteText: '',
      emptyText: '',
    });
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
    const gateStable = buildLandingVerdict(event, { ultimateStability: stability }).stability.gateStable;
    const stabilityRows = [];
    pushMetricRow(stabilityRows, 'profile', 'Scoring Profile', contextSummary.label);
    pushMetricRow(stabilityRows, 'score', 'Score', typeof stability.score === 'number' ? `${Math.round(stability.score)}%` : null);
    pushMetricRow(stabilityRows, 'samples', 'Samples', typeof stability.samples === 'number' ? stability.samples : null);
    pushMetricRow(
      stabilityRows,
      'gate-stable',
      'Gate Stable',
      gateStable != null ? (gateStable ? 'Yes' : 'No') : null,
    );
    if (Array.isArray(stability.gateFailures) && stability.gateFailures.length > 0) {
      const visibleGateFailures = stability.gateFailures.filter((failure) => (
        !RETIRED_STABILITY_FAILURES.has(String(failure || '').trim())
      ));
      pushMetricRow(
        stabilityRows,
        'gate-failures',
        'Gate Failures',
        visibleGateFailures.map(stabilityFailureLabel).join(', '),
      );
    }

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
          );
        }
      }
    }

    sections.push({
      key: 'retrospective-stability',
      title: 'Retrospective Stability',
      rows: stabilityRows,
      noteText: contextSummary.detail,
      emptyText: '',
    });
  }

  return sections;
}

export function buildLandingApproachProfileHtml(event, approachProfileApi) {
  if (!approachProfileApi || typeof approachProfileApi.buildSvg !== 'function' || !Array.isArray(event?.approachProfile) || event.approachProfile.length < approachProfileApi.MIN_PROFILE_POINTS) {
    return '';
  }

  const tdzGrade = event.touchdownDistance ? event.touchdownDistance.grade : null;
  const verdict = buildLandingVerdict(event, { touchdownDistance: event.touchdownDistance });
  const landingForSvg = {
    vs_fpm: event.vs_fpm,
    pitch_deg: event.pitch_deg,
    touchdownDistance: event.touchdownDistance || null,
    grade: tdzGrade,
    color: approachProfileApi.gradeToColor(tdzGrade),
    shortLanding: verdict.flags.shortLanding,
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
