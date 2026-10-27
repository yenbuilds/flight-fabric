export function initDebugRuntime({
  $,
  debugStore = null,
  getCurrentDebugState = null,
  subscribeDebugFrameSignal = null,
  subscribeTelemetryResetSignal = null,
  subscribeWsCloseSignal = null,
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
  let clearChangedFlagsTimer = null;
  let lastModalOpen = debugStore.modalOpen === true;

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
    debugConnected = false;
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
  };
}
