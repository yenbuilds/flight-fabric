<script setup>
import StandardAircraftMonitoringPanel from './StandardAircraftMonitoringPanel.vue';

const props = defineProps({
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
});

const modes = [
  { id: 'afds.apMaster', label: 'AP' },
  { id: 'afds.flightDirector', label: 'FD' },
  { id: 'afds.autothrottleArmed', label: 'A/T ARM' },
  { id: 'afds.autothrottleActive', label: 'A/T ACTIVE' },
  { id: 'afds.speed', label: 'SPEED' },
  { id: 'afds.headingSelect', label: 'HDG SEL' },
  { id: 'afds.lnav', label: 'LNAV' },
  { id: 'afds.altitudeHold', label: 'ALT HLD' },
  { id: 'afds.verticalSpeed', label: 'V/S' },
  { id: 'afds.levelChange', label: 'LVL CHG' },
  { id: 'afds.approach', label: 'APP' },
];
</script>

<template>
  <StandardAircraftMonitoringPanel
    template-id="microsoft-737-max-8"
    title="Microsoft / Asobo Studio Boeing 737 MAX 8"
    subtitle="Included MSFS 2024 first-party aircraft monitoring page."
    guidance-label="Mode Control Panel"
    guidance-prefix="mcp"
    :mode-indicators="modes"
    :engine-n1="true"
    :values="props.values"
    :unavailable="props.unavailable"
    :source-status="props.sourceStatus"
  />
</template>
