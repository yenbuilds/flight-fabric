export function eventCategory(event) {
  const type = String(event?.type || '').toLowerCase();
  if (type.startsWith('violation')) return 'violations';
  if (type === 'automation_event') return 'automation';
  if (type === 'flight_guidance_event') return 'flightGuidance';
  if (type === 'configuration_event') return 'markers';
  if (type === 'landing' || type === 'worst_moment') return 'landing';
  if (type === 'marker') return 'markers';
  if (type.startsWith('phase')) return 'phases';
  if (type.startsWith('score')) return 'scores';
  return null;
}

export function eventPassesMapFilter(event, filterState = {}) {
  const category = eventCategory(event);
  if (!category) return false;
  return filterState[category] === true;
}

export function getEventPosition(event, isValidCoord) {
  if (!event || typeof event !== 'object') return null;

  const candidates = [
    [event.lat, event.lon],
    [event.latitude, event.longitude],
    [event.lat_deg, event.lon_deg],
    [event.context?.lat, event.context?.lon],
    [event.context?.latitude, event.context?.longitude],
    [event.context?.lat_deg, event.context?.lon_deg],
    [event.context?.position?.lat, event.context?.position?.lon],
    [event.metrics?.lat, event.metrics?.lon],
    [event.metrics?.latitude, event.metrics?.longitude],
    [event.metrics?.lat_deg, event.metrics?.lon_deg],
  ];

  for (const [latRaw, lonRaw] of candidates) {
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (isValidCoord(lat, lon)) return { lat, lon };
  }

  return null;
}

export function getTimelineEventMarkerVisual(event) {
  const type = String(event?.type || '').toLowerCase();

  if (type === 'worst_moment') return { glyph: 'W', bg: '#7f1d1d', border: '#f87171', fg: '#ffffff', size: 11, shape: 'diamond' };
  if (type === 'landing') return { glyph: 'LDG', bg: '#14532d', border: '#4ade80', fg: '#f0fdf4', size: 9, shape: 'pill' };
  if (type === 'violation_start' || type === 'violation_end') return { glyph: '!', bg: '#7f1d1d', border: '#f87171', fg: '#fee2e2', size: 14, shape: 'round' };
  if (type === 'score_change' || type === 'score_final') return { glyph: 'S', bg: '#78350f', border: '#fbbf24', fg: '#fef3c7', size: 11, shape: 'round' };
  if (type === 'automation_event') return { glyph: 'AP', bg: '#134e4a', border: '#2dd4bf', fg: '#ccfbf1', size: 9, shape: 'pill' };
  if (type === 'flight_guidance_event') return { glyph: 'FG', bg: '#4c1d95', border: '#a78bfa', fg: '#ede9fe', size: 9, shape: 'pill' };
  if (type === 'configuration_event') {
    if (String(event?.eventType || '').toLowerCase() === 'spoilers_changed') {
      return { glyph: 'SP', bg: '#1e3a8a', border: '#60a5fa', fg: '#dbeafe', size: 8, shape: 'pill' };
    }
    return { glyph: 'F', bg: '#1e3a8a', border: '#60a5fa', fg: '#dbeafe', size: 10, shape: 'round' };
  }
  if (type === 'phase_start' || type === 'phase_end') return { glyph: 'P', bg: '#0f766e', border: '#2dd4bf', fg: '#ccfbf1', size: 11, shape: 'round' };
  if (type === 'marker') {
    const markerType = String(event?.markerType || '').toLowerCase();
    if (markerType.includes('touchdown')) return { glyph: 'TD', bg: '#1e3a8a', border: '#60a5fa', fg: '#dbeafe', size: 9, shape: 'pill' };
    if (markerType.includes('go_around')) return { glyph: 'GA', bg: '#1e3a8a', border: '#60a5fa', fg: '#dbeafe', size: 9, shape: 'pill' };
    return { glyph: 'M', bg: '#1e3a8a', border: '#60a5fa', fg: '#dbeafe', size: 10, shape: 'round' };
  }

  return { glyph: 'E', bg: '#334155', border: '#cbd5e1', fg: '#f8fafc', size: 10, shape: 'round' };
}

export function createTimelineMap() {
  return {
    eventCategory,
    eventPassesMapFilter,
    getEventPosition,
    getTimelineEventMarkerVisual,
  };
}
