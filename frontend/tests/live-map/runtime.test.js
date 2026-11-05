import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
import { createMessageFrameBatcher, FRAME_COALESCED_MESSAGE_TYPES, IMMEDIATE_MESSAGE_TYPES } from '../../src/app/runtime.js';
import { emitWsMessage, emitWsMessageReceived, subscribeWsMessage, subscribeWsMessageReceived } from '../../src/app/runtime-signals.js';
import { createFakeScene, createFakeWindow, flushPromises } from '../maps/three-d/fake-scene.js';
import { useLiveMapStore } from '../../src/vue/stores/live-map.js';
import { useSimbriefStore } from '../../src/vue/stores/simbrief.js';
import { createLiveMap3dController } from '../../src/live-map/map-3d-controller.js';
import { initLiveMapRuntime } from '../../src/live-map/runtime.js';

test('a phone SimBrief import replaces its map route without a privileged server echo', async (t) => {
  setActivePinia(createPinia());
  const liveMapStore = useLiveMapStore();
  const simbriefStore = useSimbriefStore();
  const tabsStore = reactive({ activeTabId: 'livemap' });
  const statusStore = reactive({ websocket: 'ready' });
  const windowRef = createFakeWindow();
  windowRef.addEventListener = () => {};
  windowRef.removeEventListener = () => {};
  const airports = {
    YSSY: { icao: 'YSSY', lat: -33.9461, lon: 151.1772 },
    YMML: { icao: 'YMML', lat: -37.6733, lon: 144.8433 },
    YBBN: { icao: 'YBBN', lat: -27.3842, lon: 153.1175 },
  };
  const sent = [];
  let scene;
  liveMapStore.setViewMode('3d');
  const cleanup = initLiveMapRuntime({
    liveMapStore, simbriefStore, tabsStore, statusStore, windowRef,
    canSyncTargets: () => false,
    localStorageRef: null,
    allowOnlineMapTiles: () => false,
    getElementById: () => ({ offsetParent: {}, clientWidth: 390, clientHeight: 600 }),
    sendMessage: (message) => { sent.push(message); return true; },
    subscribeWsMessageSignal: subscribeWsMessage,
    create3dController: (options) => createLiveMap3dController({
      ...options, loadThree: async () => ({}),
      createScene: (sceneOptions) => (scene = createFakeScene(sceneOptions)),
    }),
  });
  t.after(cleanup);
  const reply = (request, success = true) => emitWsMessage({
    type: 'airportLookupResult', requestId: request.requestId, success,
    ...airports[request.icao], error: success ? undefined : 'Airport lookup failed',
  });
  const pendingLookups = () => sent.filter(message => message.type === 'requestAirportLookup');
  const sharedPlan = { type: 'flightPlan', origin: 'YSSY', destination: 'YMML', arrivalRunway: '16' };
  emitWsMessage({ type: 'position', lat: -33.9461, lon: 151.1772 });
  emitWsMessage({ type: 'originTarget', target: airports.YSSY });
  emitWsMessage({ type: 'destinationTarget', target: airports.YMML });
  emitWsMessage(sharedPlan);
  await flushPromises();
  const oldRoute = Array.from(scene.state.routeLine);

  // The phone can fetch the OFP, but cannot publish flightPlan/setTarget messages.
  simbriefStore.bindRuntime({ sendMessage: () => false, httpBase: 'http://fixture' });
  simbriefStore.username = 'fixture-pilot';
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, ofp: {
      origin: { icao_code: 'YSSY', plan_rwy: '34L' },
      destination: { icao_code: 'YBBN', plan_rwy: '01R' },
    } }),
  }));
  tabsStore.activeTabId = 'dispatch';
  await simbriefStore.fetchOfp();
  await nextTick();
  assert.equal(simbriefStore.plan.destination, 'YBBN');
  assert.equal(liveMapStore.targetInput, 'YBBN', 'the fetched plan must reach the map without a server echo');
  const firstRequests = pendingLookups();
  assert.deepEqual(firstRequests.map(request => request.icao), ['YSSY', 'YBBN']);
  firstRequests.forEach(request => reply(request));
  tabsStore.activeTabId = 'livemap';
  await nextTick();
  await flushPromises();
  assert.equal(liveMapStore.destinationProgressLabel, 'From YSSY RWY 34L -> To YBBN RWY 01R');
  assert.notDeepEqual(Array.from(scene.state.routeLine), oldRoute, 'the rendered route must change too');

  // Reconnect replay of the PC's older shared route cannot replace the phone's import.
  statusStore.websocket = 'disconnected';
  await nextTick();
  statusStore.websocket = 'ready';
  await nextTick();
  emitWsMessage(sharedPlan);
  emitWsMessage({ type: 'originTarget', target: airports.YSSY });
  emitWsMessage({ type: 'destinationTarget', target: airports.YMML });
  pendingLookups().slice(firstRequests.length).forEach(request => reply(request));
  assert.equal(liveMapStore.targetInput, 'YBBN');
  assert.equal(liveMapStore.destinationProgressLabel, 'From YSSY RWY 34L -> To YBBN RWY 01R');
  assert.equal(sent.some(message => /^(set|clear)(Origin|Destination)Target$/.test(message.type)), false,
    'phone lookups must never try to mutate shared PC targets');

  // Clearing relinquishes the local route; late lookup replies cannot restore it.
  await simbriefStore.fetchOfp();
  await nextTick();
  const retiredRequests = pendingLookups().slice(-2);
  simbriefStore.clearOfp();
  await nextTick();
  retiredRequests.forEach(request => reply(request));
  retiredRequests.forEach(request => reply(request, false));
  emitWsMessage({ type: 'originTarget', target: airports.YSSY });
  emitWsMessage({ type: 'destinationTarget', target: airports.YMML });
  assert.equal(liveMapStore.targetInput, 'YMML');
  assert.equal(liveMapStore.destinationProgressLabel, 'From YSSY -> To YMML RWY 16');
});

test('a restored phone plan retries on connection and retires lookups on replacement and disposal', async (t) => {
  setActivePinia(createPinia());
  const liveMapStore = useLiveMapStore();
  const simbriefStore = useSimbriefStore();
  simbriefStore.plan = { origin: 'YSSY', destination: 'YMML', arrivalRunway: '16' };
  const statusStore = reactive({ websocket: 'connecting' });
  const windowRef = createFakeWindow();
  windowRef.addEventListener = () => {};
  windowRef.removeEventListener = () => {};
  const sent = [];
  let connected = false;
  const cleanup = initLiveMapRuntime({
    liveMapStore, simbriefStore, statusStore, windowRef, localStorageRef: null,
    canSyncTargets: () => false,
    getElementById: id => id === 'live-map' ? { offsetParent: {} } : null,
    sendMessage: message => { sent.push(message); return connected; },
    subscribeWsMessageSignal: subscribeWsMessage,
  });
  t.after(cleanup);
  assert.equal(liveMapStore.targetInput, 'YMML', 'a plan restored before map mount seeds the route');
  connected = true;
  statusStore.websocket = 'ready';
  await nextTick();
  const lookups = () => sent.filter(message => message.type === 'requestAirportLookup');
  const retired = lookups().slice(-2);
  assert.deepEqual(retired.map(request => request.icao), ['YSSY', 'YMML']);
  simbriefStore.plan = { origin: 'YMML', destination: 'YSSY', arrivalRunway: '34L' };
  const current = lookups().slice(-2);
  const airports = { YSSY: { lat: -33.9461, lon: 151.1772 }, YMML: { lat: -37.6733, lon: 144.8433 } };
  const reply = (request, success) => emitWsMessage({
    type: 'airportLookupResult', requestId: request.requestId, icao: request.icao,
    success, ...airports[request.icao], error: success ? undefined : 'Airport database unavailable',
  });
  for (const request of retired) {
    reply(request, true);
    reply(request, false);
  }
  assert.equal(liveMapStore.targetInput, 'YSSY');
  assert.equal(liveMapStore.targetStatusMessage, 'Looking up YSSY...');
  reply(current[0], true);
  reply(current[1], false);
  assert.equal(liveMapStore.targetStatusMessage, 'Airport database unavailable');
  assert.equal(liveMapStore.destinationProgressVisible, false, 'failed replacement cannot display the previous route');

  simbriefStore.plan = { ...simbriefStore.plan };
  lookups().slice(-2).forEach(request => reply(request, true));
  assert.equal(liveMapStore.destinationProgressLabel, 'From YMML -> To YSSY RWY 34L');
  cleanup();
  const countAfterCleanup = sent.length;
  simbriefStore.plan = { origin: 'YSSY', destination: 'YMML' };
  await nextTick();
  retired.forEach(request => reply(request, true));
  assert.equal(sent.length, countAfterCleanup, 'disposed runtime removes its plan watcher');
  assert.equal(liveMapStore.targetInput, 'YSSY', 'disposed runtime ignores late lookup results');
});

for (const suspendedFrames of [false, true]) {
  test(`live 3D preserves a continuous climb and descent with ${suspendedFrames ? 'suspended' : 'normal'} display frames`, async () => {
    setActivePinia(createPinia());
    const liveMapStore = useLiveMapStore();
    const tabsStore = reactive({ activeTabId: 'aircraft' });
    const windowRef = createFakeWindow();
    windowRef.addEventListener = () => {};
    windowRef.removeEventListener = () => {};
    const mapEl = { offsetParent: {} };
    const map3dEl = { offsetParent: {}, clientWidth: 800, clientHeight: 600 };
    let clock = 1_000_000;
    let controller;
    let scene;
    const cleanup = initLiveMapRuntime({
      liveMapStore,
      tabsStore,
      windowRef,
      localStorageRef: null,
      getElementById: (id) => id === 'live-map' ? mapEl : map3dEl,
      subscribeWsMessageSignal: subscribeWsMessage,
      subscribeTelemetryMessageSignal: subscribeWsMessageReceived,
      create3dController: (options) => {
        controller = createLiveMap3dController({
          ...options,
          now: () => clock,
          loadThree: async () => ({}),
          createScene: (sceneOptions) => (scene = createFakeScene(sceneOptions)),
        });
        return controller;
      },
    });
    const displayedAltitudes = [];
    const batcher = createMessageFrameBatcher({
      windowRef: { requestAnimationFrame() {} },
      coalescedMessageTypes: FRAME_COALESCED_MESSAGE_TYPES,
      immediateMessageTypes: IMMEDIATE_MESSAGE_TYPES,
      onMessageReceived: emitWsMessageReceived,
      handleMessage: (message) => {
        if (message.type === 'altitude') displayedAltitudes.push(message.plane);
        emitWsMessage(message);
      },
    });

    try {
      batcher.enqueue({ type: 'altitude', msl: 1000, plane: 1000 });
      batcher.flush();
      const altitudes = Array.from({ length: 121 }, (_, index) => 1000 + Math.min(index, 120 - index) * 100);
      for (let index = 0; index < altitudes.length; index += 1) {
        clock += 2000;
        batcher.enqueue({ type: 'altitude', msl: altitudes[index], plane: altitudes[index] });
        batcher.enqueue({ type: 'gs', value: 200 + index });
        batcher.enqueue({ type: 'vs', value: index <= 60 ? 3000 : -3000 });
        batcher.enqueue({ type: 'position', lat: 53 - index * 0.002, lon: -2 });
        if (!suspendedFrames) batcher.flush();
      }
      assert.equal(controller.getTrackSize(), altitudes.length);
      assert.equal(displayedAltitudes.length, suspendedFrames ? 1 : 122);
      assert.equal(batcher.queuedCount(), suspendedFrames ? 3 : 0, 'display telemetry stays coalesced');
      batcher.flush();
      clock += 2000;
      batcher.enqueue({ type: 'position', lat: 53 - 121 * 0.002, lon: -2 });
      altitudes.push(altitudes.at(-1));

      liveMapStore.setViewMode('3d');
      tabsStore.activeTabId = 'livemap';
      await nextTick();
      await flushPromises();
      assert.ok(scene?.state.track, 'the scene draws the history collected before activation');
      const positions = scene.state.track.pathPositions;
      const scale = scene.state.aircraft.altitudeUnitsPerFoot;
      assert.equal(scene.state.track.pointCount, altitudes.length, 'processed messages must not duplicate samples');
      assert.equal(positions.length, (altitudes.length - 1) * 6);
      for (let index = 0; index < altitudes.length - 1; index += 1) {
        assert.ok(Math.abs(positions[index * 6 + 1] / scale - altitudes[index]) < 0.01,
          `span ${index} starts at its received altitude`);
        assert.ok(Math.abs(positions[index * 6 + 4] / scale - altitudes[index + 1]) < 0.01,
          `span ${index} ends at its received altitude`);
      }
      assert.equal(liveMapStore.scene3dHud.altitudeFt, 1000);
      assert.equal(liveMapStore.scene3dHud.groundSpeedKts, 320);
      assert.equal(liveMapStore.scene3dHud.verticalSpeedFpm, -3000);

      // A delayed processed altitude must not overwrite a newer raw sample.
      emitWsMessageReceived({ type: 'altitude', plane: 1100 });
      emitWsMessage({ type: 'altitude', plane: 9000 });
      assert.equal(liveMapStore.scene3dHud.altitudeFt, 1100);
    } finally {
      cleanup();
    }
    const countAfterCleanup = controller.getTrackSize();
    emitWsMessageReceived({ type: 'position', lat: 52, lon: -2 });
    emitWsMessage({ type: 'position', lat: 52, lon: -2 });
    assert.equal(controller.getTrackSize(), countAfterCleanup, 'both subscriptions are removed on cleanup');
  });
}

test('foregrounding an unrelated tab keeps retained 3D rendering suspended until the map is visible', async () => {
  setActivePinia(createPinia());
  const liveMapStore = useLiveMapStore();
  liveMapStore.setViewMode('3d');
  const tabsStore = reactive({ activeTabId: 'livemap' });
  const windowRef = createFakeWindow();
  windowRef.addEventListener = () => {};
  windowRef.removeEventListener = () => {};
  const documentListeners = new Map();
  windowRef.document.addEventListener = (type, callback) => documentListeners.set(type, callback);
  windowRef.document.removeEventListener = (type) => documentListeners.delete(type);
  const mapEl = { offsetParent: {} };
  const map3dEl = { offsetParent: {}, clientWidth: 800, clientHeight: 600 };
  let controller;
  let scene;
  const cleanup = initLiveMapRuntime({
    liveMapStore,
    tabsStore,
    windowRef,
    localStorageRef: null,
    allowOnlineMapTiles: () => false,
    getElementById: (id) => id === 'live-map' ? mapEl : map3dEl,
    create3dController: (options) => {
      controller = createLiveMap3dController({
        ...options,
        loadThree: async () => ({}),
        createScene: (sceneOptions) => (scene = createFakeScene(sceneOptions)),
      });
      return controller;
    },
  });
  try {
    controller.handleAltitudeMessage({ plane: 5000 });
    controller.handlePositionMessage({ lat: 53, lon: -2 });
    await flushPromises();
    windowRef.runTimers();
    assert.equal(scene.isActive(), true);

    windowRef.document.visibilityState = 'hidden';
    documentListeners.get('visibilitychange')();
    assert.equal(scene.isActive(), false, 'backgrounding the selected map suspends its scene');
    const backgroundUpdates = scene.countCalls('setAircraft');
    controller.handleAltitudeMessage({ plane: 5500 });
    controller.handlePositionMessage({ lat: 53.01, lon: -2 });
    windowRef.runTimers();
    assert.equal(scene.countCalls('setAircraft'), backgroundUpdates, 'background telemetry does not redraw');
    windowRef.document.visibilityState = 'visible';
    documentListeners.get('visibilitychange')();
    assert.equal(scene.isActive(), true);
    assert.equal(scene.state.aircraft.altitudeFt, 5500);

    tabsStore.activeTabId = 'autopilot';
    map3dEl.offsetParent = null;
    await nextTick();
    assert.equal(scene.isActive(), false, 'leaving the map suspends its scene');
    const starts = scene.countCalls('start');
    const groundRefreshes = scene.countCalls('setGroundTiles');
    windowRef.document.hidden = true;
    documentListeners.get('visibilitychange')();
    windowRef.document.hidden = false;
    documentListeners.get('visibilitychange')();
    windowRef.runTimers();
    assert.equal(scene.isActive(), false, 'foregrounding Aircraft must not resume the hidden map');
    assert.equal(scene.countCalls('start'), starts);
    assert.equal(scene.countCalls('setGroundTiles'), groundRefreshes, 'hidden foreground does not restart terrain work');

    controller.handleAltitudeMessage({ plane: 6000 });
    controller.handlePositionMessage({ lat: 53.02, lon: -2 });
    tabsStore.activeTabId = 'livemap';
    map3dEl.offsetParent = {};
    await nextTick();
    assert.equal(scene.isActive(), true, 'returning to the visible map resumes it');
    assert.equal(scene.state.aircraft.altitudeFt, 6000, 'hidden telemetry is retained for the return');
    assert.equal(liveMapStore.scene3dHud.altitudeFt, 6000);
  } finally {
    cleanup();
  }
  assert.equal(documentListeners.has('visibilitychange'), false);
});
