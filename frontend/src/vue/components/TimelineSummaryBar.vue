<script setup>
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();
</script>

<template>
  <div
    v-if="!timeline.timelineLoading && (timeline.summaryVisible || timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId)"
    class="timeline-summary-container min-w-0 border-b border-surface-200 bg-surface-50"
  >
    <div class="timeline-summary-layout min-w-0">
      <div v-if="timeline.summaryVisible" class="min-w-0 px-3 py-3 sm:px-4">
        <dl class="timeline-summary-stats grid min-w-0 gap-2" :class="{ 'has-fuel-burn': timeline.fuelBurnText && timeline.fuelBurnText !== '--' }">
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
              <span :class="timeline.cautionCountText === '0' ? 'text-gray-400' : 'text-amber-400'">Cautions: {{ timeline.cautionCountText }}</span>
              <span :class="timeline.violationCountText === '0' ? 'text-gray-400' : 'text-red-400'">Violations: {{ timeline.violationCountText }}</span>
            </dd>
          </div>
        </dl>
      </div>

      <details
        v-if="timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId"
        :key="timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId"
        class="timeline-flight-details"
      >
        <summary>
          Flight details
          <span
            v-if="timeline.analysisRescore.applied"
            id="timeline-analysis-rescore-applied-badge"
            class="text-xs font-normal text-accent"
            aria-label="Current scoring is saved"
            title="Current scoring is saved"
          >Scoring saved</span>
        </summary>
        <div class="timeline-flight-details-content">
          <slot name="details" />
          <button id="timeline-open-analysis-rescore-btn" type="button"
            class="ff-button-secondary text-xs"
            aria-haspopup="dialog" :aria-expanded="timeline.analysisRescoreModalOpen ? 'true' : 'false'"
            @click="timeline.openAnalysisRescoreModal()">Compare scoring rules…</button>
        </div>
      </details>
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

.timeline-summary-alerts dd span {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}

@container (min-width: 48rem) {
  .timeline-summary-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(11rem, 1.8fr);
  }

  .timeline-summary-stats.has-fuel-burn {
    grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(11rem, 1.8fr);
  }

  .timeline-summary-alerts {
    grid-column: auto;
    display: block;
  }

  .timeline-summary-alerts dd {
    margin-top: 0.125rem;
    gap: 0.15rem 0.65rem;
  }
}

.timeline-flight-details { min-width: 0; font-size: .8125rem; border-left: 1px solid rgb(var(--border) / .6); }
.timeline-flight-details > summary { min-height: 2.75rem; padding: .8rem 1rem; cursor: pointer; color: rgb(var(--foreground)); }
.timeline-flight-details > summary:focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: -3px; }
.timeline-flight-details > summary span { margin-left: .5rem; white-space: nowrap; }
.timeline-flight-details[open] { grid-column: 1 / -1; border-left: 0; border-top: 1px solid rgb(var(--border) / .6); }
.timeline-summary-layout:has(.timeline-flight-details[open]) { grid-template-columns: minmax(0, 1fr); }
.timeline-flight-details-content { display: grid; justify-items: start; gap: 1rem; max-height: min(35vh, 18rem); overflow-y: auto; overscroll-behavior: contain; padding: .25rem 1rem 1rem; }

@container (max-width: 40rem) {
  .timeline-summary-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .timeline-flight-details {
    border-top-width: 1px;
    border-left-width: 0;
  }
}

@container (max-width: 24rem) {
  .timeline-summary-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
