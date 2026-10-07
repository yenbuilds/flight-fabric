<script setup>
import { computed } from 'vue';
import HelpTooltip from './HelpTooltip.vue';
import ToolbarPanelSettingsPanel from './ToolbarPanelSettingsPanel.vue';
import SettingsSectionWatermark from './SettingsSectionWatermark.vue';
import { useSettingsEditorStore } from '../stores/settings-editor.js';
const settings = useSettingsEditorStore();
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
    <section v-if="section === 'all' || section === 'devices'" id="settings-phone-tablet-access" data-settings-section tabindex="-1" class="settings-panel settings-panel--wide settings-panel--illustrated">
      <SettingsSectionWatermark kind="devices" />
      <div class="settings-panel-header">
        <div class="settings-panel-kicker">Second screen</div>
        <div class="settings-panel-title-row">
          <h3 class="settings-panel-title">Phone &amp; tablet access</h3>
          <HelpTooltip label="Phone and tablet access help">Use this on a private home network to open FlightFabric on a phone or tablet. Save and restart after enabling it, then open Phone setup to scan the QR code or type the short address.</HelpTooltip>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <input form="settings-form" id="setting-remote-access" v-model="settings.remoteAccess" type="checkbox" class="mt-0.5 h-5 w-5 shrink-0 rounded border-surface-300 bg-surface-100 text-primary focus:ring-primary/30" />
        <div class="min-w-0 flex-1">
          <span class="settings-toggle-head">
            <label for="setting-remote-access" class="block cursor-pointer text-sm font-medium text-fg">Use FlightFabric on phones and tablets</label>
            <HelpTooltip label="Trusted LAN access help">Enable devices on your private home network to reach FlightFabric after restart. Keep this off on public or shared networks. That includes hotel, airport, school, workplace, and hotspot Wi-Fi.</HelpTooltip>
          </span>
          <p v-if="settings.remoteAccess" class="mt-1 text-xs leading-relaxed text-muted-fg">Use this only on a private home network you trust.</p>
          <p v-else class="mt-1 text-xs leading-relaxed text-muted-fg">Off by default. Turn on only for a private home network you trust.</p>
        </div>
      </div>

      <p v-if="!settings.remoteAccess" id="setting-phone-tablet-next-step" class="mt-4 border-t border-border/40 pt-3 text-xs leading-relaxed text-muted-fg">Turn this on, save, and restart FlightFabric. Then open <span class="font-medium text-fg">Phone setup</span> to scan the QR or type the short address.</p>

      <template v-else>
        <div id="setting-remote-access-warning" class="mt-5 rounded-r-lg border-l-2 border-warning/70 bg-warning/5 px-4 py-3">
          <div class="text-[11px] font-semibold uppercase tracking-[0.12em] text-warning">Trusted LAN only</div>
          <p class="mt-1.5 text-xs leading-relaxed text-muted-fg">Do not use this on hotel, airport, school, workplace, hotspot, or other public/shared networks.</p>
        </div>

        <div class="mt-4 flex items-start gap-3 border-t border-border/50 pt-4">
          <input form="settings-form" id="setting-remote-aircraft-control" v-model="settings.remoteAircraftControl" type="checkbox" class="mt-0.5 h-5 w-5 shrink-0 rounded border-surface-300 bg-surface-100 text-primary focus:ring-primary/30" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-remote-aircraft-control" class="block cursor-pointer text-sm font-medium text-fg">Allow aircraft controls on paired devices</label>
              <HelpTooltip label="Remote aircraft control help">This is enabled by default for new phone and tablet setups. A browser must still be paired from Phone setup, using the private QR or matching-code approval, before it can operate aircraft-specific controls for the current backend session. It does not grant settings, recordings, history, file deletion, or profile management.</HelpTooltip>
            </span>
            <p v-if="settings.remoteAircraftControl" id="setting-remote-aircraft-control-warning" class="mt-1 text-xs leading-relaxed text-muted-fg">Viewer devices cannot send aircraft commands. Pair with the private QR or approve a matching code in Phone setup; access expires when the backend restarts.</p>
          </div>
        </div>

        <p class="mt-4 text-xs leading-relaxed text-muted-fg">Open <span class="font-medium text-fg">Phone setup</span> on this PC to connect your device. If you just enabled access, save and restart first.</p>
      </template>
    </section>

    <ToolbarPanelSettingsPanel v-if="section === 'all' || section === 'devices'" />

    <section v-if="section === 'all' || section === 'general'" id="settings-general" data-settings-section tabindex="-1" class="settings-panel settings-panel--illustrated">
      <SettingsSectionWatermark kind="recording" />
      <div class="settings-panel-header">
        <div class="settings-panel-kicker">App preferences</div>
        <div class="settings-panel-title-row">
          <h3 class="settings-panel-title">General</h3>
          <HelpTooltip label="Simulator and telemetry panel help">Simulator connection protocol, recording behavior, and advanced diagnostics.</HelpTooltip>
        </div>
        <p class="settings-section-description">Simulator, recording and app preferences. Save to apply. Any changes that need a restart will be listed when you edit.</p>
      </div>

      <div class="settings-preferences-stack">
        <div class="settings-runtime-connection">
          <div class="settings-label-row">
            <label for="setting-simconnect-protocol" class="block text-xs text-gray-400 uppercase tracking-wider">Simulator Connection</label>
            <HelpTooltip label="Simulator connection help">Choose the simulator backend FlightFabric should use. The MSFS path is designed and tested with MSFS 2024; MSFS 2020 is not a supported target. X-Plane support remains experimental and is temporarily unavailable for user selection; its implementation has been retained for future reactivation. Simulator changes take effect after a backend restart.</HelpTooltip>
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

        <div class="settings-option-row flex flex-col items-stretch gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-gray-200">Aircraft compatibility</div>
            <div class="mt-1 text-xs leading-relaxed text-gray-400">FlightFabric automatically detects your aircraft. If the match is wrong, use <span class="text-primary">Wrong aircraft?</span> beside the aircraft name.</div>
          </div>
        </div>

        <div class="settings-option-row flex items-center gap-3">
          <input form="settings-form" id="setting-recording-auto-start" v-model="settings.recordingAutoStart" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" aria-describedby="setting-recording-auto-start-help" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-recording-auto-start" class="block text-sm font-medium text-gray-200 cursor-pointer">Automatically start recording flights</label>
              <HelpTooltip label="Automatic flight recording help">When this is off, FlightFabric still monitors flights live, but it will not automatically start recording when movement is detected. Restart required to apply.</HelpTooltip>
            </span>
            <p id="setting-recording-auto-start-help" class="mt-1 text-xs leading-relaxed text-gray-500">Starts recording when a flight is detected. Recordings are stored locally and can be deleted from the Logbook.</p>
          </div>
        </div>
      </div>

      <div class="mt-4 grid gap-3">
        <div class="settings-option-row flex items-center gap-3">
          <input form="settings-form" id="setting-update-checks" v-model="settings.updateChecks" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-update-checks" class="block text-sm font-medium text-gray-200 cursor-pointer">Check for app updates</label>
              <HelpTooltip label="Update checks help">Packaged builds fetch the public update manifest from GitHub after startup and then daily. Turn this off for a fully quiet app.</HelpTooltip>
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
    </section>

    <section v-if="section === 'all' || section === 'audio'" id="settings-cabin-audio" data-settings-section tabindex="-1" class="settings-panel settings-panel--illustrated">
      <SettingsSectionWatermark kind="audio" />
      <div class="settings-panel-header">
        <div class="settings-panel-kicker">Cabin Announcements</div>
        <div class="settings-panel-title-row">
          <h3 class="settings-panel-title">Cabin audio</h3>
          <HelpTooltip label="Cabin audio panel help">PA audio enablement, selected pack, and startup grace timing.</HelpTooltip>
        </div>
        <p class="settings-section-description">Save to apply changes to cabin announcements.</p>
      </div>

      <div id="setting-cabin-announcements-warning" class="settings-warning-card mb-4 rounded-lg px-4 py-3">
        <div class="settings-warning-title text-[11px] font-semibold uppercase tracking-[0.14em]" style="font-family: 'B612 Mono', monospace;">Experimental</div>
        <p class="settings-warning-copy mt-1.5 text-xs leading-relaxed">Phase-triggered PA audio timing can vary and may miss or repeat an announcement. Keep it disabled unless you are evaluating this feature.</p>
      </div>

      <div class="settings-option-row flex items-center gap-3">
        <input form="settings-form" id="setting-cabin-announcements-enabled" v-model="settings.cabinAnnouncementsEnabled" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
        <div class="min-w-0 flex-1">
          <span class="settings-toggle-head">
            <label for="setting-cabin-announcements-enabled" class="block text-sm font-medium text-gray-200 cursor-pointer">Play cabin announcements</label>
              <HelpTooltip label="Cabin announcements help">Announcements play only in the FlightFabric desktop app on the simulator host. This is a shared app setting, but browser views do not play cabin audio.</HelpTooltip>
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
        <p class="settings-section-description mt-2">Enter the folder name of an installed pack, for example <span class="font-mono">standard</span>.</p>
      </div>

      <div class="mt-4">
        <div class="settings-label-row">
          <label for="setting-cabin-announcements-startup-grace-ms" class="block text-xs text-gray-400 uppercase tracking-wider">Startup delay (seconds)</label>
          <HelpTooltip label="Startup grace help">How long to ignore phase-triggered PA audio after startup, flight start, or aircraft change. Set to <span class="app-tooltip-kbd">0</span> to disable the grace window.</HelpTooltip>
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

    <details v-if="section === 'all' || section === 'advanced'" id="settings-advanced" data-settings-section tabindex="-1" class="settings-panel settings-advanced settings-panel--wide">
      <summary>
        <span>
          <span class="settings-panel-title">Advanced network ports</span>
          <span class="settings-advanced-copy">Change these only if another application is already using a FlightFabric port.</span>
        </span>
      </summary>
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

    </details>

  </div>
</template>
