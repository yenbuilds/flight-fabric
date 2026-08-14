<script setup>
import { computed } from 'vue';
import AircraftArtwork from './AircraftArtwork.vue';
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();
const timelineAircraftName = computed(() => {
  const label = String(timeline.loadedTimelineAircraftLabel || '').trim();
  return /^(?:unknown|n\/?a|--?)$/i.test(label) ? '' : label;
});
</script>

<template>
  <div>
    <div class="timeline-card-header flex items-center justify-between gap-3 p-3 sm:p-4 border-b border-surface-200">
      <div class="flex items-center gap-2 sm:gap-3">
        <svg class="w-4 h-4 sm:w-5 sm:h-5 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <div class="text-xs sm:text-sm font-semibold">Timeline Inspector</div>
          <div id="timeline-flight-id" class="text-[10px] sm:text-xs text-gray-500">{{ timeline.inspectorFlightIdText }}</div>
          <div
            id="timeline-flight-route"
            class="text-xs text-accent"
            :class="{ hidden: !timeline.inspectorRouteVisible }"
          >
            {{ timeline.inspectorRouteText }}
          </div>
          <div v-if="timelineAircraftName" class="mt-0.5 max-w-[24rem] truncate text-[10px] text-gray-500">
            {{ timelineAircraftName }}
          </div>
        </div>
      </div>
      <AircraftArtwork
        v-if="timelineAircraftName"
        class="timeline-inspector-aircraft-art"
        :profile-id="timeline.loadedTimelineAircraftProfileId"
        :aircraft-name="timelineAircraftName"
      />
    </div>

    <div id="timeline-events" class="relative h-96 overflow-y-auto px-4 py-2">
      <div
        id="timeline-empty"
        class="flex flex-col items-center justify-center h-full text-gray-500"
        :class="{ hidden: !timeline.inspectorEmptyVisible }"
      >
        <div
          v-if="timeline.timelineLoading"
          class="w-10 h-10 mb-3 rounded-full border-2 border-accent/25 border-t-accent animate-spin"
          aria-hidden="true"
        ></div>
        <svg v-else class="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div class="text-sm text-center px-4">{{ timeline.inspectorEmptyMessage }}</div>
        <div class="text-xs text-gray-600 mt-1">
          {{ timeline.timelineLoading ? `Preparing ${timeline.timelineLoadingFlightLabel}` : 'Select a completed flight from the list below' }}
        </div>
      </div>

      <div
        id="timeline-event-list"
        class="space-y-1"
        :class="{ hidden: !timeline.inspectorEventListVisible }"
      >
        <button
          v-for="row in timeline.inspectorRows"
          :key="row.rowKey"
          type="button"
          class="timeline-event block w-full appearance-none border-0 bg-transparent text-left"
          :class="{
            selected: timeline.inspectorSelectedRowKey === row.rowKey,
          }"
          :data-index="String(row.index)"
          :data-row-key="row.rowKey"
          :data-type="row.type"
          @click="timeline.selectEventRow(row.rowKey)"
        >
          <div class="timeline-event-row">
            <div class="timeline-event-time">{{ row.timeOffsetText }}</div>
            <span class="timeline-event-dot" aria-hidden="true"></span>
            <div class="timeline-event-body">
              <div class="timeline-event-title-row">
                <span class="timeline-event-title">{{ row.title }}</span>
                <span
                  v-for="badge in row.badges"
                  :key="`${row.rowKey}-${badge.text}`"
                  class="timeline-score-badge"
                  :class="badge.toneClass"
                >
                  {{ badge.text }}
                </span>
                <span v-if="row.countText" class="timeline-count-badge">{{ row.countText }}</span>
              </div>
              <div v-if="row.subtitle" class="timeline-event-subtitle">{{ row.subtitle }}</div>
              <div
                v-if="row.showEndpointDateTime && (row.localDateTimeText || row.utcDateTimeText)"
                class="mt-0.5 flex flex-wrap gap-x-2 gap-y-0 text-[10px] font-mono text-gray-500"
              >
                <span v-if="row.localDateTimeText">LT {{ row.localDateTimeText }}</span>
                <span v-if="row.utcDateTimeText">UTC {{ row.utcDateTimeText }}</span>
              </div>
            </div>
          </div>
        </button>
        <div v-if="timeline.hasMoreInspectorRows" class="pt-2">
          <div v-if="timeline.inspectorRowsMeta" class="mb-2 text-center text-[11px] text-gray-500">
            {{ timeline.inspectorRowsMeta }}
          </div>
          <button
            type="button"
            class="w-full px-3 py-2 text-xs font-medium rounded border border-surface-300 text-gray-300 hover:bg-surface-300/40 transition-colors"
            @click="timeline.showMoreInspectorRows()"
          >
            Show more events
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
