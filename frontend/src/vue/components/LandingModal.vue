<script setup>
import { computed } from 'vue';
import LandingPanel from './LandingPanel.vue';
import { useLandingStore } from '../stores/landing.js';
import { useTimelineStore } from '../stores/timeline.js';

const landing = useLandingStore();
const timeline = useTimelineStore();

const RECORDED_CONTEXT_ROWS = {
  'landing-snapshot': {
    title: 'Touchdown Record',
    keys: ['heading', 'position', 'runway'],
  },
  'touchdown-zone-analysis': {
    title: 'Touchdown Zone',
    keys: ['score', 'remaining'],
  },
  'rollout-analysis': {
    title: 'Rollout',
    keys: ['samples'],
  },
  'retrospective-stability': {
    title: 'Approach',
    keys: ['gate-failures'],
  },
};

const recordedContextSections = computed(() => {
  if (!timeline.detailVisible || timeline.selectedLandingEvent?.type !== 'landing') return [];

  return timeline.detailMetricSections.flatMap((section) => {
    const config = RECORDED_CONTEXT_ROWS[section?.key];
    if (!config) return [];
    const allowedKeys = new Set(config.keys);
    const rows = (section.rows || []).filter((row) => allowedKeys.has(row.key));
    return rows.length > 0 ? [{ key: section.key, title: config.title, rows }] : [];
  });
});
</script>

<template>
  <div
    v-if="landing.landingModalOpen"
    id="landing-modal"
    class="landing-modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="landing-modal-title"
    @click.self="landing.closeLandingModal()"
  >
    <section class="landing-modal-shell">
      <header class="landing-modal-header">
        <div class="min-w-0">
          <div class="landing-modal-kicker">Landing Debrief</div>
          <div id="landing-modal-title" class="landing-modal-title">
            {{ landing.landingCard.airportText !== '--' ? landing.landingCard.airportText : 'Recorded landing' }}
            <span v-if="landing.landingCard.runwayText !== '--'" class="landing-modal-runway">{{ landing.landingCard.runwayText }}</span>
          </div>
        </div>
        <button
          id="landing-modal-close"
          type="button"
          class="landing-modal-close"
          aria-label="Close landing debrief"
          @click="landing.closeLandingModal()"
        >
          Close
        </button>
      </header>

      <div v-if="landing.landingModalLoading" id="landing-modal-loading" class="landing-modal-state" role="status">
        Loading landing details...
      </div>
      <div v-else-if="landing.landingModalError" id="landing-modal-error" class="landing-modal-state landing-modal-error" role="alert">
        {{ landing.landingModalError }}
      </div>
      <div v-else class="landing-modal-content">
        <LandingPanel debrief-mode />
        <details
          v-if="recordedContextSections.length > 0"
          id="landing-modal-recorded-context"
          class="border-t border-surface-200/60 bg-surface-50/30"
        >
          <summary class="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-400 hover:bg-surface-200/30">
            <span>Recorded Context</span>
            <span class="ml-2 text-[10px] font-normal uppercase tracking-wider text-gray-600">Additional saved-event data</span>
          </summary>
          <div class="grid gap-3 border-t border-surface-200/40 px-4 py-4 sm:grid-cols-2">
            <section
              v-for="section in recordedContextSections"
              :key="section.key"
              class="rounded-lg border border-surface-200/60 bg-surface-100/35 p-3"
            >
              <div class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">{{ section.title }}</div>
              <dl class="space-y-1.5">
                <div
                  v-for="row in section.rows"
                  :key="row.key"
                  class="flex items-start justify-between gap-3 text-xs"
                >
                  <dt class="text-gray-500">{{ row.label }}</dt>
                  <dd class="text-right" :class="row.valueClass || 'font-mono text-gray-300'">{{ row.value }}</dd>
                </div>
              </dl>
            </section>
          </div>
        </details>
      </div>
    </section>
  </div>
</template>
