import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
import { createMessageFrameBatcher, FRAME_COALESCED_MESSAGE_TYPES, IMMEDIATE_MESSAGE_TYPES } from '../app/runtime.js';
import { emitWsMessage, emitWsMessageReceived, subscribeWsMessage, subscribeWsMessageReceived } from '../app/runtime-signals.js';
import { createFakeScene, createFakeWindow, flushPromises } from '../maps/three-d/fake-scene.js';
import { useLiveMapStore } from '../vue/stores/live-map.js';
import { createLiveMap3dController } from './map-3d-controller.js';
import { initLiveMapRuntime } from './runtime.js';

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
