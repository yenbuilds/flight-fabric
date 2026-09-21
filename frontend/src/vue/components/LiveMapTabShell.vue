<script setup>
import { onMounted, onUnmounted } from 'vue';
import { getCoordValidator, sendWs } from '../../../app-shared.js';
import { subscribeWsMessage, subscribeWsMessageReceived } from '../../app/runtime-signals.js';
import { initLiveMapRuntime } from '../../live-map/runtime.js';
import LiveMapHeader from './LiveMapHeader.vue';
import LiveMapTargetOverlay from './LiveMapTargetOverlay.vue';
import Map3dHud from './Map3dHud.vue';
import Map3dLegend from './Map3dLegend.vue';
import { useAppSettingsStore } from '../stores/app-settings.js';
import { useLiveMapStore } from '../stores/live-map.js';
import { useStatusStore } from '../stores/status.js';
import { useTabsStore } from '../stores/tabs.js';
import { useFlightStore } from '../stores/flight.js';

const appSettings = useAppSettingsStore();
const liveMap = useLiveMapStore();
const status = useStatusStore();
const tabs = useTabsStore();
const flight = useFlightStore();
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
    subscribeTelemetryMessageSignal: subscribeWsMessageReceived,
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
  <div class="live-map-workspace">
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
      <div class="live-map-canvas">
        <div class="live-map-wrap" :class="{ 'map-view-3d-active': liveMap.is3dView }">
          <div id="live-map"></div>
          <div
            id="live-map-3d"
            class="flight-scene-surface"
            :class="{ 'map-view-hidden': !liveMap.is3dView }"
            aria-label="3D live flight view"
            data-no-swipe
          ></div>
          <div
            v-if="liveMap.is3dView && liveMap.scene3dStatus"
            id="live-map-3d-status"
            class="flight-scene-status"
            role="status"
          >
            {{ liveMap.scene3dStatus }}
          </div>
          <div class="live-map-overlays">
            <Map3dHud v-if="liveMap.is3dView" id-prefix="live-map-3d" :hud="flight.muted ? null : liveMap.scene3dHud" />
            <div class="live-map-controls">
              <button
                id="live-map-center-btn"
                class="ff-button-secondary"
                :class="liveMap.centerButtonClass"
                type="button"
                data-no-swipe
                @click="liveMap.requestCenter()"
              >
                {{ liveMap.centerButtonLabel }}
              </button>
              <Map3dLegend
                v-if="liveMap.is3dView"
                id-prefix="live-map-3d"
                tabindex="0"
                role="region"
                aria-label="3D map scale and details"
                data-no-swipe
                :legend="liveMap.scene3dLegend"
                :ground-plane-ft="liveMap.scene3dHud?.groundPlaneFt ?? null"
                :vertical-scale="liveMap.scene3dHud?.verticalScale ?? null"
                :terrain-active="liveMap.scene3dHud?.terrainActive === true"
                :terrain-elevation-ft="liveMap.scene3dHud?.terrainElevationFt ?? null"
                :above-terrain-ft="liveMap.scene3dHud?.aglFt ?? null"
                :lighting="liveMap.scene3dHud?.lighting ?? null"
                :attribution="appSettings.settings?.network?.onlineMapTiles !== false"
              />
            </div>
          </div>
          <div id="vue-live-map-overlay-root">
            <LiveMapTargetOverlay />
          </div>
          <div id="live-map-empty" class="live-map-empty" :class="{ hidden: !liveMap.mapEmptyVisible }">{{ liveMap.mapEmptyMessage }}</div>
        </div>
      </div>
      <dl class="live-map-readings" aria-label="Current flight readings">
        <div><dt>Airspeed</dt><dd>{{ flight.muted ? '--' : flight.telemetry.ias }} <small>kt</small></dd></div>
        <div><dt>Altitude</dt><dd>{{ flight.muted ? '--' : flight.telemetry.alt }} <small>ft</small></dd></div>
        <div><dt>V/S</dt><dd>{{ flight.muted ? '--' : flight.telemetry.vs }} <small>fpm</small></dd></div>
        <div><dt>Ground speed</dt><dd>{{ flight.muted ? '--' : flight.telemetry.gs }} <small>kt</small></dd></div>
        <div v-if="flight.muted"><dt>Telemetry</dt><dd>{{ flight.title }}</dd></div>
      </dl>
    </div>
  </div>
</template>
