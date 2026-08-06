<script setup>
import { computed, onMounted, onUnmounted } from 'vue';
import { sendWs } from '../../../app-shared.js';
import { initDebugRuntime } from '../../debug/runtime.js';
import {
  subscribeDebugFrame,
  subscribeTelemetryReset,
  subscribeWsClose,
  subscribeWsMessage,
} from '../../app/runtime-signals.js';
import AppTooltip from './AppTooltip.vue';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useDebugStore } from '../stores/debug.js';
import { useStatusStore } from '../stores/status.js';

const debug = useDebugStore();
const status = useStatusStore();
let debugRuntime = null;
const closeShortcutLabel = 'Press Ctrl+Shift+D to close';
const shakeOptions = [
  { value: '-200', label: '-200 fpm (soft)' },
  { value: '-400', label: '-400 fpm (normal)' },
  { value: '-700', label: '-700 fpm (firm)' },
  { value: '-1000', label: '-1000 fpm (hard)' },
];
const sourceLegend = [
  { key: 'simconnect', label: 'SimConnect' },
  { key: 'lvar', label: 'LVAR' },
  { key: 'derived', label: 'Derived' },
];

const filterModel = computed({
  get: () => debug.filterText,
  set: (value) => debug.setFilterText(value),
});

const showNullModel = computed({
  get: () => debug.showNull,
  set: (value) => debug.setShowNull(value),
});

const showStaleModel = computed({
  get: () => debug.showStale,
  set: (value) => debug.setShowStale(value),
});

const pauseModel = computed({
  get: () => debug.paused,
  set: (value) => debug.setPaused(value),
});

const shakeVsModel = computed({
  get: () => debug.testShakeVs,
  set: (value) => debug.setTestShakeVs(value),
});

useBodyClass(() => debug.modalOpen, 'debug-modal-open');

onMounted(() => {
  debugRuntime = initDebugRuntime({
    $: (id) => document.getElementById(id),
    sendWs,
    debugStore: debug,
    getCurrentDebugState: () => ({
      phase: status.phase,
      simConnected: status.simConnected,
      websocketReady: status.websocket === 'ready',
    }),
    subscribeDebugFrameSignal: subscribeDebugFrame,
    subscribeTelemetryResetSignal: subscribeTelemetryReset,
    subscribeWsCloseSignal: subscribeWsClose,
    subscribeWsMessageSignal: subscribeWsMessage,
    windowRef: window,
    documentRef: document,
    consoleRef: console,
  });
});

onUnmounted(() => {
  debugRuntime?.cleanup?.();
  debugRuntime = null;
});
</script>

<template>
  <div id="debug-modal" :class="debug.modalClass">
    <div class="debug-panel h-full flex flex-col bg-black">
      <div class="flex-none flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-black">
        <div class="flex items-center gap-4">
          <span class="text-sm font-semibold text-white">Telemetry Debug</span>
          <div class="flex items-center gap-2">
            <div id="debug-status-dot" :class="debug.statusDotClass"></div>
            <span id="debug-status-text" class="text-xs text-gray-400">{{ debug.statusText }}</span>
          </div>
          <span class="text-xs text-gray-600">{{ closeShortcutLabel }}</span>
        </div>
        <div class="flex items-center gap-3">
          <input
            id="debug-filter"
            v-model="filterModel"
            type="text"
            placeholder="Filter variables..."
            class="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white w-40 focus:outline-none focus:border-green-500"
          />
          <label class="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input id="debug-show-null" v-model="showNullModel" type="checkbox" class="accent-green-500" />
            Nulls
          </label>
          <label class="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input id="debug-show-stale" v-model="showStaleModel" type="checkbox" class="accent-green-500" />
            Stale
          </label>
          <label class="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input id="debug-pause" v-model="pauseModel" type="checkbox" class="accent-green-500" />
            Pause
          </label>
          <button id="debug-close" class="modal-close-button p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white" aria-label="Close telemetry debug" @click="debug.setModalOpen(false)">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div class="flex-none flex items-center gap-6 px-4 py-2 border-b border-gray-800 bg-gray-950 text-xs text-gray-500">
        <span>Rate: <span id="debug-poll-rate" class="text-gray-300">{{ debug.pollRateLabel }}</span> msg/s</span>
        <span>Vars: <span id="debug-total-vars" class="text-gray-300">{{ debug.totalVarCount }}</span></span>
        <span>Active: <span id="debug-active-vars" class="text-gray-300">{{ debug.activeVarCount }}</span></span>
        <span>Phase: <span id="debug-phase" class="text-green-400">{{ debug.phase }}</span></span>
        <span>Messages: <span id="debug-frame-count" class="text-gray-300">{{ debug.frameCount }}</span></span>
        <span
          id="debug-menu-indicator"
          class="px-2 py-0.5 bg-amber-500/30 border border-amber-500/50 rounded text-amber-300 font-bold animate-pulse"
          :class="{ hidden: !status.simInMenu }"
        >
          IN MENU
        </span>
        <span class="ml-auto flex items-center gap-2">
          <select
            id="debug-shake-vs"
            v-model="shakeVsModel"
            class="bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none focus:border-purple-500"
          >
            <option v-for="option in shakeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <button id="debug-test-shake" class="px-2 py-0.5 bg-purple-700 hover:bg-purple-600 border border-purple-500 rounded text-xs text-white font-medium" @click="debug.requestTestShake()">Test Shake</button>
          <span id="debug-shake-status" class="text-xs text-gray-500">{{ debug.testShakeStatus }}</span>
        </span>
      </div>

      <div class="flex-none flex items-center gap-4 px-4 py-2 border-b border-gray-800 bg-gray-950 text-xs">
        <span v-for="source in sourceLegend" :key="source.key" class="flex items-center gap-1.5">
          <span class="debug-source-dot" :class="source.key"></span>
          {{ source.label }}
        </span>
      </div>

      <div id="debug-content" class="flex-1 overflow-y-auto p-4 space-y-4">
        <div v-if="debug.sourceSections.length === 0" class="text-center text-gray-500 py-8">{{ debug.emptyStateLabel }}</div>
        <div
          v-for="section in debug.sourceSections"
          :key="section.key"
          class="debug-section"
          :data-source="section.key"
          :class="{ collapsed: section.collapsed }"
        >
          <button type="button" class="debug-source-header w-full text-left" @click="debug.toggleSourceCollapsed(section.key)">
            <span class="debug-source-dot" :class="section.color"></span>
            <span class="flex-1 font-semibold text-white">{{ section.name }}</span>
            <span class="text-gray-500">{{ section.filteredCount }}/{{ section.totalCount }}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded" :class="section.active ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-500'">
              {{ section.active ? 'ACTIVE' : 'IDLE' }}
            </span>
            <span class="debug-collapse-icon text-gray-500 transition-transform">{{ section.collapsed ? '>' : 'v' }}</span>
          </button>
          <div class="debug-var-grid">
            <div
              v-for="row in section.rows"
              :key="row.key"
              class="debug-var-row"
              :class="{ updated: row.changed, stale: row.stale }"
            >
              <AppTooltip :content="row.key" anchor-class="min-w-0">
                <span class="debug-var-name">{{ row.key }}</span>
              </AppTooltip>
              <span class="debug-var-value" :class="row.valueClass">{{ row.valueText }}</span>
              <span class="debug-var-age" :class="row.ageClass">{{ row.ageText }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
