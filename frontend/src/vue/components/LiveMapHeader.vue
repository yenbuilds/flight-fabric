<script setup>
import { useLiveMapStore } from '../stores/live-map.js';

const liveMap = useLiveMapStore();

const routeInputClass = 'px-3 py-1.5 rounded-lg border border-surface-300 bg-surface-200 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-accent';
const routeButtonClass = 'px-3 py-1.5 rounded-lg border border-surface-300 bg-surface-200 text-xs text-gray-300 hover:text-white hover:bg-surface-300 transition-colors';

const routeFields = [
  {
    key: 'origin',
    inputId: 'live-map-origin-icao',
    setButtonId: 'live-map-origin-set-btn',
    clearButtonId: 'live-map-origin-clear-btn',
    statusId: 'live-map-origin-status',
    placeholder: 'From ICAO (e.g. KJFK)',
    setLabel: 'Set From',
    clearLabel: 'Clear',
    inputKey: 'originInput',
    statusClassKey: 'originStatusClass',
    statusMessageKey: 'originStatusMessage',
    inputAction: 'setOriginInput',
    setAction: 'requestSetOrigin',
    clearAction: 'requestClearOrigin',
  },
  {
    key: 'target',
    inputId: 'live-map-target-icao',
    setButtonId: 'live-map-target-set-btn',
    clearButtonId: 'live-map-target-clear-btn',
    statusId: 'live-map-target-status',
    placeholder: 'Target ICAO (e.g. EGLL)',
    setLabel: 'Set Target',
    clearLabel: 'Clear',
    inputKey: 'targetInput',
    statusClassKey: 'targetStatusClass',
    statusMessageKey: 'targetStatusMessage',
    inputAction: 'setTargetInput',
    setAction: 'requestSetTarget',
    clearAction: 'requestClearTarget',
  },
];

function updateRouteInput(field, event) {
  liveMap[field.inputAction](event?.target?.value || '');
}

function handleRouteKeydown(field, event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  liveMap[field.setAction]();
}
</script>

<template>
  <div class="live-map-header-shell">
    <div class="live-map-header-top">
      <div class="live-map-title-block">
        <div class="live-map-title">Live Aircraft Map</div>
        <div class="live-map-subtitle">Real-time aircraft position from current telemetry</div>
      </div>
      <div class="live-map-actions">
        <span id="live-map-follow-status" :class="liveMap.followStatusClass">{{ liveMap.followStatusLabel }}</span>
        <button
          id="live-map-center-btn"
          :class="liveMap.centerButtonClass"
          type="button"
          @click="liveMap.requestCenter()"
        >
          {{ liveMap.centerButtonLabel }}
        </button>
      </div>
    </div>

    <div class="live-map-inline-meta">
      <div class="live-map-meta-card">
        <div class="live-map-meta-label">Telemetry</div>
        <div id="live-map-meta" class="live-map-meta-value mt-2">{{ liveMap.metaText }}</div>
      </div>

      <div id="live-map-route-inputs" class="live-map-route-inputs">
        <div
          v-for="field in routeFields"
          :key="field.key"
          class="live-map-route-row"
        >
          <input
            :id="field.inputId"
            :value="liveMap[field.inputKey]"
            :class="routeInputClass"
            type="text"
            maxlength="4"
            :placeholder="field.placeholder"
            @input="updateRouteInput(field, $event)"
            @keydown="handleRouteKeydown(field, $event)"
          />
          <button
            :id="field.setButtonId"
            :class="routeButtonClass"
            type="button"
            @click="liveMap[field.setAction]()"
          >
            {{ field.setLabel }}
          </button>
          <button
            :id="field.clearButtonId"
            :class="routeButtonClass"
            type="button"
            @click="liveMap[field.clearAction]()"
          >
            {{ field.clearLabel }}
          </button>
          <span :id="field.statusId" :class="liveMap[field.statusClassKey]">{{ liveMap[field.statusMessageKey] }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
