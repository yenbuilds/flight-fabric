<script setup>
import { computed } from 'vue';
import { useFlightStore } from '../stores/flight.js';
import { useTabsStore } from '../stores/tabs.js';

const flight = useFlightStore();
const tabs = useTabsStore();

const gradeStyle = computed(() => ({
  color: flight.lastLanding.color || '#4a5e74',
}));
</script>

<template>
  <div
    id="data-last-landing-card"
    class="flight-summary-card ff-panel bg-surface-100 border border-surface-200 overflow-hidden"
  >
    <div class="p-3 sm:p-4 border-b border-surface-200 flex items-center justify-between gap-3">
      <div>
        <div class="ff-kicker">Last Landing</div>
        <div id="data-last-landing-status" class="text-xs text-muted-fg mt-0.5">{{ flight.lastLanding.status }}</div>
      </div>
      <button
        id="data-open-landing-btn"
        type="button"
        class="ff-button-secondary flight-summary-action px-3 py-2 text-xs font-medium rounded transition-colors"
        @click="tabs.requestTabChange('landing')"
      >
        Full Report
      </button>
    </div>
    <div class="flex flex-col sm:flex-row sm:items-center gap-0 sm:gap-px divide-y sm:divide-y-0 sm:divide-x divide-surface-200">
      <div class="flex-none px-4 sm:px-6 py-4 flex items-baseline gap-3">
        <div
          id="data-last-landing-grade"
          class="text-4xl sm:text-5xl font-bold tabular"
          style="font-family:'B612 Mono',monospace;letter-spacing:0.06em;"
          :style="gradeStyle"
        >
          {{ flight.lastLanding.grade }}
        </div>
      </div>
      <div class="flex-1 grid grid-cols-3 divide-x divide-surface-200">
        <div class="px-4 py-3">
          <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">V/S</div>
          <div id="data-last-landing-vs" class="text-base font-semibold tabular text-gray-200" style="font-family:'B612 Mono',monospace;">{{ flight.lastLanding.vs }}</div>
        </div>
        <div class="px-4 py-3">
          <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Runway</div>
          <div id="data-last-landing-runway" class="text-base font-semibold tabular text-gray-200" style="font-family:'B612 Mono',monospace;">{{ flight.lastLanding.runway }}</div>
        </div>
        <div class="px-4 py-3">
          <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Stability</div>
          <div id="data-last-landing-stability" class="text-base font-semibold tabular text-gray-200" style="font-family:'B612 Mono',monospace;">{{ flight.lastLanding.stability }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
