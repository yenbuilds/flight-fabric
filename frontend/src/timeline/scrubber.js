export function formatTimeOffset(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function interpolateHeadingDeg(startDeg, endDeg, ratio) {
  if (!Number.isFinite(startDeg) && !Number.isFinite(endDeg)) return null;
  if (!Number.isFinite(startDeg)) return endDeg;
  if (!Number.isFinite(endDeg)) return startDeg;
  const shortestDelta = ((endDeg - startDeg + 540) % 360) - 180;
  return (startDeg + shortestDelta * ratio + 360) % 360;
}

export function interpolateLinear(start, end, ratio) {
  if (!Number.isFinite(start) && !Number.isFinite(end)) return null;
  if (!Number.isFinite(start)) return end;
  if (!Number.isFinite(end)) return start;
  return start + (end - start) * ratio;
}

export function getInterpolatedTrackPointAtMs(points, targetMs) {
  if (!Number.isFinite(targetMs) || !Array.isArray(points) || points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];

  if (targetMs <= first.timestampMs) return { ...first };
  if (targetMs >= last.timestampMs) return { ...last };

  let left = 0;
  let right = points.length - 1;
  let upperIdx = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const timestampMs = Number(points[mid]?.timestampMs);
    if (!Number.isFinite(timestampMs)) return null;
    if (timestampMs >= targetMs) {
      upperIdx = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  if (upperIdx <= 0) return { ...first };

  const upper = points[upperIdx];
  const lower = points[upperIdx - 1];
  const spanMs = upper.timestampMs - lower.timestampMs;
  if (spanMs <= 0) return { ...upper };

  const ratio = (targetMs - lower.timestampMs) / spanMs;
  return {
    lat: lower.lat + (upper.lat - lower.lat) * ratio,
    lon: lower.lon + (upper.lon - lower.lon) * ratio,
    timestampMs: targetMs,
    hdgTrueDeg: interpolateHeadingDeg(lower.hdgTrueDeg, upper.hdgTrueDeg, ratio),
    pitchDeg: interpolateLinear(lower.pitchDeg, upper.pitchDeg, ratio),
    rollDeg: interpolateLinear(lower.rollDeg, upper.rollDeg, ratio),
    iasKts: interpolateLinear(lower.iasKts, upper.iasKts, ratio),
    altFt: interpolateLinear(lower.altFt, upper.altFt, ratio),
  };
}

export function createScrubber({
  scrubberEl = null,
  timelineStore,
  onScrub = () => {},
  windowRef = typeof window !== 'undefined' ? window : null,
} = {}) {
  let startMs = null;
  let endMs = null;
  let points = [];
  let pendingScrubFrame = null;
  let pendingScrub = null;

  function syncStore(state = {}) {
    timelineStore.setScrubberState(state);
  }

  function requestFrame(callback) {
    if (typeof windowRef?.requestAnimationFrame === 'function') {
      return windowRef.requestAnimationFrame(callback);
    }
    callback();
    return null;
  }

  function cancelFrame(handle) {
    if (handle != null && typeof windowRef?.cancelAnimationFrame === 'function') {
      windowRef.cancelAnimationFrame(handle);
    }
  }

  function setVisible(visible) {
    syncStore({ visible });
  }

  function updateLabels(currentOffsetMs = 0) {
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : 0;
    const clamped = Math.max(0, Math.min(durationMs, currentOffsetMs));
    syncStore({
      currentLabel: formatTimeOffset(clamped),
      startLabel: '0:00',
      endLabel: formatTimeOffset(durationMs),
    });
  }

  function publishScrubPosition(offset) {
    syncStore({ value: String(Math.round(offset)) });
    updateLabels(offset);
  }

  function applyScrub(point, offset, shouldPanMap) {
    publishScrubPosition(offset);
    onScrub(point, offset, shouldPanMap);
  }

  function flushScheduledScrub() {
    const nextScrub = pendingScrub;
    pendingScrubFrame = null;
    pendingScrub = null;
    if (!nextScrub) return;
    applyScrub(nextScrub.point, nextScrub.offset, nextScrub.shouldPanMap);
  }

  function scheduleScrub(point, offset, shouldPanMap) {
    pendingScrub = { point, offset, shouldPanMap };
    if (pendingScrubFrame != null) return;

    const handle = requestFrame(flushScheduledScrub);
    if (pendingScrub !== null) {
      pendingScrubFrame = handle;
    }
  }

  function cancelScheduledScrub() {
    cancelFrame(pendingScrubFrame);
    pendingScrubFrame = null;
    pendingScrub = null;
  }

  function normalizeScrubOptions(shouldPanMapOrOptions = true) {
    if (shouldPanMapOrOptions && typeof shouldPanMapOrOptions === 'object') {
      return {
        shouldPanMap: shouldPanMapOrOptions.shouldPanMap !== false,
        deferRender: shouldPanMapOrOptions.deferRender === true,
      };
    }
    return {
      shouldPanMap: shouldPanMapOrOptions !== false,
      deferRender: false,
    };
  }

  function setPoints(nextPoints) {
    cancelScheduledScrub();
    points = Array.isArray(nextPoints) ? nextPoints : [];
    if (!scrubberEl || points.length < 2) {
      startMs = null;
      endMs = null;
      syncStore({
        disabled: true,
        min: '0',
        max: '0',
        step: '100',
        value: '0',
      });
      setVisible(false);
      updateLabels(0);
      return false;
    }

    startMs = points[0].timestampMs;
    endMs = points[points.length - 1].timestampMs;
    const durationMs = Math.max(0, endMs - startMs);
    syncStore({
      min: '0',
      max: String(durationMs),
      step: '100',
      value: '0',
      disabled: false,
    });
    setVisible(true);
    updateLabels(0);
    return true;
  }

  function scrubToOffset(offsetMs, shouldPanMapOrOptions = true) {
    if (!Number.isFinite(startMs)) return null;
    const { shouldPanMap, deferRender } = normalizeScrubOptions(shouldPanMapOrOptions);
    const durationMs = Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
    const offset = Math.max(0, Math.min(durationMs, Number(offsetMs) || 0));
    const point = getInterpolatedTrackPointAtMs(points, startMs + offset);
    if (!point) return null;
    if (deferRender) {
      scheduleScrub(point, offset, shouldPanMap);
    } else {
      cancelScheduledScrub();
      applyScrub(point, offset, shouldPanMap);
    }
    return point;
  }

  function syncToTimestamp(timestampMs) {
    if (!scrubberEl || !Number.isFinite(timestampMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    cancelScheduledScrub();
    const durationMs = Math.max(0, endMs - startMs);
    const offset = Math.max(0, Math.min(durationMs, timestampMs - startMs));
    publishScrubPosition(offset);
  }

  function bindStoreActions() {
    if (typeof timelineStore.bindReplayActions !== 'function') return;
    timelineStore.bindReplayActions({
      onScrubOffset(offsetMs, options = {}) {
        return scrubToOffset(offsetMs, {
          shouldPanMap: options.shouldPanMap !== false,
          deferRender: options.deferRender === true,
        });
      },
    });
  }

  bindStoreActions();

  function cleanup() {
    if (typeof timelineStore.bindReplayActions === 'function') {
      timelineStore.bindReplayActions({});
    }
    setPoints([]);
  }

  return {
    cleanup,
    setPoints,
    scrubToOffset,
    syncToTimestamp,
    updateLabels,
    setVisible,
    getStartMs: () => startMs,
    getEndMs: () => endMs,
    getPoints: () => points,
  };
}
