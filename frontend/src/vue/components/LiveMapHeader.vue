<script setup>
import Map3dOptions from './Map3dOptions.vue';
import MapViewModeToggle from './MapViewModeToggle.vue';
import { useLiveMapStore } from '../stores/live-map.js';
import { useProfilesStore } from '../stores/profiles.js';

const liveMap = useLiveMapStore();
const profiles = useProfilesStore();

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
        <div class="live-map-title">Live map</div>
        <div class="live-map-subtitle">
          {{ liveMap.is3dView ? 'Altitude, track and camera view from current telemetry' : 'Real-time aircraft position from current telemetry' }}
        </div>
      </div>
      <div class="live-map-actions">
        <MapViewModeToggle
          id-prefix="live-map-view"
          label="Live map view"
          :model-value="liveMap.viewMode"
          @update:model-value="liveMap.setViewMode($event)"
        />
        <span id="live-map-follow-status" :class="liveMap.followStatusClass">{{ liveMap.followStatusLabel }}</span>
      </div>
    </div>

    <Map3dOptions
      v-if="liveMap.is3dView"
      id-prefix="live-map-3d"
      :options="liveMap.map3dOptions"
      show-camera
      @update="(key, value) => liveMap.setMap3dOption(key, value)"
    />

    <details class="live-map-route-details">
      <summary>Route &amp; position</summary>
      <div class="live-map-inline-meta">
        <div class="live-map-meta-card">
          <div class="live-map-meta-label">Telemetry</div>
          <div id="live-map-meta" class="live-map-meta-value mt-2">{{ liveMap.metaText }}</div>
        </div>

        <div v-if="profiles.authorizationScope === 'full-control'" id="live-map-route-inputs" class="live-map-route-inputs">
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
              :aria-label="field.key === 'origin' ? 'Origin airport ICAO code' : 'Destination airport ICAO code'"
              autocapitalize="characters"
              autocomplete="off"
              spellcheck="false"
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
        <p v-else class="text-xs text-muted-fg">Route targets are managed on your FlightFabric PC.</p>
      </div>
    </details>
  </div>
</template>
