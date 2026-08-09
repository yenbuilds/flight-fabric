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
    <div class="grid grid-cols-2 lg:grid-cols-6 divide-x divide-y lg:divide-y-0 divide-surface-200">
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Touchdown rate grade</div>
        <div
          id="data-last-landing-grade"
          class="text-base font-semibold tabular"
          style="font-family:'B612 Mono',monospace;letter-spacing:0.06em;"
          :style="gradeStyle"
        >
          {{ flight.lastLanding.grade }}
        </div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Approach</div>
        <div id="data-last-landing-stability" class="text-base font-semibold tabular" :class="flight.lastLanding.stabilityTone" style="font-family:'B612 Mono',monospace;">{{ flight.lastLanding.stability }}</div>
        <div v-if="flight.lastLanding.stabilityScore" id="data-last-landing-approach-score" class="mt-0.5 text-[10px] text-gray-500">{{ flight.lastLanding.stabilityScore }}</div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Bounce</div>
        <div id="data-last-landing-bounce" class="text-base font-semibold tabular" :class="flight.lastLanding.bounceTone" style="font-family:'B612 Mono',monospace;">{{ flight.lastLanding.bounce }}</div>
        <div v-if="flight.lastLanding.bounceDetail" class="mt-0.5 text-[10px] text-gray-500">{{ flight.lastLanding.bounceDetail }}</div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Touchdown rate</div>
        <div id="data-last-landing-vs" class="text-base font-semibold tabular text-gray-200" style="font-family:'B612 Mono',monospace;">{{ flight.lastLanding.vs }}</div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">TDZ</div>
        <div id="data-last-landing-tdz" class="text-base font-semibold tabular" :class="flight.lastLanding.tdzTone" style="font-family:'B612 Mono',monospace;">{{ flight.lastLanding.tdz }}</div>
        <div v-if="flight.lastLanding.tdzDetail" class="mt-0.5 text-[10px] text-gray-500">{{ flight.lastLanding.tdzDetail }}</div>
      </div>
      <div class="px-4 py-3">
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Runway</div>
        <div id="data-last-landing-runway" class="text-base font-semibold tabular text-gray-200" style="font-family:'B612 Mono',monospace;">{{ flight.lastLanding.runway }}</div>
      </div>
    </div>
  </div>
</template>
