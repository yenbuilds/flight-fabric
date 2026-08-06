<script setup>
import { onMounted, onUnmounted } from 'vue';
import AppFeedbackToast from './AppFeedbackToast.vue';
import AppFooter from './AppFooter.vue';
import AppHeader from './AppHeader.vue';
import DataSourcesModal from './DataSourcesModal.vue';
import DebugTelemetryModal from './DebugTelemetryModal.vue';
import LandingMetricModal from './LandingMetricModal.vue';
import LandingModal from './LandingModal.vue';
import MainContentShell from './MainContentShell.vue';
import MobileTabs from './MobileTabs.vue';
import MsfsInstallsModal from './MsfsInstallsModal.vue';
import QuickGlanceBar from './QuickGlanceBar.vue';
import SystemBanners from './SystemBanners.vue';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useStatusStore } from '../stores/status.js';
import { useTabsStore } from '../stores/tabs.js';
import { initCabinAnnouncementsRuntime } from '../../cabin-announcements/runtime.js';
import { initTabsRuntime } from '../../tabs/runtime.js';
import { getAppSettings, getReconnect, setAppService } from '../../../app-shared.js';

const status = useStatusStore();
const tabs = useTabsStore();
let cleanupTabsRuntime = null;
let cabinAnnouncementsRuntime = null;

useBodyClass(() => status.simInMenu, 'sim-in-menu');
useBodyClass(() => status.quickGlanceVisible, 'quick-glance-active');

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
    windowRef: window,
    documentRef: document,
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
});
</script>

<template>
  <div id="vue-system-banners-root">
    <SystemBanners />
  </div>

  <div id="vue-header-root">
    <AppHeader />
  </div>

  <div id="ptr-indicator" class="ptr-indicator" :class="tabs.pullRefreshClass">
    {{ tabs.pullRefreshLabel }}
  </div>

  <div id="quick-glance" class="quick-glance" :class="{ show: status.quickGlanceVisible }">
    <QuickGlanceBar />
  </div>

  <main id="vue-main-root" class="app-main flex-1 overflow-y-auto scrollbar-hide">
    <MainContentShell />
  </main>

  <div id="vue-mobile-tabs-root">
    <MobileTabs />
  </div>

  <div id="vue-footer-root">
    <AppFooter />
  </div>

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
</template>
