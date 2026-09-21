<script setup>
import { computed, ref } from 'vue';
import DataSourcesButton from './DataSourcesButton.vue';
import FlightStatusBadges from './FlightStatusBadges.vue';
import { useDebugStore } from '../stores/debug.js';
import { useStatusStore } from '../stores/status.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useShellStore } from '../stores/shell.js';
import { useTabsStore } from '../stores/tabs.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { EXPERIMENTAL_TABS } from '../tab-config.js';

const debug = useDebugStore();
const status = useStatusStore();
const settingsUi = useSettingsUiStore();
const shell = useShellStore();
const tabs = useTabsStore();
const voice = useVoiceControlStore();
const diagnostics = ref(null);
const voiceLabel = computed(() => {
  if (!voice.runtime.enabled) return 'Voice off';
  if (voice.listening) return 'Listening';
  if (voice.finishing) return 'Processing voice';
  if (voice.status === 'sent') return 'Voice command sent';
  if (['error', 'failed', 'blocked', 'unavailable', 'unmatched'].includes(voice.status)) return 'Voice needs attention';
  return voice.ready ? 'Voice ready' : 'Voice starting';
});
function closeDiagnostics(restoreFocus = false) {
  if (!diagnostics.value?.open) return;
  diagnostics.value.open = false;
  if (restoreFocus) diagnostics.value.querySelector('summary')?.focus();
}
function handleDiagnosticAction(event) {
  if (event.target.closest('button')) closeDiagnostics();
}
useDocumentEvent('pointerdown', event => {
  if (!diagnostics.value?.contains(event.target)) closeDiagnostics();
});
useDocumentEvent('focusin', event => {
  if (!diagnostics.value?.contains(event.target)) closeDiagnostics();
});
</script>

<template>
  <footer class="ff-app-footer">
    <div class="app-shell-container">
      <div class="footer-meta">
        <div class="footer-session">
          <span v-if="voice.bridgeAvailable" class="footer-voice" :data-listening="voice.listening" :title="voice.statusText">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>
            {{ voiceLabel }}
          </span>
          <span id="runway-context" :class="{ hidden: !status.runwayContextVisible }">{{ status.runwayContextLabel }}</span>
          <button type="button" title="Help and keyboard shortcuts" @click="shell.openNavigator('help')">Help &amp; shortcuts</button>
        </div>
        <div class="flex items-center gap-3">
          <span id="app-version"></span>
          <details ref="diagnostics" class="footer-diagnostics" @keydown.esc.stop.prevent="closeDiagnostics(true)">
            <summary>Connection details</summary>
            <div class="footer-diagnostics-panel" @click="handleDiagnosticAction">
              <div class="footer-diagnostics-tools">
                <div id="vue-datasources-button-root"><DataSourcesButton /></div>
                <span id="surface-indicator" class="rounded-full px-2 py-0.5 text-[10px] font-mono uppercase" :class="[status.surfaceToneClass, { hidden: !status.surfaceVisible }]">{{ status.surfaceLabel }}</span>
                <span id="vue-footer-sim-status-root" class="contents"><FlightStatusBadges mode="footer" /></span>
              </div>
              <div class="footer-diagnostics-tools">
                <button id="footer-open-lvars-btn" type="button" class="ff-button-ghost" @click="tabs.requestTabChange('lvars')">LVAR inspector</button>
                <button id="msfs-installs-btn" type="button" class="ff-button-ghost" :class="{ hidden: !settingsUi.canDetectMsfsInstalls }" @click="settingsUi.openMsfsInstallsModal()">MSFS installs</button>
                <button id="debug-toggle-btn" type="button" class="ff-button-ghost" :class="{ hidden: !debug.toggleVisible }" @click="debug.toggleModal()">Debug telemetry</button>
              </div>
              <div class="footer-diagnostics-tools footer-experimental" aria-label="Experimental features">
                <span class="footer-experimental-label">Experimental</span>
                <button v-for="tab in EXPERIMENTAL_TABS" :id="'footer-open-' + tab.id + '-btn'" :key="tab.id" type="button" class="ff-button-ghost" :data-tab="tab.id" :aria-current="tabs.activeTabId === tab.id ? 'page' : undefined" @click="tabs.requestTabChange(tab.id)">{{ tab.label }}</button>
              </div>
              <span id="connection-info">{{ status.connectionInfoLabel }}</span>
            </div>
          </details>
        </div>
      </div>
    </div>
  </footer>
</template>
