<script setup>
import { useTimelineStore } from '../stores/timeline.js';

const timeline = useTimelineStore();
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
          <template v-if="timeline.detailMetricSections.length > 0">
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
          v-if="timeline.detailApproachProfileHtml"
          id="timeline-approach-profile"
          class="mt-3 rounded-lg overflow-hidden"
          v-html="timeline.detailApproachProfileHtml"
        />
        <div
          v-if="timeline.detailTopdownProfileHtml"
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
