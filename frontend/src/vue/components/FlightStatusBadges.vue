<script setup>
import { computed } from 'vue';
import { useStatusStore } from '../stores/status.js';

const props = defineProps({
  mode: {
    type: String,
    default: 'header',
    validator: (value) => ['header', 'mobile', 'footer'].includes(value),
  },
});

const status = useStatusStore();
const showPhase = computed(() => props.mode !== 'footer');
const showSim = computed(() => props.mode !== 'mobile');
const phaseVisible = computed(() => showPhase.value && status.phaseVisible);
const phaseId = computed(() => (props.mode === 'mobile' ? 'phase-badge-mobile' : 'phase-badge'));
const simId = computed(() => (props.mode === 'footer' ? 'menu-state-bottom' : 'menu-state-top'));
const simClass = computed(() => [
  props.mode === 'footer'
    ? 'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em]'
    : 'ff-status-chip',
  status.simToneClass,
].join(' '));
</script>

<template>
  <span
    v-if="phaseVisible"
    :id="phaseId"
    class="ff-status-chip-primary"
  >
    {{ status.phaseLabel }}
  </span>

  <span
    v-if="showSim"
    :id="simId"
    :class="simClass"
  >
    {{ status.simLabel }}
  </span>
</template>
