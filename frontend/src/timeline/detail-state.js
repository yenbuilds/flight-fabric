import { buildLandingDetailState } from './landing-detail.js';
import { MARKER_LABELS, RULE_DESCRIPTIONS, RULE_LABELS, TYPE_LABELS } from './constants.js';

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

export function buildTimelineMetricSections(event, ruleDescriptions = RULE_DESCRIPTIONS) {
  const ctx = { ...(event.context || event.metrics || {}) };
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
    label: humanizeMetricKey(key),
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
    emptyText: rows.length === 0 ? 'No metrics' : '',
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
    type: typeLabels[event.type] || event.type,
    title,
    metricSections: buildTimelineMetricSections(event, ruleDescriptions),
    approachProfileHtml: '',
    topdownProfileHtml: '',
    landingActionVisible: false,
    selectedLandingEvent: null,
  };
}
