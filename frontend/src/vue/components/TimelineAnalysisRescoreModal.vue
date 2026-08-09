<script setup>
import {
  computed,
  nextTick,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();
const mounted = ref(false);
const closeButton = ref(null);
let returnFocus = null;

onMounted(() => {
  mounted.value = true;
});

watch(
  () => timeline.analysisRescoreModalOpen,
  async (isOpen) => {
    if (typeof document === 'undefined') return;
    if (isOpen) {
      returnFocus = document.activeElement;
      await nextTick();
      closeButton.value?.focus?.();
      return;
    }
    await nextTick();
    if (returnFocus?.isConnected) returnFocus.focus?.();
    returnFocus = null;
  },
);

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
  if (timeline.analysisRescoreStatus === 'applying') return 'Saving all current flight-analysis scoring...';
  if (timeline.analysisRescoreStatus === 'reverting') return 'Restoring all recorded flight-analysis scoring...';
  if (timeline.analysisRescoreStatus === 'refreshing') return 'Refreshing Timeline and Logbook...';
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
  <Teleport to="body" :disabled="!mounted">
    <div
      v-if="timeline.analysisRescoreModalOpen"
      id="timeline-analysis-rescore-modal"
      class="timeline-analysis-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="timeline-analysis-rescore-title"
      @click.self="timeline.closeAnalysisRescoreModal()"
    >
      <section class="timeline-analysis-modal-shell">
        <header class="timeline-analysis-modal-header">
          <div class="min-w-0">
            <div class="timeline-analysis-modal-kicker">Timeline analysis</div>
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <h2 id="timeline-analysis-rescore-title" class="timeline-analysis-modal-title">Review current scoring</h2>
              <span
                v-if="timeline.analysisRescore.applied"
                id="timeline-analysis-rescore-applied-status"
                class="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-300"
              >
                Saved<span v-if="appliedAtText"> - {{ appliedAtText }}</span>
              </span>
            </div>
            <div class="mt-0.5 truncate text-[11px] text-gray-500">{{ timeline.loadedTimelineFlightLabel }}</div>
          </div>
          <button
            ref="closeButton"
            id="timeline-analysis-rescore-close"
            type="button"
            class="timeline-analysis-modal-close"
            aria-label="Close scoring review"
            @click="timeline.closeAnalysisRescoreModal()"
          >
            Close
          </button>
        </header>

        <div id="timeline-analysis-rescore-content" class="timeline-analysis-modal-content">
          <div class="flex flex-wrap items-start justify-between gap-3 border-b border-surface-200/60 pb-4">
            <p class="max-w-3xl text-xs leading-relaxed text-gray-400">
              Recalculates touchdown rate, approach stability, TDZ, lateral offset, bounce, and rollout scoring with today's rules and each landing's recorded aircraft profile. The original recording and recorded results remain unchanged.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <button
                id="timeline-preview-analysis-rescore-btn"
                type="button"
                class="rounded border border-accent/40 px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60"
                :disabled="!timeline.canRequestAnalysisRescorePreview"
                @click="timeline.requestAnalysisRescorePreview()"
              >
                {{ timeline.analysisRescorePreviewStatus === 'loading' ? 'Reviewing current scoring...' : 'Review current scoring' }}
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
            class="py-6 text-sm text-gray-400"
            role="status"
            aria-live="polite"
          >
            Recomputing the complete saved landing analysis from recorded telemetry...
          </p>

          <div
            v-else-if="previewReady && preview.available"
            id="timeline-analysis-rescore-preview-result"
            class="mt-4"
          >
            <p class="text-sm font-semibold" :class="preview.changedMetricCount > 0 ? 'text-amber-200' : 'text-gray-300'">
              {{ previewSummary }}
            </p>
            <div v-if="preview.groups.length" class="mt-3 space-y-3">
              <section
                v-for="group in preview.groups"
                :key="group.key"
                class="overflow-hidden rounded-lg border border-surface-200/70 bg-surface-100/25"
              >
                <div class="flex items-center justify-between gap-2 bg-surface-200/30 px-3 py-2">
                  <h3 class="truncate text-[11px] font-semibold uppercase tracking-wider text-gray-400">{{ group.label }}</h3>
                  <span v-if="!group.available" class="text-[10px] text-amber-300">Unavailable</span>
                </div>
                <div v-if="group.metrics.length" class="overflow-x-auto">
                  <div class="min-w-[32rem] divide-y divide-surface-200/60">
                    <div class="grid grid-cols-[minmax(10rem,1fr)_minmax(8rem,auto)_minmax(8rem,auto)] gap-3 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-gray-600">
                      <span>Result</span><span>Recorded</span><span>Current rules</span>
                    </div>
                    <div
                      v-for="metric in group.metrics"
                      :key="metric.key"
                      class="grid grid-cols-[minmax(10rem,1fr)_minmax(8rem,auto)_minmax(8rem,auto)] gap-3 px-3 py-2 text-xs"
                      :class="metric.changed ? 'bg-amber-400/5' : ''"
                    >
                      <span class="min-w-0 text-gray-400">{{ metric.label }}</span>
                      <span class="font-mono text-gray-300">{{ metric.recorded }}</span>
                      <span class="font-mono" :class="metric.changed ? 'font-semibold text-amber-200' : 'text-gray-300'">{{ metric.current }}</span>
                    </div>
                  </div>
                </div>
                <p v-else class="px-3 py-3 text-xs text-gray-500">No comparable scored results.</p>
              </section>
            </div>
            <div class="mt-4 flex flex-wrap items-center gap-3 border-t border-surface-200/60 pt-4">
              <button
                v-if="timeline.canApplyFlightAnalysisRescore"
                id="timeline-apply-analysis-rescore-btn"
                type="button"
                class="rounded bg-accent/20 px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/30"
                @click="timeline.applyCurrentFlightAnalysisRescore()"
              >
                Save all current scoring
              </button>
              <span v-else-if="preview.saveRequired === false" class="text-xs font-medium text-emerald-300">
                This exact current-rules analysis is already saved.
              </span>
              <span class="text-[11px] text-gray-500">Saved as one reversible flight-level analysis snapshot.</span>
            </div>
          </div>

          <p
            v-else-if="previewReady"
            id="timeline-analysis-rescore-preview-unavailable"
            class="py-4 text-xs leading-relaxed text-amber-300"
          >
            Current-rules rescore is unavailable. {{ previewUnavailableReason(preview.reason) }} No partial analysis was saved.
          </p>
          <p
            v-else-if="timeline.analysisRescorePreviewStatus === 'error'"
            id="timeline-analysis-rescore-preview-error"
            class="py-4 text-xs text-red-300"
          >
            {{ timeline.analysisRescorePreviewError }}
          </p>

          <p
            v-if="operationText"
            id="timeline-analysis-rescore-operation-progress"
            class="mt-3 text-xs text-gray-400"
            role="status"
            aria-live="polite"
          >
            {{ operationText }}
          </p>
          <p
            v-else-if="timeline.analysisRescoreMessage"
            id="timeline-analysis-rescore-message"
            class="mt-3 text-xs text-emerald-300"
            aria-live="polite"
          >
            {{ timeline.analysisRescoreMessage }} The original recording remains unchanged.
          </p>
          <p
            v-if="timeline.analysisRescoreStatus === 'error'"
            id="timeline-analysis-rescore-error"
            class="mt-3 text-xs text-red-300"
            role="alert"
          >
            {{ timeline.analysisRescoreError }}
          </p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
