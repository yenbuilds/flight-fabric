import {
  describeAircraftCommandRequest,
  describeAircraftControlAction,
  describeAircraftControlRequest,
  getAircraftControlRequestPendingKey,
} from './control-ui.js';
import { comRadioResultText } from './com-radio.js';
import { baroResultText } from './baro.js';

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
      for (const key of pending.pendingKeys) controlsStore?.clearCommandPending?.(key);
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
    // A page can supply its physical-control key, but that must not replace
    // ownership of the canonical command shared with voice and other panels.
    const pendingKeys = [];
    if (canStorePending) {
      const keys = new Set([resolvedPendingKey, ...(messageType === 'executeAircraftCommand'
        ? [`aircraft-command:${request.commandId}`] : [])]);
      for (const key of keys) {
        if (controlsStore.setCommandPending(key) === false) {
          for (const acquired of pendingKeys) controlsStore.clearCommandPending(acquired);
          return false;
        }
        pendingKeys.push(key);
      }
    }
    const startedAtMs = Number(now());
    const boundedMinimumPendingMs = Number.isFinite(minimumPendingMs)
      ? Math.max(0, Math.min(5000, Number(minimumPendingMs)))
      : 0;
    pendingRequests.set(requestId, {
      pendingKey: canStorePending ? resolvedPendingKey : '',
      pendingKeys,
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
    let sent = false;
    try {
      sent = wsSend({
        ...request,
        type: messageType,
        requestId,
        profileKey: activeProfileToken.profileKey,
        profileRevision: activeProfileToken.profileRevision,
      }) !== false;
    } catch {
      // A failed transport cannot produce the result that normally clears busy state.
    }
    if (!sent) {
      pendingRequests.delete(requestId);
      for (const key of pendingKeys) controlsStore.clearCommandPending(key);
      const error = 'Control request could not be sent. Check the backend connection.';
      setFeedback({ actionText: description, routeText: error, status: 'failed', commandKey: resolvedPendingKey });
      emitToast('error', 'Aircraft control failed', error, { durationMs: 4800 });
      return false;
    }
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
    for (const pendingKey of pending?.pendingKeys || []) {
      const elapsedMs = Number(now()) - pending.startedAtMs;
      const remainingMs = Number.isFinite(elapsedMs)
        ? Math.max(0, pending.minimumPendingMs - elapsedMs)
        : 0;
      if (remainingMs > 0) {
        const timerEntry = { timerId: null };
        pendingClearTimers.set(pendingKey, timerEntry);
        timerEntry.timerId = setTimeoutRef(() => {
          if (pendingClearTimers.get(pendingKey) !== timerEntry) return;
          pendingClearTimers.delete(pendingKey);
          controlsStore?.clearCommandPending?.(pendingKey);
        }, remainingMs);
      } else {
        controlsStore?.clearCommandPending?.(pendingKey);
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

    if (/^baro\.(captain|firstOfficer|both)\./.test(msg.commandId || '')) {
      const result = baroResultText(msg);
      const routeText = result.confirmed ? 'Aircraft altimeter readbacks confirmed.' : 'Check the aircraft altimeters.';
      setFeedback({ actionText: result.text, routeText, profileText: profileKey, status: result.confirmed ? 'sent' : 'failed', commandKey: pending?.pendingKey });
      emitToast(result.confirmed ? 'success' : 'warning', result.text, routeText, { durationMs: 6000 });
      notifyResult(pending, msg);
      return;
    }
    if (msg?.ok) {
      if (/^radios\.com[12]\./.test(msg.commandId || '')) {
        const actionText = comRadioResultText(msg) || `${description} sent; radio response unconfirmed`;
        const confirmed = Boolean(comRadioResultText(msg));
        const routeText = confirmed ? 'Aircraft radio readback confirmed.' : 'Check the aircraft radio.';
        setFeedback({ actionText, routeText, profileText: profileKey, status: 'sent', commandKey: pending?.pendingKey });
        emitToast(confirmed ? 'success' : 'warning', actionText, routeText, { durationMs: 4200 });
        notifyResult(pending, msg);
        return;
      }
      const apuStart = msg.commandId === 'configuration.apu.start';
      if ((msg.transportAcknowledged === true && msg.code !== 'sent_unconfirmed') || (apuStart && msg.code === 'already_satisfied')) {
        const alreadyActive = apuStart && msg.code === 'already_satisfied';
        const actionText = alreadyActive ? 'APU already starting or running'
          : (apuStart ? 'APU start requested' : `${description} requested`);
        const routeText = alreadyActive ? 'No additional START was sent.'
          : 'Control request accepted. Aircraft outcome is not yet confirmed.';
        setFeedback({ actionText, routeText, profileText: profileKey, status: 'sent',
          commandKey: pending?.pendingKey || getAircraftControlRequestPendingKey(msg?.request) });
        emitToast('success', actionText, routeText, { durationMs: 3600 });
        notifyResult(pending, msg);
        return;
      }
      const unconfirmed = msg.code === 'sent_unconfirmed';
      const observationText = unconfirmed
        ? (stepCount > 1
            ? 'One or more aircraft responses are unconfirmed; check the simulator.'
            : msg.diagnostics?.readback?.status === 'changed_to_requested'
              ? 'Light readback changed; verify the cockpit control.'
              : 'Aircraft response unconfirmed; check the simulator.')
        : '';
      const transportLabel = msg.transportMode === 'direct-lvar'
        ? 'Direct LVAR fallback'
        : '';
      const routeParts = [
        msg.resolvedBy === 'profile' ? 'Profile override' : 'Generic fallback',
        stepSummary,
        describeAircraftControlAction(msg.action),
        transportLabel,
        msg.backendSource || '',
        observationText,
      ].filter(Boolean);

      const routeText = routeParts.join(' \u00b7 ');
      setFeedback({
        actionText: description,
        routeText,
        profileText: profileKey,
        status: 'sent',
        commandKey: pending?.pendingKey || getAircraftControlRequestPendingKey(msg?.request),
      });
      emitToast(unconfirmed ? 'warning' : 'success', 'Aircraft control sent',
        `${description} \u00b7 ${routeText}`, { durationMs: unconfirmed ? 6000 : 3600 });
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
          ? `${completedStepCount} of ${stepCount} steps ${Array.isArray(msg.acceptedStepLabels) ? 'accepted' : 'completed'} before failure`
          : `0 of ${stepCount} ${stepCount === 1 ? 'step' : 'steps'} confirmed before failure`)
      : '';
    const partialFailureAdvice = partialStepSummary || executionStarted
      ? 'Verify aircraft state.'
      : '';
    const failureMessage = [
      Array.isArray(msg.acceptedStepLabels) && msg.acceptedStepLabels.length
        ? `Accepted: ${msg.acceptedStepLabels.join(', ')}` : partialStepSummary,
      msg.failedStepLabel ? `Failed step: ${msg.failedStepLabel}` : '',
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
    applyNavRadios: (data) => controlsStore.applyNavRadios?.(data),
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
