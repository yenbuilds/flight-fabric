import { onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';
import { subscribeAppSettingsSaved, subscribeWsClose } from '../../app/runtime-signals.js';

let saveSequence = 0;

function normalizeSettings(nextSettings) {
  return nextSettings && typeof nextSettings === 'object' ? nextSettings : null;
}

function normalizeStorage(nextStorage) {
  return nextStorage && typeof nextStorage === 'object' ? nextStorage : null;
}

export const useAppSettingsStore = defineStore('appSettings', () => {
  const backendVersion = ref('');
  const settings = ref(null);
  const settingsFile = ref('');
  const storage = ref(null);
  const saveActionBound = ref(false);
  let saveSettingsAction = null;
  let cancelPendingSave = null;

  function apply(detail = {}) {
    if (typeof detail.backendVersion === 'string' && detail.backendVersion) {
      backendVersion.value = detail.backendVersion;
    }
    if ('settings' in detail) {
      settings.value = normalizeSettings(detail.settings);
    }
    if ('settingsFile' in detail) {
      settingsFile.value = typeof detail.settingsFile === 'string' ? detail.settingsFile : '';
    }
    if ('storage' in detail) {
      storage.value = normalizeStorage(detail.storage);
    }
  }

  function saveSettings(nextSettings, options = {}) {
    const normalizedSettings = normalizeSettings(nextSettings);
    if (!normalizedSettings) return false;
    if (typeof saveSettingsAction !== 'function') return false;
    return saveSettingsAction(normalizedSettings, options) !== false;
  }

  // Callers that depend on durability must wait for the correlated backend
  // acknowledgement, not just a successful WebSocket send.
  function saveSettingsConfirmed(nextSettings, { timeoutMs = 15000 } = {}) {
    if (cancelPendingSave) return Promise.resolve({ ok: false, error: 'Settings are already being saved.' });
    return new Promise((resolve) => {
      const requestId = `app-settings-${Date.now()}-${++saveSequence}`;
      let timer = null;
      const finish = (result) => {
        clearTimeout(timer);
        unsubscribeSaved();
        unsubscribeClose();
        cancelPendingSave = null;
        resolve(result);
      };
      const unsubscribeSaved = subscribeAppSettingsSaved((result) => {
        if (result.requestId === requestId) finish(result);
      });
      const unsubscribeClose = subscribeWsClose(() => finish({ ok: false, error: 'Connection lost. Reconnect and try saving again.' }));
      cancelPendingSave = () => finish({ ok: false, error: 'Settings save was interrupted.' });
      timer = setTimeout(() => finish({ ok: false, error: 'Save confirmation did not arrive. Your choices are kept; try saving again.' }), timeoutMs);
      try {
        if (!saveSettings(nextSettings, { requestId })) finish({ ok: false, error: 'Reconnect to FlightFabric before saving.' });
      } catch {
        finish({ ok: false, error: 'Settings could not be saved. Try again.' });
      }
    });
  }

  onScopeDispose(() => cancelPendingSave?.());

  function bindRuntimeActions({ onSaveSettings = null } = {}) {
    saveSettingsAction = typeof onSaveSettings === 'function' ? onSaveSettings : null;
    saveActionBound.value = saveSettingsAction != null;
  }

  return {
    apply,
    backendVersion,
    bindRuntimeActions,
    saveActionBound,
    saveSettings,
    saveSettingsConfirmed,
    settings,
    settingsFile,
    storage,
  };
});
