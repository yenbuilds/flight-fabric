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
    class="timeline-summary-container min-w-0 border-b border-surface-200 bg-surface-50"
  >
    <div class="timeline-summary-layout min-w-0">
      <div class="min-w-0 px-3 py-3 sm:px-4">
        <dl class="timeline-summary-stats grid min-w-0 gap-2">
          <div class="min-w-0 rounded-md border border-surface-200/70 bg-surface-100/50 px-2.5 py-2">
            <dt class="text-[11px] uppercase tracking-wider text-gray-500">Events</dt>
            <dd class="mt-0.5 break-words text-sm font-semibold leading-5 text-gray-200">{{ timeline.eventCountText }}</dd>
          </div>
          <div class="min-w-0 rounded-md border border-surface-200/70 bg-surface-100/50 px-2.5 py-2">
            <dt class="text-[11px] uppercase tracking-wider text-gray-500">Violations</dt>
            <dd class="mt-0.5 break-words text-sm font-semibold leading-5 text-amber-400">{{ timeline.violationCountText }}</dd>
          </div>
          <div class="min-w-0 rounded-md border border-surface-200/70 bg-surface-100/50 px-2.5 py-2">
            <dt class="text-[11px] uppercase tracking-wider text-gray-500">Duration</dt>
            <dd class="mt-0.5 break-words text-sm font-semibold leading-5 text-gray-200">{{ timeline.durationText }}</dd>
          </div>
          <div class="min-w-0 rounded-md border border-surface-200/70 bg-surface-100/50 px-2.5 py-2">
            <dt class="text-[11px] uppercase tracking-wider text-gray-500">Distance</dt>
            <dd class="mt-0.5 break-words text-sm font-semibold leading-5 text-gray-200">{{ timeline.distanceText }}</dd>
          </div>
          <div
            v-if="timeline.fuelBurnText && timeline.fuelBurnText !== '--'"
            class="min-w-0 rounded-md border border-surface-200/70 bg-surface-100/50 px-2.5 py-2"
            title="Estimated fuel burn"
          >
            <dt class="text-[11px] uppercase tracking-wider text-gray-500">Fuel burn</dt>
            <dd class="mt-0.5 break-words text-sm font-semibold leading-5 text-gray-400">{{ timeline.fuelBurnText }}</dd>
          </div>
        </dl>
      </div>

      <button
        v-if="timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId"
        id="timeline-open-analysis-rescore-btn"
        type="button"
        class="timeline-summary-action flex items-center justify-center gap-2 border-l border-surface-200/70 px-4 py-3 text-xs font-semibold text-gray-300 transition-colors hover:bg-surface-200/40 hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        aria-haspopup="dialog"
        :aria-expanded="timeline.analysisRescoreModalOpen ? 'true' : 'false'"
        @click="timeline.openAnalysisRescoreModal()"
      >
        <span>{{ analysisActionText }}</span>
        <span
          v-if="timeline.analysisRescore.applied"
          id="timeline-analysis-rescore-applied-badge"
          class="h-2 w-2 rounded-full bg-emerald-400"
          aria-label="Current scoring is saved"
        ></span>
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.timeline-summary-container {
  container-type: inline-size;
}

.timeline-summary-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
}

.timeline-summary-stats {
  grid-template-columns: repeat(auto-fit, minmax(7.25rem, 1fr));
}

.timeline-summary-action {
  min-width: 9rem;
}

@container (max-width: 30rem) {
  .timeline-summary-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .timeline-summary-action {
    border-top-width: 1px;
    border-left-width: 0;
  }
}
</style>
