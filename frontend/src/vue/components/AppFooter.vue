<script setup>
import DataSourcesButton from './DataSourcesButton.vue';
import FlightStatusBadges from './FlightStatusBadges.vue';
import { useDebugStore } from '../stores/debug.js';
import { useStatusStore } from '../stores/status.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useTabsStore } from '../stores/tabs.js';

const debug = useDebugStore();
const status = useStatusStore();
const settingsUi = useSettingsUiStore();
const tabs = useTabsStore();
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
        </div>
        <div class="flex items-center gap-4">
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
          <span id="runway-context" :class="{ hidden: !status.runwayContextVisible }">{{ status.runwayContextLabel }}</span>
          <button
            id="debug-toggle-btn"
            class="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-mono uppercase text-primary transition-colors hover:bg-primary/15"
            :class="{ hidden: !debug.toggleVisible }"
            @click="debug.toggleModal()"
          >
            Debug
          </button>
          <span id="connection-info">{{ status.connectionInfoLabel }}</span>
        </div>
      </div>
    </div>
  </footer>
</template>
