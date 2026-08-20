#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.join(__dirname, '..', '..');
const sharedSettings = require(path.join(repoRoot, 'shared', 'app-settings-shared.js'));
const { PHASES } = require(path.join(repoRoot, 'shared', 'flight-phases.js'));

function toFrontendUrl(...segments) {
  return pathToFileURL(path.join(repoRoot, 'frontend', ...segments)).href;
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...tokens) {
    for (const token of tokens) {
      if (token) this.values.add(token);
    }
  }

  remove(...tokens) {
    for (const token of tokens) {
      this.values.delete(token);
    }
  }

  contains(token) {
    return this.values.has(token);
  }

  toggle(token, force) {
    if (force === true) {
      this.values.add(token);
      return true;
    }
    if (force === false) {
      this.values.delete(token);
      return false;
    }
    if (this.values.has(token)) {
      this.values.delete(token);
      return false;
    }
    this.values.add(token);
    return true;
  }

  toString() {
    return [...this.values].join(' ');
  }
}

class FakeElement {
  constructor(id = '', options = {}) {
    this.id = id;
    this.tagName = String(options.tagName || 'DIV').toUpperCase();
    this.value = options.value || '';
    this.checked = options.checked === true;
    this.disabled = options.disabled === true;
    this.textContent = options.textContent || '';
    this.innerHTML = options.innerHTML || '';
    this.dataset = { ...(options.dataset || {}) };
    this.attributes = { ...(options.attributes || {}) };
    this.classList = new FakeClassList(options.classList || []);
    this.style = {
      values: {},
      setProperty: (key, value) => {
        this.style.values[key] = String(value);
      },
    };
    this.listeners = new Map();
    this.children = [];
    this.parentNode = null;
    this.focused = false;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event = {}) {
    const nextEvent = event;
    nextEvent.type = nextEvent.type || '';
    nextEvent.target = nextEvent.target || this;
    nextEvent.currentTarget = this;
    nextEvent.defaultPrevented = nextEvent.defaultPrevented === true;
    nextEvent.preventDefault = nextEvent.preventDefault || (() => {
      nextEvent.defaultPrevented = true;
    });
    nextEvent.stopPropagation = nextEvent.stopPropagation || (() => {});

    for (const handler of this.listeners.get(nextEvent.type) || []) {
      handler(nextEvent);
    }
    return !nextEvent.defaultPrevented;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this });
  }

  appendChild(child) {
    if (child?.isFragment === true && Array.isArray(child.children)) {
      for (const fragmentChild of child.children) {
        this.appendChild(fragmentChild);
      }
      return child;
    }
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    if (name.startsWith('data-')) {
      const dataKey = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (Object.prototype.hasOwnProperty.call(this.dataset, dataKey)) {
        return this.dataset[dataKey];
      }
    }
    return this.attributes[name] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  querySelectorAll() {
    return [];
  }

  querySelector() {
    return null;
  }

  getClientRects() {
    return [1];
  }

  focus() {
    this.focused = true;
  }

  closest() {
    return null;
  }

  get offsetWidth() {
    return 0;
  }
}

class FakeDocument {
  constructor() {
    this.byId = new Map();
    this.listeners = new Map();
    this.querySelectors = new Map();
    this.querySelectorLists = new Map();
    this.documentElement = new FakeElement('document-element', { tagName: 'HTML' });
    this.body = new FakeElement('body', { tagName: 'BODY' });
  }

  register(element) {
    if (element?.id) {
      this.byId.set(element.id, element);
    }
    return element;
  }

  getElementById(id) {
    return this.byId.get(id) || null;
  }

  createElement(tagName) {
    return new FakeElement('', { tagName });
  }

  createDocumentFragment() {
    return {
      isFragment: true,
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      },
    };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event = {}) {
    const nextEvent = event;
    nextEvent.type = nextEvent.type || '';
    nextEvent.target = nextEvent.target || this;
    nextEvent.currentTarget = this;
    nextEvent.defaultPrevented = nextEvent.defaultPrevented === true;
    nextEvent.preventDefault = nextEvent.preventDefault || (() => {
      nextEvent.defaultPrevented = true;
    });
    nextEvent.stopPropagation = nextEvent.stopPropagation || (() => {});

    for (const handler of this.listeners.get(nextEvent.type) || []) {
      handler(nextEvent);
    }
    return !nextEvent.defaultPrevented;
  }

  setQuerySelector(selector, element) {
    this.querySelectors.set(selector, element);
  }

  setQuerySelectorAll(selector, elements) {
    this.querySelectorLists.set(selector, Array.isArray(elements) ? elements : []);
  }

  querySelector(selector) {
    return this.querySelectors.get(selector) || null;
  }

  querySelectorAll(selector) {
    return this.querySelectorLists.get(selector) || [];
  }
}

class FakeWindow {
  constructor(documentRef) {
    this.document = documentRef;
    this.listeners = new Map();
    this.location = { search: '' };
    this.electronAPI = undefined;
    this.confirm = () => true;
    this.setTimeout = (fn) => {
      if (typeof fn === 'function') fn();
      return 1;
    };
    this.clearTimeout = () => {};
    this.setInterval = () => 1;
    this.clearInterval = () => {};
    this.requestAnimationFrame = (fn) => {
      if (typeof fn === 'function') fn();
      return 1;
    };
    this.matchMedia = () => ({ matches: false });
    this.CustomEvent = class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event = {}) {
    const nextEvent = event;
    nextEvent.type = nextEvent.type || '';
    nextEvent.target = nextEvent.target || this;
    nextEvent.currentTarget = this;
    nextEvent.defaultPrevented = nextEvent.defaultPrevented === true;
    nextEvent.preventDefault = nextEvent.preventDefault || (() => {
      nextEvent.defaultPrevented = true;
    });

    for (const handler of this.listeners.get(nextEvent.type) || []) {
      handler(nextEvent);
    }
    return !nextEvent.defaultPrevented;
  }
}

function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function resetGlobals(windowRef, documentRef, storage) {
  globalThis.window = windowRef;
  globalThis.document = documentRef;
  globalThis.localStorage = storage;
  globalThis.matchMedia = windowRef.matchMedia;
  globalThis.WebSocket = { OPEN: 1 };
  globalThis.CustomEvent = windowRef.CustomEvent;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { clipboard: null },
  });
  globalThis.requestAnimationFrame = windowRef.requestAnimationFrame;
  globalThis.setTimeout = windowRef.setTimeout;
  globalThis.clearTimeout = windowRef.clearTimeout;
  globalThis.setInterval = windowRef.setInterval;
  globalThis.clearInterval = windowRef.clearInterval;
  globalThis.FlightFabricAppSettings = sharedSettings;
  globalThis.FlightPhases = { PHASES };
  windowRef.localStorage = storage;
  windowRef.FlightFabricAppSettings = sharedSettings;
  windowRef.FlightPhases = { PHASES };
}

async function main() {
  const [{ createPinia, setActivePinia }, { nextTick }] = await Promise.all([
    import(toFrontendUrl('node_modules', 'pinia', 'dist', 'pinia.mjs')),
    import(toFrontendUrl('node_modules', 'vue', 'index.mjs')),
  ]);

    const [
      { useTabsStore },
      { useSettingsEditorStore },
      { useSettingsFormStore },
      { useSettingsUiStore },
    { useStatusStore },
    { useFlightStore },
    { useLiveMapStore },
    { usePreferencesStore },
    { useTimelineStore },
    { useLogbookStore },
    { useAircraftControlsStore },
    { useAircraftSpecificStore },
    { useLvarInspectorStore },
    { useDebugStore },
    { useLandingStore },
    { useProfilesStore },
    { createAppPreferences },
    { createAppSettingsController },
    { createAppMessageHandler },
    {
      FRAME_COALESCED_MESSAGE_TYPES,
      IMMEDIATE_MESSAGE_TYPES,
      bindTelemetryResumeSync,
      createMessageFrameBatcher,
    },
    { createConnection },
    { initSettingsRuntime },
    {
      emitAppSettings,
      emitAppSettingsSaved,
      emitDebugFrame,
      emitLandingReceived,
      emitTelemetryReset,
      emitWsMessage,
      emitWsClose,
      emitWsConnecting,
      emitWsError,
      emitWsOpen,
      subscribeAppSettings,
      subscribeAppSettingsSaved,
      subscribeDebugFrame,
      subscribeLandingReceived,
      subscribeTelemetryReset,
      subscribeWsMessage,
      subscribeWsClose,
      subscribeWsConnecting,
      subscribeWsError,
      subscribeWsOpen,
    },
    { getCabinAnnouncements, setAppService },
    { initTabsRuntime, LAST_ACTIVE_TAB_STORAGE_KEY, resolveInitialTabId },
    { initDebugRuntime },
    { initProfilesRuntime },
    { initLiveMapRuntime },
    { initLogbookRuntime },
    { createTelemetryDisplay },
    { createTelemetryWarnings },
    { AIRCRAFT_CONTROL_BUTTON_SELECTOR },
    {
      adjustAutopilotTargetValue,
      formatAutopilotTargetValue,
      resolveAutopilotTargetStatus,
      validateAutopilotTargetValue,
    },
    { createAircraftControlController },
    { createAutopilotPanel },
    { installVisualViewportCssVars },
    { initCabinAnnouncementsRuntime },
    { createLandingController },
    { initMockLandingRuntime },
    { createLvarInspectorController },
    { createStatusIndicatorsController },
    { createLiveMapController },
    { buildPlaneIconHtml, normalizeHeadingDeg },
    { getGreatCirclePath, unwrapLatLngPath, unwrapLongitudeNear },
    { createTimelinePageController },
    { isTimelineMapElementVisible },
    { createTimelineRuntime },
    {
      createTimelineMapController,
      downsampleTimelineMapBoundsPoints,
      downsampleTimelineMapTrackPoints,
      findNearestTimelineTrackPoint,
      getTimelineMapTrackPointLimit,
      selectTimelineMapEventMarkers,
    },
    { createScrubber },
    { buildTimelineAltitudeProfileState },
    { createPFD },
    { attachTimelinePfdOverlayFitter },
    { buildLandingDetailState },
    { approachProfileApi },
    { bindSectionMotion },
  ] = await Promise.all([
    import(toFrontendUrl('src', 'vue', 'stores', 'tabs.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-editor.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-form.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-ui.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'status.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'flight.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'live-map.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'preferences.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'timeline.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'logbook.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'aircraft-controls.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'aircraft-specific.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'lvar-inspector.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'debug.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'landing.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'profiles.js')),
    import(toFrontendUrl('src', 'app', 'preferences.js')),
    import(toFrontendUrl('src', 'app', 'settings-controller.js')),
    import(toFrontendUrl('src', 'app', 'message-handlers.js')),
    import(toFrontendUrl('src', 'app', 'runtime.js')),
    import(toFrontendUrl('src', 'ws', 'connection.js')),
    import(toFrontendUrl('src', 'settings', 'runtime.js')),
    import(toFrontendUrl('src', 'app', 'runtime-signals.js')),
    import(toFrontendUrl('app-shared.js')),
    import(toFrontendUrl('src', 'tabs', 'runtime.js')),
    import(toFrontendUrl('src', 'debug', 'runtime.js')),
    import(toFrontendUrl('src', 'profiles', 'runtime.js')),
    import(toFrontendUrl('src', 'live-map', 'runtime.js')),
    import(toFrontendUrl('src', 'logbook', 'runtime.js')),
    import(toFrontendUrl('src', 'telemetry', 'display.js')),
    import(toFrontendUrl('src', 'telemetry', 'warnings.js')),
    import(toFrontendUrl('src', 'aircraft', 'control-ui.js')),
    import(toFrontendUrl('src', 'aircraft', 'autopilot-targets.js')),
    import(toFrontendUrl('src', 'aircraft', 'control-controller.js')),
    import(toFrontendUrl('src', 'aircraft', 'autopilot-panel.js')),
    import(toFrontendUrl('src', 'vue', 'composables', 'useVisualViewportCssVars.js')),
    import(toFrontendUrl('src', 'cabin-announcements', 'runtime.js')),
    import(toFrontendUrl('src', 'landing', 'controller.js')),
    import(toFrontendUrl('src', 'landing', 'mock-runtime.js')),
    import(toFrontendUrl('src', 'data-sources', 'lvar-inspector-controller.js')),
    import(toFrontendUrl('src', 'ui', 'status-indicators.js')),
    import(toFrontendUrl('src', 'live-map', 'map-controller.js')),
    import(toFrontendUrl('src', 'live-map', 'plane-icon.js')),
    import(toFrontendUrl('src', 'live-map', 'geo.js')),
    import(toFrontendUrl('src', 'timeline', 'page-controller.js')),
    import(toFrontendUrl('src', 'timeline', 'bootstrap.js')),
    import(toFrontendUrl('src', 'timeline', 'runtime.js')),
    import(toFrontendUrl('src', 'timeline', 'map-controller.js')),
    import(toFrontendUrl('src', 'timeline', 'scrubber.js')),
    import(toFrontendUrl('src', 'timeline', 'altitude-profile.js')),
    import(toFrontendUrl('src', 'timeline', 'pfd.js')),
    import(toFrontendUrl('src', 'timeline', 'pfd-overlay.js')),
    import(toFrontendUrl('src', 'timeline', 'landing-detail.js')),
    import(toFrontendUrl('src', 'landing', 'approach-profile-global.js')),
    import(toFrontendUrl('src', 'ui', 'motion.js')),
  ]);

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  [FAIL] ${name}`);
      console.error(`    ${error.message}`);
    }
  }

  console.log('\n=== Vue Runtime Interaction Tests ===\n');

  console.log('--- mobile flight controls ---\n');
  await test('autopilot target tuning validates exact bounded values and wraps heading adjustments', () => {
    assert.deepEqual(
      validateAutopilotTargetValue('alt', 12300),
      { ok: true, value: 12300, error: '' },
      'aligned altitude targets should be accepted',
    );
    assert.equal(validateAutopilotTargetValue('spd', null).ok, false, 'missing readback must not be interpreted as a zero target');
    assert.equal(validateAutopilotTargetValue('alt', 12345).ok, false, 'off-step altitude targets should fail closed');
    assert.equal(validateAutopilotTargetValue('vs', 10000).ok, false, 'out-of-range vertical speed should fail closed');
    assert.equal(adjustAutopilotTargetValue('hdg', 355, 10), 5, 'heading coarse adjustment should wrap through north');
    assert.equal(adjustAutopilotTargetValue('hdg', 4, -10), 354, 'heading decrement should wrap below north');
    assert.equal(adjustAutopilotTargetValue('alt', 60000, 1000), 60000, 'bounded adjustments should stop at the safe maximum');
    assert.equal(formatAutopilotTargetValue('vs', -700), '-700', 'vertical-speed display should preserve its sign');
  });

  await test('autopilot target rejection wins over an already-matching live readback', () => {
    assert.deepEqual(
      resolveAutopilotTargetStatus({
        mode: 'alt',
        feedbackMatches: true,
        feedbackStatus: 'failed',
        feedbackMessage: 'Profile rejected the command.',
        submittedValue: 12000,
        liveReadbackValue: 12000,
        liveDisplayValue: '12,000',
      }),
      { tone: 'failed', text: 'Profile rejected the command.' },
      'a failed command must never be presented as confirmed merely because its value was already live',
    );
  });

  await test('visual viewport CSS variables keep keyboard-safe overlays inside the visible phone viewport', () => {
    const values = {};
    const viewportListeners = new Map();
    const windowListeners = new Map();
    const visualViewport = {
      height: 540,
      offsetTop: 40,
      addEventListener(type, handler) { viewportListeners.set(type, handler); },
      removeEventListener(type, handler) {
        if (viewportListeners.get(type) === handler) viewportListeners.delete(type);
      },
    };
    const windowRef = {
      innerHeight: 900,
      visualViewport,
      addEventListener(type, handler) { windowListeners.set(type, handler); },
      removeEventListener(type, handler) {
        if (windowListeners.get(type) === handler) windowListeners.delete(type);
      },
    };
    const documentRef = {
      documentElement: {
        style: {
          setProperty(key, value) { values[key] = value; },
          removeProperty(key) { delete values[key]; },
        },
      },
    };

    const cleanup = installVisualViewportCssVars({ windowRef, documentRef });
    assert.equal(values['--ff-visual-viewport-height'], '540px');
    assert.equal(values['--ff-visual-viewport-offset-top'], '40px');
    assert.equal(values['--ff-keyboard-inset'], '320px');

    visualViewport.height = 620;
    visualViewport.offsetTop = 0;
    viewportListeners.get('resize')();
    assert.equal(values['--ff-keyboard-inset'], '280px', 'keyboard inset should follow visual viewport resize');

    cleanup();
    assert.equal(values['--ff-visual-viewport-height'], undefined, 'cleanup should remove app-owned viewport variables');
    assert.equal(viewportListeners.size, 0, 'cleanup should remove visual viewport listeners');
    assert.equal(windowListeners.size, 0, 'cleanup should remove window listeners');
  });

  console.log('--- telemetry display ---\n');
  await test('telemetry heading preserves magnetic zero over true-heading fallback', () => {
    setActivePinia(createPinia());
    const flightStore = useFlightStore();
    const currentState = {};
    const telemetryDisplay = createTelemetryDisplay({
      currentState,
      preferences: null,
      flightStore,
    });

    telemetryDisplay.updateHeadingDisplay({ mag: 0, true: 183 });

    assert.equal(flightStore.telemetry.hdg, '000', 'magnetic heading 0 should display as 000');
    assert.equal(currentState.hdg, 0, 'current heading state should preserve 0');
  });

  await test('telemetry runtime requests a fresh snapshot when a throttled tab resumes', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const sent = [];
    const reconnects = [];
    const ws = { readyState: 1 };
    let nowMs = 1000;
    const cleanup = bindTelemetryResumeSync({
      documentRef,
      windowRef,
      WebSocketRef: { OPEN: 1 },
      getWs: () => ws,
      reconnect: (detail) => {
        reconnects.push(detail);
      },
      send: (payload) => {
        if (sent.fail === true) return false;
        sent.push(payload);
        return true;
      },
      now: () => nowMs,
      minIntervalMs: 100,
      reconnectMinIntervalMs: 100,
      periodicIntervalMs: 0,
    });

    documentRef.hidden = true;
    documentRef.visibilityState = 'hidden';
    documentRef.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(sent.length, 0, 'hidden tabs should not request a snapshot');

    documentRef.hidden = false;
    documentRef.visibilityState = 'visible';
    nowMs = 1200;
    documentRef.dispatchEvent({ type: 'visibilitychange' });
    assert.deepEqual(sent.at(-1), { type: 'requestState', reason: 'visibility' });

    windowRef.dispatchEvent({ type: 'focus' });
    assert.equal(sent.length, 1, 'back-to-back resume events should be debounced');

    nowMs = 1400;
    windowRef.dispatchEvent({ type: 'focus' });
    assert.deepEqual(sent.at(-1), { type: 'requestState', reason: 'focus' });

    ws.readyState = 0;
    nowMs = 1600;
    windowRef.dispatchEvent({ type: 'pageshow' });
    assert.equal(sent.length, 2, 'closed sockets should not request a snapshot');
    assert.deepEqual(reconnects.at(-1), { reason: 'pageshow:socket-not-open' }, 'closed sockets should reconnect as soon as a visible tab wakes');

    ws.readyState = 1;
    nowMs = 1800;
    const sentBeforeFailedSend = sent.length;
    const reconnectsBeforeFailedSend = reconnects.length;
    sent.fail = true;
    windowRef.dispatchEvent({ type: 'focus' });
    assert.equal(sent.length, sentBeforeFailedSend, 'failed snapshot sends should not be counted as delivered');
    assert.equal(reconnects.length, reconnectsBeforeFailedSend + 1, 'failed snapshot sends should request a reconnect');
    assert.deepEqual(reconnects.at(-1), { reason: 'focus:send-failed' });
    sent.fail = false;

    cleanup();
    ws.readyState = 1;
    nowMs = 2000;
    windowRef.dispatchEvent({ type: 'focus' });
    assert.equal(sent.length, 2, 'cleanup should remove resume listeners');
  });

  await test('telemetry runtime refreshes state only when the visible stream goes stale', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const sent = [];
    const ws = { readyState: 1 };
    let nowMs = 1000;
    let lastMessageAt = 0;
    let intervalHandler = null;
    let intervalDelay = 0;
    let clearedInterval = null;
    windowRef.setInterval = (handler, delay) => {
      intervalHandler = handler;
      intervalDelay = delay;
      return 42;
    };
    windowRef.clearInterval = (timerId) => {
      clearedInterval = timerId;
    };

    const cleanup = bindTelemetryResumeSync({
      documentRef,
      windowRef,
      WebSocketRef: { OPEN: 1 },
      getWs: () => ws,
      getLastMessageAt: () => lastMessageAt,
      send: (payload) => {
        sent.push(payload);
      },
      now: () => nowMs,
      minIntervalMs: 750,
      periodicIntervalMs: 1000,
      staleAfterMs: 1500,
    });

    assert.equal(intervalDelay, 1000, 'stale-stream sync should use the configured refresh interval');
    assert.equal(typeof intervalHandler, 'function', 'stale-stream sync should register an interval handler');

    intervalHandler();
    assert.deepEqual(sent.at(-1), { type: 'requestState', reason: 'stale-stream' });

    nowMs = 1200;
    intervalHandler();
    assert.equal(sent.length, 1, 'stale-stream refreshes should still respect request debouncing');

    documentRef.hidden = true;
    documentRef.visibilityState = 'hidden';
    nowMs = 2200;
    intervalHandler();
    assert.equal(sent.length, 1, 'hidden tabs should not perform periodic state refreshes');

    documentRef.hidden = false;
    documentRef.visibilityState = 'visible';
    lastMessageAt = 2000;
    nowMs = 2200;
    intervalHandler();
    assert.equal(sent.length, 1, 'fresh live traffic should suppress periodic state replays');

    nowMs = 3500;
    intervalHandler();
    assert.equal(sent.length, 1, 'the stale boundary should not fire until traffic is older than the threshold');

    ws.readyState = 0;
    nowMs = 3501;
    intervalHandler();
    assert.equal(sent.length, 1, 'stale sync should skip closed sockets');

    cleanup();
    assert.equal(clearedInterval, 42, 'cleanup should clear the periodic refresh timer');
  });

  await test('connection keeps bootstrap auth on the socket URL while exposing a token-free display URL', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    const sockets = [];
    windowRef.fetch = async (url) => ({
      ok: String(url).endsWith('/api/bootstrap'),
      async json() {
        return { wsAuthToken: 'module-token' };
      },
    });

    class FakeAuthWebSocket {
      static OPEN = 1;

      constructor(url) {
        this.url = url;
        this.readyState = 0;
        sockets.push(this);
      }

      close() {}
    }

    const connection = createConnection({
      windowRef,
      WebSocketRef: FakeAuthWebSocket,
      params: new URLSearchParams(),
      defaultWsPort: 8099,
      defaultHttpPort: 8100,
      reconnectDelay: 9999,
      setConnectionInfo: () => {},
      onConnecting: () => {},
      onOpen: () => {},
      onClose: () => {},
      onError: () => {},
      onMessage: () => {},
    });

    await connection.initialize();

    assert.equal(sockets.length, 1, 'connection should open one main websocket');
    assert.equal(sockets[0].url, 'ws://localhost:8099?token=module-token', 'main websocket should use bootstrap token');
    assert.equal(connection.getWsUrl(), 'ws://localhost:8099', 'display websocket URL should stay token-free');
  });

  await test('message frame batcher coalesces bursty websocket packets into one animation-frame flush', () => {
    const flushed = [];
    const rafCallbacks = [];
    const windowRef = {
      requestAnimationFrame(callback) {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
      setTimeout(callback) {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
    };

    const batcher = createMessageFrameBatcher({
      windowRef,
      handleMessage(message) {
        flushed.push(message.type);
      },
    });

    batcher.enqueue({ type: 'ias' });
    batcher.enqueue({ type: 'altitude' });
    batcher.enqueue({ type: 'gear' });

    assert.equal(rafCallbacks.length, 1, 'bursty packets should share one scheduled frame');
    assert.equal(flushed.length, 0, 'messages should wait until the scheduled frame flush');

    rafCallbacks.shift()();

    assert.deepEqual(flushed, ['ias', 'altitude', 'gear'], 'frame flush should preserve websocket message order');
    assert.equal(batcher.queuedCount(), 0, 'frame flush should drain the queued websocket packets');
  });

  await test('message frame batcher coalesces configured live-state packets before flushing', () => {
    const flushed = [];
    const rafCallbacks = [];
    const windowRef = {
      requestAnimationFrame(callback) {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
      setTimeout(callback) {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
    };

    const batcher = createMessageFrameBatcher({
      windowRef,
      coalescedMessageTypes: new Set(['ias', 'position', 'simState']),
      handleMessage(message) {
        flushed.push(message);
      },
    });

    batcher.enqueue({ type: 'ias', value: 120 });
    batcher.enqueue({ type: 'ias', value: 124 });
    batcher.enqueue({ type: 'landing', id: 'touchdown' });
    batcher.enqueue({ type: 'ias', value: 130 });
    batcher.enqueue({ type: 'position', lat: 1, lon: 2 });
    batcher.enqueue({ type: 'position', lat: 3, lon: 4 });
    batcher.enqueue({ type: 'simState', simconnectConnected: false });
    batcher.enqueue({ type: 'simState', simconnectConnected: true });

    assert.equal(batcher.queuedCount(), 5, 'coalesced live-state packets should not build an unbounded hidden-tab queue');

    rafCallbacks.shift()();

    assert.deepEqual(
      flushed,
      [
        { type: 'ias', value: 124 },
        { type: 'landing', id: 'touchdown' },
        { type: 'ias', value: 130 },
        { type: 'position', lat: 3, lon: 4 },
        { type: 'simState', simconnectConnected: true },
      ],
      'flush should keep the latest live-state packets while preserving one-shot messages',
    );
    assert.equal(batcher.queuedCount(), 0, 'coalesced indexes should reset after the frame flush');
  });

  await test('authorization scope and live positions bypass frame batching', () => {
    const flushed = [];
    const rafCallbacks = [];
    const windowRef = {
      requestAnimationFrame(callback) {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
      setTimeout(callback) {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
    };
    const batcher = createMessageFrameBatcher({
      windowRef,
      coalescedMessageTypes: FRAME_COALESCED_MESSAGE_TYPES,
      immediateMessageTypes: IMMEDIATE_MESSAGE_TYPES,
      handleMessage(message) {
        flushed.push(message);
      },
    });

    batcher.enqueue({ type: 'ias', value: 120 });
    batcher.enqueue({ type: 'ias', value: 124 });
    batcher.enqueue({ type: 'authorizationScope', scope: 'aircraft-control' });
    batcher.enqueue({ type: 'position', lat: -37.67, lon: 144.84 });
    batcher.enqueue({ type: 'position', lat: -37.66, lon: 144.83 });
    batcher.enqueue({ type: 'position', lat: -37.65, lon: 144.82 });

    assert.deepEqual(
      flushed,
      [
        { type: 'authorizationScope', scope: 'aircraft-control' },
        { type: 'position', lat: -37.67, lon: 144.84 },
        { type: 'position', lat: -37.66, lon: 144.83 },
        { type: 'position', lat: -37.65, lon: 144.82 },
      ],
      'authorization changes and position history should not wait for a render frame that may be suspended',
    );
    assert.equal(batcher.queuedCount(), 1, 'display telemetry should remain bounded and frame-coalesced');

    rafCallbacks.shift()();
    assert.deepEqual(flushed.at(-1), { type: 'ias', value: 124 }, 'the latest display value should still flush normally');
    assert.equal(batcher.queuedCount(), 0, 'the display queue should drain after rendering resumes');
  });

  console.log('\n--- preferences bridge ---\n');
  await test('app preferences register runtime-backed Vue actions for fuel units and branding', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    const storage = createStorage();
    resetGlobals(windowRef, documentRef, storage);
    setActivePinia(createPinia());

    const flightStore = useFlightStore();
    const preferencesStore = usePreferencesStore();

    const sent = [];
    assert.throws(
      () => createAppPreferences({ storage }),
      /Preferences store is required/,
      'app preferences runtime should fail fast without the injected preferences store',
    );
    assert.throws(
      () => createAppPreferences({ storage, preferencesStore }),
      /Flight store is required/,
      'app preferences runtime should fail fast without the injected flight store',
    );

    const appPreferences = createAppPreferences({
      storage,
      preferencesStore,
      flightStore,
      getWsSend: () => (payload) => {
        sent.push(payload);
      },
    });

    assert.equal(preferencesStore.fuelUnit, 'gal', 'app preferences should hydrate the Vue preferences store with the stored fuel unit');
    assert.equal(flightStore.telemetry.fuelUnit, 'gal', 'app preferences should hydrate the flight store fuel unit display');

    appPreferences.setFuelTelemetry({ totalGal: 406, totalWeightLbs: 2720 });
    assert.equal(flightStore.telemetry.fuel, '406', 'gallon display should use gallons');

    assert.equal(preferencesStore.requestFuelUnitCycle(), true, 'fuel-unit button actions should delegate through the Vue preferences store');
    assert.equal(preferencesStore.fuelUnit, 'lbs', 'fuel-unit delegation should cycle the preference state');
    assert.equal(flightStore.telemetry.fuelUnit, 'lbs', 'fuel-unit delegation should update the flight store display unit');
    assert.equal(flightStore.telemetry.fuel, '2,720', 'pound display should use simulator-provided fuel mass');
    assert.deepEqual(sent[0], { type: 'fuelUnit', unit: 'lbs' }, 'fuel-unit delegation should continue to notify the backend');

    assert.equal(preferencesStore.requestShowBranding(false), true, 'branding actions should delegate through the Vue preferences store');
    assert.equal(preferencesStore.showBranding, false, 'branding delegation should update the Vue preferences store');
    assert.equal(storage.getItem('ff-show-branding'), 'false', 'branding delegation should persist the stored frontend preference');
  });

  await test('app settings controller delegates cabin-announcement settings through injected runtime dependencies', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const versionEl = documentRef.register(new FakeElement('app-version'));
    const appliedSettings = [];
    const emitted = [];
    const unsubscribe = subscribeAppSettings((detail) => {
      emitted.push(detail);
    });

    const controller = createAppSettingsController({
      $: (id) => documentRef.getElementById(id),
      windowRef,
      getCabinAnnouncements() {
        return {
          applySettings(settings) {
            appliedSettings.push(settings);
          },
        };
      },
    });

    controller.apply({
      cabinAnnouncements: {
        enabled: false,
        style: 'concise',
      },
    }, {
      backendVersion: '0.1.3',
      settingsFile: 'C:/Flight Fabric/settings.json',
      storage: {
        flightLogsDir: 'C:/Flights',
      },
    });

    unsubscribe();

    assert.equal(versionEl.textContent, 'v0.1.3 Alpha', 'settings controller should update the visible version target');
    assert.deepEqual(
      appliedSettings,
      [{
        enabled: false,
        style: 'concise',
      }],
      'settings controller should forward cabin-announcement settings through the injected runtime service',
    );
    assert.equal(controller.getSettings().cabinAnnouncements.style, 'concise', 'settings controller should retain the applied settings snapshot');
    assert.equal(controller.getStorage().flightLogsDir, 'C:/Flights', 'settings controller should retain the applied storage snapshot');
    assert.equal(emitted.length, 1, 'settings controller should emit one app-settings runtime signal');
    assert.equal(emitted[0].backendVersion, 'v0.1.3 Alpha', 'app-settings runtime signal should include the formatted backend version');
    assert.equal(emitted[0].settingsFile, 'C:/Flight Fabric/settings.json', 'app-settings runtime signal should include the settings file path');
  });

  await test('app message handler routes cabin-announcement messages through an injected runtime service', () => {
    const enqueued = [];
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(),
      getSimconnectTelemetryConnected: () => true,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {},
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: { setFeedback() {} },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {},
      flightStore: null,
      getCabinAnnouncements() {
        return {
          enqueue(message) {
            enqueued.push(message);
          },
        };
      },
    });

    handler({
      type: 'cabinAnnouncement',
      phase: 'CRUISE',
      style: 'standard',
    });

    assert.deepEqual(
      enqueued,
      [{
        type: 'cabinAnnouncement',
        phase: 'CRUISE',
        style: 'standard',
      }],
      'message handler should forward cabin announcements through the injected runtime service',
    );
  });

  await test('app message handler refreshes aircraft-control availability when authorization changes', () => {
    let availabilityRefreshes = 0;
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(),
      getSimconnectTelemetryConnected: () => true,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {},
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: {
        updateAvailability() {
          availabilityRefreshes += 1;
        },
      },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {},
      flightStore: null,
    });

    handler({ type: 'authorizationScope', scope: 'aircraft-control' });
    assert.equal(
      availabilityRefreshes,
      1,
      'an acknowledged authorization upgrade should immediately refresh aircraft-control availability',
    );

    handler({ type: 'authorizationScope', scope: 'read-only' });
    assert.equal(
      availabilityRefreshes,
      2,
      'an authorization downgrade should immediately disable aircraft controls',
    );
  });

  await test('app message handler raises a persistent restart-required banner after restart-required settings saves', () => {
    setActivePinia(createPinia());
    const statusStore = useStatusStore();
    const applied = [];
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(),
      getSimconnectTelemetryConnected: () => true,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {},
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: { setFeedback() {} },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: {
        apply(settings, options) {
          applied.push({ settings, options });
        },
      },
      updateEngines: () => {},
      flightStore: null,
      statusStore,
    });

    handler({
      type: 'appSettingsSaved',
      ok: true,
      settings: { aircraft: { profile: 'fss-e175' } },
      settingsFile: 'C:/Flight Fabric/settings.json',
      storage: { flightLogsDir: 'C:/Flights' },
      restartRequired: true,
      restartReasons: ['Aircraft profile override'],
    });

    assert.equal(statusStore.restartRequiredBannerVisible, true, 'restart-required saves should raise the global banner');
    assert.match(statusStore.restartRequiredMessage, /Aircraft profile override/, 'global restart banner should explain the reason');
    assert.equal(statusStore.systemBannerCount, 1, 'restart-required banner should participate in body offset rows');
    assert.equal(applied.length, 1, 'settings save payloads should still apply through the settings controller');

    handler({
      type: 'appSettingsSaved',
      ok: true,
      settings: { network: { remoteAccess: true } },
      restartRequired: true,
      restartReasons: ['Network ports / remote access'],
    });

    assert.deepEqual(
      statusStore.restartRequiredReasons,
      ['Aircraft profile override', 'Network ports / remote access'],
      'multiple restart-required saves should preserve all visible restart reasons until dismissal or restart',
    );
  });

  await test('app message handler forwards flight recording state to desktop recording badges', () => {
    setActivePinia(createPinia());
    const statusStore = useStatusStore();
    const badgeStates = [];
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(),
      getSimconnectTelemetryConnected: () => true,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {},
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: { setFeedback() {} },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {},
      flightStore: null,
      statusStore,
      desktopIntegration: {
        setRecordingBadge(message) {
          badgeStates.push({ status: message.status, fileName: message.fileName });
        },
      },
    });

    handler({
      type: 'flightRecording',
      status: 'recording',
      fileName: 'active-flight.csv',
    });
    handler({
      type: 'flightRecording',
      status: 'finalizing',
      fileName: 'active-flight.csv',
    });
    handler({
      type: 'flightRecording',
      status: 'stopped',
      fileName: 'active-flight.csv',
    });

    assert.deepEqual(
      badgeStates.map((state) => state.status),
      ['recording', 'finalizing', 'stopped'],
      'desktop recording badge should receive every recording lifecycle state',
    );
    assert.equal(statusStore.recordingVisible, false, 'stopped recording messages should still clear the status-store recording chip');
  });

  await test('app message handler forwards timeline list errors to the timeline store', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(),
      getSimconnectTelemetryConnected: () => true,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {},
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: { setFeedback() {} },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {},
      flightStore: null,
      timelineStore,
    });

    handler({
      type: 'timelineListError',
      error: 'Privileged session required for this action.',
    });

    assert.equal(timelineStore.listStatus, 'error', 'timeline list errors should reach the timeline store');
    assert.equal(timelineStore.emptyStateMessage, 'Privileged session required for this action.', 'timeline list error copy should render instead of an empty-list message');
  });

  await test('app service cleanup clears cabin-announcement compatibility lookups', () => {
    const cabinService = {
      enqueue() {},
    };

    setAppService('cabinAnnouncements', cabinService);
    assert.equal(getCabinAnnouncements(), cabinService, 'registered cabin service should resolve through the shared getter');

    setAppService('cabinAnnouncements', null);
    assert.equal(getCabinAnnouncements(), null, 'clearing cabin service should remove stale compatibility references');
  });

  await test('app message handler rehydrates the aircraft title after an aircraft change', () => {
    setActivePinia(createPinia());
    const statusStore = useStatusStore();
    const aircraftControlsStore = useAircraftControlsStore();
    const aircraftSpecificStore = useAircraftSpecificStore();
    aircraftControlsStore.setAvailability({ enabled: true, reason: 'Ready.' });
    aircraftControlsStore.applyControlCapabilities({
      surface: { gearUp: true },
      autopilot: { heading: true },
    });
    aircraftControlsStore.setCommandPending({ type: 'selector-adjust', mode: 'hdg', action: 'inc10' });
    const feedback = [];
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(),
      getSimconnectTelemetryConnected: () => true,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {},
      resetTelemetryDisplay: (reason) => {
        statusStore.resetTelemetry(reason);
      },
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: {
        applyControlCapabilities(capabilities) {
          aircraftControlsStore.applyControlCapabilities(capabilities);
        },
        resetProfileState(reason) {
          aircraftControlsStore.prepareForAircraftChange(reason);
        },
        setFeedback(payload) {
          feedback.push(payload);
          aircraftControlsStore.setFeedback(payload);
        },
      },
      aircraftSpecificStore,
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {},
      flightStore: null,
      statusStore,
    });

    handler({
      type: 'aircraftProfile',
      profile: { id: 'old-aircraft', name: 'Old Aircraft' },
      provenance: { verificationStatus: 'partial', sourceCount: 1 },
    });
    assert.equal(statusStore.aircraftNameLabel, 'Old Aircraft');

    handler({ type: 'aircraftChanged', previousTitle: 'Old Aircraft', newTitle: 'iniBuilds L-1011 TriStar' });
    assert.equal(statusStore.aircraftNameLabel, '--', 'aircraft changes should clear the stale previous title');
    assert.equal(aircraftControlsStore.feedback.profileText, 'Detecting active profile...', 'aircraft changes should clear stale controls profile feedback');
    assert.equal(aircraftControlsStore.isCommandSupported({ type: 'selector-adjust', mode: 'hdg', action: 'inc10' }), false, 'aircraft changes should gate old profile selector writes until capabilities refresh');
    assert.equal(aircraftControlsStore.isCommandPending({ type: 'selector-adjust', mode: 'hdg', action: 'inc10' }), false, 'aircraft changes should clear stale pending commands');

    handler({
      type: 'aircraftProfile',
      profile: { id: 'inibuilds-tristar', name: 'iniBuilds L-1011 TriStar' },
      provenance: { verificationStatus: 'verified', sourceCount: 2 },
    });
    assert.equal(statusStore.aircraftNameLabel, 'iniBuilds L-1011 TriStar');
    assert.equal(feedback.at(-1).profileText, 'inibuilds-tristar');

    handler({
      type: 'aircraftProfile',
      profile: {
        id: 'pmdg-737',
        name: 'PMDG Boeing 737',
        _profileKey: 'bundled/msfs/pmdg-737',
        profileRevision: 4,
        aircraftSpecificTemplateId: 'pmdg-737',
      },
    });
    handler({
      type: 'aircraftSpecificState',
      profileKey: 'bundled/msfs/pmdg-737',
      profileRevision: 4,
      templateId: 'pmdg-737',
      available: true,
      sourceStatus: { overall: 'connected', sources: { lvar: 'connected' } },
      values: { 'afds.cmdA': true, 'afds.cmdB': false },
      unavailable: [],
      actionCapabilities: {},
    });
    assert.equal(aircraftSpecificStore.values['afds.cmdA'], true, 'message handler should route matching aircraft-specific snapshots into Pinia');
    assert.equal(aircraftSpecificStore.values['afds.cmdB'], false, 'message handler should preserve explicit false aircraft-specific values');
    assert.equal(aircraftSpecificStore.sourceStatus, 'connected', 'message handler should preserve the provider-neutral source aggregate');
  });

  await test('app message handler clears aircraft write token on simulator disconnect', () => {
    let wasSimconnectConnected = true;
    let simconnectTelemetryConnected = true;
    let resetReason = '';
    let pendingReason = '';
    let availabilityUpdates = 0;
    const clearReasons = [];

    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(),
      getSimconnectTelemetryConnected: () => simconnectTelemetryConnected,
      setSimconnectTelemetryConnected: (value) => {
        simconnectTelemetryConnected = value;
      },
      getWasSimconnectConnected: () => wasSimconnectConnected,
      setWasSimconnectConnected: (value) => {
        wasSimconnectConnected = value;
      },
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {},
      resetTelemetryDisplay: (reason) => {
        resetReason = reason;
      },
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: {
        clearProfileToken(reason) {
          clearReasons.push(reason);
        },
        clearPendingRequests(reason) {
          pendingReason = reason;
        },
        updateAvailability() {
          availabilityUpdates += 1;
        },
        setFeedback() {},
      },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {},
      flightStore: null,
    });

    handler({ type: 'simState', simconnectConnected: false, inMenu: false });

    assert.equal(resetReason, 'simconnectDisconnected', 'sim disconnect should reset stale telemetry display');
    assert.equal(simconnectTelemetryConnected, false, 'sim disconnect should mark telemetry offline');
    assert.equal(wasSimconnectConnected, false, 'sim disconnect should update the previous-connection latch');
    assert.deepEqual(
      clearReasons,
      ['Simulator disconnected. Waiting for profile refresh.'],
      'sim disconnect should invalidate the aircraft write token',
    );
    assert.equal(pendingReason, 'Simulator disconnected before control request completed.');
    assert.equal(availabilityUpdates, 1, 'sim disconnect should refresh aircraft-control availability');
  });

  await test('raw WebSocket bridge keeps Vue flight telemetry live when legacy telemetry gate is stale', () => {
    setActivePinia(createPinia());
    const flightStore = useFlightStore();
    const unsubscribeWs = subscribeWsMessage((message) => {
      flightStore.ingestMessage(message);
    });
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(['flaps', 'gear', 'engines']),
      getSimconnectTelemetryConnected: () => false,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {
        throw new Error('legacy telemetry gate should skip live handlers in this regression');
      },
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: { setFeedback() {} },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {
        throw new Error('legacy engine handler should be skipped in this regression');
      },
      flightStore: null,
    });

    try {
      handler({ type: 'flaps', value: { notch: 4, label: 'FULL', percent: 100 } });
      assert.equal(flightStore.telemetry.flaps, 'FULL', 'Vue flight store should ingest raw flap messages directly');

      handler({ type: 'gear', data: { nose: 1, left: 1, right: 1, parkingBrake: true } });
      assert.equal(flightStore.telemetry.gearState, 'DOWN', 'Vue flight store should ingest raw gear messages directly');
      assert.equal(flightStore.telemetry.gear.parkingBrake, true, 'parking brake should update from the raw bridge');

      handler({ type: 'engines', data: { count: 4, eng1Text: '21%', eng2Text: '22%', eng3Text: '23%', eng4Text: '24%' } });
      assert.deepEqual(
        flightStore.telemetry.engines.values,
        ['21%', '22%', '23%', '24%'],
        'engine cards should update from the raw bridge even when legacy handlers are gated',
      );
    } finally {
      unsubscribeWs();
    }
  });

  await test('app message handler directly mirrors live telemetry into the Vue flight store before legacy gating', () => {
    setActivePinia(createPinia());
    const flightStore = useFlightStore();
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(['gear', 'lights']),
      getSimconnectTelemetryConnected: () => false,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {
        throw new Error('legacy telemetry gate should skip live handlers in this regression');
      },
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: { setFeedback() {} },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {},
      flightStore,
    });

    handler({ type: 'gear', data: { nose: 1, left: 1, right: 1, parkingBrake: true } });
    assert.equal(flightStore.telemetry.gear.parkingBrake, true, 'parking brake should update directly from live gear packets');
    assert.equal(flightStore.telemetry.gearState, 'DOWN', 'gear state should update directly from live gear packets');

    handler({ type: 'lights', data: { nav: true, beacon: true, strobe: false, landing: true, taxi: false } });
    assert.equal(flightStore.telemetry.lights.nav, true, 'nav light should update directly from live light packets');
    assert.equal(flightStore.telemetry.lights.beacon, true, 'beacon light should update directly from live light packets');
    assert.equal(flightStore.telemetry.lights.landing, true, 'landing light should update directly from live light packets');
  });

  await test('app message handler avoids duplicate Vue store writes for high-frequency telemetry', () => {
    const ingested = [];
    const displayCalls = [];
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(['ias', 'xwind', 'engines']),
      getSimconnectTelemetryConnected: () => true,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => true,
      markFlightTelemetryActive: () => {},
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {
        updateSpeedDisplay(payload, options) {
          displayCalls.push({ method: 'speed', payload, options });
        },
      },
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: { setFeedback() {} },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines(data, options) {
        displayCalls.push({ method: 'engines', payload: data, options });
      },
      flightStore: {
        ingestMessage(message) {
          ingested.push(message.type);
        },
        updateCrosswindDisplay() {
          throw new Error('xwind should be handled by the single ingest path only');
        },
      },
    });

    handler({ type: 'ias', value: 142 });
    handler({ type: 'xwind', value: 8 });
    handler({ type: 'engines', data: { count: 2, eng1Text: '31%', eng2Text: '32%' } });

    assert.deepEqual(ingested, ['ias', 'xwind', 'engines'], 'each high-frequency packet should enter the flight store once');
    assert.deepEqual(
      displayCalls,
      [
        { method: 'speed', payload: { ias: 142 }, options: { updateFlightStore: false } },
        { method: 'engines', payload: { count: 2, eng1Text: '31%', eng2Text: '32%' }, options: { updateFlightStore: false } },
      ],
      'legacy display adapters should keep non-store side effects without mutating Pinia again',
    );
  });

  await test('app message handler lazily resolves the Vue flight store for live telemetry', () => {
    setActivePinia(createPinia());
    const flightStore = useFlightStore();
    const handler = createAppMessageHandler({
      alertRef: () => {},
      LIVE_TELEMETRY_MESSAGE_TYPES: new Set(['gear', 'lights']),
      getSimconnectTelemetryConnected: () => false,
      setSimconnectTelemetryConnected: () => {},
      getWasSimconnectConnected: () => false,
      setWasSimconnectConnected: () => {},
      getHasSeenFlightTelemetry: () => false,
      markFlightTelemetryActive: () => {
        throw new Error('legacy telemetry gate should skip live handlers in this regression');
      },
      resetTelemetryDisplay: () => {},
      setFlightState: () => {},
      telemetryDisplay: {},
      appPreferences: {},
      autopilotPanel: {},
      aircraftControl: { setFeedback() {} },
      landingController: {},
      telemetryWarnings: {},
      statusIndicators: {},
      lvarInspector: {},
      appSettingsController: { apply() {} },
      updateEngines: () => {},
      flightStore: null,
      getFlightStore: () => flightStore,
    });

    handler({ type: 'gear', data: { nose: 1, left: 1, right: 1, parkingBrake: true } });
    assert.equal(flightStore.telemetry.gear.parkingBrake, true, 'parking brake should update when the store is resolved lazily');

    handler({ type: 'lights', data: { nav: true, beacon: false, strobe: true, landing: false, taxi: true } });
    assert.equal(flightStore.telemetry.lights.nav, true, 'nav light should update when the store is resolved lazily');
    assert.equal(flightStore.telemetry.lights.strobe, true, 'strobe light should update when the store is resolved lazily');
  });

  await test('mock landing runtime injects demo scenarios through an explicit entry-point handler bridge', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const button = documentRef.register(new FakeElement('demo-landing-btn', { tagName: 'BUTTON' }));
    const select = documentRef.register(new FakeElement('demo-landing-select', { tagName: 'SELECT', value: 'butter' }));
    documentRef.register(new FakeElement('demo-landing-bar'));

    const messages = [];
    const runtime = initMockLandingRuntime({
      documentRef,
      windowRef,
      getHandleMessage() {
        return (message) => {
          messages.push(message);
        };
      },
    });

    button.click();

    assert.equal(messages.length, 2, 'demo landing button should inject both stability and landing messages');
    assert.equal(messages[0].type, 'ultimateStabilityScore', 'demo landing should emit the stability payload first');
    assert.equal(messages[1].type, 'landing', 'demo landing should emit the landing payload second');
    assert.equal(messages[1].grade, 'PERFECT', 'selected demo scenario should control the injected landing payload');

    runtime.cleanup();
    button.click();
    assert.equal(messages.length, 2, 'cleanup should remove the demo landing click listener');
  });

  await test('cabin announcements runtime hydrates settings through explicit entry-point dependencies', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const statusStore = useStatusStore();

    const api = initCabinAnnouncementsRuntime({
      windowRef,
      statusStore,
      getAppSettings() {
        return {
          cabinAnnouncements: {
            enabled: true,
            style: 'concise',
          },
        };
      },
    });

    assert.equal(typeof api.enqueue, 'function', 'runtime should initialize and return the public PA API');
    assert.equal(statusStore.cabinAnnouncements.enabled, true, 'PA runtime should hydrate enabled settings into the status store');
    assert.equal(statusStore.cabinAnnouncements.muted, false, 'PA runtime should hydrate as unmuted by default');

    api.setMuted(true);
    assert.equal(statusStore.cabinAnnouncements.muted, true, 'public PA API mute should still update store-backed mute state');
    assert.equal(windowRef.listeners.get('beforeunload')?.size, 1, 'PA runtime should register one beforeunload cleanup listener');

    api.cleanup();
    assert.equal(windowRef.listeners.get('beforeunload')?.size || 0, 0, 'PA runtime cleanup should remove the beforeunload listener');
    assert.equal(statusStore.cabinAnnouncements.enabled, false, 'PA runtime cleanup should reset store-backed availability');
  });

  await test('timeline PFD controller publishes visible replay state through the timeline store', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const timelineStore = useTimelineStore();
    const orientationWrapEl = new FakeElement('timeline-pfd');
    const pfdHdgTape = new FakeElement('pfd-hdg-tape');
    const pfdSpdTape = new FakeElement('pfd-spd-tape');
    const pfdAltTape = new FakeElement('pfd-alt-tape');
    const pfdPitchMarks = new FakeElement('pfd-adi-pitchmarks');

    pfdHdgTape.parentElement = { clientWidth: 300 };
    pfdSpdTape.parentElement = { clientHeight: 180 };
    pfdAltTape.parentElement = { clientHeight: 180 };

    const timelinePfd = createPFD({
      documentRef,
      timelineStore,
      orientationWrapEl,
      pfdHdgTape,
      pfdSpdTape,
      pfdAltTape,
      pfdPitchMarks,
    });

    timelinePfd.update({
      headingDeg: 87.2,
      pitchDeg: 3.4,
      rollDeg: -1.2,
      iasKts: 141.8,
      altFt: 3450.2,
    });

    assert.equal(timelineStore.pfdOverlayOpacity, '1', 'PFD controller should expose overlay opacity through the store');
    assert.equal(timelineStore.pfdHeadingDisplay, '087', 'PFD controller should expose heading text through the store');
    assert.equal(timelineStore.pfdSpeedDisplay, '142', 'PFD controller should expose speed text through the store');
    assert.equal(timelineStore.pfdAltitudeDisplay, '3,450', 'PFD controller should expose altitude text through the store');
    assert.equal(timelineStore.pfdPitchDisplay, '3', 'PFD controller should expose pitch text through the store');
    assert.equal(timelineStore.pfdRollDisplay, '-1', 'PFD controller should expose roll text through the store');
    assert.match(timelineStore.pfdAdiTransform, /translateY\(13\.6px\)/, 'PFD controller should expose ADI transform through the store');
    assert.equal(pfdHdgTape.children.length > 0, true, 'PFD controller should still build the hidden heading tape markup');
    assert.match(pfdHdgTape.style.transform, /translateX/, 'PFD controller should still drive hidden tape transforms imperatively');

    timelinePfd.destroy();
    assert.equal(timelineStore.pfdHeadingDisplay, '---', 'destroy should reset the store-backed PFD readouts');
    assert.equal(timelineStore.pfdOverlayOpacity, '0.4', 'destroy should reset the store-backed PFD opacity');
    assert.equal(timelineStore.pfdScale, '1', 'destroy should leave the overlay scale at its default store value');
  });

  await test('timeline PFD overlay fitter publishes collapsed and scaled layout state through the timeline store', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const timelineStore = useTimelineStore();
    const pfdMapWrap = { clientHeight: 120 };
    const pfdOverlay = new FakeElement('timeline-pfd-overlay');
    pfdOverlay.offsetHeight = 300;
    pfdOverlay.closest = () => pfdMapWrap;

    const fitter = attachTimelinePfdOverlayFitter({
      pfdOverlay,
      timelineStore,
      windowRef,
      ResizeObserverRef: null,
    });

    assert.equal(timelineStore.pfdScale, '0.550', 'overlay fitter should clamp the store-backed scale when the map wrap is short');

    timelineStore.setPfdCollapsed(true);
    await nextTick();
    assert.equal(timelineStore.pfdScale, '1', 'collapsed overlay state should restore a full-size scale in the store');

    timelineStore.setPfdCollapsed(false);
    pfdMapWrap.clientHeight = 260;
    windowRef.dispatchEvent({ type: 'resize' });
    assert.equal(timelineStore.pfdScale, '0.813', 'resize fitting should continue publishing scale through the store');

    fitter.destroy();
    assert.equal(timelineStore.pfdScale, '1', 'destroy should reset the store-backed overlay scale');
  });

  console.log('\n--- aircraft controls ---\n');
  await test('aircraft control controller and autopilot panel delegate visible state and runtime-bound commands into the Vue store', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const aircraftControlsStore = useAircraftControlsStore();
    const commandButton = new FakeElement('ctrl-gear-up-btn', { tagName: 'BUTTON' });
    const modeButton = new FakeElement('ap-master-btn', { tagName: 'BUTTON' });
    documentRef.setQuerySelectorAll(AIRCRAFT_CONTROL_BUTTON_SELECTOR, [commandButton, modeButton]);

    const sent = [];
    const toasts = [];
    let aircraftControlNowMs = 1000;
    const aircraftControlTimers = [];
    let authorizationScope = 'read-only';
    const ws = {
      readyState: 1,
    };

    assert.throws(
      () => createAircraftControlController({ getWs: () => ws }),
      /Aircraft controls store is required/,
      'aircraft control controller should fail fast without the injected controls store',
    );
    assert.throws(
      () => createAutopilotPanel({ aircraftControl: { updateAvailability() {} } }),
      /Aircraft controls store is required/,
      'autopilot panel should fail fast without the injected controls store',
    );

    const noToastController = createAircraftControlController({
      WebSocketRef: { OPEN: 1 },
      getWs: () => ({ readyState: 0 }),
      getWsSend: () => (payload) => {
        sent.push(payload);
      },
      getSimconnectConnected: () => true,
      aircraftControlsStore,
    });
    assert.doesNotThrow(
      () => noToastController.send({ control: 'gear', operation: 'down' }),
      'aircraft control unavailable path should not require a toast dependency',
    );
    assert.match(aircraftControlsStore.feedback.routeText, /Backend connection unavailable/, 'unavailable control feedback should still update without toast dependency');
    assert.doesNotThrow(
      () => noToastController.handleResult({
        ok: false,
        request: { control: 'gear', operation: 'down' },
        error: 'No provider',
      }),
      'aircraft control result handling should not require a toast dependency',
    );
    assert.match(aircraftControlsStore.feedback.routeText, /No provider/, 'failed result feedback should still update without toast dependency');
    aircraftControlsStore.resetFeedback();
    aircraftControlsStore.resetPendingCommands();

    const controller = createAircraftControlController({
      documentRef,
      WebSocketRef: { OPEN: 1 },
      getWs: () => ws,
      getWsSend: () => (payload) => {
        sent.push(payload);
      },
      getAuthorizationScope: () => authorizationScope,
      getSimconnectConnected: () => true,
      aircraftControlsStore,
      showToast(kind, title, message) {
        toasts.push({ kind, title, message });
      },
      now: () => aircraftControlNowMs,
      setTimeoutRef(callback, delayMs) {
        const timer = { callback, delayMs, cancelled: false };
        aircraftControlTimers.push(timer);
        return timer;
      },
      clearTimeoutRef(timer) {
        if (timer) timer.cancelled = true;
      },
    });

    const autopilotPanel = createAutopilotPanel({
      documentRef,
      aircraftControl: controller,
      aircraftControlsStore,
      getCurrentState: () => ({ ias: 141, hdg: 92, alt: 11050, vs: -650 }),
      now: () => aircraftControlNowMs,
    });
    autopilotPanel.bindControls();
    controller.setActiveProfileToken({
      _profileKey: 'bundled/msfs/pmdg-777',
      profileRevision: 3,
    });

    controller.updateAvailability();
    assert.equal(aircraftControlsStore.availability.enabled, false, 'read-only clients should not present aircraft controls as ready');
    assert.match(aircraftControlsStore.availability.reason, /read-only/, 'read-only clients should see the missing capability in availability');
    const sentBeforePairing = sent.length;
    assert.equal(
      controller.send({ control: 'gear', operation: 'down' }),
      false,
      'read-only clients should fail closed before attempting an aircraft control send',
    );
    assert.equal(sent.length, sentBeforePairing, 'read-only control attempts should not reach the websocket bridge');
    assert.equal(toasts.at(-1)?.kind, 'error', 'read-only control attempts should explain the unavailable capability');
    assert.match(toasts.at(-1)?.message || '', /choose Phone, then scan the QR shown there/, 'read-only control attempts should point directly to the single PC pairing flow');

    authorizationScope = 'aircraft-control';
    controller.updateAvailability();
    assert.equal(aircraftControlsStore.availability.enabled, true, 'availability should flow into the Vue store');
    assert.equal(commandButton.disabled, false, 'available control buttons should remain enabled');
    assert.equal(aircraftControlsStore.commandActionBound, true, 'autopilot runtime should bind the Vue-owned control action bridge');

    autopilotPanel.update({
      master: true,
      athrArmed: true,
      fdActive: true,
      spdHold: true,
      hdgHold: false,
      altHold: true,
      vsHold: false,
      navHold: true,
      apprHold: true,
      lvlChgHold: false,
      spdTarget: 245,
      hdgTarget: 87,
      altTarget: 12000,
      vsTarget: -700,
    });
    assert.equal(aircraftControlsStore.autopilot.master, true, 'autopilot messages should hydrate the store');
    assert.equal(aircraftControlsStore.autopilot.athrArmed, true, 'autothrottle armed state should hydrate the store');
    assert.equal(aircraftControlsStore.autopilot.spdDisplay, '245', 'selector values should hydrate the store');
    assert.equal(aircraftControlsStore.autopilot.hdgDisplay, '087', 'heading display should hydrate the store');
    assert.equal(aircraftControlsStore.autopilot.locHold, true, 'LOC hold should honor navHold fallback');

    assert.equal(
      await aircraftControlsStore.requestControlCommand(
        { type: 'selector-adjust', mode: 'hdg', action: 'inc10' },
        { pendingKey: 'selector-adjust:hdg:inc10' },
      ),
      true,
      'Vue-owned control commands should delegate back through the injected runtime action',
    );
    assert.deepEqual(
      sent[0],
      {
        type: 'executeAircraftControl',
        requestId: sent[0].requestId,
        profileKey: 'bundled/msfs/pmdg-777',
        profileRevision: 3,
        control: 'autopilot',
        target: 'heading',
        operation: 'set',
        value: 97,
      },
      'Vue-owned selector adjustments should resolve against the current MCP values before sending',
    );
    assert.equal(aircraftControlsStore.isCommandPending('selector-adjust:hdg:inc10'), true, 'Vue-owned control commands should mark the matching pending key in the store');

    controller.send(
      { control: 'autopilot', target: 'master', operation: 'toggle' },
      { pendingKey: 'preset:autopilotMasterToggle', busyLabel: 'Toggling...' },
    );
    assert.deepEqual(
      sent[1],
      {
        type: 'executeAircraftControl',
        requestId: sent[1].requestId,
        profileKey: 'bundled/msfs/pmdg-777',
        profileRevision: 3,
        control: 'autopilot',
        target: 'master',
        operation: 'toggle',
      },
      'control sends should go through the websocket bridge with a generated request id',
    );
    assert.equal(aircraftControlsStore.isCommandPending('preset:autopilotMasterToggle'), true, 'direct control sends should also mark pending state in the store');
    assert.equal(aircraftControlsStore.feedback.actionText, 'AP master toggle', 'control sends should update action feedback in the store');
    assert.match(aircraftControlsStore.feedback.routeText, /Sending control request/, 'control sends should update route feedback in the store');

    controller.handleResult({
      requestId: sent[1].requestId,
      ok: true,
      resolvedBy: 'profile',
      action: { type: 'key-event', name: 'AP_MASTER' },
      backendSource: 'SimConnect',
      profileKey: 'bundled/msfs/pmdg-777',
    });
    assert.equal(aircraftControlsStore.isCommandPending('preset:autopilotMasterToggle'), false, 'control results should clear store-backed pending state for the completed command');
    assert.equal(aircraftControlsStore.feedback.profileText, 'bundled/msfs/pmdg-777', 'successful control results should update profile feedback');
    assert.match(aircraftControlsStore.feedback.routeText, /Profile override/, 'successful control results should update route feedback');
    assert.equal(toasts.at(-1).kind, 'success', 'successful control results should show a success toast');

    controller.handleResult({
      ok: true,
      request: { control: 'aircraft-specific', operation: 'execute', actionId: 'lights.beacon.on' },
      resolvedBy: 'profile',
      action: { type: 'aircraft-integration', name: 'fenix-a32x' },
      transportMode: 'direct-lvar',
      backendSource: 'rust-simconnect-sidecar',
      profileKey: 'bundled/msfs/fenix-a320',
    });
    assert.match(aircraftControlsStore.feedback.routeText, /Direct LVAR fallback/, 'successful fallback writes should identify their transport for testing');

    autopilotPanel.update({
      master: false,
      apReliable: false,
      hdgHold: false,
      altHold: false,
      altTarget: 30800,
    });
    assert.equal(aircraftControlsStore.autopilot.master, null, 'unreliable AP readback should not render generic false as off');
    assert.equal(aircraftControlsStore.autopilot.hdgHold, null, 'unreliable AP readback should mask AP mode booleans');
    assert.equal(aircraftControlsStore.autopilot.altDisplay, '30,800', 'unreliable AP engagement should not hide selector windows');

    controller.send(
      { control: 'autopilot', target: 'master', operation: 'toggle' },
      { pendingKey: 'preset:autopilotMasterToggle' },
    );
    controller.handleResult({
      requestId: sent[2].requestId,
      ok: true,
      request: { control: 'autopilot', target: 'master', operation: 'toggle' },
      resolvedBy: 'profile',
      action: { type: 'key-event', name: 'AP_MASTER' },
      backendSource: 'SimConnect',
      profileKey: 'bundled/msfs/inibuilds-tristar',
    });
    assert.equal(aircraftControlsStore.autopilot.master, null, 'successful AP master toggle should not invent state when readback is unreliable');

    autopilotPanel.update({
      master: false,
      apReliable: false,
      altTarget: 30900,
    });
    assert.equal(aircraftControlsStore.autopilot.master, null, 'unreliable AP telemetry should keep AP master unknown');
    assert.equal(aircraftControlsStore.autopilot.altDisplay, '30,900', 'selector windows should continue updating while AP state is unknown');

    autopilotPanel.update({
      master: false,
      apReliable: true,
    });
    assert.equal(aircraftControlsStore.autopilot.master, false, 'reliable AP telemetry should still hydrate AP master state');

    autopilotPanel.update({});
    assert.equal(aircraftControlsStore.autopilot.vsDisplay, '----', 'blank selected V/S should render as unavailable instead of live aircraft V/S');
    assert.equal(
      await aircraftControlsStore.requestControlCommand(
        { type: 'selector-adjust', mode: 'vs', action: 'inc100' },
        { pendingKey: 'selector-adjust:vs:inc100' },
      ),
      true,
      'blank V/S adjustments should still send a selector write',
    );
    assert.equal(sent.at(-1).target, 'verticalSpeed', 'blank V/S adjustment should target selected vertical speed');
    assert.equal(sent.at(-1).value, 100, 'blank V/S adjustment should start from zero, not live aircraft V/S');

    controller.clearPendingRequests('Connection lost before control request completed.');
    assert.equal(aircraftControlsStore.isCommandPending('selector-adjust:hdg:inc10'), false, 'clearing pending requests should clear any remaining store-backed pending state');

    controller.clearProfileToken('Simulator disconnected. Waiting for profile refresh.');
    assert.equal(controller.updateAvailability().enabled, false, 'clearing only the profile token should block writes until profile refresh');
    assert.equal(aircraftControlsStore.availability.reason, 'Waiting for current aircraft profile.');
    const sentBeforeProfileRefresh = sent.length;
    assert.equal(
      controller.send({ control: 'gear', operation: 'down' }),
      false,
      'control sends should fail closed while the active profile token is absent',
    );
    assert.equal(sent.length, sentBeforeProfileRefresh, 'blocked sends should not reach the websocket bridge');

    controller.setActiveProfileToken({
      _profileKey: 'bundled/msfs/pmdg-777',
      profileRevision: 4,
    });
    assert.equal(controller.updateAvailability().enabled, true, 'a fresh profile token should restore write availability');

    const exactTargetIndex = sent.length;
    assert.equal(
      await aircraftControlsStore.requestControlCommand({ type: 'selector-set', mode: 'alt', value: 12300 }),
      true,
      'the focused target editor should delegate one exact bounded target through the shared controller',
    );
    assert.deepEqual(
      sent[exactTargetIndex],
      {
        type: 'executeAircraftControl',
        requestId: sent[exactTargetIndex].requestId,
        profileKey: 'bundled/msfs/pmdg-777',
        profileRevision: 4,
        control: 'autopilot',
        target: 'altitude',
        operation: 'set',
        value: 12300,
      },
      'focused tuning must preserve the profile token and use the existing autopilot target request',
    );
    assert.equal(aircraftControlsStore.feedback.status, 'sending', 'focused target feedback should enter the sending state');
    assert.equal(aircraftControlsStore.feedback.commandKey, 'selector-set:alt', 'focused target feedback should identify its physical selector');
    assert.equal(aircraftControlsStore.isCommandPending('selector-set:alt'), true, 'focused target should remain pending until its result');
    controller.handleResult({
      requestId: sent[exactTargetIndex].requestId,
      ok: true,
      resolvedBy: 'profile',
      action: { type: 'key-event', name: 'AP_ALT_VAR_SET_ENGLISH' },
      backendSource: 'SimConnect',
      profileKey: 'bundled/msfs/pmdg-777',
    });
    assert.equal(aircraftControlsStore.feedback.status, 'sent', 'accepted target feedback should distinguish sent from live readback confirmation');
    assert.equal(aircraftControlsStore.isCommandPending('selector-set:alt'), false, 'accepted target should clear its focused-editor pending state');
    const sentBeforeInvalidExactTarget = sent.length;
    assert.equal(
      await aircraftControlsStore.requestControlCommand({ type: 'selector-set', mode: 'alt', value: 12345 }),
      false,
      'off-step focused targets should fail before reaching the websocket controller',
    );
    assert.equal(sent.length, sentBeforeInvalidExactTarget, 'invalid focused targets must not emit a websocket write');

    aircraftControlsStore.applyControlCapabilities({
      surface: {
        parkingBrake: true,
        spoilersPosition: true,
        spoilersArm: true,
      },
      lights: {
        landing: true,
      },
    });
    const genericBaselineCommands = [
      {
        command: { type: 'preset', id: 'parkingBrakeSet' },
        request: { control: 'parkingBrake', operation: 'set', value: true },
      },
      {
        command: { type: 'preset', id: 'spoilersExtend' },
        request: { control: 'spoilers', operation: 'set', value: 16383 },
      },
      {
        command: { type: 'preset', id: 'spoilersArm' },
        request: { control: 'spoilers', operation: 'arm' },
      },
      {
        command: { type: 'light-set', light: 'landing', value: false },
        request: { control: 'lights', target: 'landing', operation: 'set', value: false },
      },
    ];
    for (const { command, request } of genericBaselineCommands) {
      const requestIndex = sent.length;
      assert.equal(
        await aircraftControlsStore.requestControlCommand(command),
        true,
        `${command.id || command.light} should use the bounded generic control command path`,
      );
      assert.deepEqual(
        sent[requestIndex],
        {
          type: 'executeAircraftControl',
          requestId: sent[requestIndex].requestId,
          profileKey: 'bundled/msfs/pmdg-777',
          profileRevision: 4,
          ...request,
        },
        `${command.id || command.light} should map to one fixed logical request`,
      );
    }
    assert.equal(
      await aircraftControlsStore.requestControlCommand({ type: 'light-set', light: 'logo', value: true }),
      false,
      'unknown light names should fail before reaching the websocket controller',
    );
    controller.clearPendingRequests();

    authorizationScope = 'full-control';
    assert.equal(controller.updateAvailability().enabled, true, 'a full-control session should retain aircraft-control availability');

    const protectedEnvelopeIndex = sent.length;
    controller.send({
      type: 'forged-message-type',
      requestId: 'forged-request-id',
      profileKey: 'local/msfs/other-aircraft',
      profileRevision: 999,
      control: 'aircraft-specific',
      operation: 'execute',
      actionId: 'apu.start',
    });
    assert.equal(sent[protectedEnvelopeIndex].type, 'executeAircraftControl', 'callers must not replace the fixed control message type');
    assert.notEqual(sent[protectedEnvelopeIndex].requestId, 'forged-request-id', 'callers must not replace the generated request ID');
    assert.equal(sent[protectedEnvelopeIndex].profileKey, 'bundled/msfs/pmdg-777', 'callers must not replace the active profile key');
    assert.equal(sent[protectedEnvelopeIndex].profileRevision, 4, 'callers must not replace the active profile revision');
    assert.equal(sent[protectedEnvelopeIndex].actionId, 'apu.start', 'logical aircraft action IDs should pass through the central controller');

    const positionPendingKey = 'aircraft-specific-group:lights.position';
    const positionRequestIndex = sent.length;
    controller.send({
      control: 'aircraft-specific',
      operation: 'execute',
      actionId: 'lights.position.strobeSteady',
    }, {
      pendingKey: positionPendingKey,
    });
    assert.equal(
      aircraftControlsStore.isCommandPending(positionPendingKey),
      true,
      'an aircraft-specific action should mark its shared cockpit-control group pending',
    );
    controller.handleResult({
      requestId: sent[positionRequestIndex].requestId,
      ok: false,
      request: sent[positionRequestIndex],
      code: 'readback-timeout',
      error: 'Aircraft readback did not confirm the requested position.',
    });
    assert.equal(
      aircraftControlsStore.isCommandPending(positionPendingKey),
      false,
      'an aircraft-specific result should clear the shared cockpit-control group pending state',
    );

    const pulseRequests = {
      autothrottle: { target: 'autothrottle', operation: 'toggle' },
      verticalSpeedHold: { target: 'verticalSpeedHold', operation: 'toggle' },
      altitudeHold: { target: 'altitudeHold', operation: 'toggle' },
      machHold: { target: 'machHold', operation: 'toggle' },
      headingHold: { target: 'headingHold', operation: 'toggle' },
      flightDirector: { target: 'flightDirector', operation: 'toggle' },
      apMaster: { target: 'master', operation: 'toggle' },
      apDisconnect: { target: 'master', operation: 'set', value: false },
      app: { target: 'app', operation: 'toggle' },
      loc: { target: 'loc', operation: 'toggle' },
      nav1: { target: 'nav1', operation: 'toggle' },
      ins: { target: 'ins', operation: 'toggle' },
      backcourse: { target: 'backcourse', operation: 'toggle' },
    };
    aircraftControlsStore.applyControlCapabilities({
      autopilotPulse: Object.fromEntries(Object.keys(pulseRequests).map((commandId) => [commandId, true])),
    });

    for (const [commandId, expectedRequest] of Object.entries(pulseRequests)) {
      const command = { type: 'autopilot-pulse', id: commandId };
      const sentBeforePulse = sent.length;
      assert.equal(
        await aircraftControlsStore.requestControlCommand(command),
        true,
        `${commandId} should resolve through the Vue-owned autopilot pulse command path`,
      );
      assert.deepEqual(
        sent[sentBeforePulse],
        {
          type: 'executeAircraftControl',
          requestId: sent[sentBeforePulse].requestId,
          profileKey: 'bundled/msfs/pmdg-777',
          profileRevision: 4,
          control: 'autopilot',
          ...expectedRequest,
        },
        `${commandId} should map to its exact bounded autopilot request`,
      );
      assert.equal(
        aircraftControlsStore.isCommandPending(command),
        true,
        `${commandId} should reserve its command-specific pending key`,
      );
      assert.equal(
        aircraftControlsStore.isCommandDisabled(command),
        true,
        `${commandId} should block a duplicate UI dispatch while pending`,
      );
      assert.equal(
        await aircraftControlsStore.requestControlCommand(command),
        false,
        `${commandId} duplicate dispatch should fail closed before reaching the controller`,
      );
      assert.equal(sent.length, sentBeforePulse + 1, `${commandId} duplicate must not reach the websocket bridge`);
      controller.handleResult({
        requestId: sent[sentBeforePulse].requestId,
        ok: true,
        resolvedBy: 'profile',
        action: { type: 'key-event', name: `TRISTAR_${commandId.toUpperCase()}` },
        backendSource: 'SimConnect',
        profileKey: 'bundled/msfs/inibuilds-tristar',
      });
      assert.equal(
        aircraftControlsStore.isCommandPending(command),
        true,
        `${commandId} result should preserve pending state through the physical-button cooldown`,
      );
      assert.equal(
        aircraftControlsStore.isCommandDisabled(command),
        true,
        `${commandId} should stay disabled until the physical-button cooldown ends`,
      );
      const cooldownTimer = aircraftControlTimers.shift();
      assert.ok(cooldownTimer, `${commandId} should schedule a minimum pending window`);
      assert.equal(cooldownTimer.delayMs, 600, `${commandId} should use the bounded 600 ms pulse cooldown`);
      aircraftControlNowMs += cooldownTimer.delayMs;
      cooldownTimer.callback();
      assert.equal(
        aircraftControlsStore.isCommandPending(command),
        false,
        `${commandId} should become available when the cooldown window ends`,
      );
    }

    assert.equal(
      aircraftControlsStore.resolvePendingKey({ type: 'autopilot-pulse', id: 'apMaster' }),
      aircraftControlsStore.resolvePendingKey({ type: 'autopilot-pulse', id: 'apDisconnect' }),
      'AP A and AP DISC should share one physical-control pending key',
    );

    const sharedApPendingKey = aircraftControlsStore.resolvePendingKey({ type: 'autopilot-pulse', id: 'apMaster' });
    const oldProfileRequestIndex = sent.length;
    assert.equal(
      await aircraftControlsStore.requestControlCommand({ type: 'autopilot-pulse', id: 'apMaster' }),
      true,
      'old profile should be able to reserve the shared AP key',
    );
    controller.resetProfileState('Aircraft changed. Waiting for profile capabilities.');
    assert.equal(aircraftControlsStore.isCommandPending(sharedApPendingKey), false, 'profile reset should release old pending ownership');

    controller.setActiveProfileToken({
      _profileKey: 'bundled/msfs/inibuilds-tristar',
      profileRevision: 5,
    });
    controller.applyControlCapabilities({ autopilotPulse: { apMaster: true, apDisconnect: true } });
    controller.updateAvailability();
    aircraftControlNowMs += 600;
    const newProfileRequestIndex = sent.length;
    assert.equal(
      await aircraftControlsStore.requestControlCommand({ type: 'autopilot-pulse', id: 'apDisconnect' }),
      true,
      'new profile should acquire the same physical AP key after reset',
    );
    controller.handleResult({
      requestId: sent[oldProfileRequestIndex].requestId,
      ok: true,
      resolvedBy: 'profile',
      action: { type: 'key-event', name: 'AP_MASTER' },
      profileKey: 'bundled/msfs/inibuilds-tristar',
    });
    assert.equal(aircraftControlsStore.isCommandPending(sharedApPendingKey), true, 'late old-profile result must not clear the new command');

    controller.handleResult({
      requestId: sent[newProfileRequestIndex].requestId,
      ok: true,
      resolvedBy: 'profile',
      action: { type: 'key-event', name: 'AUTOPILOT_OFF' },
      profileKey: 'bundled/msfs/inibuilds-tristar',
    });
    const staleCooldownTimer = aircraftControlTimers.shift();
    assert.ok(staleCooldownTimer, 'new-profile acknowledgement should schedule its cooldown clear');
    controller.resetProfileState('Aircraft changed again.');
    assert.equal(staleCooldownTimer.cancelled, true, 'profile reset should cancel controller-owned cooldown timers');

    controller.setActiveProfileToken({
      _profileKey: 'bundled/msfs/inibuilds-tristar',
      profileRevision: 6,
    });
    controller.applyControlCapabilities({ autopilotPulse: { apMaster: true, apDisconnect: true } });
    controller.updateAvailability();
    aircraftControlNowMs += 600;
    const latestRequestIndex = sent.length;
    assert.equal(
      await aircraftControlsStore.requestControlCommand({ type: 'autopilot-pulse', id: 'apMaster' }),
      true,
      'latest profile should acquire the shared AP key',
    );
    staleCooldownTimer.callback();
    assert.equal(aircraftControlsStore.isCommandPending(sharedApPendingKey), true, 'stale cancelled timer must not clear a later profile command');
    controller.handleResult({
      requestId: sent[latestRequestIndex].requestId,
      ok: true,
      resolvedBy: 'profile',
      action: { type: 'key-event', name: 'AP_MASTER' },
      profileKey: 'bundled/msfs/inibuilds-tristar',
    });
    const latestCooldownTimer = aircraftControlTimers.shift();
    aircraftControlNowMs += latestCooldownTimer.delayMs;
    latestCooldownTimer.callback();
    assert.equal(aircraftControlsStore.isCommandPending(sharedApPendingKey), false, 'latest command should clear only through its own cooldown timer');

    autopilotPanel.resetState();
    assert.equal(aircraftControlsStore.autopilot.master, null, 'autopilot reset should clear the store-backed AP state to unknown');
    assert.equal(aircraftControlsStore.autopilot.spdDisplay, '---', 'autopilot reset should restore default selector values');
  });

  await test('aircraft control results require live request ownership across reset and replay', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const aircraftControlsStore = useAircraftControlsStore();
    const sent = [];
    const toasts = [];
    const controller = createAircraftControlController({
      WebSocketRef: { OPEN: 1 },
      getWs: () => ({ readyState: 1 }),
      getWsSend: () => (payload) => sent.push(payload),
      getAuthorizationScope: () => 'aircraft-control',
      getSimconnectConnected: () => true,
      aircraftControlsStore,
      showToast(kind, title, message) {
        toasts.push({ kind, title, message });
      },
    });
    const pendingKey = 'preset:autopilotMasterToggle';

    controller.setActiveProfileToken({
      _profileKey: 'bundled/msfs/inibuilds-tristar',
      profileRevision: 1,
    });
    controller.send(
      { control: 'autopilot', target: 'master', operation: 'toggle' },
      { pendingKey },
    );
    const staleRequestId = sent.at(-1).requestId;

    controller.resetProfileState('Aircraft changed. Waiting for profile capabilities.');
    controller.setActiveProfileToken({
      _profileKey: 'bundled/msfs/inibuilds-tristar',
      profileRevision: 2,
    });
    controller.updateAvailability();
    controller.send(
      { control: 'autopilot', target: 'master', operation: 'set', value: false },
      { pendingKey },
    );
    const currentRequestId = sent.at(-1).requestId;
    const feedbackBeforeRejectedResults = { ...aircraftControlsStore.feedback };
    const pendingBeforeRejectedResults = { ...aircraftControlsStore.pendingCommands };
    const toastCountBeforeRejectedResults = toasts.length;

    controller.handleResult({
      requestId: staleRequestId,
      ok: true,
      resolvedBy: 'profile',
      action: { type: 'key-event', name: 'AP_MASTER' },
      profileKey: 'bundled/msfs/inibuilds-tristar',
    });
    assert.deepEqual(
      aircraftControlsStore.feedback,
      feedbackBeforeRejectedResults,
      'a late result invalidated by profile reset must not overwrite current request feedback',
    );
    assert.deepEqual(
      aircraftControlsStore.pendingCommands,
      pendingBeforeRejectedResults,
      'a late result invalidated by profile reset must not mutate current pending ownership',
    );
    assert.equal(toasts.length, toastCountBeforeRejectedResults, 'a late result invalidated by profile reset must not emit a toast');

    controller.handleResult({
      requestId: 'ctrl-unknown-result',
      ok: false,
      code: 'unknown',
      error: 'This unowned result must be ignored.',
    });
    assert.deepEqual(aircraftControlsStore.feedback, feedbackBeforeRejectedResults, 'an unknown request ID must fail closed without feedback');
    assert.deepEqual(aircraftControlsStore.pendingCommands, pendingBeforeRejectedResults, 'an unknown request ID must fail closed without pending effects');
    assert.equal(toasts.length, toastCountBeforeRejectedResults, 'an unknown request ID must fail closed without a toast');

    controller.handleResult({
      requestId: currentRequestId,
      ok: true,
      resolvedBy: 'profile',
      action: { type: 'key-event', name: 'AUTOPILOT_OFF' },
      profileKey: 'bundled/msfs/inibuilds-tristar',
    });
    assert.equal(aircraftControlsStore.isCommandPending(pendingKey), false, 'the currently owned result should still complete normally');
    assert.equal(toasts.at(-1)?.kind, 'success', 'the currently owned result should still emit its success toast');

    controller.send(
      { control: 'autopilot', target: 'master', operation: 'toggle' },
      { pendingKey },
    );
    const feedbackBeforeDuplicate = { ...aircraftControlsStore.feedback };
    const pendingBeforeDuplicate = { ...aircraftControlsStore.pendingCommands };
    const toastCountBeforeDuplicate = toasts.length;
    controller.handleResult({
      requestId: currentRequestId,
      ok: false,
      code: 'duplicate',
      error: 'A replayed result must be ignored.',
    });
    assert.deepEqual(aircraftControlsStore.feedback, feedbackBeforeDuplicate, 'a consumed request ID must not overwrite newer feedback');
    assert.deepEqual(aircraftControlsStore.pendingCommands, pendingBeforeDuplicate, 'a consumed request ID must not clear a newer pending command');
    assert.equal(toasts.length, toastCountBeforeDuplicate, 'a consumed request ID must not emit a duplicate toast');

    controller.clearPendingRequests();
  });

  console.log('\n--- status indicators ---\n');
  await test('assists indicator delegates active assist state to the status store', () => {
    const documentRef = new FakeDocument();
    setActivePinia(createPinia());
    const statusStore = useStatusStore();

    const controller = createStatusIndicatorsController({
      $: (id) => documentRef.getElementById(id),
      documentRef,
      statusStore,
    });

    controller.updateAssistsIndicator({
      landingAssist: true,
      unlimitedFuel: true,
      slewActive: false,
    });

    assert.equal(statusStore.assistsVisible, true, 'active assists should show the Vue indicator');
    assert.equal(statusStore.activeAssistCount, 2, 'active assist count should be store-backed');
    assert.deepEqual(
      statusStore.activeAssistCategories.flatMap((category) => category.items.map((item) => item.name)),
      ['Landing Assist', 'Unlimited Fuel'],
      'active assist labels should be derived by the store',
    );
  });

  await test('recording indicator delegates recording state to the status store', () => {
    const documentRef = new FakeDocument();
    setActivePinia(createPinia());
    const statusStore = useStatusStore();

    const controller = createStatusIndicatorsController({
      $: (id) => documentRef.getElementById(id),
      documentRef,
      statusStore,
    });

    controller.updateRecordingIndicator({
      status: 'recording',
      filePath: 'C:/Flights/active-flight.csv',
    });

    assert.equal(statusStore.recordingVisible, true, 'recording should show the Vue indicator');
    assert.equal(statusStore.recordingBadgeLabel, 'REC', 'recording badge should be store-backed');
    assert.equal(statusStore.recordingDetail, 'C:/Flights/active-flight.csv', 'recording path should be store-backed');

    controller.updateRecordingIndicator({
      status: 'failed',
      error: 'Failed to start recording',
    });

    assert.equal(statusStore.recordingFailed, true, 'recording failures should use the warning state');
    assert.equal(statusStore.recordingBadgeLabel, 'NO REC', 'failure badge should be store-backed');
    assert.equal(statusStore.recordingDetail, 'Failed to start recording', 'failure copy should be store-backed');

    controller.updateRecordingIndicator({ status: 'stopped' });
    assert.equal(statusStore.recordingVisible, false, 'stopped recording should hide the Vue indicator');
  });

  await test('surface indicator delegates ground surface state to the status store', () => {
    const documentRef = new FakeDocument();
    setActivePinia(createPinia());
    const statusStore = useStatusStore();

    const controller = createStatusIndicatorsController({
      $: (id) => documentRef.getElementById(id),
      documentRef,
      statusStore,
    });

    controller.updateSurfaceIndicator({
      onGround: true,
      name: 'WATER',
      class: 'WATER',
      runwayLike: false,
    });

    assert.equal(statusStore.surfaceVisible, true, 'ground surface should show the Vue indicator');
    assert.equal(statusStore.surfaceLabel, 'WATER', 'surface label should be store-backed');
    assert.match(statusStore.surfaceToneClass, /red/, 'non-runway surfaces should use danger tone classes');

    controller.updateSurfaceIndicator({ onGround: false });
    assert.equal(statusStore.surfaceVisible, false, 'airborne surface state should hide the Vue indicator');
  });

  await test('VRE sampling indicator surfaces active band and reason', () => {
    const documentRef = new FakeDocument();
    setActivePinia(createPinia());
    const statusStore = useStatusStore();

    const controller = createStatusIndicatorsController({
      $: (id) => documentRef.getElementById(id),
      documentRef,
      statusStore,
    });

    controller.updateVreSamplingIndicator({
      active: true,
      band: 'HIGH_FIDELITY',
      rateHz: 10,
      shouldSample: false,
      reason: 'ground_proximity,vs_magnitude',
      phase: 'APPROACH',
      raFt: 240,
      vsFpm: -720,
      intervalMs: 100,
      nextSampleInMs: 40,
      ultraFidelityDisabled: false,
      ultraFidelityTimeRemaining: 59000,
      ultraFidelitySamplesRemaining: 9900,
    });

    assert.equal(statusStore.vreSamplingVisible, true, 'active sampling should show the Vue indicator');
    assert.match(statusStore.vreSamplingSummaryLabel, /VRE HIGH 10 Hz/);
    assert.match(statusStore.vreSamplingReasonLabel, /ground proximity/);
    assert.match(statusStore.vreSamplingDecisionLabel, /waiting 40 ms/);
    assert.match(statusStore.vreSamplingLastLabel, /APPROACH RA 240 ft VS -720 fpm/);

    controller.updateVreSamplingIndicator({ active: false });
    assert.equal(statusStore.vreSamplingVisible, false, 'inactive sampling should hide the Vue indicator');
  });

  console.log('\n--- telemetry warnings ---\n');
  await test('warning bridge tolerates restricted storage and scalar payload drift', () => {
    setActivePinia(createPinia());
    const statusStore = useStatusStore();
    const flightStore = useFlightStore();
    let fuelWarningTimer = null;

    const warnings = createTelemetryWarnings({
      statusStore,
      flightStore,
      localStorageRef: {
        getItem() {
          throw new Error('storage unavailable');
        },
      },
      setTimeoutRef(callback) {
        fuelWarningTimer = callback;
        return 1;
      },
      clearTimeoutRef() {},
    });

    assert.doesNotThrow(() => {
      warnings.showUpdateBanner({ currentVersion: '0.1.0', latestVersion: '0.2.0' });
    }, 'update banners should not fail when storage reads are blocked');
    assert.equal(statusStore.updateBannerVisible, true, 'update banner should still be shown from store state');

    assert.doesNotThrow(() => {
      warnings.showWarningIndicator('overspeed', true, '145.5', 'vfe');
    }, 'speed warnings should tolerate numeric strings from bridged payloads');
    assert.equal(flightStore.speedWarningLabel, 'FLAP OVERSPEED', 'speed warning should remain store-backed');

    assert.doesNotThrow(() => {
      warnings.showFuelExhaustedWarning({ exhausted: true, fuelGal: '1.25' });
    }, 'fuel warnings should tolerate numeric strings from bridged payloads');
    assert.equal(flightStore.fuelExhaustedWarningVisible, true, 'fuel warning should show from store state');
    assert.equal(typeof fuelWarningTimer, 'function', 'fuel warning hide timer should be scheduled');
    fuelWarningTimer();
    assert.equal(flightStore.fuelExhaustedWarningVisible, false, 'fuel warning timer should hide through the store');

    assert.doesNotThrow(() => warnings.showDiskWarning(), 'disk warnings should tolerate missing payloads');
    assert.equal(statusStore.diskWarningVisible, true, 'disk warning fallback should be store-backed');
  });

  console.log('\n--- lvar inspector ---\n');
  await test('lvar inspector controller syncs Vue state, persistence, and websocket requests', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    const storage = createStorage({
      'ff-lvar-debug-watch': JSON.stringify(['saved_one']),
    });
    resetGlobals(windowRef, documentRef, storage);
    setActivePinia(createPinia());

    const lvarInspectorStore = useLvarInspectorStore();

    const sent = [];
    assert.throws(
      () => createLvarInspectorController({ localStorageRef: storage }),
      /LVAR inspector store is required/,
      'LVAR inspector controller should fail fast without the injected store',
    );

    const controller = createLvarInspectorController({
      localStorageRef: storage,
      lvarInspectorStore,
      sendWs(payload) {
        sent.push(payload);
      },
    });

    controller.bind();
    assert.deepEqual(lvarInspectorStore.debugWatchSubscriptions, ['saved_one'], 'bind should hydrate saved watch subscriptions into the store');
    assert.equal(lvarInspectorStore.watchInputText, 'saved_one', 'bind should hydrate the textarea model from storage');

    lvarInspectorStore.setWatchInputText('MY_CUSTOM_ONE\nMY_CUSTOM_ONE\nMY_CUSTOM_TWO');
    lvarInspectorStore.applyWatchInput();
    await nextTick();
    assert.deepEqual(
      sent.shift(),
      { type: 'lvarDebugWatch', subscriptions: ['MY_CUSTOM_ONE', 'MY_CUSTOM_TWO'] },
      'applying a watch list should emit a normalized websocket subscription payload',
    );
    assert.equal(
      storage.getItem('ff-lvar-debug-watch'),
      JSON.stringify(['MY_CUSTOM_ONE', 'MY_CUSTOM_TWO']),
      'applying a watch list should persist the normalized subscriptions',
    );

    controller.handleDataSourcesMessage({
      secondary: [{
        type: 'lvar-sidecar',
        connected: true,
        description: 'Running',
        preview: [{ key: 'L:MY_CUSTOM_TEST', value: 1.25 }],
        debugWatch: {
          count: 2,
          items: [{ expression: '(L:MY_CUSTOM_TEST, number)', value: 12, live: true }],
        },
      }],
    });
    assert.equal(lvarInspectorStore.statusLabel, 'Running', 'data source messages should update the header state through the store');
    assert.equal(lvarInspectorStore.previewRows[0].valueText, '1.25', 'preview values should remain formatted through the store');

      controller.clearDataSourcesStatus();
      assert.equal(lvarInspectorStore.statusLabel, 'LVAR source not enabled.', 'clearing data sources should restore the disabled state');
    });

  console.log('\n--- profiles runtime ---\n');
  await test('profiles runtime requests bundled profile choices only after full-control acknowledgement', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const sent = [];
    const profilesStore = useProfilesStore();

    const cleanupProfilesRuntime = initProfilesRuntime({
      profilesStore,
      sendMessage(message) {
        sent.push(message);
        return true;
      },
      subscribeWsCloseSignal: subscribeWsClose,
      subscribeWsConnectingSignal: subscribeWsConnecting,
      subscribeWsErrorSignal: subscribeWsError,
      subscribeWsMessageSignal: subscribeWsMessage,
      subscribeWsOpenSignal: subscribeWsOpen,
    });
    await nextTick();

    assert.equal(typeof cleanupProfilesRuntime, 'function', 'profiles runtime should return a cleanup function');
    assert.equal(profilesStore.messageActionBound, true, 'profiles runtime should bind websocket-backed profile actions into the store');

    assert.deepEqual(
      sent,
      [],
      'profiles runtime should not request privileged profile data before authorization is acknowledged',
    );
    assert.equal(profilesStore.authorizationScope, 'read-only');
    assert.equal(profilesStore.profileSelectionAvailable, false);

    emitWsOpen();
    emitWsMessage({ type: 'authorizationScope', scope: 'read-only', aircraftControlPairingStatus: 'expired' });
    assert.equal(profilesStore.aircraftControlPairingStatus, 'expired', 'profiles runtime should retain the server pairing rejection reason for mobile guidance');
    emitWsMessage({ type: 'authorizationScope', scope: 'aircraft-control', aircraftControlPairingStatus: 'accepted' });
    assert.deepEqual(
      sent,
      [],
      'read-only and aircraft-control sockets should never request privileged profile data',
    );
    assert.equal(profilesStore.authorizationScope, 'aircraft-control');
    assert.equal(profilesStore.aircraftControlPairingStatus, 'accepted');
    assert.equal(profilesStore.profileSelectionAvailable, false);

    emitWsMessage({ type: 'authorizationScope', scope: 'full-control' });
    emitWsMessage({ type: 'authorizationScope', scope: 'full-control' });
    assert.deepEqual(sent, [{ type: 'listProfiles' }], 'full-control acknowledgement should request the profile list once');
    assert.equal(profilesStore.authorizationScope, 'full-control');
    assert.equal(profilesStore.profileSelectionAvailable, true);

    emitWsMessage({
      type: 'profileList',
      profiles: [{ id: 'fixture', namespace: 'bundled' }],
    });
    assert.deepEqual(profilesStore.installedProfiles.map((profile) => profile.id), ['fixture']);

    emitWsClose();
    assert.equal(profilesStore.authorizationScope, 'read-only');
    assert.equal(profilesStore.aircraftControlPairingStatus, 'not-requested', 'disconnect should clear stale pairing diagnostics');
    assert.equal(profilesStore.profileSelectionAvailable, false);
    assert.deepEqual(profilesStore.installedProfiles, [], 'disconnect should clear privileged profile-list state immediately');

    sent.length = 0;
    emitWsOpen();
    assert.deepEqual(sent, [], 'reconnect should wait for the new socket scope acknowledgement');
    assert.equal(profilesStore.authorizationScope, 'read-only');
    assert.equal(profilesStore.profileSelectionAvailable, false);
    assert.deepEqual(profilesStore.installedProfiles, [], 'reconnect should clear privileged profile-list state');

    emitWsMessage({ type: 'authorizationScope', scope: 'full-control' });
    assert.deepEqual(sent, [{ type: 'listProfiles' }], 'a reauthorized full-control socket should refresh the profile list');

    cleanupProfilesRuntime();
    assert.equal(profilesStore.messageActionBound, false, 'profiles runtime cleanup should unbind websocket-backed profile actions');
    assert.equal(profilesStore.profileSelectionAvailable, false, 'profiles runtime cleanup should clear privileged UI state');
    sent.length = 0;
    emitWsOpen();
    emitWsMessage({ type: 'profileList', profiles: [{ id: 'after-cleanup' }] });
    assert.deepEqual(sent, [], 'profiles runtime cleanup should remove websocket signal subscriptions');
    assert.deepEqual(profilesStore.installedProfiles, [], 'profiles runtime cleanup should remove websocket message handling');
  });

  await test('profiles runtime recovers an already-acknowledged local scope after a late mount', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const sent = [];
    let acknowledgedScope = 'read-only';
    const profilesStore = useProfilesStore();
    const cleanupProfilesRuntime = initProfilesRuntime({
      profilesStore,
      getAuthorizationScope: () => acknowledgedScope,
      sendMessage(message) {
        sent.push(message);
        return true;
      },
      subscribeWsCloseSignal: subscribeWsClose,
      subscribeWsConnectingSignal: subscribeWsConnecting,
      subscribeWsErrorSignal: subscribeWsError,
      subscribeWsMessageSignal: subscribeWsMessage,
      subscribeWsOpenSignal: subscribeWsOpen,
    });

    assert.equal(profilesStore.profileSelectionAvailable, false);
    acknowledgedScope = 'full-control';
    emitWsMessage({ type: 'aircraftProfile', profile: { id: 'fbw-a32nx' } });
    assert.equal(profilesStore.authorizationScope, 'full-control');
    assert.equal(profilesStore.profileSelectionAvailable, true);
    assert.deepEqual(
      sent,
      [{ type: 'listProfiles' }],
      'a later server message should recover the acknowledged scope and request bundled profiles once',
    );

    emitWsMessage({ type: 'simState', connected: true });
    assert.deepEqual(sent, [{ type: 'listProfiles' }], 'scope recovery should not duplicate profile-list requests');

    emitWsError({ type: 'error' });
    assert.equal(profilesStore.authorizationScope, 'read-only');
    assert.equal(profilesStore.profileSelectionAvailable, false, 'websocket errors should hide profile selection immediately');

    acknowledgedScope = 'full-control';
    emitWsMessage({ type: 'authorizationScope', scope: 'full-control' });
    assert.equal(profilesStore.profileSelectionAvailable, true);
    emitWsConnecting();
    assert.equal(profilesStore.authorizationScope, 'read-only');
    assert.equal(profilesStore.profileSelectionAvailable, false, 'reconnect attempts should hide profile selection until reauthorized');

    cleanupProfilesRuntime();
  });

  await test('profiles runtime restores an acknowledged scope immediately when mounted late', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const sent = [];
    const profilesStore = useProfilesStore();
    const cleanupProfilesRuntime = initProfilesRuntime({
      profilesStore,
      getAuthorizationScope: () => 'full-control',
      sendMessage(message) {
        sent.push(message);
        return true;
      },
    });

    assert.equal(profilesStore.profileSelectionAvailable, true);
    assert.deepEqual(sent, [{ type: 'listProfiles' }]);

    cleanupProfilesRuntime();
  });

  console.log('\n--- debug runtime ---\n');
  await test('debug runtime feeds the Vue store and sends shake-test requests', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    documentRef.register(new FakeElement('debug-modal'));

    const sent = [];
    const timeouts = [];
    const intervals = [];
    const clearedIntervals = [];
    windowRef.setTimeout = (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    };
    windowRef.clearTimeout = (id) => {
      if (id > 0 && id <= timeouts.length) {
        timeouts[id - 1] = null;
      }
    };
    windowRef.setInterval = (fn) => {
      intervals.push(fn);
      return intervals.length;
    };
    windowRef.clearInterval = (id) => {
      clearedIntervals.push(id);
    };
    globalThis.setTimeout = windowRef.setTimeout;
    globalThis.clearTimeout = windowRef.clearTimeout;
    globalThis.setInterval = windowRef.setInterval;
    globalThis.clearInterval = windowRef.clearInterval;

    const debugStore = useDebugStore();
    const currentDebugState = {
      phase: 'CRUISE',
      simConnected: true,
      websocketReady: true,
    };
    const runtime = initDebugRuntime({
      $: (id) => documentRef.getElementById(id),
      sendWs(payload) {
        sent.push(payload);
        return true;
      },
      debugStore,
      getCurrentDebugState: () => currentDebugState,
      subscribeDebugFrameSignal: subscribeDebugFrame,
      subscribeTelemetryResetSignal: subscribeTelemetryReset,
      subscribeWsCloseSignal: subscribeWsClose,
      subscribeWsMessageSignal: subscribeWsMessage,
      windowRef,
      documentRef,
      consoleRef: { log() {} },
    });

      assert.ok(runtime, 'debug runtime should initialize when the modal and store exist');
      assert.equal(debugStore.toggleVisible, true, 'debug runtime should expose the footer debug toggle through the store');
      assert.equal(intervals.length, 0, 'closed debug runtime should not register a periodic timer');

    documentRef.dispatchEvent({
      type: 'keydown',
      key: 'D',
      ctrlKey: true,
      shiftKey: true,
      preventDefault() {},
    });
    assert.equal(debugStore.modalOpen, true, 'keyboard shortcut should toggle the debug modal open');
    assert.equal(intervals.length, 1, 'opening debug should start its cleanup timer');
    assert.equal(debugStore.phase, 'CRUISE', 'opening debug should restore current phase metadata');
    assert.equal(debugStore.simConnected, true, 'opening debug should restore current connection metadata');

    emitDebugFrame({
      primary: { connected: true },
      type: 'debug-frame',
      phase: 'APPROACH',
      ias: 142.2,
      crosswind: 16,
      'L:MY_CUSTOM_TEST': true,
    });
    assert.equal(debugStore.connectionKnown, true, 'debug frames should set connection state through the store');
    assert.equal(debugStore.simConnected, true, 'debug frames should mark SimConnect as connected');
    assert.equal(debugStore.phase, 'APPROACH', 'debug frames should update the current phase');
    assert.equal(debugStore.totalVarCount, 5, 'debug frames should populate grouped variables in the store');

    emitDebugFrame({ type: 'flightTime', value: 123 });
    assert.equal(debugStore.simConnected, true, 'unrelated messages should not overwrite known SimConnect state');

    emitDebugFrame({ type: 'simState', simconnectConnected: false });
    assert.equal(debugStore.simConnected, false, 'simState messages should authoritatively update SimConnect state');

    debugStore.setModalOpen(false);
    assert.equal(debugStore.totalVarCount, 0, 'closing debug should release captured variables');
    assert.equal(debugStore.frameCount, 0, 'closing debug should reset the captured message count');
    assert.equal(debugStore.connectionKnown, false, 'closing debug should release captured connection metadata');
    const messageCountBeforeClosedFrame = debugStore.frameCount;
    emitDebugFrame({ type: 'ias', value: 999 });
    assert.equal(debugStore.frameCount, messageCountBeforeClosedFrame, 'closed debug modal should not ingest background messages');
    emitDebugFrame({ type: 'phase', value: 'LANDING' });
    assert.equal(debugStore.phase, '--', 'closed debug modal should not process phase messages');
    assert.ok(clearedIntervals.includes(1), 'closing debug should stop its periodic timer');
    currentDebugState.phase = 'LANDING';
    debugStore.setModalOpen(true);
    assert.equal(debugStore.phase, 'LANDING', 'reopening debug should restore current phase metadata');
    assert.equal(intervals.length, 2, 'reopening debug should start a new cleanup timer');

    emitDebugFrame({ type: 'simState', simconnectConnected: true });
    emitWsClose();
    assert.equal(debugStore.connectionKnown, false, 'websocket close should clear stale debug connection state');
    assert.equal(debugStore.simConnected, false, 'websocket close should clear stale SimConnect state');

    emitDebugFrame({ type: 'ias', value: 145 });
    assert.ok(debugStore.totalVarCount > 0, 'open debug modal should capture telemetry before reset');
    emitTelemetryReset({ reason: 'simconnectDisconnected' });
    assert.equal(debugStore.totalVarCount, 0, 'telemetry reset should clear captured debug variables');
    assert.equal(debugStore.frameCount, 0, 'telemetry reset should clear the captured message count');
    assert.equal(debugStore.modalOpen, true, 'telemetry reset should leave the debug modal open');

    debugStore.setTestShakeVs('-700');
    debugStore.requestTestShake();
    await nextTick();
    assert.deepEqual(
      sent.shift(),
      { type: 'testShake', vs_fpm: -700 },
      'shake-test requests should flow through the websocket bridge',
    );
    assert.equal(debugStore.testShakeStatus, 'Sent (-700 fpm)', 'successful shake-test sends should update status text');

    emitWsMessage({
      type: 'testShakeAck',
      vs_fpm: -700,
      diag: {
        isMock: false,
        lvarBridge: true,
        lvarStarted: true,
        lvarProcAlive: true,
        connected: true,
        handle: 7,
      },
    });
    assert.match(debugStore.testShakeStatus, /ack -700fpm/, 'shake-test acknowledgements should update the status text');
    runtime.cleanup();
    assert.ok(clearedIntervals.includes(2), 'debug cleanup should stop the active periodic timer');
  });

  console.log('\n--- landing controller ---\n');
  await test('landing controller routes landing-card visibility through the landing store', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    documentRef.register(new FakeElement('landing-card', { classList: ['hidden'] }));
    documentRef.register(new FakeElement('landing-waiting-state'));
    documentRef.register(new FakeElement('landing-vs'));
    documentRef.register(new FakeElement('landing-grade'));

    const landingEvents = [];
    const unsubscribeLandingReceived = subscribeLandingReceived(() => {
      landingEvents.push('landing-received');
    });

    const flightStore = useFlightStore();
    const landingStore = useLandingStore();
    const controller = createLandingController({
      $: (id) => documentRef.getElementById(id),
      setText: (id, value) => {
        const element = documentRef.getElementById(id);
        if (element) element.textContent = value == null ? '' : String(value);
      },
      documentRef,
      windowRef,
      flightStore,
      landingStore,
    });

    controller.handleLandingMessage({
      final: true,
      vs: -467,
      color: '#00ff88',
      grade: 'Good',
      icao: 'YSSY',
      runway: '34L',
      gforce: 1.23,
      iasKts: 136,
      gsKts: 142,
      crosswind: -8,
      windSpeed: 12,
      approachType: 'ILS',
      pitchDeg: 3.1,
      bankDeg: -1.4,
      centerlineDev: 0.4,
      touchdownDistance: {
        distanceFt: 305,
        grade: 'Outstanding',
      },
      ultimateStability: { score: 60, gateFailures: ['flaps_not_set_at_gate'] },
    });

    assert.equal(landingStore.cardVisible, true, 'landing messages should reveal the landing card through the store');
    assert.equal(landingStore.waitingVisible, false, 'landing messages should hide the waiting state through the store');
    assert.equal(flightStore.lastLanding.available, true, 'landing messages should continue to feed the flight preview store');
    assert.equal(landingStore.landingCard.gradeText, 'GOOD', 'landing messages should hydrate the store-backed headline grade');
    assert.equal(landingStore.landingCard.airportText, 'YSSY', 'landing messages should hydrate the store-backed airport label');
    assert.equal(landingStore.landingCard.touchdown.distanceText, '305 ft', 'landing messages should hydrate touchdown metrics');
    assert.equal(landingStore.landingCard.approach.stabilityText, 'UNSTABLE', 'failed checks should infer an unstable approach when the explicit gate flag is absent');
    assert.equal(landingStore.landingCard.approach.stabilityNoteText, '1 substantial/required finding · Approach score 60%', 'the approach score should stay secondary to the unstable verdict');
    assert.match(landingStore.landingCard.approach.stabilityTooltip, /hard or substantial deviation was recorded after the 1,000 ft gate/, 'the tooltip should explain the full post-gate result');
    assert.deepEqual(landingEvents, ['landing-received'], 'landing messages should continue to emit the landing-received event');
    unsubscribeLandingReceived();

    controller.handleFlightSummaryMessage({
      max_alt_ft: 12000,
      max_ias_kts: 250,
      go_around_count: 1,
      overspeed_count: 2,
      violations: [{ rule_id: 'bank_angle', severity: 'warning', label: 'Bank Angle', duration_ms: 4200 }],
    });
    assert.equal(landingStore.landingCard.inflight.visible, true, 'flight summary messages should hydrate the in-flight section through the store');
    assert.equal(landingStore.landingCard.inflight.stats.length, 3, 'flight summary messages should normalize stat rows through the store');
    assert.equal(landingStore.landingCard.inflight.violations.length, 2, 'flight summary messages should normalize violation rows through the store');

    controller.handleFlightViolationMessage({ event: 'start' });
    assert.equal(landingStore.landingCard.attitude.upsetCountText, '1', 'flight violation messages should update upset counts through the store');
    controller.handleFlightViolationMessage({ event: 'start', counts_as_upset: false });
    assert.equal(landingStore.landingCard.attitude.upsetCountText, '1', 'advisory flight violation messages should not update upset counts');

    controller.resetSession();
    assert.equal(landingStore.cardVisible, false, 'resetSession should hide the landing card through the store');
    assert.equal(landingStore.waitingVisible, true, 'resetSession should restore the waiting state through the store');
    assert.equal(landingStore.landingCard.gradeText, '--', 'resetSession should reset landing-card summary state');
  });

  await test('landing controller publishes stability breakdown rows into the landing store', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    documentRef.register(new FakeElement('landing-card', { classList: ['hidden'] }));

    const landingStore = useLandingStore();
    const controller = createLandingController({
      $: (id) => documentRef.getElementById(id),
      documentRef,
      windowRef,
      setText: () => {},
      landingStore,
    });

    controller.handleUltimateStabilityScoreMessage({
      breakdown: {
        speed_ok: 82,
        thrust_ok: 96,
        thrust_stable_ok: 96,
        bank_ok: 97,
        checklist_ok: 0,
      },
      breakdownDetails: {
        speed_ok: { message: 'A little fast through the gate' },
      },
      samples: 34,
      approachProfile: [],
    });

    assert.equal(landingStore.stabilityBreakdownVisible, true, 'ultimate stability messages should reveal the stability breakdown through the store');
    assert.equal(landingStore.stabilityMetrics.length, 3, 'ultimate stability messages should normalize metric rows through the store');
    assert.equal(landingStore.stabilityMetrics.some((metric) => metric.key === 'checklist_ok'), false, 'checklist stability should not be rendered as a metric row');
    assert.equal(landingStore.stabilityMetrics.some((metric) => metric.key === 'thrust_stable_ok'), false, 'the compatibility throttle-movement alias should not render as a duplicate metric row');
    assert.equal(landingStore.stabilityMetrics.filter((metric) => metric.label === 'Throttle Movement').length, 1, 'throttle movement should render once');
    assert.equal(landingStore.stabilityMetrics[0].label, 'Airspeed', 'metric rows should use the checked-in stability labels');
    assert.equal(landingStore.stabilityMetrics[0].valueText, '82%', 'metric rows should format score values through the store');
    assert.equal(landingStore.stabilityMetrics[0].explanation, 'A little fast through the gate', 'metric rows should carry explanation text through the store');
    assert.equal(landingStore.stabilitySamplesText, '34', 'ultimate stability messages should store the sample count summary');
  });

  await test('landing controller refreshes live landing card when ultimate stability arrives after landing', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const landingEvents = [];
    const landingPreviews = [];
    const unsubscribeLandingReceived = subscribeLandingReceived(() => {
      landingEvents.push('landing-received');
    });

    const landingStore = useLandingStore();
    const controller = createLandingController({
      $: (id) => documentRef.getElementById(id),
      documentRef,
      windowRef,
      setText: () => {},
      landingStore,
      flightStore: {
        updateLandingPreview(rawLanding) {
          landingPreviews.push(rawLanding);
          return rawLanding;
        },
      },
    });

    controller.handleLandingMessage({
      final: true,
      vs: -467,
      color: '#00ff88',
      grade: 'Good',
      icao: 'KSEA',
      runway: '34L',
      touchdownDistance: {
        distanceFt: 1835,
        grade: 'Good',
      },
      ultimateStability: {
        score: 84,
        samples: 900,
      },
    });

    assert.equal(landingStore.landingCard.approach.stabilityText, 'NO VERDICT', 'an initial score without a gate result must not invent a verdict');
    assert.equal(landingStore.landingCard.debrief.confidenceText, 'High', 'an initial score with sufficient samples can retain high telemetry confidence');
    assert.equal(landingPreviews.length, 1, 'initial live landing should populate the Last Landing summary once');

    controller.handleUltimateStabilityScoreMessage({
      score: 85,
      samples: 968,
      gateStable: false,
      gateFailures: ['vs_unstable_after_gate', 'glidepath_proxy_unstable_after_gate'],
      breakdown: {
        speed_ok: 90,
        vs_ok: 57,
      },
      approachProfile: [],
    });

    assert.equal(landingStore.landingCard.approach.stabilityText, 'UNSTABLE', 'late gate verdict should refresh the live landing card');
    assert.equal(landingStore.landingCard.approach.stabilityNoteText, '2 substantial/required findings · Approach score 84%', 'late gate status should preserve the existing score as secondary context');
    assert.equal(landingStore.landingCard.debrief.confidenceText, 'High', 'late stability score should restore high data confidence when touchdown data exists');
    assert.equal(landingPreviews.length, 2, 'late stability should refresh the Last Landing summary');
    assert.equal(landingPreviews.at(-1).ultimateStability.gateStable, false, 'Last Landing should receive the late gate verdict');
    assert.equal(landingPreviews.at(-1).ultimateStability.score, 84, 'late gate facts should merge without replacing an existing landing score');
    assert.deepEqual(landingEvents, ['landing-received'], 'late stability refresh should not emit a duplicate landing-received event');

    unsubscribeLandingReceived();
  });

  await test('landing controller publishes rendered approach-profile SVG state into the landing store', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    documentRef.register(new FakeElement('landing-card', { classList: ['hidden'] }));

    const landingStore = useLandingStore();
    const controller = createLandingController({
      $: (id) => documentRef.getElementById(id),
      documentRef,
      windowRef,
      setText: () => {},
      landingStore,
    });

    controller.handleUltimateStabilityScoreMessage({
      breakdown: {
        speed_ok: 82,
      },
      breakdownDetails: {
        speed_ok: { message: 'A little fast through the gate' },
      },
      samples: 34,
      thresholdElevFt: 100,
      runwayHdg: 335,
      runwayId: '34L',
      runwayThreshold: { lat: -33.95, lon: 151.18 },
      runwayWidthFt: 148,
      runwayLengthFt: 12000,
      approachProfile: [
        { raFt: 1200, altMslFt: 1300, vsFpm: -650, iasKts: 145, gsKts: 150, pitchDeg: 2.5, bankDeg: 1.0, dtMs: 1000, latDeg: -33.9000, lonDeg: 151.1000 },
        { raFt: 1050, altMslFt: 1150, vsFpm: -700, iasKts: 144, gsKts: 149, pitchDeg: 2.6, bankDeg: 0.8, dtMs: 1000, latDeg: -33.9100, lonDeg: 151.1200 },
        { raFt: 850, altMslFt: 950, vsFpm: -720, iasKts: 143, gsKts: 148, pitchDeg: 2.7, bankDeg: 0.5, dtMs: 1000, latDeg: -33.9200, lonDeg: 151.1400 },
        { raFt: 500, altMslFt: 600, vsFpm: -680, iasKts: 141, gsKts: 146, pitchDeg: 2.9, bankDeg: 0.2, dtMs: 1000, latDeg: -33.9350, lonDeg: 151.1600 },
        { raFt: 45, altMslFt: 145, vsFpm: -467, iasKts: 136, gsKts: 142, pitchDeg: 3.1, bankDeg: -1.4, dtMs: 1000, latDeg: -33.9500, lonDeg: 151.1800 },
      ],
    });

    assert.equal(landingStore.approachProfile.visible, true, 'ultimate stability messages should expose the rendered approach profile through the store');
    assert.equal(landingStore.approachProfile.gateLabel, 'Gate: 1000 ft above runway reference', 'rendered approach profile should store the derived gate label');
    assert.match(landingStore.approachProfile.svgHtml, /<svg/, 'rendered approach profile should store SVG markup');
    assert.equal(landingStore.topdownProfile.visible, true, 'ultimate stability messages should expose the rendered top-down profile through the store');
    assert.match(landingStore.topdownProfile.svgHtml, /<svg/, 'rendered top-down profile should store SVG markup');

    controller.handleLandingMessage({
      final: true,
      vs: -467,
      grade: 'PERFECT',
      runway: '34L',
      runwayHdg: 335,
      windDirectionTrueDeg: 245,
      windSpeed: 14,
      crosswind: -14,
    });
    assert.match(landingStore.topdownProfile.svgHtml, /data-topdown-wind-vector="true"/, 'the final live landing packet should add its wind vector to the retained approach profile');
    assert.match(landingStore.topdownProfile.svgHtml, /data-wind-relative-deg="-90(?:\.0+)?"/, 'the live wind vector should be rotated relative to the detected runway');
    assert.match(landingStore.topdownProfile.svgHtml, /WIND FROM 245°T/, 'the live wind vector should retain true direction at touchdown');
    assert.match(landingStore.topdownProfile.svgHtml, /14 kt/, 'the live wind vector should retain speed at touchdown');

    controller.resetSession();
    assert.equal(landingStore.approachProfile.visible, false, 'resetSession should clear the rendered approach profile state');
    assert.equal(landingStore.topdownProfile.visible, false, 'resetSession should clear the rendered top-down profile state');
  });

  console.log('\n--- live-map store bridge ---\n');
  await test('map plane icons render as SVG and rotate directly by heading', () => {
    const html = buildPlaneIconHtml('test-plane-glyph');
    assert.match(html, /<svg\b/, 'plane icon HTML should use SVG so mobile browsers do not render it as emoji');
    assert.doesNotMatch(html, /\u2708/, 'plane icon HTML should not contain the unicode airplane glyph');
    assert.equal(normalizeHeadingDeg(87), 87, 'direct headings should be preserved');
    assert.equal(normalizeHeadingDeg(450), 90, 'overflow headings should wrap cleanly');
    assert.equal(normalizeHeadingDeg(-10), 350, 'negative headings should wrap cleanly');
  });

  await test('dateline routes stay on one wrapped map branch', () => {
    const rawPath = getGreatCirclePath(47.4502, -122.3088, -33.9399, 151.1753);
    assert(rawPath.some((point, index) => (
      index > 0 && Math.abs(point[1] - rawPath[index - 1][1]) > 180
    )), 'fixture should cross the antimeridian in canonical coordinates');

    const displayPath = unwrapLatLngPath(rawPath, -122.3088);
    for (let index = 1; index < displayPath.length; index += 1) {
      assert(
        Math.abs(displayPath[index][1] - displayPath[index - 1][1]) <= 180,
        'wrapped route must not contain a world-spanning longitude chord',
      );
    }
    const longitudes = displayPath.map(point => point[1]);
    assert(
      Math.max(...longitudes) - Math.min(...longitudes) < 180,
      'wrapped route bounds should use the short world-copy span',
    );
    assert(
      Math.abs(unwrapLongitudeNear(151.1753, -122.3088) - (-208.8247)) < 1e-9,
      'destination marker should share the route world-copy branch',
    );
  });

  await test('live destination marker follows the aircraft world branch across the dateline', () => {
    const activeLayers = [];
    const makeLayer = (kind, latLng = null, options = {}) => ({
      kind,
      latLng,
      options,
      addTo() {
        activeLayers.push(this);
        return this;
      },
      on() { return this; },
      bindTooltip() { return this; },
      setLatLng(nextLatLng) {
        this.latLng = nextLatLng;
        return this;
      },
      getElement() {
        return { querySelector: () => null };
      },
    });
    const liveMap = {
      setView() { return this; },
      panTo() { return this; },
      on() { return this; },
      removeLayer(layer) {
        const index = activeLayers.indexOf(layer);
        if (index >= 0) activeLayers.splice(index, 1);
      },
      getZoom() { return 11; },
      getCenter() { return { lat: 0, lng: 0 }; },
      getSize() { return { x: 800, y: 600 }; },
      invalidateSize() {},
    };
    const windowRef = {
      L: {
        map: () => liveMap,
        tileLayer: () => makeLayer('tile'),
        polyline: (latLngs, options) => makeLayer('polyline', latLngs, options),
        circleMarker: (latLng, options) => makeLayer('circle', latLng, options),
        marker: (latLng, options) => makeLayer('marker', latLng, options),
        divIcon: (options) => options,
      },
      setTimeout(callback) { callback(); return 1; },
      clearTimeout() {},
      requestAnimationFrame(callback) { callback(); return 1; },
      cancelAnimationFrame() {},
    };
    const targetAirport = { icao: 'YSSY', lat: -33.946, lon: 151.177 };
    const routeTargets = {
      getTargetAirport: () => targetAirport,
      getOriginAirport: () => null,
      updateTargetOverlay() {},
      updateDestinationProgress() {},
    };
    const controller = createLiveMapController({
      mapEl: { clientWidth: 800, clientHeight: 600, parentElement: null },
      liveMapStore: {
        setMapEmptyState() {},
        setMeta() {},
        setFollowStatus() {},
      },
      windowRef,
      localStorageRef: createStorage(),
      consoleRef: console,
      isValidCoord: (lat, lon) => (
        Number.isFinite(lat)
        && Number.isFinite(lon)
        && Math.abs(lat) <= 90
        && Math.abs(lon) <= 180
      ),
      getRouteTargets: () => routeTargets,
      allowOnlineTiles: () => false,
      isLiveMapVisible: () => true,
    });

    controller.handlePositionMessage({ lat: 0, lon: -179, hdg: 90 });
    controller.renderTargetMarker();
    const beforeCrossing = activeLayers.find(layer => (
      layer.kind === 'circle' && layer.options.color === '#3b82f6'
    ));
    assert(beforeCrossing, 'destination marker should exist before the crossing');
    assert(
      Math.abs(beforeCrossing.latLng[1] - (-208.823)) < 1e-9,
      'destination marker should initially use the western world copy nearest the aircraft',
    );

    controller.handlePositionMessage({ lat: 0, lon: 179, hdg: 90 });
    const afterCrossing = activeLayers.find(layer => (
      layer.kind === 'circle' && layer.options.color === '#3b82f6'
    ));
    assert(afterCrossing, 'destination marker should still exist after the crossing');
    assert.notEqual(afterCrossing, beforeCrossing, 'position update should refresh the branch-specific destination marker');
    assert(
      Math.abs(afterCrossing.latLng[1] - 151.177) < 1e-9,
      'destination marker should move to the eastern world copy nearest the aircraft after crossing',
    );
  });

  await test('live trail stays above planned route overlays', () => {
    const activeLayers = [];
    const makeLayer = (kind, latLng = null, options = {}) => ({
      kind,
      latLng,
      options,
      frontCount: 0,
      addTo() {
        activeLayers.push(this);
        return this;
      },
      on() { return this; },
      bindTooltip() { return this; },
      setLatLng(nextLatLng) {
        this.latLng = nextLatLng;
        return this;
      },
      getElement() {
        return { querySelector: () => null };
      },
      bringToFront() {
        const index = activeLayers.indexOf(this);
        if (index >= 0) activeLayers.splice(index, 1);
        activeLayers.push(this);
        this.frontCount += 1;
        return this;
      },
    });
    const liveMap = {
      setView() { return this; },
      panTo() { return this; },
      on() { return this; },
      removeLayer(layer) {
        const index = activeLayers.indexOf(layer);
        if (index >= 0) activeLayers.splice(index, 1);
      },
      getZoom() { return 11; },
      getCenter() { return { lat: -37.67, lng: 144.84 }; },
      getSize() { return { x: 800, y: 600 }; },
      invalidateSize() {},
    };
    const windowRef = {
      L: {
        map: () => liveMap,
        tileLayer: () => makeLayer('tile'),
        polyline: (latLngs, options) => makeLayer('polyline', latLngs, options),
        circleMarker: (latLng, options) => makeLayer('circle', latLng, options),
        marker: (latLng, options) => makeLayer('marker', latLng, options),
        divIcon: (options) => options,
      },
      setTimeout(callback) { callback(); return 1; },
      clearTimeout() {},
      requestAnimationFrame(callback) { callback(); return 1; },
      cancelAnimationFrame() {},
    };
    const routeTargets = {
      getOriginAirport: () => ({ icao: 'YMML', lat: -37.67, lon: 144.84 }),
      getTargetAirport: () => ({ icao: 'YBAS', lat: -23.81, lon: 133.9 }),
      updateTargetOverlay() {},
      updateDestinationProgress() {},
    };
    const controller = createLiveMapController({
      mapEl: { clientWidth: 800, clientHeight: 600, parentElement: null },
      liveMapStore: {
        setMapEmptyState() {},
        setMeta() {},
        setFollowStatus() {},
      },
      windowRef,
      localStorageRef: createStorage(),
      consoleRef: console,
      isValidCoord: (lat, lon) => (
        Number.isFinite(lat)
        && Number.isFinite(lon)
        && Math.abs(lat) <= 90
        && Math.abs(lon) <= 180
      ),
      getRouteTargets: () => routeTargets,
      allowOnlineTiles: () => false,
      isLiveMapVisible: () => true,
    });

    controller.handlePositionMessage({ lat: -37.67, lon: 144.84, hdg: 320 });
    controller.handlePositionMessage({ lat: -37.65, lon: 144.82, hdg: 320 });

    const liveTrack = activeLayers.find(layer => layer.options.className === 'flight-track-line');
    assert(liveTrack, 'two live positions should create a cyan trail layer');
    assert.equal(
      activeLayers.filter(layer => layer.kind === 'polyline').at(-1),
      liveTrack,
      'planned-route redraws should leave the cyan trail above other path layers',
    );

    controller.renderRouteLine();
    assert.equal(
      activeLayers.filter(layer => layer.kind === 'polyline').at(-1),
      liveTrack,
      'independent origin/destination updates should not repaint the route over the cyan trail',
    );
    assert(liveTrack.frontCount >= 1, 'route rendering should explicitly restore live-trail z-order');
  });

  await test('live map activation redraw is coalesced and cancelled during teardown', () => {
    let nextTimerId = 0;
    const pendingTimers = new Map();
    const windowRef = {
      setTimeout(callback) {
        nextTimerId += 1;
        pendingTimers.set(nextTimerId, callback);
        return nextTimerId;
      },
      clearTimeout(timerId) {
        pendingTimers.delete(timerId);
      },
      cancelAnimationFrame() {},
    };
    let liveMapVisible = false;
    let targetOverlayUpdates = 0;
    let destinationProgressUpdates = 0;
    const routeTargets = {
      updateTargetOverlay() {
        targetOverlayUpdates += 1;
      },
      updateDestinationProgress() {
        destinationProgressUpdates += 1;
      },
    };
    const controller = createLiveMapController({
      mapEl: { clientWidth: 800, clientHeight: 600, parentElement: null },
      liveMapStore: {
        setMapEmptyState() {},
        setMeta() {},
        setFollowStatus() {},
      },
      windowRef,
      localStorageRef: createStorage(),
      consoleRef: console,
      isValidCoord: () => true,
      getRouteTargets: () => routeTargets,
      allowOnlineTiles: () => false,
      isLiveMapVisible: () => liveMapVisible,
    });

    controller.handlePositionMessage({ lat: -37.67, lon: 144.84, hdg: 320 });
    assert.equal(targetOverlayUpdates, 0, 'hidden live-map positions should leave map-only overlay work gated');
    assert.equal(destinationProgressUpdates, 1, 'hidden live-map positions should keep the global route banner current');
    controller.handlePositionMessage({ lat: -36.90, lon: 145.50, hdg: 45 });
    assert.equal(targetOverlayUpdates, 0, 'repeated hidden positions should keep map-only overlay work gated');
    assert.equal(destinationProgressUpdates, 2, 'each hidden position should refresh the global route banner');
    liveMapVisible = true;
    controller.handleTabActivated();
    controller.handleTabActivated();
    assert.equal(pendingTimers.size, 1, 'repeated activation signals should coalesce into one redraw');

    controller.cleanup();
    assert.equal(pendingTimers.size, 0, 'teardown should cancel delayed activation before it can recreate the map');
  });

  await test('live map controller publishes empty-state visibility through the live-map store', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const liveMapStore = useLiveMapStore();
    const mapEl = documentRef.register(new FakeElement('live-map'));
    mapEl.offsetParent = {};
    mapEl.clientWidth = 0;
    mapEl.clientHeight = 0;

    const glyphEl = new FakeElement('live-plane-glyph');
    glyphEl.style = {};
    let livePlaneIconConfig = null;
    const tileLayerUrls = [];
    const renderedTracks = [];
    const cursorElement = {
      querySelector(selector) {
        return selector === '.live-plane-glyph' ? glyphEl : null;
      },
    };
    let liveMapVisible = false;

    const mapInstance = {
      setView() { return this; },
      panTo() { return this; },
      on() { return this; },
      getZoom() { return 11; },
      getCenter() { return { lat: -33.9, lng: 151.2 }; },
      invalidateSize() {},
      removeLayer() {},
      getSize() { return { x: 0, y: 0 }; },
    };

    windowRef.L = {
      map() {
        return mapInstance;
      },
      tileLayer(url) {
        tileLayerUrls.push(url);
        return {
          on() { return this; },
          addTo() { return this; },
        };
      },
      marker(_latlng, options = {}) {
        livePlaneIconConfig = options.icon;
        return {
          addTo() { return this; },
          getElement() { return cursorElement; },
          setLatLng() { return this; },
        };
      },
      divIcon(config) {
        return config;
      },
      polyline(latLngs, options) {
        renderedTracks.push({ latLngs: latLngs.map((point) => [...point]), options });
        return {
          addTo() { return this; },
        };
      },
    };

    const controller = createLiveMapController({
      mapEl,
      liveMapStore,
      windowRef,
      documentRef,
      localStorageRef: createStorage(),
      consoleRef: console,
      isValidCoord: () => true,
      getRouteTargets: () => null,
      isLiveMapVisible: () => liveMapVisible,
    });

    assert.equal(liveMapStore.mapEmptyVisible, true, 'live-map empty state should start visible');

    const hiddenTrackPointCount = 4096;
    const hiddenTrackPoints = Array.from({ length: hiddenTrackPointCount }, (_, index) => {
      const progress = index / (hiddenTrackPointCount - 1);
      return [
        -34.2011 + (0.255 * progress),
        150.9222 + (0.255 * progress),
      ];
    });
    for (const [lat, lon] of hiddenTrackPoints) {
      controller.handlePositionMessage({ lat, lon, hdg: 87 });
    }
    assert.deepEqual(tileLayerUrls, [], 'hidden live map should defer Leaflet initialization');
    liveMapVisible = true;
    controller.handleTabActivated();

    controller.handlePositionMessage({
      lat: -33.9461,
      lon: 151.1772,
      hdg: 87,
    });

    assert.equal(liveMapStore.mapEmptyVisible, false, 'first live position should hide the live-map empty state through the store');
    assert.match(liveMapStore.metaText, /Lat -33\.94610 - Lon 151\.17720 - HDG 087 deg/, 'live positions should keep updating the live-map meta text');
    assert.match(tileLayerUrls[0] || '', /basemaps\.cartocdn\.com\/dark_all/, 'live map should prefer dark CARTO tiles for readable overlays by default');
    assert.match(livePlaneIconConfig?.html || '', /<svg\b/, 'live plane marker should use SVG instead of a text glyph');
    assert.equal(glyphEl.style.transform, 'rotate(87deg)', 'live plane marker should point at the reported heading');

    controller.handlePositionMessage({ lat: -33.9, lon: 151.2, hdg: 87 });
    controller.handleWsClose();
    controller.handleWsOpen();
    controller.handlePositionMessage({ lat: -33.85, lon: 151.25, hdg: 87 });
    const latestTrack = renderedTracks.at(-1)?.latLngs || [];
    assert(
      latestTrack.length < 64,
      'live trail should compact redundant high-frequency samples instead of rebuilding an unbounded polyline',
    );
    assert(
      latestTrack.length > 2,
      'long straight legs should periodically commit vertices so pending simplifier state stays bounded',
    );
    assert.deepEqual(latestTrack[0], hiddenTrackPoints[0], 'live trail should retain its first point while the map starts hidden');
    assert.deepEqual(latestTrack.at(-1), [-33.85, 151.25], 'live trail should keep its endpoint current across WebSocket reconnects');

    const renderedTrackCountBeforeHide = renderedTracks.length;
    liveMapVisible = false;
    controller.handlePositionMessage({ lat: -33.84, lon: 151.25, hdg: 87 });
    controller.handlePositionMessage({ lat: -33.84, lon: 151.26, hdg: 87 });
    assert.equal(
      renderedTracks.length,
      renderedTrackCountBeforeHide,
      'hidden-window samples should update retained geometry without touching Leaflet',
    );
    liveMapVisible = true;
    controller.handleTabActivated();
    const trackWithTurn = renderedTracks.at(-1)?.latLngs || [];
    assert(
      trackWithTurn.some((point) => point[0] === -33.84 && point[1] === 151.25),
      'reactivating an existing map should repaint meaningful turns collected while hidden',
    );
    assert.deepEqual(
      trackWithTurn.at(-1),
      [-33.84, 151.26],
      'reactivating an existing map should repaint the newest retained position without waiting for telemetry',
    );

    controller.handlePositionMessage({ lat: 47.4502, lon: -122.3088, hdg: 87 });
    controller.handlePositionMessage({ lat: -33.79, lon: 151.31, hdg: 87 });
    controller.handlePositionMessage({ lat: -33.78, lon: 151.32, hdg: 87 });
    const discontinuousTrack = renderedTracks.at(-1)?.latLngs || [];
    assert.equal(discontinuousTrack.length, 2, 'live trail should render impossible position jumps as separate segments');
    assert.deepEqual(discontinuousTrack[0][0], hiddenTrackPoints[0], 'splitting should preserve the valid trail before a jump');
    assert.deepEqual(
      discontinuousTrack[1],
      [[-33.79, 151.31], [-33.78, 151.32]],
      'splitting should resume the trail after an isolated outlier without drawing a world-spanning chord',
    );

    controller.handlePositionMessage({ lat: 0, lon: 179.99, hdg: 87 });
    controller.handlePositionMessage({ lat: 0, lon: -179.99, hdg: 87 });
    controller.handlePositionMessage({ lat: 0, lon: -179.98, hdg: 87 });
    const antimeridianTrack = renderedTracks.at(-1)?.latLngs || [];
    assert.deepEqual(
      antimeridianTrack.at(-1),
      [[0, -179.99], [0, -179.98]],
      'antimeridian crossings should resume in a new segment instead of drawing across the world',
    );

    const turnCenter = [-33, 151];
    const turnRadiusNm = 5;
    const turnRadiusLatDeg = turnRadiusNm / 60;
    const turnRadiusLonDeg = turnRadiusLatDeg / Math.cos(turnCenter[0] * Math.PI / 180);
    const gradualTurnPoints = Array.from({ length: 721 }, (_, index) => {
      const angleRad = (index / 720) * (Math.PI / 2);
      return [
        turnCenter[0] + (turnRadiusLatDeg * Math.sin(angleRad)),
        turnCenter[1] + (turnRadiusLonDeg * Math.cos(angleRad)),
      ];
    });
    for (const [lat, lon] of gradualTurnPoints) {
      controller.handlePositionMessage({ lat, lon, hdg: 87 });
    }
    const gradualTrack = renderedTracks.at(-1)?.latLngs || [];
    const gradualTurnSegment = Array.isArray(gradualTrack[0]?.[0])
      ? gradualTrack.at(-1)
      : gradualTrack;
    assert(
      gradualTurnSegment.length > 4,
      'production-cadence gradual turns should retain their curved breadcrumb geometry',
    );
    assert(
      gradualTurnSegment.length < 64,
      'gradual turns should remain compact after preserving their geometry',
    );
    const localPointToSegmentNm = (point, start, end) => {
      const meanLatRad = ((point[0] + start[0] + end[0]) / 3) * Math.PI / 180;
      const lonScale = 60 * Math.cos(meanLatRad);
      const pointX = (point[1] - start[1]) * lonScale;
      const pointY = (point[0] - start[0]) * 60;
      const endX = (end[1] - start[1]) * lonScale;
      const endY = (end[0] - start[0]) * 60;
      const lengthSquared = (endX * endX) + (endY * endY);
      if (lengthSquared <= Number.EPSILON) return Math.hypot(pointX, pointY);
      const fraction = Math.max(0, Math.min(
        1,
        ((pointX * endX) + (pointY * endY)) / lengthSquared,
      ));
      return Math.hypot(
        pointX - (fraction * endX),
        pointY - (fraction * endY),
      );
    };
    const gradualTurnMaxErrorNm = Math.max(...gradualTurnPoints.map(point => (
      Math.min(...gradualTurnSegment.slice(1).map((endpoint, index) => (
        localPointToSegmentNm(point, gradualTurnSegment[index], endpoint)
      )))
    )));
    assert(
      gradualTurnMaxErrorNm <= 0.021,
      `gradual-turn geometry error should stay within tolerance; got ${gradualTurnMaxErrorNm.toFixed(5)} NM`,
    );
    assert.deepEqual(
      gradualTurnSegment.at(-1),
      gradualTurnPoints.at(-1),
      'gradual-turn compaction should still keep the endpoint on the aircraft',
    );

    const outAndBackStart = [10, 10];
    const outAndBackPoints = [
      ...Array.from({ length: 101 }, (_, index) => [
        outAndBackStart[0],
        outAndBackStart[1] + ((index / 100) / 60),
      ]),
      ...Array.from({ length: 80 }, (_, index) => [
        outAndBackStart[0],
        outAndBackStart[1] + ((0.99 - (index * 0.01)) / 60),
      ]),
    ];
    for (const [lat, lon] of outAndBackPoints) {
      controller.handlePositionMessage({ lat, lon, hdg: 87 });
    }
    const outAndBackTrack = renderedTracks.at(-1)?.latLngs || [];
    const outAndBackSegment = Array.isArray(outAndBackTrack[0]?.[0])
      ? outAndBackTrack.at(-1)
      : outAndBackTrack;
    const renderedApexNm = Math.max(...outAndBackSegment.map(point => (
      (point[1] - outAndBackStart[1]) * 60
    )));
    assert(
      renderedApexNm >= 0.979,
      'dense out-and-back tracks should retain the reversal instead of collapsing into one line',
    );
    assert.deepEqual(
      outAndBackSegment.at(-1),
      outAndBackPoints.at(-1),
      'out-and-back compaction should keep its latest position current',
    );

    controller.handleHeadingMessage({ mag: 99, true: 87.2 });
    assert.equal(
      glyphEl.style.transform,
      'rotate(87deg)',
      'live map heading updates should prefer true heading and ignore tiny heading noise',
    );

    controller.handleHeadingMessage({ mag: 101, true: 90 });
    assert.equal(
      glyphEl.style.transform,
      'rotate(88.05deg)',
      'live map heading updates should smooth visible heading changes',
    );

    tileLayerUrls.length = 0;
    const quietTileController = createLiveMapController({
      mapEl,
      liveMapStore,
      windowRef,
      documentRef,
      localStorageRef: createStorage(),
      consoleRef: console,
      isValidCoord: () => true,
      getRouteTargets: () => null,
      allowOnlineTiles: () => false,
      isLiveMapVisible: () => true,
    });
    quietTileController.handlePositionMessage({
      lat: -33.9461,
      lon: 151.1772,
      hdg: 87,
    });
    assert.deepEqual(tileLayerUrls, [], 'live map should skip online tiles when the user disables them');
  });

  await test('live-map runtime no longer requires the legacy empty-state element to initialize', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    const storage = createStorage();
    resetGlobals(windowRef, documentRef, storage);
    windowRef.setTimeout = () => 1;
    windowRef.clearTimeout = () => {};
    globalThis.setTimeout = windowRef.setTimeout;
    globalThis.clearTimeout = windowRef.clearTimeout;
    setActivePinia(createPinia());

    const mapEl = documentRef.register(new FakeElement('live-map'));
    mapEl.offsetParent = {};
    mapEl.clientWidth = 0;
    mapEl.clientHeight = 0;
    setAppService('sendWs', () => true);

    const glyphEl = new FakeElement('live-plane-glyph');
    glyphEl.style = {};
    const cursorElement = {
      querySelector(selector) {
        return selector === '.live-plane-glyph' ? glyphEl : null;
      },
    };

    const mapInstance = {
      setView() { return this; },
      panTo() { return this; },
      on() { return this; },
      getZoom() { return 11; },
      getCenter() { return { lat: -33.9, lng: 151.2 }; },
      invalidateSize() {},
      removeLayer() {},
      getSize() { return { x: 0, y: 0 }; },
    };

    windowRef.L = {
      map() {
        return mapInstance;
      },
      tileLayer() {
        return {
          on() { return this; },
          addTo() { return this; },
        };
      },
      marker() {
        return {
          addTo() { return this; },
          getElement() { return cursorElement; },
          setLatLng() { return this; },
        };
      },
      polyline() {
        return {
          addTo() { return this; },
        };
      },
      circleMarker() {
        return {
          addTo() { return this; },
          bindTooltip() { return this; },
        };
      },
      divIcon(config) {
        return config;
      },
    };

    const sent = [];

    const liveMapStore = useLiveMapStore();
    const tabsStore = useTabsStore();
    const statusStore = useStatusStore();
    tabsStore.setActiveTab('livemap');

    const cleanupLiveMapRuntime = initLiveMapRuntime({
      liveMapStore,
      tabsStore,
      statusStore,
      getElementById: (id) => documentRef.getElementById(id),
      sendMessage: (payload) => {
        sent.push(payload);
        return true;
      },
      subscribeWsMessageSignal: subscribeWsMessage,
      windowRef,
      documentRef,
      localStorageRef: storage,
      consoleRef: console,
    });
    await nextTick();

    assert.equal(typeof cleanupLiveMapRuntime, 'function', 'live-map runtime should return a cleanup function');
    assert.equal(windowRef.listeners.get('resize')?.size, 1, 'live-map runtime should register one resize listener');
    assert.equal(documentRef.listeners.get('visibilitychange')?.size, 1, 'live-map runtime should repaint when the window becomes visible');
    assert.equal(liveMapStore.mapEmptyVisible, true, 'live-map runtime should keep the default store-backed empty-state visibility');
    assert.equal(liveMapStore.targetStatusMessage, 'Syncing destination...', 'live-map runtime should still run its startup sync without the legacy empty-state element');
    assert.equal(liveMapStore.originStatusMessage, 'Syncing origin...', 'live-map runtime should still initialize origin sync without the legacy empty-state element');
    assert.deepEqual(
      sent.slice(0, 2),
      [{ type: 'requestDestinationTarget' }, { type: 'requestOriginTarget' }],
      'live-map runtime should keep startup sync requests on the runtime side',
    );

    liveMapStore.setTargetInput('yssy');
    assert.equal(liveMapStore.requestSetTarget(), true, 'live-map set-target requests should dispatch through the runtime action bridge');
    assert.equal(sent[2].type, 'requestAirportLookup', 'live-map set-target requests should ask runtime to look up airports');
    assert.equal(sent[2].icao, 'YSSY', 'live-map set-target requests should preserve the normalized ICAO');
    assert.match(liveMapStore.targetStatusMessage, /Looking up YSSY/, 'live-map set-target requests should update status through the store');

    liveMapStore.setOriginInput('ymml');
    assert.equal(liveMapStore.requestSetOrigin(), true, 'live-map set-origin requests should dispatch through the runtime action bridge');
    assert.equal(sent[3].type, 'requestAirportLookup', 'live-map set-origin requests should ask runtime to look up airports');
    assert.equal(sent[3].icao, 'YMML', 'live-map set-origin requests should preserve the normalized ICAO');
    assert.match(liveMapStore.originStatusMessage, /Looking up YMML/, 'live-map set-origin requests should update origin status through the store');

    assert.equal(liveMapStore.requestClearTarget(), true, 'live-map target clears should dispatch through the runtime action bridge');
    assert.equal(sent[4].type, 'clearDestinationTarget', 'live-map target clears should stay runtime-backed');
    assert.equal(liveMapStore.targetInput, '', 'live-map target clears should update store-owned input state');
    assert.equal(liveMapStore.targetStatusMessage, 'No target airport set', 'live-map target clears should update target status immediately');

    emitWsMessage({
      type: 'destinationTarget',
      target: { icao: 'YSSY', name: 'Sydney', lat: -33.9461, lon: 151.1772 },
    });
    await nextTick();
    assert.equal(liveMapStore.targetInput, '', 'stale destination sync after clear should not restore the cleared input');
    assert.equal(liveMapStore.targetStatusMessage, 'No target airport set', 'stale destination sync after clear should not flicker target status');

    assert.equal(liveMapStore.requestClearOrigin(), true, 'live-map origin clears should dispatch through the runtime action bridge');
    assert.equal(sent[5].type, 'clearOriginTarget', 'live-map origin clears should stay runtime-backed');
    assert.equal(liveMapStore.originInput, '', 'live-map origin clears should update store-owned input state');
    assert.equal(liveMapStore.originStatusMessage, 'No origin airport set', 'live-map origin clears should update origin status immediately');

    emitWsMessage({
      type: 'originTarget',
      target: { icao: 'YMML', name: 'Melbourne', lat: -37.6733, lon: 144.8433 },
    });
    await nextTick();
    assert.equal(liveMapStore.originInput, '', 'stale origin sync after clear should not restore the cleared input');
    assert.equal(liveMapStore.originStatusMessage, 'No origin airport set', 'stale origin sync after clear should not flicker origin status');

    const sentAfterClear = sent.length;
    emitWsMessage({
      type: 'flightPlan',
      origin: 'YMML',
      destination: 'YSSY',
    });
    await nextTick();
    assert.equal(sent.length, sentAfterClear, 'stale flight-plan relay after clear should not request another airport lookup');
    assert.equal(liveMapStore.targetInput, '', 'stale flight-plan relay after clear should not restore target input');
    assert.equal(liveMapStore.originInput, '', 'stale flight-plan relay after clear should not restore origin input');
    assert.equal(liveMapStore.targetStatusMessage, 'No target airport set', 'stale flight-plan relay after clear should not flicker target status');
    assert.equal(liveMapStore.originStatusMessage, 'No origin airport set', 'stale flight-plan relay after clear should not flicker origin status');

    emitWsMessage({
      type: 'flightPlan',
      origin: 'YMML',
      destination: 'KSFO',
    });
    await nextTick();
    assert.equal(sent[sentAfterClear].type, 'requestAirportLookup', 'changed flight-plan destination should still seed a new lookup after clear');
    assert.equal(sent[sentAfterClear].icao, 'KSFO', 'changed flight-plan destination should preserve the normalized ICAO');
    assert.equal(liveMapStore.targetInput, 'KSFO', 'changed flight-plan destination should update the target input');
    assert.equal(liveMapStore.originInput, '', 'unchanged ignored flight-plan origin should stay cleared');

    emitWsMessage({
      type: 'position',
      lat: -33.9461,
      lon: 151.1772,
      hdg: 87,
    });
    await nextTick();

    assert.equal(liveMapStore.mapEmptyVisible, false, 'live-map runtime should still render live positions without relying on a tab-livemap DOM class');

    cleanupLiveMapRuntime();
    assert.equal(windowRef.listeners.get('resize')?.size || 0, 0, 'live-map runtime cleanup should remove the resize listener');
    assert.equal(documentRef.listeners.get('visibilitychange')?.size || 0, 0, 'live-map runtime cleanup should remove the visibility listener');
    liveMapStore.setTargetInput('klax');
    assert.equal(liveMapStore.requestSetTarget(), false, 'live-map runtime cleanup should unbind store action handlers');
  });

  console.log('\n--- logbook runtime ---\n');
  await test('logbook runtime binds refresh through the store action bridge and reacts to app events', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const statusStore = useStatusStore();
    const tabsStore = useTabsStore();
    const logbookStore = useLogbookStore();
    statusStore.setWebsocket('ready');
    tabsStore.setActiveTab('flight');

    const sent = [];
    const countLogbookRequests = () => sent.filter((payload) => payload?.type === 'requestLogbook').length;

    const cleanupLogbookRuntime = initLogbookRuntime({
      logbookStore,
      tabsStore,
      statusStore,
      sendMessage(payload) {
        sent.push(payload);
        return true;
      },
      subscribeLandingReceivedSignal: subscribeLandingReceived,
      subscribeWsOpenSignal: subscribeWsOpen,
      windowRef,
    });
    assert.equal(typeof cleanupLogbookRuntime, 'function', 'logbook runtime should return a cleanup function');
    assert.equal(logbookStore.requestActionBound, true, 'logbook runtime should bind the store-backed refresh action');
    assert.equal(countLogbookRequests(), 1, 'ready websocket state should trigger the initial logbook request');

    const requestsBeforeWsOpen = countLogbookRequests();
    emitWsOpen();
    assert.equal(countLogbookRequests(), requestsBeforeWsOpen + 1, 'ws-open should trigger a logbook refresh through the bound action');

    const requestsBeforeLanding = countLogbookRequests();
    emitLandingReceived({ final: true });
    assert.equal(countLogbookRequests(), requestsBeforeLanding + 1, 'landing-received should trigger a deferred logbook refresh through the bound action');

    const requestsBeforeTabSwitch = countLogbookRequests();
    tabsStore.requestTabChange('timeline');
    await nextTick();
    assert.equal(countLogbookRequests(), requestsBeforeTabSwitch + 1, 'activating the timeline tab should trigger a logbook refresh through the bound action');

    cleanupLogbookRuntime();
    assert.equal(logbookStore.requestActionBound, false, 'logbook runtime cleanup should unbind the store-backed refresh action');
    const requestsBeforeCleanupCheck = countLogbookRequests();
    emitWsOpen();
    tabsStore.requestTabChange('flight');
    await nextTick();
    tabsStore.requestTabChange('timeline');
    await nextTick();
    assert.equal(countLogbookRequests(), requestsBeforeCleanupCheck, 'logbook runtime cleanup should remove signal subscriptions and tab watchers');
  });

  await test('logbook runtime keeps remote sessions quiet and starts desktop requests after authorization', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const statusStore = useStatusStore();
    const logbookStore = useLogbookStore();
    statusStore.setWebsocket('ready');
    let authorizationScope = 'read-only';
    const sent = [];

    const cleanupLogbookRuntime = initLogbookRuntime({
      logbookStore,
      statusStore,
      getAuthorizationScope: () => authorizationScope,
      sendMessage(payload) {
        sent.push(payload);
        return true;
      },
      subscribeWsMessageSignal: subscribeWsMessage,
      subscribeWsOpenSignal: subscribeWsOpen,
      windowRef,
    });

    assert.deepEqual(sent, [], 'read-only mobile sessions must not send private history requests');
    emitWsOpen();
    emitWsMessage({ type: 'authorizationScope', scope: 'read-only' });
    assert.deepEqual(sent, [], 'read-only acknowledgement must remain quiet');

    authorizationScope = 'full-control';
    emitWsMessage({ type: 'authorizationScope', scope: 'full-control' });
    assert.deepEqual(
      sent.map((payload) => payload.type),
      ['requestLogbook', 'requestHistoryIndexStatus'],
      'desktop history should load as soon as full control is acknowledged',
    );

    cleanupLogbookRuntime();
  });

  await test('timeline runtime does not request private history from read-only mobile sessions', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const sent = [];
    const wsHandlers = new Set();
    let authorizationScope = 'read-only';
    timelineStore.bindRequestActions({
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
    });

    const runtime = createTimelineRuntime({
      windowRef,
      getAuthorizationScope: () => authorizationScope,
      subscribeWsMessageSignal(handler) {
        wsHandlers.add(handler);
        return () => wsHandlers.delete(handler);
      },
      timelineStore,
      timelinePage: { loadTimeline() {}, showEmpty() {} },
      timelineMapController: { invalidateSizeStaggered() {}, render() {} },
    });
    runtime.init();

    assert.equal(runtime.requestTimelineList(), false);
    assert.deepEqual(sent, [], 'read-only mobile sessions must not send timeline-list requests');
    assert.equal(timelineStore.listStatus, 'restricted');
    assert.equal(timelineStore.emptyStateMessage, 'Saved flight history is available in the desktop app.');

    for (const handler of wsHandlers) handler({ type: 'authorizationScope', scope: 'read-only' });
    assert.deepEqual(sent, [], 'read-only acknowledgement must not create an authorization error response');

    authorizationScope = 'full-control';
    for (const handler of wsHandlers) handler({ type: 'authorizationScope', scope: 'full-control' });
    assert.equal(sent.length, 1, 'desktop timeline history should load after full-control acknowledgement');

    runtime.cleanup();
  });

  await test('timeline runtime loads desktop history when authorization follows the ready refresh', async () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const statusStore = useStatusStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const sent = [];
    const wsHandlers = new Set();
    const timers = new Map();
    let nextTimerId = 1;
    let authorizationScope = 'read-only';
    windowRef.setTimeout = (handler) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, handler);
      return timerId;
    };
    windowRef.clearTimeout = (timerId) => timers.delete(timerId);
    timelineStore.bindRequestActions({
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
    });

    const runtime = createTimelineRuntime({
      windowRef,
      statusStore,
      getAuthorizationScope: () => authorizationScope,
      subscribeWsMessageSignal(handler) {
        wsHandlers.add(handler);
        return () => wsHandlers.delete(handler);
      },
      timelineStore,
      timelinePage: { loadTimeline() {}, showEmpty() {} },
      timelineMapController: { invalidateSizeStaggered() {}, render() {} },
    });
    runtime.init();

    statusStore.setWebsocket('ready');
    await nextTick();
    assert.equal(timers.size, 1, 'ready state should schedule the normal delayed history refresh');
    const [timerId, timerHandler] = timers.entries().next().value;
    timers.delete(timerId);
    timerHandler();
    assert.deepEqual(sent, [], 'the pre-authorization refresh must remain fail closed');
    assert.equal(timelineStore.listStatus, 'restricted');

    authorizationScope = 'full-control';
    for (const handler of wsHandlers) handler({ type: 'authorizationScope', scope: 'full-control' });
    assert.equal(sent.length, 1, 'late desktop authorization should immediately recover the history request');

    runtime.cleanup();
  });

  await test('timeline runtime cleanup removes signal subscriptions, watchers, resize listener, and pending refresh timers', async () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const tabsStore = useTabsStore();
    const statusStore = useStatusStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const sent = [];
    timelineStore.bindRequestActions({
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
    });

    const wsHandlers = new Set();
    const landingHandlers = new Set();
    const timers = new Map();
    let nextTimerId = 1;
    windowRef.setTimeout = (handler) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, handler);
      return timerId;
    };
    windowRef.clearTimeout = (timerId) => {
      timers.delete(timerId);
    };

    const timelinePage = {
      loadTimeline() {},
      showEmpty() {},
    };
    const timelineMapController = {
      invalidateSizeStaggered() {},
      render() {},
    };

    const runtime = createTimelineRuntime({
      windowRef,
      subscribeWsMessageSignal(handler) {
        wsHandlers.add(handler);
        return () => wsHandlers.delete(handler);
      },
      subscribeLandingReceivedSignal(handler) {
        landingHandlers.add(handler);
        return () => landingHandlers.delete(handler);
      },
      tabsStore,
      statusStore,
      timelineStore,
      timelinePage,
      timelineMapController,
      getCurrentTimeline: () => null,
    });

    runtime.init();
    assert.equal(wsHandlers.size, 1, 'timeline runtime should subscribe to websocket messages');
    assert.equal(landingHandlers.size, 1, 'timeline runtime should subscribe to landing-received events');
    assert.equal(windowRef.listeners.get('resize')?.size, 1, 'timeline runtime should register one resize listener');

    statusStore.setWebsocket('ready');
    await nextTick();
    for (const handler of wsHandlers) handler({ type: 'authorizationScope', scope: 'full-control' });
    assert.deepEqual(sent, [], 'authorization acknowledgement must not duplicate the scheduled ready-state refresh');
    for (const handler of landingHandlers) handler({ final: true });
    assert.equal(timers.size, 2, 'timeline runtime should schedule deferred refreshes for ready websocket and landing events');

    runtime.cleanup();
    assert.equal(wsHandlers.size, 0, 'timeline runtime cleanup should remove websocket signal subscriptions');
    assert.equal(landingHandlers.size, 0, 'timeline runtime cleanup should remove landing signal subscriptions');
    assert.equal(windowRef.listeners.get('resize')?.size || 0, 0, 'timeline runtime cleanup should remove resize listeners');
    assert.equal(timers.size, 0, 'timeline runtime cleanup should clear pending deferred refreshes');

    sent.length = 0;
    tabsStore.requestTabChange('timeline');
    await nextTick();
    assert.deepEqual(sent, [], 'timeline runtime cleanup should remove active-tab watchers');
  });

  await test('timeline runtime retries a transient first-load CSV race without exposing it as an empty history', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const sent = [];
    const wsHandlers = new Set();
    const timers = new Map();
    let nextTimerId = 1;
    windowRef.setTimeout = (handler) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, handler);
      return timerId;
    };
    windowRef.clearTimeout = (timerId) => timers.delete(timerId);
    timelineStore.bindRequestActions({
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
    });

    const runtime = createTimelineRuntime({
      windowRef,
      subscribeWsMessageSignal(handler) {
        wsHandlers.add(handler);
        return () => wsHandlers.delete(handler);
      },
      timelineStore,
      timelinePage: { loadTimeline() {}, showEmpty() {} },
      timelineMapController: { invalidateSizeStaggered() {}, render() {} },
    });
    runtime.init();

    timelineStore.requestList();
    const transient = {
      type: 'timelineListError',
      requestId: 1,
      error: 'Active flight CSV is not ready yet',
      retryable: true,
      retryAfterMs: 500,
    };
    timelineStore.ingestMessage(transient);
    for (const handler of wsHandlers) handler(transient);

    assert.equal(timelineStore.listStatus, 'loading', 'transient list races should keep the page loading');
    assert.equal(timelineStore.emptyStateMessage, 'Loading saved timelines...');
    assert.equal(timers.size, 1, 'the runtime should schedule one bounded retry');

    for (const [timerId, handler] of [...timers]) {
      timers.delete(timerId);
      handler();
    }
    assert.equal(sent.length, 2, 'the retry should issue a second list request automatically');
    assert.equal(sent[1].requestId, 2, 'the retry should use a fresh request id');

    const success = {
      type: 'timelineList',
      requestId: 2,
      flights: [{ flightId: 'historic-flight', filePath: 'C:/Flights/historic.csv' }],
    };
    timelineStore.ingestMessage(success);
    for (const handler of wsHandlers) handler(success);
    assert.equal(timelineStore.listStatus, 'loaded');
    assert.deepEqual(timelineStore.flights.map((flight) => flight.flightId), ['historic-flight']);

    runtime.cleanup();
  });

  await test('timeline runtime re-renders the replay map when the timeline modal opens', async () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const tabsStore = useTabsStore();
    const statusStore = useStatusStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const currentTimeline = {
      flightId: 'F1',
      events: [{ type: 'marker', lat: 1, lon: 2, timestampMs: 1000 }],
    };
    const rendered = [];
    let invalidated = 0;
    const runtime = createTimelineRuntime({
      windowRef,
      tabsStore,
      statusStore,
      timelineStore,
      timelinePage: {
        loadTimeline() {},
        showEmpty() {},
      },
      timelineMapController: {
        invalidateSizeStaggered() {
          invalidated += 1;
        },
        render(timeline) {
          rendered.push(timeline);
        },
      },
      getCurrentTimeline: () => currentTimeline,
    });

    runtime.init();
    timelineStore.openTimelineMobileViewer();
    await nextTick();

    assert.ok(rendered.length >= 1, 'opening the timeline modal should re-render the current replay map');
    assert.equal(rendered[0], currentTimeline, 'timeline modal re-render should use the loaded timeline');
    assert.equal(invalidated, 0, 'loaded timelines should render rather than only invalidating size');

    runtime.cleanup();
  });

  await test('timeline runtime clears replay layers when a new timeline starts loading', async () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const tabsStore = useTabsStore();
    const statusStore = useStatusStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    let clearForLoadingCount = 0;
    const runtime = createTimelineRuntime({
      windowRef,
      tabsStore,
      statusStore,
      timelineStore,
      timelinePage: {
        clearForLoading() {
          clearForLoadingCount += 1;
        },
        loadTimeline() {},
        showEmpty() {},
      },
      timelineMapController: {
        invalidateSizeStaggered() {},
        render() {},
      },
      getCurrentTimeline: () => ({ flightId: 'OLD', events: [] }),
    });

    runtime.init();
    timelineStore.beginTimelineLoading({
      flightKey: 'new-flight.csv',
      flightLabel: 'YSSY-KJFK',
    });
    await nextTick();

    assert.equal(clearForLoadingCount, 1, 'timeline loading should clear runtime-owned replay map and PFD state');

    runtime.cleanup();
    timelineStore.clearTimelineLoading();
    await nextTick();
    timelineStore.beginTimelineLoading({
      flightKey: 'second-flight.csv',
      flightLabel: 'KSFO-KSEA',
    });
    await nextTick();

    assert.equal(clearForLoadingCount, 1, 'timeline runtime cleanup should remove the loading-state watcher');
  });

  await test('timeline runtime re-renders the replay map after a modal timeline response loads', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const wsHandlers = new Set();
    const sent = [];
    let currentTimeline = null;
    const rendered = [];
    timelineStore.bindRequestActions({
      onRequestTimeline(payload) {
        sent.push(payload);
        return true;
      },
    });
    const runtime = createTimelineRuntime({
      windowRef,
      subscribeWsMessageSignal(handler) {
        wsHandlers.add(handler);
        return () => wsHandlers.delete(handler);
      },
      timelineStore,
      timelinePage: {
        loadTimeline(timeline) {
          currentTimeline = timeline;
        },
        showEmpty() {},
      },
      timelineMapController: {
        invalidateSizeStaggered() {},
        render(timeline) {
          rendered.push(timeline);
        },
      },
      getCurrentTimeline: () => currentTimeline,
    });

    const loadedTimeline = {
      filePath: 'C:/Flights/F2.csv',
      flightId: 'F2',
      events: [{ type: 'landing', lat: 1, lon: 2, timestampMs: 1000 }],
    };

    runtime.init();
    assert.equal(
      timelineStore.requestTimeline(loadedTimeline.filePath, loadedTimeline.flightId),
      true,
      'modal replay should start through the correlated Timeline request bridge',
    );
    rendered.length = 0;
    for (const handler of wsHandlers) handler({
      type: 'timeline',
      scoringMode: 'recorded',
      requestId: sent[0].requestId,
      timeline: loadedTimeline,
    });

    assert.ok(rendered.includes(loadedTimeline), 'loaded timelines should render again after the modal receives data');

    runtime.cleanup();
  });

  await test('timeline runtime ignores stale normal success and error packets over newer flight selections', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const wsHandlers = new Set();
    const sent = [];
    const loadedFlightIds = [];
    const emptyMessages = [];
    const openedLandings = [];
    const landingErrors = [];
    let currentTimeline = null;

    timelineStore.bindRequestActions({
      onRequestTimeline(payload) {
        sent.push(payload);
        return true;
      },
    });
    timelineStore.bindDetailActions({
      onOpenSelectedLanding(event) {
        openedLandings.push(event);
        return true;
      },
      onFlightLandingLoadError(error) {
        landingErrors.push(error);
      },
    });

    const runtime = createTimelineRuntime({
      windowRef,
      subscribeWsMessageSignal(handler) {
        wsHandlers.add(handler);
        return () => wsHandlers.delete(handler);
      },
      timelineStore,
      timelinePage: {
        loadTimeline(timeline) {
          currentTimeline = timeline;
          loadedFlightIds.push(timeline.flightId);
          timelineStore.setLoadedTimelineIdentity(timeline);
        },
        getCurrentTimeline() {
          return currentTimeline;
        },
        showEmpty({ message } = {}) {
          emptyMessages.push(message);
        },
      },
      timelineMapController: {
        invalidateSizeStaggered() {},
        render() {},
      },
    });

    runtime.init();
    assert.equal(timelineStore.requestTimeline('C:/Flights/old.csv', 'OLD', { openViewer: false }), true);
    assert.equal(timelineStore.requestTimeline('C:/Flights/new.csv', 'NEW', { openViewer: false }), true);
    const oldRequest = sent[0];
    const newRequest = sent[1];
    assert.deepEqual(
      sent.slice(0, 2).map((payload) => payload.requestId),
      [1, 2],
      'ordinary Timeline requests should share one monotonic correlation sequence',
    );

    for (const handler of wsHandlers) handler({
      type: 'timeline',
      scoringMode: 'recorded',
      requestId: newRequest.requestId,
      timeline: { filePath: newRequest.filePath, flightId: 'NEW', events: [] },
    });
    for (const handler of wsHandlers) handler({
      type: 'timeline',
      scoringMode: 'recorded',
      requestId: oldRequest.requestId,
      timeline: { filePath: oldRequest.filePath, flightId: 'OLD', events: [] },
    });

    assert.deepEqual(loadedFlightIds, ['NEW'], 'a late older success must not replace the newer replay');
    assert.equal(timelineStore.loadedTimelineFlightId, 'NEW', 'the selected Timeline identity must remain on the newer flight');

    assert.equal(timelineStore.requestTimeline('C:/Flights/error.csv', 'ERROR', { openViewer: false }), true);
    const staleErrorRequest = sent[2];
    const requestedLanding = {
      id: 'landing-newest',
      type: 'landing',
      timestampMs: 4000,
      grade: 'PERFECT',
    };
    assert.equal(timelineStore.requestFlightLanding({
      filePath: 'C:/Flights/debrief.csv',
      flightId: 'DEBRIEF',
      origin: 'YSSY',
      destination: 'YMML',
      latestLandingEvent: requestedLanding,
    }), true);
    const debriefRequest = sent[3];
    assert.equal(debriefRequest.requestId, 4, 'landing-detail loads should use the same normal Timeline request sequence');
    assert.equal(timelineStore.timelineLoadStatus, 'loading');

    for (const handler of wsHandlers) handler({
      type: 'timelineError',
      scoringMode: 'recorded',
      requestId: staleErrorRequest.requestId,
      error: 'late failure for superseded flight',
    });

    assert.equal(timelineStore.timelineLoadStatus, 'loading', 'a stale error must not clear the newer loading state');
    assert.deepEqual(emptyMessages, [], 'a stale error must not replace the newer replay with an error state');
    assert.deepEqual(landingErrors, [], 'a stale error must not fail the newer pending debrief');
    assert.ok(timelineStore.pendingFlightLandingRequest, 'the newer pending debrief should survive a stale error');

    for (const handler of wsHandlers) handler({
      type: 'timeline',
      scoringMode: 'recorded',
      requestId: debriefRequest.requestId,
      timeline: {
        filePath: debriefRequest.filePath,
        flightId: 'DEBRIEF',
        events: [{ ...requestedLanding }],
      },
    });

    assert.deepEqual(loadedFlightIds, ['NEW', 'DEBRIEF'], 'the current debrief response should still load normally');
    assert.deepEqual(openedLandings.map((event) => event.id), ['landing-newest'], 'only the current response should open the pending debrief');
    assert.equal(timelineStore.pendingFlightLandingRequest, null, 'the current response should consume the pending debrief once');
    assert.deepEqual(emptyMessages, []);
    assert.deepEqual(landingErrors, []);

    runtime.cleanup();
  });

  await test('normal timeline load retains its canonical path through full-analysis preview, apply, refresh, and revert', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());

    const wsHandlers = new Set();
    const sent = [];
    let loadedTimelineCount = 0;
    const recordingPath = 'C:/Flight Logs/2026-08-08_01-02-03Z--abcd1234/telemetry.csv';
    const recordingFlightId = '2026-08-08T01:02:03.000Z';
    const recordedLanding = {
      id: 'landing-preview',
      type: 'landing',
      timestampMs: 1000,
      landingKey: '7',
      grade: 'GOOD',
    };
    const runtime = createTimelineRuntime({
      windowRef,
      subscribeWsMessageSignal(handler) {
        wsHandlers.add(handler);
        return () => wsHandlers.delete(handler);
      },
      timelineStore,
      timelinePage: {
        loadTimeline(timeline) {
          loadedTimelineCount += 1;
          timelineStore.setLoadedTimelineIdentity(timeline);
          timelineStore.setDetail({
            visible: true,
            type: 'Landing',
            selectedLandingEvent: timeline.events[0],
          });
        },
        showEmpty() {},
      },
      timelineMapController: {
        invalidateSizeStaggered() {},
        render() {},
      },
    });
    timelineStore.bindRequestActions({
      onRequestTimeline(payload) {
        sent.push(payload);
        return true;
      },
      onRequestList(payload) {
        sent.push(payload);
        return true;
      },
    });

    runtime.init();
    assert.equal(
      timelineStore.requestTimeline(recordingPath, recordingFlightId, { openViewer: false }),
      true,
      'the initial recorded replay should start through the correlated normal request path',
    );
    assert.deepEqual(sent[0], {
      type: 'requestTimeline',
      filePath: recordingPath,
      flightId: recordingFlightId,
      requestId: 1,
    });
    for (const handler of wsHandlers) handler({
      type: 'timeline',
      scoringMode: 'recorded',
      requestId: sent[0].requestId,
      timeline: {
        filePath: recordingPath,
        flightId: recordingFlightId,
        analysisRescore: { applied: false, revision: 0 },
        events: [recordedLanding],
      },
    });
    assert.equal(loadedTimelineCount, 1, 'the ordinary recorded timeline should load first');
    assert.equal(timelineStore.loadedTimelineFilePath, recordingPath);
    assert.equal(timelineStore.requestAnalysisRescorePreview(), true);
    assert.deepEqual(sent[1], {
      type: 'requestTimeline',
      filePath: recordingPath,
      flightId: recordingFlightId,
      requestId: 1,
      scoringMode: 'current-preview',
    });
    for (const handler of wsHandlers) handler({
      type: 'timeline',
      scoringMode: 'current-preview',
      requestId: 1,
      timeline: {
        analysisRescorePreview: {
          available: true,
          previewFingerprint: 'preview-fingerprint',
          baseRevision: 0,
          sourceFingerprint: 'source-fingerprint',
          analysisContractFingerprint: 'contract-fingerprint',
          changedMetricCount: 2,
          landingCount: 1,
          landings: [{
            landingKey: '7',
            label: 'Landing 1',
            metrics: [
              { key: 'touchdown-rate', label: 'Touchdown rate', recorded: 'GOOD', current: 'FIRM', changed: true },
              { key: 'stability', label: 'Approach stability', recorded: 'Stable 86%', current: 'Unstable 72%', changed: true },
            ],
          }],
        },
      },
    });

    assert.equal(loadedTimelineCount, 1, 'preview responses must not replace the recorded timeline');
    assert.equal(timelineStore.analysisRescorePreviewStatus, 'ready');
    assert.equal(timelineStore.analysisRescorePreview?.changedMetricCount, 2);

    assert.equal(timelineStore.applyCurrentFlightAnalysisRescore(), true);
    assert.deepEqual(sent[2], {
      type: 'applyFlightAnalysisRescore',
      filePath: recordingPath,
      flightId: recordingFlightId,
      requestId: 1,
      previewFingerprint: 'preview-fingerprint',
      baseRevision: 0,
      sourceFingerprint: 'source-fingerprint',
      analysisContractFingerprint: 'contract-fingerprint',
    });
    for (const handler of wsHandlers) handler({
      type: 'flightAnalysisRescoreResult',
      requestId: 1,
      action: 'apply',
      success: true,
      revision: 3,
      appliedAt: '2026-08-08T00:00:00.000Z',
      snapshotFingerprint: 'saved-snapshot-3',
    });
    assert.equal(timelineStore.analysisRescoreStatus, 'refreshing');
    assert.equal(loadedTimelineCount, 1, 'mutation result itself must not replace the replay');
    assert.deepEqual(sent[3], {
      type: 'requestTimeline',
      filePath: recordingPath,
      flightId: recordingFlightId,
      requestId: 2,
    }, 'the effective Timeline should refresh after the atomic save');
    assert.equal(sent[4].type, 'requestTimelineList', 'the saved-flight list and history index should refresh');
    assert.deepEqual(sent[5], { type: 'requestLogbook', limit: 500 }, 'Logbook should refresh after the atomic save');

    for (const handler of wsHandlers) handler({
      type: 'timeline',
      scoringMode: 'recorded',
      requestId: sent[3].requestId,
      timeline: {
        filePath: recordingPath,
        flightId: recordingFlightId,
        analysisRescore: {
          applied: true,
          revision: 3,
          appliedAt: '2026-08-08T00:00:00.000Z',
          snapshotFingerprint: 'saved-snapshot-3',
        },
        events: [{ ...recordedLanding, grade: 'FIRM', analysisSource: 'applied-rescore' }],
      },
    });
    assert.equal(loadedTimelineCount, 2, 'the refreshed effective Timeline should load after saving');
    assert.equal(timelineStore.analysisRescoreStatus, 'applied');
    assert.equal(timelineStore.analysisRescore.applied, true);

    assert.equal(timelineStore.revertFlightAnalysisRescore(), true);
    assert.deepEqual(sent[6], {
      type: 'revertFlightAnalysisRescore',
      filePath: recordingPath,
      flightId: recordingFlightId,
      requestId: 2,
      expectedRevision: 3,
      expectedSnapshotFingerprint: 'saved-snapshot-3',
    });
    for (const handler of wsHandlers) handler({
      type: 'flightAnalysisRescoreResult',
      requestId: 2,
      action: 'revert',
      success: true,
      revision: 4,
      reverted: true,
    });
    assert.equal(timelineStore.analysisRescoreStatus, 'refreshing');
    assert.deepEqual(sent[7], {
      type: 'requestTimeline',
      filePath: recordingPath,
      flightId: recordingFlightId,
      requestId: 3,
    });
    assert.equal(sent[8].type, 'requestTimelineList');
    assert.deepEqual(sent[9], { type: 'requestLogbook', limit: 500 });
    for (const handler of wsHandlers) handler({
      type: 'timeline',
      scoringMode: 'recorded',
      requestId: sent[7].requestId,
      timeline: {
        filePath: recordingPath,
        flightId: recordingFlightId,
        analysisRescore: { applied: false, revision: 4 },
        events: [recordedLanding],
      },
    });
    assert.equal(timelineStore.analysisRescoreStatus, 'reverted');
    assert.equal(timelineStore.analysisRescore.applied, false);
    assert.equal(loadedTimelineCount, 3, 'revert should reload the original recorded replay');

    runtime.cleanup();
  });

  await test('timeline map visibility treats the open replay modal as renderable', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const tabsStore = useTabsStore();
    const mapEl = new FakeElement('timeline-map');
    mapEl.offsetParent = null;
    mapEl.clientWidth = 960;
    mapEl.clientHeight = 420;

    tabsStore.setActiveTab('livemap');
    assert.equal(
      isTimelineMapElementVisible({ tabsStore, timelineStore, mapEl }),
      false,
      'hidden timeline tab without an open modal should not initialize the replay map',
    );

    timelineStore.openTimelineMobileViewer();
    assert.equal(
      isTimelineMapElementVisible({ tabsStore, timelineStore, mapEl }),
      true,
      'open timeline modal with a real viewport should initialize the replay map even if offsetParent is null',
    );

    mapEl.clientWidth = 0;
    mapEl.clientHeight = 0;
    assert.equal(
      isTimelineMapElementVisible({ tabsStore, timelineStore, mapEl }),
      false,
      'open timeline modal should still wait for a measurable map viewport',
    );
  });

  console.log('\n--- timeline replay state bridge ---\n');
  await test('timeline scrubber publishes range and label state through the timeline store', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const scrubberEl = new FakeElement('timeline-time-scrubber', { tagName: 'INPUT' });
    const scrubbedOffsets = [];

    const scrubber = createScrubber({
      scrubberEl,
      timelineStore,
      onScrub(_point, offsetMs) {
        scrubbedOffsets.push(offsetMs);
      },
    });

    assert.equal(timelineStore.scrubActionBound, true, 'scrubber should bind the Vue-owned replay action bridge when a timeline store is present');
    assert.equal(scrubber.setPoints([
      { lat: -33.9, lon: 151.2, timestampMs: 1000, altFt: 1200 },
      { lat: -33.91, lon: 151.21, timestampMs: 31000, altFt: 600 },
    ]), true, 'scrubber should accept timelines with at least two points');

    assert.equal(timelineStore.scrubberVisible, true, 'setPoints should reveal the scrubber through the store');
    assert.equal(timelineStore.scrubberDisabled, false, 'setPoints should enable the scrubber through the store');
    assert.equal(timelineStore.scrubberMax, '30000', 'setPoints should publish the scrubber duration');
    assert.equal(timelineStore.scrubberCurrentLabel, '0:00', 'setPoints should reset the current scrubber label');
    assert.equal(timelineStore.scrubberEndLabel, '0:30', 'setPoints should publish the end scrubber label');

    assert.equal(
      timelineStore.requestScrubOffset('15000', { shouldPanMap: false }),
      true,
      'store-backed scrub requests should route through the scrubber bridge',
    );
    assert.equal(timelineStore.scrubberValue, '15000', 'store-backed scrub requests should publish the current offset through the store');
    assert.equal(timelineStore.scrubberCurrentLabel, '0:15', 'store-backed scrub requests should publish the current time label');
    assert.deepEqual(scrubbedOffsets, [15000], 'store-backed scrub requests should continue to drive the replay callback');

    scrubber.syncToTimestamp(21000);
    assert.equal(timelineStore.scrubberValue, '20000', 'syncToTimestamp should publish the derived scrubber value');
    assert.equal(timelineStore.scrubberCurrentLabel, '0:20', 'syncToTimestamp should publish the derived current label');

    scrubber.setPoints([]);
    assert.equal(timelineStore.scrubberVisible, false, 'empty scrubber points should hide the scrubber through the store');
    assert.equal(timelineStore.scrubberDisabled, true, 'empty scrubber points should disable the scrubber through the store');
    assert.equal(timelineStore.scrubberValue, '0', 'empty scrubber points should reset the scrubber value');

    scrubber.cleanup();
    assert.equal(timelineStore.scrubActionBound, false, 'scrubber cleanup should unbind the store-backed replay action');
    assert.equal(timelineStore.requestScrubOffset('15000'), false, 'scrubber cleanup should prevent stale replay requests');
  });

  await test('timeline scrubber coalesces deferred replay paints to animation frames', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const scrubberEl = new FakeElement('timeline-time-scrubber', { tagName: 'INPUT' });
    const queuedFrames = [];
    const cancelledFrames = new Set();
    let nextFrameId = 1;
    const scrubbedOffsets = [];

    const scrubber = createScrubber({
      scrubberEl,
      timelineStore,
      windowRef: {
        requestAnimationFrame(callback) {
          const frameId = nextFrameId;
          nextFrameId += 1;
          queuedFrames.push({ frameId, callback });
          return frameId;
        },
        cancelAnimationFrame(frameId) {
          cancelledFrames.add(frameId);
        },
      },
      onScrub(_point, offsetMs, shouldPanMap) {
        scrubbedOffsets.push({ offsetMs, shouldPanMap });
      },
    });

    scrubber.setPoints([
      { lat: -33.9, lon: 151.2, timestampMs: 1000, altFt: 1200 },
      { lat: -33.91, lon: 151.21, timestampMs: 11000, altFt: 1000 },
      { lat: -33.92, lon: 151.22, timestampMs: 31000, altFt: 600 },
    ]);

    assert.equal(timelineStore.requestScrubOffset('10000', {
      shouldPanMap: false,
      deferRender: true,
    }), true, 'deferred scrub requests should route through the replay bridge');
    assert.equal(timelineStore.requestScrubOffset('20000', {
      shouldPanMap: false,
      deferRender: true,
    }), true, 'later deferred scrubs should replace pending work');
    assert.equal(queuedFrames.length, 1, 'rapid deferred scrub requests should schedule one frame');
    assert.deepEqual(scrubbedOffsets, [], 'deferred scrub requests should wait for the scheduled paint');
    assert.equal(timelineStore.scrubberValue, '0', 'deferred scrubs should not force reactive slider state before paint');

    queuedFrames.shift().callback();
    assert.deepEqual(scrubbedOffsets, [
      { offsetMs: 20000, shouldPanMap: false },
    ], 'scheduled scrub paint should use the latest requested offset');
    assert.equal(timelineStore.scrubberValue, '20000', 'scheduled scrub paint should publish the latest offset');
    assert.equal(timelineStore.scrubberCurrentLabel, '0:20', 'scheduled scrub paint should publish the latest label');

    assert.equal(timelineStore.requestScrubOffset('5000', {
      shouldPanMap: false,
      deferRender: true,
    }), true, 'a new deferred scrub should schedule another frame');
    assert.equal(queuedFrames.length, 1, 'new deferred scrub should wait for one frame');
    assert.equal(timelineStore.requestScrubOffset('15000', {
      shouldPanMap: false,
    }), true, 'committed scrub requests should flush immediately');
    assert.deepEqual(scrubbedOffsets, [
      { offsetMs: 20000, shouldPanMap: false },
      { offsetMs: 15000, shouldPanMap: false },
    ], 'committed scrub should cancel stale deferred work');
    assert.equal(cancelledFrames.has(2), true, 'committed scrub should cancel the pending animation frame');

    queuedFrames.shift().callback();
    assert.deepEqual(scrubbedOffsets, [
      { offsetMs: 20000, shouldPanMap: false },
      { offsetMs: 15000, shouldPanMap: false },
    ], 'cancelled deferred frames should not replay stale cursor state');

    scrubber.cleanup();
  });

  await test('timeline altitude profile builds a scrubber-synced side profile state', () => {
    const profile = buildTimelineAltitudeProfileState([
      { timestampMs: 1000, altFt: 1200 },
      { timestampMs: 16000, altFt: 900 },
      { timestampMs: 31000, altFt: 600 },
    ], {
      startMs: 1000,
      endMs: 31000,
      offsetMs: 15000,
    });

    assert.equal(profile.visible, true, 'profile should be visible when at least two altitude samples are available');
    assert.match(profile.pathD, /^M 22 /, 'profile path should start at the plot origin padding');
    assert.match(profile.fillD, /^M 22 78 /, 'profile fill should close against the plot baseline');
    assert.equal(profile.cursorVisible, true, 'profile cursor should be visible for interpolated altitude samples');
    assert.equal(profile.currentText, '900 ft', 'profile current altitude should interpolate from the scrubber offset');
    assert.equal(profile.minText, '600 ft', 'profile should expose the minimum altitude label');
    assert.equal(profile.maxText, '1,200 ft', 'profile should expose the maximum altitude label');
    assert.equal(Number(profile.cursorX) > 300 && Number(profile.cursorX) < 350, true, 'profile cursor x should track the scrubber offset');

    const emptyProfile = buildTimelineAltitudeProfileState([
      { timestampMs: 1000, altFt: null },
      { timestampMs: 31000, altFt: null },
    ], {
      startMs: 1000,
      endMs: 31000,
      offsetMs: 15000,
    });
    assert.equal(emptyProfile.visible, false, 'profile should hide when the timeline has no altitude samples');
    assert.equal(emptyProfile.pathD, '', 'empty profile should not expose stale SVG path data');
  });

  await test('timeline map controller publishes unavailable-map copy through the timeline store', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const timelineMapController = createTimelineMapController({
      mapEl: new FakeElement('timeline-map'),
      timelineStore,
      windowRef: {},
      isTimelineTabVisible: () => true,
      getEventPosition: () => null,
    });

    timelineMapController.render({ events: [] });
    assert.equal(timelineStore.mapEmptyVisible, true, 'missing Leaflet should keep the replay empty-state visible');
    assert.equal(timelineStore.mapEmptyMessage, 'Map unavailable (Leaflet failed to load)', 'missing Leaflet should publish the unavailable-map copy');
  });

  await test('timeline map controller retries stale Leaflet containers instead of leaving a black map', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const mapEl = new FakeElement('timeline-map');
    mapEl.clientWidth = 640;
    mapEl.clientHeight = 360;
    mapEl._leaflet_id = 99;

    let mapCalls = 0;
    const fakeMap = {
      setView() { return this; },
      getSize() { return { x: 640, y: 360 }; },
      invalidateSize() {},
      removeLayer() {},
      getZoom() { return 11; },
      panTo() {},
      fitBounds() {},
    };
    const fakeL = {
      canvas: () => ({ renderer: 'canvas' }),
      map() {
        mapCalls += 1;
        if (mapCalls === 1) throw new Error('Map container is already initialized.');
        return fakeMap;
      },
      tileLayer: () => ({
        on() { return this; },
        addTo() { return this; },
      }),
      DomEvent: {
        disableScrollPropagation() {},
        disableClickPropagation() {},
      },
      divIcon: (options) => options,
      marker: () => ({
        addTo() { return this; },
        bindTooltip() { return this; },
        on() { return this; },
      }),
      polyline: () => ({
        addTo() { return this; },
      }),
      layerGroup: () => ({
        addTo() { return this; },
        clearLayers() {},
      }),
      latLngBounds: () => ({
        pad() { return this; },
      }),
    };

    const controller = createTimelineMapController({
      mapEl,
      timelineStore,
      windowRef: {
        L: fakeL,
        requestAnimationFrame: (fn) => {
          if (typeof fn === 'function') fn();
          return 1;
        },
        cancelAnimationFrame() {},
        setTimeout: (fn) => {
          if (typeof fn === 'function') fn();
          return 1;
        },
        clearTimeout() {},
      },
      isTimelineTabVisible: () => true,
      isValidCoord: (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon),
      getEventPosition: (event) => event?.pos || null,
      createTimelineEventIcon: () => ({ className: 'event-icon' }),
      eventPassesMapFilter: () => true,
    });

    controller.render({
      flightId: 'STALE-CONTAINER',
      events: [],
      track: [{ lat: 1, lon: 2, timestampMs: 1000 }],
    });

    assert.equal(mapCalls, 2, 'stale Leaflet containers should be retried once after clearing the old id');
    assert.equal(timelineStore.mapEmptyVisible, false, 'successful retry should allow replay data to hide the empty overlay');
    assert.equal(controller.hasMap(), true, 'successful retry should leave the timeline map initialized');
  });

  await test('timeline map redraws keep the replay cursor separate from heavy data layers', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const mapEl = new FakeElement('timeline-map');
    mapEl.clientWidth = 640;
    mapEl.clientHeight = 360;

    const removedLayers = [];
    const clearLayerCalls = [];
    const tileLayerUrls = [];
    let cursorLayer = null;
    let mapSize = { x: 640, y: 360 };
    let fitBoundsCalls = 0;
    const fakeMap = {
      setView() { return this; },
      getSize() { return mapSize; },
      invalidateSize() {
        mapSize = { x: mapEl.clientWidth, y: mapEl.clientHeight };
      },
      removeLayer(layer) {
        removedLayers.push(layer);
      },
      getZoom() { return 11; },
      panTo() {},
      fitBounds() {
        fitBoundsCalls += 1;
      },
    };
    const fakeL = {
      canvas: () => ({ renderer: 'canvas' }),
      map: () => fakeMap,
      tileLayer: (url) => {
        tileLayerUrls.push(url);
        return {
          on() { return this; },
          addTo() { return this; },
        };
      },
      DomEvent: {
        disableScrollPropagation() {},
        disableClickPropagation() {},
      },
      divIcon: (options) => options,
      marker: (_latlng, options = {}) => {
        const marker = {
          options,
          addTo() { return this; },
          setLatLng() {},
          getElement() {
            return { querySelector: () => ({ style: {} }) };
          },
          bindTooltip() { return this; },
          on() { return this; },
        };
        if (options.icon?.className === 'timeline-plane-icon') cursorLayer = marker;
        return marker;
      },
      polyline: () => ({
        addTo() { return this; },
      }),
      layerGroup: () => ({
        addTo() { return this; },
        clearLayers() { clearLayerCalls.push('clear'); },
      }),
      latLngBounds: () => ({
        pad() { return this; },
      }),
    };
    const controller = createTimelineMapController({
      mapEl,
      timelineStore,
      windowRef: {
        L: fakeL,
        requestAnimationFrame: (fn) => {
          if (typeof fn === 'function') fn();
          return 1;
        },
        cancelAnimationFrame() {},
        setTimeout: (fn) => {
          if (typeof fn === 'function') fn();
          return 1;
        },
        clearTimeout() {},
      },
      isTimelineTabVisible: () => true,
      isValidCoord: (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon),
      getEventPosition: (event) => event?.pos || null,
      createTimelineEventIcon: () => ({ className: 'event-icon' }),
      eventPassesMapFilter: () => true,
    });

    const baseTimeline = {
      flightId: 'CURSOR-KEEPER',
      events: [{ type: 'landing', timestampMs: 1000, pos: { lat: 1, lon: 2 } }],
      track: [{ lat: 1, lon: 2, timestampMs: 1000, hdgTrueDeg: 90 }],
    };
    controller.render(baseTimeline);
    assert.match(tileLayerUrls[0] || '', /basemaps\.cartocdn\.com\/dark_all/, 'timeline replay map should prefer dark CARTO tiles for readable overlays by default');
    const initialFitBoundsCalls = fitBoundsCalls;
    mapEl.clientWidth = 900;
    mapEl.clientHeight = 520;
    controller.render(baseTimeline);
    assert.equal(fitBoundsCalls, initialFitBoundsCalls + 1, 'unchanged timeline data should refit bounds after the map viewport changes');
    controller.focusEvent(baseTimeline.events[0]);
    assert.ok(cursorLayer, 'focusEvent should create the replay cursor marker');

    controller.render({
      ...baseTimeline,
      events: [
        ...baseTimeline.events,
        { type: 'violation_start', timestampMs: 2000, pos: { lat: 1.1, lon: 2.1 } },
      ],
    });
    assert.equal(clearLayerCalls.length > 0, true, 'data layer redraw should clear grouped event markers');
    assert.equal(removedLayers.includes(cursorLayer), false, 'data layer redraw should not remove the replay cursor');

    controller.reset();
    assert.equal(removedLayers.includes(cursorLayer), true, 'full map reset should still remove the replay cursor');
  });

  await test('timeline map helpers cap visual-only Leaflet work without trimming replay data', () => {
    const points = Array.from({ length: 1000 }, (_, index) => ({
      lat: 10 + index * 0.01,
      lon: 20 + index * 0.01,
      timestampMs: index * 1000,
    }));
    const sampled = downsampleTimelineMapTrackPoints(points, 50);
    const defaultSampled = downsampleTimelineMapTrackPoints(points);

    assert.equal(sampled.length, 50, 'map polyline samples should be capped for Leaflet rendering');
    assert.equal(defaultSampled.length, 700, 'default map polyline rendering should stay aggressively capped for drag performance');
    assert.equal(sampled[0], points[0], 'map polyline sampling should retain the first replay point');
    assert.equal(sampled.at(-1), points.at(-1), 'map polyline sampling should retain the final replay point');
    assert.equal(points.length, 1000, 'visual downsampling must not mutate the full replay track');

    assert.equal(getTimelineMapTrackPointLimit(4), 700, 'whole-flight zoom should retain the fast base track budget');
    assert.equal(getTimelineMapTrackPointLimit(7), 1500, 'regional zoom should expose additional track detail');
    assert.equal(getTimelineMapTrackPointLimit(10), 2500, 'close zoom should expose the maximum bounded track detail');

    const boundsSampled = downsampleTimelineMapBoundsPoints([
      ...points,
      { lat: -40, lon: 25, timestampMs: 1000001 },
      { lat: 80, lon: 26, timestampMs: 1000002 },
      { lat: 12, lon: -170, timestampMs: 1000003 },
      { lat: 13, lon: 170, timestampMs: 1000004 },
    ], 80);
    assert.equal(boundsSampled.length <= 80, true, 'map bounds samples should stay capped for large replay tracks');
    assert.equal(boundsSampled.some((point) => point.lat === -40), true, 'map bounds sampling should retain the minimum latitude');
    assert.equal(boundsSampled.some((point) => point.lat === 80), true, 'map bounds sampling should retain the maximum latitude');
    assert.equal(boundsSampled.some((point) => point.lon === -170), true, 'map bounds sampling should retain the minimum longitude');
    assert.equal(boundsSampled.some((point) => point.lon === 170), true, 'map bounds sampling should retain the maximum longitude');

    const positioned = Array.from({ length: 900 }, (_, index) => ({
      originalIndex: index,
      event: { type: index === 850 ? 'landing' : index % 3 === 0 ? 'violation_start' : 'phase_start' },
      pos: { lat: 1, lon: 2 },
    }));
    const selected = selectTimelineMapEventMarkers(positioned, 120);
    const defaultSelected = selectTimelineMapEventMarkers(positioned);

    assert.equal(selected.length, 120, 'map event markers should be capped');
    assert.equal(defaultSelected.length, 160, 'default map event marker rendering should stay capped for drag performance');
    assert.equal(
      selected.some((item) => item.event.type === 'landing'),
      true,
      'important landing markers should survive marker capping',
    );
    assert.equal(
      selected.every((item, index) => index === 0 || item.originalIndex >= selected[index - 1].originalIndex),
      true,
      'selected marker order should remain chronological',
    );

    assert.equal(
      findNearestTimelineTrackPoint(points, points.map((point) => point.timestampMs), 42250, true),
      points[42],
      'nearest-track lookup should use timestamp proximity for sorted tracks',
    );
    const unsorted = [points[30], points[10], points[20]];
    assert.equal(
      findNearestTimelineTrackPoint(unsorted, unsorted.map((point) => point.timestampMs), 19500, false),
      points[20],
      'nearest-track lookup should safely fall back for unsorted tracks',
    );
  });

  await test('timeline map spatial sampling preserves a short turn in a long flight', () => {
    const turnStart = 2970;
    const turnLength = 60;
    const track = Array.from({ length: 6000 }, (_, index) => {
      const turnProgress = (index - turnStart) / turnLength;
      const turnOffset = turnProgress >= 0 && turnProgress <= 1
        ? Math.sin(turnProgress * Math.PI) * 0.04
        : 0;
      return {
        lat: -37 + turnOffset,
        lon: 144 + index * 0.0005,
        timestampMs: index * 2000,
      };
    });
    const sampled = downsampleTimelineMapTrackPoints(track, 100);
    const retainedTurnOffsets = sampled.map((point) => point.lat + 37);

    assert.equal(sampled.length, 100, 'long-flight path work should remain strictly bounded');
    assert.equal(
      Math.max(...retainedTurnOffsets) > 0.035,
      true,
      'geometry-aware sampling should retain the apex of a brief turn instead of flattening it into cruise',
    );
    assert.equal(sampled[0], track[0], 'turn-preserving sampling should retain departure');
    assert.equal(sampled.at(-1), track.at(-1), 'turn-preserving sampling should retain arrival');
  });

  await test('timeline map reveals cached bounded path detail after zooming in', () => {
    setActivePinia(createPinia());
    const timelineStore = useTimelineStore();
    const mapEl = new FakeElement('timeline-map');
    mapEl.clientWidth = 640;
    mapEl.clientHeight = 360;

    let zoom = 4;
    let zoomEndHandler = null;
    let polylineOptions = null;
    const renderedPathLengths = [];
    const fakeMap = {
      setView() { return this; },
      getSize() { return { x: 640, y: 360 }; },
      invalidateSize() {},
      removeLayer() {},
      getZoom() { return zoom; },
      panTo() {},
      fitBounds() {},
      on(eventName, handler) {
        if (eventName === 'zoomend') zoomEndHandler = handler;
        return this;
      },
    };
    const fakeL = {
      canvas: () => ({ renderer: 'canvas' }),
      map: () => fakeMap,
      tileLayer: () => ({
        on() { return this; },
        addTo() { return this; },
      }),
      DomEvent: {
        disableScrollPropagation() {},
        disableClickPropagation() {},
      },
      polyline: (latLngs, options) => {
        polylineOptions = options;
        renderedPathLengths.push(latLngs.length);
        return {
          addTo() { return this; },
          setLatLngs(nextLatLngs) {
            renderedPathLengths.push(nextLatLngs.length);
            return this;
          },
        };
      },
      layerGroup: () => ({
        addTo() { return this; },
        clearLayers() {},
      }),
      latLngBounds: () => ({
        pad() { return this; },
      }),
    };
    const controller = createTimelineMapController({
      mapEl,
      timelineStore,
      windowRef: {
        L: fakeL,
        requestAnimationFrame: (fn) => {
          if (typeof fn === 'function') fn();
          return 1;
        },
        cancelAnimationFrame() {},
        setTimeout: (fn) => {
          if (typeof fn === 'function') fn();
          return 1;
        },
        clearTimeout() {},
      },
      isTimelineTabVisible: () => true,
      isValidCoord: (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon),
      getEventPosition: () => null,
      createTimelineEventIcon: () => ({ className: 'event-icon' }),
      eventPassesMapFilter: () => true,
    });
    const track = Array.from({ length: 3000 }, (_, index) => ({
      lat: -34 + (index % 2 === 0 ? 0 : 0.01),
      lon: 140 + index * 0.001,
      timestampMs: index * 2000,
    }));

    controller.render({ flightId: 'ZOOM-DETAIL', events: [], track });
    assert.equal(renderedPathLengths[0], 700, 'whole-flight rendering should start with the base path budget');
    assert.equal(polylineOptions?.smoothFactor, 1, 'Leaflet should not aggressively simplify the already-bounded route');
    assert.equal(typeof zoomEndHandler, 'function', 'timeline maps should listen for settled zoom changes');

    zoom = 7;
    zoomEndHandler();
    zoom = 10;
    zoomEndHandler();

    assert.deepEqual(
      renderedPathLengths,
      [700, 1500, 2500],
      'zooming in should reveal progressively detailed paths without exceeding the maximum render budget',
    );
  });

  console.log('\n--- timeline inspector store bridge ---\n');
  await test('timeline page controller publishes inspector rows and detail selection through the store', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const timelineStore = useTimelineStore();
    const focusedEvents = [];
    const timelineMapController = {
      focusEvent(event) {
        focusedEvents.push(event);
      },
      render() {
        return [];
      },
      reset() {},
    };

    const page = createTimelinePageController({
      timelineStore,
      timelineMapController,
      normalizeTimelineForUI: (timeline) => timeline,
      compactTimelineEvents: (events) => events,
      buildTimelineSummaryState: () => ({
        visible: true,
        eventCountText: '2',
        violationCountText: '0',
        durationText: '1m 0s',
        fuelBurnText: '--',
        fuelBurnClass: 'font-semibold text-gray-500',
        scoreImpactText: '0',
        scoreImpactClass: 'font-semibold text-gray-400',
      }),
      buildTimelineEventDetailState: (event) => ({
        visible: true,
        type: event.type,
        title: event.type === 'landing' ? 'Landing at YSSY 34L' : 'Phase: APPROACH',
        metricSections: [{
          key: 'event-context',
          title: 'Event Details',
          rows: [{ key: 'type', label: 'Type', value: event.type }],
          noteText: '',
          emptyText: '',
        }],
        approachProfileHtml: '',
        landingActionVisible: event.type === 'landing',
        selectedLandingEvent: event.type === 'landing' ? event : null,
      }),
      buildTimelineEventRows: (events) => events.map((event, index) => ({
        rowKey: `row-${index}`,
        event,
        index,
        type: event.type === 'landing' ? 'marker' : 'phase',
        title: event.type === 'landing' ? 'Landing at YSSY 34L' : 'APPROACH',
        subtitle: '',
        timeOffsetText: `00:0${index}`,
        badges: [],
        countText: '',
        originalIndexStart: index,
        originalIndexEnd: index,
      })),
      formatTimeOffset: (ms) => `${ms}ms`,
      getEventPosition: (event) => (event.hasPos ? { lat: -33.9, lon: 151.2 } : null),
      setupTimelineScrubber: () => {},
      scrubToOffset: () => {},
      getTimelineScrubberPointsLength: () => 0,
      resetScrubberUi: () => {},
      buildDurationText: () => '1m 0s',
      getApproachProfileApi: () => null,
    });

    page.loadTimeline({
      flightId: 'F1',
      route: 'YSSY-KJFK',
      aircraft: 'Standard Cabin',
      aircraftProfileId: 'inibuilds-tristar',
      events: [
        { type: 'phase_start', timestampMs: 1000, newPhase: 'APPROACH', hasPos: true },
        { type: 'landing', timestampMs: 2000, runway: { airport_icao: 'YSSY', runway_id: '34L' } },
      ],
      worstMoment: { index: 1 },
    });

    assert.equal(timelineStore.inspectorFlightIdText, '1m 0s', 'timeline controller should publish duration without repeating the route');
    assert.equal(timelineStore.inspectorRouteText, 'YSSY-KJFK', 'timeline controller should publish route text into the store');
    assert.equal(timelineStore.loadedTimelineAircraftLabel, 'Standard Cabin', 'timeline controller should preserve the saved aircraft type for the replay header');
    assert.equal(timelineStore.loadedTimelineAircraftProfileId, 'inibuilds-tristar', 'timeline controller should preserve the recorded profile id for deterministic artwork');
    assert.equal(timelineStore.inspectorRows.length, 2, 'timeline controller should publish event rows into the store');
    assert.equal(Object.hasOwn(timelineStore.inspectorRows[1] || {}, 'isWorstMoment'), false, 'timeline controller should ignore legacy worst-moment metadata');
    assert.equal(focusedEvents[0].type, 'phase_start', 'timeline controller should still focus the first event with a position');

    timelineStore.selectEventRow('row-1');
    assert.equal(timelineStore.inspectorSelectedRowKey, 'row-1', 'timeline row selection should persist through the store');
    assert.equal(timelineStore.detailVisible, true, 'timeline row selection should publish detail state through the store');
    assert.equal(timelineStore.detailTitle, 'Landing at YSSY 34L', 'timeline row selection should publish structured detail copy');
    assert.equal(timelineStore.detailLandingActionVisible, true, 'landing rows should continue to expose the landing handoff action');
    assert.equal(focusedEvents[focusedEvents.length - 1].type, 'landing', 'timeline row selection should still focus the selected event on the map');

    const focusCountBeforeSkip = focusedEvents.length;
    page.selectTimelineRowByOriginalIndex(0, { focusMap: false });
    assert.equal(timelineStore.inspectorSelectedRowKey, 'row-0', 'original-index selection should still select the matching row');
    assert.equal(timelineStore.detailTitle, 'Phase: APPROACH', 'original-index selection should still publish detail state');
    assert.equal(focusedEvents.length, focusCountBeforeSkip, 'original-index selection should be able to skip redundant map focus');

    page.showEmpty();
    assert.equal(timelineStore.inspectorRows.length, 0, 'showEmpty should clear inspector rows through the store');
    assert.equal(timelineStore.inspectorEmptyVisible, true, 'showEmpty should restore the empty inspector state through the store');
    assert.equal(timelineStore.detailVisible, false, 'showEmpty should clear the active detail through the store');
    assert.equal(timelineStore.mapEmptyVisible, true, 'showEmpty should restore the replay empty-state through the store');
    assert.equal(timelineStore.mapEmptyMessage, 'No positional event data yet', 'showEmpty should restore the default replay empty-state copy');

    page.showEmpty({ message: 'Could not load timeline: CSV is too large to open in Timeline (201 MB; limit is 200 MB).' });
    assert.equal(timelineStore.inspectorEmptyMessage, 'Could not load timeline: CSV is too large to open in Timeline (201 MB; limit is 200 MB).', 'showEmpty should publish custom inspector empty-state copy');
    assert.equal(timelineStore.mapEmptyMessage, 'Could not load timeline: CSV is too large to open in Timeline (201 MB; limit is 200 MB).', 'showEmpty should publish custom replay map empty-state copy');
  });

  console.log('\n--- landing timeline handoff ---\n');
  await test('timeline landing handoff opens the landing debrief modal without replacing the page', () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const tabsStore = useTabsStore();
    const landingStore = useLandingStore();
    const timelineStore = useTimelineStore();
    tabsStore.setActiveTab('timeline');

    const landingCard = documentRef.register(new FakeElement('landing-card', { classList: ['hidden'] }));
    const waitingState = documentRef.register(new FakeElement('landing-waiting-state'));
    const landingEvents = [];
    const unsubscribeLandingReceived = subscribeLandingReceived(() => {
      landingEvents.push('landing-received');
    });

    const controller = createLandingController({
      $: (id) => documentRef.getElementById(id),
      documentRef,
      windowRef,
      setText: (id, value) => {
        const element = documentRef.getElementById(id);
        if (element) element.textContent = value == null ? '' : String(value);
      },
      landingStore,
      tabsStore,
    });

    const landingEvent = {
      type: 'landing',
      vs_fpm: -467,
      grade: 'PERFECT',
      ias_kts: 136,
      pitch_deg: 3.1,
      wind_dir_deg: '',
      windDirDeg: 240,
      windSpeedKts: 14,
      xwindKts: -8,
      bounceCount: 1,
      bounceGrade: 'Single Bounce',
      runwayExcursion: true,
      shortLanding: true,
      ultimateStability: { verdict: 'unstable', score: 84, gateStable: false },
      rolloutAnalysis: {
        assessment: 'caution',
        maxBankDeg: 3.3,
        flags: [{ code: 'rollout_bank', label: 'Noticeable bank during rollout' }],
      },
      runway: {
        airport_icao: 'YSSY',
        runway_id: '34L',
        heading: 335,
        length_ft: 12000,
        width_ft: 200,
        threshold: { lat: -33.95, lon: 151.18 },
      },
    };
    timelineStore.bindDetailActions({
      onOpenSelectedLanding(event) {
        controller.showTimelineLanding(event, { openModal: true });
        return true;
      },
    });
    timelineStore.setDetail({
      visible: true,
      landingActionVisible: true,
      selectedLandingEvent: landingEvent,
    });

    assert.equal(timelineStore.detailLandingActionBound, true, 'timeline detail actions should report when the landing handoff bridge is bound');
    assert.equal(timelineStore.openSelectedLanding(), true, 'timeline landing handoff should route through the store action bridge');

    assert.equal(tabsStore.activeTabId, 'timeline', 'timeline landing action should keep the current page active');
    assert.equal(landingStore.landingModalOpen, true, 'timeline landing action should open the landing debrief modal');
    assert.equal(landingStore.cardVisible, true, 'timeline landing action should reveal the landing card through the store');
    assert.equal(landingStore.waitingVisible, false, 'timeline landing action should hide the waiting state through the store');
    assert.equal(landingStore.landingCard.rollout.visible, true, 'timeline landing handoff should preserve rollout analysis');
    assert.equal(landingStore.landingCard.rollout.assessmentText, 'CAUTION', 'timeline landing handoff should preserve rollout assessment');
    assert.equal(landingStore.landingCard.gradeText, 'PERFECT', 'bounce-only timeline handoff should preserve the scoped touchdown grade');
    assert.equal(landingStore.landingCard.approach.stabilityText, 'UNSTABLE', 'timeline handoff should preserve the approach verdict');
    assert.equal(landingStore.landingCard.wind.directionText, '240°T', 'indexed-logbook fallback should preserve true touchdown wind direction');
    assert.equal(landingStore.landingCard.wind.speedText, '14 kt', 'indexed-logbook fallback should preserve touchdown wind speed');
    assert.equal(landingStore.landingCard.wind.crosswindDetailText, 'XW 8 kt from left', 'indexed-logbook fallback should preserve runway-relative crosswind context');
    assert.equal(landingStore.landingCard.touchdown.bounceText, '1x', 'bounce-only timeline handoff should preserve top-level bounce facts');
    assert.equal(landingStore.landingCard.runwayExcursionVisible, true, 'timeline handoff should preserve the separate runway-excursion fact');
    assert(landingStore.landingCard.debrief.reasons.some((reason) => reason.text === 'Short of threshold'), 'timeline handoff should preserve the separate short-landing fact');
    assert.equal(landingCard.classList.contains('hidden'), true, 'wrapper visibility is now owned by Vue store state');
    assert.equal(waitingState.classList.contains('hidden'), false, 'waiting shell DOM is no longer toggled directly by the controller');
    assert.deepEqual(landingEvents, ['landing-received'], 'timeline landing action should emit the landing-received event');
    unsubscribeLandingReceived();
  });

  console.log('\n--- timeline detail state ---\n');
  await test('landing detail state keeps CSV-derived text as literal structured values', () => {
    const detailState = buildLandingDetailState({
      type: 'landing',
      runway: {
        runway_id: '<img src=x onerror=alert(1)>',
        length_ft: 9000,
      },
      touchdownDistance: {
        distanceFt: 900,
        grade: '<script>alert(1)</script>',
        score: 70,
      },
    });

    const snapshotSection = detailState.metricSections.find((section) => section.key === 'landing-snapshot');
    const touchdownSection = detailState.metricSections.find((section) => section.key === 'touchdown-zone-analysis');
    assert.equal(
      snapshotSection.rows.find((row) => row.key === 'runway').value,
      '<img src=x onerror=alert(1)> (9000ft)',
      'structured runway text should stay literal instead of becoming HTML',
    );
    assert.equal(
      touchdownSection.rows.find((row) => row.key === 'grade').value,
      '<script>alert(1)</script>',
      'structured touchdown grades should stay literal instead of becoming HTML',
    );
  });

  await test('landing detail state builds side-on and top-down SVGs for post-flight analysis', () => {
    const detailState = buildLandingDetailState({
      type: 'landing',
      vs_fpm: -520,
      pitch_deg: 3.1,
      centerlineDev: 1.5,
      wind_dir_deg: 245,
      wind_speed_kts: 14,
      xwind_kts: -14,
      thresholdElevFt: 500,
      runway: {
        airport_icao: 'YSSY',
        runway_id: '34L',
        heading: 335,
        threshold: { lat: -33.95, lon: 151.18 },
        length_ft: 12000,
        width_ft: 148,
      },
      touchdownDistance: {
        distanceFt: 1150,
        lateralOffsetFt: 42,
        lateralOffsetSide: 'right',
        lateralOffsetGrade: 'Good',
        grade: 'Good',
        score: 88,
      },
      approachProfile: [
        { raFt: 1200, altMslFt: 1700, vsFpm: -650, iasKts: 145, gsKts: 150, pitchDeg: 2.5, bankDeg: 1.0, headingDeg: 335, dtMs: 1000, latDeg: -33.9000, lonDeg: 151.1000 },
        { raFt: 950, altMslFt: 1450, vsFpm: -680, iasKts: 144, gsKts: 149, pitchDeg: 2.6, bankDeg: 0.8, headingDeg: 335, dtMs: 1000, latDeg: -33.9120, lonDeg: 151.1200 },
        { raFt: 720, altMslFt: 1220, vsFpm: -700, iasKts: 142, gsKts: 148, pitchDeg: 2.8, bankDeg: 0.5, headingDeg: 335, dtMs: 1000, latDeg: -33.9240, lonDeg: 151.1400 },
        { raFt: 420, altMslFt: 920, vsFpm: -640, iasKts: 140, gsKts: 145, pitchDeg: 3.0, bankDeg: 0.1, headingDeg: 335, dtMs: 1000, latDeg: -33.9380, lonDeg: 151.1600 },
        { raFt: 35, altMslFt: 535, vsFpm: -520, iasKts: 136, gsKts: 140, pitchDeg: 3.1, bankDeg: -0.8, headingDeg: 335, dtMs: 1000, latDeg: -33.9500, lonDeg: 151.1800 },
      ],
    }, { approachProfileApi });

    assert.match(detailState.approachProfileHtml, /^<svg\b/, 'post-flight detail should build the side-on approach SVG');
    assert.match(detailState.topdownProfileHtml, /^<svg\b/, 'post-flight detail should build the top-down approach SVG');
    assert.doesNotMatch(detailState.approachProfileHtml, /NaN|Infinity/, 'side-on detail SVG should not contain invalid coordinates');
    assert.doesNotMatch(detailState.topdownProfileHtml, /NaN|Infinity/, 'top-down detail SVG should not contain invalid coordinates');
    assert.match(detailState.topdownProfileHtml, /GPS pts: 5\/5/, 'top-down detail SVG should use CSV GPS profile points when available');
    assert.match(detailState.topdownProfileHtml, /RWY hdg: 335\.0/, 'top-down detail SVG should preserve runway heading');
    assert.match(detailState.topdownProfileHtml, /data-topdown-wind-vector="true"/, 'top-down detail SVG should preserve the CSV touchdown wind vector');
    assert.match(detailState.topdownProfileHtml, /data-wind-relative-deg="-90(?:\.0+)?"/, 'timeline wind vector should be runway-relative');
    assert.match(detailState.topdownProfileHtml, /data-wind-side="left"/, 'timeline wind vector should identify wind from the runway left');
    assert.match(detailState.topdownProfileHtml, /WIND FROM 245°T/, 'timeline wind vector should preserve true wind direction');
    assert.match(detailState.topdownProfileHtml, /14 kt/, 'timeline wind vector should preserve touchdown wind speed');
  });

  console.log('--- settings runtime ---\n');
  await test('settings runtime handles dirty state, leave guard, save, and reload', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    const storage = createStorage();
    resetGlobals(windowRef, documentRef, storage);
    setActivePinia(createPinia());

    const ids = [
      'settings-form',
      'setting-simconnect-protocol',
      'setting-ws-port',
      'setting-http-port',
      'setting-remote-access',
      'setting-remote-aircraft-control',
      'setting-cabin-announcements-enabled',
      'setting-cabin-announcements-style',
      'setting-cabin-announcements-startup-grace-ms',
      'settings-save-btn',
      'settings-reload-btn',
      'settings-restart-app-btn',
      'settings-pending-save-btn',
      'settings-pending-reload-btn',
    ];

    for (const id of ids) {
      documentRef.register(new FakeElement(id, {
        tagName: id === 'settings-form' ? 'FORM' : id.includes('btn') ? 'BUTTON' : 'INPUT',
      }));
    }

    const sent = [];
    const ws = {
      readyState: 1,
      send(payload) {
        sent.push(JSON.parse(payload));
      },
    };

    const defaultSettings = sharedSettings.normalizeAppSettings({}, {
      phases: Object.values(PHASES),
      defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
    });
    const initialSettings = {
      ...defaultSettings,
      aircraft: { ...defaultSettings.aircraft, profile: 'auto' },
    };

    const tabsStore = useTabsStore();
    tabsStore.setActiveTab('settings');
    const settingsEditorStore = useSettingsEditorStore();
    const settingsFormStore = useSettingsFormStore();
    const settingsUiStore = useSettingsUiStore();

    const runtimeApi = initSettingsRuntime({
      $: (id) => documentRef.getElementById(id),
      getAppSettings: () => initialSettings,
      getWs: () => ws,
      settingsEditorStore,
      settingsFormStore,
      settingsUiStore,
      subscribeAppSettingsSignal: subscribeAppSettings,
      subscribeAppSettingsSavedSignal: subscribeAppSettingsSaved,
      subscribeWsOpenSignal: subscribeWsOpen,
      tabsStore,
      appSettingsShared: sharedSettings,
      phases: PHASES,
      windowRef,
      WebSocketRef: { OPEN: 1 },
    });

    await nextTick();
    runtimeApi.applySettingsToForm(runtimeApi.readFormSettings(), {
      storage: { flightLogsDir: 'C:/Flights', flightLogsExists: true, flightLogsFileCount: 2, flightLogsTotalBytes: 4096 },
    });
    await nextTick();

    assert.equal(settingsFormStore.saveEnabled, false, 'initially clean settings should keep save disabled through the form store');
    assert.equal(settingsFormStore.saveActionBound, true, 'settings runtime should bind the save action into the form store');
    assert.equal(settingsFormStore.reloadActionBound, true, 'settings runtime should bind the reload action into the form store');
    assert.equal(settingsUiStore.restartActionBound, true, 'settings runtime should bind the restart action into the UI store');
    assert.equal(settingsUiStore.restartActionAvailable, false, 'browser-mode settings runtime should expose restart availability through the UI store');
    assert.equal(settingsUiStore.restartActionDisabled, true, 'browser-mode settings runtime should disable restart through the UI store');
    assert.equal(settingsUiStore.restartActionTitle, 'Only available in the Electron app - click for details.', 'browser-mode settings runtime should expose restart help text through the UI store');

    settingsEditorStore.recordingAutoStart = false;
    await nextTick();
    await nextTick();
    assert.equal(settingsFormStore.pendingVisible, true, 'recording auto-start changes should show the pending bar');
    assert.match(settingsFormStore.pendingTitle, /restart-required/i, 'recording auto-start changes should mark restart-required copy');
    assert.match(settingsFormStore.pendingMeta, /Automatic recording/i, 'recording auto-start dirty state should name the restart reason');
    assert.match(settingsFormStore.statusMessage, /Automatic recording/i, 'recording auto-start status should name the restart reason');

    settingsEditorStore.recordingAutoStart = true;
    await nextTick();
    await nextTick();
    assert.equal(settingsFormStore.saveEnabled, false, 'returning recording auto-start to the saved value should clear dirty state');

    settingsEditorStore.cabinAnnouncementsEnabled = true;
    await nextTick();
    await nextTick();
    assert.equal(settingsEditorStore.cabinAnnouncementsEnabled, true, 'checkbox edits should update the settings editor store');
    assert.equal(settingsFormStore.saveEnabled, true, 'checkbox edits should mark settings dirty');

    emitAppSettings({
      settings: initialSettings,
      storage: { flightLogsDir: 'C:/Flights', flightLogsExists: true, flightLogsFileCount: 2, flightLogsTotalBytes: 4096 },
    });
    await nextTick();
    await nextTick();
    assert.equal(settingsEditorStore.cabinAnnouncementsEnabled, true, 'background settings refreshes should not revert dirty checkbox edits');
    assert.equal(settingsFormStore.saveEnabled, true, 'preserved checkbox edits should remain dirty after a background refresh');

    sent.length = 0;
    assert.equal(await settingsFormStore.requestReload(), true, 'explicit reload should still request fresh settings');
    assert.deepEqual(sent[0], { type: 'requestAppSettings' }, 'explicit reload should request settings from the backend');
    emitAppSettings({
      settings: initialSettings,
      storage: { flightLogsDir: 'C:/Flights', flightLogsExists: true, flightLogsFileCount: 2, flightLogsTotalBytes: 4096 },
    });
    await nextTick();
    await nextTick();
    assert.equal(settingsEditorStore.cabinAnnouncementsEnabled, false, 'explicit reload should replace dirty checkbox edits with backend settings');
    assert.equal(settingsFormStore.saveEnabled, false, 'explicit reload should clear dirty state when backend settings match saved state');
    sent.length = 0;

    let confirmCalls = 0;
    windowRef.confirm = () => {
      confirmCalls += 1;
      return false;
    };
    assert.equal(tabsStore.requestTabChange('livemap'), true, 'unchanged settings should allow leaving without prompting');
    assert.equal(confirmCalls, 0, 'unchanged settings should not trigger the leave confirmation');
    tabsStore.setActiveTab('settings');

    settingsEditorStore.aircraftProfile = 'pmdg-777';
    await nextTick();
    await nextTick();

    assert.equal(settingsFormStore.saveEnabled, true, 'editing settings should enable save through the form store');
    assert.equal(settingsFormStore.pendingVisible, true, 'editing should show the pending bar');
    assert.match(settingsFormStore.pendingTitle, /restart-required/i, 'aircraft profile changes should mark restart-required copy');

    windowRef.confirm = () => {
      confirmCalls += 1;
      return false;
    };
    assert.equal(tabsStore.requestTabChange('livemap'), false, 'leave guard should block tab changes when confirm is rejected');
    assert.equal(tabsStore.activeTabId, 'settings', 'blocked leave should keep the settings tab active');
    assert.equal(confirmCalls, 1, 'leave guard should prompt once');

    windowRef.confirm = () => {
      confirmCalls += 1;
      return true;
    };
    assert.equal(tabsStore.requestTabChange('livemap'), true, 'leave guard should allow tab changes when confirmed');
    assert.equal(tabsStore.activeTabId, 'livemap', 'confirmed leave should switch tabs');
    assert.equal(confirmCalls, 2, 'second leave should prompt again');

    tabsStore.setActiveTab('settings');
    sent.length = 0;
    assert.equal(await settingsFormStore.requestSave(), true, 'save requests should route through the form store action');
    assert.equal(sent.length, 1, 'pending save button should send one websocket message');
    assert.equal(sent[0].type, 'saveAppSettings', 'save action should emit saveAppSettings');
    assert.equal(sent[0].settings.aircraft.profile, 'pmdg-777', 'save action should serialize the edited settings');
    assert.equal(settingsFormStore.saveBusy, true, 'save requests should flip the store-backed save busy state');
    assert.equal(settingsFormStore.saveButtonLabel, 'Saving...', 'save requests should flip the save label through the store');
    const savedSettings = sent[0].settings;

    emitAppSettingsSaved({
      ok: true,
      settings: savedSettings,
      storage: { flightLogsDir: 'C:/Flights', flightLogsExists: true, flightLogsFileCount: 2, flightLogsTotalBytes: 4096 },
      restartRequired: true,
      restartReasons: ['Aircraft profile override'],
    });
    await nextTick();

    assert.match(settingsFormStore.statusMessage, /restart required/i, 'save result should surface restart guidance');
    assert.equal(settingsFormStore.saveBusy, false, 'save completion should clear the store-backed save busy state');
    assert.equal(settingsFormStore.saveFlashActive, false, 'restart-required saves should not trigger the immediate-apply save flash');

    sent.length = 0;
    assert.equal(await settingsFormStore.requestReload(), true, 'reload requests should route through the form store action');
    assert.equal(sent.length, 1, 'reload should send one websocket message');
    assert.deepEqual(sent[0], { type: 'requestAppSettings' }, 'reload should request fresh settings from backend');
    assert.equal(settingsFormStore.reloadBusy, true, 'reload requests should flip the store-backed reload busy state');
    assert.equal(settingsFormStore.reloadButtonLabel, 'Reloading...', 'reload requests should flip the reload label through the store');

    emitAppSettings({
      settings: savedSettings,
      storage: { flightLogsDir: 'C:/Flights', flightLogsExists: true, flightLogsFileCount: 2, flightLogsTotalBytes: 4096 },
    });
    await nextTick();
    assert.equal(settingsFormStore.reloadBusy, false, 'settings payloads should clear the store-backed reload busy state');

    settingsEditorStore.recordingAutoStart = false;
    await nextTick();
    await nextTick();
    assert.equal(settingsFormStore.pendingVisible, true, 'recording changes should show the pending bar');
    assert.match(settingsFormStore.pendingTitle, /restart-required/i, 'recording changes should mark restart-required copy');
    assert.match(settingsFormStore.pendingMeta, /Automatic recording/i, 'recording changes should identify the restart reason');
    assert.match(settingsFormStore.statusMessage, /Automatic recording/i, 'recording dirty state should name the restart reason');

    assert.equal(await settingsUiStore.requestRestart(), false, 'restart requests should report unavailable browser-mode restart through the UI store');
    assert.match(settingsFormStore.statusMessage, /Restart is not available in browser mode/i, 'unavailable restart action should still report through the settings form status');

    const recordingSavedSettings = settingsEditorStore.serializeSettings();
    emitAppSettingsSaved({
      ok: true,
      settings: recordingSavedSettings,
      storage: { flightLogsDir: 'C:/Flights', flightLogsExists: true, flightLogsFileCount: 2, flightLogsTotalBytes: 4096 },
      restartRequired: true,
      restartReasons: ['Automatic recording'],
    });
    await nextTick();
    assert.match(settingsFormStore.statusMessage, /Automatic recording/i, 'recording save results should name the restart reason');
    assert.equal(settingsFormStore.saveFlashActive, false, 'restart-required recording saves should not trigger the immediate-apply save flash');

    emitAppSettingsSaved({
      ok: true,
      settings: recordingSavedSettings,
      storage: { flightLogsDir: 'C:/Flights', flightLogsExists: true, flightLogsFileCount: 2, flightLogsTotalBytes: 4096 },
      restartRequired: false,
    });
    await nextTick();
    assert.equal(settingsFormStore.saveFlashActive, true, 'immediate-apply saves should trigger the store-backed save flash');
    settingsFormStore.clearSaveFlash();
    assert.equal(settingsFormStore.saveFlashActive, false, 'save flash should clear when the action-bar animation handler resets the store');

    runtimeApi.cleanup();
    assert.equal(settingsFormStore.saveActionBound, false, 'settings runtime cleanup should unbind the save action');
    assert.equal(settingsFormStore.reloadActionBound, false, 'settings runtime cleanup should unbind the reload action');
    assert.equal(settingsUiStore.restartActionBound, false, 'settings runtime cleanup should unbind the restart action');

    tabsStore.setActiveTab('settings');
    settingsEditorStore.aircraftProfile = 'cleanup-test';
    await nextTick();
    await nextTick();
    confirmCalls = 0;
    windowRef.confirm = () => {
      confirmCalls += 1;
      return false;
    };
    assert.equal(tabsStore.requestTabChange('livemap'), true, 'settings runtime cleanup should remove the leave guard');
    assert.equal(confirmCalls, 0, 'settings runtime cleanup should prevent leave confirmation prompts');

    emitAppSettings({
      settings: initialSettings,
      storage: { flightLogsDir: 'C:/Flights', flightLogsExists: true, flightLogsFileCount: 2, flightLogsTotalBytes: 4096 },
    });
    await nextTick();
    assert.equal(settingsEditorStore.aircraftProfile, 'cleanup-test', 'settings runtime cleanup should remove app-settings signal handlers');
  });

  await test('settings runtime keeps optional field IDs from blocking store-backed saves', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());
    documentRef.register(new FakeElement('settings-form', { tagName: 'FORM' }));

    const sent = [];
    const warnings = [];
    const ws = {
      readyState: 1,
      send(payload) {
        sent.push(JSON.parse(payload));
      },
    };
    const initialSettings = sharedSettings.normalizeAppSettings({}, {
      defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
    });

    const settingsEditorStore = useSettingsEditorStore();
    const settingsFormStore = useSettingsFormStore();
    const runtimeApi = initSettingsRuntime({
      $: (id) => documentRef.getElementById(id),
      getAppSettings: () => initialSettings,
      getWs: () => ws,
      settingsEditorStore,
      settingsFormStore,
      settingsUiStore: useSettingsUiStore(),
      appSettingsShared: sharedSettings,
      windowRef,
      WebSocketRef: { OPEN: 1 },
      consoleRef: {
        warn(message) {
          warnings.push(String(message));
        },
      },
    });

    assert.ok(runtimeApi, 'settings runtime should initialize when only the form root is present');
    assert.equal(settingsFormStore.saveActionBound, true, 'settings runtime should still bind save actions with missing optional field IDs');
    assert.equal(warnings.length, 1, 'missing optional field IDs should warn once');
    assert.match(warnings[0], /setting-simconnect-protocol/, 'optional field warning should name missing field IDs');
    assert.doesNotMatch(warnings[0], /setting-debug-mode/, 'retired debug controls should not be probed as optional fields');

    settingsEditorStore.aircraftProfile = 'pmdg-777';
    assert.equal(await settingsFormStore.requestSave(), true, 'store-backed save should work without optional field DOM nodes');
    assert.equal(sent.length, 1, 'store-backed save should send one websocket message');
    assert.equal(sent[0].type, 'saveAppSettings', 'store-backed save should emit saveAppSettings');
    assert.equal(sent[0].settings.aircraft.profile, 'pmdg-777', 'store-backed save should serialize the Pinia settings editor state');
    runtimeApi.cleanup();
    assert.equal(settingsFormStore.saveActionBound, false, 'settings runtime cleanup should unbind save actions with missing optional field IDs');
  });

  await test('settings runtime never saves defaults before the first backend hydration', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());
    documentRef.register(new FakeElement('settings-form', { tagName: 'FORM' }));

    const sent = [];
    const ws = {
      readyState: 1,
      send(payload) {
        sent.push(JSON.parse(payload));
      },
    };
    const settingsEditorStore = useSettingsEditorStore();
    const settingsFormStore = useSettingsFormStore();
    const runtimeApi = initSettingsRuntime({
      $: (id) => documentRef.getElementById(id),
      getAppSettings: () => null,
      getWs: () => ws,
      settingsEditorStore,
      settingsFormStore,
      settingsUiStore: useSettingsUiStore(),
      subscribeAppSettingsSignal: subscribeAppSettings,
      appSettingsShared: sharedSettings,
      windowRef,
      WebSocketRef: { OPEN: 1 },
      consoleRef: { warn() {} },
    });

    settingsEditorStore.remoteAccess = true;
    await nextTick();
    await nextTick();

    assert.equal(settingsFormStore.saveEnabled, false, 'pre-hydration edits must not enable settings persistence');
    assert.equal(await settingsFormStore.requestSave(), false, 'pre-hydration form submission must be rejected');
    assert.equal(sent.length, 0, 'pre-hydration defaults must never reach the backend save route');

    const persistedSettings = sharedSettings.normalizeAppSettings({
      network: {
        wsPort: 9123,
        httpPort: 9124,
        remoteAccess: false,
      },
      recording: { autoStart: false },
    }, {
      defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
    });
    emitAppSettings({ settings: persistedSettings });
    await nextTick();
    await nextTick();

    assert.equal(settingsEditorStore.remoteAccess, false, 'the first backend snapshot must replace pre-hydration form defaults and edits');
    assert.equal(settingsEditorStore.wsPort, '9123', 'the first backend snapshot must hydrate persisted network settings');
    assert.equal(settingsEditorStore.recordingAutoStart, false, 'the first backend snapshot must hydrate persisted non-network settings');
    assert.equal(settingsFormStore.saveEnabled, false, 'initial hydration must establish a clean save baseline');

    settingsEditorStore.remoteAccess = true;
    await nextTick();
    await nextTick();
    assert.equal(settingsFormStore.saveEnabled, true, 'post-hydration edits should enable persistence normally');
    assert.equal(await settingsFormStore.requestSave(), true, 'post-hydration settings should save normally');
    assert.equal(sent.length, 1, 'post-hydration save should send one request');
    assert.equal(sent[0].settings.network.remoteAccess, true, 'post-hydration save should include the trusted-LAN edit');
    assert.equal(sent[0].settings.network.wsPort, 9123, 'post-hydration save should preserve the persisted network baseline');
    assert.equal(sent[0].settings.recording.autoStart, false, 'post-hydration save should preserve unrelated persisted settings');

    runtimeApi.cleanup();
  });

  console.log('\n--- section motion ---\n');
  await test('section motion follows the tabs store without depending on MutationObserver', async () => {
    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    resetGlobals(windowRef, documentRef, createStorage());
    setActivePinia(createPinia());

    const tabsStore = useTabsStore();
    tabsStore.setActiveTab('livemap');

    const liveSection = documentRef.register(new FakeElement('tab-livemap', { classList: ['tab-section'] }));
    const flightSection = documentRef.register(new FakeElement('tab-flight', { classList: ['tab-section'] }));
    const liveChild = new FakeElement('live-child');
    const flightChild = new FakeElement('flight-child');

    liveSection.querySelectorAll = () => [liveChild];
    flightSection.querySelectorAll = () => [flightChild];
    documentRef.setQuerySelectorAll('.tab-section', [liveSection, flightSection]);

    let mutationObserverUsed = 0;
    class UnexpectedMutationObserver {
      constructor() {
        mutationObserverUsed += 1;
      }

      observe() {
        mutationObserverUsed += 1;
      }
    }

    bindSectionMotion({
      documentRef,
      requestAnimationFrameRef: (callback) => {
        if (typeof callback === 'function') callback();
      },
      MutationObserverRef: UnexpectedMutationObserver,
      tabsStore,
    });
    await nextTick();

    assert.equal(mutationObserverUsed, 0, 'store-backed section motion should not create a MutationObserver');
    assert.equal(liveChild.classList.contains('ff-motion-target'), true, 'initial active section should receive motion classes');
    assert.equal(liveChild.classList.contains('ff-motion-in'), true, 'initial active section should animate in immediately');
    assert.equal(liveChild.style.values['--ff-motion-index'], '0', 'motion targets should still receive their sequence index');

    tabsStore.setActiveTab('flight');
    await nextTick();

    assert.equal(flightChild.classList.contains('ff-motion-target'), true, 'newly active sections should animate from store-driven tab changes');
    assert.equal(flightChild.classList.contains('ff-motion-in'), true, 'newly active sections should still enter with the visible motion class');
  });

  console.log('\n--- tabs runtime ---\n');
  await test('tabs runtime restores a contextual tab after a full page refresh', async () => {
    const storage = createStorage();
    const initialDocumentRef = new FakeDocument();
    const initialWindowRef = new FakeWindow(initialDocumentRef);
    resetGlobals(initialWindowRef, initialDocumentRef, storage);
    setActivePinia(createPinia());

    const initialTabsStore = useTabsStore();
    const cleanupInitialTabsRuntime = initTabsRuntime({
      tabsStore: initialTabsStore,
      windowRef: initialWindowRef,
      documentRef: initialDocumentRef,
      storage,
    });
    initialTabsStore.requestTabChange('landing');
    await nextTick();
    assert.equal(storage.getItem(LAST_ACTIVE_TAB_STORAGE_KEY), 'landing', 'opening a contextual tab should persist it before reload');
    cleanupInitialTabsRuntime();

    const refreshedDocumentRef = new FakeDocument();
    const refreshedWindowRef = new FakeWindow(refreshedDocumentRef);
    resetGlobals(refreshedWindowRef, refreshedDocumentRef, storage);
    setActivePinia(createPinia());

    const refreshedTabsStore = useTabsStore();
    const cleanupRefreshedTabsRuntime = initTabsRuntime({
      tabsStore: refreshedTabsStore,
      windowRef: refreshedWindowRef,
      documentRef: refreshedDocumentRef,
      storage,
    });
    await nextTick();
    assert.equal(refreshedTabsStore.activeTabId, 'landing', 'a refreshed app should reopen the contextual tab that was active');
    cleanupRefreshedTabsRuntime();
  });

  await test('tabs runtime drives tab store state from startup, keyboard, and touch interactions', async () => {
    assert.equal(resolveInitialTabId(), 'flight', 'first use should open Overview');
    assert.equal(resolveInitialTabId({ persistedTabId: 'timeline' }), 'timeline', 'returning users should restore their last primary tab');
    assert.equal(resolveInitialTabId({ persistedTabId: 'landing' }), 'landing', 'returning users should restore the landing debrief after a refresh');
    assert.equal(resolveInitialTabId({ persistedTabId: 'lvars' }), 'lvars', 'returning users should restore the LVAR inspector after a refresh');
    assert.equal(resolveInitialTabId({ persistedTabId: 'not-a-tab' }), 'flight', 'invalid remembered tabs should fall back to Overview');
    assert.equal(resolveInitialTabId({ requestedTabId: 'systems', persistedTabId: 'timeline' }), 'system', 'valid deep links should override remembered navigation');
    assert.equal(resolveInitialTabId({ requestedTabId: 'not-a-tab', persistedTabId: 'timeline' }), 'timeline', 'invalid deep links should fall back to a valid remembered tab');

    const documentRef = new FakeDocument();
    const windowRef = new FakeWindow(documentRef);
    const storage = createStorage({ [LAST_ACTIVE_TAB_STORAGE_KEY]: 'timeline' });
    resetGlobals(windowRef, documentRef, storage);
    setActivePinia(createPinia());
    windowRef.location.search = '?tab=systems';

    const tabsStore = useTabsStore();

    const sectionLive = documentRef.register(new FakeElement('tab-livemap', { classList: ['tab-section'] }));
    const sectionFlight = documentRef.register(new FakeElement('tab-flight', { classList: ['tab-section'] }));
    const sectionSettings = documentRef.register(new FakeElement('tab-settings', { classList: ['tab-section'] }));
    const sectionSystem = documentRef.register(new FakeElement('tab-system', { classList: ['tab-section'] }));
    const landingCard = documentRef.register(new FakeElement('landing-card', { classList: ['hidden'] }));
    const landingEmpty = documentRef.register(new FakeElement('landing-empty'));
    const mainEl = new FakeElement('main', { tagName: 'MAIN' });
    const headerEl = new FakeElement('header', { tagName: 'HEADER' });
    const desktopBar = new FakeElement('desktop-bar', { classList: ['desktop-tab-bar'] });
    const mobileBar = new FakeElement('mobile-bar', { classList: ['mobile-tab-bar'] });

    documentRef.setQuerySelectorAll('.tab-section', [sectionLive, sectionFlight, sectionSettings, sectionSystem]);
    documentRef.setQuerySelector('main', mainEl);
    documentRef.setQuerySelector('header', headerEl);
    documentRef.setQuerySelector('.desktop-tab-bar', desktopBar);
    documentRef.setQuerySelector('.mobile-tab-bar', mobileBar);

    let reconnectCalls = 0;
    let websocketState = 'ready';
    const cleanupTabsRuntime = initTabsRuntime({
      tabsStore,
      reconnect: () => {
        reconnectCalls += 1;
      },
      canPullToReconnect: () => websocketState === 'disconnected' || websocketState === 'error',
      windowRef,
      documentRef,
      storage,
    });
    await nextTick();
    await nextTick();

    assert.equal(tabsStore.activeTabId, 'system', 'tabs runtime should normalize the systems tab alias to the System tab');
    assert.equal(tabsStore.tabSectionClass('system').active, true, 'initial section active state should come from the tabs store');
    assert.equal(storage.getItem(LAST_ACTIVE_TAB_STORAGE_KEY), 'system', 'explicit primary deep links should become the latest selected tab');

    mainEl.scrollTop = 260;

    const keyboardEvent = {
      type: 'keydown',
      key: '1',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      target: { tagName: 'DIV' },
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    documentRef.dispatchEvent(keyboardEvent);
    await nextTick();
    await nextTick();

    assert.equal(keyboardEvent.prevented, true, 'keyboard shortcut should prevent default when it handles the key');
    assert.equal(tabsStore.activeTabId, 'livemap', 'keyboard shortcut should switch back to live map');
    assert.equal(mainEl.scrollTop, 0, 'a newly opened tab should start at the top');

    mainEl.scrollTop = 140;
    tabsStore.requestTabChange('system');
    await nextTick();
    await nextTick();
    assert.equal(mainEl.scrollTop, 260, 'returning to a tab should restore its prior scroll position');

    tabsStore.requestTabChange('livemap');
    await nextTick();
    await nextTick();
    assert.equal(mainEl.scrollTop, 140, 'each tab should keep an independent scroll position');

    const ignoredKeyEvent = {
      type: 'keydown',
      key: '8',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      target: { tagName: 'INPUT' },
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    documentRef.dispatchEvent(ignoredKeyEvent);
    await nextTick();
    await nextTick();

    assert.equal(ignoredKeyEvent.prevented, false, 'keyboard shortcuts should ignore focused inputs');
    assert.equal(tabsStore.activeTabId, 'livemap', 'ignored keyboard shortcuts should not change tabs');

    const interactiveTouchTarget = {
      closest(selector) {
        return selector.includes('button') ? this : null;
      },
    };
    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 140, clientY: 40 }],
      target: interactiveTouchTarget,
    });
    mainEl.dispatchEvent({
      type: 'touchend',
      changedTouches: [{ clientX: 20, clientY: 42 }],
      target: interactiveTouchTarget,
    });
    await nextTick();
    assert.equal(tabsStore.activeTabId, 'livemap', 'horizontal control gestures should not swipe to another tab');

    mainEl.scrollTop = 0;
    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 20, clientY: 20 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 110 }],
      target: mainEl,
    });
    assert.equal(tabsStore.pullRefreshVisible, false, 'healthy-socket overscroll should not show a reconnect prompt');
    mainEl.dispatchEvent({
      type: 'touchend',
      changedTouches: [{ clientX: 20, clientY: 110 }],
      target: mainEl,
    });
    assert.equal(reconnectCalls, 0, 'healthy-socket overscroll should not reconnect');

    websocketState = 'connecting';
    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 20, clientY: 20 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 110 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchend',
      changedTouches: [{ clientX: 20, clientY: 110 }],
      target: mainEl,
    });
    assert.equal(tabsStore.pullRefreshVisible, false, 'connecting-socket overscroll should not show a reconnect prompt');
    assert.equal(reconnectCalls, 0, 'connecting-socket overscroll should not restart the connection');

    websocketState = 'disconnected';
    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 20, clientY: 20 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 110 }],
      target: mainEl,
    });
    assert.equal(tabsStore.pullRefreshVisible, true, 'pull-to-refresh prompt should be store-backed');
    assert.equal(tabsStore.pullRefreshLabel, 'Release to reconnect', 'pull-to-refresh release copy should be store-backed');

    mainEl.dispatchEvent({
      type: 'touchend',
      changedTouches: [{ clientX: 20, clientY: 110 }],
      target: mainEl,
    });
    assert.equal(reconnectCalls, 1, 'disconnected pull-to-reconnect should reconnect exactly once');
    assert.equal(tabsStore.pullRefreshVisible, false, 'pull-to-refresh prompt should clear after refresh completes');

    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 20, clientY: 20 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 70 }],
      target: mainEl,
    });
    assert.equal(tabsStore.pullRefreshVisible, true, 'disconnected partial pull should show the reconnect hint');
    mainEl.dispatchEvent({ type: 'touchcancel', target: mainEl });
    assert.equal(tabsStore.pullRefreshVisible, false, 'touch cancellation should clear the reconnect hint');
    assert.equal(reconnectCalls, 1, 'touch cancellation should not reconnect');
    mainEl.dispatchEvent({
      type: 'touchend',
      changedTouches: [{ clientX: -90, clientY: 70 }],
      target: mainEl,
    });
    await nextTick();
    assert.equal(tabsStore.activeTabId, 'livemap', 'touch cancellation should also cancel horizontal tab swiping');

    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 20, clientY: 20 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 70 }],
      target: mainEl,
    });
    websocketState = 'connecting';
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 90 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchend',
      changedTouches: [{ clientX: 20, clientY: 90 }],
      target: mainEl,
    });
    assert.equal(tabsStore.pullRefreshVisible, false, 'connection recovery during a pull should cancel the reconnect hint');
    assert.equal(reconnectCalls, 1, 'connection recovery during a pull should prevent a redundant reconnect');

    websocketState = 'error';
    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 20, clientY: 20 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 70 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [
        { clientX: 20, clientY: 70 },
        { clientX: 40, clientY: 70 },
      ],
      target: mainEl,
    });
    assert.equal(tabsStore.pullRefreshVisible, false, 'multi-touch should cancel an active reconnect hint');
    assert.equal(reconnectCalls, 1, 'multi-touch cancellation should not reconnect');
    mainEl.dispatchEvent({
      type: 'touchend',
      changedTouches: [{ clientX: -90, clientY: 70 }],
      target: mainEl,
    });
    await nextTick();
    assert.equal(tabsStore.activeTabId, 'livemap', 'multi-touch should cancel horizontal tab swiping');

    let nextReconnectTimerId = 0;
    const pendingReconnectTimers = new Map();
    windowRef.setTimeout = (callback) => {
      nextReconnectTimerId += 1;
      pendingReconnectTimers.set(nextReconnectTimerId, callback);
      return nextReconnectTimerId;
    };
    windowRef.clearTimeout = (timerId) => {
      pendingReconnectTimers.delete(timerId);
    };
    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 20, clientY: 20 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 110 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchend',
      changedTouches: [{ clientX: 20, clientY: 110 }],
      target: mainEl,
    });
    assert.equal(reconnectCalls, 2, 'error-state pull should still expose manual recovery');
    assert.equal(pendingReconnectTimers.size, 1, 'reconnect feedback should schedule one clear timer');

    mainEl.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 20, clientY: 20 }],
      target: mainEl,
    });
    mainEl.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 20, clientY: 70 }],
      target: mainEl,
    });
    assert.equal(pendingReconnectTimers.size, 0, 'a new eligible pull should cancel stale reconnect feedback timers');
    assert.equal(tabsStore.pullRefreshVisible, true, 'a rapid retry should keep its own reconnect hint visible');
    cleanupTabsRuntime();
    assert.equal(tabsStore.pullRefreshVisible, false, 'tabs cleanup should clear an active reconnect hint');
    assert.equal(mainEl.listeners.get('touchstart')?.size || 0, 0, 'tabs cleanup should remove touch listeners');
  });

  console.log(`\n${'-'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
