<script setup>
import { computed, ref } from 'vue';
import { resolveAircraftSpecificTemplate } from '../aircraft-specific/template-registry.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import AircraftPageSearch from './AircraftPageSearch.vue';
import AircraftSpecificSection from './aircraft-specific/AircraftSpecificSection.vue';
import AutopilotControlsTab from './AutopilotControlsTab.vue';

const aircraftSpecific = useAircraftSpecificStore();
const searchableContent = ref(null);

// A trusted profile template owns the Aircraft page even while its live data is
// awaiting, stale, or disconnected. Falling back based on transient source
// health would make the page jump between two unrelated control surfaces.
const hasResolvedAircraftTemplate = computed(() => Boolean(
  aircraftSpecific.hasTemplate
  && resolveAircraftSpecificTemplate(aircraftSpecific.templateId),
));
const usesPmdg737MobileRibbon = computed(() => (
  hasResolvedAircraftTemplate.value && aircraftSpecific.templateId === 'pmdg-737'
));
</script>

<template>
  <div
    class="aircraft-tab-shell"
    :data-aircraft-page-mode="hasResolvedAircraftTemplate ? 'specific' : 'generic'"
    :data-mobile-aircraft-navigation="usesPmdg737MobileRibbon ? 'section-ribbon' : 'search'"
  >
    <AircraftPageSearch
      :target="searchableContent"
      :content-key="`${hasResolvedAircraftTemplate ? 'specific' : 'generic'}:${aircraftSpecific.activeProfileKey || aircraftSpecific.templateId || ''}`"
      :hide-on-mobile="usesPmdg737MobileRibbon"
    />
    <div ref="searchableContent" class="aircraft-tab-search-content">
      <AircraftSpecificSection v-if="hasResolvedAircraftTemplate" />
      <AutopilotControlsTab v-else />
    </div>
  </div>
</template>
