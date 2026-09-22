<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { containDialogFocus } from '../../ui/dialog-focus.js';
import { useLandingStore } from '../stores/landing.js';
import { useTimelineStore } from '../stores/timeline.js';

const props = defineProps({ inline: { type: Boolean, default: false }, labelledBy: { type: String, default: 'timeline-detail-title' } });
const landing = useLandingStore();
const timeline = useTimelineStore();
const dialog = ref(null);
const closeButton = ref(null);
let returnFocus = null;

function handleKeydown(event) {
  if (event.defaultPrevented) return;
  if (landing.landingModalOpen || landing.stabilityMetricModal.open || timeline.analysisRescoreModalOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    timeline.clearDetail();
    return;
  }
  if (!props.inline) containDialogFocus(event, dialog.value);
}

watch(() => timeline.detailVisible, async (isOpen) => {
  if (props.inline || typeof document === 'undefined') return;
  if (isOpen) {
    returnFocus = document.activeElement;
    await nextTick();
    if (timeline.detailVisible) closeButton.value?.focus?.({ preventScroll: true });
    return;
  }
  const target = returnFocus;
  returnFocus = null;
  await nextTick();
  if (timeline.timelineMobileViewerOpen && target?.isConnected) target.focus?.({ preventScroll: true });
}, { immediate: true });

const isLandingDetail = computed(() => (
  timeline.selectedLandingEvent?.type === 'landing'
  || String(timeline.detailType || '').toLowerCase() === 'landing'
));

const landingEssentialRows = computed(() => {
  const rowsByKey = new Map();
  for (const section of timeline.detailMetricSections) {
    for (const row of section?.rows || []) rowsByKey.set(row.key, row);
  }

  const rows = [];
  const addRow = (key, label) => {
    const row = rowsByKey.get(key);
    if (row) rows.push({ ...row, label });
  };

  addRow('touchdown-grade', 'Touchdown Rate Grade');
  addRow('vs', 'Touchdown Rate');

  const tdzDistance = rowsByKey.get('distance');
  const tdzGrade = rowsByKey.get('grade');
  if (tdzDistance || tdzGrade) {
    rows.push({
      key: 'tdz-summary',
      label: 'TDZ',
      value: [tdzDistance?.value, tdzGrade?.value].filter(Boolean).join(' / '),
      valueClass: tdzGrade?.valueClass || tdzDistance?.valueClass || '',
    });
  }

  addRow('approach-verdict', 'Approach');
  addRow('bounce', 'Bounce');
  return rows;
});
</script>

<template>
  <div
    v-if="timeline.detailVisible"
    :class="inline ? 'timeline-event-detail' : 'timeline-detail-backdrop'"
    @click.self="!inline && timeline.clearDetail()"
  >
    <section
      ref="dialog"
      id="timeline-detail"
      :class="{ 'timeline-detail-drawer': !inline }"
      :role="inline ? 'region' : 'dialog'"
      :aria-modal="inline ? undefined : 'true'"
      :aria-labelledby="inline ? labelledBy : 'timeline-detail-title'"
      tabindex="-1"
      @keydown="handleKeydown"
    >
      <h3 v-if="inline" id="timeline-detail-title" class="sr-only">{{ timeline.detailTitle }}</h3>
      <header v-if="!inline" class="timeline-detail-drawer-header">
        <div class="min-w-0">
          <div id="timeline-detail-type" class="timeline-detail-drawer-kicker">{{ timeline.detailType }}</div>
          <h2 id="timeline-detail-title" class="timeline-detail-drawer-title">{{ timeline.detailTitle }}</h2>
        </div>
        <button
          ref="closeButton"
          id="timeline-detail-close"
          type="button"
          class="timeline-detail-drawer-close"
          aria-label="Close event details"
          @click="timeline.clearDetail()"
        >
          Close
        </button>
      </header>

      <div id="timeline-detail-content" :class="{ 'timeline-detail-drawer-content': !inline }">
        <div id="timeline-detail-metrics" class="space-y-4">
          <template v-if="isLandingDetail">
            <dl v-if="landingEssentialRows.length > 0" class="grid grid-cols-2 gap-2">
              <div
                v-for="row in landingEssentialRows"
                :key="row.key"
                class="min-w-0 rounded-md border border-surface-200/60 bg-surface-100/40 px-2.5 py-2"
              >
                <dt class="text-[9px] font-semibold uppercase tracking-wider text-gray-600">{{ row.label }}</dt>
                <dd class="mt-0.5 text-xs leading-snug" :class="row.valueClass || 'font-mono text-gray-300'">{{ row.value }}</dd>
              </div>
            </dl>
            <div v-else class="text-xs text-gray-500">No landing summary available</div>
          </template>
          <template v-else-if="timeline.detailMetricSections.length > 0">
            <section
              v-for="section in timeline.detailMetricSections"
              :key="section.key"
              class="rounded-lg border border-surface-200/60 bg-surface-100/25 p-3"
            >
              <div
                v-if="section.title"
                class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent"
              >
                {{ section.title }}
              </div>
              <dl v-if="section.rows.length > 0" class="space-y-1.5">
                <div
                  v-for="row in section.rows"
                  :key="row.key"
                  :class="inline ? 'timeline-event-metric' : 'grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 text-xs'"
                >
                  <dt class="text-gray-500">{{ row.label }}</dt>
                  <dd class="min-w-0 break-words" :class="row.valueClass || 'text-gray-300 font-mono'">{{ row.value }}</dd>
                </div>
              </dl>
              <div v-else-if="section.emptyText" class="text-xs text-gray-500">{{ section.emptyText }}</div>
              <p v-if="section.noteText" class="mt-2 text-xs italic leading-snug text-gray-400">{{ section.noteText }}</p>
            </section>
        </template>
        <div v-else class="text-xs text-gray-500">No additional measurements were recorded for this event.</div>
      </div>

      <div
        v-if="!isLandingDetail && timeline.detailApproachProfileHtml"
        id="timeline-approach-profile"
        class="mt-4 overflow-hidden rounded-lg"
        v-html="timeline.detailApproachProfileHtml"
      />
      <div
        v-if="!isLandingDetail && timeline.detailTopdownProfileHtml"
        id="timeline-topdown-profile"
        class="mt-4 overflow-hidden rounded-lg"
        v-html="timeline.detailTopdownProfileHtml"
      />
      <button
        v-if="timeline.detailLandingActionVisible"
        id="timeline-open-landing-btn"
        type="button"
        class="timeline-detail-action mt-4 rounded bg-accent/20 px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/30"
        @click="timeline.openSelectedLanding()"
      >
        Open Landing Debrief
      </button>
    </div>
    <button v-if="inline" id="timeline-detail-close" type="button" class="timeline-event-collapse ff-button-secondary" @click="timeline.clearDetail()">Hide details</button>
  </section>
  </div>
</template>
