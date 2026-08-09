<script setup>
import { computed } from 'vue';
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();

const preview = computed(() => timeline.analysisRescorePreview || null);
const previewReady = computed(() => (
  timeline.analysisRescorePreviewStatus === 'ready' && preview.value
));
const previewSummary = computed(() => {
  if (!previewReady.value?.available) return '';
  const changes = Number(previewReady.value.changedMetricCount) || 0;
  const landings = Number(previewReady.value.landingCount) || previewReady.value.groups?.length || 0;
  if (changes === 0) {
    return `Current rules produce the same saved scoring across ${landings} landing${landings === 1 ? '' : 's'}.`;
  }
  return `${changes} scoring result${changes === 1 ? '' : 's'} change across ${landings} landing${landings === 1 ? '' : 's'}.`;
});
const operationText = computed(() => {
  if (timeline.analysisRescoreStatus === 'applying') return 'Saving all current flight-analysis scoring…';
  if (timeline.analysisRescoreStatus === 'reverting') return 'Restoring all recorded flight-analysis scoring…';
  if (timeline.analysisRescoreStatus === 'refreshing') return 'Refreshing Timeline and Logbook…';
  return '';
});
const appliedAtText = computed(() => {
  const value = timeline.analysisRescore?.appliedAt;
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
});

function previewUnavailableReason(value) {
  const reason = String(value || '').trim();
  if (!reason) return 'A complete current-rules analysis could not be reconstructed safely.';
  return reason.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
</script>

<template>
  <div
    v-if="timeline.summaryVisible"
    class="border-b border-surface-200 bg-surface-50"
  >
    <div class="overflow-x-auto px-3 py-2 sm:px-4">
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

    <details
      v-if="timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId"
      :key="timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId"
      id="timeline-analysis-rescore"
      class="group border-t border-surface-200/70"
      aria-labelledby="timeline-analysis-rescore-title"
    >
      <summary
        id="timeline-analysis-rescore-toggle"
        class="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 sm:px-4 [&::-webkit-details-marker]:hidden"
      >
        <span class="flex min-w-0 flex-wrap items-center gap-2">
          <span id="timeline-analysis-rescore-title" class="text-xs font-semibold text-gray-300">All landing analysis</span>
          <span
            v-if="timeline.analysisRescore.applied"
            id="timeline-analysis-rescore-applied-badge"
            class="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-300"
          >
            Current scoring saved<span v-if="appliedAtText"> · {{ appliedAtText }}</span>
          </span>
        </span>
        <span class="flex shrink-0 items-center gap-1.5 text-[10px] font-medium text-gray-500">
          <span class="hidden sm:inline">Review current rules</span>
          <svg
            class="h-3.5 w-3.5 transition-transform group-open:rotate-180"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </summary>

      <div id="timeline-analysis-rescore-content" class="px-3 pb-3 sm:px-4">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <p class="max-w-3xl text-[11px] leading-snug text-gray-500">
            Recalculates touchdown-rate, approach stability, TDZ, lateral-offset, bounce, and rollout scoring with today’s rules and each landing’s recorded aircraft profile. The original recording and recorded results remain unchanged.
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <button
              id="timeline-preview-analysis-rescore-btn"
              type="button"
              class="rounded border border-accent/40 px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60"
              :disabled="!timeline.canRequestAnalysisRescorePreview"
              @click="timeline.requestAnalysisRescorePreview()"
            >
              {{ timeline.analysisRescorePreviewStatus === 'loading' ? 'Reviewing current scoring…' : 'Review current scoring' }}
            </button>
            <button
              v-if="timeline.analysisRescore.applied"
              id="timeline-revert-analysis-rescore-btn"
              type="button"
              class="rounded border border-surface-300 px-3 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:bg-surface-200/50 disabled:cursor-wait disabled:opacity-60"
              :disabled="!timeline.canRevertFlightAnalysisRescore"
              @click="timeline.revertFlightAnalysisRescore()"
            >
              Restore all recorded scoring
            </button>
          </div>
        </div>

      <p
        v-if="timeline.analysisRescorePreviewStatus === 'loading'"
        id="timeline-analysis-rescore-preview-progress"
        class="mt-2 text-[11px] text-gray-400"
        role="status"
        aria-live="polite"
      >
        Recomputing the complete saved landing analysis from recorded telemetry…
      </p>

      <div
        v-else-if="previewReady && preview.available"
        id="timeline-analysis-rescore-preview-result"
        class="mt-3 rounded-md border border-surface-200/70 bg-surface-100/40 p-3"
      >
        <p class="text-xs font-medium" :class="preview.changedMetricCount > 0 ? 'text-amber-200' : 'text-gray-300'">
          {{ previewSummary }}
        </p>
        <div v-if="preview.groups.length" class="mt-2 space-y-2">
          <section
            v-for="group in preview.groups"
            :key="group.key"
            class="overflow-hidden rounded border border-surface-200/70"
          >
            <div class="flex items-center justify-between gap-2 bg-surface-200/30 px-2.5 py-1.5">
              <h4 class="truncate text-[10px] font-semibold uppercase tracking-wider text-gray-400">{{ group.label }}</h4>
              <span v-if="!group.available" class="text-[10px] text-amber-300">Unavailable</span>
            </div>
            <div v-if="group.metrics.length" class="divide-y divide-surface-200/60">
              <div class="grid grid-cols-[minmax(0,1fr)_minmax(5rem,auto)_minmax(5rem,auto)] gap-2 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wider text-gray-600">
                <span>Result</span><span>Recorded</span><span>Current rules</span>
              </div>
              <div
                v-for="metric in group.metrics"
                :key="metric.key"
                class="grid grid-cols-[minmax(0,1fr)_minmax(5rem,auto)_minmax(5rem,auto)] gap-2 px-2.5 py-1.5 text-[11px]"
                :class="metric.changed ? 'bg-amber-400/5' : ''"
              >
                <span class="min-w-0 truncate text-gray-400">{{ metric.label }}</span>
                <span class="font-mono text-gray-300">{{ metric.recorded }}</span>
                <span class="font-mono" :class="metric.changed ? 'font-semibold text-amber-200' : 'text-gray-300'">{{ metric.current }}</span>
              </div>
            </div>
            <p v-else class="px-2.5 py-2 text-[11px] text-gray-500">No comparable scored results.</p>
          </section>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            v-if="timeline.canApplyFlightAnalysisRescore"
            id="timeline-apply-analysis-rescore-btn"
            type="button"
            class="rounded bg-accent/20 px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/30"
            @click="timeline.applyCurrentFlightAnalysisRescore()"
          >
            Save all current scoring
          </button>
          <span v-else-if="preview.saveRequired === false" class="text-[10px] font-medium text-emerald-300">
            This exact current-rules analysis is already saved.
          </span>
          <span class="text-[10px] text-gray-500">Saved as one reversible flight-level analysis snapshot.</span>
        </div>
      </div>

      <p
        v-else-if="previewReady"
        id="timeline-analysis-rescore-preview-unavailable"
        class="mt-2 text-[11px] leading-snug text-amber-300"
      >
        Current-rules rescore is unavailable. {{ previewUnavailableReason(preview.reason) }} No partial analysis was saved.
      </p>
      <p
        v-else-if="timeline.analysisRescorePreviewStatus === 'error'"
        id="timeline-analysis-rescore-preview-error"
        class="mt-2 text-[11px] text-red-300"
      >
        {{ timeline.analysisRescorePreviewError }}
      </p>

      <p
        v-if="operationText"
        id="timeline-analysis-rescore-operation-progress"
        class="mt-2 text-[11px] text-gray-400"
        role="status"
        aria-live="polite"
      >
        {{ operationText }}
      </p>
      <p
        v-else-if="timeline.analysisRescoreMessage"
        id="timeline-analysis-rescore-message"
        class="mt-2 text-[11px] text-emerald-300"
        aria-live="polite"
      >
        {{ timeline.analysisRescoreMessage }} The original recording remains unchanged.
      </p>
      <p
        v-if="timeline.analysisRescoreStatus === 'error'"
        id="timeline-analysis-rescore-error"
        class="mt-2 text-[11px] text-red-300"
        role="alert"
      >
        {{ timeline.analysisRescoreError }}
      </p>
      </div>
    </details>
  </div>
</template>
