<script setup>
import { computed, ref } from 'vue';
import { readStorageValue, writeStorageValue } from '../../app/browser-environment.js';
import { useProfilesStore } from '../stores/profiles.js';

const GUIDE_STORAGE_KEY = 'ff_second_screen_guide_dismissed_v1';
const profiles = useProfilesStore();

function isRemoteBrowserPage() {
  const location = typeof window !== 'undefined' && window.location
    ? window.location
    : globalThis.location;
  const pathname = String(location?.pathname || '').toLowerCase();
  return pathname === '/remote' || pathname === '/remote.html';
}

const isSecondScreen = isRemoteBrowserPage();
const dismissed = ref(readStorageValue(GUIDE_STORAGE_KEY, { fallback: '' }) === '1');
const controlsPaired = computed(() => (
  profiles.authorizationScope === 'aircraft-control'
  || profiles.authorizationScope === 'full-control'
));
const pairingProblem = computed(() => {
  if (controlsPaired.value) return '';
  if (profiles.aircraftControlPairingStatus === 'disabled') return 'disabled';
  if (profiles.aircraftControlPairingStatus === 'expired') return 'expired';

  const location = typeof window !== 'undefined' && window.location
    ? window.location
    : globalThis.location;
  try {
    return new URLSearchParams(String(location?.search || '')).has('aircraftControlToken')
      ? 'expired'
      : '';
  } catch {
    return '';
  }
});
const controlStatusLabel = computed(() => {
  if (controlsPaired.value) return 'Controls paired';
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
    class="mb-4 rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-4 shadow-lg shadow-black/10"
    aria-labelledby="second-screen-guide-title"
  >
    <div class="flex items-start gap-3">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-400/15 text-cyan-300" aria-hidden="true">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v4" />
          <path d="M12 18v4" />
          <path d="m4.93 4.93 2.83 2.83" />
          <path d="m16.24 16.24 2.83 2.83" />
          <path d="M2 12h4" />
          <path d="M18 12h4" />
          <path d="m4.93 19.07 2.83-2.83" />
          <path d="m16.24 7.76 2.83-2.83" />
        </svg>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 id="second-screen-guide-title" class="text-sm font-semibold text-gray-100">Keep this second screen for every flight</h2>
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
          Bookmark this page after scanning the QR shown under <strong>Phone</strong> on your Flight Fabric PC. New flights appear automatically—there is no new-flight scan.
        </p>
        <p v-if="controlsPaired" class="mt-2 text-xs leading-5 text-muted-fg">
          Aircraft controls stay paired for this backend session. Scan the Phone QR again only after the Flight Fabric backend restarts.
        </p>
        <p v-else-if="pairingProblem === 'expired'" id="second-screen-pairing-expired" class="mt-2 text-xs leading-5 text-rose-200">
          This saved Phone link uses an expired pairing token. On the Flight Fabric PC, choose <strong>Phone</strong> and scan the current QR. The token changes whenever the backend restarts.
        </p>
        <p v-else-if="pairingProblem === 'disabled'" id="second-screen-pairing-disabled" class="mt-2 text-xs leading-5 text-rose-200">
          LAN viewing is connected, but aircraft controls are not active in this backend session. Enable LAN aircraft controls on the PC, save, restart, then scan the current Phone QR.
        </p>
        <p v-else class="mt-2 text-xs leading-5 text-muted-fg">
          To use aircraft controls, choose <strong>Phone</strong> on the Flight Fabric PC and scan the QR shown there. Scan again after backend restarts, not for each new flight.
        </p>
      </div>
      <button
        id="second-screen-guide-dismiss"
        type="button"
        class="ff-button-secondary shrink-0 px-3 py-2 text-xs"
        aria-label="Dismiss second-screen guidance"
        @click="dismissGuide"
      >
        Got it
      </button>
    </div>
  </aside>
</template>
