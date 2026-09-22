<script setup>
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();
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
          <div class="timeline-summary-alerts">
            <dt class="text-[11px] uppercase tracking-wider text-gray-500">Alerts</dt>
            <dd class="text-xs font-semibold leading-5">
              <span class="text-amber-400">Cautions: {{ timeline.cautionCountText }}</span>
              <span :class="timeline.violationCountText === '0' ? 'text-gray-400' : 'text-red-400'">Violations: {{ timeline.violationCountText }}</span>
            </dd>
          </div>
        </dl>
      </div>

      <button
        v-if="timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId"
        id="timeline-open-analysis-rescore-btn"
        type="button"
        class="timeline-summary-action flex flex-wrap items-center justify-center gap-2 border-l border-surface-200/70 px-4 py-3 text-xs font-semibold text-gray-300 transition-colors hover:bg-surface-200/40 hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        aria-haspopup="dialog"
        :aria-expanded="timeline.analysisRescoreModalOpen ? 'true' : 'false'"
        @click="timeline.openAnalysisRescoreModal()"
      >
        <span>Compare scoring rules…</span>
        <span
          v-if="timeline.analysisRescore.applied"
          id="timeline-analysis-rescore-applied-badge"
          class="text-[10px] font-normal text-accent"
          aria-label="Current scoring is saved"
          title="Current scoring is saved"
        >Saved</span>
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.6rem 1rem;
}

.timeline-summary-alerts {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
}

.timeline-summary-alerts dd {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 1rem;
}

.timeline-summary-action {
  min-width: 9rem;
}

@container (max-width: 40rem) {
  .timeline-summary-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .timeline-summary-action {
    border-top-width: 1px;
    border-left-width: 0;
    min-height: 2.75rem;
  }
}

@container (max-width: 24rem) {
  .timeline-summary-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
