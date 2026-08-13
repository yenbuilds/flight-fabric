import { watch } from 'vue';

export function initSettingsRuntime({
  $,
  getAppSettings,
  getWs,
  settingsEditorStore,
  settingsFormStore,
  settingsUiStore,
  subscribeAppSettingsSignal = null,
  subscribeAppSettingsSavedSignal = null,
  subscribeWsOpenSignal = null,
  tabsStore = null,
  showAppToast = null,
  appSettingsShared,
  windowRef = window,
  WebSocketRef = WebSocket,
  consoleRef = console,
} = {}) {
  if (!appSettingsShared || typeof appSettingsShared.normalizeAppSettings !== 'function') {
    throw new Error('FlightFabricAppSettings shared module is required before settings runtime');
  }

  if (!settingsEditorStore || typeof settingsEditorStore.serializeSettings !== 'function') {
    throw new Error('Settings editor store is required before settings runtime');
  }

  if (
    !$ ||
    typeof getWs !== 'function' ||
    typeof getAppSettings !== 'function'
  ) {
    throw new Error('Settings runtime requires DOM and websocket helpers');
  }

  const {
    APP_SETTINGS_DEFAULTS,
    normalizeAppSettings,
  } = appSettingsShared;

  const form = $('settings-form');
  if (!form) {
    return null;
  }
  const cleanupFns = [];
  const optionalFieldIds = [
    'setting-simconnect-protocol',
    'setting-ws-port',
    'setting-http-port',
    'setting-remote-access',
    'setting-cabin-announcements-enabled',
    'setting-cabin-announcements-style',
    'setting-cabin-announcements-startup-grace-ms',
  ];
  const optionalFields = Object.fromEntries(optionalFieldIds.map((id) => [id, $(id)]));
  const missingOptionalFieldIds = optionalFieldIds.filter((id) => !optionalFields[id]);
  if (missingOptionalFieldIds.length > 0 && typeof consoleRef?.warn === 'function') {
    consoleRef.warn(
      `[settings] Optional settings field targets missing: ${missingOptionalFieldIds.join(', ')}`,
    );
  }

  let lastSavedJson = null;
  let applyingFormState = false;
  let hasLocalEdits = false;
  let settingsHydrated = false;

  const RESTART_REASON_LABELS = {
    simulator: 'Simulator protocol',
    aircraft: 'Aircraft profile override',
    network: 'Network ports / remote access',
    recording: 'Automatic recording',
  };

  function normalizeSettings(settings) {
    return normalizeAppSettings(settings, {
      defaults: APP_SETTINGS_DEFAULTS,
    });
  }

  function updateRestartActionState(state = {}) {
    settingsUiStore?.setRestartActionState?.(state);
  }

  function applyRestartActionAvailability() {
    const canRestartApp = typeof windowRef.electronAPI?.restartApp === 'function';
    const canRestartBackend = typeof windowRef.electronAPI?.restartBackend === 'function';
    updateRestartActionState({
      available: canRestartApp || canRestartBackend,
      busy: false,
      title: (canRestartApp || canRestartBackend)
        ? ''
        : 'Only available in the Electron app - click for details.',
    });
    return { canRestartApp, canRestartBackend };
  }

  function setStatus(message, tone = 'neutral') {
    if (settingsFormStore && typeof settingsFormStore.setStatus === 'function') {
      settingsFormStore.setStatus(message, tone);
    }
  }

  function sendWs(message) {
    const ws = getWs();
    if (!ws || ws.readyState !== WebSocketRef.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  }

  function requestSettings({ markReloadBusy = false } = {}) {
    if (markReloadBusy) {
      settingsFormStore?.setReloadBusy?.(true);
    }
    if (!sendWs({ type: 'requestAppSettings' })) {
      settingsFormStore?.setReloadBusy?.(false);
      setStatus('Connect to SimBridge to load settings.', 'error');
    }
  }

  function readFormSettings() {
    return settingsEditorStore.serializeSettings();
  }

  function getRestartReasonsForSettings(settings) {
    let previous;
    try {
      previous = lastSavedJson ? JSON.parse(lastSavedJson) : null;
    } catch {
      previous = null;
    }
    if (!previous || typeof previous !== 'object') return [];

    const reasons = [];
    for (const [key, label] of Object.entries(RESTART_REASON_LABELS)) {
      if (JSON.stringify(settings[key]) !== JSON.stringify(previous[key])) {
        reasons.push(label);
      }
    }
    return reasons;
  }

  function updatePendingBar(isDirty, restartReasons = []) {
    if (!settingsFormStore || typeof settingsFormStore.setPendingState !== 'function') return;
    if (!isDirty) {
      settingsFormStore.setPendingState(false);
      return;
    }

    const restartRequired = restartReasons.length > 0;
    settingsFormStore.setPendingState(true, {
      title: restartRequired
        ? 'Unsaved changes with restart-required updates'
        : 'Unsaved settings changes',
      meta: restartRequired
        ? `Save now, then restart to apply: ${restartReasons.join(', ')}.`
        : 'Save to write them to the settings file. Immediate-only settings will apply as soon as the save completes.',
    });
  }

  function submitSettings() {
    if (!settingsHydrated) {
      settingsFormStore?.setSaveBusy?.(false);
      settingsFormStore?.setSaveEnabled?.(false);
      updatePendingBar(false);
      setStatus('Waiting for settings from backend...', 'pending');
      return false;
    }

    const settings = readFormSettings();

    if (!sendWs({ type: 'saveAppSettings', settings })) {
      settingsFormStore?.setSaveBusy?.(false);
      setStatus('Connect to SimBridge to save settings.', 'error');
      if (showAppToast) {
        showAppToast('error', 'Save failed', 'Connect to SimBridge before saving settings.');
      }
      return false;
    }

    settingsFormStore?.setSaveBusy?.(true);
    setStatus('Saving settings...', 'pending');
    return true;
  }

  function updateDirtyState() {
    if (!settingsHydrated) {
      settingsFormStore?.setSaveEnabled?.(false);
      updatePendingBar(false);
      setStatus('Waiting for settings from backend...', 'pending');
      return;
    }

    const currentSettings = readFormSettings();
    const currentJson = JSON.stringify(currentSettings);
    const isDirty = currentJson !== lastSavedJson;
    const restartReasons = isDirty ? getRestartReasonsForSettings(currentSettings) : [];

    if (settingsFormStore && typeof settingsFormStore.setSaveEnabled === 'function') {
      settingsFormStore.setSaveEnabled(isDirty);
    }

    updatePendingBar(isDirty, restartReasons);

    if (isDirty) {
      const suffix = restartReasons.length > 0
        ? ` Restart required after save for: ${restartReasons.join(', ')}.`
        : '';
      setStatus(`Unsaved changes.${suffix}`, 'pending');
    } else {
      setStatus('Saved to settings file.', 'neutral');
    }
  }

  function hasDirtyLocalEdits() {
    return hasLocalEdits && JSON.stringify(readFormSettings()) !== lastSavedJson;
  }

  function applySettingsToForm(settings, options = {}) {
    applyingFormState = true;
    try {
      settingsEditorStore.applySettings(settings);
    } finally {
      applyingFormState = false;
    }
    lastSavedJson = JSON.stringify(readFormSettings());
    hasLocalEdits = false;
    settingsHydrated = true;
    updateDirtyState();
  }

  const stopDirtyWatch = watch(
    () => JSON.stringify(readFormSettings()),
    (currentJson, previousJson) => {
      if (!settingsHydrated || applyingFormState || currentJson === previousJson) return;
      hasLocalEdits = true;
      updateDirtyState();
    },
  );
  cleanupFns.push(stopDirtyWatch);

  settingsFormStore?.bindRuntimeActions?.({
    onSave: submitSettings,
    onReload: () => {
      setStatus('Reloading settings...', 'pending');
      requestSettings({ markReloadBusy: true });
      return true;
    },
  });

  settingsUiStore?.bindDesktopActions?.({
    detectMsfsInstalls: typeof windowRef.electronAPI?.detectMsfsInstalls === 'function'
      ? () => windowRef.electronAPI.detectMsfsInstalls()
      : null,
    getStorageLocations: typeof windowRef.electronAPI?.getStorageLocations === 'function'
      ? () => windowRef.electronAPI.getStorageLocations()
      : null,
    openStorageLocation: typeof windowRef.electronAPI?.revealInExplorer === 'function'
      ? (targetPath) => windowRef.electronAPI.revealInExplorer(targetPath)
      : null,
    copyStorageLocationPath: typeof windowRef.navigator?.clipboard?.writeText === 'function'
      ? async (targetPath) => {
        await windowRef.navigator.clipboard.writeText(targetPath);
        return true;
      }
      : null,
    openLegalFile: typeof windowRef.electronAPI?.openLegalFile === 'function'
      ? (filename) => windowRef.electronAPI.openLegalFile(filename)
      : null,
    revealLegalFolder: typeof windowRef.electronAPI?.revealLegalFolder === 'function'
      ? () => windowRef.electronAPI.revealLegalFolder()
      : null,
  });
  settingsUiStore?.requestStorageLocations?.();

  settingsUiStore?.bindRestartAction?.(async () => {
      const { canRestartApp, canRestartBackend } = applyRestartActionAvailability();

      if (!canRestartApp && !canRestartBackend) {
        setStatus('Restart is not available in browser mode. Close and relaunch Flight Fabric manually.', 'error');
        return false;
      }

      updateRestartActionState({ busy: true });
      try {
        if (canRestartApp) {
          setStatus('Restarting app...', 'pending');
          await windowRef.electronAPI.restartApp();
          return true;
        }

        setStatus('Restarting backend...', 'pending');
        await windowRef.electronAPI.restartBackend();
        setStatus('Backend restarted. Waiting for reconnect...', 'pending');
        return true;
      } catch (err) {
        setStatus(`Restart failed: ${err?.message || 'unknown error'}`, 'error');
        return false;
      } finally {
        updateRestartActionState({ busy: false });
      }
  });

  if (typeof subscribeAppSettingsSignal === 'function') {
    cleanupFns.push(subscribeAppSettingsSignal((detail = {}) => {
      const forceApply = settingsFormStore?.reloadBusy === true;
      settingsFormStore?.setReloadBusy?.(false);
      if (settingsHydrated && hasDirtyLocalEdits() && !forceApply) {
        updateDirtyState();
        return;
      }
      applySettingsToForm(detail.settings, { storage: detail.storage });
    }));
  }

  if (typeof subscribeAppSettingsSavedSignal === 'function') {
    cleanupFns.push(subscribeAppSettingsSavedSignal((detail = {}) => {
      settingsFormStore?.setSaveBusy?.(false);
      if (!detail.ok) {
        setStatus(detail.error || 'Failed to save settings.', 'error');
        if (showAppToast) {
          showAppToast('error', 'Save failed', detail.error || 'Failed to save settings.');
        }
        return;
      }

      if (detail.settings) {
        applySettingsToForm(detail.settings, { storage: detail.storage });
      }

      const restartRequired = detail.restartRequired === true;
      const reasons = Array.isArray(detail.restartReasons) ? detail.restartReasons.filter(Boolean) : [];

      if (restartRequired) {
        const suffix = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
        setStatus(`Settings saved. Restart required to apply all changes${suffix}.`, 'pending');
        if (showAppToast) {
          showAppToast(
            'warning',
            'Settings saved',
            reasons.length > 0
              ? `Restart required to apply: ${reasons.join(', ')}.`
              : 'Restart required to apply all changes.'
          );
        }
        return;
      }

      setStatus('Settings saved and applied immediately.', 'neutral');
      if (showAppToast) {
        showAppToast('success', 'Settings saved', 'Changes applied immediately.');
      }
      settingsFormStore?.startSaveFlash?.();
    }));
  }

  if (typeof subscribeWsOpenSignal === 'function') {
    cleanupFns.push(subscribeWsOpenSignal(requestSettings));
  }

  if (typeof tabsStore?.registerBeforeChangeGuard === 'function') {
    const unregisterBeforeChangeGuard = tabsStore.registerBeforeChangeGuard((fromTabId, toTabId) => {
      if (fromTabId !== 'settings' || toTabId === 'settings') return true;
      const currentJson = JSON.stringify(readFormSettings());
      if (currentJson === lastSavedJson) return true;
      return windowRef.confirm('You have unsaved changes to Settings. Leave without saving?');
    });
    cleanupFns.push(unregisterBeforeChangeGuard);
  }

  if (tabsStore) {
    const stopTabsWatch = watch(
      () => tabsStore.activeTabId,
      (tabId) => {
        if (tabId === 'settings') {
          requestSettings();
        }
      },
    );
    cleanupFns.push(stopTabsWatch);
  }

  const initialSettings = getAppSettings();
  applyRestartActionAvailability();

  if (initialSettings) {
    applySettingsToForm(initialSettings);
  } else {
    updateDirtyState();
  }

  function cleanupSettingsRuntime() {
    for (const cleanup of cleanupFns.splice(0).reverse()) {
      try {
        cleanup?.();
      } catch {}
    }
    settingsFormStore?.bindRuntimeActions?.({});
    settingsUiStore?.bindDesktopActions?.({});
    settingsUiStore?.bindRestartAction?.(null);
    updateRestartActionState({ busy: false, available: false, title: '' });
  }

  return {
    applySettingsToForm,
    cleanup: cleanupSettingsRuntime,
    readFormSettings,
    requestSettings,
    submitSettings,
    updateDirtyState,
  };
}
