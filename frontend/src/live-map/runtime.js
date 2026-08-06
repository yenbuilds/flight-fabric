// ES module - strict mode is implicit in modules.
import { watch } from 'vue';
import { createLiveMapController } from './map-controller.js';
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
  allowOnlineMapTiles = () => true,
  windowRef = window,
  localStorageRef = localStorage,
  consoleRef = console,
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

  let routeTargets = null;
  let liveMapController = null;

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
      windowRef.document?.hidden !== true
      && (!tabsStore || tabsStore.activeTabId === 'livemap')
      && Boolean(mapEl && mapEl.offsetParent !== null)
    ),
  });

  routeTargets = createRouteTargetsController({
    liveMapStore,
    isValidCoord: validateCoord,
    sendWsMessage: typeof sendMessage === 'function' ? sendMessage : (() => false),
    getLastPosition: () => liveMapController.getLastPosition(),
    getDistanceNm: liveMapController.getDistanceNm,
    getInitialBearingDeg: liveMapController.getInitialBearingDeg,
    renderTargetLine: () => liveMapController.renderTargetLine(),
    renderTargetMarker: () => liveMapController.renderTargetMarker(),
    renderRouteLine: () => liveMapController.renderRouteLine(),
    renderOriginMarker: () => liveMapController.renderOriginMarker(),
  });

  function requestSharedDestinationTarget() {
    return routeTargets.requestSharedDestinationTarget();
  }

  function requestSharedOriginTarget() {
    return routeTargets.requestSharedOriginTarget();
  }

  if (typeof subscribeWsMessageSignal === 'function') {
    const unsubscribeWsMessage = subscribeWsMessageSignal((msg) => {
      if (!msg || typeof msg !== 'object') return;

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
  };
  windowRef.addEventListener('resize', handleResize);
  cleanupFns.push(() => windowRef.removeEventListener?.('resize', handleResize));

  const handleVisibilityChange = () => {
    const documentRef = windowRef.document;
    if (documentRef?.hidden === true || documentRef?.visibilityState === 'hidden') return;
    liveMapController.handleTabActivated();
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
        }
      },
    );
    cleanupFns.push(stopTabsWatch);
  }

  liveMapController.restoreFollowMode();
  liveMapController.syncFollowUiState();
  routeTargets.updateDestinationProgress();

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
          liveMapController.handleWsOpen();
          return;
        }

        if ((state === 'disconnected' || state === 'error') && previousState !== state) {
          liveMapController.handleWsClose();
        }
      },
    );
    cleanupFns.push(stopStatusWatch);
  }

  liveMapStore.bindRuntimeActions({
    onCenter() {
      liveMapController.resumeFollowAndCenter();
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
    liveMapController.cleanup?.();
  };
}
