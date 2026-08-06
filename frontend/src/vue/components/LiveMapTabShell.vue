<script setup>
import { onMounted, onUnmounted } from 'vue';
import { getCoordValidator, sendWs } from '../../../app-shared.js';
import { subscribeWsMessage } from '../../app/runtime-signals.js';
import { initLiveMapRuntime } from '../../live-map/runtime.js';
import LiveMapHeader from './LiveMapHeader.vue';
import LiveMapTargetOverlay from './LiveMapTargetOverlay.vue';
import { useAppSettingsStore } from '../stores/app-settings.js';
import { useLiveMapStore } from '../stores/live-map.js';
import { useStatusStore } from '../stores/status.js';
import { useTabsStore } from '../stores/tabs.js';

const appSettings = useAppSettingsStore();
const liveMap = useLiveMapStore();
const status = useStatusStore();
const tabs = useTabsStore();
let cleanupLiveMapRuntime = null;

onMounted(() => {
  cleanupLiveMapRuntime = initLiveMapRuntime({
    liveMapStore: liveMap,
    tabsStore: tabs,
    statusStore: status,
    getElementById: (id) => document.getElementById(id),
    isValidCoord: getCoordValidator(),
    sendMessage: (payload) => sendWs(payload),
    subscribeWsMessageSignal: subscribeWsMessage,
    allowOnlineMapTiles: () => appSettings.settings?.network?.onlineMapTiles !== false,
    windowRef: window,
    localStorageRef: localStorage,
    consoleRef: console,
  });
});

onUnmounted(() => {
  cleanupLiveMapRuntime?.();
  cleanupLiveMapRuntime = null;
});
</script>

<template>
  <div>
    <div class="menu-overlay">
      <div class="menu-overlay-content text-center">
        <div class="text-amber-300 text-lg font-semibold tracking-wide">SIM IS IN MENUS</div>
        <div class="text-gray-400 text-sm">Map position updates paused</div>
      </div>
    </div>
    <div class="live-map-card-shell bg-surface-100 border border-surface-200 overflow-hidden">
      <div class="px-4 pt-4 pb-4 border-b border-surface-200 live-map-panel-head">
        <div id="vue-live-map-header-root">
          <LiveMapHeader />
        </div>
      </div>
      <div class="p-4">
        <div class="live-map-wrap">
          <div id="live-map"></div>
          <div id="vue-live-map-overlay-root">
            <LiveMapTargetOverlay />
          </div>
          <div id="live-map-empty" class="live-map-empty" :class="{ hidden: !liveMap.mapEmptyVisible }">{{ liveMap.mapEmptyMessage }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
