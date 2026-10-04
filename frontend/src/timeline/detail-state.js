import { buildLandingDetailState } from './landing-detail.js';
import { MARKER_LABELS, RULE_DESCRIPTIONS, RULE_LABELS, TYPE_LABELS } from './constants.js';
import { alertTone, approachEpisodeDetails } from './alert-presentation.js';

function humanizeMetricKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatMetricValue(value) {
  if (typeof value === 'number') return value.toFixed(2);
  if (value === null || value === undefined || value === '') return '--';
  return String(value);
}

function getRuleTitle(ruleId) {
  if (RULE_LABELS[ruleId]) return RULE_LABELS[ruleId];
  return String(ruleId || '').replace(/_/g, ' ');
}

function buildTimelineMetricSections(event, ruleDescriptions = RULE_DESCRIPTIONS) {
  const approachRows = approachEpisodeDetails(event);
  if (approachRows) return [{ key: 'approach-episode', title: 'Approach episode', rows: approachRows,
    noteText: ruleDescriptions[event.ruleId] || '', emptyText: '' }];
  const ctx = { ...(event.context || event.metrics || {}) };
  const metricLabels = {};
  if (event.markerType === 'takeoff' && Array.isArray(ctx.flags)) {
    ctx.flags = ctx.flags.map((flag) => flag?.label ? `${flag.severity || 'caution'}: ${flag.label}` : '').filter(Boolean).join('; ') || 'None recorded';
  }
  if (event.markerType === 'takeoff') {
    const screen = ctx.takeoff_analysis?.screenHeight;
    metricLabels.runway_used_pct = 'Liftoff position (% from runway start)';
    metricLabels.liftoff_distance_ft = 'Liftoff position from runway start (ft)';
    metricLabels.runway_remaining_ft = 'Runway remaining at liftoff (ft)';
    metricLabels.max_pitch_deg = 'Max pitch during capture (deg)';
    metricLabels.roll_distance_ft = ctx.hop_count > 0
      ? 'Distance to final liftoff including airborne intervals (ft)' : 'Ground roll (ft)';
    metricLabels.screen_height_ft = 'Screen-height target (ft)';
    metricLabels.screen_height_remaining_ft = 'Runway remaining at observed height (ft)';
    if (screen?.heightSource === 'radio') metricLabels.screen_height_ft = 'Radio-height target (ft)';
    else if (screen?.heightSource === 'baro') metricLabels.screen_height_ft = 'Height-gain target from liftoff (ft)';
    else if (screen?.heightSource === 'plane') metricLabels.screen_height_ft = 'Geometric height-gain target from liftoff (ft)';
    if (typeof screen?.reached === 'boolean') {
      ctx.screen_height_observation = screen.reached ? 'Observed' : 'Not observed during capture';
      if (!screen.reached) ctx.screen_height_remaining_ft = null;
    }
    if (typeof ctx.roll_duration_s === 'number' && ctx.roll_duration_basis === 'capture') {
      ctx.roll_duration_s = `${ctx.roll_duration_s.toFixed(1)} (real time)`;
    }
    if (typeof ctx.rotation_rate_deg_s === 'number' && ctx.takeoff_analysis?.rotation?.timeBasis === 'capture') {
      ctx.rotation_rate_deg_s = `${ctx.rotation_rate_deg_s.toFixed(2)} (real time)`;
    }
    // Durable identity and original analysis travel with the marker for history
    // consistency; the inspector shows measurements and findings to the pilot.
    for (const key of ['takeoff_id', 'event_id', 'sample_index', 'takeoff_analysis', 'roll_duration_basis']) delete ctx[key];
  }
  if (event.type === 'phase_start') {
    if (event.previousPhase) ctx.previous_phase = event.previousPhase;
    if (event.newPhase) ctx.new_phase = event.newPhase;
  }
  const noteFromContext = typeof ctx.note === 'string' ? ctx.note : null;
  delete ctx.note;

  if ((event.repeatCount || 1) > 1) {
    ctx.repeatCount = event.repeatCount;
    if (typeof event.repeatSpanMs === 'number' && event.repeatSpanMs > 0) {
      ctx.repeatSpanSec = (event.repeatSpanMs / 1000).toFixed(1);
    }
  }

  const rows = Object.entries(ctx).map(([key, value]) => ({
    key,
    label: metricLabels[key] || humanizeMetricKey(key),
    value: formatMetricValue(value),
    valueClass: 'text-gray-300 font-mono',
  }));

  const noteText = noteFromContext
    || (event.ruleId && ruleDescriptions[event.ruleId])
    || '';

  return [{
    key: 'event-context',
    title: rows.length > 0 ? 'Event Details' : '',
    rows,
    noteText,
    emptyText: rows.length === 0 ? 'No additional measurements were recorded for this event.' : '',
  }];
}

export function buildTimelineEventDetailState(event, {
  approachProfileApi,
  typeLabels = TYPE_LABELS,
  markerLabels = MARKER_LABELS,
  ruleDescriptions = RULE_DESCRIPTIONS,
} = {}) {
  if (!event) {
    return {
      visible: false,
      selectedLandingEvent: null,
    };
  }

  if (event.type === 'landing') {
    const runway = event.runway ? `${event.runway.airport_icao} ${event.runway.runway_id}` : 'Unknown Runway';
    const landingState = buildLandingDetailState(event, { approachProfileApi });
    return {
      visible: true,
      type: typeLabels[event.type] || event.type,
      title: `Landing at ${runway}`,
      metricSections: landingState.metricSections,
      approachProfileHtml: landingState.approachProfileHtml,
      topdownProfileHtml: landingState.topdownProfileHtml,
      landingActionVisible: true,
      selectedLandingEvent: event,
    };
  }

  if (event.type === 'automation_event' || event.type === 'flight_guidance_event') {
    return {
      visible: true,
      type: typeLabels[event.type] || event.type,
      title: event.label || String(
        event.eventType || (event.type === 'flight_guidance_event'
          ? 'Flight guidance changed'
          : 'Automation event'),
      ).replace(/_/g, ' '),
      metricSections: buildTimelineMetricSections(event, ruleDescriptions),
      approachProfileHtml: '',
      topdownProfileHtml: '',
      landingActionVisible: false,
      selectedLandingEvent: null,
    };
  }

  const title = event.reason
    ? event.reason
    : event.label
      ? event.label
    : event.newPhase
      ? `Phase: ${event.newPhase}`
      : event.ruleId
        ? getRuleTitle(event.ruleId)
        : event.markerType
          ? (markerLabels[event.markerType] || event.markerType)
          : event.type;

  return {
    visible: true,
    type: event.type === 'violation_start' ? (alertTone(event) === 'caution' ? 'Caution' : 'Violation')
      : event.type === 'violation_end' ? 'Episode ended' : typeLabels[event.type] || event.type,
    title,
    metricSections: buildTimelineMetricSections(event, ruleDescriptions),
    approachProfileHtml: '',
    topdownProfileHtml: '',
    landingActionVisible: false,
    selectedLandingEvent: null,
  };
}
