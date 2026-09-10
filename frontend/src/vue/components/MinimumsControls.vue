<script setup>
import { computed, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';

const controls = useAircraftControlsStore();
const target = ref('baro'), draft = ref(''), sending = ref(false);
const context = computed(() => `${controls.aircraftCommandCatalogue.profileKey}:${controls.aircraftCommandCatalogue.profileRevision}`);
const supported = computed(() => controls.isAircraftCommandSupported('approach.minimums.baro'));
const commandId = computed(() => `approach.minimums.${target.value}`);
const max = computed(() => target.value === 'radio' ? 5000 : 39000);
const value = computed(() => /^\d{1,5}$/.test(draft.value) && Number(draft.value) <= max.value ? Number(draft.value) : null);
const busy = computed(() => sending.value || ['baro', 'radio'].some((type) => controls.isCommandPending(`aircraft-command:approach.minimums.${type}`)));
const ready = computed(() => controls.availability.enabled && controls.isAircraftCommandSupported(commandId.value));
watch(context, () => { draft.value = ''; sending.value = false; });
watch([target, ready], () => { draft.value = ''; });
async function send() {
  if (!ready.value || busy.value || value.value === null) return;
  const sentContext = context.value;
  sending.value = true;
  try { await controls.requestControlCommand({ type: 'canonical', commandId: commandId.value, input: { value: value.value } }); }
  finally { if (sentContext === context.value) sending.value = false; }
}
</script>

<template>
  <section v-if="supported" class="rounded-xl border border-surface-200 bg-surface-100 p-3 sm:p-4" aria-label="Approach minimums" data-minimums-controls>
    <h2 class="text-sm font-semibold">Approach minimums</h2>
    <p id="minimums-setup" class="mt-2 text-xs text-muted-fg">Run FlyByWire SimBridge on this PC (port 8380), enabled in the EFB. Open the active PERF APPR page on the captain MCDU and leave its scratchpad empty.</p>
    <form class="mt-3 grid grid-cols-2 gap-3" :aria-busy="busy" @submit.prevent="send">
      <label class="text-xs">Minimums type
        <select v-model="target" :disabled="!ready || busy" aria-label="Minimums type" class="mt-1 block w-full rounded-md border border-surface-200 bg-surface-50 px-3 text-base">
          <option value="baro">BARO altitude</option><option value="radio">RADIO height (ILS)</option>
        </select>
      </label>
      <label class="text-xs">Feet
        <input v-model="draft" type="text" inputmode="numeric" maxlength="5" autocomplete="off" aria-label="Minimums feet" aria-describedby="minimums-setup minimums-status"
          :disabled="!ready || busy" :aria-invalid="draft !== '' && value === null" :placeholder="target === 'radio' ? '200' : '420'"
          class="mt-1 block w-full min-w-0 rounded-md border border-surface-200 bg-surface-50 px-3 font-mono text-base" />
      </label>
      <button type="submit" :disabled="!ready || busy || value === null" class="col-span-2 rounded-md border border-surface-300 px-3 py-2 text-sm disabled:opacity-40">Set minimums</button>
      <p id="minimums-status" role="status" class="col-span-2 text-xs text-muted-fg">{{ busy ? 'Entering and confirming minimums on PERF APPR…' : `0–${max} whole feet; the aircraft checks the approach limits. Setting one type clears the other. Avoid MCDU input until confirmation.` }}</p>
    </form>
  </section>
</template>
