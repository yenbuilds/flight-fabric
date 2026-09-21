import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveMap3dController } from './map-3d-controller.js';
import {
  createFakeScene,
  createFakeThreeLoader,
  createFakeWindow,
  flushPromises,
} from '../maps/three-d/fake-scene.js';

function createStore() {
  const store = {
    followStatus: null,
    status: null,
    hud: null,
    legend: null,
    emptyState: null,
    setFollowStatus(kind) { store.followStatus = kind; },
    setScene3dStatus(message) { store.status = message; },
    setScene3dHud(hud) { store.hud = hud; },
    setScene3dLegend(legend) { store.legend = legend; },
    setMapEmptyState(state) { store.emptyState = state; },
    setMeta() {},
  };
  return store;
}

function createHarness({ visible = true, loaderFail = false, loadThree = null, tiles = true, options = {} } = {}) {
  const visibility = { visible };
  const windowRef = createFakeWindow();
  const store = createStore();
  const loader = createFakeThreeLoader({ fail: loaderFail });
  let scene = null;
  let clock = 1_000_000;
  const containerEl = { clientWidth: 800, clientHeight: 600, offsetParent: {} };
  let routeTargets = { getOriginAirport: () => null, getTargetAirport: () => null };
  const controller = createLiveMap3dController({
    containerEl,
    liveMapStore: store,
    windowRef,
    documentRef: windowRef.document,
    consoleRef: { warn() {} },
    isValidCoord: (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180,
    getRouteTargets: () => routeTargets,
    allowOnlineTiles: () => tiles,
    isVisible: () => visibility.visible,
    getOptions: () => ({ cameraMode: 'chase', colorMode: 'altitude', verticalScale: 2, showCurtain: true, ...options }),
    loadThree: loadThree || loader.loadThree,
    createScene: (sceneOptions) => {
      scene = createFakeScene(sceneOptions);
      return scene;
    },
    localStorageRef: null,
    now: () => clock,
  });
  return {
    controller,
    store,
    loader,
    windowRef,
    getScene: () => scene,
    advance(ms) { clock += ms; },
    setRouteTargets(next) { routeTargets = next; },
    setVisible(next) { visibility.visible = next; },
  };
}

function fly(harness, steps = 5, startIndex = 0) {
  for (let index = startIndex; index < startIndex + steps; index += 1) {
    harness.controller.handleAltitudeMessage({ msl: 1000 + (index * 500) });
    harness.controller.handleScalarMessage({ type: 'gs', value: 200 + index });
    harness.controller.handleScalarMessage({ type: 'vs', value: 1500 });
    harness.controller.handlePositionMessage({ lat: 51.47 + (index * 0.02), lon: -0.46, hdg: 10 });
    harness.advance(2000);
  }
}

test('telemetry is collected before the 3D view is ever shown, and drawn once it is', async () => {
  const harness = createHarness();
  fly(harness, 5);
  assert.equal(harness.controller.getTrackSize(), 5);
  assert.equal(harness.loader.getLoadCount(), 0, 'three.js is not loaded while the view is inactive');
  assert.equal(harness.getScene(), null);

  harness.controller.setActive(true);
  assert.equal(harness.store.status, 'Loading 3D view...');
  await flushPromises();
  const scene = harness.getScene();
  assert.ok(scene, 'the scene is created once the view is active');
  assert.equal(harness.store.status, '');
  assert.ok(scene.countCalls('start') >= 1);
  assert.ok(scene.state.track, 'the collected trail is drawn immediately');
  assert.equal(scene.state.track.pointCount, 5);
  assert.equal(scene.state.followMode, 'chase');
  assert.ok(scene.state.snapCount >= 1, 'the follow camera snaps behind the aircraft');
  assert.equal(scene.state.aircraft.visible, true);
  assert.equal(scene.state.aircraft.headingDeg, 10);
  assert.ok(scene.state.aircraft.y > 0, 'the aircraft is lifted by its altitude');
  assert.equal(harness.store.followStatus, 'following');
  assert.equal(harness.store.hud.altitudeFt, 3000);
  assert.equal(harness.store.hud.groundSpeedKts, 204);
  assert.equal(harness.store.hud.groundPlaneFt, 0, 'with terrain the ground plane is sea level');
  assert.equal(harness.store.hud.terrainActive, true);
  assert.match(scene.state.aircraft.label, /^3,000 ft$/, 'the aircraft carries its altitude until elevation tiles arrive');
  assert.equal(scene.state.aircraft.altitudeFt, 3000);
  assert.ok(scene.state.aircraft.altitudeUnitsPerFoot > 0);
  assert.equal(harness.store.hud.verticalScale, 2);
  assert.equal(harness.store.legend.mode, 'altitude');
  assert.equal(harness.store.legend.lower, 1000);
  assert.equal(harness.store.legend.upper, 3000);
  assert.deepEqual(harness.store.emptyState, { visible: false });

  harness.windowRef.runTimers();
  assert.ok(scene.state.tiles.length > 0, 'ground tiles are draped under the flight');
  assert.ok(scene.state.tiles.every((tile) => tile.url.startsWith('https://tile.openstreetmap.org/')));
  assert.ok(scene.state.terrain, 'tiles are displaced by the elevation provider');
  assert.equal(scene.state.terrain.floorMeters, 0);
  assert.ok(scene.state.terrain.unitsPerMeter > 1, 'mercator stretch times the vertical scale');

  // Once elevation is known under the aircraft, the label and HUD show height above terrain.
  scene.state.defaultGroundHeight = 1000 * scene.state.aircraft.altitudeUnitsPerFoot;
  scene.options.onTerrainUpdated();
  assert.equal(scene.state.aircraft.label, '3,000 ft · 2,000 AGL');
  assert.ok(Math.abs(harness.store.hud.terrainElevationFt - 1000) < 1e-6);
  assert.ok(Math.abs(harness.store.hud.aglFt - 2000) < 1e-6);

  // The simulator's own AGL wins over the tile estimate when it is reported.
  harness.controller.handleAltitudeMessage({ msl: 3000, aircraftAgl: 1850 });
  assert.equal(scene.state.aircraft.label, '3,000 ft · 1,850 AGL');
  assert.equal(harness.store.hud.aglFt, 1850);
});

test('pressure-setting changes do not move a trail with geometric altitude', async () => {
  const harness = createHarness();
  for (let index = 0; index < 5; index += 1) {
    harness.controller.handleAltitudeMessage({
      plane: 6000 + index * 100,
      msl: 6000 + index * 100 + (index >= 3 ? 1500 : 0),
      indicated: 6000 + index * 100 + (index >= 3 ? 1500 : 0),
      aircraftAgl: 5700 + index * 100,
    });
    harness.controller.handlePositionMessage({ lat: 53 - index * 0.002, lon: -2 });
    harness.advance(2000);
  }
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  const positions = scene.state.track.pathPositions;
  const scale = scene.state.aircraft.altitudeUnitsPerFoot;
  assert.equal(harness.store.hud.altitudeFt, 6400);
  assert.equal(harness.store.hud.aglFt, 6100);
  for (let index = 0; index < positions.length; index += 6) {
    assert.ok(Math.abs((positions[index + 4] - positions[index + 1]) / scale - 100) < 0.01,
      'each drawn span follows the 100-foot climb, including the barometer change');
  }
  assert.equal(harness.store.legend.upper, 6400);
  harness.controller.cleanup();
});

test('older altitude payloads fall back to indicated altitude without treating missing plane as zero', async () => {
  const harness = createHarness();
  harness.controller.handleAltitudeMessage({ plane: null, msl: 3000 });
  harness.controller.handlePositionMessage({ lat: 53, lon: -2 });
  harness.controller.setActive(true);
  await flushPromises();
  assert.equal(harness.store.hud.altitudeFt, 3000);
  harness.controller.handleAltitudeMessage({ plane: NaN, indicated: 3200 });
  assert.equal(harness.store.hud.altitudeFt, 3200);
  harness.controller.handleAltitudeMessage({ plane: 0, msl: 500 });
  assert.equal(harness.store.hud.altitudeFt, 0, 'a real zero geometric altitude remains valid');
  harness.controller.cleanup();
});

test('background telemetry collects without repainting, then restores the latest height and HUD', async () => {
  const harness = createHarness();
  fly(harness, 2);
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  const aircraftCalls = scene.countCalls('setAircraft');
  harness.setVisible(false);
  fly(harness, 3, 2);
  assert.equal(harness.controller.getTrackSize(), 5);
  assert.equal(scene.countCalls('setAircraft'), aircraftCalls);
  assert.equal(harness.store.hud.altitudeFt, 1500);
  harness.setVisible(true);
  harness.controller.handleTabActivated();
  assert.equal(scene.state.aircraft.altitudeFt, 3000);
  assert.equal(harness.store.hud.altitudeFt, 3000);
  assert.equal(harness.store.hud.groundSpeedKts, 204);
  assert.equal(scene.state.track.pointCount, 5);
  harness.controller.cleanup();
});

test('a scene that finishes loading after the map is hidden remains suspended until it becomes visible', async () => {
  const harness = createHarness();
  fly(harness, 2);
  harness.controller.setActive(true);
  harness.setVisible(false);
  harness.controller.suspend();
  await flushPromises();
  const scene = harness.getScene();
  assert.ok(scene, 'the loaded scene may be retained');
  assert.equal(scene.isActive(), false, 'late chunk completion must not start hidden rendering');
  harness.controller.handleTabActivated();
  assert.equal(scene.isActive(), false, 'activation callbacks cannot override hidden geometry');
  harness.setVisible(true);
  harness.controller.handleTabActivated();
  assert.equal(scene.isActive(), true);
  assert.equal(scene.state.track.pointCount, 2);
  harness.controller.cleanup();
});

test('context loss clears the live HUD and resumes the retained track with current telemetry and options', async () => {
  const options = { verticalScale: 2 };
  const harness = createHarness({ options });
  try {
    fly(harness, 2);
    harness.controller.setActive(true);
    await flushPromises();
    harness.windowRef.runTimers();
    const scene = harness.getScene();
    scene.options.onUserPan();
    scene.loseContext();
    assert.match(harness.store.status, /graphics.*interrupted/i);
    assert.match(harness.store.status, /2D/);
    assert.equal(harness.store.hud, null);
    const starts = scene.countCalls('start');
    const groundUpdates = scene.countCalls('setGroundTiles');
    const aircraftUpdates = scene.countCalls('setAircraft');

    fly(harness, 3, 2);
    options.verticalScale = 5;
    harness.controller.applyOptions();
    harness.controller.setActive(true);
    harness.controller.handleTabActivated();
    scene.options.onViewSettled();
    scene.options.onTerrainUpdated();
    harness.windowRef.runTimers();
    assert.equal(harness.controller.getTrackSize(), 5, 'telemetry continues collecting while graphics are unavailable');
    assert.equal(scene.countCalls('start'), starts);
    assert.equal(scene.countCalls('setAircraft'), aircraftUpdates);
    assert.equal(scene.countCalls('setGroundTiles'), groundUpdates, 'queued work and late terrain notifications cannot revive lost graphics');
    assert.equal(harness.store.hud, null);
    assert.match(harness.store.status, /graphics.*interrupted/i);

    scene.restoreContext();
    harness.windowRef.runTimers();
    assert.equal(scene.isActive(), true);
    assert.equal(harness.store.status, '');
    assert.equal(harness.store.hud.altitudeFt, 3000);
    assert.equal(harness.store.hud.verticalScale, 5);
    assert.equal(scene.state.track.pointCount, 5);
    assert.equal(scene.state.followMode, 'none', 'recovery preserves the user camera/follow choice');
    assert.ok(scene.countCalls('setGroundTiles') > groundUpdates);
  } finally { harness.controller.cleanup(); }
});

for (const awayMode of ['hidden', '2D']) {
  test(`restored live graphics remain suspended when the user has chosen ${awayMode}`, async () => {
    const harness = createHarness();
    try {
      fly(harness, 2);
      harness.controller.setActive(true);
      await flushPromises();
      const scene = harness.getScene();
      scene.loseContext();
      if (awayMode === 'hidden') { harness.setVisible(false); harness.controller.suspend(); }
      else harness.controller.setActive(false);
      const starts = scene.countCalls('start');
      const aircraftUpdates = scene.countCalls('setAircraft');
      scene.restoreContext();
      scene.options.onTerrainUpdated();
      assert.equal(scene.isActive(), false);
      assert.equal(scene.countCalls('start'), starts);
      assert.equal(scene.countCalls('setAircraft'), aircraftUpdates);
      assert.equal(harness.store.hud, null);
      harness.setVisible(true);
      harness.controller.setActive(true);
      assert.equal(scene.isActive(), true);
      assert.equal(harness.store.hud.altitudeFt, 1500);
    } finally { harness.controller.cleanup(); }
  });
}

test('with terrain off the lowest recorded altitude becomes the ground plane', async () => {
  const harness = createHarness({ options: { showTerrain: false } });
  fly(harness, 5);
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  harness.windowRef.runTimers();
  assert.equal(harness.store.hud.groundPlaneFt, 1000, 'the ground plane is the lowest altitude seen');
  assert.equal(harness.store.hud.terrainActive, false);
  assert.equal(scene.state.terrain, null, 'no elevation displacement is requested');
  assert.equal(scene.state.aircraft.label, '3,000 ft');
});

test('panning hands the camera to the user and Center resumes the follow', async () => {
  const harness = createHarness();
  fly(harness, 3);
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  assert.equal(harness.controller.isFollowing(), true);

  scene.options.onUserPan();
  assert.equal(harness.controller.isFollowing(), false);
  assert.equal(scene.state.followMode, 'none');
  assert.equal(harness.store.followStatus, 'paused');

  const snapsBefore = scene.state.snapCount;
  harness.controller.resumeFollowAndCenter();
  assert.equal(harness.controller.isFollowing(), true);
  assert.equal(scene.state.followMode, 'chase');
  assert.equal(scene.state.snapCount, snapsBefore + 1);
  assert.equal(harness.store.followStatus, 'following');
});

test('option changes rebuild the track with the new colour mode and vertical scale', async () => {
  const options = { colorMode: 'altitude', verticalScale: 1 };
  const harness = createHarness({ options });
  fly(harness, 4);
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  const heightBefore = scene.state.aircraft.y;
  const setTrackBefore = scene.countCalls('setTrack');

  options.colorMode = 'verticalSpeed';
  options.verticalScale = 5;
  harness.controller.applyOptions();
  assert.equal(scene.countCalls('setTrack'), setTrackBefore + 1);
  assert.equal(harness.store.legend.mode, 'verticalSpeed');
  assert.equal(harness.store.legend.kind, 'diverging');
  assert.ok(Math.abs(scene.state.aircraft.y - (heightBefore * 5)) < 1e-6, 'altitude is drawn five times taller');
  assert.equal(harness.store.hud.verticalScale, 5);
});

test('a failed three.js load reports the reason once and retries only when the view is selected again', async () => {
  const harness = createHarness({ loaderFail: true });
  fly(harness, 2);
  harness.controller.setActive(true);
  await flushPromises();
  assert.equal(harness.getScene(), null);
  assert.match(harness.store.status, /3D view unavailable: WebGL is unavailable/);
  assert.match(harness.controller.getSceneError(), /WebGL/);
  assert.equal(harness.loader.getLoadCount(), 1);

  fly(harness, 2, 2);
  harness.windowRef.runTimers();
  await flushPromises();
  assert.equal(harness.controller.getTrackSize(), 4, 'the trail keeps collecting');
  assert.equal(harness.loader.getLoadCount(), 1, 'telemetry and the watchdog do not hammer a failed start');

  harness.controller.setActive(false);
  harness.controller.setActive(true);
  await flushPromises();
  assert.equal(harness.loader.getLoadCount(), 2, 'selecting the view again is the retry');
});

test('leaving the tab suspends the render loop and returning restarts it', async () => {
  const harness = createHarness();
  fly(harness, 3);
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  assert.equal(scene.isActive(), true);
  const aircraftCalls = scene.countCalls('setAircraft');

  harness.controller.suspend();
  assert.equal(scene.isActive(), false);
  fly(harness, 2, 3);
  assert.equal(scene.countCalls('setAircraft'), aircraftCalls, 'a hidden scene is not redrawn per message');
  assert.equal(harness.controller.getTrackSize(), 5, 'the trail still collects while hidden');

  harness.controller.handleTabActivated();
  assert.equal(scene.isActive(), true);
  assert.ok(scene.countCalls('setAircraft') > aircraftCalls, 'returning redraws the aircraft at once');
});

test('disabling online tiles draws a grid instead of requesting any tile', async () => {
  const harness = createHarness({ tiles: false });
  fly(harness, 3);
  harness.controller.setActive(true);
  await flushPromises();
  harness.windowRef.runTimers();
  const scene = harness.getScene();
  assert.deepEqual(scene.state.tiles, []);
  assert.ok(scene.state.grid, 'a fallback grid is placed under the aircraft');
});

test('route targets become pins, a planned route and a descending target line', async () => {
  const harness = createHarness();
  harness.setRouteTargets({
    getOriginAirport: () => ({ icao: 'EGLL', lat: 51.47, lon: -0.46 }),
    getTargetAirport: () => ({ icao: 'EHAM', lat: 52.31, lon: 4.76 }),
  });
  fly(harness, 3);
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  assert.equal(scene.state.pins.length, 2);
  assert.deepEqual(scene.state.pins.map((pin) => pin.id), ['FROM EGLL', 'EHAM']);
  assert.ok(scene.state.routeLine instanceof Float32Array && scene.state.routeLine.length >= 12);
  assert.ok(scene.state.targetLine instanceof Float32Array && scene.state.targetLine.length >= 12);
  assert.ok(scene.state.targetLine[1] > 0, 'the target line starts at the aircraft altitude');
  assert.equal(scene.state.targetLine[scene.state.targetLine.length - 2], 0, 'and ends on the ground at the destination');

  const pinsBefore = scene.countCalls('setPins');
  harness.controller.renderRouteOverlays();
  assert.equal(scene.countCalls('setPins'), pinsBefore, 'unchanged airports do not rebuild the pins');

  harness.setRouteTargets({ getOriginAirport: () => null, getTargetAirport: () => null });
  harness.controller.renderRouteOverlays();
  assert.deepEqual(scene.state.pins, []);
  assert.equal(scene.state.routeLine, null);
  assert.equal(scene.state.targetLine, null);
});

test('a hidden surface is retried until it becomes visible, then the scene starts', async () => {
  const harness = createHarness({ visible: false });
  fly(harness, 2);
  harness.controller.setActive(true);
  await flushPromises();
  assert.equal(harness.getScene(), null, 'nothing starts while the surface is hidden');
  assert.equal(harness.loader.getLoadCount(), 0);
  harness.windowRef.runTimers();
  await flushPromises();
  assert.equal(harness.getScene(), null, 'still hidden, still waiting');

  harness.setVisible(true);
  harness.windowRef.runTimers();
  await flushPromises();
  assert.ok(harness.getScene(), 'the watchdog starts the scene once the surface is visible');
  assert.ok(harness.windowRef.timers.some((timer) => timer.interval && timer.cleared), 'the watchdog stops itself');
});

test('lighting follows the simulator clock, falls back to the real clock, and can be pinned to daylight', async () => {
  const options = {};
  const harness = createHarness({ options });
  // Innsbruck at 22:00 UTC in September: the sun is well below the horizon.
  for (let index = 0; index < 3; index += 1) {
    harness.controller.handleAltitudeMessage({ msl: 6000 });
    harness.controller.handlePositionMessage({ lat: 47.26 + (index * 0.02), lon: 11.34, hdg: 80 });
    harness.advance(2000);
  }
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  assert.equal(harness.store.hud.lighting.source, 'clock', 'without a simulator clock the real clock is used and said so');

  harness.controller.handleSimTimeMessage({ zuluIso: '2026-09-19T22:00:00Z', localIso: '2026-09-20T00:00:00', timeOfDay: 4, valid: true });
  assert.equal(scene.state.lighting.phase, 'night');
  assert.ok(scene.state.lighting.moonIntensity > 0.3, 'night keeps a moonlight so terrain stays visible');
  assert.equal(scene.state.lighting.sunIntensity, 0);
  assert.ok(scene.state.lightingSun.sunElevationDeg < -20, `sun elevation ${scene.state.lightingSun.sunElevationDeg}`);
  assert.equal(harness.store.hud.lighting.source, 'sim');
  assert.equal(harness.store.hud.lighting.timeText, '22:00Z');
  assert.equal(harness.store.hud.lighting.phase, 'night');

  // The clock is extrapolated between broadcasts: twelve hours later it is day.
  harness.advance(12 * 3_600_000);
  harness.controller.handlePositionMessage({ lat: 47.32, lon: 11.34, hdg: 80 });
  assert.equal(scene.state.lighting.phase, 'day');
  assert.equal(harness.store.hud.lighting.timeText, '10:00Z');

  options.lighting = 'day';
  harness.controller.applyOptions();
  assert.equal(harness.store.hud.lighting.source, 'day');
  assert.equal(scene.state.lighting.phase, 'day');
  harness.controller.handleSimTimeMessage({ zuluIso: 'garbage', valid: false });
  assert.equal(harness.store.hud.lighting.source, 'day', 'an invalid clock does not disturb pinned daylight');
});

test('a phone-sized or touch window gets the compact scene quality', async () => {
  const wide = createHarness();
  wide.windowRef.innerWidth = 1440;
  fly(wide, 2);
  wide.controller.setActive(true);
  await flushPromises();
  assert.equal(wide.getScene().options.quality, 'high');

  const narrow = createHarness();
  narrow.windowRef.innerWidth = 420;
  fly(narrow, 2);
  narrow.controller.setActive(true);
  await flushPromises();
  assert.equal(narrow.getScene().options.quality, 'compact');

  const touch = createHarness();
  touch.windowRef.innerWidth = 1200;
  touch.windowRef.matchMedia = (query) => ({ matches: query === '(pointer: coarse)' });
  fly(touch, 2);
  touch.controller.setActive(true);
  await flushPromises();
  assert.equal(touch.getScene().options.quality, 'compact');
});

test('deactivating stops rendering and cleanup disposes the scene', async () => {
  const harness = createHarness();
  fly(harness, 2);
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  harness.controller.setActive(false);
  assert.equal(scene.isActive(), false);
  harness.controller.cleanup();
  assert.equal(scene.isDisposed(), true);
  assert.equal(harness.controller.hasScene(), false);
});

test('a failed lazy load after live-map cleanup cannot overwrite a replacement status', async () => {
  let rejectLoad;
  const harness = createHarness({ loadThree: () => new Promise((resolve, reject) => { rejectLoad = reject; }) });
  harness.controller.setActive(true);
  harness.controller.cleanup();
  harness.store.setScene3dStatus('Replacement view ready');
  rejectLoad(new Error('late chunk failure'));
  await flushPromises();
  assert.equal(harness.store.status, 'Replacement view ready');
  assert.equal(harness.controller.getSceneError(), '');
  assert.equal(harness.getScene(), null);
});

test('retiring old fragmented trails preserves the flat ground altitude reference', async () => {
  const harness = createHarness({ tiles: false });
  try {
    harness.controller.handleAltitudeMessage({ plane: 80 });
    harness.controller.handlePositionMessage({ lat: 1, lon: 1 });
    harness.advance(2000);
    harness.controller.handlePositionMessage({ lat: 1.001, lon: 1 });
    harness.controller.setActive(true);
    await flushPromises();
    assert.equal(harness.store.hud.groundPlaneFt, 50);
    harness.controller.setActive(false);
    for (let leg = 1; leg <= 6500; leg += 1) {
      harness.controller.handleAltitudeMessage({ plane: 10000 });
      harness.advance(2000);
      harness.controller.handlePositionMessage({ lat: leg % 2 ? 30 : 1, lon: 1 });
      harness.advance(2000);
      harness.controller.handlePositionMessage({ lat: (leg % 2 ? 30 : 1) + 0.001, lon: 1 });
    }
    harness.controller.setActive(true);
    assert.ok(harness.controller.getTrackSize() <= 12000);
    assert.equal(harness.store.hud.groundPlaneFt, 50, 'retiring the takeoff segment must not raise the ground plane');
  } finally { harness.controller.cleanup(); }
});

test('a simulator clock jump relights immediately within the regular refresh interval', async () => {
  const harness = createHarness();
  try {
    harness.controller.handleAltitudeMessage({ plane: 6000 });
    harness.controller.handlePositionMessage({ lat: 47.26, lon: 11.34 });
    harness.controller.setActive(true);
    await flushPromises();
    harness.controller.handleSimTimeMessage({ valid: true, zuluIso: '2026-09-19T22:00:00Z' });
    assert.equal(harness.store.hud.lighting.phase, 'night');
    harness.advance(1000);
    harness.controller.handleSimTimeMessage({ valid: true, zuluIso: '2026-09-20T10:00:00Z' });
    assert.equal(harness.store.hud.lighting.phase, 'day');
    assert.equal(harness.store.hud.lighting.timeText, '10:00Z');
  } finally { harness.controller.cleanup(); }
});
