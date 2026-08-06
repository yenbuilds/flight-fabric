import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

export const useSettingsFormStore = defineStore('settingsForm', () => {
  const statusMessage = ref('Waiting for settings from backend...');
  const statusTone = ref('neutral');
  const pendingVisible = ref(false);
  const pendingTitle = ref('Unsaved settings changes');
  const pendingMeta = ref('Save to write them to the settings file.');
  const saveEnabled = ref(false);
  const saveBusy = ref(false);
  const saveActionBound = ref(false);
  const reloadBusy = ref(false);
  const reloadActionBound = ref(false);
  const saveFlashActive = ref(false);
  let onSaveAction = null;
  let onReloadAction = null;

  const statusClass = computed(() => {
    const toneClass = statusTone.value === 'error'
      ? 'text-red-400'
      : statusTone.value === 'pending'
        ? 'text-amber-400'
        : 'text-gray-500';
    return `text-xs mt-2 ${toneClass}`;
  });
  const saveButtonDisabled = computed(() => saveBusy.value || !saveEnabled.value);
  const saveButtonLabel = computed(() => (saveBusy.value ? 'Saving...' : 'Save Settings'));
  const pendingSaveButtonLabel = computed(() => (saveBusy.value ? 'Saving...' : 'Save Now'));
  const reloadButtonDisabled = computed(() => reloadBusy.value);
  const reloadButtonLabel = computed(() => (reloadBusy.value ? 'Reloading...' : 'Reload'));
  const pendingReloadButtonLabel = computed(() => (reloadBusy.value ? 'Reloading...' : 'Discard Changes'));

  function setStatus(message, tone = 'neutral') {
    statusMessage.value = message || '';
    statusTone.value = tone;
  }

  function setPendingState(isVisible, options = {}) {
    pendingVisible.value = isVisible === true;
    if (!pendingVisible.value) return;

    pendingTitle.value = options.title || 'Unsaved settings changes';
    pendingMeta.value = options.meta || 'Save to write them to the settings file.';
  }

  function setSaveEnabled(enabled) {
    saveEnabled.value = enabled === true;
  }

  function setSaveBusy(busy) {
    saveBusy.value = busy === true;
  }

  function setReloadBusy(busy) {
    reloadBusy.value = busy === true;
  }

  function bindRuntimeActions({ onSave = null, onReload = null } = {}) {
    onSaveAction = typeof onSave === 'function' ? onSave : null;
    onReloadAction = typeof onReload === 'function' ? onReload : null;
    saveActionBound.value = onSaveAction !== null;
    reloadActionBound.value = onReloadAction !== null;
  }

  async function requestSave() {
    if (typeof onSaveAction !== 'function') return false;
    const result = await onSaveAction();
    return result !== false;
  }

  async function requestReload() {
    if (typeof onReloadAction !== 'function') return false;
    const result = await onReloadAction();
    return result !== false;
  }

  function startSaveFlash() {
    saveFlashActive.value = true;
  }

  function clearSaveFlash() {
    saveFlashActive.value = false;
  }

  return {
    bindRuntimeActions,
    clearSaveFlash,
    pendingMeta,
    pendingTitle,
    pendingVisible,
    pendingReloadButtonLabel,
    pendingSaveButtonLabel,
    reloadButtonDisabled,
    reloadButtonLabel,
    reloadActionBound,
    reloadBusy,
    requestReload,
    requestSave,
    saveEnabled,
    saveActionBound,
    saveBusy,
    saveButtonDisabled,
    saveButtonLabel,
    saveFlashActive,
    setPendingState,
    setReloadBusy,
    setSaveBusy,
    setSaveEnabled,
    setStatus,
    startSaveFlash,
    statusClass,
    statusMessage,
    statusTone,
  };
});
