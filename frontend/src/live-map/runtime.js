// ES module - strict mode is implicit in modules.
import { watch } from 'vue';
import { createLiveMapController } from './map-controller.js';
import { createLiveMap3dController } from './map-3d-controller.js';
import { createRouteTargetsController } from './route-targets.js';

function defaultCoordValidator(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return !(Math.abs(lat) <= 1e-6 && Math.abs(lon) <= 1e-6);
}

export function initLiveMapRuntime({
  liveMapStore = null,
  tabsStore = null,
  statusStore = null,
  getElementById = (id) => document.getElementById(id),
  isValidCoord = null,
  sendMessage = null,
  subscribeWsMessageSignal = null,
  subscribeTelemetryMessageSignal = null,
  allowOnlineMapTiles = () => true,
  windowRef = window,
  localStorageRef = localStorage,
  consoleRef = console,
  create3dController = createLiveMap3dController,
} = {}) {
  if (!liveMapStore) {
    throw new Error('Live map store is required before live-map runtime');
  }

  const cleanupFns = [];

  const mapEl = getElementById('live-map');
  if (!mapEl) return () => {};

  const validateCoord = typeof isValidCoord === 'function'
    ? isValidCoord
    : defaultCoordValidator;

  const map3dEl = getElementById('live-map-3d');
  let routeTargets = null;
  let liveMapController = null;
  let liveMap3dController = null;

  function isLiveTabShowing() {
    return windowRef.document?.hidden !== true
      && (!tabsStore || tabsStore.activeTabId === 'livemap');
  }

  function is3dViewSelected() {
    return liveMapStore.viewMode === '3d';
  }

  function activeMapController() {
    return is3dViewSelected() && liveMap3dController ? liveMap3dController : liveMapController;
  }

  liveMapController = createLiveMapController({
    mapEl,
    liveMapStore,
    windowRef,
    localStorageRef,
    consoleRef,
    isValidCoord: validateCoord,
    getRouteTargets: () => routeTargets,
    allowOnlineTiles: allowOnlineMapTiles,
    isLiveMapVisible: () => (
      isLiveTabShowing()
      && !is3dViewSelected()
      && Boolean(mapEl && mapEl.offsetParent !== null)
    ),
  });

  // The 3D view shares the same telemetry and route targets but renders into
  // its own surface; it only becomes active when the user selects it.
  liveMap3dController = map3dEl ? create3dController({
    containerEl: map3dEl,
    liveMapStore,
    windowRef,
    documentRef: windowRef.document,
    consoleRef,
    localStorageRef,
    isValidCoord: validateCoord,
    getRouteTargets: () => routeTargets,
    allowOnlineTiles: allowOnlineMapTiles,
    getOptions: () => liveMapStore.map3dOptions,
    isVisible: () => (
      isLiveTabShowing()
      && is3dViewSelected()
      && windowRef.document?.visibilityState !== 'hidden'
      && windowRef.document?.hidden !== true
      && Boolean(map3dEl && map3dEl.offsetParent !== null)
    ),
  }) : null;

  routeTargets = createRouteTargetsController({
    liveMapStore,
    isValidCoord: validateCoord,
    sendWsMessage: typeof sendMessage === 'function' ? sendMessage : (() => false),
    getLastPosition: () => liveMapController.getLastPosition(),
    getDistanceNm: liveMapController.getDistanceNm,
    getInitialBearingDeg: liveMapController.getInitialBearingDeg,
    renderTargetLine: () => {
      liveMapController.renderTargetLine();
      liveMap3dController?.renderRouteOverlays();
    },
    renderTargetMarker: () => liveMapController.renderTargetMarker(),
    renderRouteLine: () => {
      liveMapController.renderRouteLine();
      liveMap3dController?.renderRouteOverlays();
    },
    renderOriginMarker: () => {
      liveMapController.renderOriginMarker();
      liveMap3dController?.renderRouteOverlays();
    },
  });

  function applyViewMode() {
    const use3d = is3dViewSelected() && Boolean(liveMap3dController);
    liveMap3dController?.setActive(use3d);
    if (!use3d) {
      liveMapController.syncFollowUiState();
      liveMapController.handleTabActivated();
    }
  }

  function requestSharedDestinationTarget() {
    return routeTargets.requestSharedDestinationTarget();
  }

  function requestSharedOriginTarget() {
    return routeTargets.requestSharedOriginTarget();
  }

  function handle3dTelemetry(msg) {
    switch (msg?.type) {
      case 'position': liveMap3dController?.handlePositionMessage(msg); break;
      case 'heading': liveMap3dController?.handleHeadingMessage(msg); break;
      case 'altitude': liveMap3dController?.handleAltitudeMessage(msg); break;
      case 'ias':
      case 'gs':
      case 'vs': liveMap3dController?.handleScalarMessage(msg); break;
      case 'attitude': liveMap3dController?.handleAttitudeMessage(msg); break;
      case 'simTime': liveMap3dController?.handleSimTimeMessage(msg); break;
    }
  }

  // Positions and their altitude/speed must be collected on the same clock.
  // Display frames can stop in a background window while flight continues.
  const hasTelemetrySubscription = typeof subscribeTelemetryMessageSignal === 'function';
  if (hasTelemetrySubscription) {
    cleanupFns.push(subscribeTelemetryMessageSignal(handle3dTelemetry));
  }

  if (typeof subscribeWsMessageSignal === 'function') {
    const unsubscribeWsMessage = subscribeWsMessageSignal((msg) => {
      if (!msg || typeof msg !== 'object') return;
      // Older embedders may supply only the processed message stream. Never
      // replay a delayed display sample over telemetry already collected raw.
      if (!hasTelemetrySubscription) handle3dTelemetry(msg);

      if (msg.type === 'position') {
        liveMapController.handlePositionMessage(msg);
        return;
      }

      if (msg.type === 'heading') {
        liveMapController.handleHeadingMessage(msg);
        return;
      }

      if (msg.type === 'flightPlan') {
        routeTargets.handleFlightPlanMessage(msg);
        return;
      }

      if (msg.type === 'airportLookupResult') {
        routeTargets.handleAirportLookupResult(msg);
        return;
      }

      if (msg.type === 'destinationTarget') {
        routeTargets.handleDestinationTargetMessage(msg);
        return;
      }

      if (msg.type === 'destinationTargetError') {
        routeTargets.handleDestinationTargetErrorMessage(msg);
        return;
      }

      if (msg.type === 'originTarget') {
        routeTargets.handleOriginTargetMessage(msg);
        return;
      }

      if (msg.type === 'originTargetError') {
        routeTargets.handleOriginTargetErrorMessage(msg);
        return;
      }

    });
    cleanupFns.push(unsubscribeWsMessage);
  }

  const handleResize = () => {
    liveMapController.handleWindowResize();
    liveMap3dController?.handleWindowResize();
  };
  windowRef.addEventListener('resize', handleResize);
  cleanupFns.push(() => windowRef.removeEventListener?.('resize', handleResize));

  const handleVisibilityChange = () => {
    const documentRef = windowRef.document;
    if (documentRef?.visibilityState === 'hidden' || documentRef?.hidden === true) {
      liveMap3dController?.suspend();
      return;
    }
    if (!isLiveTabShowing()) return;
    liveMapController.handleTabActivated();
    liveMap3dController?.handleTabActivated();
  };
  windowRef.document?.addEventListener?.('visibilitychange', handleVisibilityChange);
  cleanupFns.push(() => (
    windowRef.document?.removeEventListener?.('visibilitychange', handleVisibilityChange)
  ));

  if (tabsStore) {
    const stopTabsWatch = watch(
      () => tabsStore.activeTabId,
      (tabId) => {
        if (tabId === 'livemap') {
          liveMapController.handleTabActivated();
          liveMap3dController?.handleTabActivated();
        } else {
          liveMap3dController?.suspend();
        }
      },
      // Resume only after the selected tab's surface has become visible.
      { flush: 'post' },
    );
    cleanupFns.push(stopTabsWatch);
  }

  liveMapController.restoreFollowMode();
  liveMapController.syncFollowUiState();
  liveMap3dController?.restoreFollowMode();
  routeTargets.updateDestinationProgress();

  // Flush after the DOM update so the newly selected surface is visible
  // when its controller checks whether it may start.
  const stopViewModeWatch = watch(
    () => liveMapStore.viewMode,
    () => {
      applyViewMode();
    },
    { flush: 'post' },
  );
  cleanupFns.push(stopViewModeWatch);

  const stopMap3dOptionsWatch = watch(
    () => liveMapStore.map3dOptions,
    () => {
      liveMap3dController?.applyOptions();
    },
    { deep: true },
  );
  cleanupFns.push(stopMap3dOptionsWatch);
  applyViewMode();

  if (requestSharedDestinationTarget()) {
    routeTargets.updateTargetStatus('Syncing destination...');
  }
  if (requestSharedOriginTarget()) {
    routeTargets.updateOriginStatus('Syncing origin...');
  }

  if (statusStore) {
    const stopStatusWatch = watch(
      () => statusStore.websocket,
      (state, previousState) => {
        if (state === 'ready' && previousState !== 'ready') {
          requestSharedDestinationTarget();
          requestSharedOriginTarget();
          // Both views restore their own state; the active one syncs the
          // follow badge last so it wins.
          liveMapController.handleWsOpen();
          liveMap3dController?.handleWsOpen();
          if (!is3dViewSelected()) liveMapController.syncFollowUiState();
          return;
        }

        if ((state === 'disconnected' || state === 'error') && previousState !== state) {
          liveMapController.handleWsClose();
          liveMap3dController?.handleWsClose();
        }
      },
    );
    cleanupFns.push(stopStatusWatch);
  }

  liveMapStore.bindRuntimeActions({
    onCenter() {
      activeMapController().resumeFollowAndCenter();
    },
    onSetTarget() {
      routeTargets.requestAirportLookup('destination');
    },
    onClearTarget() {
      routeTargets.clearTargetSelection();
    },
    onSetOrigin() {
      routeTargets.requestAirportLookup('origin');
    },
    onClearOrigin() {
      routeTargets.clearOriginSelection();
    },
  });

  return function cleanupLiveMapRuntime() {
    for (const cleanup of cleanupFns.splice(0).reverse()) {
      try {
        cleanup?.();
      } catch {}
    }
    liveMapStore.bindRuntimeActions({});
    routeTargets.cleanup?.();
    liveMap3dController?.cleanup?.();
    liveMapController.cleanup?.();
  };
}
