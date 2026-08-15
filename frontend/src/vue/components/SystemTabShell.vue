<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { sendWs } from '../../../app-shared.js';
import RemoteBrowserQr from './RemoteBrowserQr.vue';
import { useLogbookStore } from '../stores/logbook.js';
import { useSystemHostStore } from '../stores/system-host.js';

const systemHost = useSystemHostStore();
const logbook = useLogbookStore();
let refreshTimer = null;
let cleanupBackendStatus = null;
let copyResetTimer = null;
const copiedMobileLink = ref(false);

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

function refreshNow() {
  systemHost.refresh();
  sendWs({ type: 'requestHistoryIndexStatus' });
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
  sendWs({ type: 'checkHistoryIndex' });
}

function rebuildHistoryIndex() {
  const confirmed = window.confirm(
    'Rebuild Flight Fabric\'s flight history index?\n\nThis clears and recreates only the derived SQLite catalogue. Your flight CSV files and portable history summaries will not be changed or deleted.',
  );
  if (!confirmed) return;
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
    <div class="rounded-3xl border border-border/80 bg-panel/80 p-5 shadow-2xl shadow-black/20">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-400" style="font-family: var(--ff-font-mono);">
            Electron App Host
          </div>
          <h2 class="text-2xl font-semibold tracking-tight text-gray-100">System Control</h2>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-muted-fg">
            Service status, local ports, mobile access, and flight-history maintenance.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button id="system-refresh-btn" type="button" class="ff-button-secondary px-3 py-2 text-xs" @click="refreshNow">
            Refresh
          </button>
        </div>
      </div>

      <div
        v-if="!systemHost.isElectron"
        id="system-browser-mode-note"
        class="mt-5 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning"
      >
        Native service controls are only available in the Electron app. The web dashboard can still connect to a running backend normally.
      </div>

      <div
        v-if="systemHost.lastError"
        id="system-host-error"
        class="mt-5 rounded-2xl border border-danger/35 bg-danger/10 p-4 text-sm text-danger"
      >
        {{ systemHost.lastError }}
      </div>
    </div>

    <div class="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
      <section class="rounded-3xl border border-border/80 bg-panel/75 p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 class="text-lg font-semibold text-gray-100">Services</h3>
            <p class="mt-1 text-sm text-muted-fg">Start, stop, and inspect the local Flight Fabric runtime.</p>
          </div>
          <div class="flex gap-2">
            <button
              id="system-start-all-btn"
              type="button"
              class="ff-button-primary px-3 py-2 text-xs"
              :disabled="!systemHost.isElectron || systemHost.isBusy"
              @click="systemHost.startBackend()"
            >
              Start All
            </button>
            <button
              id="system-stop-all-btn"
              type="button"
              class="ff-button-secondary px-3 py-2 text-xs text-danger"
              :disabled="!systemHost.isElectron || systemHost.isBusy"
              @click="systemHost.stopBackend()"
            >
              Stop Backend
            </button>
          </div>
        </div>

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
                  :disabled="!systemHost.isElectron || systemHost.isBusy"
                  @click="systemHost.startBackend()"
                >
                  Start
                </button>
                <button
                  id="system-restart-backend-btn"
                  type="button"
                  class="ff-button-secondary px-3 py-2 text-xs"
                  :disabled="!systemHost.isElectron || systemHost.isBusy"
                  @click="systemHost.restartBackend()"
                >
                  Restart
                </button>
                <button
                  id="system-stop-backend-btn"
                  type="button"
                  class="ff-button-secondary px-3 py-2 text-xs text-danger"
                  :disabled="!systemHost.isElectron || systemHost.isBusy"
                  @click="systemHost.stopBackend()"
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
                Keep a browser second screen ready for every flight. Connect the device to the same trusted network as this PC.
              </p>
            </div>
          </div>

          <div class="mt-4 grid gap-4 rounded-2xl border border-cyan-400/25 bg-cyan-400/10 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div class="min-w-0">
              <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300" style="font-family: var(--ff-font-mono);">
                Phone link
              </div>
              <div class="mt-1 text-sm font-semibold text-gray-100">Scan to connect</div>
              <div id="system-remote-url" class="mt-2 break-all font-mono text-sm text-cyan-100">
                {{ systemHost.remoteBrowserUrl || 'LAN IP unavailable' }}
              </div>
              <div v-if="systemHost.remoteBrowserUrl" id="system-mobile-pairing-note" class="mt-2 text-xs leading-5 text-muted-fg">
                <template v-if="systemHost.shareAircraftControlPaired">Private link. It opens the dashboard and pairs aircraft controls for this backend session. Starting a new flight does not require another scan; scan again only after the Flight Fabric backend restarts. Aircraft commands still require the LAN control setting.</template>
                <template v-else-if="systemHost.currentBrowserAircraftControlPaired">This browser is paired for aircraft controls in the current backend session. The displayed link remains read-only and does not expose its pairing token.</template>
                <template v-else>Read-only link. Open this page on the simulator PC after the backend starts to generate the current-session paired link.</template>
              </div>
              <button
                v-if="systemHost.remoteBrowserUrl"
                id="system-mobile-copy-btn"
                type="button"
                class="ff-button-secondary mt-3 px-3 py-2 text-xs"
                @click="copyMobileLink(systemHost.remoteBrowserUrl)"
              >
                {{ copiedMobileLink ? 'Copied' : 'Copy phone link' }}
              </button>
              <div v-if="systemHost.alternateIpsLabel" id="system-alt-ips" class="mt-2 text-xs text-muted-fg">
                Other IPs: {{ systemHost.alternateIpsLabel }}
              </div>
            </div>
            <RemoteBrowserQr
              v-if="systemHost.remoteBrowserUrl"
              id="system-mobile-qr"
              class="justify-self-start sm:justify-self-end"
              :value="systemHost.remoteBrowserUrl"
            />
          </div>
        </section>

        <section id="system-history-index" class="rounded-3xl border border-border/80 bg-panel/75 p-5">
          <h3 class="text-lg font-semibold text-gray-100">Flight History Index</h3>
          <p class="mt-1 text-sm text-muted-fg">
            The searchable catalogue is derived from versioned Flight Fabric summaries. Missing or stale summaries are rebuilt progressively from the authoritative CSVs, newest first.
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
                  Rebuilding touches only Flight Fabric's derived SQLite database. It never edits or deletes a flight CSV.
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
