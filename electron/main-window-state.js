'use strict';

const { normalizeBounds, normalizeWindowState, findDisplayForBounds, restoreMainWindowState } = require('./main-window-bounds');

// This controller only owns placement. It never shows/focuses the window or
// changes backend/recording lifetime, including when monitors are disconnected.
function trackMainWindowState({ window, screen, store, initialState, delay = 250, timers = globalThis }) {
  let state = normalizeWindowState(initialState);
  let saveTimer = null;
  let recoveryTimer = null;
  let deferredBounds = null;
  let disposed = false;
  let recovering = false;
  let resetPending = false;
  let fullscreenTransition = false;
  let resetTimer = null;

  function clearSaveTimer() {
    if (saveTimer !== null) timers.clearTimeout(saveTimer);
    saveTimer = null;
  }

  function capture() {
    if (disposed || window.isDestroyed()) return;
    // Some Windows versions temporarily return maximized/fullscreen frame
    // bounds as normal bounds while entering fullscreen. Keep the last normal
    // placement until the native transition has finished.
    if (fullscreenTransition || window.isFullScreen()) return;
    const bounds = deferredBounds || normalizeBounds(window.getNormalBounds());
    if (!bounds) return;
    const displays = screen.getAllDisplays().filter((display) => normalizeBounds(display.workArea));
    // A locked/disconnected remote desktop can briefly have no displays. Keep
    // the last real placement until a display returns, including during quit.
    if (displays.length === 0) return;
    const primary = screen.getPrimaryDisplay();
    const fallback = normalizeBounds(primary?.workArea) ? primary : state.display;
    const display = findDisplayForBounds(bounds, displays, fallback);
    state = {
      version: 1,
      bounds,
      // On Windows a minimized maximized window can report isMaximized=false.
      // Fullscreen is intentionally transient, and must not overwrite normal placement.
      maximized: window.isMinimized() || window.isFullScreen() ? state.maximized : window.isMaximized(),
      display: { id: display.id, workArea: { ...display.workArea } },
    };
  }

  function save() {
    clearSaveTimer();
    capture();
    if (state) store.save(state);
  }

  function scheduleSave() {
    if (disposed || recovering) return;
    capture();
    clearSaveTimer();
    saveTimer = timers.setTimeout(save, delay);
    saveTimer?.unref?.();
  }

  function recover() {
    recoveryTimer = null;
    if (disposed || window.isDestroyed()) return;
    const displays = screen.getAllDisplays().filter((display) => normalizeBounds(display.workArea));
    if (displays.length === 0) return;
    const restored = restoreMainWindowState(state, displays, screen.getPrimaryDisplay());
    recovering = true;
    try {
      window.setMinimumSize(restored.windowOptions.minWidth, restored.windowOptions.minHeight);
      if (window.isMaximized() || window.isMinimized() || window.isFullScreen()) {
        deferredBounds = restored.bounds;
      } else {
        deferredBounds = null;
        if (JSON.stringify(window.getNormalBounds()) !== JSON.stringify(restored.bounds)) {
          window.setBounds(restored.bounds);
        }
      }
      state = normalizeWindowState(restored);
    } finally {
      recovering = false;
    }
    save();
  }

  function scheduleRecovery() {
    if (recoveryTimer !== null) timers.clearTimeout(recoveryTimer);
    recoveryTimer = timers.setTimeout(recover, delay);
    recoveryTimer?.unref?.();
  }

  function onMetricsChanged(_event, _display, changedMetrics) {
    if (changedMetrics.some((metric) => ['bounds', 'workArea', 'scaleFactor', 'rotation'].includes(metric))) {
      scheduleRecovery();
    }
  }

  function onRestore() {
    if (resetPending) {
      scheduleReset();
      return;
    }
    if (deferredBounds && !window.isMaximized() && !window.isMinimized() && !window.isFullScreen()) {
      const bounds = deferredBounds;
      deferredBounds = null;
      window.setBounds(bounds);
    }
    scheduleSave();
  }

  function resetPlacement() {
    if (disposed || window.isDestroyed()) return;
    resetPending = true;
    deferredBounds = null;
    if (window.isFullScreen()) {
      // Fullscreen transitions are asynchronous; writing normal bounds before
      // leave-full-screen can have them overwritten by the native transition.
      window.setFullScreen(false);
      return;
    }
    if (window.isMinimized()) { window.restore(); return; }
    if (window.isMaximized()) { window.unmaximize(); return; }
    if (recoveryTimer !== null) timers.clearTimeout(recoveryTimer);
    recoveryTimer = null;
    const restored = restoreMainWindowState(null, screen.getAllDisplays(), screen.getPrimaryDisplay());
    recovering = true;
    try {
      window.setMinimumSize(restored.windowOptions.minWidth, restored.windowOptions.minHeight);
      window.setBounds(restored.bounds);
      state = normalizeWindowState(restored);
      resetPending = false;
    } finally {
      recovering = false;
    }
    save();
  }

  function scheduleReset() {
    if (resetTimer !== null) timers.clearTimeout(resetTimer);
    resetTimer = timers.setTimeout(() => { resetTimer = null; resetPlacement(); }, 0);
  }

  function onLeaveFullscreen() {
    fullscreenTransition = false;
    if (resetPending) {
      // Windows can reapply its pre-fullscreen maximized state after emitting
      // leave-full-screen. Finish the explicit reset after that native event.
      scheduleReset();
    } else {
      onRestore();
    }
  }

  const windowListeners = [
    ['move', scheduleSave], ['resize', scheduleSave], ['maximize', scheduleSave],
    ['enter-full-screen', () => { fullscreenTransition = true; }],
    ['unmaximize', onRestore], ['restore', onRestore], ['leave-full-screen', onLeaveFullscreen],
    ['close', save], ['hide', save], ['closed', dispose],
  ];
  const screenListeners = [
    ['display-added', scheduleRecovery], ['display-removed', scheduleRecovery],
    ['display-metrics-changed', onMetricsChanged],
  ];

  function dispose() {
    if (disposed) return;
    save();
    disposed = true;
    if (recoveryTimer !== null) timers.clearTimeout(recoveryTimer);
    if (resetTimer !== null) timers.clearTimeout(resetTimer);
    for (const [event, listener] of windowListeners) window.removeListener(event, listener);
    for (const [event, listener] of screenListeners) screen.removeListener(event, listener);
  }

  for (const [event, listener] of windowListeners) window.on(event, listener);
  for (const [event, listener] of screenListeners) screen.on(event, listener);
  return { save, dispose, resetPlacement };
}

function showMainWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// Keep the owner heartbeat alive while taxiing behind MSFS. Restore normal
// background power saving as soon as the panel releases its activity.
function setAutotaxiBackgroundActivity(contents, active) {
  if (typeof active !== 'boolean') throw new TypeError('Invalid Autotaxi activity');
  if (!contents || contents.isDestroyed()) return { ok: false };
  contents.setBackgroundThrottling(!active);
  return { ok: true };
}

module.exports = { trackMainWindowState, showMainWindow, setAutotaxiBackgroundActivity };
