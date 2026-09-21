<script setup>
import { ref } from 'vue';
import Map3dLegend from './Map3dLegend.vue';
import Map3dOptions from './Map3dOptions.vue';
import MapViewModeToggle from './MapViewModeToggle.vue';
import TimelineMapControls from './TimelineMapControls.vue';
import TimelineAltitudeProfile from './TimelineAltitudeProfile.vue';
import TimelinePfdOverlay from './TimelinePfdOverlay.vue';
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();
const mapSettingsOpen = ref(false);
const fitViewButtonClass = 'flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 border border-surface-300 hover:border-accent/40 hover:text-gray-200 transition-colors';

function requestPreviewScrubOffset(event) {
  timeline.requestScrubOffset(event?.target?.value, {
    shouldPanMap: false,
    deferRender: true,
  });
}

function requestCommittedScrubOffset(event) {
  timeline.requestScrubOffset(event?.target?.value, {
    shouldPanMap: false,
  });
}
</script>

<template>
  <div id="timeline-map-card" class="bg-surface-100 border border-surface-200 overflow-hidden">
    <div class="p-2 sm:p-4 border-b border-surface-200">
      <div class="timeline-map-header">
        <div>
          <div class="text-xs sm:text-sm font-semibold text-gray-300">Replay View</div>
        </div>
        <div class="timeline-map-controls">
          <MapViewModeToggle
            id-prefix="timeline-map-view"
            label="Replay map view"
            :model-value="timeline.mapViewMode"
            @update:model-value="timeline.setMapViewMode($event)"
          />
          <button
            v-if="timeline.is3dMapView"
            id="timeline-map-3d-fit-btn"
            type="button"
            :class="fitViewButtonClass"
            title="Frame the whole flight"
            @click="timeline.requestMap3dFitView()"
          >
            Fit flight
          </button>
          <button
            v-if="timeline.is3dMapView"
            id="timeline-map-3d-settings-toggle"
            type="button"
            :class="fitViewButtonClass"
            :aria-expanded="mapSettingsOpen"
            aria-controls="timeline-map-settings"
            @click="mapSettingsOpen = !mapSettingsOpen"
          >3D settings</button>
          <div id="vue-timeline-map-controls-root">
            <TimelineMapControls />
          </div>
        </div>
      </div>
      <Map3dOptions
        v-if="timeline.is3dMapView"
        v-show="mapSettingsOpen"
        id="timeline-map-settings"
        id-prefix="timeline-map-3d"
        :disclosure="false"
        :options="timeline.map3dOptions"
        @update="(key, value) => timeline.setMap3dOption(key, value)"
      />
    </div>
    <div class="timeline-map-wrap" :class="{ 'map-view-3d-active': timeline.is3dMapView }" data-no-swipe>
      <div id="timeline-map" class="timeline-map-surface"></div>
      <div
        id="timeline-map-3d"
        class="timeline-map-surface flight-scene-surface"
        :class="{ 'map-view-hidden': !timeline.is3dMapView }"
        aria-label="3D replay view"
      ></div>
      <template v-if="timeline.is3dMapView">
        <Map3dLegend
          id-prefix="timeline-map-3d"
          :legend="timeline.scene3dLegend"
          :ground-plane-ft="timeline.scene3dLegend?.groundPlaneFt ?? null"
          :vertical-scale="timeline.scene3dLegend?.verticalScale ?? null"
          :terrain-active="timeline.scene3dLegend?.terrainActive === true"
          :terrain-elevation-ft="timeline.scene3dLegend?.terrainElevationFt ?? null"
          :above-terrain-ft="timeline.scene3dLegend?.aboveTerrainFt ?? null"
          :lighting="timeline.scene3dLegend?.lighting ?? null"
        />
        <div
          v-if="timeline.scene3dStatus"
          id="timeline-map-3d-status"
          class="flight-scene-status"
          role="status"
        >
          {{ timeline.scene3dStatus }}
        </div>
      </template>
      <div id="timeline-map-empty" :class="{ hidden: !timeline.mapEmptyVisible }">
        <div class="flex flex-col items-center gap-3">
          <div
            v-if="timeline.timelineLoading"
            class="h-9 w-9 rounded-full border-2 border-accent/25 border-t-accent animate-spin"
            aria-hidden="true"
          ></div>
          <div>
            <div class="text-sm font-medium text-gray-300">{{ timeline.mapEmptyMessage }}</div>
            <div v-if="timeline.timelineLoading" class="mt-1 text-xs text-gray-500">
              Preparing {{ timeline.timelineLoadingFlightLabel }}
            </div>
          </div>
        </div>
      </div>
      <div id="vue-timeline-pfd-root">
        <TimelinePfdOverlay />
      </div>
    </div>
    <TimelineAltitudeProfile />
    <div
      id="timeline-scrubber-wrap"
      data-no-swipe
      class="px-3 sm:px-4 py-2 sm:py-3 bg-surface-50 border-t border-surface-200"
      :class="{ hidden: !timeline.scrubberVisible }"
    >
      <div class="flex items-center justify-between text-[10px] sm:text-[11px] text-gray-500 mb-1 sm:mb-2">
        <div>Timeline Scrubber</div>
        <div id="timeline-time-current" class="font-mono text-gray-300">{{ timeline.scrubberCurrentLabel }}</div>
      </div>
      <div class="relative">
        <input
          id="timeline-time-scrubber"
          type="range"
          aria-label="Replay position"
          :aria-valuetext="`${timeline.scrubberCurrentLabel} of ${timeline.scrubberEndLabel}`"
          :min="timeline.scrubberMin"
          :max="timeline.scrubberMax"
          :value="timeline.scrubberValue"
          :step="timeline.scrubberStep"
          class="relative z-20 w-full cursor-pointer"
          :disabled="timeline.scrubberDisabled"
          @input="requestPreviewScrubOffset"
          @change="requestCommittedScrubOffset"
        />
      </div>
      <div class="mt-1 flex items-center justify-between text-[11px] font-mono text-gray-500">
        <div id="timeline-time-start">{{ timeline.scrubberStartLabel }}</div>
        <div id="timeline-time-end">{{ timeline.scrubberEndLabel }}</div>
      </div>
    </div>
  </div>
</template>
