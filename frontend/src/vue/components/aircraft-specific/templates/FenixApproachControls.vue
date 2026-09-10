<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAircraftControlsStore } from '../../../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../../stores/aircraft-specific.js';
import { freshAircraftValue } from '../../../../voice/state-queries.js';

const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
const now = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 500); });
onUnmounted(() => clearInterval(timer));
const current = computed(() => controls.aircraftCommandCatalogue.profileKey === specific.activeProfileKey
  && controls.aircraftCommandCatalogue.profileRevision === specific.activeProfileRevision);
const read = (id) => current.value ? freshAircraftValue(specific, id, Math.max(now.value, Date.now())) : null;
const autobrake = () => {
  if (read('baro.healthy') !== true) return null;
  const modes = ['low', 'medium', 'max'], values = modes.map((mode) => read(`controls.autobrake.${mode}`));
  if (values.some((value) => typeof value !== 'boolean') || values.filter(Boolean).length > 1) return null;
  return modes.find((_, i) => values[i]) || 'off';
};
const groups = [
  { id: 'surfaces.flaps.set', label: 'Flaps', read: () => read('controls.flapsHandle') },
  { id: 'surfaces.autobrake.set', label: 'Autobrake', read: autobrake },
  { id: 'surfaces.spoilers.set', label: 'Speedbrake', read: () => {
    if (read('baro.healthy') !== true) return null;
    const position = read('controls.speedbrakePosition');
    return position === 0 ? 'armed' : position === 1 ? 'retracted' : position === 2 ? 'half' : position === 3 ? 'full'
      : typeof position === 'number' && position > 1 && position < 3 ? 'intermediate' : null;
  } },
];
const pending = (id) => controls.isCommandPending(`aircraft-command:${id}`);
const disabled = (group) => !controls.availability.enabled || !current.value || group.read() === null || !controls.isAircraftCommandSupported(group.id)
  || pending(group.id) || (group.id === 'surfaces.spoilers.set' && pending('surfaces.spoilersArmed.set'));
const label = (value) => value === 'retracted' ? 'RETRACT' : value.toUpperCase();
function send(group, value) {
  if (disabled(group) || !controls.getAircraftCommand(group.id)?.input.values.includes(value)) return;
  return controls.requestControlCommand({ type: 'canonical', commandId: group.id, input: { value } });
}
function arm(value) {
  if (disabled(groups[2]) || !controls.isAircraftCommandSupported('surfaces.spoilersArmed.set')) return;
  return controls.requestControlCommand({ type: 'canonical', commandId: 'surfaces.spoilersArmed.set', input: { value } });
}
</script>

<template>
  <section class="rounded-xl border border-surface-200 bg-surface-50 p-3 sm:p-4" data-fenix-approach-controls aria-label="Flaps, autobrake and speedbrake">
    <h3 class="text-sm font-semibold">Flaps, autobrake &amp; speedbrake</h3>
    <div class="mt-3 grid gap-4 lg:grid-cols-3">
      <fieldset v-for="group in groups" :key="group.id" class="min-w-0" :data-approach-command="group.id" :aria-busy="pending(group.id)">
        <legend class="mb-2 text-xs font-semibold">{{ group.label }} <span class="text-muted-fg">{{ group.read()?.toUpperCase() ?? '—' }}</span></legend>
        <div class="flex flex-wrap gap-2">
          <button v-for="value in (controls.getAircraftCommand(group.id)?.input.values || []).filter((value) => value !== 'disarm')" :key="value" type="button"
            :aria-label="`${group.label} ${label(value)}`" :aria-pressed="group.read() === value" :disabled="disabled(group)"
            class="min-h-10 rounded-md border border-surface-300 px-3 text-xs disabled:opacity-40"
            :class="{ 'bg-emerald-500/15 text-emerald-300': group.read() === value }" @click="send(group, value)">{{ label(value) }}</button>
        </div>
        <div v-if="group.id === 'surfaces.spoilers.set'" class="mt-2 flex flex-wrap gap-2">
          <button v-for="value in [true, false]" :key="String(value)" type="button" :disabled="disabled(group) || !controls.isAircraftCommandSupported('surfaces.spoilersArmed.set')"
            :aria-label="value ? 'Arm ground spoilers' : 'Disarm ground spoilers'" class="min-h-10 rounded-md border border-surface-300 px-3 text-xs disabled:opacity-40" @click="arm(value)">{{ value ? 'ARM' : 'DISARM' }}</button>
        </div>
      </fieldset>
    </div>
    <p class="mt-3 text-xs text-muted-fg">Selections confirm the lever or armed mode. Surfaces may still be moving.</p>
  </section>
</template>
