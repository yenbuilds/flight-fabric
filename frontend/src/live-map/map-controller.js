import {
  getDistanceNm,
  getGreatCirclePath,
  getInitialBearingDeg,
  unwrapLatLngPath,
  unwrapLongitudeNear,
} from './geo.js';
import { buildPlaneIconHtml, normalizeHeadingDeg } from './plane-icon.js';
import {
  createOpenFreeMapDarkLayer,
  createOpenFreeMapRasterFallbackLayer,
} from '../maps/openfreemap.js';

const HEADING_DEADBAND_DEG = 0.75;
const HEADING_SMOOTHING_FACTOR = 0.35;
// Preserve brief telemetry gaps, but never bridge a simulator reposition with
// a straight line across the map.
const LIVE_TRACK_JUMP_TOLERANCE_NM = 5;
const LIVE_TRACK_MAX_PLAUSIBLE_SPEED_KTS = 1200;
const LIVE_TRACK_MAX_CONTINUITY_GAP_MS = 5 * 60 * 1000;
// Position messages arrive far more often than the map needs a new vertex.
// Keep the first point and the always-current endpoint, committing an
// intermediate point only when removing it would visibly cut a corner.
const LIVE_TRACK_SIMPLIFY_TOLERANCE_NM = 0.02;
// The streaming simplifier keeps raw points since its last committed vertex so
// gradual turns cannot be flattened one tiny telemetry step at a time. Bound
// that working set on long straight legs.
const LIVE_TRACK_SIMPLIFY_MAX_PENDING_POINTS = 512;
const LIVE_TRACK_SIMPLIFY_MAX_SPAN_NM = 20;
const WEB_MERCATOR_MAX_LAT_DEG = 85.05112878;
const EARTH_RADIUS_NM = 3440.065;

function angleDeltaDeg(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function clampMercatorLat(lat) {
  return Math.max(
    -WEB_MERCATOR_MAX_LAT_DEG,
    Math.min(WEB_MERCATOR_MAX_LAT_DEG, lat),
  );
}

function getMercatorY(lat) {
  const latRad = clampMercatorLat(lat) * Math.PI / 180;
  return Math.log(Math.tan((Math.PI / 4) + (latRad / 2)));
}

export function createLiveMapController({
  mapEl,
  liveMapStore,
  windowRef = window,
  localStorageRef = localStorage,
  consoleRef = console,
  isValidCoord,
  getRouteTargets = () => null,
  allowOnlineTiles = () => true,
  isLiveMapVisible = () => false,
} = {}) {
  let liveMap = null;
  let liveBaseLayer = null;
  let liveBaseLayerFallbackActive = false;
  let livePath = null;
  let liveCursor = null;
  let targetLine = null;
  let routeLine = null;
  let targetMarker = null;
  let originMarker = null;
  let lastHeading = null;
  let renderedHeading = null;
  let lastPosition = null;
  let lastTrackPoint = null;
  let autoFollow = true;
  let suppressFollowPause = false;
  let sampleCount = 0;
  let hasRestoredMapView = false;
  let mapResizeObserver = null;
  let liveMapResizeRaf = null;
  let liveMapResizeTimer = null;
  let liveMapActivationTimer = null;

  const trackSegments = [[]];
  let pendingTrackPoints = [];
  const FOLLOW_MODE_STORAGE_KEY = 'ff.liveMap.followMode.v1';
  const MAP_VIEW_STORAGE_KEY = 'ff.liveMap.view.v1';

  function setMapEmptyState(state = {}) {
    liveMapStore.setMapEmptyState(state);
  }

  function saveMapView() {
    if (!liveMap) return;
    try {
      const center = liveMap.getCenter();
      const zoom = liveMap.getZoom();
      if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng) || !Number.isFinite(zoom)) return;
      localStorageRef.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify({ lat: center.lat, lon: center.lng, zoom }));
    } catch {}
  }

  function restoreMapView() {
    try {
      const raw = localStorageRef.getItem(MAP_VIEW_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const lat = Number(parsed?.lat);
      const lon = Number(parsed?.lon);
      const zoom = Number(parsed?.zoom);
      if (!isValidCoord(lat, lon) || !Number.isFinite(zoom)) return null;
      return { lat, lon, zoom };
    } catch {
      return null;
    }
  }

  function syncFollowUiState() {
    liveMapStore.setFollowStatus(autoFollow ? 'following' : 'paused');

    try {
      localStorageRef.setItem(FOLLOW_MODE_STORAGE_KEY, autoFollow ? 'follow' : 'paused');
    } catch {}
  }

  function restoreFollowMode() {
    try {
      const mode = localStorageRef.getItem(FOLLOW_MODE_STORAGE_KEY);
      if (mode === 'paused') autoFollow = false;
      if (mode === 'follow') autoFollow = true;
    } catch {}
  }

  function removeLayer(layer) {
    if (!liveMap || !layer) return null;
    liveMap.removeLayer(layer);
    return null;
  }

  function resolveMapHeading(message) {
    const trueHeading = Number(message?.true);
    if (Number.isFinite(trueHeading)) return trueHeading;

    const positionHeading = Number(message?.hdg);
    if (Number.isFinite(positionHeading)) return positionHeading;

    const magneticHeading = Number(message?.mag);
    return Number.isFinite(magneticHeading) ? magneticHeading : null;
  }

  function getStableHeading(hdg) {
    const nextHeading = normalizeHeadingDeg(hdg);
    if (renderedHeading == null) {
      renderedHeading = nextHeading;
      return renderedHeading;
    }

    const delta = angleDeltaDeg(renderedHeading, nextHeading);
    if (Math.abs(delta) < HEADING_DEADBAND_DEG) return renderedHeading;

    renderedHeading = normalizeHeadingDeg(renderedHeading + delta * HEADING_SMOOTHING_FACTOR);
    return renderedHeading;
  }

  function applyCursorHeading(hdg) {
    if (!Number.isFinite(hdg)) return;
    const glyph = liveCursor?.getElement()?.querySelector('.live-plane-glyph');
    if (!glyph) return;
    const headingDeg = Number(getStableHeading(hdg).toFixed(2));
    glyph.style.transform = `rotate(${headingDeg}deg)`;
  }

  function ensureMap() {
    if (liveMap || typeof windowRef.L === 'undefined') return;
    if (!isLiveMapVisible()) return;

    liveMap = windowRef.L.map(mapEl, {
      zoomControl: true,
      attributionControl: true,
    }).setView([20, 0], 2);

    const restoredView = restoreMapView();
    if (restoredView) {
      suppressFollowPause = true;
      liveMap.setView([restoredView.lat, restoredView.lon], restoredView.zoom, { animate: false });
      hasRestoredMapView = true;
      windowRef.setTimeout(() => { suppressFollowPause = false; }, 0);
    }

    if (allowOnlineTiles() !== true) {
      liveMapStore.setMeta('Online map tiles disabled');
      invalidateSizeStaggered();
    } else {
      const activateRasterFallback = (reason) => {
        if (!liveMap || liveBaseLayerFallbackActive) return;
        liveBaseLayerFallbackActive = true;
        try {
          if (liveBaseLayer) liveMap.removeLayer(liveBaseLayer);
        } catch {}

        try {
          liveBaseLayer = createOpenFreeMapRasterFallbackLayer(windowRef.L);
          liveBaseLayer.on?.('load', invalidateSizeStaggered);
          liveBaseLayer.on?.('tileerror', (event) => {
            consoleRef.warn('[LiveMap] OpenFreeMap raster fallback unavailable', event?.error || event);
          });
          liveBaseLayer.addTo(liveMap);
          liveMapStore.setMeta('Using simplified OpenFreeMap basemap');
          consoleRef.warn('[LiveMap] OpenFreeMap vector map unavailable; switched to raster fallback', reason);
        } catch (fallbackError) {
          liveBaseLayer = null;
          liveMapStore.setMeta('Dark basemap unavailable');
          consoleRef.warn('[LiveMap] OpenFreeMap raster fallback could not start', fallbackError);
        }
      };

      try {
        liveBaseLayer = createOpenFreeMapDarkLayer(windowRef.L).addTo(liveMap);
        const vectorMap = liveBaseLayer.getMaplibreMap?.();
        vectorMap?.once?.('load', invalidateSizeStaggered);
        vectorMap?.once?.('error', (event) => {
          activateRasterFallback(event?.error || event);
        });
      } catch (error) {
        activateRasterFallback(error);
      }
    }

    const pauseAutoFollow = () => {
      if (suppressFollowPause) return;
      autoFollow = false;
      syncFollowUiState();
    };

    liveMap.on('dragstart', pauseAutoFollow);
    liveMap.on('zoomstart', pauseAutoFollow);
    liveMap.on('moveend', saveMapView);
    liveMap.on('zoomend', saveMapView);

    invalidateSizeStaggered();

    if (!mapResizeObserver && typeof windowRef.ResizeObserver !== 'undefined') {
      mapResizeObserver = new windowRef.ResizeObserver(() => {
        invalidateSizeStaggered();
      });
      mapResizeObserver.observe(mapEl);
      if (mapEl.parentElement) mapResizeObserver.observe(mapEl.parentElement);
    }
  }

  function renderCursor(lat, lon, hdg) {
    if (!liveMap || typeof windowRef.L === 'undefined') return;

    if (!liveCursor) {
      liveCursor = windowRef.L.marker([lat, lon], {
        icon: windowRef.L.divIcon({
          className: 'live-plane-icon',
          html: buildPlaneIconHtml('live-plane-glyph'),
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        }),
      }).addTo(liveMap);
    } else {
      liveCursor.setLatLng([lat, lon]);
    }

    applyCursorHeading(hdg);
  }

  function renderTrack() {
    if (!liveMap || typeof windowRef.L === 'undefined') return;

    livePath = removeLayer(livePath);
    const renderableSegments = trackSegments.filter((segment) => segment.length >= 2);
    if (renderableSegments.length === 0) return;

    const latLngs = renderableSegments.length === 1
      ? renderableSegments[0]
      : renderableSegments;

    livePath = windowRef.L.polyline(latLngs, {
      color: '#00d4ff',
      weight: 2.5,
      opacity: 0.9,
      className: 'flight-track-line',
    }).addTo(liveMap);
  }

  function bringLiveTrackToFront() {
    try {
      livePath?.bringToFront?.();
    } catch {}
  }

  function getTrackDeviationNm(anchorPoint, candidatePoint, endpoint) {
    const referenceLatRad = clampMercatorLat(
      (anchorPoint[0] + candidatePoint[0] + endpoint[0]) / 3,
    ) * Math.PI / 180;
    const projectedRadianToNm = EARTH_RADIUS_NM * Math.cos(referenceLatRad);
    const candidateX = (
      (candidatePoint[1] - anchorPoint[1])
      * Math.PI
      / 180
      * projectedRadianToNm
    );
    const candidateY = (
      getMercatorY(candidatePoint[0])
      - getMercatorY(anchorPoint[0])
    ) * projectedRadianToNm;
    const endpointX = (
      (endpoint[1] - anchorPoint[1])
      * Math.PI
      / 180
      * projectedRadianToNm
    );
    const endpointY = (
      getMercatorY(endpoint[0])
      - getMercatorY(anchorPoint[0])
    ) * projectedRadianToNm;
    if (
      !Number.isFinite(candidateX)
      || !Number.isFinite(candidateY)
      || !Number.isFinite(endpointX)
      || !Number.isFinite(endpointY)
    ) {
      return Number.POSITIVE_INFINITY;
    }

    // Leaflet draws straight segments in Web Mercator. Measure against that
    // same finite projected segment so the tolerance matches what is visible
    // and a collinear out-and-back turn cannot collapse onto an infinite line.
    const endpointLengthSquared = (endpointX * endpointX) + (endpointY * endpointY);
    if (endpointLengthSquared <= Number.EPSILON) {
      return Math.hypot(candidateX, candidateY);
    }
    const fraction = Math.max(0, Math.min(
      1,
      ((candidateX * endpointX) + (candidateY * endpointY)) / endpointLengthSquared,
    ));
    return Math.hypot(
      candidateX - (fraction * endpointX),
      candidateY - (fraction * endpointY),
    );
  }

  function appendRenderableTrackPoint(segment, lat, lon) {
    const nextPoint = [lat, lon];
    if (segment.length === 0) {
      segment.push(nextPoint);
      pendingTrackPoints = [nextPoint];
      return;
    }

    const previousPoint = pendingTrackPoints[pendingTrackPoints.length - 1]
      || segment[segment.length - 1];
    const previousToNextNm = getDistanceNm(
      previousPoint[0],
      previousPoint[1],
      lat,
      lon,
    );
    if (!Number.isFinite(previousToNextNm)) {
      segment.push(nextPoint);
      return;
    }

    if (segment.length === 1) {
      if (previousToNextNm <= Number.EPSILON) {
        segment[0] = nextPoint;
        pendingTrackPoints = [nextPoint];
      } else {
        segment.push(nextPoint);
        pendingTrackPoints = [segment[0], nextPoint];
      }
      return;
    }

    if (previousToNextNm <= Number.EPSILON) {
      segment[segment.length - 1] = nextPoint;
      pendingTrackPoints[pendingTrackPoints.length - 1] = nextPoint;
      return;
    }

    pendingTrackPoints.push(nextPoint);
    const anchorPoint = pendingTrackPoints[0];
    const anchorToNextNm = getDistanceNm(
      anchorPoint[0],
      anchorPoint[1],
      lat,
      lon,
    );
    let shouldCommitPrevious = (
      !Number.isFinite(anchorToNextNm)
      || anchorToNextNm > LIVE_TRACK_SIMPLIFY_MAX_SPAN_NM
      || pendingTrackPoints.length > LIVE_TRACK_SIMPLIFY_MAX_PENDING_POINTS
    );

    if (!shouldCommitPrevious) {
      for (let index = 1; index < pendingTrackPoints.length - 1; index += 1) {
        const deviationNm = getTrackDeviationNm(
          anchorPoint,
          pendingTrackPoints[index],
          nextPoint,
        );
        if (deviationNm > LIVE_TRACK_SIMPLIFY_TOLERANCE_NM) {
          shouldCommitPrevious = true;
          break;
        }
      }
    }

    if (shouldCommitPrevious) {
      // The prior live endpoint already represents a chord whose accumulated
      // error was within tolerance. Commit it, then keep the newest position as
      // the always-current endpoint.
      segment.push(nextPoint);
      pendingTrackPoints = [previousPoint, nextPoint];
      return;
    }

    segment[segment.length - 1] = nextPoint;
  }

  function appendTrackPoint(lat, lon) {
    const receivedAtMs = Date.now();
    if (lastTrackPoint) {
      const elapsedMs = Math.max(0, receivedAtMs - lastTrackPoint.receivedAtMs);
      const continuityElapsedMs = Math.min(elapsedMs, LIVE_TRACK_MAX_CONTINUITY_GAP_MS);
      const maxContinuousDistanceNm = LIVE_TRACK_JUMP_TOLERANCE_NM
        + (LIVE_TRACK_MAX_PLAUSIBLE_SPEED_KTS * continuityElapsedMs / 3_600_000);
      const distanceNm = getDistanceNm(lastTrackPoint.lat, lastTrackPoint.lon, lat, lon);
      // Leaflet projects raw longitudes, so a valid 179E -> 179W crossing can
      // otherwise render as a chord across the whole world map.
      const crossesAntimeridian = Math.abs(lon - lastTrackPoint.lon) > 180;

      if (crossesAntimeridian || !Number.isFinite(distanceNm) || distanceNm > maxContinuousDistanceNm) {
        const currentSegment = trackSegments[trackSegments.length - 1];
        if (currentSegment.length < 2) {
          // Reuse an unrenderable singleton when telemetry repeatedly jumps.
          // This keeps alternating outliers from growing trackSegments forever.
          currentSegment.length = 0;
        } else {
          trackSegments.push([]);
        }
        pendingTrackPoints = [];
      }
    }

    appendRenderableTrackPoint(trackSegments[trackSegments.length - 1], lat, lon);
    lastTrackPoint = { lat, lon, receivedAtMs };
  }

  function renderTargetLine() {
    if (!liveMap || typeof windowRef.L === 'undefined') return;

    targetLine = removeLayer(targetLine);

    const targetAirport = getRouteTargets()?.getTargetAirport?.();
    if (!targetAirport || !lastPosition) return;

    const path = unwrapLatLngPath(getGreatCirclePath(
      lastPosition.lat,
      lastPosition.lon,
      targetAirport.lat,
      targetAirport.lon,
      isValidCoord,
    ), lastPosition.lon);
    if (path.length < 2) return;

    targetLine = windowRef.L.polyline(path, {
      color: '#3b82f6',
      weight: 2,
      opacity: 0.9,
    }).addTo(liveMap);
    bringLiveTrackToFront();
  }

  function renderTargetMarker() {
    if (!liveMap || typeof windowRef.L === 'undefined') return;

    targetMarker = removeLayer(targetMarker);

    const targetAirport = getRouteTargets()?.getTargetAirport?.();
    if (!targetAirport) return;

    const referenceLon = lastPosition?.lon
      ?? getRouteTargets()?.getOriginAirport?.()?.lon
      ?? targetAirport.lon;
    const displayLon = unwrapLongitudeNear(targetAirport.lon, referenceLon);
    targetMarker = windowRef.L.circleMarker([targetAirport.lat, displayLon], {
      radius: 5,
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.9,
      weight: 1,
    }).addTo(liveMap);

    targetMarker.bindTooltip(targetAirport.icao, {
      permanent: false,
      direction: 'top',
      opacity: 0.9,
    });
  }

  function renderRouteLine() {
    if (!liveMap || typeof windowRef.L === 'undefined') return;

    routeLine = removeLayer(routeLine);

    const routeTargets = getRouteTargets();
    const originAirport = routeTargets?.getOriginAirport?.();
    const targetAirport = routeTargets?.getTargetAirport?.();
    if (!originAirport || !targetAirport) return;

    const referenceLon = lastPosition?.lon ?? originAirport.lon;
    const path = unwrapLatLngPath(getGreatCirclePath(
      originAirport.lat,
      originAirport.lon,
      targetAirport.lat,
      targetAirport.lon,
      isValidCoord,
    ), referenceLon);
    if (path.length < 2) return;

    routeLine = windowRef.L.polyline(path, {
      color: '#3b82f6',
      weight: 1.5,
      opacity: 0.45,
      dashArray: '4 4',
    }).addTo(liveMap);
    bringLiveTrackToFront();
  }

  function renderOriginMarker() {
    if (!liveMap || typeof windowRef.L === 'undefined') return;

    originMarker = removeLayer(originMarker);

    const originAirport = getRouteTargets()?.getOriginAirport?.();
    if (!originAirport) return;

    const referenceLon = lastPosition?.lon ?? originAirport.lon;
    const displayLon = unwrapLongitudeNear(originAirport.lon, referenceLon);
    originMarker = windowRef.L.circleMarker([originAirport.lat, displayLon], {
      radius: 5,
      color: '#10b981',
      fillColor: '#10b981',
      fillOpacity: 0.9,
      weight: 1,
    }).addTo(liveMap);

    originMarker.bindTooltip(`FROM ${originAirport.icao}`, {
      permanent: false,
      direction: 'top',
      opacity: 0.9,
    });
  }

  function updateMeta(lat, lon, hdg) {
    const headingText = Number.isFinite(hdg) ? `${Math.round(hdg).toString().padStart(3, '0')} deg` : '--';
    liveMapStore.setMeta(`Lat ${lat.toFixed(5)} - Lon ${lon.toFixed(5)} - HDG ${headingText}`);
  }

  function centerOnLatestPosition() {
    if (!liveMap || !lastPosition) return;
    const currentZoom = Number.isFinite(liveMap.getZoom()) ? liveMap.getZoom() : 10;
    const targetZoom = Math.max(10, currentZoom);
    suppressFollowPause = true;
    liveMap.setView([lastPosition.lat, lastPosition.lon], targetZoom, { animate: true });
    windowRef.setTimeout(() => { suppressFollowPause = false; }, 50);
  }

  function renderLatestPosition() {
    if (!lastPosition) return false;

    // Header route progress is global UI, so keep it current even while the
    // Leaflet tab is hidden. Map-only work remains visibility-gated below.
    getRouteTargets()?.updateDestinationProgress?.();

    if (!liveMap || !isLiveMapVisible()) return false;

    renderTrack();
    renderTargetLine();
    renderTargetMarker();
    renderOriginMarker();
    renderRouteLine();
    renderCursor(lastPosition.lat, lastPosition.lon, lastHeading);
    updateMeta(lastPosition.lat, lastPosition.lon, lastHeading);
    getRouteTargets()?.updateTargetOverlay?.();
    ensureViewportSync();
    setMapEmptyState({ visible: false });
    return true;
  }

  function handlePositionMessage(message) {
    const lat = Number(message?.lat);
    const lon = Number(message?.lon);
    const hdg = resolveMapHeading(message);

    if (!isValidCoord(lat, lon)) return;

    if (Number.isFinite(hdg)) lastHeading = hdg;
    lastPosition = { lat, lon };

    sampleCount += 1;
    appendTrackPoint(lat, lon);

    // Collect the complete live trail even before the map tab is first shown.
    // Map creation is visibility-gated, but flight telemetry must not be.
    ensureMap();
    if (!renderLatestPosition()) return;

    if (sampleCount === 1) {
      if (!hasRestoredMapView || autoFollow) {
        suppressFollowPause = true;
        liveMap.setView([lat, lon], 11, { animate: false });
        windowRef.setTimeout(() => { suppressFollowPause = false; }, 0);
      }
    } else if (autoFollow) {
      suppressFollowPause = true;
      liveMap.panTo([lat, lon], { animate: true });
      windowRef.setTimeout(() => { suppressFollowPause = false; }, 0);
    }
  }

  function handleHeadingMessage(message) {
    const hdg = resolveMapHeading(message);
    if (hdg == null) return;
    lastHeading = hdg;
    applyCursorHeading(hdg);
  }

  function invalidateSizeStaggered() {
    if (!liveMap) return;
    if (liveMapResizeRaf != null) windowRef.cancelAnimationFrame?.(liveMapResizeRaf);
    liveMapResizeRaf = windowRef.requestAnimationFrame(() => {
      liveMapResizeRaf = null;
      if (!liveMap) return;
      liveMap.invalidateSize({ pan: false, animate: false });
    });

    if (liveMapResizeTimer != null) windowRef.clearTimeout(liveMapResizeTimer);
    liveMapResizeTimer = windowRef.setTimeout(() => {
      liveMapResizeTimer = null;
      if (!liveMap) return;
      liveMap.invalidateSize({ pan: false, animate: false });
    }, 140);
  }

  function ensureViewportSync() {
    if (!liveMap || !mapEl) return;
    const cw = mapEl.clientWidth;
    const ch = mapEl.clientHeight;
    if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) return;
    const size = liveMap.getSize();
    if (!size) return;
    if (Math.abs(size.x - cw) > 8 || Math.abs(size.y - ch) > 8) {
      liveMap.invalidateSize({ pan: false, animate: false });
    }
  }

  function handleTabActivated() {
    if (liveMapActivationTimer != null) {
      windowRef.clearTimeout?.(liveMapActivationTimer);
    }
    liveMapActivationTimer = windowRef.setTimeout(() => {
      liveMapActivationTimer = null;
      if (lastPosition && !liveMap) {
        ensureMap();
        if (!liveMap || !isLiveMapVisible()) return;
        suppressFollowPause = true;
        liveMap.setView([lastPosition.lat, lastPosition.lon], 11, { animate: false });
        renderLatestPosition();
        windowRef.setTimeout(() => { suppressFollowPause = false; }, 400);
      } else if (liveMap) {
        renderLatestPosition();
      }

      if (liveMap) invalidateSizeStaggered();
    }, 50);
  }

  function handleWindowResize() {
    if (liveMap) invalidateSizeStaggered();
  }

  function resumeFollowAndCenter() {
    ensureMap();
    autoFollow = true;
    syncFollowUiState();
    centerOnLatestPosition();
  }

  function handleWsClose() {
    const glyph = liveCursor?.getElement()?.querySelector('.live-plane-glyph');
    if (glyph) glyph.style.opacity = '0.3';
    liveMapStore.setFollowStatus('no-data');
  }

  function handleWsOpen() {
    // A WebSocket reconnect is a transport event, not a new flight. Keep the
    // breadcrumb history so a brief backend/UI connection interruption does
    // not make the beginning of the live trail disappear.
    const glyph = liveCursor?.getElement()?.querySelector('.live-plane-glyph');
    if (glyph) glyph.style.opacity = '1';
    syncFollowUiState();
  }

  function cleanup() {
    if (mapResizeObserver) {
      try {
        mapResizeObserver.disconnect();
      } catch {}
      mapResizeObserver = null;
    }
    if (liveMapResizeRaf != null) {
      windowRef.cancelAnimationFrame?.(liveMapResizeRaf);
      liveMapResizeRaf = null;
    }
    if (liveMapResizeTimer != null) {
      windowRef.clearTimeout?.(liveMapResizeTimer);
      liveMapResizeTimer = null;
    }
    if (liveMapActivationTimer != null) {
      windowRef.clearTimeout?.(liveMapActivationTimer);
      liveMapActivationTimer = null;
    }
    try {
      liveMap?.remove?.();
    } catch {}
    liveMap = null;
    liveBaseLayer = null;
    liveBaseLayerFallbackActive = false;
    livePath = null;
    liveCursor = null;
    targetLine = null;
    routeLine = null;
    targetMarker = null;
    originMarker = null;
  }

  return {
    cleanup,
    ensureMap,
    getLiveMap: () => liveMap,
    getLastPosition: () => lastPosition,
    getDistanceNm,
    getInitialBearingDeg,
    renderOriginMarker,
    renderRouteLine,
    renderTargetLine,
    renderTargetMarker,
    handleHeadingMessage,
    handlePositionMessage,
    handleTabActivated,
    handleWindowResize,
    handleWsClose,
    handleWsOpen,
    invalidateSizeStaggered,
    restoreFollowMode,
    resumeFollowAndCenter,
    syncFollowUiState,
  };
}
