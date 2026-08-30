<script setup>
import HelpTooltip from './HelpTooltip.vue';
import { useSettingsEditorStore } from '../stores/settings-editor.js';
const settings = useSettingsEditorStore();
</script>

<template>
  <div class="settings-panel-grid">
    <section class="settings-panel">
      <div class="settings-panel-header">
        <div class="settings-panel-kicker">Runtime</div>
        <div class="settings-panel-title-row">
          <div class="settings-panel-title">Simulator &amp; Telemetry</div>
          <HelpTooltip label="Simulator and telemetry panel help">Simulator connection protocol, recording behavior, and advanced diagnostics.</HelpTooltip>
        </div>
      </div>

      <div class="settings-grid-2">
        <div class="settings-runtime-connection">
          <div class="settings-label-row">
            <label for="setting-simconnect-protocol" class="block text-xs text-gray-400 uppercase tracking-wider">Simulator Connection</label>
            <HelpTooltip label="Simulator connection help">Choose the simulator backend Flight Fabric should use. The MSFS path is designed and tested with MSFS 2024; MSFS 2020 is not a supported target. X-Plane support remains experimental and is temporarily unavailable for user selection; its implementation has been retained for future reactivation. Simulator changes take effect after a backend restart.</HelpTooltip>
          </div>
          <select
            id="setting-simconnect-protocol"
            v-model="settings.simconnectProtocol"
            class="w-full bg-surface-200 border border-surface-300 text-sm text-gray-100 px-3 py-2.5 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
            style="font-family: 'B612 Mono', monospace;"
          >
            <option value="KittyHawk">MSFS 2024 (KittyHawk / SimConnect)</option>
            <option value="XPLANE_WEB" disabled>X-Plane 12 Web API (experimental, currently unavailable)</option>
          </select>
        </div>

        <div class="flex flex-col items-stretch gap-3 rounded-lg border border-surface-300 bg-surface-200/60 px-4 py-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-gray-200">Aircraft compatibility</div>
            <div class="mt-1 text-xs leading-relaxed text-gray-400">Flight Fabric detects the loaded aircraft automatically from release-owned, read-only compatibility profiles. If the match is wrong, use <span class="text-cyan-400">Wrong aircraft?</span> beside the aircraft name.</div>
          </div>
        </div>

        <div class="flex items-center gap-3 rounded-lg border border-surface-300 bg-surface-200/60 px-4 py-3">
          <input id="setting-recording-auto-start" v-model="settings.recordingAutoStart" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" aria-describedby="setting-recording-auto-start-help" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-recording-auto-start" class="block text-sm font-medium text-gray-200 cursor-pointer">Automatically start recording flights</label>
              <HelpTooltip label="Automatic flight recording help">When this is off, Flight Fabric still monitors flights live, but it will not automatically start recording when movement is detected. Restart required to apply.</HelpTooltip>
            </span>
            <p id="setting-recording-auto-start-help" class="mt-1 text-xs leading-relaxed text-gray-500">Starts recording when a flight is detected. Recordings are stored locally and can be deleted from the Logbook.</p>
          </div>
        </div>
      </div>

    </section>

    <section class="settings-panel">
      <div class="settings-panel-header">
        <div class="settings-panel-kicker">Network</div>
        <div class="settings-panel-title-row">
          <div class="settings-panel-title">Ports &amp; Private LAN Access</div>
          <HelpTooltip label="Network panel help">Ports and private-LAN access for browser overlays and remote screens.</HelpTooltip>
        </div>
      </div>

      <div class="settings-grid-2">
        <div>
          <label for="setting-ws-port" class="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">WebSocket Port</label>
          <input
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
          <input
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

      <div class="mt-4 flex items-center gap-3 rounded-lg border border-surface-300 bg-surface-200/60 px-4 py-3">
        <input id="setting-remote-access" v-model="settings.remoteAccess" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
        <div class="min-w-0 flex-1">
          <span class="settings-toggle-head">
            <label for="setting-remote-access" class="block text-sm font-medium text-gray-200 cursor-pointer">Allow trusted LAN access</label>
            <HelpTooltip label="Remote access help">Enable phones, tablets, and other devices on your private LAN to reach the local dashboard after restart. Keep this off on public or shared networks.</HelpTooltip>
          </span>
        </div>
      </div>

      <div v-if="settings.remoteAccess" id="setting-remote-access-warning" class="settings-warning-card mt-4 rounded-lg px-4 py-3">
        <div class="settings-warning-title text-[11px] font-semibold uppercase tracking-[0.14em]" style="font-family: 'B612 Mono', monospace;">Trusted LAN Only</div>
        <p class="settings-warning-copy mt-1.5 text-xs leading-relaxed">Use this only on a private home network you trust. Do not enable it on hotel, airport, school, workplace, hotspot, or other public/shared networks.</p>
        <p class="settings-warning-copy mt-2 text-xs leading-relaxed">After saving and restarting, open <span class="font-mono text-gray-300">http://localhost:{{ settings.httpPort || '8100' }}/setup</span> on this PC to view the LAN address for phones and tablets.</p>

        <div class="mt-3 flex items-center gap-3 rounded-lg border border-amber-400/25 bg-surface-200/50 px-3 py-3">
          <input id="setting-remote-aircraft-control" v-model="settings.remoteAircraftControl" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-remote-aircraft-control" class="block text-sm font-medium text-gray-200 cursor-pointer">Allow aircraft controls from trusted LAN</label>
              <HelpTooltip label="Remote aircraft control help">Enable this on the Flight Fabric PC to let a browser paired from Phone setup operate aircraft-specific controls for the current backend session. This does not grant settings, recordings, history, file deletion, or profile management.</HelpTooltip>
            </span>
          </div>
        </div>

        <p v-if="settings.remoteAircraftControl" id="setting-remote-aircraft-control-warning" class="settings-warning-copy mt-2 text-xs leading-relaxed">Only browsers opened from the private QR under Phone setup can command the connected aircraft. Treat that URL and QR code as private; the pairing expires when the backend restarts, not when a new flight starts.</p>
      </div>

      <div class="mt-4 grid gap-3">
        <div class="flex items-center gap-3 rounded-lg border border-surface-300 bg-surface-200/60 px-4 py-3">
          <input id="setting-update-checks" v-model="settings.updateChecks" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-update-checks" class="block text-sm font-medium text-gray-200 cursor-pointer">Check for app updates</label>
              <HelpTooltip label="Update checks help">Packaged builds fetch the public update manifest from GitHub after startup and then daily. Turn this off for a fully quiet app.</HelpTooltip>
            </span>
          </div>
        </div>

        <div class="flex items-center gap-3 rounded-lg border border-surface-300 bg-surface-200/60 px-4 py-3">
          <input id="setting-online-map-tiles" v-model="settings.onlineMapTiles" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
          <div class="min-w-0 flex-1">
            <span class="settings-toggle-head">
              <label for="setting-online-map-tiles" class="block text-sm font-medium text-gray-200 cursor-pointer">Use online map tiles</label>
              <HelpTooltip label="Online map tiles help">Map views use OpenStreetMap's standard labeled basemap. Turn this off to avoid third-party map traffic.</HelpTooltip>
            </span>
          </div>
        </div>
      </div>
    </section>

    <section class="settings-panel">
      <div class="settings-panel-header">
        <div class="settings-panel-kicker">Cabin Announcements</div>
        <div class="settings-panel-title-row">
          <div class="settings-panel-title">Cabin Audio</div>
          <HelpTooltip label="Cabin audio panel help">PA audio enablement, selected pack, and startup grace timing.</HelpTooltip>
        </div>
      </div>

      <div id="setting-cabin-announcements-warning" class="settings-warning-card mb-4 rounded-lg px-4 py-3">
        <div class="settings-warning-title text-[11px] font-semibold uppercase tracking-[0.14em]" style="font-family: 'B612 Mono', monospace;">Experimental</div>
        <p class="settings-warning-copy mt-1.5 text-xs leading-relaxed">Phase-triggered PA audio timing can vary and may miss or repeat an announcement. Keep it disabled unless you are evaluating this feature.</p>
      </div>

      <div class="flex items-center gap-3 rounded-lg border border-surface-300 bg-surface-200/60 px-4 py-3">
        <input id="setting-cabin-announcements-enabled" v-model="settings.cabinAnnouncementsEnabled" type="checkbox" class="h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30" />
        <div class="min-w-0 flex-1">
          <span class="settings-toggle-head">
            <label for="setting-cabin-announcements-enabled" class="block text-sm font-medium text-gray-200 cursor-pointer">Enable phase-triggered PA audio</label>
              <HelpTooltip label="Cabin announcements help">Announcements play only in the Flight Fabric desktop app on the simulator host. This is a shared app setting, but browser views do not play cabin audio.</HelpTooltip>
          </span>
        </div>
      </div>

      <div class="mt-4">
        <div class="settings-label-row">
          <label for="setting-cabin-announcements-style" class="block text-xs text-gray-400 uppercase tracking-wider">Audio Pack Style</label>
          <HelpTooltip label="Audio pack style help">Matches the folder name inside your per-user <span class="app-tooltip-kbd">Flight Fabric/Audio/Cabin/</span> directory. Letters, numbers, <span class="app-tooltip-kbd">-</span>, and <span class="app-tooltip-kbd">_</span> only.</HelpTooltip>
        </div>
        <input
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
      </div>

      <div class="mt-4">
        <div class="settings-label-row">
          <label for="setting-cabin-announcements-startup-grace-ms" class="block text-xs text-gray-400 uppercase tracking-wider">Startup Grace (ms)</label>
          <HelpTooltip label="Startup grace help">How long to ignore phase-triggered PA audio after startup, flight start, or aircraft change. Set to <span class="app-tooltip-kbd">0</span> to disable the grace window.</HelpTooltip>
        </div>
        <input
          id="setting-cabin-announcements-startup-grace-ms"
          v-model="settings.cabinAnnouncementsStartupGraceMs"
          type="number"
          min="0"
          max="60000"
          step="1000"
          placeholder="5000"
          class="w-full bg-surface-200 border border-surface-300 text-sm text-gray-100 placeholder-gray-600 px-3 py-2.5 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
          style="font-family: 'B612 Mono', monospace;"
          @input="settings.sanitizeStartupGraceValue()"
        />
      </div>
    </section>

  </div>
</template>
