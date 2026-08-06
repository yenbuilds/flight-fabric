<script setup>
import StandardAircraftMonitoringPanel from './StandardAircraftMonitoringPanel.vue';

const props = defineProps({
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
});

const modes = [
  { id: 'fcp.apMaster', label: 'AP' },
  { id: 'fcp.flightDirector', label: 'FD' },
  { id: 'fcp.autothrottleActive', label: 'A/THR' },
  { id: 'fcp.speedHold', label: 'SPD' },
  { id: 'fcp.lnav', label: 'NAV' },
  { id: 'fcp.headingSelect', label: 'HDG SEL' },
  { id: 'fcp.altitudeHold', label: 'ALT HLD' },
  { id: 'fcp.verticalSpeed', label: 'V/S' },
  { id: 'fcp.levelChange', label: 'LVL CHG' },
];
</script>

<template>
  <StandardAircraftMonitoringPanel
    template-id="inibuilds-a310"
    title="Microsoft / iniBuilds Airbus A310-300"
    subtitle="Included MSFS 2024 first-party aircraft monitoring page."
    guidance-label="Flight Control Panel"
    guidance-prefix="fcp"
    :mode-indicators="modes"
    :engine-n1="true"
    :values="props.values"
    :unavailable="props.unavailable"
    :source-status="props.sourceStatus"
  />
</template>
