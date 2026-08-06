<script setup>
import { computed } from 'vue';
import { resolveAircraftSpecificTemplate } from '../aircraft-specific/template-registry.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import AircraftSpecificSection from './aircraft-specific/AircraftSpecificSection.vue';
import AutopilotControlsTab from './AutopilotControlsTab.vue';

const aircraftSpecific = useAircraftSpecificStore();

// A trusted profile template owns the Aircraft page even while its live data is
// awaiting, stale, or disconnected. Falling back based on transient source
// health would make the page jump between two unrelated control surfaces.
const hasResolvedAircraftTemplate = computed(() => Boolean(
  aircraftSpecific.hasTemplate
  && resolveAircraftSpecificTemplate(aircraftSpecific.templateId),
));
</script>

<template>
  <div
    class="aircraft-tab-shell"
    :data-aircraft-page-mode="hasResolvedAircraftTemplate ? 'specific' : 'generic'"
  >
    <AircraftSpecificSection v-if="hasResolvedAircraftTemplate" />
    <AutopilotControlsTab v-else />
  </div>
</template>
