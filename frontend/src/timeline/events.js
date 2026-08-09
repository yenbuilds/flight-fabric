import { buildLandingPresentation, gradeSeverity } from '../landing/scoring.js';
import { RULE_END_LABELS, RULE_LABELS, VIOLATION_RULE } from './constants.js';

export function describeViolation(violation, descriptions = {}) {
  if (!violation) return null;
  return violation.context?.note || violation.metrics?.note || descriptions[violation.ruleId] || null;
}

function resolveEventType(event) {
  const type = String(event?.type || '');
  if (type.includes('phase')) return 'phase';
  if (type.includes('violation')) return 'violation';
  if (type === 'automation_event') return 'automation';
  if (type === 'configuration_event') return 'marker';
  if (type.includes('score')) return 'score';
  return 'marker';
}

function createBadge(text, tone = '') {
  return {
    text: String(text || '--'),
    toneClass: tone,
  };
}

function getViolationLabel(event, fallback = 'violation') {
  if (event?.label) return event.label;
  if (RULE_LABELS[event?.ruleId]) return RULE_LABELS[event.ruleId];
  return (event?.ruleId || fallback).replace(/_/g, ' ');
}

function humanizeAutomationToken(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\.]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function formatConfidenceBadge(confidence) {
  const value = String(confidence || '').trim();
  if (!value) return null;
  if (value === 'profile-confirmed') return createBadge('Profile data', 'positive');
  if (value === 'simconnect') return createBadge('Sim');
  if (value === 'inferred') return createBadge('Inferred');
  if (value === 'unreliable') return createBadge('Unreliable', 'negative');
  if (value === 'unavailable') return createBadge('Limited', 'negative');
  return createBadge(humanizeAutomationToken(value));
}

export function buildTimelineEventRowState(event, index, startMs, {
  typeLabels = {},
  markerLabels = {},
  formatTimeOffset = (ms) => String(ms),
} = {}) {
  const type = resolveEventType(event);
  const timeOffsetText = formatTimeOffset(event.timestampMs - startMs);

  let title = '';
  let subtitle = '';
  const badges = [];
  const count = Number.isFinite(Number(event.repeatCount)) ? Math.max(1, Math.round(Number(event.repeatCount))) : 1;

  if (event.type === 'phase_start') {
    title = event.newPhase || 'Unknown Phase';
    subtitle = event.previousPhase ? `from ${event.previousPhase}` : '';
  } else if (event.type === 'violation_start') {
    title = getViolationLabel(event).toUpperCase();
    subtitle = event.severity || '';
    if (event.ruleId === VIOLATION_RULE.HIGH_SINK_RATE) {
      const peakFpm = Number(event.context?.peak_sink_rate_fpm);
      const durationMs = Number(event.context?.duration_ms);
      const details = [event.severity || ''];
      if (Number.isFinite(peakFpm)) details.push(`peak ${Math.round(peakFpm)} fpm`);
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        details.push(`${(durationMs / 1000).toFixed(1)}s`);
      }
      subtitle = details.filter(Boolean).join(' · ');
    }
  } else if (event.type === 'violation_end') {
    const violationLabel = getViolationLabel(event);
    title = RULE_END_LABELS[event.ruleId] || `${violationLabel} ended`;
    if (event.scoreImpact) {
      badges.push(createBadge(event.scoreImpact, 'negative'));
    }
  } else if (event.type === 'score_change') {
    title = event.reason || 'Score Change';
    if (event.scoreDelta) {
      const tone = event.scoreDelta < 0 ? 'negative' : 'positive';
      const sign = event.scoreDelta > 0 ? '+' : '';
      badges.push(createBadge(`${sign}${event.scoreDelta}`, tone));
    }
  } else if (event.type === 'score_final') {
    title = `Final ${event.scoreType || 'Score'}: ${event.finalScore ?? '--'}`;
  } else if (event.type === 'automation_event') {
    title = event.label || humanizeAutomationToken(event.eventType) || 'Automation event';
    subtitle = event.summary || event.context?.summary || '';

    const confidenceBadge = formatConfidenceBadge(event.confidence || event.context?.confidence);
    if (confidenceBadge) badges.push(confidenceBadge);

    const raFt = Number(event.raFt ?? event.context?.ra_ft);
    if (event.eventType === 'ap_disengaged' && Number.isFinite(raFt)) {
      badges.push(createBadge(`${Math.round(raFt)}ft RA`));
    }
  } else if (event.type === 'configuration_event') {
    title = event.label || humanizeAutomationToken(event.eventType) || 'Configuration changed';
    subtitle = event.summary || event.context?.summary || '';

    const confidenceBadge = formatConfidenceBadge(event.confidence || event.context?.confidence);
    if (confidenceBadge) badges.push(confidenceBadge);
  } else if (event.type === 'marker') {
    title = markerLabels[event.markerType] || event.markerType || 'Marker';
    if (event.markerType === 'go_around') {
      const parts = [];
      const altitudeFt = Number(event.context?.altitude_ft ?? event.context?.ra);
      if (Number.isFinite(altitudeFt)) parts.push(`Initiated at ${Math.round(altitudeFt)}ft`);
      if (event.context?.previous_phase) parts.push(`from ${event.context.previous_phase}`);
      if (event.context?.late) parts.push('Possible late');
      subtitle = parts.join(' - ');
    } else if (event.context?.ra !== undefined) {
      subtitle = `RA: ${Math.round(event.context.ra)}ft`;
    }
    if (event.context?.vs_fpm !== undefined && event.markerType !== 'go_around') {
      subtitle = `VS: ${Math.round(event.context.vs_fpm)}fpm`;
    }
  } else if (event.type === 'landing') {
    const runway = event.runway ? `${event.runway.airport_icao} ${event.runway.runway_id}` : 'Unknown';
    title = `Landing at ${runway}`;
    const presentation = buildLandingPresentation(event);
    const verdict = presentation.verdict;

    const parts = [];
    if (event.ias_kts != null) parts.push(`${Math.round(event.ias_kts)} kts`);
    if (event.vs_fpm != null) parts.push(`TD rate ${Math.round(event.vs_fpm)} fpm`);

    if (presentation.touchdownGrade !== '--') {
      const touchdownTone = presentation.touchdownSeverity >= 3 ? 'negative'
        : presentation.touchdownSeverity === 0 ? 'positive' : '';
      badges.push(createBadge(`TD RATE ${presentation.touchdownGrade}`, touchdownTone));
    }

    if (presentation.approachText) {
      parts.push(`Approach ${presentation.approachText}`);
      badges.push(createBadge(
        `APP ${presentation.approachText}`,
        verdict.stability.verdict === 'unstable'
          ? 'negative'
          : verdict.stability.verdict === 'marginal'
            ? 'warning'
            : verdict.stability.verdict === 'stable' ? 'positive' : '',
      ));
    }
    if (presentation.approachScoreText) parts.push(presentation.approachScoreText);

    if (presentation.bounceKnown) {
      parts.push(`Bounce ${presentation.bounceText}`);
      badges.push(createBadge(
        `BNC ${presentation.bounceText}`,
        presentation.bounceCount > 0 && verdict.bounce.severity >= 3 ? 'negative'
          : presentation.bounceCount === 0 ? 'positive' : '',
      ));
    }

    if (event.touchdownDistance) {
      const tdz = event.touchdownDistance;
      const tdzDistanceFt = Number(tdz.distanceFt);
      if (Number.isFinite(tdzDistanceFt)) {
        parts.push(`${Math.round(tdzDistanceFt)}ft TDZ${tdz.grade ? ` (${tdz.grade})` : ''}`);
      } else if (tdz.grade) {
        parts.push(`TDZ ${tdz.grade}`);
      }

      if (tdz.grade) {
        const tdzSeverity = gradeSeverity(tdz.grade);
        badges.push(createBadge(
          `TDZ ${String(tdz.grade).toUpperCase()}`,
          tdzSeverity >= 2 ? 'negative' : tdzSeverity === 0 ? 'positive' : '',
        ));
      }

      if (tdz.lateralOffsetFt != null) {
        const latAbs = Math.abs(tdz.lateralOffsetFt);
        const latSide = (tdz.lateralOffsetSide || 'center').charAt(0).toUpperCase();
        parts.push(latAbs < 5 ? 'CL' : `${latAbs}ft ${latSide}`);
      }

      if (tdz.lateralOffsetGrade === 'Poor' || tdz.lateralOffsetGrade === 'Excursion') {
        badges.push(createBadge(tdz.lateralOffsetGrade, 'negative'));
      }
    }

    if (verdict.flags.runwayExcursion) {
      parts.push('Runway excursion');
      badges.push(createBadge('RUNWAY EXCURSION', 'negative'));
    }

    if (event.rolloutAnalysis) {
      const rolloutAssessment = String(event.rolloutAnalysis.assessment || 'normal').toUpperCase();
      parts.push(`Rollout ${rolloutAssessment}`);
      badges.push(createBadge(
        `ROLLOUT ${rolloutAssessment}`,
        rolloutAssessment === 'CRITICAL' || rolloutAssessment === 'WARNING'
          ? 'negative'
          : rolloutAssessment === 'NORMAL'
            ? 'positive'
            : '',
      ));
    }

    subtitle = parts.join(' - ');
  } else {
    title = typeLabels[event.type] || event.type;
  }

  return {
    rowKey: `timeline-row-${index}-${event.timestampMs ?? startMs}-${event.type || 'event'}`,
    event,
    index,
    type,
    title: String(title || '--'),
    subtitle: String(subtitle || ''),
    timeOffsetText,
    badges,
    countText: count > 1 ? `x${count}` : '',
    originalIndexStart: Number(event?._originalIndexStart ?? index),
    originalIndexEnd: Number(event?._originalIndexEnd ?? index),
  };
}

export function buildTimelineEventRows(events, {
  startMs,
  rowOptions = {},
} = {}) {
  return (Array.isArray(events) ? events : []).map((event, index) =>
    buildTimelineEventRowState(event, index, startMs, rowOptions));
}
