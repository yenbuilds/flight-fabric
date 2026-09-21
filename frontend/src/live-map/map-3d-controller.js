// 3D counterpart of the live map controller. It collects the flight with
// altitude and speed from the moment telemetry starts (like the 2D trail, it
// must not depend on the tab being visible), and drives the three.js scene
// only while the 3D view is showing. The scene itself is created lazily the
// first time the view is visible, because three.js loads as its own chunk
// and WebGL may be unavailable.

import { getGreatCirclePath, unwrapLatLngPath } from './geo.js';
import { createLiveTrackBuffer } from './live-track-buffer.js';
import { createFlightScene, WEBGL_CONTEXT_LOST_STATUS } from '../maps/three-d/scene.js';
import { loadThree as defaultLoadThree } from '../maps/three-d/load-three.js';
import { createSceneProjection, FEET_TO_METERS } from '../maps/three-d/projection.js';
import { planGroundTiles } from '../maps/three-d/ground-tiles.js';
import { createLabelCanvas } from '../maps/three-d/marker-sprites.js';
import { createTerrainProvider as defaultCreateTerrainProvider } from '../maps/three-d/terrain-tiles.js';
import {
  buildTrackColorScale,
  buildTrackGeometry,
  computeTrackBounds,
  derivePointMetrics,
} from '../maps/three-d/track-geometry.js';
import { normalizeMap3dOptions } from '../maps/three-d/view-mode.js';
import {
  daylightLighting,
  formatZuluTime,
  lightingForSunElevation,
  sunPosition,
} from '../maps/three-d/sun-position.js';

const TRACK_REFRESH_MIN_INTERVAL_MS = 500;
const ACTIVATION_RETRY_INTERVAL_MS = 500;
// The sun moves a quarter of a degree a minute; refreshing the rig every
// half minute keeps twilight smooth without recomputing per message.
const LIGHTING_REFRESH_INTERVAL_MS = 30000;
const GROUND_REFRESH_MIN_INTERVAL_MS = 2500;
const FOLLOW_MODE_STORAGE_KEY = 'ff.liveMap.followMode3d.v1';
const ORIGIN_PIN_COLOR = 0x10b981;
const TARGET_PIN_COLOR = 0x3b82f6;

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function createLiveMap3dController({
  containerEl,
  liveMapStore,
  windowRef = window,
  documentRef = document,
  consoleRef = console,
  isValidCoord = () => true,
  getRouteTargets = () => null,
  allowOnlineTiles = () => true,
  isVisible = () => false,
  getOptions = () => ({}),
  loadThree = defaultLoadThree,
  createScene = createFlightScene,
  createTerrainProvider = defaultCreateTerrainProvider,
  localStorageRef = null,
  now = () => Date.now(),
} = {}) {
  const track = createLiveTrackBuffer({ now });
  const telemetry = {
    altFt: null,
    aglFt: null,
    gsKts: null,
    vsFpm: null,
    iasKts: null,
    headingDeg: null,
    pitchDeg: null,
    rollDeg: null,
    // The simulator's own clock, extrapolated between broadcasts.
    simZuluMs: null,
    simTimeReceivedAtMs: null,
  };
  let lastPosition = null;
  let lastLightingAt = 0;
  let lightingState = null;
  let scene = null;
  let sceneLoading = null;
  let sceneError = '';
  let sceneContextLost = false;
  let disposed = false;
  let active = false;
  let autoFollow = true;
  let projection = null;
  let projectionKey = '';
  let renderedTrackVersion = -1;
  let trackRefreshTimer = null;
  let lastTrackRefreshAt = 0;
  let lastGroundRefreshAt = 0;
  let groundRefreshTimer = null;
  let resizeObserver = null;
  let hasFramedFlight = false;
  let colorScale = null;
  let renderedPinsKey = '';
  let renderedRouteKey = '';
  let renderedGridKey = '';
  let terrainProvider = null;
  let activationRetryTimer = null;

  function terrainActive() {
    return currentOptions().showTerrain === true && allowOnlineTiles() === true;
  }

  function getTerrainProvider() {
    if (!terrainProvider) terrainProvider = createTerrainProvider({ documentRef, consoleRef });
    return terrainProvider;
  }

  function currentOptions() {
    return normalizeMap3dOptions(getOptions());
  }

  // Phones and narrow windows get the compact quality profile.
  function sceneQuality() {
    const width = Number(windowRef.innerWidth);
    const coarse = windowRef.matchMedia?.('(pointer: coarse)')?.matches === true;
    return (Number.isFinite(width) && width <= 760) || coarse ? 'compact' : 'high';
  }

  // Drawing is worth doing only while the view is selected and its loop
  // runs; telemetry is still collected otherwise.
  function canDraw() {
    return active && isVisible() && !sceneContextLost && Boolean(scene) && scene.isActive();
  }

  function setStatus(message) {
    liveMapStore.setScene3dStatus?.(message || '');
  }

  function syncFollowUiState() {
    if (!active) return;
    liveMapStore.setFollowStatus(autoFollow ? 'following' : 'paused');
    try {
      localStorageRef?.setItem?.(FOLLOW_MODE_STORAGE_KEY, autoFollow ? 'follow' : 'paused');
    } catch {}
  }

  function restoreFollowMode() {
    try {
      const mode = localStorageRef?.getItem?.(FOLLOW_MODE_STORAGE_KEY);
      if (mode === 'paused') autoFollow = false;
      if (mode === 'follow') autoFollow = true;
    } catch {}
  }

  function applyFollowMode() {
    if (!scene) return;
    scene.setFollowMode(autoFollow ? currentOptions().cameraMode : 'none');
  }

  function ensureProjection() {
    const first = track.getSegments().find((segment) => segment.length > 0)?.[0] || lastPosition;
    if (!first) return null;
    // With terrain the ground plane is sea level and the tiles rise to meet
    // the aircraft; without it the lowest recorded altitude is the ground.
    // The oldest segments may be retired to bound the trail. Keep the flight's
    // altitude reference instead of moving the ground up to the retained track.
    const floorFt = terrainActive() ? 0 : Math.floor((track.getMinAltFt() ?? 0) / 50) * 50;
    const options = currentOptions();
    const key = `${first.lat.toFixed(4)}|${first.lon.toFixed(4)}|${floorFt}|${options.verticalScale}|${terrainActive() ? 'terrain' : 'flat'}`;
    if (key !== projectionKey || !projection) {
      projection = createSceneProjection({
        refLat: first.lat,
        refLon: first.lon,
        floorFt,
        verticalScale: options.verticalScale,
      });
      projectionKey = key;
      renderedTrackVersion = -1;
      lastGroundRefreshAt = 0;
    }
    return projection;
  }

  function currentAltitudeFt() {
    return telemetry.altFt ?? track.getLatest()?.altFt ?? projection?.floorFt ?? 0;
  }

  // Terrain height under the aircraft from the loaded elevation tiles, in
  // feet MSL, or null before they arrive or when terrain is off.
  function terrainElevationFt() {
    if (!scene || !projection || !lastPosition || !scene.hasTerrain?.()) return null;
    const position = projection.toScene(lastPosition.lat, lastPosition.lon, projection.floorFt);
    const groundY = scene.groundHeightAt?.(position.x, position.z);
    if (!Number.isFinite(groundY)) return null;
    return projection.floorFt + (groundY / projection.altitudeUnitsPerFoot);
  }

  function heightAboveGroundFt() {
    if (Number.isFinite(telemetry.aglFt)) return telemetry.aglFt;
    const terrainFt = terrainElevationFt();
    return terrainFt === null ? null : currentAltitudeFt() - terrainFt;
  }

  function formatFeet(value) {
    return Math.round(value).toLocaleString('en-US');
  }

  function aircraftLabel() {
    const altitude = currentAltitudeFt();
    const agl = heightAboveGroundFt();
    const parts = [`${formatFeet(altitude)} ft`];
    if (Number.isFinite(agl)) parts.push(`${formatFeet(Math.max(0, agl))} AGL`);
    return parts.join(' \u00b7 ');
  }

  // Simulator UTC now, or null when the simulator has not reported a clock.
  function currentSimTimeMs() {
    if (!Number.isFinite(telemetry.simZuluMs) || !Number.isFinite(telemetry.simTimeReceivedAtMs)) return null;
    return telemetry.simZuluMs + Math.max(0, now() - telemetry.simTimeReceivedAtMs);
  }

  // Point the light rig at the sun for the aircraft's position and the
  // simulator clock (falling back to the real clock, and saying so).
  function updateLighting({ force = false } = {}) {
    if (!scene) return;
    if (!force && now() - lastLightingAt < LIGHTING_REFRESH_INTERVAL_MS) return;
    lastLightingAt = now();
    const options = currentOptions();
    let next;
    if (options.lighting === 'day' || !lastPosition) {
      next = { ...daylightLighting(), source: options.lighting === 'day' ? 'day' : 'none', timeMs: null };
      scene.setLighting(next, { immediate: force });
    } else {
      const simTimeMs = currentSimTimeMs();
      const timeMs = simTimeMs ?? now();
      const sun = sunPosition(timeMs, lastPosition.lat, lastPosition.lon);
      next = {
        ...lightingForSunElevation(sun.elevationDeg),
        source: simTimeMs === null ? 'clock' : 'sim',
        timeMs,
      };
      scene.setLighting(next, { sunAzimuthDeg: sun.azimuthDeg, sunElevationDeg: sun.elevationDeg, immediate: force });
    }
    lightingState = {
      phase: next.phase,
      phaseLabel: next.phaseLabel,
      source: next.source,
      timeText: next.timeMs === null ? '' : formatZuluTime(next.timeMs),
      sunElevationDeg: next.sunElevationDeg,
    };
  }

  function publishHud() {
    if (sceneContextLost) {
      liveMapStore.setScene3dHud?.(null);
      return;
    }
    liveMapStore.setScene3dHud?.({
      lighting: lightingState,
      altitudeFt: currentAltitudeFt(),
      aglFt: heightAboveGroundFt(),
      terrainElevationFt: terrainElevationFt(),
      terrainActive: terrainActive(),
      groundSpeedKts: telemetry.gsKts,
      verticalSpeedFpm: telemetry.vsFpm,
      iasKts: telemetry.iasKts,
      headingDeg: telemetry.headingDeg,
      groundPlaneFt: projection?.floorFt ?? null,
      verticalScale: currentOptions().verticalScale,
      pointCount: track.size(),
    });
  }

  function publishLegend() {
    if (!colorScale) return;
    liveMapStore.setScene3dLegend?.({
      mode: colorScale.mode,
      label: colorScale.label,
      unit: colorScale.unit,
      kind: colorScale.kind,
      gradientCss: colorScale.gradientCss,
      lower: colorScale.lower,
      upper: colorScale.upper,
      hasData: colorScale.hasData,
      poleLabels: colorScale.poleLabels,
    });
  }

  function renderAircraft() {
    if (!scene || sceneContextLost || !lastPosition) return;
    const projectionRef = ensureProjection();
    if (!projectionRef) return;
    const position = projectionRef.toScene(lastPosition.lat, lastPosition.lon, currentAltitudeFt());
    scene.setAircraft({
      x: position.x,
      y: position.y,
      z: position.z,
      headingDeg: telemetry.headingDeg ?? 0,
      pitchDeg: telemetry.pitchDeg ?? 0,
      rollDeg: telemetry.rollDeg ?? 0,
      visible: true,
      altitudeFt: currentAltitudeFt(),
      altitudeUnitsPerFoot: projectionRef.altitudeUnitsPerFoot,
      floorFt: projectionRef.floorFt,
      label: aircraftLabel(),
    });
  }

  function renderTrack() {
    if (!canDraw()) return;
    const projectionRef = ensureProjection();
    if (!projectionRef) return;
    const version = track.getVersion();
    if (version === renderedTrackVersion) return;
    renderedTrackVersion = version;
    lastTrackRefreshAt = now();

    const options = currentOptions();
    const { segments } = derivePointMetrics(track.getSegments());
    colorScale = buildTrackColorScale(segments, options.colorMode);
    const geometry = buildTrackGeometry(segments, projectionRef, colorScale);
    scene.setTrack(geometry);
    scene.setCurtainVisible(options.showCurtain);
    publishLegend();
    renderAircraft();
    renderRouteOverlays();

    if (!hasFramedFlight && geometry.bounds) {
      hasFramedFlight = true;
      if (autoFollow) {
        applyFollowMode();
        scene.snapToFollowTarget();
      } else {
        scene.fitToBounds(geometry.bounds);
      }
    }
    scheduleGroundRefresh();
  }

  function scheduleTrackRefresh() {
    if (!canDraw()) return;
    if (trackRefreshTimer != null) return;
    const elapsed = now() - lastTrackRefreshAt;
    const delay = Math.max(0, TRACK_REFRESH_MIN_INTERVAL_MS - elapsed);
    trackRefreshTimer = windowRef.setTimeout(() => {
      trackRefreshTimer = null;
      renderTrack();
    }, delay);
  }

  function refreshGround() {
    if (!canDraw()) return;
    lastGroundRefreshAt = now();
    const projectionRef = ensureProjection();
    if (!projectionRef) return;
    if (allowOnlineTiles() !== true) {
      scene.setGroundTiles([]);
      const center = lastPosition ? projectionRef.toScene(lastPosition.lat, lastPosition.lon, projectionRef.floorFt) : { x: 0, z: 0 };
      // Re-centre the fallback grid only once the aircraft has left it.
      const gridKey = `${projectionKey}|${Math.round(center.x / 150000)}|${Math.round(center.z / 150000)}`;
      if (gridKey !== renderedGridKey) {
        renderedGridKey = gridKey;
        scene.setGroundGrid({ size: 600000, centerX: center.x, centerZ: center.z });
      }
      return;
    }
    // Always plan around the camera as it is now: while following, the
    // target moves with the aircraft between user gestures.
    scene.setGroundTiles(planGroundTiles({
      trackBounds: computeTrackBounds(track.getSegments()),
      viewInfo: scene.getViewInfo(),
      projection: projectionRef,
    }), {
      terrain: terrainActive() ? {
        provider: getTerrainProvider(),
        unitsPerMeter: projectionRef.groundScale * projectionRef.verticalScale,
        floorMeters: projectionRef.floorFt * FEET_TO_METERS,
      } : null,
    });
  }

  function scheduleGroundRefresh({ immediate = false } = {}) {
    if (!canDraw()) return;
    if (groundRefreshTimer != null) return;
    const elapsed = now() - lastGroundRefreshAt;
    const delay = immediate ? 0 : Math.max(0, GROUND_REFRESH_MIN_INTERVAL_MS - elapsed);
    groundRefreshTimer = windowRef.setTimeout(() => {
      groundRefreshTimer = null;
      refreshGround();
    }, delay);
  }

  function pathToScenePositions(latLngPath, projectionRef, { startAltFt = null, endAltFt = null } = {}) {
    const positions = [];
    const count = latLngPath.length;
    let previous = null;
    for (let index = 0; index < count; index += 1) {
      const [lat, lon] = latLngPath[index];
      const fraction = count > 1 ? index / (count - 1) : 0;
      const altFt = startAltFt === null || endAltFt === null
        ? projectionRef.floorFt
        : startAltFt + ((endAltFt - startAltFt) * fraction);
      const point = projectionRef.toScene(lat, lon, altFt);
      if (previous) positions.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
      previous = point;
    }
    return Float32Array.from(positions);
  }

  function renderRouteOverlays() {
    if (!scene || sceneContextLost) return;
    const projectionRef = ensureProjection();
    if (!projectionRef) return;
    const routeTargets = getRouteTargets();
    const origin = routeTargets?.getOriginAirport?.() || null;
    const target = routeTargets?.getTargetAirport?.() || null;
    const referenceLon = lastPosition?.lon ?? origin?.lon ?? target?.lon ?? projectionRef.refLon;
    const airportKey = (airport) => (airport ? `${airport.icao}:${airport.lat}:${airport.lon}` : '-');

    // Pins and the planned route only change with the airports or the
    // projection; the target line follows the aircraft on every refresh.
    const pinsKey = `${projectionKey}|${airportKey(origin)}|${airportKey(target)}`;
    if (pinsKey !== renderedPinsKey) {
      renderedPinsKey = pinsKey;
      const pins = [];
      for (const [airport, color, prefix] of [[origin, ORIGIN_PIN_COLOR, 'FROM '], [target, TARGET_PIN_COLOR, '']]) {
        if (!airport || !isValidCoord(airport.lat, airport.lon)) continue;
        const position = projectionRef.toScene(airport.lat, airport.lon, projectionRef.floorFt);
        pins.push({
          id: `${prefix}${airport.icao}`,
          x: position.x,
          z: position.z,
          color,
          label: createLabelCanvas(documentRef, `${prefix}${airport.icao}`),
        });
      }
      scene.setPins(pins);
    }

    const routeKey = `${pinsKey}|${Math.round(referenceLon)}`;
    if (routeKey !== renderedRouteKey) {
      renderedRouteKey = routeKey;
      if (origin && target) {
        const path = unwrapLatLngPath(getGreatCirclePath(origin.lat, origin.lon, target.lat, target.lon, isValidCoord), referenceLon);
        scene.setRouteLine(path.length >= 2 ? pathToScenePositions(path, projectionRef) : null);
      } else {
        scene.setRouteLine(null);
      }
    }

    if (target && lastPosition && isValidCoord(target.lat, target.lon)) {
      const path = unwrapLatLngPath(getGreatCirclePath(lastPosition.lat, lastPosition.lon, target.lat, target.lon, isValidCoord), referenceLon);
      scene.setTargetLine(path.length >= 2
        ? pathToScenePositions(path, projectionRef, { startAltFt: currentAltitudeFt(), endAltFt: projectionRef.floorFt })
        : null);
    } else {
      scene.setTargetLine(null);
    }
  }

  function handleUserPan() {
    if (!autoFollow) return;
    autoFollow = false;
    applyFollowMode();
    syncFollowUiState();
  }

  function handleViewSettled() {
    scheduleGroundRefresh({ immediate: true });
  }

  function handleTerrainUpdated() {
    if (!canDraw()) return;
    renderAircraft();
    publishHud();
  }

  function handleContextLost() {
    sceneContextLost = true;
    sceneError = WEBGL_CONTEXT_LOST_STATUS;
    setStatus(sceneError);
    publishHud();
    if (trackRefreshTimer != null) {
      windowRef.clearTimeout?.(trackRefreshTimer);
      trackRefreshTimer = null;
    }
    if (groundRefreshTimer != null) {
      windowRef.clearTimeout?.(groundRefreshTimer);
      groundRefreshTimer = null;
    }
  }

  function handleContextRestored() {
    sceneContextLost = false;
    sceneError = '';
    setStatus('');
    handleTabActivated();
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
    if (!isVisible()) return null;
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
          onUserPan: handleUserPan,
          onViewSettled: handleViewSettled,
          quality: sceneQuality(),
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
        if (active && isVisible()) {
          scene.start();
          applyFollowMode();
          renderTrack();
          renderAircraft();
          updateLighting({ force: true });
          scheduleGroundRefresh({ immediate: true });
          publishHud();
        }
        return scene;
      })
      .catch((error) => {
        if (disposed) return null;
        sceneError = `3D view unavailable: ${error?.message || error}`;
        consoleRef.warn?.('[LiveMap3D] Could not start the 3D view', error);
        setStatus(sceneError);
        return null;
      })
      .finally(() => {
        sceneLoading = null;
      });
    return sceneLoading;
  }

  function setActive(nextActive) {
    const wasActive = active;
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
    } else if (isVisible() && (!wasActive || !scene.isActive())) {
      scene.start();
      scene.resize();
      applyFollowMode();
      renderTrack();
      renderAircraft();
      updateLighting({ force: true });
      scheduleGroundRefresh({ immediate: true });
    }
    syncFollowUiState();
    publishHud();
    liveMapStore.setMapEmptyState({ visible: !lastPosition });
  }

  function handlePositionMessage(message) {
    const lat = Number(message?.lat);
    const lon = Number(message?.lon);
    if (!isValidCoord(lat, lon)) return;
    const heading = finiteOrNull(message?.true) ?? finiteOrNull(message?.hdg) ?? finiteOrNull(message?.mag);
    if (heading !== null) telemetry.headingDeg = heading;
    lastPosition = { lat, lon };
    track.append({
      lat,
      lon,
      altFt: telemetry.altFt,
      gsKts: telemetry.gsKts,
      vsFpm: telemetry.vsFpm,
      iasKts: telemetry.iasKts,
      receivedAtMs: now(),
    });
    if (!active) return;
    if (!scene) {
      ensureScene();
      return;
    }
    if (!canDraw()) return;
    renderAircraft();
    scheduleTrackRefresh();
    scheduleGroundRefresh();
    updateLighting();
    publishHud();
    liveMapStore.setMapEmptyState({ visible: false });
  }

  function handleSimTimeMessage(message) {
    const zuluMs = message?.valid === true && typeof message?.zuluIso === 'string'
      ? Date.parse(message.zuluIso)
      : NaN;
    if (!Number.isFinite(zuluMs)) {
      telemetry.simZuluMs = null;
      telemetry.simTimeReceivedAtMs = null;
    } else {
      const previousTimeMs = currentSimTimeMs();
      telemetry.simZuluMs = zuluMs;
      telemetry.simTimeReceivedAtMs = now();
      // The first clock, or a jump of more than a few minutes (the pilot
      // changed the simulator time), relights at once.
      if (canDraw()) {
        updateLighting({ force: previousTimeMs === null || Math.abs(previousTimeMs - zuluMs) > 180_000 });
        publishHud();
      }
    }
  }

  function handleHeadingMessage(message) {
    const heading = finiteOrNull(message?.true) ?? finiteOrNull(message?.hdg) ?? finiteOrNull(message?.mag);
    if (heading === null) return;
    telemetry.headingDeg = heading;
    if (canDraw()) renderAircraft();
  }

  function handleAltitudeMessage(message) {
    // The legacy `msl` field is cockpit-indicated altitude. Prefer geometric
    // altitude so pressure-setting changes cannot move the trail over terrain.
    const msl = finiteOrNull(message?.plane) ?? finiteOrNull(message?.msl) ?? finiteOrNull(message?.indicated);
    if (msl === null) return;
    telemetry.altFt = msl;
    telemetry.aglFt = finiteOrNull(message?.aircraftAgl) ?? finiteOrNull(message?.planeAgl);
    if (canDraw()) {
      renderAircraft();
      publishHud();
    }
  }

  function handleScalarMessage(message) {
    const value = finiteOrNull(message?.value);
    if (value === null) return;
    if (message.type === 'gs') telemetry.gsKts = value;
    else if (message.type === 'vs') telemetry.vsFpm = value;
    else if (message.type === 'ias') telemetry.iasKts = value;
    else return;
    if (canDraw()) publishHud();
  }

  function handleAttitudeMessage(message) {
    if (message?.valid === false) return;
    const pitch = finiteOrNull(message?.pitchDeg);
    const bank = finiteOrNull(message?.bankDeg);
    if (pitch !== null) telemetry.pitchDeg = pitch;
    if (bank !== null) telemetry.rollDeg = bank;
    if (canDraw()) renderAircraft();
  }

  function handleTabActivated() {
    if (!active || !isVisible() || sceneContextLost) return;
    if (!scene) {
      ensureScene();
      return;
    }
    scene.start();
    scene.resize();
    applyFollowMode();
    renderTrack();
    renderAircraft();
    updateLighting({ force: true });
    scheduleGroundRefresh({ immediate: true });
    publishHud();
  }

  // The tab is hidden: stop the render loop but keep the scene and the
  // trail so returning is instant.
  function suspend() {
    scene?.stop();
  }

  function handleWindowResize() {
    if (scene?.resize()) scene.requestRender();
  }

  function resumeFollowAndCenter() {
    autoFollow = true;
    if (!scene) {
      ensureScene();
    } else {
      applyFollowMode();
      scene.snapToFollowTarget();
    }
    syncFollowUiState();
  }

  function applyOptions() {
    if (!scene) return;
    // A new colour mode recolours every vertex and a new vertical scale
    // moves every vertex, so both rebuild the track from scratch. Terrain
    // changes the ground plane too, so the tiles are re-planned at once.
    renderedTrackVersion = -1;
    if (!canDraw()) return;
    renderTrack();
    updateLighting({ force: true });
    lastGroundRefreshAt = 0;
    scheduleGroundRefresh({ immediate: true });
    applyFollowMode();
    if (autoFollow) scene.snapToFollowTarget();
    publishHud();
  }

  function handleWsClose() {
    if (active) liveMapStore.setFollowStatus('no-data');
  }

  function handleWsOpen() {
    syncFollowUiState();
  }

  function cleanup() {
    disposed = true;
    active = false;
    sceneLoading = null;
    if (activationRetryTimer != null) {
      windowRef.clearInterval?.(activationRetryTimer);
      activationRetryTimer = null;
    }
    if (trackRefreshTimer != null) {
      windowRef.clearTimeout?.(trackRefreshTimer);
      trackRefreshTimer = null;
    }
    if (groundRefreshTimer != null) {
      windowRef.clearTimeout?.(groundRefreshTimer);
      groundRefreshTimer = null;
    }
    resizeObserver?.disconnect?.();
    resizeObserver = null;
    scene?.dispose();
    scene = null;
    sceneContextLost = false;
    terrainProvider?.dispose?.();
    terrainProvider = null;
  }

  return {
    applyOptions,
    cleanup,
    getLastPosition: () => lastPosition,
    getSceneError: () => sceneError,
    getTrackSize: () => track.size(),
    handleAltitudeMessage,
    handleAttitudeMessage,
    handleHeadingMessage,
    handlePositionMessage,
    handleScalarMessage,
    handleSimTimeMessage,
    handleTabActivated,
    handleWindowResize,
    handleWsClose,
    handleWsOpen,
    hasScene: () => Boolean(scene),
    isFollowing: () => autoFollow,
    renderRouteOverlays,
    restoreFollowMode,
    resumeFollowAndCenter,
    setActive,
    suspend,
    syncFollowUiState,
  };
}
