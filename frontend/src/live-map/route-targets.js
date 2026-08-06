export function createRouteTargetsController({
  liveMapStore,
  isValidCoord,
  sendWsMessage = () => false,
  getLastPosition = () => null,
  getDistanceNm,
  getInitialBearingDeg,
  renderTargetLine = () => {},
  renderTargetMarker = () => {},
  renderRouteLine = () => {},
  renderOriginMarker = () => {},
} = {}) {
  let targetAirport = null;
  let originAirport = null;
  let targetInitialDistanceNm = null;
  const ignoredSyncIcao = { destination: null, origin: null };
  const lookupRequests = { destination: null, origin: null };
  const lookupTimeouts = { destination: null, origin: null };

  function clearLookup(kind) {
    lookupRequests[kind] = null;
    if (lookupTimeouts[kind]) {
      clearTimeout(lookupTimeouts[kind]);
      lookupTimeouts[kind] = null;
    }
  }

  function redrawDestinationState() {
    renderTargetLine();
    renderTargetMarker();
    renderRouteLine();
    updateTargetOverlay();
    updateDestinationProgress();
  }

  function redrawOriginState() {
    renderOriginMarker();
    renderRouteLine();
    updateDestinationProgress();
  }

  function updateTargetStatus(text, isError = false) {
    liveMapStore.setTargetStatus(text, isError ? 'error' : 'neutral');
  }

  function updateOriginStatus(text, isError = false) {
    liveMapStore.setOriginStatus(text, isError ? 'error' : 'neutral');
  }

  function clearDestinationState({
    clearInput = false,
    statusText = 'No target airport set',
    isError = false,
    syncServer = false,
  } = {}) {
    const previousIcao = targetAirport?.icao || liveMapStore.targetInput || '';
    targetAirport = null;
    targetInitialDistanceNm = null;
    clearLookup('destination');
    if (syncServer) {
      ignoredSyncIcao.destination = String(previousIcao || '').toUpperCase() || null;
    }
    if (clearInput) {
      liveMapStore.setTargetInput('');
    }
    updateTargetStatus(statusText, isError);
    redrawDestinationState();
    if (syncServer) {
      sendWsMessage({ type: 'clearDestinationTarget' });
    }
  }

  function clearOriginState({
    clearInput = false,
    statusText = 'No origin airport set',
    isError = false,
    syncServer = false,
  } = {}) {
    const previousIcao = originAirport?.icao || liveMapStore.originInput || '';
    originAirport = null;
    clearLookup('origin');
    if (syncServer) {
      ignoredSyncIcao.origin = String(previousIcao || '').toUpperCase() || null;
    }
    if (clearInput) {
      liveMapStore.setOriginInput('');
    }
    updateOriginStatus(statusText, isError);
    redrawOriginState();
    if (syncServer) {
      sendWsMessage({ type: 'clearOriginTarget' });
    }
  }

  function applyDestinationTarget(target, statusText) {
    const icao = String(target?.icao || '').toUpperCase();
    const name = String(target?.name || icao || '');
    const lat = Number(target?.lat);
    const lon = Number(target?.lon);
    const initialDistanceNm = Number(target?.initialDistanceNm);
    const lastPosition = getLastPosition();

    if (!icao || !isValidCoord(lat, lon)) {
      clearTargetSelection(false);
      return;
    }

    ignoredSyncIcao.destination = null;
    targetAirport = { icao, name, lat, lon };
    targetInitialDistanceNm = Number.isFinite(initialDistanceNm) && initialDistanceNm > 0
      ? initialDistanceNm
      : (lastPosition ? getDistanceNm(lastPosition.lat, lastPosition.lon, lat, lon) : null);

    liveMapStore.setTargetInput(icao);
    updateTargetStatus(statusText || `Target set: ${icao} (${name})`);
    redrawDestinationState();
  }

  function clearTargetSelection(syncServer = true) {
    clearDestinationState({
      clearInput: true,
      statusText: 'No target airport set',
      isError: false,
      syncServer,
    });
  }

  function applyOriginTarget(target, statusText) {
    const icao = String(target?.icao || '').toUpperCase();
    const name = String(target?.name || icao || '');
    const lat = Number(target?.lat);
    const lon = Number(target?.lon);

    if (!icao || !isValidCoord(lat, lon)) {
      clearOriginSelection(false);
      return;
    }

    ignoredSyncIcao.origin = null;
    originAirport = { icao, name, lat, lon };
    liveMapStore.setOriginInput(icao);
    updateOriginStatus(statusText || `From set: ${icao} (${name})`);
    redrawOriginState();
  }

  function clearOriginSelection(syncServer = true) {
    clearOriginState({
      clearInput: true,
      statusText: 'No origin airport set',
      isError: false,
      syncServer,
    });
  }

  function updateTargetOverlay() {
    const lastPosition = getLastPosition();
    if (!targetAirport || !lastPosition) {
      liveMapStore.hideOverlay();
      return;
    }

    const distanceNm = getDistanceNm(lastPosition.lat, lastPosition.lon, targetAirport.lat, targetAirport.lon);
    const bearingDeg = getInitialBearingDeg(lastPosition.lat, lastPosition.lon, targetAirport.lat, targetAirport.lon);
    const roundedBearing = Math.round(bearingDeg).toString().padStart(3, '0');
    const distanceText = distanceNm >= 100 ? `${Math.round(distanceNm)} NM` : `${distanceNm.toFixed(1)} NM`;

    liveMapStore.setOverlay({
      visible: true,
      rotationDeg: bearingDeg,
      primary: `${targetAirport.icao} - ${distanceText}`,
      secondary: `BRG ${roundedBearing} deg`,
    });
  }

  function updateDestinationProgress() {
    if (!targetAirport) {
      liveMapStore.hideDestinationProgress();
      return;
    }

    const progressLabel = originAirport
      ? `From ${originAirport.icao} -> To ${targetAirport.icao}`
      : `To ${targetAirport.icao}`;
    const lastPosition = getLastPosition();

    if (!lastPosition) {
      liveMapStore.setDestinationProgress({
        visible: true,
        label: progressLabel,
        text: 'Awaiting position',
        percent: 0,
      });
      return;
    }

    const remainingNm = getDistanceNm(lastPosition.lat, lastPosition.lon, targetAirport.lat, targetAirport.lon);
    let baselineDistanceNm = targetInitialDistanceNm;
    if (originAirport) {
      baselineDistanceNm = getDistanceNm(originAirport.lat, originAirport.lon, targetAirport.lat, targetAirport.lon);
    }
    if (!Number.isFinite(baselineDistanceNm) || baselineDistanceNm <= 0) {
      baselineDistanceNm = Math.max(remainingNm, 0.01);
    }
    if (!originAirport) {
      targetInitialDistanceNm = baselineDistanceNm;
    }

    const rawProgress = ((baselineDistanceNm - remainingNm) / baselineDistanceNm) * 100;
    const progressPct = Math.max(0, Math.min(100, rawProgress));
    const remText = remainingNm >= 100 ? `${Math.round(remainingNm)} NM` : `${remainingNm.toFixed(1)} NM`;

    liveMapStore.setDestinationProgress({
      visible: true,
      label: progressLabel,
      text: `${progressPct.toFixed(0)}% - ${remText} remaining`,
      percent: progressPct,
    });
  }

  function requestAirportLookup(kind) {
    const isOrigin = kind === 'origin';
    const icao = String(isOrigin ? liveMapStore.originInput : liveMapStore.targetInput).trim().toUpperCase();
    if (!icao) {
      if (isOrigin) {
        clearOriginSelection();
      } else {
        clearTargetSelection();
      }
      return false;
    }

    ignoredSyncIcao[kind] = null;
    const requestId = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    lookupRequests[kind] = requestId;

    if (!sendWsMessage({
      type: 'requestAirportLookup',
      icao,
      requestId,
    })) {
      if (isOrigin) {
        updateOriginStatus('WebSocket not connected', true);
      } else {
        updateTargetStatus('WebSocket not connected', true);
      }
      lookupRequests[kind] = null;
      return false;
    }

    if (isOrigin) {
      updateOriginStatus(`Looking up ${icao}...`);
    } else {
      updateTargetStatus(`Looking up ${icao}...`);
    }
    if (lookupTimeouts[kind]) {
      clearTimeout(lookupTimeouts[kind]);
      lookupTimeouts[kind] = null;
    }

    lookupTimeouts[kind] = setTimeout(() => {
      if (!lookupRequests[kind]) return;
      clearLookup(kind);

      if (isOrigin) {
        clearOriginState({
          clearInput: false,
          statusText: 'Lookup timed out. Restart backend to enable airport lookup.',
          isError: true,
          syncServer: false,
        });
        return;
      }

      clearDestinationState({
        clearInput: false,
        statusText: 'Lookup timed out. Restart backend to enable airport lookup.',
        isError: true,
        syncServer: false,
      });
    }, 6000);

    return true;
  }

  function requestSharedDestinationTarget() {
    return sendWsMessage({ type: 'requestDestinationTarget' });
  }

  function requestSharedOriginTarget() {
    return sendWsMessage({ type: 'requestOriginTarget' });
  }

  function handleFlightPlanMessage(message = {}) {
    if (message.cleared) return false;

    let handled = false;
    if (message.origin) {
      const originIcao = String(message.origin).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (originIcao && ignoredSyncIcao.origin !== originIcao && originAirport?.icao !== originIcao) {
        ignoredSyncIcao.origin = null;
        liveMapStore.setOriginInput(originIcao);
        requestAirportLookup('origin');
        handled = true;
      }
    }
    if (message.destination) {
      const destinationIcao = String(message.destination).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (destinationIcao && ignoredSyncIcao.destination !== destinationIcao && targetAirport?.icao !== destinationIcao) {
        ignoredSyncIcao.destination = null;
        liveMapStore.setTargetInput(destinationIcao);
        requestAirportLookup('destination');
        handled = true;
      }
    }

    return handled;
  }

  function handleAirportLookupResult(message = {}) {
    const responseRequestId = String(message.requestId || '');
    let lookupKind = null;
    if (responseRequestId && lookupRequests.destination === responseRequestId) lookupKind = 'destination';
    if (responseRequestId && lookupRequests.origin === responseRequestId) lookupKind = 'origin';
    if (!lookupKind) return false;

    clearLookup(lookupKind);
    const isOrigin = lookupKind === 'origin';

    if (!message.success) {
      if (isOrigin) {
        clearOriginState({
          clearInput: false,
          statusText: message.error || 'Airport lookup failed',
          isError: true,
          syncServer: false,
        });
      } else {
        clearDestinationState({
          clearInput: false,
          statusText: message.error || 'Airport lookup failed',
          isError: true,
          syncServer: false,
        });
      }
      return true;
    }

    const lat = Number(message.lat);
    const lon = Number(message.lon);
    if (!isValidCoord(lat, lon)) {
      if (isOrigin) {
        clearOriginState({
          clearInput: false,
          statusText: 'Airport has invalid coordinates',
          isError: true,
          syncServer: false,
        });
      } else {
        clearDestinationState({
          clearInput: false,
          statusText: 'Airport has invalid coordinates',
          isError: true,
          syncServer: false,
        });
      }
      return true;
    }

    const lastPosition = getLastPosition();
    const resolvedAirport = {
      icao: String(message.icao || '').toUpperCase(),
      name: message.name || String(message.icao || '').toUpperCase(),
      lat,
      lon,
      initialDistanceNm: lastPosition
        ? getDistanceNm(lastPosition.lat, lastPosition.lon, lat, lon)
        : null,
    };

    if (isOrigin) {
      applyOriginTarget(resolvedAirport, `From set: ${resolvedAirport.icao} (${resolvedAirport.name})`);
      sendWsMessage({
        type: 'setOriginTarget',
        target: resolvedAirport,
      });
    } else {
      applyDestinationTarget(resolvedAirport, `Target set: ${resolvedAirport.icao} (${resolvedAirport.name})`);
      sendWsMessage({
        type: 'setDestinationTarget',
        target: resolvedAirport,
      });
    }

    return true;
  }

  function handleDestinationTargetMessage(message = {}) {
    if (!message.target) {
      clearTargetSelection(false);
    } else {
      const icao = String(message.target.icao || '').toUpperCase();
      if (icao && ignoredSyncIcao.destination === icao) return false;
      const isSameTarget = targetAirport?.icao === icao;
      applyDestinationTarget(
        message.target,
        isSameTarget ? liveMapStore.targetStatusMessage : `Target synced: ${icao}`,
      );
    }
    return true;
  }

  function handleDestinationTargetErrorMessage(message = {}) {
    updateTargetStatus(message.error || 'Destination sync failed', true);
    return true;
  }

  function handleOriginTargetMessage(message = {}) {
    if (!message.target) {
      clearOriginSelection(false);
    } else {
      const icao = String(message.target.icao || '').toUpperCase();
      if (icao && ignoredSyncIcao.origin === icao) return false;
      const isSameOrigin = originAirport?.icao === icao;
      applyOriginTarget(
        message.target,
        isSameOrigin ? liveMapStore.originStatusMessage : `From synced: ${icao}`,
      );
    }
    return true;
  }

  function handleOriginTargetErrorMessage(message = {}) {
    updateOriginStatus(message.error || 'Origin sync failed', true);
    return true;
  }

  function cleanup() {
    clearLookup('destination');
    clearLookup('origin');
  }

  return {
    applyDestinationTarget,
    applyOriginTarget,
    cleanup,
    clearOriginSelection,
    clearTargetSelection,
    getOriginAirport: () => originAirport,
    getTargetAirport: () => targetAirport,
    handleAirportLookupResult,
    handleDestinationTargetErrorMessage,
    handleDestinationTargetMessage,
    handleFlightPlanMessage,
    handleOriginTargetErrorMessage,
    handleOriginTargetMessage,
    requestAirportLookup,
    requestSharedDestinationTarget,
    requestSharedOriginTarget,
    updateDestinationProgress,
    updateOriginStatus,
    updateTargetOverlay,
    updateTargetStatus,
  };
}
