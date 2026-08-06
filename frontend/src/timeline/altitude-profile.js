const PROFILE_WIDTH = 640;
const PROFILE_HEIGHT = 96;
const PROFILE_PADDING = Object.freeze({
  top: 12,
  right: 16,
  bottom: 18,
  left: 22,
});
const PROFILE_POINT_LIMIT = 240;

export const DEFAULT_ALTITUDE_PROFILE_STATE = Object.freeze({
  visible: false,
  emptyVisible: false,
  pathD: '',
  fillD: '',
  cursorVisible: false,
  cursorX: '0',
  cursorY: '0',
  currentText: '-- ft',
  rangeText: '--',
  minText: '--',
  maxText: '--',
});

function formatSvgNumber(value) {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 10) / 10);
}

export function formatAltitudeProfileFeet(value) {
  if (!Number.isFinite(value)) return '--';
  return `${Math.round(value).toLocaleString()} ft`;
}

function downsampleProfilePoints(points, limit = PROFILE_POINT_LIMIT) {
  if (!Array.isArray(points)) return [];
  if (points.length <= limit) return points;

  const result = [];
  const step = (points.length - 1) / (Math.max(2, limit) - 1);
  for (let i = 0; i < limit; i += 1) {
    result.push(points[Math.max(0, Math.min(points.length - 1, Math.round(i * step)))]);
  }
  return result;
}

function getInterpolatedAltitudeAtMs(points, targetMs) {
  if (!Array.isArray(points) || points.length === 0 || !Number.isFinite(targetMs)) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (targetMs <= first.timestampMs) return first.altFt;
  if (targetMs >= last.timestampMs) return last.altFt;

  let left = 0;
  let right = points.length - 1;
  let upperIdx = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (points[mid].timestampMs >= targetMs) {
      upperIdx = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  if (upperIdx <= 0) return first.altFt;
  const upper = points[upperIdx];
  const lower = points[upperIdx - 1];
  const spanMs = upper.timestampMs - lower.timestampMs;
  if (spanMs <= 0) return upper.altFt;
  const ratio = (targetMs - lower.timestampMs) / spanMs;
  return lower.altFt + (upper.altFt - lower.altFt) * ratio;
}

function buildDefaultProfileModel() {
  return {
    ready: false,
    state: { ...DEFAULT_ALTITUDE_PROFILE_STATE },
    altitudePoints: [],
    startMs: null,
    endMs: null,
    durationMs: 0,
  };
}

export function buildTimelineAltitudeProfileModel(points, {
  startMs = null,
  endMs = null,
} = {}) {
  const altitudePoints = (Array.isArray(points) ? points : [])
    .map((point) => {
      const rawTimestampMs = point?.timestampMs;
      const rawAltFt = point?.altFt;
      if (rawTimestampMs == null || rawAltFt == null || rawTimestampMs === '' || rawAltFt === '') return null;
      const timestampMs = Number(rawTimestampMs);
      const altFt = Number(rawAltFt);
      if (!Number.isFinite(timestampMs) || !Number.isFinite(altFt)) return null;
      return {
        timestampMs,
        altFt: Math.max(0, altFt),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (altitudePoints.length < 2) {
    return buildDefaultProfileModel();
  }

  const resolvedStartMs = Number.isFinite(Number(startMs)) ? Number(startMs) : altitudePoints[0].timestampMs;
  const resolvedEndMs = Number.isFinite(Number(endMs)) ? Number(endMs) : altitudePoints[altitudePoints.length - 1].timestampMs;
  const durationMs = resolvedEndMs - resolvedStartMs;
  if (durationMs <= 0) {
    return buildDefaultProfileModel();
  }

  const minAlt = Math.min(...altitudePoints.map((point) => point.altFt));
  const maxAlt = Math.max(...altitudePoints.map((point) => point.altFt));
  const altSpan = Math.max(100, maxAlt - minAlt);
  const lowerBound = Math.max(0, minAlt - altSpan * 0.08);
  const upperBound = Math.max(lowerBound + 100, maxAlt + altSpan * 0.08);
  const plotWidth = PROFILE_WIDTH - PROFILE_PADDING.left - PROFILE_PADDING.right;
  const plotHeight = PROFILE_HEIGHT - PROFILE_PADDING.top - PROFILE_PADDING.bottom;
  const plotBottom = PROFILE_HEIGHT - PROFILE_PADDING.bottom;

  const toX = (timestampMs) => PROFILE_PADDING.left + ((timestampMs - resolvedStartMs) / durationMs) * plotWidth;
  const toY = (altFt) => PROFILE_PADDING.top + plotHeight - ((altFt - lowerBound) / (upperBound - lowerBound)) * plotHeight;
  const sampled = downsampleProfilePoints(altitudePoints)
    .map((point) => ({
      x: Math.max(PROFILE_PADDING.left, Math.min(PROFILE_WIDTH - PROFILE_PADDING.right, toX(point.timestampMs))),
      y: Math.max(PROFILE_PADDING.top, Math.min(plotBottom, toY(point.altFt))),
    }));

  if (sampled.length < 2) {
    return buildDefaultProfileModel();
  }

  const pathD = sampled
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`)
    .join(' ');
  const first = sampled[0];
  const last = sampled[sampled.length - 1];
  const fillD = `M ${formatSvgNumber(first.x)} ${formatSvgNumber(plotBottom)} ${pathD.slice(2)} L ${formatSvgNumber(last.x)} ${formatSvgNumber(plotBottom)} Z`;

  return {
    ready: true,
    state: {
      visible: true,
      emptyVisible: false,
      pathD,
      fillD,
      cursorVisible: false,
      cursorX: '0',
      cursorY: '0',
      currentText: DEFAULT_ALTITUDE_PROFILE_STATE.currentText,
      rangeText: `${formatAltitudeProfileFeet(minAlt)} - ${formatAltitudeProfileFeet(maxAlt)}`,
      minText: formatAltitudeProfileFeet(minAlt),
      maxText: formatAltitudeProfileFeet(maxAlt),
    },
    altitudePoints,
    startMs: resolvedStartMs,
    endMs: resolvedEndMs,
    durationMs,
    toX,
    toY,
    plotBottom,
  };
}

export function updateTimelineAltitudeProfileCursor(model, offsetMs = 0) {
  if (!model?.ready) return { ...DEFAULT_ALTITUDE_PROFILE_STATE };

  const durationMs = Number(model.durationMs);
  const startMs = Number(model.startMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(startMs)) {
    return { ...DEFAULT_ALTITUDE_PROFILE_STATE };
  }

  const clampedOffsetMs = Math.max(0, Math.min(durationMs, Number(offsetMs) || 0));
  const cursorTimestampMs = startMs + clampedOffsetMs;
  const cursorAlt = getInterpolatedAltitudeAtMs(model.altitudePoints, cursorTimestampMs);
  const cursorX = Math.max(PROFILE_PADDING.left, Math.min(PROFILE_WIDTH - PROFILE_PADDING.right, model.toX(cursorTimestampMs)));
  const cursorY = Number.isFinite(cursorAlt)
    ? Math.max(PROFILE_PADDING.top, Math.min(model.plotBottom, model.toY(cursorAlt)))
    : model.plotBottom;

  return {
    ...model.state,
    cursorVisible: Number.isFinite(cursorAlt),
    cursorX: formatSvgNumber(cursorX),
    cursorY: formatSvgNumber(cursorY),
    currentText: formatAltitudeProfileFeet(cursorAlt),
  };
}

export function buildTimelineAltitudeProfileState(points, {
  offsetMs = 0,
  startMs = null,
  endMs = null,
} = {}) {
  return updateTimelineAltitudeProfileCursor(
    buildTimelineAltitudeProfileModel(points, { startMs, endMs }),
    offsetMs,
  );
}
