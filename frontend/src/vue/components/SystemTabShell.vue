<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { sendWs } from '../../../app-shared.js';
import { subscribeWsMessage } from '../../app/runtime-signals.js';
import RemoteBrowserQr from './RemoteBrowserQr.vue';
import { useLogbookStore } from '../stores/logbook.js';
import { useSystemHostStore } from '../stores/system-host.js';
import { useTabsStore } from '../stores/tabs.js';
import { useProfilesStore } from '../stores/profiles.js';
import { useStatusStore } from '../stores/status.js';

const systemHost = useSystemHostStore();
const logbook = useLogbookStore();
const tabs = useTabsStore();
const profiles = useProfilesStore();
const status = useStatusStore();
const canManageHost = computed(() => profiles.authorizationScope === 'full-control');
// Native recovery is provided by the trusted preload bridge, including while the
// backend is stopped. Websocket authorization still owns history and pairing.
const canInspectServices = computed(() => systemHost.isElectron || canManageHost.value);
const phoneSetupUrl = computed(() => canManageHost.value ? systemHost.remoteBrowserUrl : systemHost.remoteViewerUrl);
const connectionLabel = computed(() => ({
  ready: 'Connected to FlightFabric',
  disconnected: 'Disconnected from FlightFabric',
  error: 'Connection failed',
}[status.websocket] || 'Connecting to FlightFabric...'));
let refreshTimer = null;
let cleanupBackendStatus = null;
let copyResetTimer = null;
const copiedMobileLink = ref(false);
const pairingRequests = ref([]);
const pairingRequestsEnabled = ref(false);
const approvingPairingRequestId = ref('');
const pairingNotice = ref(null);
const pairingNowMs = ref(Date.now());
let cleanupPairingMessages = null;

const statusDotClass = {
  success: 'bg-success shadow-[0_0_12px_rgba(16,185,129,0.35)]',
  warning: 'bg-warning shadow-[0_0_12px_rgba(245,158,11,0.35)]',
  danger: 'bg-danger shadow-[0_0_12px_rgba(239,68,68,0.35)]',
  muted: 'bg-gray-500',
};

const pillToneClass = {
  success: 'border-success/35 bg-success/10 text-success',
  warning: 'border-warning/35 bg-warning/10 text-warning',
  danger: 'border-danger/35 bg-danger/10 text-danger',
  muted: 'border-border bg-surface-200 text-muted-fg',
};

function toneClass(map, tone) {
  return map[tone] || map.muted;
}

function nativeServiceActionAvailable(method) {
  return !systemHost.isBusy && typeof systemHost.electronApi?.[method] === 'function';
}

function runNativeServiceAction(method) {
  if (!nativeServiceActionAvailable(method)) return false;
  return systemHost[method]();
}

function refreshNow() {
  pairingNowMs.value = Date.now();
  systemHost.refresh();
  if (!canManageHost.value) return;
  sendWs({ type: 'requestHistoryIndexStatus' });
  sendWs({ type: 'requestDevicePairingRequests' });
}

function openPhoneTabletSettings() {
  if (!canManageHost.value) return;
  tabs.requestTabChange('settings');
}

function approvePairingRequest(request) {
  if (!canManageHost.value || !request?.id || !request?.confirmationCode) return;
  pairingNotice.value = null;
  approvingPairingRequestId.value = request.id;
  const sent = sendWs({
    type: 'approveDevicePairingRequest',
    requestId: request.id,
    confirmationCode: request.confirmationCode,
  });
  if (!sent) {
    approvingPairingRequestId.value = '';
    pairingNotice.value = {
      tone: 'danger',
      message: 'Could not contact the backend. Check the connection and try again.',
    };
  }
}

function pairingExpiryLabel(expiresAt) {
  const seconds = Math.max(0, Math.ceil((Number(expiresAt) - pairingNowMs.value) / 1000));
  if (seconds <= 0) return 'Expiring now';
  return `Expires in ${seconds}s`;
}

const historyIndex = computed(() => logbook.historyIndexStatus || {});
const historyIndexStatusLabel = computed(() => {
  const index = historyIndex.value;
  if (logbook.historyIndexActionError) return logbook.historyIndexActionError;
  if (index.phase === 'checking') return 'Checking saved flight files...';
  if (index.phase === 'indexing') {
    return `${index.mode === 'rebuild' ? 'Rebuilding' : 'Indexing'} ${index.completedFiles || 0} of ${index.totalFiles || 0} flights (${index.percent || 0}%)`;
  }
  if (index.phase === 'error') return index.error || 'The history index could not be updated.';
  if (index.phase === 'complete') {
    const flights = Number(index.counts?.flights) || 0;
    const landings = Number(index.counts?.landings) || 0;
    const suffix = index.failures > 0 ? `; ${index.failures} file${index.failures === 1 ? '' : 's'} will be retried` : '';
    return `Up to date: ${flights} flights and ${landings} scored landings${suffix}.`;
  }
  return 'Status will be checked when the backend is connected.';
});

function checkHistoryIndex() {
  if (!canManageHost.value) return;
  sendWs({ type: 'checkHistoryIndex' });
}

function rebuildHistoryIndex() {
  if (!canManageHost.value) return;
  const confirmed = window.confirm(
    'Rebuild FlightFabric\'s flight history index?\n\nThis clears and recreates only the derived SQLite catalogue. Your flight CSV files and portable history summaries will not be changed or deleted.',
  );
  if (!confirmed || !canManageHost.value) return;
  sendWs({ type: 'rebuildHistoryIndex' });
}

async function copyMobileLink(url) {
  if (!url || typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return;
  try {
    await navigator.clipboard.writeText(url);
    copiedMobileLink.value = true;
    if (copyResetTimer) window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(() => {
      copiedMobileLink.value = false;
      copyResetTimer = null;
    }, 1800);
  } catch {
    copiedMobileLink.value = false;
  }
}

watch(canManageHost, (allowed) => {
  pairingRequests.value = [];
  pairingRequestsEnabled.value = false;
  pairingNotice.value = null;
  approvingPairingRequestId.value = '';
  if (allowed) refreshNow();
}, { flush: 'sync' });

onMounted(() => {
  cleanupPairingMessages = subscribeWsMessage((message = {}) => {
    if (!canManageHost.value) return;
    if (message.type === 'devicePairingRequests') {
      const hadPendingRequest = pairingRequests.value.length > 0;
      pairingRequestsEnabled.value = message.enabled === true;
      pairingRequests.value = Array.isArray(message.requests) ? message.requests : [];
      if (!hadPendingRequest && pairingRequests.value.length > 0) {
        pairingNotice.value = null;
        if (tabs.activeTabId === 'system') {
          void nextTick(() => {
            document.getElementById('system-device-pairing-requests')?.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest',
            });
          });
        }
      }
      return;
    }
    if (message.type !== 'devicePairingApprovalResult') return;
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    if (requestId && approvingPairingRequestId.value && requestId !== approvingPairingRequestId.value) return;
    approvingPairingRequestId.value = '';
    pairingNotice.value = message.ok === true
      ? { tone: 'success', message: 'Controls approved. The device will connect automatically.' }
      : { tone: 'warning', message: 'That request expired or changed. Ask the device to request a new code.' };
  });
  cleanupBackendStatus = systemHost.bindBackendStatusEvents();
  refreshNow();
  refreshTimer = window.setInterval(() => {
    refreshNow();
  }, 2500);
});

onUnmounted(() => {
  if (copyResetTimer) {
    window.clearTimeout(copyResetTimer);
    copyResetTimer = null;
  }
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (typeof cleanupBackendStatus === 'function') {
    cleanupBackendStatus();
  }
  cleanupBackendStatus = null;
  if (typeof cleanupPairingMessages === 'function') cleanupPairingMessages();
  cleanupPairingMessages = null;
});
</script>

<template>
  <section id="system-tab-shell" class="space-y-5">
    <div class="page-intro">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 class="text-sm font-semibold tracking-wide text-gray-100">System</h2>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-muted-fg">
            {{ canInspectServices ? 'Service status, phone and tablet access, and flight-history maintenance.' : 'Connection status and phone or tablet access.' }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button id="system-refresh-btn" type="button" class="ff-button-secondary px-3 py-2 text-xs" @click="refreshNow">
            Refresh
          </button>
        </div>
      </div>

      <div
        v-if="canManageHost && !systemHost.isElectron"
        id="system-browser-mode-note"
        class="mt-5 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning"
      >
        Service controls are available in the FlightFabric desktop app on your simulator PC. This browser can connect to FlightFabric while it is running.
      </div>

      <div
        v-if="canInspectServices && systemHost.lastError"
        id="system-host-error"
        class="mt-5 rounded-2xl border border-danger/35 bg-danger/10 p-4 text-sm text-danger"
      >
        {{ systemHost.lastError }}
      </div>
    </div>

    <div class="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
      <section v-if="canInspectServices" class="rounded-3xl border border-border/80 bg-panel/75 p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 class="text-lg font-semibold text-gray-100">Services</h3>
            <p class="mt-1 text-sm text-muted-fg">Start, stop, and inspect the local FlightFabric runtime.</p>
          </div>
          <div class="flex gap-2">
            <button
              id="system-start-all-btn"
              type="button"
              class="ff-button-primary px-3 py-2 text-xs"
              :disabled="!nativeServiceActionAvailable('startBackend')"
              @click="runNativeServiceAction('startBackend')"
            >
              Start All
            </button>
            <button
              id="system-stop-all-btn"
              type="button"
              class="ff-button-secondary px-3 py-2 text-xs text-danger"
              :disabled="!nativeServiceActionAvailable('stopBackend')"
              @click="runNativeServiceAction('stopBackend')"
            >
              Stop Backend
            </button>
          </div>
        </div>

        <p v-if="systemHost.isElectron && !canManageHost" id="system-desktop-recovery-note" class="mb-4 text-sm text-muted-fg" role="status">
          {{ connectionLabel }}. This desktop app can still start or restart the backend below. Settings and flight-history maintenance return when the connection is restored.
        </p>

        <div class="space-y-3">
          <div id="system-backend-service" class="rounded-2xl border border-border bg-surface-100/80 p-4">
            <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div class="flex items-start gap-3">
                <span
                  class="mt-1 h-3 w-3 rounded-full"
                  :class="toneClass(statusDotClass, systemHost.backendStatusTone)"
                  aria-hidden="true"
                ></span>
                <div>
                  <div class="font-semibold text-gray-100">Backend</div>
                  <div class="mt-1 text-sm text-muted-fg">Telemetry, WebSocket, recording, and API services.</div>
                  <div class="mt-2 flex flex-wrap gap-2 text-[11px]" style="font-family: var(--ff-font-mono);">
                    <span class="rounded-full border px-2 py-1" :class="toneClass(pillToneClass, systemHost.backendStatusTone)">
                      {{ systemHost.backendStatusLabel }}
                    </span>
                    <span class="rounded-full border border-border bg-surface-200 px-2 py-1 text-muted-fg">
                      WS {{ systemHost.backendWsPort || '--' }}
                    </span>
                    <span class="rounded-full border border-border bg-surface-200 px-2 py-1 text-muted-fg">
                      HTTP {{ systemHost.backendHttpPort || '--' }}
                    </span>
                  </div>
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  id="system-start-backend-btn"
                  type="button"
                  class="ff-button-primary px-3 py-2 text-xs"
                  :disabled="!nativeServiceActionAvailable('startBackend')"
                  @click="runNativeServiceAction('startBackend')"
                >
                  Start
                </button>
                <button
                  id="system-restart-backend-btn"
                  type="button"
                  class="ff-button-secondary px-3 py-2 text-xs"
                  :disabled="!nativeServiceActionAvailable('restartBackend')"
                  @click="runNativeServiceAction('restartBackend')"
                >
                  Restart
                </button>
                <button
                  id="system-stop-backend-btn"
                  type="button"
                  class="ff-button-secondary px-3 py-2 text-xs text-danger"
                  :disabled="!nativeServiceActionAvailable('stopBackend')"
                  @click="runNativeServiceAction('stopBackend')"
                >
                  Stop
                </button>
              </div>
            </div>
          </div>

          <div id="system-frontend-service" class="rounded-2xl border border-border bg-surface-100/80 p-4">
            <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div class="flex items-start gap-3">
                <span
                  class="mt-1 h-3 w-3 rounded-full"
                  :class="toneClass(statusDotClass, systemHost.frontendStatusTone)"
                  aria-hidden="true"
                ></span>
                <div>
                  <div class="font-semibold text-gray-100">Desktop UI Server</div>
                  <div class="mt-1 text-sm text-muted-fg">Local static server used by the Electron window and browser clients.</div>
                  <div class="mt-2 flex flex-wrap gap-2 text-[11px]" style="font-family: var(--ff-font-mono);">
                    <span class="rounded-full border px-2 py-1" :class="toneClass(pillToneClass, systemHost.frontendStatusTone)">
                      {{ systemHost.frontendStatusLabel }}
                    </span>
                    <span class="rounded-full border border-border bg-surface-200 px-2 py-1 text-muted-fg">
                      UI {{ systemHost.frontendPort || '--' }}
                    </span>
                  </div>
                </div>
              </div>
              <a
                id="system-desktop-url"
                class="break-all rounded-xl border border-border bg-surface-200 px-3 py-2 text-xs text-muted-fg"
                :href="systemHost.desktopUrl"
              >
                {{ systemHost.desktopUrl }}
              </a>
            </div>
          </div>
        </div>
      </section>

      <section v-else id="system-pc-managed-note" class="settings-panel" aria-labelledby="system-connection-title">
        <h3 id="system-connection-title" class="settings-panel-title">This device</h3>
        <p id="system-connection-status" class="mt-3 text-sm text-gray-100" role="status">{{ connectionLabel }}</p>
        <p class="mt-2 text-sm text-muted-fg">{{ profiles.authorizationScope === 'aircraft-control' ? 'Aircraft controls are paired on this device.' : 'This device has viewer access. To pair aircraft controls, use Request aircraft controls on this device and approve the code on your PC.' }}</p>
        <p class="mt-4 text-sm text-muted-fg">Services, recordings, and flight-history maintenance are managed in FlightFabric on your simulator PC. Keep FlightFabric running there to use this device as a second screen.</p>
      </section>

      <div class="space-y-5">
        <section id="system-mobile-access" class="scroll-mt-24 rounded-3xl border border-border/80 bg-panel/75 p-5">
          <div class="flex items-start gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300" aria-hidden="true">
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="5" y="2" width="14" height="20" rx="2" />
                <path d="M9 6h6" />
                <path d="M11.5 18h1" />
              </svg>
            </div>
            <div>
              <h3 class="text-lg font-semibold text-gray-100">Phone &amp; tablet</h3>
              <p class="mt-1 text-sm leading-6 text-muted-fg">
                Keep a browser second screen ready for every flight. Connect the device to the same trusted network as your simulator PC.
              </p>
            </div>
          </div>

          <div class="mt-4 grid gap-4 rounded-2xl border border-cyan-400/25 bg-cyan-400/10 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div class="min-w-0">
              <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300" style="font-family: var(--ff-font-mono);">
                Connect a device
              </div>
              <div class="mt-1 text-sm font-semibold text-gray-100">
                {{ systemHost.remoteAccessEnabled === false ? 'Phone & tablet access is off' : 'Scan the QR or type the address' }}
              </div>
              <div id="system-remote-url" class="mt-2 break-all font-mono text-sm text-cyan-100">
                <template v-if="systemHost.remoteAccessEnabled === false">Enable phone &amp; tablet access in Settings on your simulator PC</template>
                <span v-else-if="systemHost.remotePhoneEntryUrl" id="system-phone-entry-url">{{ systemHost.remotePhoneEntryUrl }}</span>
                <template v-else>LAN address unavailable</template>
              </div>
              <div v-if="systemHost.remoteAccessEnabled === false" id="system-mobile-disabled-note" class="mt-2 text-xs leading-5 text-muted-fg">
                Save the setting on your simulator PC, then restart the backend before pairing a phone or tablet.
              </div>
              <button
                v-if="canManageHost && systemHost.remoteAccessEnabled === false"
                id="system-mobile-settings-btn"
                type="button"
                class="ff-button-primary mt-3 px-3 py-2 text-xs"
                @click="openPhoneTabletSettings"
              >
                Enable phone &amp; tablet access
              </button>
              <div v-if="phoneSetupUrl" id="system-mobile-pairing-note" class="mt-2 text-xs leading-5 text-muted-fg">
                <template v-if="canManageHost && systemHost.shareAircraftControlPaired">The QR privately pairs aircraft controls for this backend session. The typed address opens safely in viewer mode, then asks you to approve a matching code. Starting a new flight does not require pairing again.</template>
                <template v-else-if="profiles.authorizationScope === 'aircraft-control'">This browser is already paired for aircraft controls. The typed address stays safe to share because it contains no pairing credential.</template>
                <template v-else>The QR and typed address open in viewer mode. To use aircraft controls, request them on the device and approve the matching code in FlightFabric on your simulator PC.</template>
              </div>
              <button
                v-if="systemHost.remotePhoneEntryUrl"
                id="system-mobile-copy-btn"
                type="button"
                class="ff-button-secondary mt-3 px-3 py-2 text-xs"
                @click="copyMobileLink(systemHost.remotePhoneEntryUrl)"
              >
                {{ copiedMobileLink ? 'Address copied' : 'Copy short address' }}
              </button>
              <details v-if="systemHost.remoteAccessEnabled === true && systemHost.alternateIpsLabel" class="mt-2 text-xs text-muted-fg">
                <summary class="w-fit cursor-pointer select-none hover:text-gray-200">Other network addresses</summary>
                <div id="system-alt-ips" class="mt-1 break-all font-mono text-[11px]">{{ systemHost.alternateIpsLabel }}</div>
              </details>
            </div>
            <RemoteBrowserQr
              v-if="phoneSetupUrl"
              id="system-mobile-qr"
              class="justify-self-start sm:justify-self-end"
              :label="canManageHost && systemHost.shareAircraftControlPaired ? 'Private QR code for FlightFabric phone setup' : 'QR code for FlightFabric viewer access'"
              :value="phoneSetupUrl"
            />
          </div>

          <div v-if="systemHost.remoteAccessEnabled === true && systemHost.remotePhoneEntryUrl" id="system-camera-free-setup" class="mt-3 flex items-start gap-2 text-xs leading-5 text-muted-fg">
            <svg class="mt-0.5 h-4 w-4 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <p><strong class="font-medium text-gray-200">No camera?</strong> Type the short address shown above. On the device, choose <strong class="font-medium text-gray-200">Request aircraft controls</strong>, then approve the matching code in FlightFabric on your simulator PC.</p>
          </div>

          <div v-if="canManageHost && systemHost.remoteAccessEnabled === true && pairingRequestsEnabled" id="system-device-pairing-requests" class="mt-4 rounded-2xl border border-border bg-surface-100/80 p-4">
            <div class="text-sm font-semibold text-gray-100">Device approval</div>
            <p class="mt-1 text-xs leading-5 text-muted-fg">Approve only when the same six-digit code is visible on your phone or tablet.</p>
            <div
              v-if="pairingNotice"
              id="system-device-pairing-notice"
              class="mt-3 rounded-xl border px-3 py-2 text-xs leading-5"
              :class="pairingNotice.tone === 'success'
                ? 'border-success/30 bg-success/10 text-success'
                : (pairingNotice.tone === 'danger'
                  ? 'border-danger/30 bg-danger/10 text-danger'
                  : 'border-warning/30 bg-warning/10 text-warning')"
              aria-live="polite"
            >
              {{ pairingNotice.message }}
            </div>
            <p v-if="pairingRequests.length === 0" class="mt-3 text-xs leading-5 text-muted-fg">No device is waiting for approval.</p>
            <div v-for="request in pairingRequests" :key="request.id" class="mt-3 flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-fg">Code shown on device</div>
                <div class="mt-1 font-mono text-2xl font-semibold tracking-[0.18em] text-primary">{{ request.confirmationCode }}</div>
                <div class="mt-1 text-xs text-muted-fg">{{ pairingExpiryLabel(request.expiresAt) }} · Network address {{ request.remoteAddress }}</div>
              </div>
              <button
                type="button"
                class="ff-button-primary w-full justify-center px-4 py-2 text-xs sm:w-auto"
                :disabled="Boolean(approvingPairingRequestId)"
                @click="approvePairingRequest(request)"
              >
                {{ approvingPairingRequestId === request.id ? 'Approving...' : 'Approve controls' }}
              </button>
            </div>
          </div>
        </section>

        <section v-if="canManageHost" id="system-history-index" class="rounded-3xl border border-border/80 bg-panel/75 p-5">
          <h3 class="text-lg font-semibold text-gray-100">Flight History Index</h3>
          <p class="mt-1 text-sm text-muted-fg">
            The searchable catalogue is derived from versioned FlightFabric summaries. Missing or stale summaries are rebuilt progressively from the authoritative CSVs, newest first.
          </p>
          <div class="mt-4 rounded-2xl border border-border bg-surface-100/80 p-4">
            <div class="flex items-start gap-3">
              <span
                class="mt-1 h-3 w-3 rounded-full"
                :class="logbook.historyIndexBusy ? statusDotClass.warning : (historyIndex.phase === 'error' ? statusDotClass.danger : statusDotClass.success)"
                aria-hidden="true"
              ></span>
              <div class="min-w-0 flex-1">
                <div id="system-history-index-status" class="text-sm font-medium text-gray-200">{{ historyIndexStatusLabel }}</div>
                <div v-if="logbook.historyIndexBusy" class="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-300">
                  <div
                    class="h-full rounded-full bg-cyan-400 transition-[width] duration-300"
                    :style="{ width: `${Math.max(1, historyIndex.percent || 0)}%` }"
                  ></div>
                </div>
                <div class="mt-2 text-xs text-muted-fg">
                  Rebuilding touches only FlightFabric's derived SQLite database. It never edits or deletes a flight CSV.
                </div>
              </div>
            </div>
          </div>
          <div class="mt-4 flex flex-wrap gap-2">
            <button
              id="system-history-index-check-btn"
              type="button"
              class="ff-button-primary px-3 py-2 text-xs"
              :disabled="logbook.historyIndexBusy"
              @click="checkHistoryIndex"
            >
              Check for Changes
            </button>
            <button
              id="system-history-index-rebuild-btn"
              type="button"
              class="ff-button-secondary px-3 py-2 text-xs"
              :disabled="logbook.historyIndexBusy"
              @click="rebuildHistoryIndex"
            >
              Rebuild Index...
            </button>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
