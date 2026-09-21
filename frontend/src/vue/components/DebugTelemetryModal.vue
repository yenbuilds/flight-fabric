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
const sourceLegend = [
  { key: 'simconnect', label: 'SimConnect' },
  { key: 'lvar', label: 'LVAR' },
  { key: 'derived', label: 'Derived' },
];

const samplingDetailRowClass = 'flex justify-between gap-3';
const samplingDetailLabelClass = 'text-muted-fg';
const samplingDetailValueClass = 'text-right font-mono text-fg';

const samplingDetails = [
  { id: 'sampling-rate', label: 'Rate', valueKey: 'vreSamplingRateDetail' },
  { id: 'sampling-reason', label: 'Reason', valueKey: 'vreSamplingReasonLabel' },
  { id: 'sampling-decision', label: 'Decision', valueKey: 'vreSamplingDecisionLabel' },
  { id: 'sampling-last', label: 'Frame', valueKey: 'vreSamplingLastLabel' },
  { id: 'sampling-safety', label: 'Ultra', valueKey: 'vreSamplingSafetyLabel' },
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

      <div class="flex-none flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 border-b border-gray-800 bg-gray-950 text-xs text-gray-500">
        <div id="sampling-indicator" :class="{ hidden: !status.vreSamplingVisible }">
          <AppTooltip placement="bottom-end" tooltip-class="w-72" anchor-tag="div">
            <div
              id="sampling-pill"
              class="ff-status-chip cursor-help"
              :class="status.vreSamplingPillToneClass"
            >
              <div id="sampling-dot" class="h-2 w-2 rounded-full" :class="status.vreSamplingDotToneClass"></div>
              <span id="sampling-band" class="font-medium" :class="status.vreSamplingLabelToneClass">{{ status.vreSamplingSummaryLabel }}</span>
            </div>
            <template #content>
              <div class="mb-2 text-xs font-semibold text-fg">CSV Sampling</div>
              <dl class="space-y-1 text-[10px] text-muted-fg">
                <div
                  v-for="detail in samplingDetails"
                  :key="detail.id"
                  :class="samplingDetailRowClass"
                >
                  <dt :class="samplingDetailLabelClass">{{ detail.label }}</dt>
                  <dd :id="detail.id" :class="samplingDetailValueClass">{{ status[detail.valueKey] }}</dd>
                </div>
              </dl>
            </template>
          </AppTooltip>
        </div>
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
        <!-- The Test Shake controls were removed on 2026-09-18 while the
             touchdown shake is disabled; see touchdown-shake.ts. -->
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
