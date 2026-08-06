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
    template-id="workingtitle-747-8"
    title="Microsoft / Asobo Studio Boeing 747-8i / 747-8F"
    subtitle="Included MSFS 2024 Standard aircraft with Working Title avionics."
    guidance-label="Mode Control Panel"
    guidance-prefix="mcp"
    :mode-indicators="modes"
    :engine-n1="true"
    :engine-count="4"
    gear-note="The standard simulator exposes center, left, and right gear mirrors here; these are not a complete synoptic of the 747-8 body and wing main-gear bogies."
    :values="props.values"
    :unavailable="props.unavailable"
    :source-status="props.sourceStatus"
  />
</template>
