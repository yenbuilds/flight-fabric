import { getEventAttitudeDeg, normalizeTimelineTrackPoints } from './track-points.js';
import { getTimelineEventMarkerVisual } from './map.js';
import { buildPlaneIconHtml, normalizeHeadingDeg } from '../live-map/plane-icon.js';
import { unwrapLatLngPath, unwrapLongitudeNear } from '../live-map/geo.js';
import { createOpenFreeMapDarkLayer } from '../maps/openfreemap.js';

const MAP_TRACK_RENDER_POINT_LIMIT = 700;
const MAP_TRACK_RENDER_DETAIL_POINT_LIMIT = 1500;
const MAP_TRACK_RENDER_MAX_POINT_LIMIT = 2500;
const MAP_BOUNDS_POINT_LIMIT = 1200;
const MAP_EVENT_MARKER_LIMIT = 160;

function clampIndex(index, length) {
  return Math.max(0, Math.min(length - 1, Math.round(index)));
}

function evenlySampleItems(items, limit) {
  if (!Array.isArray(items) || limit <= 0) return [];
  if (items.length <= limit) return items.slice();
  if (limit === 1) return [items[0]];

  const result = [];
  const seen = new Set();
  const step = (items.length - 1) / (limit - 1);

  for (let i = 0; i < limit; i += 1) {
    const index = clampIndex(i * step, items.length);
    if (seen.has(index)) continue;
    seen.add(index);
    result.push(items[index]);
  }

  return result;
}

export function downsampleTimelineMapTrackPoints(points, limit = MAP_TRACK_RENDER_POINT_LIMIT) {
  if (!Array.isArray(points)) return [];
  if (points.length <= limit) return points.slice();
  const cappedLimit = Math.max(2, Math.floor(limit));
  const projected = [];
  let previousLon = null;
  const latSum = points.reduce((sum, point) => {
    const lat = Number(point?.lat);
    return Number.isFinite(lat) ? sum + lat : sum;
  }, 0);
  const latScale = Math.max(0.01, Math.cos((latSum / points.length) * Math.PI / 180));

  for (const point of points) {
    const lat = Number(point?.lat);
    let lon = Number(point?.lon);
    if (previousLon !== null) {
      while (lon - previousLon > 180) lon -= 360;
      while (lon - previousLon < -180) lon += 360;
    }
    previousLon = lon;
    projected.push({ x: lon * latScale, y: lat });
  }

  // Spatial Largest-Triangle-Three-Buckets sampling keeps the most
  // geometrically significant point in each section of the flight. Unlike
  // uniform time sampling, short turns survive even when cruise dominates the
  // recording. It is linear-time and still gives Leaflet a strict point cap.
  const sampled = [points[0]];
  const bucketWidth = (points.length - 2) / (cappedLimit - 2);
  let selectedIndex = 0;

  for (let bucket = 0; bucket < cappedLimit - 2; bucket += 1) {
    const nextStart = Math.min(
      points.length - 1,
      Math.floor((bucket + 1) * bucketWidth) + 1,
    );
    const nextEnd = Math.min(
      points.length,
      Math.floor((bucket + 2) * bucketWidth) + 1,
    );
    let averageX = projected[points.length - 1].x;
    let averageY = projected[points.length - 1].y;

    if (nextEnd > nextStart) {
      averageX = 0;
      averageY = 0;
      for (let index = nextStart; index < nextEnd; index += 1) {
        averageX += projected[index].x;
        averageY += projected[index].y;
      }
      const nextCount = nextEnd - nextStart;
      averageX /= nextCount;
      averageY /= nextCount;
    }

    const rangeStart = Math.floor(bucket * bucketWidth) + 1;
    const rangeEnd = Math.min(
      points.length - 1,
      Math.floor((bucket + 1) * bucketWidth) + 1,
    );
    const selected = projected[selectedIndex];
    let maxArea = -1;
    let maxAreaIndex = rangeStart;

    for (let index = rangeStart; index < rangeEnd; index += 1) {
      const candidate = projected[index];
      const area = Math.abs(
        (selected.x - averageX) * (candidate.y - selected.y) -
        (selected.x - candidate.x) * (averageY - selected.y),
      );
      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = index;
      }
    }

    sampled.push(points[maxAreaIndex]);
    selectedIndex = maxAreaIndex;
  }

  sampled.push(points[points.length - 1]);
  return sampled;
}

export function getTimelineMapTrackPointLimit(zoom) {
  const numericZoom = Number(zoom);
  if (!Number.isFinite(numericZoom) || numericZoom <= 5) return MAP_TRACK_RENDER_POINT_LIMIT;
  if (numericZoom <= 8) return MAP_TRACK_RENDER_DETAIL_POINT_LIMIT;
  return MAP_TRACK_RENDER_MAX_POINT_LIMIT;
}

export function downsampleTimelineMapBoundsPoints(points, limit = MAP_BOUNDS_POINT_LIMIT) {
  if (!Array.isArray(points)) return [];
  if (points.length <= limit) return points.slice();
  const cappedLimit = Math.max(2, limit);
  const selected = new Set([0, points.length - 1]);
  let minLatIndex = -1;
  let maxLatIndex = -1;
  let minLonIndex = -1;
  let maxLonIndex = -1;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  points.forEach((point, index) => {
    const lat = Number(point?.lat);
    const lon = Number(point?.lon);
    if (Number.isFinite(lat)) {
      if (lat < minLat) {
        minLat = lat;
        minLatIndex = index;
      }
      if (lat > maxLat) {
        maxLat = lat;
        maxLatIndex = index;
      }
    }
    if (Number.isFinite(lon)) {
      if (lon < minLon) {
        minLon = lon;
        minLonIndex = index;
      }
      if (lon > maxLon) {
        maxLon = lon;
        maxLonIndex = index;
      }
    }
  });

  [minLatIndex, maxLatIndex, minLonIndex, maxLonIndex].forEach((index) => {
    if (index >= 0 && selected.size < cappedLimit) selected.add(index);
  });

  const step = (points.length - 1) / (cappedLimit - 1);
  for (let i = 0; i < cappedLimit && selected.size < cappedLimit; i += 1) {
    selected.add(clampIndex(i * step, points.length));
  }

  return Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => points[index]);
}

function timelineMapEventMarkerPriority(event) {
  const type = String(event?.type || '').toLowerCase();
  if (type === 'landing' || type === 'worst_moment') return 0;
  if (type === 'violation_start' || type === 'violation_end') return 1;
  if (type === 'automation_event') return 2;
  if (type === 'configuration_event') return 2;
  if (type === 'marker') return 2;
  return 3;
}

function shouldUseDomEventMarker(event) {
  return timelineMapEventMarkerPriority(event) <= 1;
}

function createCanvasEventMarkerOptions(event, renderer = null) {
  const visual = getTimelineEventMarkerVisual(event);
  const options = {
    radius: visual.shape === 'pill' ? 5 : 4,
    color: visual.border || '#94a3b8',
    weight: 1,
    opacity: 0.85,
    fillColor: visual.bg || '#334155',
    fillOpacity: 0.8,
    interactive: true,
    keyboard: false,
    bubblingMouseEvents: false,
  };
  if (renderer) options.renderer = renderer;
  return options;
}

export function selectTimelineMapEventMarkers(positioned, limit = MAP_EVENT_MARKER_LIMIT) {
  if (!Array.isArray(positioned)) return [];
  if (positioned.length <= limit) return positioned.slice();

  const buckets = [[], [], [], []];
  positioned.forEach((item, renderOrder) => {
    const priority = timelineMapEventMarkerPriority(item?.event);
    buckets[priority].push({ item, renderOrder });
  });

  const selected = [];
  let remaining = Math.max(0, limit);
  for (const bucket of buckets) {
    if (remaining <= 0) break;
    const bucketSelection = evenlySampleItems(bucket, remaining);
    selected.push(...bucketSelection);
    remaining -= bucketSelection.length;
  }

  return selected
    .sort((a, b) => a.renderOrder - b.renderOrder)
    .map((entry) => entry.item);
}

function buildTimelinePointKey(point) {
  if (!point) return 'none';
  return [
    Number.isFinite(point.timestampMs) ? Math.round(point.timestampMs) : '',
    Number.isFinite(point.lat) ? point.lat.toFixed(5) : '',
    Number.isFinite(point.lon) ? point.lon.toFixed(5) : '',
  ].join(':');
}

function hashPositionedEvents(positioned) {
  let hash = 2166136261;
  for (const item of positioned) {
    const index = Number.isFinite(item?.originalIndex) ? item.originalIndex : 0;
    const type = String(item?.event?.type || '');
    hash ^= index + type.length;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildTimelineLayerRenderKey(timeline, trackPoints, positioned) {
  const firstPoint = trackPoints[0] || null;
  const lastPoint = trackPoints[trackPoints.length - 1] || null;
  return [
    timeline?.flightId || timeline?.filePath || '',
    timeline?.generatedAt || '',
    Number.isFinite(Number(timeline?.durationMs)) ? Math.round(Number(timeline.durationMs)) : '',
    Number.isFinite(Number(timeline?.sampleCount)) ? Math.round(Number(timeline.sampleCount)) : '',
    Array.isArray(timeline?.events) ? timeline.events.length : 0,
    trackPoints.length,
    buildTimelinePointKey(firstPoint),
    buildTimelinePointKey(lastPoint),
    positioned.length,
    hashPositionedEvents(positioned),
  ].join('|');
}

function buildTimelineFitBoundsKey(timeline, trackPoints, positioned) {
  if (trackPoints.length > 0) {
    return [
      timeline?.flightId || timeline?.filePath || '',
      timeline?.generatedAt || '',
      Number.isFinite(Number(timeline?.durationMs)) ? Math.round(Number(timeline.durationMs)) : '',
      trackPoints.length,
      buildTimelinePointKey(trackPoints[0]),
      buildTimelinePointKey(trackPoints[trackPoints.length - 1]),
    ].join('|');
  }

  return [
    timeline?.flightId || timeline?.filePath || '',
    timeline?.generatedAt || '',
    Number.isFinite(Number(timeline?.durationMs)) ? Math.round(Number(timeline.durationMs)) : '',
    positioned.length,
    hashPositionedEvents(positioned),
  ].join('|');
}

function areSortedFiniteTimestamps(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of timestamps) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < previous) return false;
    previous = numeric;
  }
  return true;
}

function findNearestTimelineTrackPointLinear(trackPoints, target) {
  let nearest = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const point of trackPoints) {
    const pointTs = Number(point?.timestampMs);
    if (!Number.isFinite(pointTs)) continue;
    const delta = Math.abs(pointTs - target);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = point;
    }
  }
  return nearest;
}

export function findNearestTimelineTrackPoint(trackPoints, timestamps, timestampMs, timestampsSorted = null) {
  if (!Array.isArray(trackPoints) || trackPoints.length === 0) return null;
  const target = Number(timestampMs);
  if (!Number.isFinite(target)) return null;

  const timeValues = Array.isArray(timestamps) && timestamps.length === trackPoints.length
    ? timestamps
    : trackPoints.map((point) => Number(point?.timestampMs));
  const sorted = timestampsSorted === true || (timestampsSorted == null && areSortedFiniteTimestamps(timeValues));
  if (!sorted) return findNearestTimelineTrackPointLinear(trackPoints, target);

  let left = 0;
  let right = timeValues.length - 1;
  let bestIndex = -1;
  let bestDelta = Number.POSITIVE_INFINITY;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const value = Number(timeValues[mid]);
    if (!Number.isFinite(value)) {
      return findNearestTimelineTrackPointLinear(trackPoints, target);
    }

    const delta = Math.abs(value - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = mid;
    }

    if (value < target) {
      left = mid + 1;
    } else if (value > target) {
      right = mid - 1;
    } else {
      bestIndex = mid;
      break;
    }
  }

  return bestIndex >= 0 ? trackPoints[bestIndex] : null;
}

export function createTimelineMapController({
  mapEl = null,
  timelineStore,
  windowRef = window,
  consoleRef = console,
  isTimelineTabVisible = () => false,
  isValidCoord = null,
  eventPassesMapFilter = () => true,
  getEventPosition = () => null,
  getEventAttitude = getEventAttitudeDeg,
  createTimelineEventIcon,
  jumpToTimelineEvent = () => {},
  updateOrientationWidget = () => {},
  syncScrubberToTimestamp = () => {},
  updateProfileCursor = () => {},
  getTimelineScrubberStartMs = () => null,
  typeLabels = {},
  allowOnlineTiles = () => true,
} = {}) {
  let timelineMap = null;
  let timelineBaseLayer = null;
  let timelineBaseLayerInitialLoadSynced = false;
  let timelineMapResizeObserver = null;
  let timelineMapResizeRaf = null;
  let timelineMapResizeTimer = null;
  let timelinePath = null;
  let timelineCursor = null;
  let timelineTrackPoints = [];
  let timelineTrackTimestamps = [];
  let timelineTrackTimestampsSorted = false;
  let timelineEventMarkers = [];
  let timelineEventLayer = null;
  let timelineCanvasRenderer = null;
  let timelineTrackRenderCache = new Map();
  let timelineTrackRenderCacheKey = '';
  let timelineTrackRenderLimit = null;
  let lastLayerRenderKey = '';
  let lastFitBoundsKey = '';
  let timelineMapInitErrorMessage = '';
  let timelineLongitudeReference = null;

  function setMapEmptyState(state = {}) {
    timelineStore.setMapEmptyState(state);
  }

  function getErrorMessage(error) {
    return error instanceof Error && error.message
      ? error.message
      : String(error || 'unknown error');
  }

  function invalidateTimelineMapSizeStaggered() {
    if (!timelineMap) return;
    if (timelineMapResizeRaf != null) windowRef.cancelAnimationFrame(timelineMapResizeRaf);
    timelineMapResizeRaf = windowRef.requestAnimationFrame(() => {
      timelineMapResizeRaf = null;
      if (!timelineMap) return;
      timelineMap.invalidateSize({ pan: false, animate: false });
    });

    if (timelineMapResizeTimer != null) windowRef.clearTimeout(timelineMapResizeTimer);
    timelineMapResizeTimer = windowRef.setTimeout(() => {
      timelineMapResizeTimer = null;
      if (!timelineMap) return;
      timelineMap.invalidateSize({ pan: false, animate: false });
    }, 140);
  }

  function ensureTimelineMapViewportSync() {
    if (!timelineMap || !mapEl) return false;
    const cw = mapEl.clientWidth;
    const ch = mapEl.clientHeight;
    if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) return false;
    const size = timelineMap.getSize();
    if (!size) return false;
    if (Math.abs(size.x - cw) > 8 || Math.abs(size.y - ch) > 8) {
      timelineMap.invalidateSize({ pan: false, animate: false });
      return true;
    }
    return false;
  }

  function fitTimelineMapBounds(timelineTrackPointsForBounds, positioned, fitBoundsKey) {
    if (!timelineMap || fitBoundsKey === lastFitBoundsKey) return;
    const fitLatLngs = [];
    if (timelineTrackPointsForBounds.length > 0) {
      const boundsTrackPoints = downsampleTimelineMapBoundsPoints(timelineTrackPointsForBounds);
      fitLatLngs.push(...unwrapLatLngPath(
        boundsTrackPoints.map((point) => [point.lat, point.lon]),
        timelineLongitudeReference,
      ));
    }
    fitLatLngs.push(...positioned.map((item) => [
      item.pos.lat,
      unwrapLongitudeNear(item.pos.lon, timelineLongitudeReference),
    ]));
    const bounds = windowRef.L.latLngBounds(fitLatLngs);
    timelineMap.fitBounds(bounds.pad(0.15), { animate: false });
    lastFitBoundsKey = fitBoundsKey;
  }

  function ensureTimelineMap() {
    if (timelineMap || !mapEl || typeof windowRef.L === 'undefined') return;
    if (!isTimelineTabVisible()) return;

    timelineCanvasRenderer = typeof windowRef.L.canvas === 'function'
      ? windowRef.L.canvas({ padding: 0.5 })
      : null;
    const mapOptions = {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
      zoomAnimation: false,
      markerZoomAnimation: false,
      fadeAnimation: false,
      wheelDebounceTime: 80,
      wheelPxPerZoomLevel: 120,
    };
    if (timelineCanvasRenderer) mapOptions.renderer = timelineCanvasRenderer;

    try {
      timelineMap = windowRef.L.map(mapEl, mapOptions).setView([20, 0], 2);
    } catch (error) {
      const message = getErrorMessage(error);
      if (/already initialized/i.test(message) && mapEl && Object.prototype.hasOwnProperty.call(mapEl, '_leaflet_id')) {
        try {
          delete mapEl._leaflet_id;
          timelineMap = windowRef.L.map(mapEl, mapOptions).setView([20, 0], 2);
          timelineMapInitErrorMessage = '';
        } catch (retryError) {
          timelineMap = null;
          timelineMapInitErrorMessage = `Map failed to initialize: ${getErrorMessage(retryError)}`;
          setMapEmptyState({ visible: true, message: timelineMapInitErrorMessage });
          consoleRef.error?.('[TimelineMap] Leaflet map initialization failed after stale-container retry', retryError);
          return;
        }
      } else {
        timelineMap = null;
        timelineMapInitErrorMessage = `Map failed to initialize: ${message}`;
        setMapEmptyState({ visible: true, message: timelineMapInitErrorMessage });
        consoleRef.error?.('[TimelineMap] Leaflet map initialization failed', error);
        return;
      }
    }
    timelineMapInitErrorMessage = '';

    const syncMapSizeAfterInitialTileLoad = () => {
      if (timelineBaseLayerInitialLoadSynced) return;
      timelineBaseLayerInitialLoadSynced = true;
      invalidateTimelineMapSizeStaggered();
    };

    if (allowOnlineTiles() !== true) {
      setMapEmptyState({ message: 'Online map tiles disabled' });
      syncMapSizeAfterInitialTileLoad();
    } else {
      try {
        timelineBaseLayer = createOpenFreeMapDarkLayer(windowRef.L).addTo(timelineMap);
        const vectorMap = timelineBaseLayer.getMaplibreMap?.();
        vectorMap?.once?.('load', syncMapSizeAfterInitialTileLoad);
        vectorMap?.once?.('error', (event) => {
          consoleRef.warn('[TimelineMap] OpenFreeMap dark basemap unavailable', event?.error || event);
        });
      } catch (error) {
        timelineBaseLayer = null;
        syncMapSizeAfterInitialTileLoad();
        consoleRef.warn('[TimelineMap] OpenFreeMap dark basemap could not start', error);
      }
    }

    if (windowRef.L.DomEvent && mapEl) {
      windowRef.L.DomEvent.disableScrollPropagation(mapEl);
      windowRef.L.DomEvent.disableClickPropagation(mapEl);
    }

    timelineMap.on?.('zoomend', updateTimelinePathDetail);
    invalidateTimelineMapSizeStaggered();

    if (!timelineMapResizeObserver && typeof windowRef.ResizeObserver !== 'undefined') {
      timelineMapResizeObserver = new windowRef.ResizeObserver(() => {
        invalidateTimelineMapSizeStaggered();
      });
      timelineMapResizeObserver.observe(mapEl);
      if (mapEl.parentElement) timelineMapResizeObserver.observe(mapEl.parentElement);
    }
  }

  function resetTimelineMapDataLayers() {
    if (!timelineMap) return;

    if (timelinePath) {
      timelineMap.removeLayer(timelinePath);
      timelinePath = null;
    }

    if (timelineEventLayer) {
      try {
        timelineEventLayer.clearLayers();
      } catch {}
    } else {
      timelineEventMarkers.forEach((marker) => {
        try {
          timelineMap.removeLayer(marker);
        } catch {}
      });
    }
    timelineEventMarkers = [];
    lastLayerRenderKey = '';
  }

  function resetTimelineCursor() {
    if (!timelineMap || !timelineCursor) return;
    timelineMap.removeLayer(timelineCursor);
    timelineCursor = null;
  }

  function findNearestTrackPointForEvent(event) {
    return findNearestTimelineTrackPoint(timelineTrackPoints, timelineTrackTimestamps, event?.timestampMs, timelineTrackTimestampsSorted);
  }

  function setCursorPosition(pos, attitude = {}, shouldPan = true) {
    const headingDeg = Number(attitude?.headingDeg);
    const pitchDeg = Number(attitude?.pitchDeg);
    const rollDeg = Number(attitude?.rollDeg);
    const iasKts = Number(attitude?.iasKts);
    const altFt = Number(attitude?.altFt);

    updateOrientationWidget(
      Number.isFinite(headingDeg) ? headingDeg : null,
      Number.isFinite(pitchDeg) ? pitchDeg : null,
      Number.isFinite(rollDeg) ? rollDeg : null,
      Number.isFinite(iasKts) ? iasKts : null,
      Number.isFinite(altFt) ? altFt : null,
    );

    if (!timelineMap || typeof windowRef.L === 'undefined' || !pos) return;

    const rotationDeg = normalizeHeadingDeg(headingDeg);

    const displayLon = unwrapLongitudeNear(pos.lon, timelineLongitudeReference);
    if (!timelineCursor) {
      timelineCursor = windowRef.L.marker([pos.lat, displayLon], {
        icon: windowRef.L.divIcon({
          className: 'timeline-plane-icon',
          html: buildPlaneIconHtml('timeline-plane-glyph'),
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        }),
      }).addTo(timelineMap);
    } else {
      timelineCursor.setLatLng([pos.lat, displayLon]);
    }

    const glyph = timelineCursor.getElement()?.querySelector('.timeline-plane-glyph');
    if (glyph) {
      glyph.style.transform = `rotate(${rotationDeg}deg)`;
    }

    if (!shouldPan) return;

    if (timelineMap.getZoom() < 10) {
      timelineMap.setView([pos.lat, displayLon], 10, { animate: false });
    } else {
      timelineMap.panTo([pos.lat, displayLon], { animate: false });
    }
  }

  function getTimelineTrackRenderPoints(limit) {
    if (timelineTrackRenderCache.has(limit)) return timelineTrackRenderCache.get(limit);
    const points = downsampleTimelineMapTrackPoints(timelineTrackPoints, limit);
    timelineTrackRenderCache.set(limit, points);
    return points;
  }

  function getDisplayTimelineTrack(points) {
    return unwrapLatLngPath(
      points.map((point) => [point.lat, point.lon]),
      timelineLongitudeReference,
    );
  }

  function updateTimelinePathDetail() {
    if (!timelineMap || !timelinePath || timelineTrackPoints.length === 0) return;
    const limit = getTimelineMapTrackPointLimit(timelineMap.getZoom?.());
    if (limit === timelineTrackRenderLimit) return;
    timelineTrackRenderLimit = limit;
    const displayTrack = getDisplayTimelineTrack(getTimelineTrackRenderPoints(limit));
    timelinePath.setLatLngs?.(displayTrack);
  }

  function focusEvent(event) {
    const nearestTrackPoint = findNearestTrackPointForEvent(event);
    const eventPos = getEventPosition(event);
    const pos = nearestTrackPoint || eventPos;

    const attitude = getEventAttitude(event);
    const headingDeg = Number(nearestTrackPoint?.hdgTrueDeg ?? attitude.headingDeg);
    const pitchDeg = Number(nearestTrackPoint?.pitchDeg ?? attitude.pitchDeg);
    const rollDeg = Number(nearestTrackPoint?.rollDeg ?? attitude.rollDeg);
    const iasKts = Number(nearestTrackPoint?.iasKts ?? event?.ias_kts);
    const altFt = Number(nearestTrackPoint?.altFt ?? event?.alt_msl_ft ?? event?.alt_ft);
    setCursorPosition(pos, {
      headingDeg: Number.isFinite(headingDeg) ? headingDeg : null,
      pitchDeg: Number.isFinite(pitchDeg) ? pitchDeg : null,
      rollDeg: Number.isFinite(rollDeg) ? rollDeg : null,
      iasKts: Number.isFinite(iasKts) ? iasKts : null,
      altFt: Number.isFinite(altFt) ? altFt : null,
    }, true);

    const eventTs = Number(event?.timestampMs);
    if (Number.isFinite(eventTs)) {
      syncScrubberToTimestamp(eventTs);
      const scrubberStartMs = getTimelineScrubberStartMs();
      if (Number.isFinite(scrubberStartMs)) {
        updateProfileCursor(eventTs - scrubberStartMs);
      }
    }
  }

  function render(timeline) {
    if (!mapEl) return timelineTrackPoints;

    if (typeof windowRef.L === 'undefined') {
      setMapEmptyState({
        visible: true,
        message: 'Map unavailable (Leaflet failed to load)',
      });
      timelineTrackPoints = normalizeTimelineTrackPoints(timeline, {
        isValidCoord,
        getEventPosition,
        getEventAttitude,
      });
      return timelineTrackPoints;
    }

    ensureTimelineMap();
    if (!timelineMap) {
      timelineTrackPoints = normalizeTimelineTrackPoints(timeline, {
        isValidCoord,
        getEventPosition,
        getEventAttitude,
      });
      if (!isTimelineTabVisible()) return timelineTrackPoints;
      setMapEmptyState({
        visible: true,
        message: timelineMapInitErrorMessage || 'Map unavailable (Leaflet failed to load)',
      });
      return timelineTrackPoints;
    }
    const viewportChanged = ensureTimelineMapViewportSync();
    if (viewportChanged) lastFitBoundsKey = '';

    timelineTrackPoints = normalizeTimelineTrackPoints(timeline, {
      isValidCoord,
      getEventPosition,
      getEventAttitude,
    });
    timelineTrackTimestamps = timelineTrackPoints.map((point) => Number(point?.timestampMs));
    timelineTrackTimestampsSorted = areSortedFiniteTimestamps(timelineTrackTimestamps);
    const positioned = (Array.isArray(timeline?.events) ? timeline.events : [])
      .map((event, originalIndex) => ({ event, pos: getEventPosition(event), originalIndex }))
      .filter((item) => item.pos)
      .filter((item) => eventPassesMapFilter(item.event));

    timelineLongitudeReference = Number.isFinite(timelineTrackPoints[0]?.lon)
      ? timelineTrackPoints[0].lon
      : (Number.isFinite(positioned[0]?.pos?.lon) ? positioned[0].pos.lon : null);

    const hasTrack = timelineTrackPoints.length > 0;
    setMapEmptyState({
      visible: !(hasTrack || positioned.length > 0),
      message: 'No positional event data yet',
    });

    if (!hasTrack && positioned.length === 0) {
      resetTimelineMapDataLayers();
      resetTimelineCursor();
      invalidateTimelineMapSizeStaggered();
      return timelineTrackPoints;
    }

    const renderKey = buildTimelineLayerRenderKey(timeline, timelineTrackPoints, positioned);
    const fitBoundsKey = buildTimelineFitBoundsKey(timeline, timelineTrackPoints, positioned);
    const trackRenderCacheKey = [
      timeline?.flightId || timeline?.filePath || '',
      timelineTrackPoints.length,
      buildTimelinePointKey(timelineTrackPoints[0]),
      buildTimelinePointKey(timelineTrackPoints[timelineTrackPoints.length - 1]),
    ].join('|');
    if (trackRenderCacheKey !== timelineTrackRenderCacheKey) {
      timelineTrackRenderCacheKey = trackRenderCacheKey;
      timelineTrackRenderCache = new Map();
      timelineTrackRenderLimit = null;
    }
    if (renderKey === lastLayerRenderKey) {
      fitTimelineMapBounds(timelineTrackPoints, positioned, fitBoundsKey);
      invalidateTimelineMapSizeStaggered();
      return timelineTrackPoints;
    }

    resetTimelineMapDataLayers();
    lastLayerRenderKey = renderKey;

    timelineTrackRenderLimit = getTimelineMapTrackPointLimit(timelineMap.getZoom?.());
    const renderTrackPoints = getTimelineTrackRenderPoints(timelineTrackRenderLimit);
    const renderMarkers = selectTimelineMapEventMarkers(positioned);
    if (hasTrack) {
      const polylineOptions = {
        color: '#00d4ff',
        weight: 2.5,
        opacity: 0.9,
        className: 'flight-track-line',
        interactive: false,
        smoothFactor: 1,
      };
      if (timelineCanvasRenderer) polylineOptions.renderer = timelineCanvasRenderer;
      const displayTrack = getDisplayTimelineTrack(renderTrackPoints);
      timelinePath = windowRef.L.polyline(displayTrack, polylineOptions).addTo(timelineMap);
    }

    if (!timelineEventLayer && typeof windowRef.L.layerGroup === 'function') {
      timelineEventLayer = windowRef.L.layerGroup().addTo(timelineMap);
    }

    renderMarkers.forEach(({ event, pos, originalIndex }) => {
      const useDomMarker = shouldUseDomEventMarker(event) || typeof windowRef.L.circleMarker !== 'function';
      const displayLon = unwrapLongitudeNear(pos.lon, timelineLongitudeReference);
      const marker = useDomMarker
        ? windowRef.L.marker([pos.lat, displayLon], {
          icon: createTimelineEventIcon(event),
          keyboard: false,
        })
        : windowRef.L.circleMarker(
          [pos.lat, displayLon],
          createCanvasEventMarkerOptions(event, timelineCanvasRenderer),
        );

      const label = typeLabels[event.type] || event.type || 'Event';
      marker.bindTooltip(label, { direction: 'top', opacity: 0.9 });
      marker.on('click', () => {
        jumpToTimelineEvent(event, originalIndex, { shouldPanMap: true });
      });
      if (timelineEventLayer) {
        marker.addTo(timelineEventLayer);
      } else {
        marker.addTo(timelineMap);
      }
      timelineEventMarkers.push(marker);
    });

    fitTimelineMapBounds(timelineTrackPoints, positioned, fitBoundsKey);
    invalidateTimelineMapSizeStaggered();
    return timelineTrackPoints;
  }

  function reset() {
    timelineTrackPoints = [];
    timelineTrackTimestamps = [];
    timelineTrackTimestampsSorted = false;
    timelineTrackRenderCache = new Map();
    timelineTrackRenderCacheKey = '';
    timelineTrackRenderLimit = null;
    timelineLongitudeReference = null;
    lastFitBoundsKey = '';
    resetTimelineMapDataLayers();
    resetTimelineCursor();
    updateOrientationWidget(null, null, null);
  }

  function destroy() {
    if (timelineMapResizeRaf != null) {
      windowRef.cancelAnimationFrame(timelineMapResizeRaf);
      timelineMapResizeRaf = null;
    }
    if (timelineMapResizeTimer != null) {
      windowRef.clearTimeout(timelineMapResizeTimer);
      timelineMapResizeTimer = null;
    }
    timelineMapResizeObserver?.disconnect?.();
    timelineMapResizeObserver = null;
    reset();
    if (timelineMap) {
      try {
        timelineMap.remove();
      } catch {}
    }
    timelineMap = null;
    timelineBaseLayer = null;
    timelineBaseLayerInitialLoadSynced = false;
    timelineMapInitErrorMessage = '';
    timelineEventLayer = null;
    timelineCanvasRenderer = null;
  }

  return {
    destroy,
    focusEvent,
    getTrackPoints: () => timelineTrackPoints.slice(),
    hasMap: () => Boolean(timelineMap),
    invalidateSizeStaggered: invalidateTimelineMapSizeStaggered,
    render,
    reset,
    setCursorPosition,
  };
}
