<script setup>
import { onMounted, onUnmounted } from 'vue';
import {
  $,
  getAppSettings,
  getUiHelpers,
  getWs,
} from '../../../app-shared.js';
import {
  subscribeAppSettings,
  subscribeAppSettingsSaved,
  subscribeWsOpen,
} from '../../app/runtime-signals.js';
import { getFlightFabricAppSettings } from '../../settings/shared-runtime.js';
import { initSettingsRuntime } from '../../settings/runtime.js';
import SettingsAboutLegal from './SettingsAboutLegal.vue';
import SettingsActionBar from './SettingsActionBar.vue';
import SettingsFormPanels from './SettingsFormPanels.vue';
import HelpTooltip from './HelpTooltip.vue';
import SettingsPendingBar from './SettingsPendingBar.vue';
import { useSettingsEditorStore } from '../stores/settings-editor.js';
import { useSettingsFormStore } from '../stores/settings-form.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useTabsStore } from '../stores/tabs.js';

const settingsEditor = useSettingsEditorStore();
const settingsForm = useSettingsFormStore();
const settingsUi = useSettingsUiStore();
const tabs = useTabsStore();
let settingsRuntime = null;

function showSettingsToast(...args) {
  const uiHelpers = getUiHelpers();
  if (typeof uiHelpers?.showToast !== 'function') return false;
  return uiHelpers.showToast(...args);
}

onMounted(() => {
  settingsRuntime = initSettingsRuntime({
    $,
    getAppSettings,
    getWs,
    settingsEditorStore: settingsEditor,
    settingsFormStore: settingsForm,
    settingsUiStore: settingsUi,
    subscribeAppSettingsSignal: subscribeAppSettings,
    subscribeAppSettingsSavedSignal: subscribeAppSettingsSaved,
    subscribeWsOpenSignal: subscribeWsOpen,
    tabsStore: tabs,
    showAppToast: showSettingsToast,
    appSettingsShared: getFlightFabricAppSettings(),
    windowRef: window,
    WebSocketRef: WebSocket,
  });
});

onUnmounted(() => {
  settingsRuntime?.cleanup?.();
  settingsRuntime = null;
});
</script>

<template>
  <div class="max-w-6xl page-stack">
    <div class="page-intro">
      <h2 class="text-sm font-semibold tracking-wide mb-1">Settings</h2>
      <p class="text-xs text-gray-500">Persisted to your Flight Fabric settings file so the packaged Electron app and backend use the same source of truth.</p>
    </div>

    <form id="settings-form" class="settings-form-shell" @submit.prevent="settingsForm.requestSave()">
      <div class="settings-form-head">
        <div class="text-xs font-semibold uppercase tracking-widest text-cyan-400" style="font-family: 'B612 Mono', monospace;">App Settings</div>
        <HelpTooltip label="App settings help">Changes are written to the settings file. Simulator, aircraft profile, network, and recording changes require restart.</HelpTooltip>
      </div>

      <div id="vue-settings-form-root">
        <SettingsFormPanels />
      </div>

      <div id="vue-settings-action-bar-root">
        <SettingsActionBar />
      </div>
    </form>

    <div id="vue-settings-pending-bar-root">
      <SettingsPendingBar />
    </div>

    <div id="vue-settings-about-root">
      <SettingsAboutLegal />
    </div>
  </div>
</template>
