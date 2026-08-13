// ES module - strict mode is implicit in modules.
import { isValidCoord } from '../geo/coords.js';
import { createAppPreferences } from './preferences.js';
import { createAppSettingsController } from './settings-controller.js';
import { createAutopilotPanel } from '../aircraft/autopilot-panel.js';
import { createAircraftControlController } from '../aircraft/control-controller.js';
import {
  LIVE_TELEMETRY_MESSAGE_TYPES,
} from '../telemetry/display-defaults.js';
import { createTelemetryDisplay } from '../telemetry/display.js';
import { createLandingController } from '../landing/controller.js';
import { createTelemetryWarnings } from '../telemetry/warnings.js';
import { createAppFeedback } from '../ui/feedback.js';
import { bindSectionMotion } from '../ui/motion.js';
import { createAppMessageHandler } from './message-handlers.js';
import { createStatusIndicatorsController } from '../ui/status-indicators.js';
import { createLvarInspectorController } from '../data-sources/lvar-inspector-controller.js';
import { createConnection } from '../ws/connection.js';
import { getCabinAnnouncements, setAppServices } from '../../app-shared.js';
import {
  emitTelemetryReset,
  emitWsClose,
  emitWsConnecting,
  emitWsError,
  emitWsOpen,
} from './runtime-signals.js';

export const FRAME_COALESCED_MESSAGE_TYPES = new Set([
  ...LIVE_TELEMETRY_MESSAGE_TYPES,
  'assists',
  'aircraftSpecificState',
  'attitude',
  'controls',
  'flightRecording',
  'iast',
  'phase',
  'rates',
  'runwayContext',
  'simState',
  'surface',
  'throttle',
  'vreSampling',
]);

// The live map needs every position sample even when Chromium suspends
// requestAnimationFrame for a minimized/backgrounded window. These messages
// bypass the render-frame queue; all display-oriented telemetry remains
// coalesced above.
export const IMMEDIATE_MESSAGE_TYPES = new Set(['authorizationScope', 'position']);

function requireRuntimeStore(stores, storeName) {
  const store = stores?.[storeName] || null;
  if (store) return store;
  throw new Error(`${storeName} store is required before app runtime initialization.`);
}

export function bindTelemetryResumeSync({
  documentRef = document,
  windowRef = window,
  WebSocketRef = WebSocket,
  getWs = () => null,
  getLastMessageAt = () => 0,
  reconnect = null,
  send = () => {},
  now = () => Date.now(),
  minIntervalMs = 750,
  reconnectMinIntervalMs = 3000,
  periodicIntervalMs = 1000,
  staleAfterMs = 1500,
} = {}) {
  let lastRequestedAt = 0;
  let lastReconnectAt = 0;
  let periodicTimer = null;

  function getNowMs() {
    const nowMs = Number(now());
    return Number.isFinite(nowMs) ? nowMs : Date.now();
  }

  function requestReconnect(reason) {
    if (typeof reconnect !== 'function') return false;

    const nowMs = getNowMs();
    if (nowMs - lastReconnectAt < reconnectMinIntervalMs) {
      return false;
    }

    lastReconnectAt = nowMs;
    reconnect({ reason });
    return true;
  }

  function requestState(reason) {
    const ws = typeof getWs === 'function' ? getWs() : null;
    if (!ws || ws.readyState !== WebSocketRef.OPEN) {
      requestReconnect(`${reason}:socket-not-open`);
      return false;
    }

    const nowMs = getNowMs();
    if (Number.isFinite(nowMs) && nowMs - lastRequestedAt < minIntervalMs) {
      return false;
    }

    lastRequestedAt = nowMs;
    try {
      const sent = send({ type: 'requestState', reason });
      if (sent === false) {
        requestReconnect(`${reason}:send-failed`);
        return false;
      }
      return true;
    } catch {
      requestReconnect(`${reason}:send-failed`);
      return false;
    }
  }

  function handleVisibilityChange() {
    if (documentRef?.hidden === true || documentRef?.visibilityState === 'hidden') return;
    requestState('visibility');
  }

  function handleFocus() {
    requestState('focus');
  }

  function handlePageShow() {
    requestState('pageshow');
  }

  documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);
  windowRef?.addEventListener?.('focus', handleFocus);
  windowRef?.addEventListener?.('pageshow', handlePageShow);
  if (Number.isFinite(periodicIntervalMs) && periodicIntervalMs > 0) {
    periodicTimer = windowRef?.setInterval?.(() => {
      if (documentRef?.hidden === true || documentRef?.visibilityState === 'hidden') return;
      const lastMessageAt = Number(typeof getLastMessageAt === 'function' ? getLastMessageAt() : 0);
      const nowMs = getNowMs();
      const hasFreshMessages = Number.isFinite(lastMessageAt)
        && Number.isFinite(nowMs)
        && lastMessageAt > 0
        && nowMs - lastMessageAt <= staleAfterMs;
      if (hasFreshMessages) return;
      requestState('stale-stream');
    }, periodicIntervalMs) || null;
  }

  return () => {
    if (periodicTimer != null) {
      windowRef?.clearInterval?.(periodicTimer);
      periodicTimer = null;
    }
    documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
    windowRef?.removeEventListener?.('focus', handleFocus);
    windowRef?.removeEventListener?.('pageshow', handlePageShow);
  };
}

export function createMessageFrameBatcher({
  windowRef = window,
  handleMessage = () => {},
  coalescedMessageTypes = null,
  immediateMessageTypes = null,
} = {}) {
  const coalescedTypes = coalescedMessageTypes instanceof Set
    ? coalescedMessageTypes
    : new Set(Array.isArray(coalescedMessageTypes) ? coalescedMessageTypes : []);
  const immediateTypes = immediateMessageTypes instanceof Set
    ? immediateMessageTypes
    : new Set(Array.isArray(immediateMessageTypes) ? immediateMessageTypes : []);
  let queuedMessages = [];
  let coalescedIndexes = new Map();
  let flushScheduled = false;

  function getCoalescedKey(message) {
    const type = typeof message?.type === 'string' ? message.type : '';
    return type && coalescedTypes.has(type) ? type : null;
  }

  function flush() {
    flushScheduled = false;
    if (queuedMessages.length === 0) return;
    const batch = queuedMessages;
    queuedMessages = [];
    coalescedIndexes = new Map();
    for (const message of batch) {
      handleMessage(message);
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    const requestFrame = typeof windowRef?.requestAnimationFrame === 'function'
      ? windowRef.requestAnimationFrame.bind(windowRef)
      : (callback) => windowRef?.setTimeout?.(callback, 16);
    requestFrame(flush);
  }

  return {
    enqueue(message) {
      const messageType = typeof message?.type === 'string' ? message.type : '';
      if (messageType && immediateTypes.has(messageType)) {
        handleMessage(message);
        return;
      }

      const coalescedKey = getCoalescedKey(message);
      if (coalescedKey) {
        const existingIndex = coalescedIndexes.get(coalescedKey);
        if (
          Number.isInteger(existingIndex)
          && existingIndex >= 0
          && existingIndex < queuedMessages.length
        ) {
          queuedMessages[existingIndex] = message;
          scheduleFlush();
          return;
        }
        coalescedIndexes.set(coalescedKey, queuedMessages.length);
      } else {
        coalescedIndexes = new Map();
      }
      queuedMessages.push(message);
      scheduleFlush();
    },
    flush,
    queuedCount() {
      return queuedMessages.length;
    },
  };
}

export async function initAppRuntime({
  stores = null,
} = {}) {
  console.log('[INIT] Script starting...');
  
  // === Configuration ===
  const WS_PORT = 8099;
  const HTTP_PORT = 8100;
  const RECONNECT_DELAY = 3000;
  const params = new URLSearchParams(window.location.search);

  // === State ===
  const runtimeStores = stores || {};
  let wasSimconnectConnected = false;
  const flightStore = requireRuntimeStore(runtimeStores, 'flight');
  const appSettingsStore = requireRuntimeStore(runtimeStores, 'appSettings');
  const feedbackStore = requireRuntimeStore(runtimeStores, 'feedback');
  const statusStore = requireRuntimeStore(runtimeStores, 'status');
  const preferencesStore = requireRuntimeStore(runtimeStores, 'preferences');
  const aircraftControlsStore = requireRuntimeStore(runtimeStores, 'aircraftControls');
  const aircraftSpecificStore = requireRuntimeStore(runtimeStores, 'aircraftSpecific');
  const lvarInspectorStore = requireRuntimeStore(runtimeStores, 'lvarInspector');
  const logbookStore = requireRuntimeStore(runtimeStores, 'logbook');
  const simbriefStore = requireRuntimeStore(runtimeStores, 'simbrief');
  const tabsStore = requireRuntimeStore(runtimeStores, 'tabs');
  const landingStore = requireRuntimeStore(runtimeStores, 'landing');
  const timelineStore = requireRuntimeStore(runtimeStores, 'timeline');
  const desktopIntegration = {
    setRecordingBadge(message = {}) {
      const api = window.electronAPI;
      if (typeof api?.setRecordingBadge !== 'function') return false;
      Promise.resolve(api.setRecordingBadge({ status: message.status }))
        .catch((err) => {
          console.warn('[electron] Recording badge update failed:', err?.message || err);
        });
      return true;
    },
  };
  let lvarInspector = null;
  let statusIndicators = null;
  let handleMessage = () => {};
  
  // Current flight state (for AP display fallbacks)
  const currentState = {
    ias: null,
    hdg: null,
    alt: null,
    vs: null
  };
  // === DOM Helpers ===
  const $ = (id) => document.getElementById(id);
  const appSettingsController = createAppSettingsController({
    $,
    windowRef: window,
    getCabinAnnouncements,
  });
  const { showToast: showAppToast } = createAppFeedback({ windowRef: window, feedbackStore });
  const telemetryWarnings = createTelemetryWarnings({
    localStorageRef: localStorage,
    statusStore,
    flightStore,
  });

  const uiHelpers = {
    showToast: showAppToast,
  };

  const setText = (id, val) => {
    const el = $(id);
    if (!el) return;
    const next = val == null ? '' : String(val);
    if (el.textContent === next) return;
    el.textContent = next;
  };
  const appPreferences = createAppPreferences({
    storage: localStorage,
    getWsSend: () => connection.send,
    preferencesStore,
    flightStore,
  });
  const telemetryDisplay = createTelemetryDisplay({
    currentState,
    preferences: appPreferences,
    flightStore,
  });

  const aircraftControl = createAircraftControlController({
    WebSocketRef: WebSocket,
    getWs: () => connection.getWs(),
    getWsSend: () => connection.send,
    getAuthorizationScope: () => connection.getAuthorizationScope(),
    getSimconnectConnected: () => wasSimconnectConnected,
    aircraftControlsStore,
    showToast: showAppToast,
  });
  aircraftSpecificStore?.bindRuntimeActions?.({
    requestAction(actionId, { pendingKey = '', value } = {}) {
      return aircraftControl.send({
        control: 'aircraft-specific',
        operation: 'execute',
        actionId,
        ...(value === undefined ? {} : { value }),
      }, {
        pendingKey,
      });
    },
  });

  const autopilotPanel = createAutopilotPanel({
    aircraftControl,
    aircraftControlsStore,
    getCurrentState: () => currentState,
  });
  
  // === Default text values - single source of truth for initial / disconnected state ===
  let hasSeenFlightTelemetry = false;
  let simconnectTelemetryConnected = null;
  let lastMessageAt = 0;
  const messageBatcher = createMessageFrameBatcher({
    windowRef: window,
    handleMessage: (message) => handleMessage(message),
    coalescedMessageTypes: FRAME_COALESCED_MESSAGE_TYPES,
    immediateMessageTypes: IMMEDIATE_MESSAGE_TYPES,
  });

  const connection = createConnection({
    windowRef: window,
    WebSocketRef: WebSocket,
    params,
    defaultWsPort: WS_PORT,
    defaultHttpPort: HTTP_PORT,
    reconnectDelay: RECONNECT_DELAY,
    setConnectionInfo: (wsUrl) => statusStore?.setConnectionInfo?.(wsUrl),
    onConnecting: () => {
      hasSeenFlightTelemetry = false;
      simconnectTelemetryConnected = null;
      setFlightState('connecting');
      emitWsConnecting();
    },
    onOpen: ({ send }) => {
      setFlightState('waiting');
      aircraftControl.updateAvailability();
      // Request current state from backend
      send({ type: 'requestState' });
      appPreferences.syncToBackend();
      simbriefStore?.relayPlan?.();
      lvarInspector?.resync();
      emitWsOpen();
    },
    onClose: () => {
      setFlightState('disconnected');
      aircraftControl.clearProfileToken('Backend connection lost. Waiting for profile refresh.');
      aircraftControl.clearPendingRequests('Connection lost before control request completed.');
      aircraftControl.updateAvailability();

      // Reset telemetry display so gauges don't show stale values
      resetTelemetryDisplay('wsDisconnected');
      timelineStore?.markListDisconnected?.();
      emitWsClose();
    },
    onError: () => {
      setFlightState('error');
      emitWsError();
    },
    onMessage: (msg) => {
      lastMessageAt = Date.now();
      messageBatcher.enqueue(msg);
    },
  });

  bindTelemetryResumeSync({
    documentRef: document,
    windowRef: window,
    WebSocketRef: WebSocket,
    getWs: () => connection.getWs(),
    getLastMessageAt: () => lastMessageAt,
    reconnect: connection.reconnect,
    send: (payload) => connection.send(payload),
  });

  setAppServices({
    getWs: connection.getWs,
    getWsUrl: connection.getWsUrl,
    getWsSend: () => connection.send,
    getAuthorizationScope: connection.getAuthorizationScope,
    sendWs: connection.send,
    getBackendHttpBase: connection.getBackendHttpBase,
    ui: uiHelpers,
  });
  appSettingsStore?.bindRuntimeActions?.({
    onSaveSettings(nextSettings) {
      return connection.send({ type: 'saveAppSettings', settings: nextSettings });
    },
  });
  simbriefStore?.bindRuntime?.({
    sendMessage: (payload) => connection.send(payload),
    httpBase: connection.getBackendHttpBase(),
    getHttpBase: () => connection.getBackendHttpBase(),
    copyRouteText: async (text) => {
      if (!text || !navigator?.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(text);
      return true;
    },
    fetchSimbrief: typeof window.electronAPI?.fetchSimbrief === 'function'
      ? (username) => window.electronAPI.fetchSimbrief(username)
      : null,
  });
  timelineStore?.bindRequestActions?.({
    onRequestList(payload) {
      if (connection.getAuthorizationScope() !== 'full-control') {
        timelineStore.markListRestricted?.();
        return false;
      }
      return connection.send(payload || { type: 'requestTimelineList' });
    },
    onRequestTimeline(payload) {
      if (connection.getAuthorizationScope() !== 'full-control') return false;
      return connection.send(payload);
    },
    onDeleteFlight(payload) {
      if (connection.getAuthorizationScope() !== 'full-control') return false;
      return connection.send(payload);
    },
  });
  timelineStore?.bindPanelActions?.({
    confirmDeleteFlight(message) {
      return window.confirm(message);
    },
    notifyDeleteUnavailable(message) {
      window.alert(message);
      return true;
    },
    async openStorageFolder(dir) {
      if (!dir || dir === '--') return false;
      if (window.electronAPI && typeof window.electronAPI.revealInExplorer === 'function') {
        try {
          await window.electronAPI.revealInExplorer(dir);
          return true;
        } catch (error) {
          window.alert(`Could not open folder: ${error?.message || error}`);
          return false;
        }
      }
      window.alert(`Open this folder in your file manager:\n\n${dir}`);
      return true;
    },
    async copyStoragePath(dir) {
      if (!dir || dir === '--') return false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(dir);
          return { copied: true };
        }
      } catch {
        // Fall through to the manual copy prompt below.
      }
      window.prompt('Copy the folder path:', dir);
      return { copied: false, prompted: true };
    },
  });

  function setFlightTabMuted(muted) {
    if (flightStore?.setFlightState) return;
    const shell = $('flight-live-shell');
    if (shell) shell.classList.toggle('is-muted', muted);
  }

  function setFlightState(mode, overrides = {}) {
    const next = typeof flightStore?.setFlightState === 'function'
      ? flightStore.setFlightState(mode, overrides)
      : { muted: Object.prototype.hasOwnProperty.call(overrides, 'muted') ? overrides.muted !== false : mode !== 'live' };
    setFlightTabMuted(next.muted !== false);
  }

  function markFlightTelemetryActive() {
    if (simconnectTelemetryConnected === false) return;
    hasSeenFlightTelemetry = true;
    if (statusStore?.simInMenu !== true) {
      setFlightState('live');
    }
  }

  function dispatchTelemetryReset(reason) {
    emitTelemetryReset({ reason: reason || 'unknown' });
  }

  // === Reset telemetry display to initial state (SimConnect disconnected) ===
  function resetTelemetryDisplay(reason = 'unknown') {
    flightStore?.resetLiveTelemetry?.();

    // Autopilot structural resets
    autopilotPanel.resetState();

    // Clear internal state
    currentState.ias = null; currentState.hdg = null; currentState.alt = null; currentState.vs = null;
    hasSeenFlightTelemetry = false;

    // Hide stale landing card from previous flight
    landingController.resetSession();

    // Clear data sources footer
    lvarInspector?.clearDataSourcesStatus();

    if (reason === 'aircraftChanged') {
      setFlightState('waiting', {
        copy: 'Aircraft changed. Waiting for the new aircraft to start publishing live telemetry.',
      });
    } else if (reason === 'simconnectDisconnected') {
      simconnectTelemetryConnected = false;
      setFlightState('disconnected', {
        title: 'Simulator disconnected',
        copy: 'The app is connected, but the simulator telemetry link is offline right now.',
      });
    } else if (reason === 'wsDisconnected') {
      simconnectTelemetryConnected = false;
      setFlightState('disconnected');
    }

    dispatchTelemetryReset(reason);

    console.log('[UI] Telemetry display reset \u2014 SimConnect disconnected');
  }
  // === Message Handlers ===
  const landingController = createLandingController({
    $,
    setText,
    documentRef: document,
    windowRef: window,
    flightStore,
    landingStore,
    tabsStore,
  });
  timelineStore?.bindDetailActions?.({
    onOpenSelectedLanding(event) {
      if (!event || event.type !== 'landing') return false;
      landingController.showTimelineLanding(event, { openModal: true });
      return true;
    },
    onOpenFlightLanding(flight) {
      return timelineStore.requestFlightLanding(flight);
    },
    onFlightLandingLoadStart() {
      landingController.openTimelineLandingModal({ loading: true });
    },
    onFlightLandingLoadError(error) {
      landingController.showTimelineLandingError(error);
    },
  });

  const updateEngines = telemetryDisplay.updateEngineDisplay;
  
  autopilotPanel.bindControls();
  
  // === Manual Flight Recording Controls ===
  function startRecordingManual() {
    const ws = connection.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert('Not connected to telemetry server');
      return false;
    }

    if (statusStore?.recordingStartAvailable !== true) {
      alert(statusStore?.simConnected === true ? 'Simulator is not ready for recording' : 'Simulator telemetry is not connected');
      return false;
    }

    return connection.send({ type: 'startRecording' });
  }

  function endFlightManual() {
    const ws = connection.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert('Not connected to telemetry server');
      return false;
    }
    
    if (!confirm('End flight and save log now?\n\nThis will finalize the current flight recording.')) {
      return false;
    }
    
    return connection.send({ type: 'endFlightManual' });
  }

  statusStore?.bindHeaderActions?.({
    onStartRecordingManual: startRecordingManual,
    onEndFlightManual: endFlightManual,
  });

  statusIndicators = createStatusIndicatorsController({
    $,
    documentRef: document,
    statusStore,
  });

  lvarInspector = createLvarInspectorController({
    $,
    documentRef: document,
    localStorageRef: localStorage,
    lvarInspectorStore,
    sendWs: (payload) => connection.send(payload),
  });

  handleMessage = createAppMessageHandler({
    windowRef: window,
    alertRef: alert,
    consoleRef: console,
    LIVE_TELEMETRY_MESSAGE_TYPES,
    getSimconnectTelemetryConnected: () => simconnectTelemetryConnected,
    setSimconnectTelemetryConnected: (value) => {
      simconnectTelemetryConnected = value;
    },
    getWasSimconnectConnected: () => wasSimconnectConnected,
    setWasSimconnectConnected: (value) => {
      wasSimconnectConnected = value;
    },
    getHasSeenFlightTelemetry: () => hasSeenFlightTelemetry,
    markFlightTelemetryActive,
    resetTelemetryDisplay,
    setFlightState,
    telemetryDisplay,
    appPreferences,
    autopilotPanel,
    aircraftControl,
    aircraftSpecificStore,
    landingController,
    telemetryWarnings,
    statusIndicators,
    lvarInspector,
    appSettingsController,
    updateEngines,
    flightStore,
    getFlightStore: () => flightStore,
    statusStore,
    logbookStore,
    timelineStore,
    desktopIntegration,
    getCabinAnnouncements,
  });
  
  setAppServices({
    getAppSettings: appSettingsController.getSettings,
    isValidCoord,
    handleMessage,
    showTimelineLanding: landingController.showTimelineLanding,
    reconnect: connection.reconnect,
  });

  lvarInspector.bind();
  bindSectionMotion({ tabsStore });

  // === Initialize ===
  simbriefStore?.restore?.();
  connection.initialize();
}



