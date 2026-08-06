import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useAppSettingsStore } from './app-settings.js';

const AUTHORIZATION_SCOPES = new Set(['read-only', 'aircraft-control', 'full-control']);

function normalizeProfileOverride(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'auto';
}

function normalizeAuthorizationScope(value) {
  return AUTHORIZATION_SCOPES.has(value) ? value : 'read-only';
}

export const useProfilesStore = defineStore('profiles', () => {
  const appSettings = useAppSettingsStore();
  const authorizationScope = ref('read-only');
  const installedProfiles = ref([]);
  const messageActionBound = ref(false);
  const toastActionBound = ref(false);
  let sendMessageAction = null;
  let showToastAction = null;

  const builtInProfiles = computed(() => installedProfiles.value.filter((profile) => (
    profile && profile.namespace === 'bundled'
  )));
  const aircraftProfileOverride = computed(() => normalizeProfileOverride(appSettings.settings?.aircraft?.profile || 'auto'));
  const aircraftProfileOverrideActive = computed(() => aircraftProfileOverride.value !== 'auto');
  const aircraftProfileOverrideLabel = computed(() => (
    aircraftProfileOverrideActive.value ? aircraftProfileOverride.value : 'auto-detect'
  ));
  const profileSelectionAvailable = computed(() => authorizationScope.value === 'full-control');

  function bindRuntime({ sendMessage = null, showToast = null } = {}) {
    sendMessageAction = typeof sendMessage === 'function' ? sendMessage : null;
    showToastAction = typeof showToast === 'function' ? showToast : null;
    messageActionBound.value = sendMessageAction !== null;
    toastActionBound.value = showToastAction !== null;
  }

  function dispatchMessage(payload) {
    if (typeof sendMessageAction !== 'function') return false;
    return sendMessageAction(payload) !== false;
  }

  function notify(kind, title, message, options = {}) {
    if (typeof showToastAction === 'function') {
      showToastAction(kind, title, message, options);
    }
  }

  function setAuthorizationScope(scope) {
    authorizationScope.value = normalizeAuthorizationScope(scope);
    if (!profileSelectionAvailable.value) {
      installedProfiles.value = [];
    }
    return authorizationScope.value;
  }

  function requestProfiles() {
    if (!profileSelectionAvailable.value) return false;
    return dispatchMessage({ type: 'listProfiles' });
  }

  function requestAll(forceRefresh = false) {
    void forceRefresh;
    return requestProfiles();
  }

  function getProfileOverrideKey(profileOrKey) {
    if (typeof profileOrKey === 'string') return profileOrKey.trim();
    const profile = profileOrKey && typeof profileOrKey === 'object' ? profileOrKey : null;
    if (!profile) return '';
    if (profile.qualifiedId) return String(profile.qualifiedId).trim();
    if (profile._qualifiedId) return String(profile._qualifiedId).trim();
    if (profile._profileKey) return String(profile._profileKey).trim();
    if (profile.namespace && profile.simulator && profile.id) {
      return `${profile.namespace}/${profile.simulator}/${profile.id}`;
    }
    return typeof profile.id === 'string' ? profile.id.trim() : '';
  }

  function isProfileOverrideSelected(profile) {
    const override = aircraftProfileOverride.value;
    if (!override || override === 'auto') return false;
    const key = normalizeProfileOverride(getProfileOverrideKey(profile));
    const id = normalizeProfileOverride(profile?.id || '');
    return override === key || (!!id && override === id);
  }

  function saveAircraftProfileOverride(profileOrKey) {
    if (!profileSelectionAvailable.value) return false;
    const profileKey = getProfileOverrideKey(profileOrKey);
    if (!profileKey) return false;
    const ok = appSettings.saveSettings({ aircraft: { profile: profileKey } });
    if (ok) {
      notify('warning', 'Profile override saved', `Restart Flight Fabric to use ${profileKey}.`);
    } else {
      notify('error', 'Profile override failed', 'Unable to save the aircraft profile override.');
    }
    return ok;
  }

  function clearAircraftProfileOverride() {
    if (!profileSelectionAvailable.value) return false;
    const ok = appSettings.saveSettings({ aircraft: { profile: 'auto' } });
    if (ok) {
      notify('warning', 'Auto-detect restored', 'Restart Flight Fabric to resume automatic aircraft matching.');
    } else {
      notify('error', 'Profile override failed', 'Unable to restore automatic aircraft matching.');
    }
    return ok;
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;

    switch (msg.type) {
      case 'profileList':
        if (!profileSelectionAvailable.value) {
          installedProfiles.value = [];
          return true;
        }
        installedProfiles.value = Array.isArray(msg.profiles)
          ? msg.profiles.filter((profile) => profile?.namespace === 'bundled')
          : [];
        return true;
      case 'profileError':
        notify('error', 'Profile action failed', (msg.errors || ['Unknown error']).join('; '));
        return true;
      default:
        return false;
    }
  }

  return {
    aircraftProfileOverride,
    aircraftProfileOverrideActive,
    aircraftProfileOverrideLabel,
    authorizationScope,
    bindRuntime,
    builtInProfiles,
    clearAircraftProfileOverride,
    handleMessage,
    installedProfiles,
    isProfileOverrideSelected,
    messageActionBound,
    profileSelectionAvailable,
    requestAll,
    requestProfiles,
    saveAircraftProfileOverride,
    setAuthorizationScope,
    toastActionBound,
  };
});
