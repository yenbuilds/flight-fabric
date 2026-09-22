import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
import { useTimelineStore } from '../vue/stores/timeline.js';
import { initTimelinePage } from './bootstrap.js';
import { createTimelineMap3dController } from './map-3d-controller.js';
import { createTimelineMapViewSwitch } from './map-view-switch.js';
import { getEventPosition } from './map.js';
import {
  createFakeScene,
  createFakeThreeLoader,
  createFakeWindow,
  flushPromises,
} from '../maps/three-d/fake-scene.js';

const START_MS = Date.UTC(2026, 8, 19, 12, 0, 0);

function isValidCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    && !(Math.abs(lat) <= 1e-6 && Math.abs(lon) <= 1e-6);
}

function buildTimeline() {
  return {
    flightId: 'flight-1',
    generatedAt: '2026-09-19T12:30:00Z',
    durationMs: 5_400_000,
    track: [
      { lat: 39.8744, lon: -75.2424, timestampMs: START_MS, hdgTrueDeg: 42, iasKts: 0, altFt: 36 },
      { lat: 40.3501, lon: -74.5002, timestampMs: START_MS + 1_800_000, hdgTrueDeg: 43, iasKts: 289, altFt: 28000 },
      { lat: 41.3308, lon: -72.8363, timestampMs: START_MS + 4_200_000, hdgTrueDeg: 47, iasKts: 232, altFt: 9800 },
      { lat: 42.3656, lon: -71.0096, timestampMs: START_MS + 5_400_000, hdgTrueDeg: 44, iasKts: 134, altFt: 18 },
    ],
    events: [
      { type: 'violation_start', timestampMs: START_MS + 1_800_000, lat: 40.3501, lon: -74.5002 },
      { type: 'landing', timestampMs: START_MS + 5_400_000, lat: 42.3656, lon: -71.0096 },
      { type: 'phase_start', timestampMs: START_MS + 60_000, lat: 39.9, lon: -75.2 },
    ],
  };
}

function createStore() {
  const store = {
    emptyState: null,
    status: null,
    legend: null,
    setMapEmptyState(state) { store.emptyState = { ...(store.emptyState || {}), ...state }; },
    setScene3dStatus(message) { store.status = message; },
    setScene3dLegend(legend) { store.legend = legend; },
  };
  return store;
}

function createHarness({ visible = true, loaderFail = false, loadThree = null, filters = { violations: true, landing: true }, allowOnlineTiles = () => true } = {}) {
  const windowRef = createFakeWindow();
  const store = createStore();
  const loader = createFakeThreeLoader({ fail: loaderFail });
  const orientation = [];
  const jumps = [];
  const scrubberSync = [];
  let scene = null;
  const options = { cameraMode: 'chase', colorMode: 'altitude', verticalScale: 2, showCurtain: true };
  const controller = createTimelineMap3dController({
    containerEl: { clientWidth: 800, clientHeight: 600, offsetParent: {} },
    timelineStore: store,
    windowRef,
    documentRef: windowRef.document,
    consoleRef: { warn() {} },
    isTimelineTabVisible: () => visible,
    isValidCoord,
    eventPassesMapFilter: (event) => {
      const type = String(event?.type || '');
      if (type.startsWith('violation')) return filters.violations === true;
      if (type === 'landing') return filters.landing === true;
      return false;
    },
    getEventPosition: (event) => getEventPosition(event, isValidCoord),
    jumpToTimelineEvent: (event, index, opts) => jumps.push({ event, index, opts }),
    updateOrientationWidget: (...args) => orientation.push(args),
    syncScrubberToTimestamp: (ts) => scrubberSync.push(ts),
    updateProfileCursor: () => {},
    getTimelineScrubberStartMs: () => START_MS,
    allowOnlineTiles,
    getOptions: () => options,
    loadThree: loadThree || loader.loadThree,
    createScene: (sceneOptions) => {
      scene = createFakeScene(sceneOptions);
      return scene;
    },
  });
  return { controller, store, loader, windowRef, options, orientation, jumps, scrubberSync, getScene: () => scene, setVisible(next) { visible = next; } };
}

test('an inactive 3D replay still normalizes the track for the scrubber without loading three.js', () => {
  const harness = createHarness();
  const points = harness.controller.render(buildTimeline());
  assert.equal(points.length, 4);
  assert.equal(points[1].altFt, 28000);
  assert.equal(harness.loader.getLoadCount(), 0);
  assert.equal(harness.getScene(), null);
});

test('a failed lazy load after replay destruction cannot overwrite a replacement status', async () => {
  let rejectLoad;
  const harness = createHarness({ loadThree: () => new Promise((resolve, reject) => { rejectLoad = reject; }) });
  harness.controller.setActive(true);
  harness.controller.destroy();
  harness.store.setScene3dStatus('Replacement view ready');
  rejectLoad(new Error('late chunk failure'));
  await flushPromises();
  assert.equal(harness.store.status, 'Replacement view ready');
  assert.equal(harness.controller.getSceneError(), '');
  assert.equal(harness.getScene(), null);
});

test('a late recording response and cursor updates keep a hidden replay suspended', async () => {
  const harness = createHarness();
  try {
    harness.controller.setActive(true);
    await flushPromises();
    harness.controller.render(buildTimeline());
    const scene = harness.getScene();
    harness.setVisible(false);
    harness.controller.suspend();
    const starts = scene.countCalls('start');
    const tracks = scene.countCalls('setTrack');
    const aircraft = scene.countCalls('setAircraft');
    const timeline = { ...buildTimeline(), flightId: 'late-recording' };
    assert.equal(harness.controller.render(timeline).length, 4, 'hidden responses still prepare scrubber data');
    harness.controller.setCursorPosition({ lat: 41.33, lon: -72.84 }, { altFt: 9800 }, false);
    harness.controller.applyOptions();
    assert.equal(scene.isActive(), false);
    assert.equal(scene.countCalls('start'), starts);
    assert.equal(scene.countCalls('setTrack'), tracks);
    assert.equal(scene.countCalls('setAircraft'), aircraft);
    harness.setVisible(true);
    harness.controller.setActive(true);
    assert.equal(scene.isActive(), true);
    assert.equal(scene.countCalls('setTrack'), tracks + 1);
    assert.equal(scene.state.aircraft.altitudeFt, 9800);
  } finally { harness.controller.destroy(); }
});

test('a resize after closing a compact replay stops its retained scene', async () => {
  const harness = createHarness();
  try {
    harness.controller.setActive(true);
    await flushPromises();
    harness.controller.render(buildTimeline());
    harness.setVisible(false);
    harness.controller.invalidateSizeStaggered();
    assert.equal(harness.getScene().isActive(), false);
    harness.setVisible(true);
    harness.controller.invalidateSizeStaggered();
    assert.equal(harness.getScene().isActive(), true);
  } finally { harness.controller.destroy(); }
});

test('replay bootstrap suspends a closed compact viewer and background document, then removes visibility listeners', async () => {
  setActivePinia(createPinia());
  const timelineStore = useTimelineStore();
  timelineStore.setMapViewMode('3d');
  timelineStore.openTimelineMobileViewer();
  const tabsStore = reactive({ activeTabId: 'timeline' });
  const windowRef = createFakeWindow();
  const windowListeners = new Map();
  const documentListeners = new Map();
  windowRef.addEventListener = (name, callback) => windowListeners.set(name, callback);
  windowRef.removeEventListener = name => windowListeners.delete(name);
  const documentRef = windowRef.document;
  documentRef.getElementById = () => null;
  documentRef.addEventListener = (name, callback) => documentListeners.set(name, callback);
  documentRef.removeEventListener = name => documentListeners.delete(name);
  const mapEl = { offsetParent: {}, clientWidth: 600, clientHeight: 400 };
  let scene;
  const cleanup = initTimelinePage({
    timelineStore, tabsStore, windowRef, documentRef,
    getElementById: id => id === 'timeline-map-3d' ? mapEl : null,
    create3dController: options => createTimelineMap3dController({
      ...options,
      loadThree: async () => ({}),
      createScene: options => (scene = createFakeScene(options)),
    }),
  });
  try {
    await flushPromises();
    assert.equal(scene.isActive(), true);
    timelineStore.closeTimelineMobileViewer();
    mapEl.offsetParent = null;
    mapEl.clientWidth = 0;
    mapEl.clientHeight = 0;
    await nextTick();
    assert.equal(scene.isActive(), false, 'closing review suspends without changing tabs or waiting for resize');
    timelineStore.openTimelineMobileViewer();
    mapEl.offsetParent = {};
    mapEl.clientWidth = 600;
    mapEl.clientHeight = 400;
    await nextTick();
    assert.equal(scene.isActive(), true);
    documentRef.visibilityState = 'hidden';
    documentListeners.get('visibilitychange')();
    assert.equal(scene.isActive(), false);
    windowListeners.get('resize')();
    assert.equal(scene.isActive(), false, 'background resize does not restart rendering');
    documentRef.visibilityState = 'visible';
    documentListeners.get('visibilitychange')();
    assert.equal(scene.isActive(), true);
  } finally { cleanup(); }
  assert.equal(documentListeners.has('visibilitychange'), false);
  assert.equal(scene.isDisposed(), true);
});

test('resuming an unchanged replay refreshes terrain ownership and the latest online setting', async () => {
  let online = true;
  const harness = createHarness({ allowOnlineTiles: () => online });
  try {
    harness.controller.setActive(true);
    await flushPromises();
    harness.controller.render(buildTimeline());
    const scene = harness.getScene();
    const before = scene.countCalls('setGroundTiles');
    harness.controller.suspend();
    harness.controller.setActive(true);
    assert.ok(scene.countCalls('setGroundTiles') > before, 'unchanged track still renews its viewport');
    harness.controller.suspend();
    online = false;
    harness.controller.setActive(true);
    assert.equal(scene.state.tiles.length, 0, 'online maps disabled while hidden stay disabled on resume');
  } finally { harness.controller.destroy(); }
});

test('replay context recovery retains the recording and restores the latest cursor without reframing', async () => {
  const harness = createHarness();
  try {
    harness.controller.setActive(true);
    await flushPromises();
    harness.controller.render(buildTimeline());
    harness.controller.setCursorPosition({ lat: 40.35, lon: -74.5 }, { altFt: 28000 }, false);
    const scene = harness.getScene();
    const track = scene.state.track;
    const fits = scene.countCalls('fitToBounds');
    scene.loseContext();
    assert.match(harness.store.status, /graphics.*interrupted/i);
    assert.match(harness.store.status, /2D/);
    const starts = scene.countCalls('start');
    const groundUpdates = scene.countCalls('setGroundTiles');
    const aircraftUpdates = scene.countCalls('setAircraft');
    assert.equal(harness.controller.render(buildTimeline()).length, 4, 'the scrubber retains normalized track data');
    harness.controller.setCursorPosition({ lat: 41.33, lon: -72.84 }, { headingDeg: 47, altFt: 9800 }, false);
    harness.controller.setActive(true);
    harness.controller.invalidateSizeStaggered();
    harness.controller.applyOptions();
    scene.options.onViewSettled();
    scene.options.onTerrainUpdated();
    assert.equal(scene.countCalls('start'), starts);
    assert.equal(scene.countCalls('setGroundTiles'), groundUpdates);
    assert.equal(scene.countCalls('setAircraft'), aircraftUpdates);
    assert.match(harness.store.status, /graphics.*interrupted/i);

    scene.restoreContext();
    assert.equal(scene.isActive(), true);
    assert.equal(harness.store.status, '');
    assert.equal(scene.state.track, track, 'unchanged recording geometry is retained');
    assert.equal(scene.countCalls('fitToBounds'), fits, 'restoration does not steal the camera');
    assert.equal(scene.state.aircraft.altitudeFt, 9800);
    assert.equal(scene.state.aircraft.headingDeg, 47);
    assert.ok(scene.countCalls('setGroundTiles') > groundUpdates);
  } finally { harness.controller.destroy(); }
});

for (const awayMode of ['hidden', '2D']) {
  test(`restored replay graphics remain suspended when the user has chosen ${awayMode}`, async () => {
    const harness = createHarness();
    try {
      harness.controller.setActive(true);
      await flushPromises();
      harness.controller.render(buildTimeline());
      const scene = harness.getScene();
      scene.loseContext();
      if (awayMode === 'hidden') { harness.setVisible(false); harness.controller.suspend(); }
      else harness.controller.setActive(false);
      const starts = scene.countCalls('start');
      const groundUpdates = scene.countCalls('setGroundTiles');
      const emptyState = harness.store.emptyState;
      scene.restoreContext();
      scene.options.onTerrainUpdated();
      scene.options.onViewSettled();
      harness.controller.invalidateSizeStaggered();
      assert.equal(scene.isActive(), false);
      assert.equal(scene.countCalls('start'), starts);
      assert.equal(scene.countCalls('setGroundTiles'), groundUpdates);
      assert.equal(harness.store.emptyState, emptyState, 'restoration must not change the 2D empty state');
      harness.setVisible(true);
      harness.controller.setActive(true);
      assert.equal(scene.isActive(), true);
      assert.equal(scene.state.track.pointCount, 4);
    } finally { harness.controller.destroy(); }
  });
}

test('an active 3D replay draws the track, lifts markers to their altitude and frames the flight', async () => {
  const harness = createHarness();
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  assert.ok(scene);
  harness.controller.render(buildTimeline());

  assert.equal(scene.state.track.pointCount, 4);
  assert.equal(scene.state.markers.length, 2, 'only the filtered categories become markers');
  const violation = scene.state.markers.find((marker) => marker.id === 0);
  const landing = scene.state.markers.find((marker) => marker.id === 1);
  assert.ok(violation.y > landing.y, 'the cruise violation sits far above the landing');
  assert.ok(violation.badge?.canvas === undefined || violation.badge, 'a badge is attached');
  assert.ok(scene.state.fitBounds, 'the camera frames the flight once');
  assert.equal(harness.store.legend.mode, 'altitude');
  assert.equal(harness.store.legend.groundPlaneFt, 0, 'with terrain the ground plane is sea level');
  assert.equal(harness.store.legend.terrainActive, true);
  assert.ok(scene.state.terrain, 'tiles are displaced by the elevation provider');
  assert.equal(harness.store.legend.verticalScale, 2);
  assert.equal(harness.store.emptyState.visible, false);
  assert.ok(scene.state.tiles.length > 0, 'tiles are draped under the replay');

  const fitCount = scene.countCalls('fitToBounds');
  harness.controller.render(buildTimeline());
  assert.equal(scene.countCalls('fitToBounds'), fitCount, 're-rendering the same timeline keeps the camera where the user left it');
  harness.controller.fitView();
  assert.equal(scene.countCalls('fitToBounds'), fitCount + 1, 'Fit flight reframes on request');
});

test('the scrubber cursor drives the aircraft and the PFD, and clicking a marker jumps to its event', async () => {
  const harness = createHarness();
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  harness.controller.render(buildTimeline());

  harness.controller.setCursorPosition({ lat: 40.35, lon: -74.5 }, { headingDeg: 43, pitchDeg: 2, rollDeg: -5, iasKts: 289, altFt: 28000 }, false);
  assert.equal(scene.state.aircraft.visible, true);
  assert.equal(scene.state.aircraft.headingDeg, 43);
  assert.equal(scene.state.aircraft.rollDeg, -5);
  assert.ok(scene.state.aircraft.y > 0);
  assert.deepEqual(harness.orientation.at(-1), [43, 2, -5, 289, 28000]);
  assert.equal(scene.state.target, null, 'scrubbing does not move the camera');

  harness.controller.setCursorPosition({ lat: 41.33, lon: -72.84 }, { headingDeg: 47, altFt: 9800 }, true);
  assert.equal(scene.state.followMode, 'chase', 'an explicit pan engages the chosen follow camera');
  assert.equal(scene.state.snapCount, 1, 'the camera snaps to the aircraft once, then tracks it');
  assert.equal(scene.state.aircraft.label, '9,800 ft', 'no terrain height yet');

  scene.state.defaultGroundHeight = 800 * scene.state.aircraft.altitudeUnitsPerFoot;
  scene.options.onTerrainUpdated();
  assert.equal(scene.state.aircraft.label, '9,800 ft · 9,000 AGL');
  assert.ok(Math.abs(harness.store.legend.terrainElevationFt - 800) < 1e-6);
  assert.ok(Math.abs(harness.store.legend.aboveTerrainFt - 9000) < 1e-6);

  scene.options.onMarkerClick(1);
  assert.equal(harness.jumps.length, 1);
  assert.equal(harness.jumps[0].index, 1);
  assert.equal(harness.jumps[0].event.type, 'landing');

  harness.controller.focusEvent(buildTimeline().events[0]);
  assert.equal(harness.scrubberSync.at(-1), START_MS + 1_800_000);
  assert.equal(scene.state.aircraft.headingDeg, 43, 'focus uses the nearest track point attitude');
});

test('replay lighting follows the simulator clock across the recording and labels its source', async () => {
  const harness = createHarness();
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  const timeline = { ...buildTimeline(), simDateTimeUtc: '2026-06-21T12:00:00Z' };
  harness.controller.render(timeline);
  // Philadelphia at 12:00Z on the June solstice: mid-morning sun.
  assert.equal(scene.state.lighting.phase, 'day');
  assert.equal(harness.store.legend.lighting.source, 'sim');
  assert.equal(harness.store.legend.lighting.timeText, '12:00Z');

  // Scrub to twelve and a half hours after takeoff: 00:30Z, sunset in Boston.
  harness.controller.setCursorPosition(
    { lat: 42.36, lon: -71.0, timestampMs: START_MS + (12.5 * 3_600_000) },
    { headingDeg: 44, altFt: 3000 },
    false,
  );
  assert.equal(harness.store.legend.lighting.timeText, '00:30Z');
  assert.ok(['dusk', 'golden'].includes(scene.state.lighting.phase), `sunset phase ${scene.state.lighting.phase}`);

  harness.controller.setCursorPosition(
    { lat: 42.36, lon: -71.0, timestampMs: START_MS + (16 * 3_600_000) },
    { headingDeg: 44, altFt: 3000 },
    false,
  );
  assert.equal(scene.state.lighting.phase, 'night');
  assert.ok(scene.state.lighting.moonIntensity > 0.3);

  harness.controller.render(buildTimeline());
  harness.controller.setCursorPosition({ lat: 40.35, lon: -74.5, timestampMs: START_MS }, { altFt: 28000 }, false);
  assert.equal(harness.store.legend.lighting.source, 'recording', 'without a simulator clock the recording clock is used and said so');
  harness.controller.setCursorPosition({ lat: 40.35, lon: -74.5 }, { altFt: 28000 }, false);
  assert.equal(harness.store.legend.lighting.source, 'none', 'a cursor without a moment does not invent a clock');
  assert.equal(scene.state.lighting.phase, 'day');

  harness.options.lighting = 'day';
  harness.controller.applyOptions();
  assert.equal(harness.store.legend.lighting.source, 'day');
  assert.equal(scene.state.lighting.phase, 'day');
});

test('a WebGL failure shows the reason in the replay empty state and is not retried per render', async () => {
  const harness = createHarness({ loaderFail: true });
  harness.controller.setActive(true);
  await flushPromises();
  assert.match(harness.store.status, /3D view unavailable/);
  harness.controller.render(buildTimeline());
  assert.equal(harness.store.emptyState.visible, true);
  assert.match(harness.store.emptyState.message, /3D view unavailable/);
  harness.controller.render(buildTimeline());
  harness.windowRef.runTimers();
  await flushPromises();
  assert.equal(harness.loader.getLoadCount(), 1, 'renders and the watchdog do not retry a failed start');
  harness.controller.setActive(false);
  harness.controller.setActive(true);
  await flushPromises();
  assert.equal(harness.loader.getLoadCount(), 2, 'selecting the view again retries');
});

test('a suspended replay restarts when it is rendered or resized again', async () => {
  const harness = createHarness();
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  harness.controller.render(buildTimeline());
  harness.controller.suspend();
  assert.equal(scene.isActive(), false);
  harness.controller.invalidateSizeStaggered();
  assert.equal(scene.isActive(), true, 'a resize on the active view restarts the loop');
  harness.controller.suspend();
  harness.controller.render(buildTimeline());
  assert.equal(scene.isActive(), true, 'a render on the active view restarts the loop');
});

test('the view switch replays the timeline and cursor onto the view the user switches to', () => {
  const calls = { '2d': [], '3d': [] };
  const cursors = { '2d': [], '3d': [] };
  const makeController = (key) => ({
    render(timeline) { calls[key].push(['render', timeline?.flightId]); return timeline?.track || []; },
    setCursorPosition(pos, attitude, shouldPan) { calls[key].push(['cursor', pos?.lat, shouldPan]); cursors[key].push(pos); },
    focusEvent(event) { calls[key].push(['focus', event?.type]); },
    reset() { calls[key].push(['reset']); },
    destroy() { calls[key].push(['destroy']); },
    invalidateSizeStaggered() { calls[key].push(['invalidate']); },
    hasMap: () => true,
    setActive(active) { calls[key].push(['active', active]); },
  });
  let mode = '2d';
  const controllers = { '2d': makeController('2d'), '3d': makeController('3d') };
  delete controllers['2d'].setActive;
  const facade = createTimelineMapViewSwitch({ controllers, getMode: () => mode });

  facade.applyMode();
  assert.deepEqual(calls['3d'], [['active', false]]);
  facade.render(buildTimeline());
  facade.setCursorPosition({ lat: 40.35, lon: -74.5, timestampMs: START_MS + 5 }, { altFt: 28000 }, false);
  assert.deepEqual(calls['2d'].map((call) => call[0]), ['invalidate', 'render', 'cursor']);
  assert.equal(calls['3d'].length, 1, 'the hidden view receives nothing');

  mode = '3d';
  facade.applyMode('3d');
  assert.deepEqual(calls['3d'].slice(1), [['active', true], ['render', 'flight-1'], ['cursor', 40.35, false]]);
  assert.equal(cursors['3d'].at(-1)?.timestampMs, START_MS + 5, 'the replayed cursor keeps its moment for lighting');
  facade.focusEvent({ type: 'landing' });
  assert.deepEqual(calls['3d'].at(-1), ['focus', 'landing']);
  assert.equal(calls['2d'].filter((call) => call[0] === 'focus').length, 0);

  mode = '2d';
  facade.applyMode('2d');
  assert.deepEqual(calls['3d'].at(-1), ['active', false]);
  assert.deepEqual(calls['2d'].slice(-3), [['invalidate'], ['render', 'flight-1'], ['cursor', 40.35, false]]);

  // A re-render of the same recording (filters, tab return) keeps the cursor
  // for the next switch; a different recording drops it.
  facade.render(buildTimeline());
  mode = '3d';
  facade.applyMode('3d');
  assert.deepEqual(calls['3d'].slice(-2), [['render', 'flight-1'], ['cursor', 40.35, false]]);
  mode = '2d';
  facade.applyMode('2d');
  facade.render({ ...buildTimeline(), flightId: 'flight-2' });
  mode = '3d';
  facade.applyMode('3d');
  assert.deepEqual(calls['3d'].slice(-2), [['active', true], ['render', 'flight-2']], 'no stale cursor on a new recording');

  facade.reset();
  facade.destroy();
  assert.deepEqual(calls['2d'].slice(-2), [['reset'], ['destroy']]);
  assert.deepEqual(calls['3d'].slice(-2), [['reset'], ['destroy']]);
});

test('the replay follows the aircraft after the first scrub, pauses when the user drags and resumes from Center', async () => {
  const harness = createHarness();
  const followStatuses = [];
  harness.store.setMapFollowStatus = (kind) => followStatuses.push(kind);
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  harness.controller.render(buildTimeline());
  assert.equal(scene.state.followMode, 'none', 'the framed flight is an overview: follow waits for the first scrub');
  assert.equal(followStatuses.at(-1), 'following');

  harness.controller.setCursorPosition({ lat: 40.35, lon: -74.5 }, { headingDeg: 43, altFt: 28000 }, true);
  assert.equal(scene.state.followMode, 'chase');
  assert.equal(scene.state.snapCount, 1);

  scene.options.onUserPan();
  assert.equal(scene.state.followMode, 'none', 'dragging the camera pauses the follow');
  assert.equal(followStatuses.at(-1), 'paused');
  harness.controller.setCursorPosition({ lat: 41.33, lon: -72.84 }, { headingDeg: 47, altFt: 9800 }, true);
  assert.equal(scene.state.followMode, 'none', 'scrubbing while paused moves the aircraft but not the camera');
  assert.equal(scene.state.snapCount, 1);

  harness.controller.resumeFollowAndCenter();
  assert.equal(followStatuses.at(-1), 'following');
  assert.equal(scene.state.followMode, 'chase');
  assert.equal(scene.state.snapCount, 2, 'Center snaps back to the aircraft');

  harness.options.cameraMode = 'orbit';
  harness.controller.applyOptions();
  assert.equal(scene.state.followMode, 'orbit', 'a new camera mode applies while following');

  harness.controller.fitView();
  assert.equal(scene.state.followMode, 'none', 'Fit flight shows the overview again');
  assert.equal(followStatuses.at(-1), 'following', 'fitting is not a pause');
  scene.options.onUserPan();
  assert.equal(followStatuses.at(-1), 'following', 'orbiting the overview is not a pause either');
  harness.controller.setCursorPosition({ lat: 42.36, lon: -71.0 }, { headingDeg: 44, altFt: 18 }, true);
  assert.equal(scene.state.followMode, 'orbit', 'the next scrub re-engages follow');

  scene.options.onUserPan();
  assert.equal(followStatuses.at(-1), 'paused');
  harness.controller.focusEvent(buildTimeline().events[1]);
  assert.equal(followStatuses.at(-1), 'following', 'choosing an event resumes following');
  assert.equal(scene.state.followMode, 'orbit');

  harness.controller.render({ ...buildTimeline(), flightId: 'flight-2' });
  assert.equal(scene.state.followMode, 'none', 'a new recording starts from its overview');
  assert.equal(followStatuses.at(-1), 'following');
});

test('scrubbing re-plans the ground imagery around the followed aircraft without waiting for a user drag', async () => {
  const harness = createHarness();
  harness.controller.setActive(true);
  await flushPromises();
  const scene = harness.getScene();
  harness.controller.render(buildTimeline());
  const plannedAfterRender = scene.countCalls('setGroundTiles');

  harness.controller.setCursorPosition({ lat: 40.35, lon: -74.5 }, { headingDeg: 43, altFt: 28000 }, true);
  harness.windowRef.runTimers();
  assert.equal(scene.countCalls('setGroundTiles'), plannedAfterRender + 1, 'engaging follow re-plans the tiles at once');

  harness.controller.setCursorPosition({ lat: 41.33, lon: -72.84 }, { headingDeg: 47, altFt: 9800 }, true);
  harness.controller.setCursorPosition({ lat: 42.36, lon: -71.0 }, { headingDeg: 44, altFt: 18 }, true);
  assert.equal(scene.countCalls('setGroundTiles'), plannedAfterRender + 1, 'further scrubs wait for the throttle');
  const pendingRefreshes = harness.windowRef.timers.filter((timer) => !timer.cleared && !timer.fired && !timer.interval);
  assert.equal(pendingRefreshes.length, 1, 'one throttled re-plan is pending');
  harness.windowRef.runTimers();
  assert.equal(scene.countCalls('setGroundTiles'), plannedAfterRender + 2, 'the throttled re-plan runs once the interval elapses');

  harness.controller.setCursorPosition({ lat: 40.35, lon: -74.5 }, { headingDeg: 43, altFt: 28000 }, false);
  harness.windowRef.runTimers();
  assert.equal(scene.countCalls('setGroundTiles'), plannedAfterRender + 2, 'a cursor update without a pan request does not re-plan');
});
