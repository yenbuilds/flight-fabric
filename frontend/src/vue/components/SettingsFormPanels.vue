<script setup>
import { computed } from 'vue';
import HelpTooltip from './HelpTooltip.vue';
import ToolbarPanelSettingsPanel from './ToolbarPanelSettingsPanel.vue';
import SettingsSectionWatermark from './SettingsSectionWatermark.vue';
import PhoneTabletSetup from './PhoneTabletSetup.vue';
import { useSettingsEditorStore } from '../stores/settings-editor.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
const settings = useSettingsEditorStore();
const settingsUi = useSettingsUiStore();
defineProps({ section: { type: String, default: 'all' } });
const startupDelaySeconds = computed({
  get: () => Number(settings.cabinAnnouncementsStartupGraceMs) / 1000,
  set: value => {
    settings.cabinAnnouncementsStartupGraceMs = value === '' ? '' : String(Math.round(Number(value) * 1000));
    settings.sanitizeStartupGraceValue();
  },
});
</script>

<template>
  <div class="settings-panel-grid">
    <PhoneTabletSetup v-if="section === 'all' || section === 'devices'" />

    <ToolbarPanelSettingsPanel v-if="section === 'all' || section === 'devices'" />

    <section v-if="section === 'all' || section === 'general'" id="settings-general" data-settings-section tabindex="-1" class="settings-panel settings-panel--illustrated">
      <SettingsSectionWatermark kind="recording" />
      <div class="settings-panel-header">
        <div class="settings-panel-title-row">
          <h3 class="settings-panel-title">General</h3>
        </div>
      </div>

      <div class="settings-preferences-stack">
        <div class="settings-runtime-connection">
          <div class="settings-label-row">
            <label for="setting-simconnect-protocol" class="block text-xs text-gray-400 uppercase tracking-wider">Simulator Connection</label>
            <HelpTooltip label="Simulator connection help">Supports MSFS 2024. MSFS 2020 is unsupported; experimental X-Plane support is currently unavailable. Restart FlightFabric after changing simulators.</HelpTooltip>
          </div>
          <select form="settings-form"
            id="setting-simconnect-protocol"
            v-model="settings.simconnectProtocol"
            class="w-full bg-surface-200 border border-surface-300 text-sm text-gray-100 px-3 py-2.5 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
            style="font-family: 'B612 Mono', monospace;"
          >
            <option value="KittyHawk">Microsoft Flight Simulator 2024</option>
            <option value="XPLANE_WEB" disabled>X-Plane 12 Web API (experimental, currently unavailable)</option>
          </select>
        </div>

        <div class="settings-option-row flex items-center gap-3">
          <input form="settings-form" id="setting-recording-auto-start" v-model="settings.recordingAutoStart" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" aria-describedby="setting-recording-auto-start-help" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-recording-auto-start" class="block text-sm font-medium text-gray-200 cursor-pointer">Automatically start recording flights</label>
              <HelpTooltip label="Automatic flight recording help">Live monitoring continues when automatic recording is off. Restart to apply.</HelpTooltip>
            </span>
            <p id="setting-recording-auto-start-help" class="mt-1 text-xs leading-relaxed text-gray-500">Saved on this PC. Manage recordings in Logbook.</p>
          </div>
        </div>
      </div>

      <div class="mt-4 grid gap-3">
        <div class="settings-option-row flex items-center gap-3">
          <input form="settings-form" id="setting-update-checks" v-model="settings.updateChecks" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-update-checks" class="block text-sm font-medium text-gray-200 cursor-pointer">Check for app updates</label>
              <HelpTooltip label="Update checks help">Checks for updates at startup and daily.</HelpTooltip>
            </span>
          </div>
        </div>

        <div class="settings-option-row flex items-center gap-3">
          <input form="settings-form" id="setting-online-map-tiles" v-model="settings.onlineMapTiles" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-online-map-tiles" class="block text-sm font-medium text-gray-200 cursor-pointer">Use online map tiles</label>
              <HelpTooltip label="Online map tiles help">Map views use OpenStreetMap's standard labeled basemap. Turn this off to avoid third-party map traffic.</HelpTooltip>
            </span>
          </div>
        </div>
      </div>
      <div class="settings-option-row mt-4 flex flex-col items-start gap-3">
        <p v-if="settingsUi.introBlockedReason" id="settings-intro-help" class="text-xs leading-relaxed text-muted-fg">{{ settingsUi.introBlockedReason }}</p>
        <button id="settings-show-intro" type="button" class="ff-button-secondary sm:self-start"
          :disabled="Boolean(settingsUi.introBlockedReason)" :aria-describedby="settingsUi.introBlockedReason ? 'settings-intro-help' : undefined"
          @click="settingsUi.requestIntro()">Show intro again</button>
      </div>
    </section>

    <section v-if="section === 'all' || section === 'audio'" id="settings-cabin-audio" data-settings-section tabindex="-1" class="settings-panel settings-panel--illustrated">
      <SettingsSectionWatermark kind="audio" />
      <div class="settings-panel-header">
        <div class="settings-panel-title-row">
          <h3 class="settings-panel-title">Cabin audio</h3>
        </div>
      </div>

      <div id="setting-cabin-announcements-warning" class="settings-warning-card mb-4 rounded-lg px-4 py-3">
        <div class="settings-warning-title text-[11px] font-semibold uppercase tracking-[0.14em]" style="font-family: 'B612 Mono', monospace;">Experimental</div>
        <p class="settings-warning-copy mt-1.5 text-xs leading-relaxed">Announcements may be missed or repeated. Enable only for testing.</p>
      </div>

      <div class="settings-option-row flex items-center gap-3">
        <input form="settings-form" id="setting-cabin-announcements-enabled" v-model="settings.cabinAnnouncementsEnabled" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
        <div class="min-w-0 flex-1">
          <span class="settings-toggle-head">
            <label for="setting-cabin-announcements-enabled" class="block text-sm font-medium text-gray-200 cursor-pointer">Play cabin announcements</label>
              <HelpTooltip label="Cabin announcements help">Plays on the simulator PC only, not in browser views.</HelpTooltip>
          </span>
        </div>
      </div>

      <div class="mt-4">
        <div class="settings-label-row">
          <label for="setting-cabin-announcements-style" class="block text-xs text-gray-400 uppercase tracking-wider">Announcement pack</label>
          <HelpTooltip label="Audio pack style help">Matches the folder name inside your per-user <span class="app-tooltip-kbd">Flight Fabric/Audio/Cabin/</span> directory. Letters, numbers, <span class="app-tooltip-kbd">-</span>, and <span class="app-tooltip-kbd">_</span> only.</HelpTooltip>
        </div>
        <input form="settings-form"
          id="setting-cabin-announcements-style"
          v-model="settings.cabinAnnouncementsStyle"
          type="text"
          maxlength="40"
          placeholder="standard"
          class="w-full bg-surface-200 border border-surface-300 text-sm text-gray-100 placeholder-gray-600 px-3 py-2.5 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
          style="font-family: 'B612 Mono', monospace;"
          spellcheck="false"
          @input="settings.sanitizeCabinAnnouncementStyleValue()"
        />
        <p class="settings-section-description mt-2">Use an installed pack’s folder name, e.g. <span class="font-mono">standard</span>.</p>
      </div>

      <div class="mt-4">
        <div class="settings-label-row">
          <label for="setting-cabin-announcements-startup-grace-ms" class="block text-xs text-gray-400 uppercase tracking-wider">Startup delay (seconds)</label>
          <HelpTooltip label="Startup grace help">Wait before playing announcements after startup, a new flight or an aircraft change. Set to <span class="app-tooltip-kbd">0</span> for no delay.</HelpTooltip>
        </div>
        <input form="settings-form"
          id="setting-cabin-announcements-startup-grace-ms"
          v-model="startupDelaySeconds"
          type="number"
          min="0"
          max="60"
          step="0.001"
          placeholder="5"
          class="w-full bg-surface-200 border border-surface-300 text-sm text-gray-100 placeholder-gray-600 px-3 py-2.5 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
          style="font-family: 'B612 Mono', monospace;"
        />
      </div>
    </section>

    <section v-if="section === 'all' || section === 'advanced'" id="settings-advanced" data-settings-section tabindex="-1" class="settings-panel settings-advanced settings-panel--wide" aria-labelledby="settings-advanced-title">
      <div class="settings-advanced-heading">
        <h3 id="settings-advanced-title" class="settings-panel-title">Advanced network ports</h3>
        <p class="settings-advanced-copy">Change these only if another application is already using a FlightFabric port.</p>
      </div>
      <div class="settings-grid-2">
        <div>
          <label for="setting-ws-port" class="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">WebSocket Port</label>
          <input form="settings-form"
            id="setting-ws-port"
            v-model="settings.wsPort"
            type="number"
            min="1024"
            max="65535"
            step="1"
            class="w-full bg-surface-200 border border-surface-300 text-sm text-gray-100 px-3 py-2.5 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
            style="font-family: 'B612 Mono', monospace;"
          />
        </div>

        <div>
          <label for="setting-http-port" class="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">HTTP Port</label>
          <input form="settings-form"
            id="setting-http-port"
            v-model="settings.httpPort"
            type="number"
            min="1024"
            max="65535"
            step="1"
            class="w-full bg-surface-200 border border-surface-300 text-sm text-gray-100 px-3 py-2.5 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
            style="font-family: 'B612 Mono', monospace;"
          />
        </div>
      </div>

    </section>

  </div>
</template>
