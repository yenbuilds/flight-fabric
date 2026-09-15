<script setup>
import { ref } from 'vue';
import DataSourcesButton from './DataSourcesButton.vue';
import FlightStatusBadges from './FlightStatusBadges.vue';
import { useDebugStore } from '../stores/debug.js';
import { useStatusStore } from '../stores/status.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useTabsStore } from '../stores/tabs.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';

const debug = useDebugStore();
const status = useStatusStore();
const settingsUi = useSettingsUiStore();
const tabs = useTabsStore();
const diagnostics = ref(null);

function closeDiagnostics(restoreFocus = false) {
  if (!diagnostics.value?.open) return;
  diagnostics.value.open = false;
  if (restoreFocus) diagnostics.value.querySelector('summary')?.focus();
}

function handleDiagnosticAction(event) {
  if (event.target.closest('button')) closeDiagnostics();
}

useDocumentEvent('pointerdown', (event) => {
  if (!diagnostics.value?.contains(event.target)) closeDiagnostics();
});
useDocumentEvent('focusin', (event) => {
  if (!diagnostics.value?.contains(event.target)) closeDiagnostics();
});
</script>

<template>
  <footer class="ff-app-footer flex-none border-t border-border/80">
    <div class="app-shell-container py-2">
      <div class="footer-meta flex items-center justify-between text-xs" style="font-family: var(--ff-font-mono);">
        <div class="flex items-center gap-3">
          <span>FLIGHT FABRIC ALPHA</span>
          <span id="app-version" class="text-gray-500" style="font-size: 0.6rem; letter-spacing: 0.06em;"></span>
          <a
            id="footer-source-link"
            class="text-cyan-400 transition-colors hover:text-cyan-300"
            style="font-size: 0.6rem; letter-spacing: 0.06em; text-transform: uppercase;"
            href="https://github.com/yenbuilds/flight-fabric/releases"
            target="_blank"
            rel="noopener noreferrer"
          >Source (AGPL)</a>
        </div>
        <div class="flex items-center gap-4">
          <span id="runway-context" :class="{ hidden: !status.runwayContextVisible }">{{ status.runwayContextLabel }}</span>
          <a
            id="footer-donate-link"
            class="ff-button-secondary shrink-0 px-3 py-1 text-xs"
            href="https://ko-fi.com/yenbuilds"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg class="h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true" focusable="false">
              <path stroke-linecap="round" stroke-linejoin="round" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
            </svg>
            Donate
          </a>
          <details ref="diagnostics" class="footer-diagnostics" @keydown.esc.stop.prevent="closeDiagnostics(true)">
            <summary>Diagnostics</summary>
            <div class="footer-diagnostics-panel" @click="handleDiagnosticAction">
              <div class="footer-diagnostics-tools">
                <div id="vue-datasources-button-root">
                  <DataSourcesButton />
                </div>
                <span
                  id="surface-indicator"
                  class="rounded-full px-2 py-0.5 text-[10px] font-mono uppercase"
                  :class="[status.surfaceToneClass, { hidden: !status.surfaceVisible }]"
                >{{ status.surfaceLabel }}</span>
                <span id="vue-footer-sim-status-root" class="contents">
                  <FlightStatusBadges mode="footer" />
                </span>
              </div>
              <div class="footer-diagnostics-tools">
                <button
                  id="footer-open-lvars-btn"
                  type="button"
                  class="inline-flex items-center rounded-full px-2 py-1 text-gray-500 transition-colors hover:bg-panel-elevated/80 hover:text-gray-300"
                  style="font-size: 0.6rem; letter-spacing: 0.06em; text-transform: uppercase;"
                  @click="tabs.requestTabChange('lvars')"
                >
                  LVARs
                </button>
                <button
                  id="msfs-installs-btn"
                  type="button"
                  class="inline-flex items-center rounded-full px-2 py-1 text-gray-500 transition-colors hover:bg-panel-elevated/80 hover:text-gray-300"
                  :class="{ hidden: !settingsUi.canDetectMsfsInstalls }"
                  style="font-size: 0.6rem; letter-spacing: 0.06em; text-transform: uppercase;"
                  @click="settingsUi.openMsfsInstallsModal()"
                >
                  MSFS Installs
                </button>
                <button
                  id="debug-toggle-btn"
                  class="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-mono uppercase text-primary transition-colors hover:bg-primary/15"
                  :class="{ hidden: !debug.toggleVisible }"
                  @click="debug.toggleModal()"
                >
                  Debug
                </button>
              </div>
              <span id="connection-info">{{ status.connectionInfoLabel }}</span>
            </div>
          </details>
        </div>
      </div>
    </div>
  </footer>
</template>
