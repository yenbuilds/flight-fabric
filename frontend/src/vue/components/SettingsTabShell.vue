<script setup>
import { computed, onMounted, onUnmounted } from 'vue';
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
import { useProfilesStore } from '../stores/profiles.js';
import { useSettingsEditorStore } from '../stores/settings-editor.js';
import { useSettingsFormStore } from '../stores/settings-form.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useToolbarPanelStore } from '../stores/toolbar-panel.js';
import { useTabsStore } from '../stores/tabs.js';

const settingsEditor = useSettingsEditorStore();
const settingsForm = useSettingsFormStore();
const settingsUi = useSettingsUiStore();
const toolbarPanel = useToolbarPanelStore();
const tabs = useTabsStore();
const profiles = useProfilesStore();
const canManageSettings = computed(() => profiles.authorizationScope === 'full-control');
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
    canManageSettings: () => canManageSettings.value,
    settingsEditorStore: settingsEditor,
    settingsFormStore: settingsForm,
    settingsUiStore: settingsUi,
    toolbarPanelStore: toolbarPanel,
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
  <div class="max-w-6xl page-stack settings-page">
    <div class="page-intro">
      <h2 class="text-sm font-semibold tracking-wide mb-1">Settings</h2>
      <p class="text-xs text-gray-500">Choose how FlightFabric works on this device.</p>
    </div>

    <section v-if="!canManageSettings" id="settings-pc-managed-note" class="settings-panel" aria-labelledby="settings-pc-managed-title">
      <h3 id="settings-pc-managed-title" class="settings-panel-title">App settings are managed on your PC</h3>
      <p class="mt-2 text-sm text-muted-fg">Open Settings in FlightFabric on the simulator PC to change simulator, recording, network, and app preferences.</p>
    </section>

    <!-- Keep the form mounted: the settings runtime binds its fields before the connection grants access. -->
    <div id="settings-desktop-preferences" v-show="canManageSettings" :inert="!canManageSettings" class="page-stack">
      <form id="settings-form" class="settings-form-shell" @submit.prevent="canManageSettings && settingsForm.requestSave()">
        <fieldset :disabled="!canManageSettings" class="min-w-0 m-0 border-0 p-0">
          <div class="settings-form-head">
            <div class="settings-form-heading">App preferences</div>
            <HelpTooltip label="App settings help">Changes are written to the settings file. Simulator, aircraft profile, network, and recording changes require restart.</HelpTooltip>
          </div>

          <div id="vue-settings-form-root">
            <SettingsFormPanels />
          </div>

          <div id="vue-settings-action-bar-root">
            <SettingsActionBar />
          </div>
        </fieldset>
      </form>

      <div id="vue-settings-pending-bar-root">
        <SettingsPendingBar />
      </div>

      <div id="vue-settings-about-root">
        <SettingsAboutLegal />
      </div>
    </div>
  </div>
</template>
