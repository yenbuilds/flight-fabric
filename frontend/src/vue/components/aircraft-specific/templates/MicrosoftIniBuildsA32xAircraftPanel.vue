<script setup>
import { computed } from 'vue';
import StandardAircraftMonitoringPanel from './StandardAircraftMonitoringPanel.vue';

const props = defineProps({
  profileKey: { type: String, default: '' },
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
  sourceStatuses: { type: Object, default: () => ({}) },
  actionCapabilities: { type: Object, default: () => ({}) },
  requestAction: { type: Function, default: () => false },
  isActionPending: { type: Function, default: () => false },
});

const title = computed(() => (
  props.profileKey.endsWith('/inibuilds-a321lr')
    ? 'Microsoft / iniBuilds Airbus A321LR'
    : 'Microsoft / iniBuilds Airbus A320neo V2'
));

const modes = [
  { id: 'flightGuidance.apMaster', label: 'AP' },
  { id: 'flightGuidance.flightDirector', label: 'FD' },
  { id: 'flightGuidance.autothrottleArmed', label: 'A/THR ARM' },
  { id: 'flightGuidance.autothrottleActive', label: 'A/THR ACTIVE' },
  { id: 'flightGuidance.speedHold', label: 'SPD' },
  { id: 'flightGuidance.headingHold', label: 'HDG' },
  { id: 'flightGuidance.navHold', label: 'NAV' },
  { id: 'flightGuidance.altitudeHold', label: 'ALT' },
  { id: 'flightGuidance.verticalSpeedHold', label: 'V/S' },
  { id: 'flightGuidance.flightLevelChange', label: 'FLC' },
  { id: 'flightGuidance.approachHold', label: 'APPR' },
];
</script>

<template>
  <StandardAircraftMonitoringPanel
    template-id="microsoft-inibuilds-a32x"
    :title="title"
    subtitle="Included MSFS 2024 first-party aircraft monitoring page."
    guidance-label="Flight Control Unit"
    guidance-prefix="fcu"
    :mode-indicators="modes"
    :engine-n1="true"
    :values="props.values"
    :unavailable="props.unavailable"
    :source-status="props.sourceStatus"
  />
</template>
