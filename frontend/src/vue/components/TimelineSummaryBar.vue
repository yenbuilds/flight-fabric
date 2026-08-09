<script setup>
import { computed } from 'vue';
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();

const analysisActionText = computed(() => (
  timeline.analysisRescore.applied ? 'Scoring saved' : 'Review scoring'
));
</script>

<template>
  <div
    v-if="timeline.summaryVisible"
    class="flex min-w-0 items-center border-b border-surface-200 bg-surface-50"
  >
    <div class="min-w-0 flex-1 overflow-x-auto px-3 py-2 sm:px-4">
      <dl class="flex min-w-max items-center gap-2 whitespace-nowrap text-[10px]">
        <div class="flex items-baseline gap-1.5">
          <dt class="text-[9px] uppercase tracking-wider text-gray-500">Events</dt>
          <dd class="font-semibold text-gray-200">{{ timeline.eventCountText }}</dd>
        </div>
        <div class="flex items-baseline gap-1.5 border-l border-surface-200/70 pl-2">
          <dt class="text-[9px] uppercase tracking-wider text-gray-500">Violations</dt>
          <dd class="font-semibold text-amber-400">{{ timeline.violationCountText }}</dd>
        </div>
        <div class="flex items-baseline gap-1.5 border-l border-surface-200/70 pl-2">
          <dt class="text-[9px] uppercase tracking-wider text-gray-500">Duration</dt>
          <dd class="font-semibold text-gray-200">{{ timeline.durationText }}</dd>
        </div>
        <div class="flex items-baseline gap-1.5 border-l border-surface-200/70 pl-2">
          <dt class="text-[9px] uppercase tracking-wider text-gray-500">Distance</dt>
          <dd class="font-semibold text-gray-200">{{ timeline.distanceText }}</dd>
        </div>
        <div
          v-if="timeline.fuelBurnText && timeline.fuelBurnText !== '--'"
          class="flex items-baseline gap-1.5 border-l border-surface-200/70 pl-2"
          title="Estimated fuel burn"
        >
          <dt class="text-[9px] uppercase tracking-wider text-gray-500">Fuel burn</dt>
          <dd class="font-semibold text-gray-400">{{ timeline.fuelBurnText }}</dd>
        </div>
      </dl>
    </div>

    <button
      v-if="timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId"
      id="timeline-open-analysis-rescore-btn"
      type="button"
      class="flex shrink-0 items-center gap-1.5 self-stretch border-l border-surface-200/70 px-3 text-[10px] font-semibold text-gray-400 transition-colors hover:bg-surface-200/40 hover:text-gray-200 sm:px-4"
      aria-haspopup="dialog"
      :aria-expanded="timeline.analysisRescoreModalOpen ? 'true' : 'false'"
      @click="timeline.openAnalysisRescoreModal()"
    >
      <span>{{ analysisActionText }}</span>
      <span
        v-if="timeline.analysisRescore.applied"
        id="timeline-analysis-rescore-applied-badge"
        class="h-1.5 w-1.5 rounded-full bg-emerald-400"
        aria-label="Current scoring is saved"
      ></span>
      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" />
      </svg>
    </button>
  </div>
</template>
