import { ref } from 'vue';
import { defineStore } from 'pinia';

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

  function saveSettings(nextSettings) {
    const normalizedSettings = normalizeSettings(nextSettings);
    if (!normalizedSettings) return false;
    if (typeof saveSettingsAction !== 'function') return false;
    return saveSettingsAction(normalizedSettings) !== false;
  }

  function updateSettings(updater) {
    if (!settings.value || typeof settings.value !== 'object') return false;
    const nextSettings = typeof updater === 'function'
      ? updater(settings.value)
      : updater;
    return saveSettings(nextSettings);
  }

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
    settings,
    settingsFile,
    storage,
    updateSettings,
  };
});
