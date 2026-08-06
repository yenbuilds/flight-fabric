<script setup>
import { computed, onMounted, onUnmounted } from 'vue';
import { getAuthorizationScope, getUiHelpers, sendWs } from '../../../app-shared.js';
import {
  subscribeWsClose,
  subscribeWsConnecting,
  subscribeWsError,
  subscribeWsMessage,
  subscribeWsOpen,
} from '../../app/runtime-signals.js';
import { initProfilesRuntime } from '../../profiles/runtime.js';
import { useProfilesStore } from '../stores/profiles.js';
import { useStatusStore } from '../stores/status.js';

const profiles = useProfilesStore();
const status = useStatusStore();
let cleanupProfilesRuntime = null;

const selectableBuiltInProfiles = computed(() => profiles.builtInProfiles.filter((profile) => (
  profile?.abstract !== true && profile?.id !== 'generic'
)));
const selectedOverrideKey = computed(() => {
  if (!profiles.aircraftProfileOverrideActive) return 'auto';
  const selectedProfile = selectableBuiltInProfiles.value.find((profile) => profiles.isProfileOverrideSelected(profile));
  return selectedProfile ? profileKey(selectedProfile) : profiles.aircraftProfileOverride;
});
const unmatchedOverrideActive = computed(() => (
  profiles.aircraftProfileOverrideActive
  && !selectableBuiltInProfiles.value.some((profile) => profiles.isProfileOverrideSelected(profile))
));
const profileSelectionLabel = computed(() => {
  if (profiles.aircraftProfileOverrideActive) return 'Manual override';
  return String(status.aircraftProfile.profileId || '').toLowerCase() === 'generic'
    ? 'Generic fallback'
    : 'Auto match';
});
const profileSummaryLabel = computed(() => {
  const profileName = String(status.aircraftProfileNameLabel || '').trim();
  const aircraftName = String(status.aircraftNameLabel || '').trim();
  return [
    profileName && profileName !== aircraftName ? profileName : '',
    profileSelectionLabel.value,
    status.aircraftProfileVerificationLabel,
  ].filter(Boolean).join(' · ');
});

function profileKey(profile) {
  return profile?.qualifiedId || profile?._qualifiedId || profile?.id || '';
}

function handleSelection(event) {
  const selectedKey = String(event?.target?.value || 'auto').trim();
  if (!selectedKey || selectedKey === selectedOverrideKey.value) return;
  if (selectedKey === 'auto') {
    profiles.clearAircraftProfileOverride();
    return;
  }
  profiles.saveAircraftProfileOverride(selectedKey);
}

function showProfileToast(...args) {
  const uiHelpers = getUiHelpers();
  if (typeof uiHelpers?.showToast !== 'function') return false;
  return uiHelpers.showToast(...args);
}

onMounted(() => {
  cleanupProfilesRuntime = initProfilesRuntime({
    profilesStore: profiles,
    getAuthorizationScope,
    sendMessage: (payload) => sendWs(payload),
    showToast: showProfileToast,
    subscribeWsCloseSignal: subscribeWsClose,
    subscribeWsConnectingSignal: subscribeWsConnecting,
    subscribeWsErrorSignal: subscribeWsError,
    subscribeWsMessageSignal: subscribeWsMessage,
    subscribeWsOpenSignal: subscribeWsOpen,
  });
});

onUnmounted(() => {
  cleanupProfilesRuntime?.();
  cleanupProfilesRuntime = null;
});
</script>

<template>
  <div v-if="status.aircraftProfileNameVisible" class="flex max-w-[190px] items-center sm:max-w-[310px]">
    <span id="aircraft-profile-name" class="truncate text-[10px] text-muted-fg">
      {{ profileSummaryLabel }}
    </span>
    <details
      v-if="profiles.profileSelectionAvailable"
      id="aircraft-profile-correction"
      class="group relative ml-1 shrink-0"
      data-no-swipe
    >
      <summary
        id="aircraft-profile-correction-btn"
        class="cursor-pointer list-none rounded px-1.5 py-0.5 text-[10px] text-cyan-400 transition-colors hover:bg-cyan-500/10 hover:text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 [&::-webkit-details-marker]:hidden"
        aria-label="Correct aircraft profile match"
      >
        Wrong aircraft?
      </summary>

      <div
        id="aircraft-profile-correction-panel"
        class="absolute right-0 top-full z-[70] mt-2 w-72 rounded-lg border border-surface-300 bg-surface-100 p-3 text-left shadow-2xl"
      >
        <div class="text-xs font-semibold text-gray-200">Aircraft match</div>
        <p class="mt-1 text-[10px] leading-relaxed text-gray-400">
          Automatic matching is recommended. Choose a profile only when the detected aircraft is wrong.
        </p>

        <label for="aircraft-profile-correction-select" class="mt-3 block text-[10px] uppercase tracking-wider text-gray-500">
          Use profile
        </label>
        <select
          id="aircraft-profile-correction-select"
          :value="selectedOverrideKey"
          class="mt-1 w-full rounded border border-surface-300 bg-surface-200 px-2 py-2 text-xs text-gray-100 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
          @change="handleSelection"
        >
          <option value="auto">Automatic detection (recommended)</option>
          <option v-if="unmatchedOverrideActive" :value="profiles.aircraftProfileOverride">
            Current override: {{ profiles.aircraftProfileOverride }}
          </option>
          <optgroup v-if="selectableBuiltInProfiles.length" label="Built-in compatibility profiles">
            <option
              v-for="profile in selectableBuiltInProfiles"
              :key="profileKey(profile)"
              :value="profileKey(profile)"
            >
              {{ profile.name || profile.id }}
            </option>
          </optgroup>
        </select>

        <p class="mt-2 text-[10px] leading-relaxed text-amber-300/80">
          A manual override applies after Flight Fabric restarts.
        </p>
      </div>
    </details>
  </div>
</template>
