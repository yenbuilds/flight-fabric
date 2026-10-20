<script setup>
import { computed, ref } from 'vue';
import { readStorageValue, writeStorageValue } from '../../app/browser-environment.js';
import { isRemoteView } from '../../app/remote-view.js';
import { useProfilesStore } from '../stores/profiles.js';
import SetupIllustration from './SetupIllustration.vue';
import { useTabsStore } from '../stores/tabs.js';
import { useStatusStore } from '../stores/status.js';

const GUIDE_STORAGE_KEY = 'ff_second_screen_guide_dismissed_v1';
const profiles = useProfilesStore();
const tabs = useTabsStore();
const status = useStatusStore();
const awaitingAuthorization = computed(() => status.websocket !== 'ready' || !profiles.authorizationAcknowledged);

function isRemoteBrowserPage() {
  return isRemoteView(typeof window !== 'undefined' && window.location ? window.location : globalThis.location);
}

const isSecondScreen = isRemoteBrowserPage();
const dismissed = ref(readStorageValue(GUIDE_STORAGE_KEY, { fallback: '' }) === '1');
const controlsPaired = computed(() => (
  !awaitingAuthorization.value && (profiles.authorizationScope === 'aircraft-control'
  || profiles.authorizationScope === 'full-control')
));
const pairingProblem = computed(() => {
  if (awaitingAuthorization.value || controlsPaired.value) return '';
  if (profiles.aircraftControlPairingStatus === 'disabled') return 'disabled';
  if (profiles.aircraftControlPairingStatus === 'expired') return 'expired';
  return '';
});
const controlStatusLabel = computed(() => {
  if (awaitingAuthorization.value) return 'Checking connection';
  if (controlsPaired.value) return 'Controls ready';
  if (pairingProblem.value === 'expired') return 'Pairing expired';
  if (pairingProblem.value === 'disabled') return 'Controls not active';
  return 'Viewer mode';
});

function dismissGuide() {
  dismissed.value = true;
  writeStorageValue(GUIDE_STORAGE_KEY, '1');
}
</script>

<template>
  <aside
    v-if="isSecondScreen && !dismissed"
    id="second-screen-guide"
    class="mb-4 rounded-xl border border-border bg-panel p-4"
    :class="controlsPaired ? 'block' : 'hidden min-[641px]:block'"
    aria-labelledby="second-screen-guide-title"
  >
    <div class="flex flex-wrap items-start gap-3">
      <SetupIllustration kind="phone" class="!w-16 !h-14" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 id="second-screen-guide-title" class="text-sm font-semibold text-gray-100">Your aircraft, at your fingertips</h2>
          <span
            id="second-screen-control-status"
            class="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
            :class="controlsPaired
              ? 'border-success/35 bg-success/10 text-success'
              : (pairingProblem
                ? 'border-danger/35 bg-danger/10 text-danger'
                : 'border-amber-400/35 bg-amber-400/10 text-amber-300')"
          >
            {{ controlStatusLabel }}
          </span>
        </div>
        <p class="mt-1 text-xs leading-5 text-gray-300">
          Bookmark this page. New flights appear automatically.
        </p>
        <p v-if="awaitingAuthorization" id="second-screen-connecting" class="mt-2 text-xs leading-5 text-muted-fg">
          Checking access with your FlightFabric PC. Keep this page open while it reconnects.
        </p>
        <p v-else-if="controlsPaired" class="mt-2 text-xs leading-5 text-muted-fg">
          Use Controls for presets, cockpit switches and instruments. Voice uses the microphone on your PC.
        </p>
        <p v-else-if="pairingProblem === 'expired'" id="second-screen-pairing-expired" class="mt-2 text-xs leading-5 text-rose-200">
          Control access has expired. Request a new code below, then approve it on your PC.
        </p>
        <p v-else-if="pairingProblem === 'disabled'" id="second-screen-pairing-disabled" class="mt-2 text-xs leading-5 text-rose-200">
          On your PC, allow aircraft controls in Settings → Devices, save and restart FlightFabric. Then reconnect this device.
        </p>
        <p v-else class="mt-2 text-xs leading-5 text-muted-fg">
          Request a code below to enable controls. Approve the matching code in Settings → Devices on your PC.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button v-if="controlsPaired" type="button" class="ff-button-primary text-xs" data-second-screen-open-controls @click="tabs.requestTabChange('autopilot')">Open Controls</button>
          <button id="second-screen-guide-dismiss" type="button" class="ff-button-secondary text-xs"
            aria-label="Dismiss second-screen guidance" @click="dismissGuide">Got it</button>
        </div>
        <details v-if="controlsPaired" class="setup-details mt-2"><summary>About pairing</summary><p class="text-xs text-muted-fg">Access lasts until the FlightFabric service restarts. If it expires, request a new code here or scan the current QR in Settings → Devices on your PC.</p></details>
      </div>
    </div>
  </aside>
</template>
