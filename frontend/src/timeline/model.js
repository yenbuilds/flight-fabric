import {
  formatDistanceNm,
  formatDuration,
  formatFuelBurn,
  getFiniteDistanceNm,
  getFiniteFuelBurnGal,
} from '../utils/formatting.js';

export { formatDuration };

const FUEL_UNIT_LS_KEY = 'ff-fuel-unit';

function getStorageRef() {
  return typeof globalThis !== 'undefined' && globalThis.localStorage
    ? globalThis.localStorage
    : null;
}

function getFuelUnit() {
  const storage = getStorageRef();
  if (!storage) return 'gal';

  try {
    const unit = storage.getItem(FUEL_UNIT_LS_KEY);
    return unit === 'lbs' || unit === 'kg' ? unit : 'gal';
  } catch {
    return 'gal';
  }
}

export function getTimelineFuelSummary(timeline) {
  const fuelBurnGal = getFiniteFuelBurnGal(timeline?.fuelBurnGal);
  const fuelBurnWeightLbs = Number(timeline?.fuelBurnWeightLbs);
  const unit = getFuelUnit();
  if ((unit === 'gal' && fuelBurnGal !== null) || (unit !== 'gal' && Number.isFinite(fuelBurnWeightLbs) && fuelBurnWeightLbs > 10)) {
    return {
      text: formatFuelBurn(fuelBurnGal, unit, fuelBurnWeightLbs),
      className: 'font-semibold text-sky-300',
    };
  }
  return {
    text: '--',
    className: 'font-semibold text-gray-500',
  };
}

function getTrackPointCoordinate(point) {
  const lat = Number(point?.lat ?? point?.latDeg ?? point?.lat_deg);
  const lon = Number(point?.lon ?? point?.lonDeg ?? point?.lon_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (Math.abs(lat) <= 1e-6 && Math.abs(lon) <= 1e-6) return null;
  return { lat, lon };
}

function getDistanceNmBetweenCoordinates(a, b) {
  if (!a || !b) return null;
  const earthRadiusNm = 3440.065;
  const toRad = (deg) => deg * Math.PI / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusNm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function calculateTrackDistanceNm(track) {
  let previousCoord = null;
  let totalDistanceNm = 0;

  for (const point of Array.isArray(track) ? track : []) {
    const coord = getTrackPointCoordinate(point);
    if (!coord) continue;
    const segmentNm = previousCoord ? getDistanceNmBetweenCoordinates(previousCoord, coord) : null;
    if (segmentNm !== null) totalDistanceNm += segmentNm;
    previousCoord = coord;
  }

  return getFiniteDistanceNm(totalDistanceNm);
}

export function getTimelineDistanceText(timeline) {
  const distanceNm = getFiniteDistanceNm(timeline?.distanceNm) ?? calculateTrackDistanceNm(timeline?.track);
  return distanceNm !== null ? formatDistanceNm(distanceNm) : '--';
}

export function compactTimelineEvents(events, options = {}) {
  const maxGapMs = options.maxGapMs ?? 2500;
  if (!Array.isArray(events) || events.length === 0) return [];

  function getRepeatKey(event) {
    if (!event || !event.type) return null;

    if (event.type === 'violation_start' || event.type === 'violation_end') {
      return `${event.type}:${event.ruleId || ''}:${event.severity || ''}`;
    }

    if (event.type === 'marker') {
      return `marker:${event.markerType || ''}`;
    }

    return null;
  }

  const compacted = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const key = getRepeatKey(event);
    const last = compacted[compacted.length - 1];

    if (!key || !last || last._repeatKey !== key) {
      compacted.push({
        ...event,
        repeatCount: 1,
        repeatSpanMs: 0,
        _repeatKey: key,
        _originalIndexStart: i,
        _originalIndexEnd: i,
        _lastTimestampMs: event?.timestampMs,
      });
      continue;
    }

    const lastTs = last._lastTimestampMs ?? last.timestampMs;
    const thisTs = event?.timestampMs;
    const gapMs = (typeof thisTs === 'number' && typeof lastTs === 'number')
      ? (thisTs - lastTs)
      : Number.POSITIVE_INFINITY;

    if (gapMs <= maxGapMs) {
      last.repeatCount = (last.repeatCount || 1) + 1;
      last._originalIndexEnd = i;
      last._lastTimestampMs = thisTs;
      const startTs = last.timestampMs;
      if (typeof startTs === 'number' && typeof thisTs === 'number') {
        last.repeatSpanMs = Math.max(0, thisTs - startTs);
      }
      continue;
    }

    compacted.push({
      ...event,
      repeatCount: 1,
      repeatSpanMs: 0,
      _repeatKey: key,
      _originalIndexStart: i,
      _originalIndexEnd: i,
      _lastTimestampMs: thisTs,
    });
  }

  return compacted.map((event) => {
    const { _repeatKey, _lastTimestampMs, ...rest } = event;
    return rest;
  });
}

export function normalizeTimelineForUI(timeline) {
  if (!timeline || !Array.isArray(timeline.events)) return timeline;

  function normalizeEvent(event) {
    if (!event || typeof event !== 'object') return event;
    if (event.type && typeof event.timestampMs === 'number') return event;

    const type = event.type || event.event_type;
    const timestampMs = event.timestampMs ?? event.timestamp_ms ?? event.timestamp_start;

    return {
      ...event,
      type,
      timestampMs: typeof timestampMs === 'number' ? timestampMs : (timestampMs ? Number(timestampMs) : undefined),
      ruleId: event.ruleId ?? event.rule_id,
      markerType: event.markerType ?? event.marker_type,
      scoreImpact: event.scoreImpact ?? event.score_impact,
      scoreDelta: event.scoreDelta ?? event.score_delta,
      scoreType: event.scoreType ?? event.score_type,
      finalScore: event.finalScore ?? event.final_score,
      newPhase: event.newPhase ?? event.phase_name,
      eventType: event.eventType ?? event.event_type,
      dataSource: event.dataSource ?? event.data_source,
      raFt: event.raFt ?? event.ra_ft,
      previousLabel: event.previousLabel ?? event.previous_label,
      currentLabel: event.currentLabel ?? event.current_label,
    };
  }

  const events = timeline.events.map(normalizeEvent).filter(Boolean);
  let worstMoment = timeline.worstMoment;

  if (worstMoment && (worstMoment.index === undefined || worstMoment.index === null)) {
    const eventId = worstMoment.eventId || worstMoment.event_id || worstMoment.worst_event_id;
    if (eventId) {
      const idx = events.findIndex((event) => event.id === eventId);
      if (idx >= 0) {
        worstMoment = { ...worstMoment, index: idx };
      }
    }
  }

  return {
    ...timeline,
    events,
    eventCount: timeline.eventCount ?? timeline.event_count ?? events.length,
    worstMoment,
  };
}

export function buildTimelineSummaryState(timeline, displayEvents) {
  const rawCount = timeline.eventCount ?? timeline.events.length;
  const shownCount = displayEvents.length;
  const violations = timeline.events.filter((event) => event.type === 'violation_start');
  const shownViolations = displayEvents.filter((event) => event.type === 'violation_start');
  const violationMoments = countViolationMoments(timeline.events);
  const shownViolationMoments = countViolationMoments(displayEvents);

  let durationText = '--';
  const timelineDurationMs = Number(timeline.durationMs);
  if (timeline.durationFormatted) {
    durationText = timeline.durationFormatted;
  } else if (Number.isFinite(timelineDurationMs) && timelineDurationMs >= 0) {
    durationText = formatDuration(timelineDurationMs);
  } else if (timeline.events.length > 1) {
    const firstTs = timeline.events[0].timestampMs;
    const lastTs = timeline.events[timeline.events.length - 1].timestampMs;
    durationText = formatDuration(lastTs - firstTs);
  }

  const fuelSummary = getTimelineFuelSummary(timeline);
  let totalImpact = 0;
  timeline.events.forEach((event) => {
    if (event.scoreDelta) totalImpact += event.scoreDelta;
    if (event.scoreImpact) totalImpact += event.scoreImpact;
  });

  return {
    visible: true,
    eventCountText: shownCount === rawCount ? String(rawCount) : `${rawCount} (${shownCount} shown)`,
    violationCountText: shownViolations.length === violations.length
      ? formatViolationMomentCount(violationMoments, violations.length)
      : `${formatViolationMomentCount(violationMoments, violations.length)}; ${shownViolationMoments} shown`,
    durationText,
    distanceText: getTimelineDistanceText(timeline),
    fuelBurnText: fuelSummary.text,
    fuelBurnClass: fuelSummary.className,
    scoreImpactText: totalImpact === 0 ? '0' : (totalImpact > 0 ? `+${totalImpact}` : String(totalImpact)),
    scoreImpactClass: `font-semibold ${totalImpact < 0 ? 'text-red-400' : totalImpact > 0 ? 'text-green-400' : 'text-gray-400'}`,
  };
}

export function countViolationMoments(events) {
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === 'violation_start' || event?.type === 'violation_end')
    .filter((event) => Number.isFinite(Number(event.timestampMs)))
    .slice()
    .sort((left, right) => Number(left.timestampMs) - Number(right.timestampMs));
  const activeByRule = new Map();
  const episodes = [];

  for (const event of ordered) {
    const ruleId = String(event.ruleId || event.rule_id || '');
    if (!ruleId) continue;
    const timestampMs = Number(event.timestampMs);

    if (event.type === 'violation_start') {
      const durationMs = Number(event.duration_ms ?? event.context?.duration_ms);
      const episode = {
        startMs: timestampMs,
        endMs: Number.isFinite(durationMs) && durationMs >= 0 ? timestampMs + durationMs : timestampMs,
      };
      episodes.push(episode);
      activeByRule.set(ruleId, episode);
      continue;
    }

    const episode = activeByRule.get(ruleId);
    if (!episode) continue;
    episode.endMs = Math.max(episode.endMs, timestampMs);
    activeByRule.delete(ruleId);
  }

  episodes.sort((left, right) => left.startMs - right.startMs);
  let moments = 0;
  let currentEndMs = Number.NEGATIVE_INFINITY;
  for (const episode of episodes) {
    if (episode.startMs > currentEndMs) {
      moments += 1;
      currentEndMs = episode.endMs;
    } else {
      currentEndMs = Math.max(currentEndMs, episode.endMs);
    }
  }
  return moments;
}

function formatViolationMomentCount(momentCount, triggerCount) {
  if (momentCount === triggerCount) return String(triggerCount);
  return `${momentCount} moments (${triggerCount} triggers)`;
}
