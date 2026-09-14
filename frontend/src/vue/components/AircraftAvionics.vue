<script setup>
import { computed } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import ComRadios from './ComRadios.vue';
import BaroControls from './BaroControls.vue';
import TransponderControls from './TransponderControls.vue';
import MinimumsControls from './MinimumsControls.vue';
import EfisControls from './EfisControls.vue';

const controls = useAircraftControlsStore();
const supported = computed(() => ['radios.com1.setStandby', 'radios.com2.setStandby',
  'baro.both.qnhHpa', 'surveillance.squawk.set', 'surveillance.ident.activate',
  'approach.minimums.baro', 'navigation.captain.range', 'navigation.firstOfficer.range']
  .some(id => controls.isAircraftCommandSupported(id)));
</script>

<template>
  <section v-if="supported" id="aircraft-page-avionics" class="aircraft-avionics aircraft-mobile-navigable-section"
    tabindex="-1" aria-labelledby="aircraft-avionics-title" data-aircraft-avionics-section>
    <h2 id="aircraft-avionics-title" class="mb-3 text-base font-semibold text-gray-100">Radios &amp; approach</h2>
    <div class="aircraft-avionics-grid">
      <ComRadios id="aircraft-page-com" />
      <BaroControls id="aircraft-page-baro" />
      <TransponderControls id="aircraft-page-transponder" />
      <MinimumsControls id="aircraft-page-minimums" />
      <EfisControls id="aircraft-page-efis" />
    </div>
  </section>
</template>

<style scoped>
.aircraft-avionics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr));
  align-items: start;
  gap: 0.75rem;
}
</style>
