<script setup>
import { computed } from 'vue';
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();

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
      value: [tdzDistance?.value, tdzGrade?.value].filter(Boolean).join(' · '),
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
    id="timeline-detail"
    class="border-t border-surface-200 p-3 sm:p-4 bg-surface-50"
  >
    <div class="flex items-start gap-3 sm:gap-4">
      <div class="flex-1">
        <div id="timeline-detail-type" class="text-xs text-gray-500 uppercase tracking-wider mb-1">{{ timeline.detailType }}</div>
        <div id="timeline-detail-title" class="font-semibold mb-2">{{ timeline.detailTitle }}</div>
        <div id="timeline-detail-metrics" class="space-y-4">
          <template v-if="isLandingDetail">
            <dl v-if="landingEssentialRows.length > 0" class="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
              class="space-y-2"
            >
              <div
                v-if="section.title"
                class="text-[10px] font-semibold uppercase tracking-wider text-accent"
              >
                {{ section.title }}
              </div>
              <dl v-if="section.rows.length > 0" class="space-y-1">
                <div
                  v-for="row in section.rows"
                  :key="row.key"
                  class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                >
                  <dt class="text-gray-500">{{ row.label }}:</dt>
                  <dd :class="row.valueClass || 'text-gray-300 font-mono'">{{ row.value }}</dd>
                </div>
              </dl>
              <div v-else-if="section.emptyText" class="text-xs text-gray-500">{{ section.emptyText }}</div>
              <p v-if="section.noteText" class="text-xs text-gray-400 italic leading-snug">{{ section.noteText }}</p>
            </section>
          </template>
          <div v-else class="text-xs text-gray-500">No metrics</div>
        </div>
        <div
          v-if="!isLandingDetail && timeline.detailApproachProfileHtml"
          id="timeline-approach-profile"
          class="mt-3 rounded-lg overflow-hidden"
          v-html="timeline.detailApproachProfileHtml"
        />
        <div
          v-if="!isLandingDetail && timeline.detailTopdownProfileHtml"
          id="timeline-topdown-profile"
          class="mt-3 rounded-lg overflow-hidden"
          v-html="timeline.detailTopdownProfileHtml"
        />
        <button
          v-if="timeline.detailLandingActionVisible"
          id="timeline-open-landing-btn"
          type="button"
          class="timeline-detail-action mt-3 px-3 py-1.5 text-xs font-semibold rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
          @click="timeline.openSelectedLanding()"
        >
          Open Landing Debrief
        </button>
      </div>
    </div>
  </div>
</template>
