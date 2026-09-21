<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { isRemoteView } from '../../app/remote-view.js';
import { useProfilesStore } from '../stores/profiles.js';
import { useStatusStore } from '../stores/status.js';

const STORAGE_KEY = 'ff_device_pairing_request_v1';
const requestId = ref('');
const confirmationCode = ref('');
const expiresAt = ref(0);
const status = ref('idle');
const error = ref('');
const pollInterrupted = ref(false);
const nowMs = ref(Date.now());
let pollTimer = null;
let clockTimer = null;
let reloadTimer = null;
let statusCheckInFlight = false;
const profiles = useProfilesStore();
const appStatus = useStatusStore();

const isPending = computed(() => status.value === 'pending');
const remainingSeconds = computed(() => Math.max(0, Math.ceil((expiresAt.value - nowMs.value) / 1000)));
const remainingLabel = computed(() => {
  const seconds = remainingSeconds.value;
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
});
const controlsPaired = computed(() => (
  profiles.authorizationScope === 'aircraft-control' || profiles.authorizationScope === 'full-control'
));
const backendReady = computed(() => appStatus.websocket === 'ready');
const isRemoteSecondScreen = computed(() => isRemoteView(typeof window !== 'undefined' ? window.location : globalThis.location));

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function clearRequest() {
  requestId.value = '';
  confirmationCode.value = '';
  expiresAt.value = 0;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {}
}

function saveRequest() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({
      requestId: requestId.value,
      confirmationCode: confirmationCode.value,
      expiresAt: expiresAt.value,
    }));
  } catch {
    // Pairing still works when private browsing or storage policy blocks sessionStorage.
  }
}

async function checkRequest() {
  if (!requestId.value || statusCheckInFlight) return;
  statusCheckInFlight = true;
  try {
    const response = await fetch(`/api/device-pairing/status?requestId=${encodeURIComponent(requestId.value)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.status === 'approved') {
      clearRequest();
      status.value = 'approved';
      error.value = '';
      pollInterrupted.value = false;
      reloadTimer = window.setTimeout(() => window.location.reload(), 700);
      return;
    }
    if (payload?.status === 'expired' || payload?.status === 'disabled') {
      clearRequest();
      status.value = payload.status;
      error.value = '';
      pollInterrupted.value = false;
      return;
    }
    if (response.ok && payload?.status === 'pending') {
      if (Number(payload.expiresAt) > 0) expiresAt.value = Number(payload.expiresAt);
      pollInterrupted.value = false;
      return;
    }
    pollInterrupted.value = true;
  } catch {
    // A short network interruption should not discard a valid approval request.
    pollInterrupted.value = true;
  } finally {
    statusCheckInFlight = false;
  }
}

async function requestControls() {
  if (!backendReady.value) return;
  status.value = 'requesting';
  error.value = '';
  try {
    const response = await fetch('/api/device-pairing/request', {
      method: 'POST',
      headers: { 'X-Flight-Fabric-Pairing': '1' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.requestId || !payload?.confirmationCode) {
      error.value = payload?.error === 'aircraft_controls_disabled'
        ? 'Aircraft controls are not enabled on this FlightFabric PC.'
        : (payload?.error === 'too_many_requests'
          ? 'Two requests from this device are already waiting. Wait for them to expire, then try again.'
          : 'FlightFabric could not start pairing. Reload this page and try again.');
      status.value = 'idle';
      return;
    }
    requestId.value = payload.requestId;
    confirmationCode.value = payload.confirmationCode;
    expiresAt.value = Number(payload.expiresAt) || 0;
    nowMs.value = Date.now();
    saveRequest();
    status.value = 'pending';
    pollInterrupted.value = false;
    await checkRequest();
  } catch {
    error.value = 'Could not request aircraft controls. Check that this is the FlightFabric address shown on your PC.';
    status.value = 'idle';
  }
}

onMounted(() => {
  try {
    const saved = JSON.parse(storage()?.getItem(STORAGE_KEY) || '{}');
    if (typeof saved.requestId === 'string' && /^\d{6}$/.test(saved.confirmationCode) && Number(saved.expiresAt) > 0) {
      requestId.value = saved.requestId;
      confirmationCode.value = saved.confirmationCode;
      expiresAt.value = Number(saved.expiresAt);
      status.value = 'pending';
    }
  } catch {}
  if (isPending.value) void checkRequest();
  pollTimer = window.setInterval(() => {
    if (isPending.value) void checkRequest();
  }, 2500);
  clockTimer = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
  if (clockTimer) window.clearInterval(clockTimer);
  if (reloadTimer) window.clearTimeout(reloadTimer);
  pollTimer = null;
  clockTimer = null;
  reloadTimer = null;
});
</script>

<template>
  <section v-if="isRemoteSecondScreen && !controlsPaired" id="device-pairing-request" class="mb-4 rounded-2xl border border-primary/30 bg-primary/10 p-4 shadow-lg shadow-black/10" aria-labelledby="device-pairing-title">
    <div class="flex items-start gap-3">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary" aria-hidden="true">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" />
          <path d="M9 6h6" />
          <path d="M11.5 18h1" />
        </svg>
      </div>
      <div class="min-w-0 flex-1" aria-live="polite">
        <h2 id="device-pairing-title" class="text-sm font-semibold text-fg">Enable aircraft controls</h2>
        <p v-if="(status === 'idle' || status === 'requesting') && backendReady" id="device-pairing-intro" class="mt-1 text-xs leading-5 text-muted-fg">This device is connected in viewer mode. Request access, then approve the matching code in <strong class="font-medium text-gray-200">Phone setup</strong> on the FlightFabric PC.</p>
        <p v-else-if="(status === 'idle' || status === 'requesting') && !backendReady" id="device-pairing-connecting" class="mt-1 text-xs leading-5 text-muted-fg">Waiting for the FlightFabric PC. Pairing will be available when this dashboard connects.</p>
        <template v-if="isPending">
          <div class="mt-3 rounded-xl border border-primary/30 bg-panel/70 p-3">
            <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-fg">Match this code on the PC</div>
            <div id="device-pairing-code" class="mt-1 font-mono text-3xl font-semibold tracking-[0.2em] text-primary" :aria-label="`Pairing code ${confirmationCode.split('').join(' ')}`">{{ confirmationCode }}</div>
          </div>
          <p class="mt-2 text-xs leading-5 text-gray-200">In <strong class="font-medium">Phone setup</strong> on the PC, find the same code and choose <strong class="font-medium">Approve controls</strong>.</p>
          <p class="mt-1 text-xs leading-5 text-muted-fg">Waiting for approval · expires in {{ remainingLabel }}</p>
          <p v-if="pollInterrupted" id="device-pairing-poll-warning" class="mt-2 text-xs leading-5 text-warning">Connection interrupted. FlightFabric will keep checking.</p>
        </template>
        <p v-else-if="status === 'approved'" id="device-pairing-approved" class="mt-2 text-xs leading-5 text-success">Controls approved. Connecting this device...</p>
        <p v-else-if="status === 'expired'" class="mt-2 text-xs leading-5 text-warning">That request expired. Request a new code when you are ready.</p>
        <p v-else-if="status === 'disabled'" class="mt-2 text-xs leading-5 text-warning">Aircraft controls are not enabled on the FlightFabric PC. Enable them in Settings and restart FlightFabric.</p>
        <p v-if="error" id="device-pairing-error" class="mt-2 text-xs leading-5 text-danger" role="alert">{{ error }}</p>
        <button
          v-if="!isPending && status !== 'approved'"
          id="device-pairing-request-btn"
          type="button"
          class="ff-button-primary mt-3 px-4 py-2 text-xs"
          :disabled="status === 'requesting' || !backendReady"
          @click="requestControls"
        >
          {{ status === 'requesting' ? 'Requesting...' : (backendReady ? 'Request aircraft controls' : 'Waiting for connection...') }}
        </button>
      </div>
    </div>
  </section>
</template>
