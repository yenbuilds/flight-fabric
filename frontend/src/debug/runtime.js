/**
 * One-line status for a testShakeAck. The backend sends one ack when the shake
 * starts and a second one (phase 'done', with sidecar write counters) after it
 * has played, so the last thing on screen says whether the sim accepted it.
 */
export function formatTestShakeAck(message) {
  const diag = message?.diag || {};
  const shake = diag.shake;
  const writes = diag.writes;
  const parts = [];
  if (shake && typeof shake === 'object') {
    if (shake.ok) {
      const seconds = typeof shake.durationMs === 'number' ? (shake.durationMs / 1000).toFixed(1) : '?';
      const severity = typeof shake.severity === 'number' ? shake.severity.toFixed(2) : '?';
      const drop = typeof shake.peakDropMeters === 'number' ? `${(shake.peakDropMeters * 100).toFixed(1)}cm` : '';
      parts.push(`${shake.method || 'shake'} ${seconds}s sev=${severity}${drop ? ` drop=${drop}` : ''}`);
    } else {
      parts.push(`skipped: ${shake.reason || 'unknown'}`);
    }
  } else {
    parts.push(`mock=${diag.isMock} bridge=${diag.lvarBridge} started=${diag.lvarStarted} proc=${diag.lvarProcAlive} conn=${diag.connected} hdl=${diag.handle}`);
  }
  if (writes && typeof writes === 'object') {
    const failures = Number(writes.failed) || 0;
    parts.push(`writes ok=${Number(writes.ok) || 0} fail=${failures}${failures && writes.lastError ? ` (${writes.lastError})` : ''}`);
  } else if (message?.phase === 'started' && shake?.ok) {
    parts.push('playing...');
  }
  return `ack ${message?.vs_fpm}fpm | ${parts.join(' | ')}`;
}

export function initDebugRuntime({
  $,
  sendWs,
  debugStore = null,
  getCurrentDebugState = null,
  subscribeDebugFrameSignal = null,
  subscribeTelemetryResetSignal = null,
  subscribeWsCloseSignal = null,
  subscribeWsMessageSignal = null,
  windowRef = window,
  documentRef = document,
  consoleRef = console,
} = {}) {
  const debugModal = $('debug-modal');
  const cleanupFns = [];
  const captureCleanupFns = [];

  consoleRef.log('[Debug] Initializing debug panel (Ctrl+Shift+D to toggle)');
  consoleRef.log('[Debug] Modal:', !!debugModal);

  if (!debugModal || !debugStore) return null;

  debugStore.setToggleVisible(true);
  consoleRef.log('[Debug] Footer toggle enabled');

  let debugConnected = false;
  let captureActive = false;
  let shakeStatusTimer = null;
  let clearChangedFlagsTimer = null;
  let lastModalOpen = debugStore.modalOpen === true;
  let lastShakeRequestNonce = debugStore.testShakeRequestNonce;

  function clearShakeStatusTimer() {
    if (shakeStatusTimer == null) return;
    windowRef.clearTimeout(shakeStatusTimer);
    shakeStatusTimer = null;
  }

  function setShakeStatus(text, timeoutMs = 0) {
    debugStore.setTestShakeStatus(text);
    clearShakeStatusTimer();
    if (timeoutMs > 0) {
      shakeStatusTimer = windowRef.setTimeout(() => {
        debugStore.clearTestShakeStatus();
        shakeStatusTimer = null;
      }, timeoutMs);
    }
  }

  function processDebugFrame(message) {
    debugStore.ingestFrame(message);
  }

  function toggleDebugPanel() {
    debugStore.toggleModal();
  }

  function updateDebugConnectionStatus(message) {
    let isActuallyConnected = null;
    if (message?.type === 'simState' && typeof message.simconnectConnected === 'boolean') {
      isActuallyConnected = message.simconnectConnected;
    } else if (typeof message?.primary?.connected === 'boolean') {
      isActuallyConnected = message.primary.connected;
    }

    if (isActuallyConnected == null) return;
    if (isActuallyConnected !== debugConnected) {
      debugConnected = isActuallyConnected;
    }
    debugStore.setConnectionStatus(isActuallyConnected);
  }

  function addCaptureCleanup(dispose) {
    if (typeof dispose === 'function') captureCleanupFns.push(dispose);
  }

  function stopCapture() {
    if (captureActive) {
      captureActive = false;
      while (captureCleanupFns.length > 0) {
        const dispose = captureCleanupFns.pop();
        try {
          dispose();
        } catch {}
      }
    }

    if (clearChangedFlagsTimer != null) {
      windowRef.clearInterval?.(clearChangedFlagsTimer);
      clearChangedFlagsTimer = null;
    }
    clearShakeStatusTimer();
    debugConnected = false;
    debugStore.clearTestShakeStatus();
    debugStore.clearCapturedData();
    debugStore.setConnectionUnknown();
  }

  function startCapture() {
    if (captureActive) return;
    captureActive = true;
    debugStore.clearCapturedData();

    const currentState = typeof getCurrentDebugState === 'function'
      ? (getCurrentDebugState() || {})
      : {};
    debugStore.ingestMetadata({ type: 'phase', value: currentState.phase });
    if (currentState.websocketReady === false) {
      debugStore.setConnectionUnknown();
    } else if (typeof currentState.simConnected === 'boolean') {
      debugConnected = currentState.simConnected;
      debugStore.setConnectionStatus(currentState.simConnected);
    }

    if (typeof subscribeWsMessageSignal === 'function') {
      addCaptureCleanup(subscribeWsMessageSignal((message) => {
        if (message?.type === 'testShakeAck') {
          setShakeStatus(formatTestShakeAck(message), 8000);
        }
      }));
    }

    if (typeof subscribeWsCloseSignal === 'function') {
      addCaptureCleanup(subscribeWsCloseSignal(() => {
        debugConnected = false;
        debugStore.setConnectionUnknown();
      }));
    }

    if (typeof subscribeTelemetryResetSignal === 'function') {
      addCaptureCleanup(subscribeTelemetryResetSignal(() => {
        debugStore.clearCapturedData();
      }));
    }

    if (typeof subscribeDebugFrameSignal === 'function') {
      addCaptureCleanup(subscribeDebugFrameSignal((message) => {
        debugStore.ingestMetadata(message);
        updateDebugConnectionStatus(message);
        processDebugFrame(message);
      }));
    }

    clearChangedFlagsTimer = windowRef.setInterval(() => {
      debugStore.clearChangedFlags();
    }, 500);
  }

  function handleKeydown(event) {
    if (event.ctrlKey && event.shiftKey && event.key === 'D') {
      event.preventDefault();
      toggleDebugPanel();
    }
    if (event.key === 'Escape' && debugStore.modalOpen) {
      debugStore.setModalOpen(false);
    }
  }

  documentRef.addEventListener('keydown', handleKeydown);
  cleanupFns.push(() => documentRef.removeEventListener?.('keydown', handleKeydown));

  const unsubscribeStore = debugStore.$subscribe((_mutation, state) => {
    if (state.modalOpen !== lastModalOpen) {
      lastModalOpen = state.modalOpen;
      if (lastModalOpen) startCapture();
      else stopCapture();
    }

    if (state.testShakeRequestNonce === lastShakeRequestNonce) return;
    lastShakeRequestNonce = state.testShakeRequestNonce;

    const vsFpm = Number(state.testShakeVs || -400);
    const method = state.testShakeMethod === 'camera6dof' ? 'camera6dof' : 'eyepoint';
    if (sendWs({ type: 'testShake', vs_fpm: vsFpm, method })) {
      setShakeStatus(`Sent (${vsFpm} fpm, ${method})`, 2000);
      return;
    }

    setShakeStatus('WS not ready', 2000);
  }, { detached: true, flush: 'sync' });
  cleanupFns.push(unsubscribeStore);

  if (lastModalOpen) startCapture();

  function cleanup() {
    stopCapture();
    while (cleanupFns.length > 0) {
      const dispose = cleanupFns.pop();
      try {
        dispose();
      } catch {}
    }
    debugStore.setToggleVisible(false);
  }

  return {
    cleanup,
    processDebugFrame,
    startCapture,
    stopCapture,
    toggleDebugPanel,
    updateDebugConnectionStatus,
  };
}
