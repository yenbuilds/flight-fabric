<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { sendWs } from '../../../app-shared.js';
import { openPhoneSettings } from '../settings-navigation.js';
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
const phoneSetupUrl = computed(() => systemHost.remoteViewerUrl);
const connectionLabel = computed(() => ({
  ready: 'Connected to FlightFabric',
  disconnected: 'Disconnected from FlightFabric',
  error: 'Connection failed',
}[status.websocket] || 'Connecting to FlightFabric...'));
let refreshTimer = null;
let cleanupBackendStatus = null;
let copyResetTimer = null;
const copiedMobileLink = ref(false);
const statusDotClass = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-gray-500',
};

const statusTextClass = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-muted-fg',
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
  systemHost.refresh();
  if (!canManageHost.value) return;
  sendWs({ type: 'requestHistoryIndexStatus' });
}

function openPhoneTabletSettings() {
  if (canManageHost.value) return openPhoneSettings(tabs);
}

const historyIndex = computed(() => logbook.historyIndexStatus || {});
const historyIndexTone = computed(() => {
  if (logbook.historyIndexActionError || historyIndex.value.phase === 'error') return 'danger';
  if (logbook.historyIndexBusy) return 'warning';
  if (historyIndex.value.phase === 'complete') return historyIndex.value.failures > 0 ? 'warning' : 'success';
  return 'muted';
});
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
  return 'Waiting for flight-history status.';
});

function checkHistoryIndex() {
  if (!canManageHost.value) return;
  sendWs({ type: 'checkHistoryIndex' });
}

function rebuildHistoryIndex() {
  if (!canManageHost.value) return;
  const confirmed = window.confirm(
    'Rebuild FlightFabric\'s flight list?\n\nThis recreates the searchable list of saved flights. Your recordings and saved flight summaries will not be changed or deleted.',
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

watch(canManageHost, allowed => { if (allowed) refreshNow(); }, { flush: 'sync' });

onMounted(() => {
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
        Service controls are available in the FlightFabric desktop app on your simulator PC.
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
      <section v-if="canInspectServices" class="settings-panel">
        <div class="mb-4 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h3 class="text-lg font-semibold text-gray-100">Services</h3>
            <p class="mt-1 text-sm text-muted-fg">Start, stop, and inspect the local FlightFabric runtime.</p>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
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
          <div id="system-backend-service" class="system-service-row">
            <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div class="flex items-start gap-3">
                <span
                  class="mt-1 h-2 w-2 shrink-0 rounded-full"
                  :class="toneClass(statusDotClass, systemHost.backendStatusTone)"
                  aria-hidden="true"
                ></span>
                <div>
                  <div class="font-semibold text-gray-100">Backend</div>
                  <div class="mt-1 text-sm text-muted-fg">Telemetry, WebSocket, recording, and API services.</div>
                  <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <span class="font-semibold" :class="toneClass(statusTextClass, systemHost.backendStatusTone)">
                      {{ systemHost.backendStatusLabel }}
                    </span>
                    <span class="text-muted-fg">
                      WS {{ systemHost.backendWsPort || '--' }}
                    </span>
                    <span class="text-muted-fg">
                      HTTP {{ systemHost.backendHttpPort || '--' }}
                    </span>
                  </div>
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  id="system-start-backend-btn"
                  type="button"
                  class="ff-button-secondary px-3 py-2 text-xs"
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

          <div id="system-frontend-service" class="system-service-row">
            <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div class="flex items-start gap-3">
                <span
                  class="mt-1 h-2 w-2 shrink-0 rounded-full"
                  :class="toneClass(statusDotClass, systemHost.frontendStatusTone)"
                  aria-hidden="true"
                ></span>
                <div>
                  <div class="font-semibold text-gray-100">Desktop UI Server</div>
                  <div class="mt-1 text-sm text-muted-fg">Local static server used by the Electron window and browser clients.</div>
                  <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <span class="font-semibold" :class="toneClass(statusTextClass, systemHost.frontendStatusTone)">
                      {{ systemHost.frontendStatusLabel }}
                    </span>
                    <span class="text-muted-fg">
                      UI {{ systemHost.frontendPort || '--' }}
                    </span>
                  </div>
                </div>
              </div>
              <a
                id="system-desktop-url"
                class="break-all text-xs text-muted-fg underline underline-offset-4"
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
        <p class="mt-4 text-sm text-muted-fg">Services, recordings, and flight-history maintenance are managed in FlightFabric on your simulator PC.</p>
      </section>

      <div class="space-y-5">
        <section id="system-mobile-access" class="settings-panel">
          <template v-if="canManageHost">
            <h3 class="settings-panel-title">Phone &amp; tablet</h3>
            <p class="mt-2 text-sm text-muted-fg">Use another device for cockpit controls and flight instruments.</p>
            <button id="system-mobile-settings-btn" type="button" class="ff-button-secondary mt-3" @click="openPhoneTabletSettings">Connect a phone or tablet</button>
          </template>
          <template v-else>
            <h3 class="settings-panel-title">Phone &amp; tablet</h3>
            <p id="system-mobile-pairing-note" class="mt-2 text-sm text-muted-fg">{{ profiles.authorizationScope === 'aircraft-control' ? 'This device is paired for aircraft controls. This address opens other devices in view-only mode.' : 'This device has view-only access.' }}</p>
            <p class="mt-2 text-sm text-muted-fg">Open Settings → Devices in FlightFabric on your PC to connect a phone or tablet.</p>
            <template v-if="phoneSetupUrl">
              <p id="system-phone-entry-url" class="my-3 break-all text-sm">{{ systemHost.remotePhoneEntryUrl }}</p>
              <RemoteBrowserQr id="system-mobile-qr" :value="phoneSetupUrl" label="QR code for FlightFabric viewer access" />
              <button id="system-mobile-copy-btn" type="button" class="ff-button-secondary mt-3" @click="copyMobileLink(systemHost.remotePhoneEntryUrl)">{{ copiedMobileLink ? 'Address copied' : 'Copy address' }}</button>
            </template>
          </template>
        </section>

        <section v-if="canManageHost" id="system-history-index" class="settings-panel">
          <h3 class="text-lg font-semibold text-fg">Flight history</h3>
          <p class="mt-1 text-sm text-muted-fg">
            Refresh or rebuild Logbook’s searchable flight list.
          </p>
          <div class="mt-4 border-t border-border pt-4">
            <div class="flex items-start gap-3">
              <span
                id="system-history-index-indicator"
                class="mt-1 h-2 w-2 shrink-0 rounded-full"
                :class="statusDotClass[historyIndexTone]"
                aria-hidden="true"
              ></span>
              <div class="min-w-0 flex-1">
                <div id="system-history-index-status" class="text-sm font-medium text-gray-200" role="status">{{ historyIndexStatusLabel }}</div>
                <div v-if="logbook.historyIndexBusy" class="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-300">
                  <div
                    class="h-full rounded-full bg-cyan-400 transition-[width] duration-300"
                    :style="{ width: `${Math.max(1, historyIndex.percent || 0)}%` }"
                  ></div>
                </div>
                <div class="mt-2 text-xs text-muted-fg">
          Your recordings and saved flight summaries stay unchanged.
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
              Rebuild flight list...
            </button>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.system-service-row { padding: 1rem 0; border-top: 1px solid rgb(var(--border) / .6); }
</style>
