// 3D counterpart of the timeline replay map: the recorded track at altitude,
// event markers lifted to the altitude the aircraft had at that moment, and
// the replay cursor as an aircraft model driven by the scrubber. It exposes
// the same surface as the 2D controller so the view switch can swap them.

import { findNearestTimelineTrackPoint, selectTimelineMapEventMarkers } from './map-controller.js';
import { getTimelineEventMarkerVisual } from './map.js';
import { getEventAttitudeDeg, normalizeTimelineTrackPoints } from './track-points.js';
import { createFlightScene, WEBGL_CONTEXT_LOST_STATUS } from '../maps/three-d/scene.js';
import { loadThree as defaultLoadThree } from '../maps/three-d/load-three.js';
import { createSceneProjection, FEET_TO_METERS } from '../maps/three-d/projection.js';
import { planGroundTiles } from '../maps/three-d/ground-tiles.js';
import { createEventBadgeCanvas } from '../maps/three-d/marker-sprites.js';
import { createTerrainProvider as defaultCreateTerrainProvider } from '../maps/three-d/terrain-tiles.js';
import {
  buildTrackColorScale,
  buildTrackGeometry,
  computeTrackBounds,
  computeTrackFloorFt,
  derivePointMetrics,
} from '../maps/three-d/track-geometry.js';
import { normalizeMap3dOptions } from '../maps/three-d/view-mode.js';
import {
  daylightLighting,
  formatZuluTime,
  lightingForSunElevation,
  sunPosition,
} from '../maps/three-d/sun-position.js';

const ACTIVATION_RETRY_INTERVAL_MS = 500;

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function areSortedFiniteTimestamps(timestamps) {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of timestamps) {
    if (!Number.isFinite(value) || value < previous) return false;
    previous = value;
  }
  return timestamps.length > 0;
}

function buildTimelineKey(timeline, trackPoints, positioned) {
  const first = trackPoints[0];
  const last = trackPoints[trackPoints.length - 1];
  return [
    timeline?.flightId || timeline?.filePath || '',
    timeline?.generatedAt || '',
    trackPoints.length,
    first ? `${first.timestampMs}:${first.lat}:${first.lon}` : '',
    last ? `${last.timestampMs}:${last.lat}:${last.lon}` : '',
    positioned.length,
    positioned.map((item) => item.originalIndex).join(','),
  ].join('|');
}

export function createTimelineMap3dController({
  containerEl = null,
  timelineStore,
  windowRef = window,
  documentRef = document,
  consoleRef = console,
  isTimelineTabVisible = () => false,
  isValidCoord = null,
  eventPassesMapFilter = () => true,
  getEventPosition = () => null,
  getEventAttitude = getEventAttitudeDeg,
  jumpToTimelineEvent = () => {},
  updateOrientationWidget = () => {},
  syncScrubberToTimestamp = () => {},
  updateProfileCursor = () => {},
  getTimelineScrubberStartMs = () => null,
  allowOnlineTiles = () => true,
  getOptions = () => ({}),
  loadThree = defaultLoadThree,
  createScene = createFlightScene,
  createTerrainProvider = defaultCreateTerrainProvider,
} = {}) {
  let scene = null;
  let terrainProvider = null;
  let activationRetryTimer = null;
  let sceneLoading = null;
  let sceneError = '';
  let sceneContextLost = false;
  let disposed = false;
  let active = false;
  let currentTimeline = null;
  let trackPoints = [];
  let trackTimestamps = [];
  let trackTimestampsSorted = false;
  let positionedEvents = [];
  let projection = null;
  let renderedKey = '';
  let renderedOptionsKey = '';
  let framedKey = '';
  let lastCursor = null;
  let resizeObserver = null;
  let colorScale = null;
  let trackBounds = null;
  const badgeCache = new Map();

  function currentOptions() {
    return normalizeMap3dOptions(getOptions());
  }

  // Phones and narrow windows get the compact quality profile.
  function sceneQuality() {
    const width = Number(windowRef.innerWidth);
    const coarse = windowRef.matchMedia?.('(pointer: coarse)')?.matches === true;
    return (Number.isFinite(width) && width <= 760) || coarse ? 'compact' : 'high';
  }

  function terrainActive() {
    return currentOptions().showTerrain === true && allowOnlineTiles() === true;
  }

  function getTerrainProvider() {
    if (!terrainProvider) terrainProvider = createTerrainProvider({ documentRef, consoleRef });
    return terrainProvider;
  }

  function optionsKey(options) {
    return `${options.colorMode}|${options.verticalScale}|${options.showCurtain}|${terrainActive() ? 'terrain' : 'flat'}`;
  }

  function formatFeet(value) {
    return Math.round(value).toLocaleString('en-US');
  }

  // Terrain height under the replay cursor in feet MSL, or null before the
  // elevation tiles arrive or when terrain is off.
  function terrainElevationAt(scenePosition) {
    if (!scene || !projection || !scenePosition || !scene.hasTerrain?.()) return null;
    const groundY = scene.groundHeightAt?.(scenePosition.x, scenePosition.z);
    if (!Number.isFinite(groundY)) return null;
    return projection.floorFt + (groundY / projection.altitudeUnitsPerFoot);
  }

  function setMapEmptyState(state) {
    timelineStore.setMapEmptyState(state);
  }

  function setStatus(message) {
    timelineStore.setScene3dStatus?.(message || '');
  }

  let cursorTerrain = { terrainElevationFt: null, aboveTerrainFt: null };
  let lightingState = null;

  // Simulator UTC for a moment of the recording: the recording's simulator
  // start clock plus the elapsed time, or the recording clock itself when
  // the CSV carries no simulator clock.
  function simulatorTimeAt(timestampMs) {
    const elapsedFrom = finiteOrNull(trackPoints[0]?.timestampMs);
    const at = finiteOrNull(timestampMs);
    if (at === null) return null;
    const simStartMs = Date.parse(currentTimeline?.simDateTimeUtc || '');
    if (Number.isFinite(simStartMs) && elapsedFrom !== null) {
      return { timeMs: simStartMs + (at - elapsedFrom), source: 'sim' };
    }
    return { timeMs: at, source: 'recording' };
  }

  function updateLighting(pos, timestampMs, { immediate = false } = {}) {
    if (!scene) return;
    const options = currentOptions();
    const moment = options.lighting === 'day' ? null : simulatorTimeAt(timestampMs);
    let next;
    if (!moment || !pos) {
      next = { ...daylightLighting(), source: options.lighting === 'day' ? 'day' : 'none', timeMs: null };
      scene.setLighting(next, { immediate });
    } else {
      const sun = sunPosition(moment.timeMs, pos.lat, pos.lon);
      next = { ...lightingForSunElevation(sun.elevationDeg), source: moment.source, timeMs: moment.timeMs };
      scene.setLighting(next, { sunAzimuthDeg: sun.azimuthDeg, sunElevationDeg: sun.elevationDeg, immediate });
    }
    const state = {
      phase: next.phase,
      phaseLabel: next.phaseLabel,
      source: next.source,
      timeText: next.timeMs === null ? '' : formatZuluTime(next.timeMs),
      sunElevationDeg: next.sunElevationDeg,
    };
    const changed = !lightingState
      || state.phase !== lightingState.phase
      || state.timeText !== lightingState.timeText
      || state.source !== lightingState.source;
    lightingState = state;
    if (changed) publishLegend();
  }

  function publishLegend() {
    if (!colorScale) return;
    timelineStore.setScene3dLegend?.({
      lighting: lightingState,
      terrainActive: terrainActive(),
      ...cursorTerrain,
      mode: colorScale.mode,
      label: colorScale.label,
      unit: colorScale.unit,
      kind: colorScale.kind,
      gradientCss: colorScale.gradientCss,
      lower: colorScale.lower,
      upper: colorScale.upper,
      hasData: colorScale.hasData,
      poleLabels: colorScale.poleLabels,
      groundPlaneFt: projection?.floorFt ?? null,
      verticalScale: projection?.verticalScale ?? null,
    });
  }

  function getBadge(event) {
    const visual = getTimelineEventMarkerVisual(event);
    const key = JSON.stringify(visual);
    if (!badgeCache.has(key)) badgeCache.set(key, createEventBadgeCanvas(documentRef, visual));
    return badgeCache.get(key);
  }

  function nearestTrackPoint(timestampMs) {
    return findNearestTimelineTrackPoint(trackPoints, trackTimestamps, timestampMs, trackTimestampsSorted);
  }

  function refreshGround() {
    if (!scene || !projection || sceneContextLost || !active || !isTimelineTabVisible() || !scene.isActive()) return;
    if (allowOnlineTiles() !== true) {
      scene.setGroundTiles([]);
      scene.setGroundGrid({ size: 600000 });
      return;
    }
    scene.setGroundTiles(planGroundTiles({
      trackBounds,
      viewInfo: scene.getViewInfo(),
      projection,
    }), {
      terrain: terrainActive() ? {
        provider: getTerrainProvider(),
        unitsPerMeter: projection.groundScale * projection.verticalScale,
        floorMeters: projection.floorFt * FEET_TO_METERS,
      } : null,
    });
  }

  function renderCursorToScene() {
    if (!scene || !projection || sceneContextLost || !active || !isTimelineTabVisible() || !scene.isActive()) return;
    if (!lastCursor?.pos) {
      scene.setAircraft({ visible: false });
      return;
    }
    const { pos, attitude, timestampMs } = lastCursor;
    const altFt = Number.isFinite(attitude?.altFt) ? attitude.altFt : projection.floorFt;
    const position = projection.toScene(pos.lat, pos.lon, altFt);
    updateLighting(pos, timestampMs);
    const terrainFt = terrainElevationAt(position);
    const aboveTerrainFt = terrainFt === null ? null : altFt - terrainFt;
    const labelParts = [`${formatFeet(altFt)} ft`];
    if (aboveTerrainFt !== null) labelParts.push(`${formatFeet(Math.max(0, aboveTerrainFt))} AGL`);
    scene.setAircraft({
      x: position.x,
      y: position.y,
      z: position.z,
      headingDeg: attitude?.headingDeg ?? 0,
      pitchDeg: attitude?.pitchDeg ?? 0,
      rollDeg: attitude?.rollDeg ?? 0,
      visible: true,
      altitudeFt: altFt,
      altitudeUnitsPerFoot: projection.altitudeUnitsPerFoot,
      floorFt: projection.floorFt,
      label: labelParts.join(' \u00b7 '),
    });
    const nextTerrain = { terrainElevationFt: terrainFt, aboveTerrainFt };
    if (nextTerrain.terrainElevationFt !== cursorTerrain.terrainElevationFt
      || nextTerrain.aboveTerrainFt !== cursorTerrain.aboveTerrainFt) {
      cursorTerrain = nextTerrain;
      publishLegend();
    }
    return position;
  }

  function renderScene({ refit = false } = {}) {
    if (!scene || !currentTimeline || sceneContextLost || !active || !isTimelineTabVisible() || !scene.isActive()) return;
    const options = currentOptions();
    const nextOptionsKey = optionsKey(options);
    const key = buildTimelineKey(currentTimeline, trackPoints, positionedEvents);
    const needsRebuild = key !== renderedKey || nextOptionsKey !== renderedOptionsKey;

    if (needsRebuild) {
      renderedKey = key;
      renderedOptionsKey = nextOptionsKey;
      const segments = trackPoints.length > 0 ? [trackPoints] : [];
      const { segments: derivedSegments } = derivePointMetrics(segments);
      // With terrain the ground plane is sea level and the tiles rise to meet
      // the track; without it the lowest recorded altitude is the ground.
      const floorFt = terrainActive() ? 0 : computeTrackFloorFt(derivedSegments);
      trackBounds = computeTrackBounds(derivedSegments)
        || computeTrackBounds([positionedEvents.map((item) => item.pos)]);
      projection = createSceneProjection({
        refLat: trackBounds?.centerLat ?? 0,
        refLon: trackBounds?.centerLon ?? 0,
        floorFt,
        verticalScale: options.verticalScale,
      });
      colorScale = buildTrackColorScale(derivedSegments, options.colorMode);
      const geometry = buildTrackGeometry(derivedSegments, projection, colorScale);
      scene.setTrack(geometry);
      scene.setCurtainVisible(options.showCurtain);

      const markers = [];
      // Same priority-based cap as the 2D map so both views show the same
      // events when a recording has more markers than is readable.
      for (const { event, pos, originalIndex } of selectTimelineMapEventMarkers(positionedEvents)) {
        const badge = getBadge(event);
        if (!badge) continue;
        const nearest = nearestTrackPoint(Number(event?.timestampMs));
        const altFt = finiteOrNull(nearest?.altFt)
          ?? finiteOrNull(event?.alt_msl_ft)
          ?? finiteOrNull(event?.alt_ft)
          ?? floorFt;
        const position = projection.toScene(pos.lat, pos.lon, altFt);
        markers.push({ id: originalIndex, x: position.x, y: position.y, z: position.z, badge });
      }
      scene.setMarkers(markers);
      publishLegend();

      const fitKey = `${currentTimeline?.flightId || currentTimeline?.filePath || ''}|${trackPoints.length}`;
      if (refit || fitKey !== framedKey) {
        framedKey = fitKey;
        const bounds = geometry.bounds || (markers.length > 0
          ? markers.reduce((acc, marker) => ({
            minX: Math.min(acc.minX, marker.x),
            maxX: Math.max(acc.maxX, marker.x),
            minY: Math.min(acc.minY, marker.y),
            maxY: Math.max(acc.maxY, marker.y + 1),
            minZ: Math.min(acc.minZ, marker.z),
            maxZ: Math.max(acc.maxZ, marker.z),
          }), {
            minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity,
          })
          : null);
        if (bounds) scene.fitToBounds(bounds);
      }
    }
    // The cursor can move while graphics are unavailable even if the track
    // and options remain unchanged. Reassert it whenever a retained view resumes.
    if (!lastCursor?.pos && trackPoints[0]) {
      updateLighting(trackPoints[0], trackPoints[0].timestampMs, { immediate: needsRebuild });
    }
    renderCursorToScene();
    // A retained scene may have cancelled terrain work while hidden. Reassert
    // the current viewport and online setting even when the track is unchanged.
    refreshGround();
  }

  function handleMarkerClick(markerId) {
    const item = positionedEvents.find((entry) => entry.originalIndex === markerId);
    if (!item) return;
    jumpToTimelineEvent(item.event, item.originalIndex, { shouldPanMap: true });
  }

  function handleViewSettled() {
    refreshGround();
  }

  function handleTerrainUpdated() {
    if (!active || !scene || sceneContextLost || !isTimelineTabVisible() || !scene.isActive()) return;
    renderCursorToScene();
  }

  function handleContextLost() {
    sceneContextLost = true;
    sceneError = WEBGL_CONTEXT_LOST_STATUS;
    setStatus(sceneError);
  }

  function handleContextRestored() {
    sceneContextLost = false;
    sceneError = '';
    setStatus('');
    if (!active || !isTimelineTabVisible()) return;
    scene.start();
    scene.resize();
    renderScene();
  }

  function attachResizeObserver() {
    if (resizeObserver || typeof windowRef.ResizeObserver !== 'function' || !containerEl) return;
    resizeObserver = new windowRef.ResizeObserver(() => {
      if (scene?.resize()) scene.requestRender();
    });
    resizeObserver.observe(containerEl);
  }

  // A failed start (no WebGL, chunk failed to load) is not retried on its
  // own; the next explicit selection of the 3D view tries again.
  function ensureScene() {
    if (disposed || scene || sceneLoading || !containerEl || sceneError) return sceneLoading;
    if (!isTimelineTabVisible()) return null;
    setStatus('Loading 3D view...');
    sceneLoading = loadThree()
      .then((three) => {
        if (sceneLoading === null) return null;
        scene = createScene({
          containerEl,
          three,
          windowRef,
          documentRef,
          consoleRef,
          onViewSettled: handleViewSettled,
          quality: sceneQuality(),
          onMarkerClick: handleMarkerClick,
          onTerrainUpdated: handleTerrainUpdated,
          onContextLost: handleContextLost,
          onContextRestored: handleContextRestored,
        });
        sceneError = '';
        setStatus('');
        attachResizeObserver();
        if (activationRetryTimer != null) {
          windowRef.clearInterval?.(activationRetryTimer);
          activationRetryTimer = null;
        }
        if (active && isTimelineTabVisible()) {
          scene.start();
          renderScene({ refit: true });
        }
        return scene;
      })
      .catch((error) => {
        if (disposed) return null;
        sceneError = `3D view unavailable: ${error?.message || error}`;
        consoleRef.warn?.('[TimelineMap3D] Could not start the 3D view', error);
        setStatus(sceneError);
        if (active) setMapEmptyState({ visible: true, message: sceneError });
        return null;
      })
      .finally(() => {
        sceneLoading = null;
      });
    return sceneLoading;
  }

  function setActive(nextActive) {
    active = nextActive === true;
    if (activationRetryTimer != null) {
      windowRef.clearInterval?.(activationRetryTimer);
      activationRetryTimer = null;
    }
    if (!active) {
      scene?.stop();
      return;
    }
    if (sceneContextLost) return;
    if (!scene) {
      // Selecting the view again is the user's retry after a failed start.
      sceneError = '';
      if (ensureScene() === null && !sceneLoading) {
        // The surface may still be hidden while the view switch settles, or
        // the window may be occluded; keep trying until it can start.
        activationRetryTimer = windowRef.setInterval(() => {
          if (!active || scene || sceneError) {
            windowRef.clearInterval?.(activationRetryTimer);
            activationRetryTimer = null;
            return;
          }
          ensureScene();
        }, ACTIVATION_RETRY_INTERVAL_MS);
      }
      return;
    }
    if (!isTimelineTabVisible()) return;
    scene.start();
    scene.resize();
    renderScene();
  }

  function render(timeline) {
    currentTimeline = timeline || null;
    trackPoints = normalizeTimelineTrackPoints(timeline, {
      isValidCoord,
      getEventPosition,
      getEventAttitude,
    });
    trackTimestamps = trackPoints.map((point) => Number(point?.timestampMs));
    trackTimestampsSorted = areSortedFiniteTimestamps(trackTimestamps);
    positionedEvents = (Array.isArray(timeline?.events) ? timeline.events : [])
      .map((event, originalIndex) => ({ event, pos: getEventPosition(event), originalIndex }))
      .filter((item) => item.pos)
      .filter((item) => eventPassesMapFilter(item.event));

    if (!active || !isTimelineTabVisible()) return trackPoints;

    const hasData = trackPoints.length > 0 || positionedEvents.length > 0;
    setMapEmptyState({
      visible: !hasData,
      message: sceneError || 'No positional event data yet',
    });
    if (!hasData) {
      scene?.setTrack(null);
      scene?.setMarkers([]);
      return trackPoints;
    }

    if (!scene) {
      // A failed WebGL start is shown in place of the map; selecting the 3D
      // view again is what retries it.
      if (sceneError) setMapEmptyState({ visible: true, message: sceneError });
      else ensureScene();
      return trackPoints;
    }
    if (sceneContextLost) return trackPoints;
    if (!scene.isActive()) {
      scene.start();
      scene.resize();
    }
    renderScene();
    return trackPoints;
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
    if (!pos) return;
    lastCursor = {
      pos: { lat: pos.lat, lon: pos.lon },
      timestampMs: finiteOrNull(pos.timestampMs),
      attitude: {
        headingDeg: Number.isFinite(headingDeg) ? headingDeg : null,
        pitchDeg: Number.isFinite(pitchDeg) ? pitchDeg : null,
        rollDeg: Number.isFinite(rollDeg) ? rollDeg : null,
        altFt: Number.isFinite(altFt) ? altFt : null,
      },
    };
    if (!scene || !active) return;
    const position = renderCursorToScene();
    if (shouldPan && position) scene.moveTargetTo(position.x, position.y, position.z, { animate: true });
  }

  function focusEvent(event) {
    const nearest = nearestTrackPoint(Number(event?.timestampMs));
    const eventPos = getEventPosition(event);
    const pos = nearest || eventPos;
    const attitude = getEventAttitude(event);
    const headingDeg = Number(nearest?.hdgTrueDeg ?? attitude.headingDeg);
    const pitchDeg = Number(nearest?.pitchDeg ?? attitude.pitchDeg);
    const rollDeg = Number(nearest?.rollDeg ?? attitude.rollDeg);
    const iasKts = Number(nearest?.iasKts ?? event?.ias_kts);
    const altFt = Number(nearest?.altFt ?? event?.alt_msl_ft ?? event?.alt_ft);
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
      if (Number.isFinite(scrubberStartMs)) updateProfileCursor(eventTs - scrubberStartMs);
    }
  }

  function fitView() {
    if (!scene || !currentTimeline) return;
    framedKey = '';
    renderedKey = '';
    renderScene({ refit: true });
  }

  function applyOptions() {
    if (!scene || !active || sceneContextLost || !isTimelineTabVisible() || !scene.isActive()) return;
    renderScene();
    if (lastCursor?.pos) updateLighting(lastCursor.pos, lastCursor.timestampMs, { immediate: true });
    else if (trackPoints[0]) updateLighting(trackPoints[0], trackPoints[0].timestampMs, { immediate: true });
  }

  function invalidateSizeStaggered() {
    if (!scene || sceneContextLost || !active) return;
    if (!isTimelineTabVisible()) {
      scene.stop();
      return;
    }
    if (!scene.isActive()) { scene.start(); renderScene(); }
    if (scene.resize()) scene.requestRender();
  }

  // The tab is hidden: stop the render loop but keep the scene so
  // returning is instant.
  function suspend() {
    scene?.stop();
  }

  function reset() {
    currentTimeline = null;
    trackPoints = [];
    trackTimestamps = [];
    trackTimestampsSorted = false;
    positionedEvents = [];
    renderedKey = '';
    renderedOptionsKey = '';
    framedKey = '';
    lastCursor = null;
    colorScale = null;
    trackBounds = null;
    scene?.setTrack(null);
    scene?.setMarkers([]);
    scene?.setAircraft({ visible: false });
    scene?.setGroundTiles([]);
    updateOrientationWidget(null, null, null);
  }

  function destroy() {
    disposed = true;
    active = false;
    sceneLoading = null;
    if (activationRetryTimer != null) {
      windowRef.clearInterval?.(activationRetryTimer);
      activationRetryTimer = null;
    }
    resizeObserver?.disconnect?.();
    resizeObserver = null;
    reset();
    scene?.dispose();
    scene = null;
    terrainProvider?.dispose?.();
    terrainProvider = null;
    sceneError = '';
    sceneContextLost = false;
    badgeCache.clear();
  }

  return {
    applyOptions,
    destroy,
    fitView,
    focusEvent,
    getLastCursor: () => lastCursor,
    getSceneError: () => sceneError,
    hasMap: () => Boolean(scene),
    invalidateSizeStaggered,
    render,
    reset,
    setActive,
    setCursorPosition,
    suspend,
  };
}
