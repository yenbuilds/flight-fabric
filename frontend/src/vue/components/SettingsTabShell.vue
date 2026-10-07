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
import VoiceControlSettings from './VoiceControlSettings.vue';
import SettingsPendingBar from './SettingsPendingBar.vue';
import SettingsSectionNav from './SettingsSectionNav.vue';
import '../../styles/settings-workspace.css';
import { useProfilesStore } from '../stores/profiles.js';
import { useSettingsEditorStore } from '../stores/settings-editor.js';
import { useSettingsFormStore } from '../stores/settings-form.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useSystemHostStore } from '../stores/system-host.js';
import { useToolbarPanelStore } from '../stores/toolbar-panel.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';

const settingsEditor = useSettingsEditorStore();
const settingsForm = useSettingsFormStore();
const settingsUi = useSettingsUiStore();
const toolbarPanel = useToolbarPanelStore();
const voice = useVoiceControlStore();
const tabs = useTabsStore();
const profiles = useProfilesStore();
const systemHost = useSystemHostStore();
const canManageSettings = computed(() => profiles.authorizationScope === 'full-control');
const sections = computed(() => [
  ...(canManageSettings.value ? [{ id: 'settings-general', label: 'General' }] : []),
  ...(voice.bridgeAvailable ? [{ id: 'settings-voice-control', label: 'Voice' }] : []),
  ...(canManageSettings.value ? [
    { id: 'settings-phone-tablet-access', label: 'Devices & MSFS' },
    { id: 'settings-cabin-audio', label: 'Cabin audio' },
    { id: 'settings-advanced', label: 'Advanced' },
    { id: 'vue-settings-about-root', label: 'About' },
  ] : []),
]);
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

    <SettingsSectionNav :sections="sections" />

    <section v-if="!canManageSettings && systemHost.isElectron" id="settings-connection-note" class="settings-panel" aria-labelledby="settings-connection-title" role="status">
      <h3 id="settings-connection-title" class="settings-panel-title">Waiting for app settings</h3>
      <p class="mt-2 text-sm text-muted-fg">App preferences will return when FlightFabric reconnects. Open System to check the connection.</p>
    </section>

    <section v-else-if="!canManageSettings" id="settings-pc-managed-note" class="settings-panel" aria-labelledby="settings-pc-managed-title">
      <h3 id="settings-pc-managed-title" class="settings-panel-title">App settings are managed on your PC</h3>
      <p class="mt-2 text-sm text-muted-fg">Open Settings in FlightFabric on the simulator PC to change simulator, recording, network, and app preferences.</p>
    </section>

    <!-- Keep the form mounted: the settings runtime binds its fields before the connection grants access. -->
    <div id="settings-desktop-preferences" v-show="canManageSettings" :inert="!canManageSettings" class="page-stack">
      <form id="settings-form" @submit.prevent="canManageSettings && settingsForm.requestSave()">
        <fieldset :disabled="!canManageSettings" class="min-w-0 m-0 border-0 p-0">
          <div id="vue-settings-form-root">
            <SettingsFormPanels section="general" />
          </div>
        </fieldset>
      </form>
    </div>

    <VoiceControlSettings v-if="voice.bridgeAvailable" />

    <!-- These controls belong to the same form through their form attribute.
         Voice owns separate forms and remains available during backend recovery. -->
    <fieldset v-for="section in ['devices', 'audio', 'advanced']" :key="section"
      v-show="canManageSettings" :inert="!canManageSettings" :disabled="!canManageSettings"
      class="settings-preference-group">
      <SettingsFormPanels :section="section" />
    </fieldset>

    <div v-show="canManageSettings" :inert="!canManageSettings" id="vue-settings-action-bar-root">
      <SettingsActionBar />
    </div>
    <div id="vue-settings-pending-bar-root">
      <SettingsPendingBar />
    </div>
    <div v-show="canManageSettings" :inert="!canManageSettings" id="vue-settings-about-root" data-settings-section tabindex="-1">
      <SettingsAboutLegal />
    </div>
  </div>
</template>
