<script setup>
import { watch } from 'vue';
import HelpTooltip from './HelpTooltip.vue';
import { useToolbarPanelStore } from '../stores/toolbar-panel.js';

const toolbarPanel = useToolbarPanelStore();

// The settings runtime binds the desktop API after this section mounts, so
// load the status when the binding arrives rather than on mount.
watch(
  () => toolbarPanel.available,
  (available) => {
    if (available && !toolbarPanel.hasLoaded) toolbarPanel.refresh();
  },
  { immediate: true },
);

const TONE_CHIP = Object.freeze({
  good: 'ff-status-chip-success',
  warn: 'ff-status-chip-warning',
  danger: 'ff-status-chip-danger',
  muted: 'ff-status-chip',
});

function chipClass(tone) {
  return TONE_CHIP[tone] || TONE_CHIP.muted;
}

function isBusy(row, action) {
  return toolbarPanel.busyInstallId === row.installId && toolbarPanel.busyAction === action;
}

function confirmRemove(row) {
  return window.confirm(`Remove the FlightFabric toolbar package from ${row.label}?\n\nClose MSFS first. The flightfabric-toolbar package folders and all their contents are deleted, including any files added inside them. Other Community packages are left untouched.`);
}

async function remove(row) {
  if (!confirmRemove(row)) return;
  await toolbarPanel.uninstall(row.installId);
}
</script>

<template>
  <section id="settings-toolbar-panel" class="settings-panel settings-panel--wide" aria-labelledby="settings-toolbar-panel-title">
    <div class="settings-panel-header">
      <div class="settings-panel-kicker">In the simulator</div>
      <div class="settings-panel-title-row">
        <div id="settings-toolbar-panel-title" class="settings-panel-title">MSFS 2024 toolbar panel</div>
        <HelpTooltip label="MSFS toolbar panel help">Adds a FlightFabric button to the MSFS 2024 in-flight toolbar. The panel shows your SimBrief plan, the voice commands for the current aircraft, your last landing and the live voice push-to-talk state. It reads from FlightFabric on this PC only and cannot change settings or send aircraft commands.</HelpTooltip>
      </div>
    </div>

    <p class="text-xs leading-relaxed text-muted-fg">
      Your SimBrief plan, voice command reference, last landing and push-to-talk status, without leaving the simulator. The panel is read-only: it talks to FlightFabric on this PC only and never gets settings, recordings or aircraft-control access.
    </p>

    <div class="mt-4 rounded-r-lg border-l-2 border-warning/70 bg-warning/5 px-4 py-3 text-xs leading-relaxed">
      <h3 class="font-semibold text-warning">Experimental</h3>
      <p class="mt-1 text-fg">This toolbar panel may be unstable. If you experience problems, close MSFS and use Remove in this section of the desktop app.</p>
    </div>

    <div v-if="!toolbarPanel.available" id="toolbar-panel-desktop-only" class="mt-4 rounded-lg border border-border/60 bg-panel-subtle/60 px-4 py-3 text-xs leading-relaxed text-muted-fg">
      Install the toolbar package from the FlightFabric desktop app on your simulator PC. This browser view cannot write to the MSFS Community folder.
    </div>

    <template v-else>
      <div id="toolbar-panel-source-error" v-if="toolbarPanel.sourceError" class="mt-4 rounded-r-lg border-l-2 border-danger/70 bg-danger/5 px-4 py-3 text-xs leading-relaxed text-danger">
        {{ toolbarPanel.sourceError }}
      </div>

      <div id="toolbar-panel-installs" class="mt-4 divide-y divide-border/50 rounded-lg border border-border/60 bg-panel-subtle/40">
        <div v-if="toolbarPanel.loading && !toolbarPanel.hasLoaded" class="px-4 py-3 text-xs text-muted-fg">Checking your MSFS 2024 installations...</div>
        <div v-else-if="toolbarPanel.hasLoaded && !toolbarPanel.hasFoundInstall" id="toolbar-panel-no-installs" class="px-4 py-3 text-xs leading-relaxed text-muted-fg">
          No MSFS 2024 installation was found on this PC. FlightFabric checks the Microsoft Store and Steam locations only.
        </div>
        <div
          v-for="row in toolbarPanel.rows"
          v-show="row.found"
          :key="row.key"
          class="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
          :data-toolbar-install="row.installId"
        >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium text-fg">{{ row.label }}</span>
              <span :class="chipClass(row.tone)" data-toolbar-status>{{ row.statusLabel }}</span>
            </div>
            <p v-if="row.detail" class="mt-1 text-xs leading-relaxed text-muted-fg">{{ row.detail }}</p>
            <p v-if="row.communityFolder" class="mt-1 break-all text-[11px] text-gray-500" style="font-family: var(--ff-font-mono);">{{ row.communityFolder }}</p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button
              v-if="row.canInstall"
              type="button"
              class="ff-button-primary text-xs disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="toolbarPanel.busy"
              data-toolbar-action="install"
              @click="toolbarPanel.install(row.installId)"
            >
              {{ isBusy(row, 'install') ? 'Working...' : row.actionLabel }}
            </button>
            <button
              v-if="row.canRemove"
              type="button"
              class="ff-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="toolbarPanel.busy"
              data-toolbar-action="uninstall"
              @click="remove(row)"
            >
              {{ isBusy(row, 'uninstall') ? 'Removing...' : 'Remove' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="toolbarPanel.error" id="toolbar-panel-error" role="alert" class="mt-3 text-xs leading-relaxed text-danger">{{ toolbarPanel.error }}</div>
      <div v-else-if="toolbarPanel.result" id="toolbar-panel-result" role="status" class="mt-3 text-xs leading-relaxed text-success">
        {{ toolbarPanel.result.message }}
        <span v-if="toolbarPanel.restartNotice" class="text-warning">{{ toolbarPanel.restartNotice }}</span>
      </div>

      <div class="mt-4 grid gap-2 text-xs leading-relaxed text-muted-fg sm:grid-cols-2">
        <div class="rounded-lg border border-border/50 bg-panel/40 px-3 py-2.5">
          <div class="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg">Updates and reinstalls</div>
          <p class="mt-1">After each FlightFabric version update, return here and choose Update when shown. Same-version package fixes, such as a new toolbar icon, need Reinstall. Panel page content updates automatically and does not require reinstalling on its own.</p>
        </div>
        <div class="rounded-lg border border-border/50 bg-panel/40 px-3 py-2.5">
          <div class="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg">Installing safely</div>
          <p class="mt-1">Close MSFS before installing, updating or removing the package, then restart it. If FlightFabric's network ports change, choose Update ports. Removal is limited to the flightfabric-toolbar package folders and their contents; other Community packages are left untouched.</p>
        </div>
      </div>

      <div class="mt-3 flex items-center justify-between gap-3">
        <span v-if="toolbarPanel.packageVersion" class="text-[11px] text-gray-500" style="font-family: var(--ff-font-mono);">Package {{ toolbarPanel.packageVersion }}</span>
        <button
          id="toolbar-panel-refresh"
          type="button"
          class="ff-button-ghost text-xs disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="toolbarPanel.busy"
          @click="toolbarPanel.refresh()"
        >
          {{ toolbarPanel.loading ? 'Checking...' : 'Check again' }}
        </button>
      </div>
    </template>
  </section>
</template>
