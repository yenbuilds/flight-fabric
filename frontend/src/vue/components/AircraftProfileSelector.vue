<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { getAuthorizationScope, isAuthorizationAcknowledged, getUiHelpers, sendWs } from '../../../app-shared.js';
import {
  subscribeWsClose,
  subscribeWsConnecting,
  subscribeWsError,
  subscribeWsMessage,
  subscribeWsOpen,
} from '../../app/runtime-signals.js';
import { initProfilesRuntime } from '../../profiles/runtime.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { useProfilesStore } from '../stores/profiles.js';
import { useStatusStore } from '../stores/status.js';

const profiles = useProfilesStore();
const status = useStatusStore();
const correction = ref(null);
const correctionTrigger = ref(null);
let cleanupProfilesRuntime = null;

function closeCorrection(restoreFocus = false) {
  if (!correction.value?.open) return;
  correction.value.open = false;
  if (restoreFocus) nextTick(() => correctionTrigger.value?.focus({ preventScroll: true }));
}

function handleCorrectionFocusOut(event) {
  // Clicking explanatory text or opening a native select can temporarily blur
  // to no element. Outside pointers are handled separately; only a move to
  // another focus target should dismiss the disclosure here.
  if (!event.relatedTarget || correction.value?.contains(event.relatedTarget)) return;
  closeCorrection();
}

useDocumentEvent('pointerdown', event => {
  if (!correction.value?.contains(event.target)) closeCorrection();
}, true);
useDocumentEvent('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || !correction.value?.open) return;
  event.preventDefault();
  event.stopPropagation();
  closeCorrection(true);
});

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
    isAuthorizationAcknowledged,
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
  <div v-if="status.aircraftProfileNameVisible" class="relative flex w-full min-w-0 max-w-[190px] items-center sm:max-w-[200px]">
    <span
      id="aircraft-profile-name"
      class="min-w-0 flex-1 truncate text-[10px] leading-4 text-muted-fg"
      :title="profileSummaryLabel"
    >
      {{ profileSummaryLabel }}
    </span>
    <details
      v-if="profiles.profileSelectionAvailable"
      ref="correction"
      id="aircraft-profile-correction"
      class="group ml-1 shrink-0"
      data-no-swipe
      @focusout="handleCorrectionFocusOut"
    >
      <summary
        ref="correctionTrigger"
        id="aircraft-profile-correction-btn"
        class="-my-3.5 inline-flex min-h-11 cursor-pointer list-none items-center rounded px-1.5 text-[10px] leading-4 text-cyan-400 transition-colors hover:bg-cyan-500/10 md:my-0 md:min-h-0 md:py-0.5 hover:text-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 [&::-webkit-details-marker]:hidden"
        aria-label="Correct aircraft profile match"
        aria-controls="aircraft-profile-correction-panel"
      >
        Wrong aircraft?
      </summary>

      <div
        id="aircraft-profile-correction-panel"
        class="aircraft-profile-correction-panel absolute right-0 top-full z-[70] mt-2 rounded-lg border border-surface-300 bg-surface-100 p-3 text-left shadow-2xl"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-semibold text-gray-200">Aircraft match</div>
          <button
            id="aircraft-profile-correction-close"
            type="button"
            class="ff-toolbar-button min-h-11 min-w-11 shrink-0 justify-center"
            aria-label="Close aircraft match"
            @click="closeCorrection(true)"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
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
          A manual override applies after FlightFabric restarts.
        </p>
      </div>
    </details>
  </div>
</template>

<style scoped>
.aircraft-profile-correction-panel {
  width: min(18rem, calc(100vw - 1.5rem));
}

@media (max-width: 640px) {
  .aircraft-profile-correction-panel {
    right: auto;
    left: 0;
  }
}
</style>
