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
  { id: 'afds.navLockMirror', label: 'NAV (SIM)' },
  { id: 'afds.altitudeHold', label: 'ALT HLD' },
  { id: 'afds.verticalSpeed', label: 'V/S' },
  { id: 'afds.levelChange', label: 'FLCH' },
  { id: 'afds.approach', label: 'APP' },
];
</script>

<template>
  <StandardAircraftMonitoringPanel
    template-id="asobo-787"
    title="Microsoft / Asobo Studio Boeing 787-10 Dreamliner"
    subtitle="Included MSFS 2024 Premium Deluxe/Aviator aircraft with Working Title avionics."
    guidance-label="Mode Control Panel"
    guidance-prefix="mcp"
    :mode-indicators="modes"
    :engine-n1="true"
    :engine-count="2"
    :values="props.values"
    :unavailable="props.unavailable"
    :source-status="props.sourceStatus"
  />
</template>
