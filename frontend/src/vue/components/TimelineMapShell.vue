<script setup>
import TimelineMapControls from './TimelineMapControls.vue';
import TimelineAltitudeProfile from './TimelineAltitudeProfile.vue';
import TimelinePfdOverlay from './TimelinePfdOverlay.vue';
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();

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
          <div class="text-xs text-gray-500 hidden sm:block">2D flight-path replay driven by the timeline scrubber</div>
        </div>
        <div class="timeline-map-controls">
          <div id="vue-timeline-map-controls-root">
            <TimelineMapControls />
          </div>
        </div>
      </div>
    </div>
    <div class="timeline-map-wrap" data-no-swipe>
      <div id="timeline-map" class="timeline-map-surface"></div>
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
