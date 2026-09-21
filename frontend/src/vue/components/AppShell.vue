<script setup>
import { onMounted, onUnmounted } from 'vue';
import AppFeedbackToast from './AppFeedbackToast.vue';
import AppFooter from './AppFooter.vue';
import AppHeader from './AppHeader.vue';
import AppNavigator from './AppNavigator.vue';
import DesktopTabs from './DesktopTabs.vue';
import DataSourcesModal from './DataSourcesModal.vue';
import DebugTelemetryModal from './DebugTelemetryModal.vue';
import LandingMetricModal from './LandingMetricModal.vue';
import LandingModal from './LandingModal.vue';
import MainContentShell from './MainContentShell.vue';
import MobileTabs from './MobileTabs.vue';
import MsfsInstallsModal from './MsfsInstallsModal.vue';
import QuickGlanceBar from './QuickGlanceBar.vue';
import SupportPrompt from './SupportPrompt.vue';
import SystemBanners from './SystemBanners.vue';
import VoiceFirstCommandCard from './VoiceFirstCommandCard.vue';
import WhatsNewCard from './WhatsNewCard.vue';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useVisualViewportCssVars } from '../composables/useVisualViewportCssVars.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useLogbookStore } from '../stores/logbook.js';
import { usePromptsStore } from '../stores/prompts.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useStatusStore } from '../stores/status.js';
import { useSupportStore } from '../stores/support.js';
import { useTabsStore } from '../stores/tabs.js';
import { useShellStore } from '../stores/shell.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useVoiceFirstCommandStore } from '../stores/voice-first-command.js';
import { useWhatsNewStore } from '../stores/whats-new.js';
import { initCabinAnnouncementsRuntime } from '../../cabin-announcements/runtime.js';
import { subscribeLandingReceived } from '../../app/runtime-signals.js';
import { initScreenWakeRuntime } from '../../app/screen-wake.js';
import { initWhatsNewRuntime } from '../../app/whats-new.js';
import { initSupportRuntime } from '../../support/runtime.js';
import { initTabsRuntime } from '../../tabs/runtime.js';
import { initVoiceFirstCommandRuntime } from '../../voice/first-command.js';
import { getAppSettings, getReconnect, setAppService } from '../../../app-shared.js';

const status = useStatusStore();
const tabs = useTabsStore();
const shell = useShellStore();
const logbook = useLogbookStore();
const prompts = usePromptsStore();
const settingsUi = useSettingsUiStore();
const support = useSupportStore();
const whatsNew = useWhatsNewStore();
const voice = useVoiceControlStore();
const voiceFirstCommand = useVoiceFirstCommandStore();
const aircraftControls = useAircraftControlsStore();
let cleanupTabsRuntime = null;
let cleanupSupportRuntime = null;
let cleanupWhatsNewRuntime = null;
let cleanupScreenWakeRuntime = null;
let cleanupVoiceFirstCommandRuntime = null;
let cabinAnnouncementsRuntime = null;

useBodyClass(() => status.simInMenu, 'sim-in-menu');
useBodyClass(() => status.quickGlanceVisible, 'quick-glance-active');
useVisualViewportCssVars();

onMounted(() => {
  cabinAnnouncementsRuntime = initCabinAnnouncementsRuntime({
    getAppSettings,
    statusStore: status,
    windowRef: window,
  });
  setAppService('cabinAnnouncements', cabinAnnouncementsRuntime);

  cleanupTabsRuntime = initTabsRuntime({
    tabsStore: tabs,
    reconnect: () => {
      const reconnect = getReconnect();
      return typeof reconnect === 'function' ? reconnect() : false;
    },
    canPullToReconnect: () => status.websocket === 'disconnected' || status.websocket === 'error',
    windowRef: window,
    documentRef: document,
  });

  cleanupSupportRuntime = initSupportRuntime({
    supportStore: support,
    logbookStore: logbook,
    promptsStore: prompts,
    subscribeLandingReceivedSignal: subscribeLandingReceived,
    windowRef: window,
    documentRef: document,
  });

  cleanupWhatsNewRuntime = initWhatsNewRuntime({
    whatsNewStore: whatsNew,
    settingsUiStore: settingsUi,
    windowRef: window,
  });

  cleanupScreenWakeRuntime = initScreenWakeRuntime({
    windowRef: window,
    documentRef: document,
    navigatorRef: navigator,
  });

  cleanupVoiceFirstCommandRuntime = initVoiceFirstCommandRuntime({
    firstCommandStore: voiceFirstCommand,
    voiceStore: voice,
    aircraftControlsStore: aircraftControls,
    statusStore: status,
    promptsStore: prompts,
    windowRef: window,
  });
});

onUnmounted(() => {
  setAppService('cabinAnnouncements', null);
  cabinAnnouncementsRuntime?.cleanup?.();
  cabinAnnouncementsRuntime = null;

  if (typeof cleanupTabsRuntime === 'function') {
    cleanupTabsRuntime();
  }
  cleanupTabsRuntime = null;
  cleanupSupportRuntime?.();
  cleanupSupportRuntime = null;
  cleanupWhatsNewRuntime?.();
  cleanupWhatsNewRuntime = null;
  cleanupScreenWakeRuntime?.();
  cleanupScreenWakeRuntime = null;
  cleanupVoiceFirstCommandRuntime?.();
  cleanupVoiceFirstCommandRuntime = null;
});
</script>

<template>
  <div class="app-workbench" :class="{ 'sidebar-collapsed': shell.sidebarCollapsed, 'mobile-menu-open': tabs.moreSheetOpen }" :data-active-view="tabs.activeTabId">
    <div id="vue-system-banners-root">
      <SystemBanners />
    </div>

    <aside id="vue-desktop-tabs-root" class="app-sidebar" aria-label="Application navigation">
      <DesktopTabs />
    </aside>

    <div id="vue-header-root">
      <AppHeader />
    </div>

    <div id="ptr-indicator" class="ptr-indicator" :class="tabs.pullRefreshClass">
      {{ tabs.pullRefreshLabel }}
    </div>

    <div id="quick-glance" class="quick-glance" :class="{ show: status.quickGlanceVisible }">
      <QuickGlanceBar />
    </div>

    <main id="vue-main-root" class="app-main ff-scroll-y flex-1 overflow-y-auto" tabindex="-1" aria-label="Workspace">
      <MainContentShell />
    </main>

    <div id="vue-mobile-tabs-root">
      <MobileTabs />
    </div>

    <div id="vue-footer-root">
      <AppFooter />
    </div>
  </div>

  <AppNavigator />

  <div id="vue-datasources-modal-root">
    <DataSourcesModal />
  </div>

  <div id="vue-msfs-installs-modal-root">
    <MsfsInstallsModal />
  </div>

  <div id="vue-landing-metric-modal-root">
    <LandingMetricModal />
  </div>

  <div id="vue-landing-modal-root">
    <LandingModal />
  </div>

  <div id="vue-debug-modal-root">
    <DebugTelemetryModal />
  </div>

  <div id="vue-app-feedback-toast-root">
    <AppFeedbackToast />
  </div>

  <div id="vue-support-prompt-root">
    <SupportPrompt />
  </div>

  <div id="vue-whats-new-root">
    <WhatsNewCard />
  </div>

  <div id="vue-voice-first-command-root">
    <VoiceFirstCommandCard />
  </div>
</template>

<style src="../../styles/app-workbench.css"></style>
