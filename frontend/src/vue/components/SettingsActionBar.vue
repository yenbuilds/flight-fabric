<script setup>
import { computed } from 'vue';
import AppTooltip from './AppTooltip.vue';
import { useAppSettingsStore } from '../stores/app-settings.js';
import { useSettingsFormStore } from '../stores/settings-form.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useSystemHostStore } from '../stores/system-host.js';

const appSettings = useAppSettingsStore();
const settingsForm = useSettingsFormStore();
const settingsUi = useSettingsUiStore();
const systemHost = useSystemHostStore();

const settingsFilePath = computed(() => (
  appSettings.settingsFile
  || appSettings.storage?.settingsFile
  || '.../Flight Fabric/Settings/settings.json'
));
</script>

<template>
  <div class="settings-action-bar">
    <div class="min-w-0">
      <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-1" style="font-family: 'B612 Mono', monospace;">Settings File</div>
      <AppTooltip :content="settingsFilePath" placement="top-start" anchor-tag="div">
        <div
          id="settings-file-path"
          class="text-xs text-gray-300 break-all"
          style="font-family: 'B612 Mono', monospace;"
        >
          {{ settingsFilePath }}
        </div>
      </AppTooltip>
      <div id="settings-status" :class="settingsForm.statusClass">{{ settingsForm.statusMessage }}</div>
    </div>

    <div class="flex gap-2 shrink-0">
      <button
        id="settings-reveal-file-btn"
        type="button"
        class="px-3 py-1.5 rounded-lg bg-surface-200 border border-surface-300 text-gray-300 text-sm font-medium hover:bg-surface-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        :disabled="!systemHost.isElectron || systemHost.isBusy"
        @click="systemHost.revealSettingsFile()"
      >
        Reveal File
      </button>
      <button
        id="settings-reload-btn"
        type="button"
        class="px-3 py-1.5 rounded-lg bg-surface-200 border border-surface-300 text-gray-300 text-sm font-medium hover:bg-surface-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        :disabled="settingsForm.reloadButtonDisabled"
        @click="settingsForm.requestReload()"
      >
        {{ settingsForm.reloadButtonLabel }}
      </button>
      <AppTooltip :content="settingsUi.restartActionTitle" :disabled="!settingsUi.restartActionTitle">
        <button
          id="settings-restart-app-btn"
          type="button"
          class="settings-btn-warning px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          :disabled="settingsUi.restartActionDisabled"
          @click="settingsUi.requestRestart()"
        >
          {{ settingsUi.restartActionLabel }}
        </button>
      </AppTooltip>
      <button
        id="settings-save-btn"
        type="submit"
        class="settings-btn-accent px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        :class="{ 'save-flash': settingsForm.saveFlashActive }"
        :disabled="settingsForm.saveButtonDisabled"
        @animationend="settingsForm.clearSaveFlash()"
      >
        {{ settingsForm.saveButtonLabel }}
      </button>
    </div>
  </div>
</template>
