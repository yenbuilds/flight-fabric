import {
  describeAircraftCommandRequest,
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
  now = () => Date.now(),
  setTimeoutRef = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeoutRef = (timerId) => clearTimeout(timerId),
} = {}) {
  if (!aircraftControlsStore) {
    throw new Error('Aircraft controls store is required before aircraft control controller');
  }
  const controlsStore = aircraftControlsStore;
  let nextRequestId = 1;
  const pendingRequests = new Map();
  const pendingClearTimers = new Map();
  let activeProfileToken = null;
  let simStateBlocker = '';

  function getSimStateBlocker(state = {}) {
    if (state?.simconnectConnected === false) {
      return 'Simulator telemetry link unavailable.';
    }
    if (state?.inMenu === true || state?.blocked === true) {
      return 'Simulator is in a menu or loading state.';
    }
    const lifecycleState = typeof state?.lifecycleState === 'string'
      ? state.lifecycleState.trim().toLowerCase()
      : '';
    if (['blocked', 'crashed', 'in_menu', 'loading', 'shutting_down', 'shutting-down'].includes(lifecycleState)) {
      return 'Simulator lifecycle state is not safe for aircraft control writes.';
    }
    return '';
  }

  function applySimState(state = {}) {
    simStateBlocker = getSimStateBlocker(state);
    return {
      blocked: Boolean(simStateBlocker),
      reason: simStateBlocker,
    };
  }

  function createRequestId() {
    const id = `ctrl-${Date.now()}-${nextRequestId}`;
    nextRequestId += 1;
    return id;
  }

  function setFeedback(feedback = {}) {
    controlsStore?.setFeedback?.(feedback);
  }

  function applyControlCapabilities(capabilities = {}, expectedProfileToken = null) {
    if (expectedProfileToken && typeof expectedProfileToken === 'object') {
      const expectedProfileKey = typeof expectedProfileToken.profileKey === 'string'
        ? expectedProfileToken.profileKey.trim()
        : '';
      const expectedProfileRevision = Number(expectedProfileToken.profileRevision);
      if (
        !activeProfileToken
        || !expectedProfileKey
        || !Number.isSafeInteger(expectedProfileRevision)
        || expectedProfileRevision < 0
        || activeProfileToken.profileKey !== expectedProfileKey
        || activeProfileToken.profileRevision !== expectedProfileRevision
      ) {
        return false;
      }
    }
    controlsStore?.applyControlCapabilities?.(capabilities);
    return true;
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
    // A profile transition invalidates both the native request and ownership of
    // its UI pending key. Cancel delayed clears before the store accepts
    // commands for the next aircraft, otherwise an old timer/result could clear
    // a new command that happens to reuse the same physical-control key.
    clearPendingRequests();
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
        toast: 'On the Flight Fabric PC, choose Phone, then scan the QR shown there.',
      };
    }

    if (typeof getSimconnectConnected === 'function' && getSimconnectConnected() !== true) {
      return {
        enabled: false,
        reason: 'Simulator telemetry link unavailable.',
        toast: 'Connect the simulator telemetry link before sending control commands.',
      };
    }

    if (simStateBlocker) {
      return {
        enabled: false,
        reason: simStateBlocker,
        toast: 'Return to the active flight before sending control commands.',
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
    const hadPending = pendingRequests.size > 0 || pendingClearTimers.size > 0;
    const abandonedRequests = [...pendingRequests.values()];
    for (const pending of abandonedRequests) {
      if (pending?.pendingKey) {
        controlsStore?.clearCommandPending?.(pending.pendingKey);
      }
    }
    pendingRequests.clear();
    for (const [pendingKey, timerEntry] of pendingClearTimers) {
      clearTimeoutRef(timerEntry?.timerId);
      controlsStore?.clearCommandPending?.(pendingKey);
    }
    pendingClearTimers.clear();
    for (const pending of abandonedRequests) {
      notifyResult(pending, {
        ok: false,
        cancelled: true,
        error: typeof reason === 'string' && reason.trim()
          ? reason.trim()
          : 'Aircraft control request was cancelled.',
      });
    }
    if (hadPending && typeof reason === 'string' && reason.trim()) {
      setFeedback({
        routeText: reason.trim(),
        status: 'failed',
      });
    }
  }

  function send(request, {
    pendingKey = '',
    minimumPendingMs = 0,
    messageType = 'executeAircraftControl',
    onResult = null,
  } = {}) {
    const requestedPendingKey = (typeof pendingKey === 'string' && pendingKey.trim())
      || (messageType === 'executeAircraftCommand'
        ? `aircraft-command:${request?.commandId || 'unknown'}`
        : getAircraftControlRequestPendingKey(request));
    const availability = updateAvailability();
    if (!availability.enabled) {
      const description = messageType === 'executeAircraftCommand'
        ? describeAircraftCommandRequest(request, controlsStore?.getAircraftCommand?.(request?.commandId))
        : describeAircraftControlRequest(request);
      setFeedback({
        actionText: description,
        routeText: availability.reason,
        status: 'failed',
        commandKey: requestedPendingKey,
      });
      emitToast('error', 'Aircraft control unavailable', availability.toast, { durationMs: 4800 });
      return false;
    }

    const wsSend = getWsSend();
    const requestId = createRequestId();
    const description = messageType === 'executeAircraftCommand'
      ? describeAircraftCommandRequest(request, controlsStore?.getAircraftCommand?.(request?.commandId))
      : describeAircraftControlRequest(request);
    const resolvedPendingKey = requestedPendingKey;
    const canStorePending = Boolean(
      resolvedPendingKey
      && typeof controlsStore?.setCommandPending === 'function'
      && typeof controlsStore?.clearCommandPending === 'function'
    );
    if (canStorePending) {
      if (controlsStore.setCommandPending(resolvedPendingKey) === false) return false;
    }
    const startedAtMs = Number(now());
    const boundedMinimumPendingMs = Number.isFinite(minimumPendingMs)
      ? Math.max(0, Math.min(5000, Number(minimumPendingMs)))
      : 0;
    pendingRequests.set(requestId, {
      pendingKey: canStorePending ? resolvedPendingKey : '',
      description,
      minimumPendingMs: boundedMinimumPendingMs,
      onResult: typeof onResult === 'function' ? onResult : null,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
    });
    setFeedback({
      actionText: description,
      routeText: 'Sending control request\u2026',
      profileText: 'Resolving against active profile\u2026',
      status: 'sending',
      commandKey: resolvedPendingKey,
    });
    wsSend({
      ...request,
      type: messageType,
      requestId,
      profileKey: activeProfileToken.profileKey,
      profileRevision: activeProfileToken.profileRevision,
    });
    return true;
  }

  function sendCommand(commandId, input = {}, options = {}) {
    if (typeof commandId !== 'string' || !commandId.trim()) return false;
    const normalizedCommandId = commandId.trim();
    if (controlsStore?.isAircraftCommandSupported?.(normalizedCommandId) === false) {
      const description = describeAircraftCommandRequest(
        { commandId: normalizedCommandId, input },
        controlsStore?.getAircraftCommand?.(normalizedCommandId),
      );
      setFeedback({
        actionText: description,
        routeText: 'The active aircraft does not expose this command.',
        status: 'failed',
        commandKey: options.pendingKey || `aircraft-command:${normalizedCommandId}`,
      });
      return false;
    }
    return send({ commandId: normalizedCommandId, input }, {
      ...options,
      messageType: 'executeAircraftCommand',
    });
  }

  function notifyResult(pending, result) {
    if (typeof pending?.onResult !== 'function') return;
    try {
      pending.onResult(result);
    } catch {
      // A result observer must not interrupt the shared feedback/toast path.
    }
  }

  function handleResult(msg) {
    const requestId = msg?.requestId || msg?.request?.requestId || null;
    // Correlated responses are owned only while their request is present in
    // this controller's pending map. A profile reset clears that ownership,
    // and the first accepted response consumes it. Ignore late, unknown, and
    // duplicate IDs before they can mutate feedback, toasts, or pending state.
    // Keep the request-id-less compatibility path for legacy/local callers.
    if (requestId && !pendingRequests.has(requestId)) return;
    const pending = requestId ? pendingRequests.get(requestId) : null;
    if (requestId) pendingRequests.delete(requestId);
    if (pending?.pendingKey) {
      const elapsedMs = Number(now()) - pending.startedAtMs;
      const remainingMs = Number.isFinite(elapsedMs)
        ? Math.max(0, pending.minimumPendingMs - elapsedMs)
        : 0;
      if (remainingMs > 0) {
        const timerEntry = { timerId: null };
        pendingClearTimers.set(pending.pendingKey, timerEntry);
        timerEntry.timerId = setTimeoutRef(() => {
          if (pendingClearTimers.get(pending.pendingKey) !== timerEntry) return;
          pendingClearTimers.delete(pending.pendingKey);
          controlsStore?.clearCommandPending?.(pending.pendingKey);
        }, remainingMs);
      } else {
        controlsStore?.clearCommandPending?.(pending.pendingKey);
      }
    }

    const description = pending?.description
      || (msg?.commandId
        ? describeAircraftCommandRequest(msg?.request || msg?.command, { label: msg?.commandLabel })
        : describeAircraftControlRequest(msg?.request));
    const profileKey = typeof msg?.profileKey === 'string' && msg.profileKey.trim()
      ? msg.profileKey.trim()
      : 'generic';
    const completedStepCount = Number(msg?.completedStepCount);
    const stepCount = Number(msg?.stepCount);
    const stepSummary = Number.isSafeInteger(completedStepCount)
      && completedStepCount >= 0
      && Number.isSafeInteger(stepCount)
      && stepCount > 1
      && completedStepCount <= stepCount
      ? `${completedStepCount} of ${stepCount} steps`
      : '';

    if (msg?.ok) {
      const transportLabel = msg.transportMode === 'direct-lvar'
        ? 'Direct LVAR fallback'
        : '';
      const routeParts = [
        msg.resolvedBy === 'profile' ? 'Profile override' : 'Generic fallback',
        stepSummary,
        describeAircraftControlAction(msg.action),
        transportLabel,
        msg.backendSource || '',
      ].filter(Boolean);

      const routeText = routeParts.join(' \u00b7 ');
      setFeedback({
        actionText: description,
        routeText,
        profileText: profileKey,
        status: 'sent',
        commandKey: pending?.pendingKey || getAircraftControlRequestPendingKey(msg?.request),
      });
      emitToast('success', 'Aircraft control sent', `${description} \u00b7 ${routeText}`, { durationMs: 3600 });
      notifyResult(pending, msg);
      return;
    }

    const executionStarted = msg?.executionStarted === true;
    const hasIncompleteStepProgress = Number.isSafeInteger(completedStepCount)
      && completedStepCount >= 0
      && Number.isSafeInteger(stepCount)
      && stepCount > 0
      && completedStepCount < stepCount
      && (completedStepCount > 0 || executionStarted);
    const partialStepSummary = hasIncompleteStepProgress
      ? (completedStepCount > 0
          ? `${completedStepCount} of ${stepCount} steps completed before failure`
          : `0 of ${stepCount} ${stepCount === 1 ? 'step' : 'steps'} confirmed before failure`)
      : '';
    const partialFailureAdvice = partialStepSummary || executionStarted
      ? 'Verify aircraft state.'
      : '';
    const failureMessage = [
      partialStepSummary,
      msg?.error || 'Request failed.',
      partialFailureAdvice,
    ].filter(Boolean).join(' \u00b7 ');
    const routeParts = [
      msg?.resolvedBy === 'profile' ? 'Profile override' : (msg?.resolvedBy === 'generic' ? 'Generic fallback' : ''),
      partialStepSummary,
      describeAircraftControlAction(msg?.action),
      msg?.code || '',
    ].filter(Boolean);

    setFeedback({
      actionText: description,
      routeText: routeParts.length > 0
        ? [routeParts.join(' \u00b7 '), msg?.error || 'Request failed.', partialFailureAdvice]
          .filter(Boolean)
          .join(' \u00b7 ')
        : failureMessage,
      profileText: profileKey,
      status: 'failed',
      commandKey: pending?.pendingKey || getAircraftControlRequestPendingKey(msg?.request),
    });
    emitToast('error', 'Aircraft control failed', failureMessage, { durationMs: 5200 });
    notifyResult(pending, msg);
  }

  return {
    applyControlCapabilities,
    applySimState,
    clearProfileToken,
    clearPendingRequests,
    handleResult,
    resetProfileState,
    send,
    sendCommand,
    setActiveProfileToken,
    setFeedback,
    updateAvailability,
  };
}
