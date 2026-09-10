<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { parseComRadioFrequency } from '../../aircraft/com-radio.js';
import { freshAircraftValue } from '../../voice/state-queries.js';

const controls = useAircraftControlsStore();
const specific = useAircraftSpecificStore();
const drafts = ref({});
const sending = ref({});
const now = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 500); });
onUnmounted(() => clearInterval(timer));
const context = computed(() => `${controls.aircraftCommandCatalogue.profileKey}:${controls.aircraftCommandCatalogue.profileRevision}`);
const radios = computed(() => [1, 2].filter((index) => controls.isAircraftCommandSupported(`radios.com${index}.setStandby`)));
const fresh = computed(() => specific.available && specific.sourceStatus === 'connected'
  && specific.activeProfileKey === controls.aircraftCommandCatalogue.profileKey
  && specific.activeProfileRevision === controls.aircraftCommandCatalogue.profileRevision
  && Number.isFinite(Date.parse(specific.updatedAt)) && now.value - Date.parse(specific.updatedAt) <= 2000
  && now.value - Date.parse(specific.updatedAt) >= -1000);
watch(context, () => { drafts.value = {}; sending.value = {}; });
watch(() => controls.availability.enabled, () => { drafts.value = {}; });
watch(fresh, (value) => { if (!value) drafts.value = {}; });
function read(index, property) {
  const id = `radios.com${index}.${property}`;
  return fresh.value ? freshAircraftValue(specific, id, Math.max(now.value, Date.now())) : null;
}
const format = (value) => typeof value === 'number' ? value.toFixed(3) : '—';
const draft = (index) => drafts.value[index] ?? (read(index, 'standbyMhz') == null ? '' : format(read(index, 'standbyMhz')));
const target = (index) => parseComRadioFrequency(draft(index), read(index, 'spacingMode'));
const edited = (index) => Object.hasOwn(drafts.value, index) && target(index) !== read(index, 'standbyMhz');
const busy = (index) => sending.value[index] || ['setStandby', 'swap', 'switchTo'].some((op) => controls.isCommandPending(`aircraft-command:radios.com${index}.${op}`));
const ready = (index) => controls.availability.enabled && read(index, 'installed') === true && read(index, 'status') === 0
  && [0, 1].includes(read(index, 'spacingMode')) && read(index, 'activeMhz') != null && read(index, 'standbyMhz') != null;
watch(() => [ready(1), ready(2)], (states) => {
  states.forEach((isReady, offset) => { if (!isReady) delete drafts.value[offset + 1]; });
});
const disabled = (index, op) => !ready(index) || busy(index) || !controls.isAircraftCommandSupported(`radios.com${index}.${op}`)
  || (op === 'swap' ? edited(index) : target(index) == null);
async function send(index, operation) {
  if (disabled(index, operation)) return;
  const sentContext = context.value;
  sending.value[index] = true;
  try {
    await controls.requestControlCommand({ type: 'canonical', commandId: `radios.com${index}.${operation}`,
      input: operation === 'swap' ? {} : { value: target(index) } });
  } finally {
    if (sentContext === context.value) sending.value[index] = false;
  }
}
watch(() => specific.values, () => {
  for (const index of radios.value) {
    if (target(index) === read(index, 'standbyMhz')) delete drafts.value[index];
  }
});
</script>

<template>
  <section v-if="radios.length" class="com-radios ff-panel rounded-xl border border-surface-200 bg-surface-100 p-3 sm:p-4" aria-label="COM radios" data-com-radios>
    <h2 class="text-sm font-semibold text-gray-100">COM radios</h2>
    <p class="mt-1 text-xs text-muted-fg">Tune standby, swap, or switch directly to a confirmed channel.</p>
    <div class="mt-3 grid gap-3 md:grid-cols-2">
      <form v-for="index in radios" :key="`${context}:${index}`" class="min-w-0 rounded-lg border border-surface-200 bg-surface-50 p-3"
        :data-com-radio="index" :data-aircraft-search-label="`COM ${index} VHF frequency standby swap`" :aria-busy="Boolean(busy(index))"
        @submit.prevent="send(index, 'setStandby')">
        <h3 class="text-sm font-semibold">COM {{ index }}</h3>
        <div class="my-3 grid grid-cols-2 gap-2 text-xs text-muted-fg">
          <div>Active<output class="block font-mono text-xl text-emerald-200" :aria-label="`COM ${index} active frequency`">{{ format(read(index, 'activeMhz')) }}</output></div>
          <div>Standby<output class="block font-mono text-xl text-gray-100" :aria-label="`COM ${index} standby frequency`">{{ format(read(index, 'standbyMhz')) }}</output></div>
        </div>
        <label :for="`com-${index}-frequency`" class="block text-xs">New frequency (MHz)</label>
        <input :id="`com-${index}-frequency`" class="mt-1 min-h-12 w-full min-w-0 rounded-md border border-surface-200 bg-surface-100 px-3 font-mono text-base"
          type="text" inputmode="decimal" maxlength="7" placeholder="123.450" autocomplete="off" :value="draft(index)"
          :disabled="!ready(index) || Boolean(busy(index))" :aria-invalid="draft(index) !== '' && target(index) == null"
          :aria-describedby="`com-${index}-status`" @input="drafts[index] = $event.target.value" @focus="$event.target.select()" />
        <p :id="`com-${index}-status`" class="mt-2 min-h-8 text-xs text-muted-fg" role="status">
          {{ busy(index) ? 'Waiting for radio confirmation…' : !ready(index) ? 'Waiting for fresh, powered radio data.'
            : target(index) == null ? 'Enter a valid channel for this radio; frequencies are never rounded.'
              : `${read(index, 'spacingMode') === 0 ? '25' : '8.33'} kHz channel spacing · 118.000–136.990 MHz` }}
        </p>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <button type="submit" :disabled="disabled(index, 'setStandby')" :aria-label="`Set COM ${index} standby frequency`">Set standby</button>
          <button type="button" :disabled="disabled(index, 'swap')" :aria-label="`Swap COM ${index} frequencies`" @click="send(index, 'swap')">Swap</button>
          <button type="button" class="col-span-2" :disabled="disabled(index, 'switchTo')" :aria-label="`Switch COM ${index} to entered frequency`" @click="send(index, 'switchTo')">Switch to {{ target(index) == null ? 'frequency' : format(target(index)) }}</button>
        </div>
        <button v-if="edited(index)" type="button" class="mt-2 w-full" :disabled="Boolean(busy(index))" @click="delete drafts[index]">Cancel edit</button>
        <p class="mt-2 text-xs text-muted-fg">Say “COM {{ index === 1 ? 'one' : 'two' }} standby 123.450”</p>
      </form>
    </div>
  </section>
</template>

<style scoped>
.com-radios input { height: 3rem; min-height: 3rem; }
.com-radios button { min-height: 3rem; border: 1px solid rgb(var(--color-accent, 0 212 255) / .4); border-radius: .5rem; padding: .5rem; font-size: .8rem; background: rgb(var(--color-accent, 0 212 255) / .08); }
.com-radios :disabled { opacity: .45; cursor: not-allowed; }
.com-radios :is(input, button):focus-visible { outline: 2px solid rgb(var(--color-accent, 0 212 255)); outline-offset: 3px; }
</style>
