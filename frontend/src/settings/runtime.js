import { watch } from 'vue';

// Shared across remounts so a late reply on the same connection cannot match
// a save from a replacement settings runtime.
let settingsSaveSequence = 0;

export function initSettingsRuntime({
  $,
  getAppSettings,
  getWs,
  canManageSettings = () => true,
  settingsEditorStore,
  settingsFormStore,
  settingsUiStore,
  toolbarPanelStore = null,
  subscribeAppSettingsSignal = null,
  subscribeAppSettingsSavedSignal = null,
  subscribeWsOpenSignal = null,
  tabsStore = null,
  showAppToast = null,
  appSettingsShared,
  windowRef = window,
  WebSocketRef = WebSocket,
  consoleRef = console,
  saveAcknowledgementTimeoutMs = 15000,
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
  let submittedSettingsJson = null;
  let submittedRequestId = null;
  let submittedSaveTimer = null;
  let restartInProgress = false;
  let pendingRestartSave = null;
  let disposed = false;

  function clearSubmittedSave() {
    if (submittedSaveTimer !== null) windowRef.clearTimeout(submittedSaveTimer);
    submittedSaveTimer = null;
    submittedSettingsJson = null;
    submittedRequestId = null;
  }

  function settleRestartSave(ok) {
    const pending = pendingRestartSave;
    if (!pending) return;
    pendingRestartSave = null;
    pending.resolve(ok);
  }

  const RESTART_REASON_LABELS = {
    simulator: 'Simulator protocol',
    aircraft: 'Aircraft profile override',
    network: 'Network ports / remote access',
    recording: 'Automatic recording',
  };

  function updateRestartActionState(state = {}) {
    settingsUiStore?.setRestartActionState?.(state);
  }

  function applyRestartActionAvailability() {
    const canRestartApp = canManageSettings() && typeof windowRef.electronAPI?.restartApp === 'function';
    const canRestartBackend = canManageSettings() && typeof windowRef.electronAPI?.restartBackend === 'function';
    updateRestartActionState({
      available: canRestartApp || canRestartBackend,
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
    if (!canManageSettings()) return false;
    const ws = getWs();
    if (!ws || ws.readyState !== WebSocketRef.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  }

  function requestSettings({ markReloadBusy = false } = {}) {
    if (!canManageSettings()) return false;
    if (markReloadBusy) {
      settingsFormStore?.setReloadBusy?.(true);
    }
    if (!sendWs({ type: 'requestAppSettings' })) {
      settingsFormStore?.setReloadBusy?.(false);
      setStatus('Waiting for FlightFabric to connect.', 'neutral');
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
        ? 'Save and restart to apply these changes'
        : 'Unsaved settings changes',
      meta: restartRequired
        ? `Save now, then restart to apply: ${restartReasons.join(', ')}.`
        : 'Your changes will take effect when you save.',
    });
  }

  function submitSettings() {
    if (!canManageSettings() || settingsFormStore?.saveBusy || settingsFormStore?.reloadBusy) return false;
    if (!settingsHydrated) {
      settingsFormStore?.setSaveBusy?.(false);
      settingsFormStore?.setSaveEnabled?.(false);
      updatePendingBar(false);
      setStatus('Loading your settings...', 'pending');
      return false;
    }

    const settings = readFormSettings();
    submittedSettingsJson = JSON.stringify(settings);
    submittedRequestId = `settings-save-${++settingsSaveSequence}`;
    settingsFormStore?.setSaveBusy?.(true);
    setStatus('Saving settings...', 'pending');
    // Every save needs a deadline, including Save without a following restart.
    // Clear the request identity so a late reply cannot settle a later retry.
    submittedSaveTimer = windowRef.setTimeout(() => {
      clearSubmittedSave();
      settingsFormStore?.setSaveBusy?.(false);
      setStatus('Save confirmation did not arrive. Your edits are kept; reload or try saving again.', 'error');
      settleRestartSave(false);
    }, saveAcknowledgementTimeoutMs);

    if (!sendWs({ type: 'saveAppSettings', requestId: submittedRequestId, settings })) {
      clearSubmittedSave();
      settingsFormStore?.setSaveBusy?.(false);
      setStatus('Reconnect to FlightFabric before saving settings.', 'error');
      if (showAppToast) {
        showAppToast('error', 'Save failed', 'Reconnect to FlightFabric before saving settings.');
      }
      return false;
    }

    return true;
  }

  function updateDirtyState() {
    updateRestartActionState({ saveRequired: canManageSettings() && settingsHydrated && JSON.stringify(readFormSettings()) !== lastSavedJson });
    if (!canManageSettings()) {
      settingsFormStore?.setSaveEnabled?.(false);
      updatePendingBar(false);
      return;
    }
    if (!settingsHydrated) {
      settingsFormStore?.setSaveEnabled?.(false);
      updatePendingBar(false);
      setStatus('Loading your settings...', 'pending');
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

  function applySettingsToForm(settings) {
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
    onSave: () => restartInProgress ? false : submitSettings(),
    onReload: () => {
      if (!canManageSettings() || restartInProgress || settingsFormStore?.saveBusy) return false;
      setStatus('Reloading settings...', 'pending');
      requestSettings({ markReloadBusy: true });
      return true;
    },
  });

  function bindDesktopRuntimeActions() {
    settingsUiStore?.bindDesktopActions?.(canManageSettings() ? {
      detectMsfsInstalls: typeof windowRef.electronAPI?.detectMsfsInstalls === 'function'
        ? () => canManageSettings() && windowRef.electronAPI.detectMsfsInstalls()
        : null,
      getStorageLocations: typeof windowRef.electronAPI?.getStorageLocations === 'function'
        ? () => canManageSettings() && windowRef.electronAPI.getStorageLocations()
        : null,
      openStorageLocation: typeof windowRef.electronAPI?.revealInExplorer === 'function'
        ? (targetPath) => canManageSettings() && windowRef.electronAPI.revealInExplorer(targetPath)
        : null,
      copyStorageLocationPath: typeof windowRef.navigator?.clipboard?.writeText === 'function'
        ? async (targetPath) => {
          if (!canManageSettings()) return false;
          await windowRef.navigator.clipboard.writeText(targetPath);
          return true;
        }
        : null,
      openLegalFile: typeof windowRef.electronAPI?.openLegalFile === 'function'
        ? (filename) => canManageSettings() && windowRef.electronAPI.openLegalFile(filename)
        : null,
      revealLegalFolder: typeof windowRef.electronAPI?.revealLegalFolder === 'function'
        ? () => canManageSettings() && windowRef.electronAPI.revealLegalFolder()
        : null,
    } : {});
    if (canManageSettings()) settingsUiStore?.requestStorageLocations?.();

    const toolbarPanelApi = windowRef.electronAPI?.toolbarPanel;
    toolbarPanelStore?.bindDesktopActions?.(canManageSettings() && toolbarPanelApi && typeof toolbarPanelApi.getStatus === 'function'
      ? {
        getStatus: () => canManageSettings() && toolbarPanelApi.getStatus(),
        install: (installId) => canManageSettings() && toolbarPanelApi.install(installId),
        uninstall: (installId) => canManageSettings() && toolbarPanelApi.uninstall(installId),
      }
      : null);
  }
  bindDesktopRuntimeActions();

  settingsUiStore?.bindRestartAction?.(async () => {
      if (!canManageSettings() || restartInProgress || settingsFormStore?.saveBusy || settingsFormStore?.reloadBusy) return false;
      const { canRestartApp, canRestartBackend } = applyRestartActionAvailability();

      if (!canRestartApp && !canRestartBackend) {
        setStatus('Restart is not available in browser mode. Close and relaunch FlightFabric manually.', 'error');
        return false;
      }

      restartInProgress = true;
      updateRestartActionState({ busy: true });
      try {
        if (settingsHydrated && JSON.stringify(readFormSettings()) !== lastSavedJson) {
          // Wait for the save acknowledgement, not merely a successful socket send.
          updateRestartActionState({ saving: true });
          const saveResult = new Promise((resolve) => {
            pendingRestartSave = { resolve, settingsJson: JSON.stringify(readFormSettings()) };
          });
          if (!submitSettings()) settleRestartSave(false);
          const saved = await saveResult;
          updateRestartActionState({ saving: false });
          if (!saved || disposed || !canManageSettings()) return false;
          if (JSON.stringify(readFormSettings()) !== lastSavedJson) {
            setStatus('Settings changed while saving. Your newer edits are kept; save them before restarting.', 'pending');
            return false;
          }
        }
        if (disposed || !canManageSettings()) return false;
        if (canRestartApp) {
          setStatus('Restarting app...', 'pending');
          const result = await windowRef.electronAPI.restartApp();
          if (result?.ok === false) throw new Error('FlightFabric could not restart. Your saved settings are kept.');
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
        restartInProgress = false;
        updateRestartActionState({ busy: false, saving: false });
      }
  });

  if (typeof subscribeAppSettingsSignal === 'function') {
    cleanupFns.push(subscribeAppSettingsSignal((detail = {}) => {
      if (!canManageSettings()) return;
      // The backend broadcasts the saved snapshot before acknowledging this
      // client. Keep any edits made during that request until its result arrives.
      if (submittedSettingsJson !== null) return;
      const forceApply = settingsFormStore?.reloadBusy === true;
      settingsFormStore?.setReloadBusy?.(false);
      if (settingsHydrated && hasDirtyLocalEdits() && !forceApply) {
        updateDirtyState();
        return;
      }
      applySettingsToForm(detail.settings);
    }));
  }

  if (typeof subscribeAppSettingsSavedSignal === 'function') {
    cleanupFns.push(subscribeAppSettingsSavedSignal((detail = {}) => {
      if (!canManageSettings()) return;
      // An expired save must not settle a retry, clear its busy state, or
      // authorize a restart. Snapshots still arrive independently for Reload.
      if (submittedRequestId === null || detail.requestId !== submittedRequestId) return;
      settingsFormStore?.setSaveBusy?.(false);
      if (!detail.ok) {
        clearSubmittedSave();
        settleRestartSave(false);
        setStatus(detail.error || 'Failed to save settings.', 'error');
        if (showAppToast) {
          showAppToast('error', 'Save failed', detail.error || 'Failed to save settings.');
        }
        return;
      }

      const newerEdits = submittedSettingsJson !== null && JSON.stringify(readFormSettings()) !== submittedSettingsJson;
      const savedSettings = detail.settings || (submittedSettingsJson ? JSON.parse(submittedSettingsJson) : null);
      if (pendingRestartSave && savedSettings
        && JSON.stringify(appSettingsShared.normalizeAppSettings(savedSettings)) !== pendingRestartSave.settingsJson) {
        clearSubmittedSave();
        settleRestartSave(false);
        setStatus('Save confirmation did not match your edits. Your draft is kept; reload or save again before restarting.', 'error');
        return;
      }
      clearSubmittedSave();
      if (savedSettings) {
        if (newerEdits) {
          lastSavedJson = JSON.stringify(appSettingsShared.normalizeAppSettings(savedSettings));
          updateDirtyState();
        } else {
          applySettingsToForm(savedSettings);
        }
      }
      settleRestartSave(Boolean(savedSettings));
      if (newerEdits) {
        setStatus('Settings saved. Newer edits are still unsaved.', 'pending');
        return;
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
      if (!canManageSettings()) return true;
      if (fromTabId !== 'settings' || toTabId === 'settings') return true;
      if (!settingsHydrated || JSON.stringify(readFormSettings()) === lastSavedJson) return true;
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

  if (initialSettings && canManageSettings()) {
    applySettingsToForm(initialSettings);
  } else {
    updateDirtyState();
  }

  // The form is mounted before authorization arrives. Keep its drafts and bindings,
  // then fetch the authoritative settings once this connection can manage them.
  cleanupFns.push(watch(() => canManageSettings(), (allowed) => {
    if (!allowed) {
      clearSubmittedSave();
      settleRestartSave(false);
    }
    settingsFormStore?.setSaveBusy?.(false);
    settingsFormStore?.setReloadBusy?.(false);
    bindDesktopRuntimeActions();
    applyRestartActionAvailability();
    updateDirtyState();
    if (allowed) requestSettings();
  }, { flush: 'sync' }));

  cleanupFns.push(watch(
    () => Boolean(settingsFormStore?.saveBusy || settingsFormStore?.reloadBusy),
    (blocked) => updateRestartActionState({ blocked }),
    { immediate: true, flush: 'sync' },
  ));

  function cleanupSettingsRuntime() {
    disposed = true;
    clearSubmittedSave();
    settleRestartSave(false);
    for (const cleanup of cleanupFns.splice(0).reverse()) {
      try {
        cleanup?.();
      } catch {}
    }
    settingsFormStore?.bindRuntimeActions?.({});
    settingsUiStore?.bindDesktopActions?.({});
    toolbarPanelStore?.bindDesktopActions?.(null);
    settingsUiStore?.bindRestartAction?.(null);
    updateRestartActionState({ busy: false, saving: false, saveRequired: false, blocked: false, available: false, title: '' });
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
