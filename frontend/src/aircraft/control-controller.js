import {
  describeAircraftControlAction,
  describeAircraftControlRequest,
  getAircraftControlRequestPendingKey,
} from './control-ui.js';

export function createAircraftControlController({
  WebSocketRef = WebSocket,
  getWs,
  getWsSend,
  getAuthorizationScope = () => 'read-only',
  getSimconnectConnected,
  aircraftControlsStore = null,
  showToast,
} = {}) {
  if (!aircraftControlsStore) {
    throw new Error('Aircraft controls store is required before aircraft control controller');
  }
  const controlsStore = aircraftControlsStore;
  let nextRequestId = 1;
  const pendingRequests = new Map();
  let activeProfileToken = null;

  function createRequestId() {
    const id = `ctrl-${Date.now()}-${nextRequestId}`;
    nextRequestId += 1;
    return id;
  }

  function setFeedback({ actionText, routeText, profileText } = {}) {
    controlsStore?.setFeedback?.({ actionText, routeText, profileText });
  }

  function applyControlCapabilities(capabilities = {}) {
    controlsStore?.applyControlCapabilities?.(capabilities);
  }

  function setActiveProfileToken(profile = {}) {
    const profileKey = typeof profile?._profileKey === 'string' && profile._profileKey.trim()
      ? profile._profileKey.trim()
      : (typeof profile?._qualifiedId === 'string' && profile._qualifiedId.trim()
          ? profile._qualifiedId.trim()
          : (profile?.namespace && profile?.simulator && profile?.id
              ? `${profile.namespace}/${profile.simulator}/${profile.id}`
              : ''));
    const profileRevision = Number(profile?.profileRevision);
    activeProfileToken = profileKey && Number.isSafeInteger(profileRevision) && profileRevision >= 0
      ? { profileKey, profileRevision }
      : null;
  }

  function clearProfileToken() {
    activeProfileToken = null;
  }

  function resetProfileState(reason) {
    clearProfileToken();
    controlsStore?.prepareForAircraftChange?.(reason);
  }

  function emitToast(kind, title, message, options = {}) {
    if (typeof showToast === 'function') {
      showToast(kind, title, message, options);
    }
  }

  function getAvailability() {
    const ws = typeof getWs === 'function' ? getWs() : null;
    const wsSend = typeof getWsSend === 'function' ? getWsSend() : null;
    if (!ws || ws.readyState !== WebSocketRef.OPEN || typeof wsSend !== 'function') {
      return {
        enabled: false,
        reason: 'Backend connection unavailable.',
        toast: 'Connect to the backend before sending control commands.',
      };
    }

    const authorizationScope = typeof getAuthorizationScope === 'function'
      ? getAuthorizationScope()
      : 'read-only';
    if (authorizationScope !== 'full-control' && authorizationScope !== 'aircraft-control') {
      return {
        enabled: false,
        reason: 'This browser has read-only access.',
        toast: 'Open the session-paired Mobile Browser URL before sending aircraft controls.',
      };
    }

    if (typeof getSimconnectConnected === 'function' && getSimconnectConnected() !== true) {
      return {
        enabled: false,
        reason: 'Simulator telemetry link unavailable.',
        toast: 'Connect the simulator telemetry link before sending control commands.',
      };
    }

    if (!activeProfileToken) {
      return {
        enabled: false,
        reason: 'Waiting for current aircraft profile.',
        toast: 'Wait for the active aircraft profile to finish loading before sending control commands.',
      };
    }

    return {
      enabled: true,
      reason: 'Ready. Commands are checked against the active profile and provider safety gate.',
      toast: '',
    };
  }

  function updateAvailability() {
    const availability = getAvailability();
    controlsStore?.setAvailability?.(availability);
    return availability;
  }

  function clearPendingRequests(reason) {
    const hadPending = pendingRequests.size > 0;
    for (const pending of pendingRequests.values()) {
      if (pending?.pendingKey) {
        controlsStore?.clearCommandPending?.(pending.pendingKey);
      }
    }
    pendingRequests.clear();
    if (hadPending && typeof reason === 'string' && reason.trim()) {
      setFeedback({
        routeText: reason.trim(),
      });
    }
  }

  function send(request, { pendingKey = '' } = {}) {
    const availability = updateAvailability();
    if (!availability.enabled) {
      const description = describeAircraftControlRequest(request);
      setFeedback({
        actionText: description,
        routeText: availability.reason,
      });
      emitToast('error', 'Aircraft control unavailable', availability.toast, { durationMs: 4800 });
      return false;
    }

    const wsSend = getWsSend();
    const requestId = createRequestId();
    const description = describeAircraftControlRequest(request);
    const resolvedPendingKey = (typeof pendingKey === 'string' && pendingKey.trim())
      || getAircraftControlRequestPendingKey(request);
    const canStorePending = Boolean(
      resolvedPendingKey
      && typeof controlsStore?.setCommandPending === 'function'
      && typeof controlsStore?.clearCommandPending === 'function'
    );
    if (canStorePending) {
      controlsStore.setCommandPending(resolvedPendingKey);
    }
    pendingRequests.set(requestId, {
      pendingKey: canStorePending ? resolvedPendingKey : '',
      description,
    });
    setFeedback({
      actionText: description,
      routeText: 'Sending control request\u2026',
      profileText: 'Resolving against active profile\u2026',
    });
    wsSend({
      ...request,
      type: 'executeAircraftControl',
      requestId,
      profileKey: activeProfileToken.profileKey,
      profileRevision: activeProfileToken.profileRevision,
    });
    return true;
  }

  function handleResult(msg) {
    const requestId = msg?.requestId || msg?.request?.requestId || null;
    const pending = requestId ? pendingRequests.get(requestId) : null;
    if (requestId) pendingRequests.delete(requestId);
    if (pending?.pendingKey) {
      controlsStore?.clearCommandPending?.(pending.pendingKey);
    }

    const description = pending?.description || describeAircraftControlRequest(msg?.request);
    const profileKey = typeof msg?.profileKey === 'string' && msg.profileKey.trim()
      ? msg.profileKey.trim()
      : 'generic';

    if (msg?.ok) {
      const transportLabel = msg.transportMode === 'direct-lvar'
        ? 'Direct LVAR fallback'
        : '';
      const routeParts = [
        msg.resolvedBy === 'profile' ? 'Profile override' : 'Generic fallback',
        describeAircraftControlAction(msg.action),
        transportLabel,
        msg.backendSource || '',
      ].filter(Boolean);

      const routeText = routeParts.join(' \u00b7 ');
      setFeedback({
        actionText: description,
        routeText,
        profileText: profileKey,
      });
      emitToast('success', 'Aircraft control sent', `${description} \u00b7 ${routeText}`, { durationMs: 3600 });
      return;
    }

    const routeParts = [
      msg?.resolvedBy === 'profile' ? 'Profile override' : (msg?.resolvedBy === 'generic' ? 'Generic fallback' : ''),
      describeAircraftControlAction(msg?.action),
      msg?.code || '',
    ].filter(Boolean);

    setFeedback({
      actionText: description,
      routeText: routeParts.length > 0
        ? `${routeParts.join(' \u00b7 ')} \u00b7 ${msg?.error || 'Request failed.'}`
        : (msg?.error || 'Request failed.'),
      profileText: profileKey,
    });
    emitToast('error', 'Aircraft control failed', msg?.error || 'Request failed.', { durationMs: 5200 });
  }

  return {
    applyControlCapabilities,
    clearProfileToken,
    clearPendingRequests,
    handleResult,
    resetProfileState,
    send,
    setActiveProfileToken,
    setFeedback,
    updateAvailability,
  };
}
