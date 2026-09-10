<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { formatSquawk, parseSquawk } from '../../aircraft/transponder.js';
import { A32NX_QUERY_PROFILE, freshAircraftValue } from '../../voice/state-queries.js';

const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
const draft = ref(''), sending = ref(false), now = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 500); });
onUnmounted(() => clearInterval(timer));
const context = computed(() => `${controls.aircraftCommandCatalogue.profileKey}:${controls.aircraftCommandCatalogue.profileRevision}`);
const squawkSupported = computed(() => controls.isAircraftCommandSupported('surveillance.squawk.set'));
const identSupported = computed(() => controls.isAircraftCommandSupported('surveillance.ident.activate'));
const supported = computed(() => squawkSupported.value || identSupported.value);
const confirmsIdent = computed(() => controls.aircraftCommandCatalogue.profileKey === A32NX_QUERY_PROFILE);
const lastResult = ref('');
const read = (id) => freshAircraftValue(specific, `surveillance.${id}`, Math.max(now.value, Date.now()));
const ready = computed(() => specific.activeProfileKey === controls.aircraftCommandCatalogue.profileKey
  && specific.activeProfileRevision === controls.aircraftCommandCatalogue.profileRevision
  && read('powered') === true);
const busy = computed(() => sending.value || ['squawk.set', 'ident.activate'].some((id) =>
  controls.isCommandPending(`aircraft-command:surveillance.${id}`)));
const disabled = (operation) => !controls.availability.enabled || !ready.value || busy.value
  || !controls.isAircraftCommandSupported(`surveillance.${operation}`)
  || (operation === 'squawk.set' ? parseSquawk(draft.value) === null || formatSquawk(read('squawk')) === '----'
    : (squawkSupported.value && read('transmitting') !== true) || (confirmsIdent.value && read('ident') !== false));
watch(context, () => { draft.value = ''; sending.value = false; lastResult.value = ''; });
watch(ready, (value) => { if (!value) { draft.value = ''; lastResult.value = ''; } });
watch(() => controls.availability.enabled, () => { draft.value = ''; lastResult.value = ''; });
async function send(operation) {
  if (disabled(operation)) return;
  const sentContext = context.value;
  sending.value = true;
  lastResult.value = '';
  try {
    const result = await controls.requestControlCommand({ type: 'canonical', commandId: `surveillance.${operation}`,
      input: operation === 'squawk.set' ? { value: parseSquawk(draft.value) } : {} });
    if (context.value === sentContext) lastResult.value = result?.transportAcknowledged && result.ok
      ? 'IDENT requested. Verify the aircraft response.' : '';
  } finally { if (sentContext === context.value) sending.value = false; }
}
</script>

<template>
  <section v-if="supported" class="transponder-controls rounded-xl border border-surface-200 bg-surface-100 p-3 sm:p-4" aria-label="Transponder" data-transponder-controls>
    <div class="transponder-heading flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-sm font-semibold">Transponder</h2>
      <output v-if="squawkSupported" aria-label="Current squawk" class="font-mono text-lg text-emerald-200">{{ ready ? formatSquawk(read('squawk')) : '----' }}</output>
    </div>
    <form class="mt-3 grid grid-cols-2 gap-3" :aria-busy="busy" @submit.prevent="send('squawk.set')">
      <label v-if="squawkSupported" class="col-span-2 text-xs">Squawk code
        <input v-model="draft" type="text" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="0042" aria-label="Squawk code"
          aria-describedby="squawk-status" :aria-invalid="draft !== '' && parseSquawk(draft) === null" :disabled="!controls.availability.enabled || !ready || busy"
          class="mt-1 block w-full min-w-0 rounded-md border border-surface-200 bg-surface-50 px-3 font-mono text-base" @focus="$event.target.select()" />
      </label>
      <button v-if="squawkSupported" type="submit" :disabled="disabled('squawk.set')" class="rounded-md border border-surface-300 px-3 py-2 text-sm disabled:opacity-40">Set squawk</button>
      <button v-if="identSupported" type="button" :disabled="disabled('ident.activate')" class="rounded-md border border-surface-300 px-3 py-2 text-sm disabled:opacity-40" @click="send('ident.activate')">{{ confirmsIdent && read('ident') === true ? 'IDENT active' : 'IDENT' }}</button>
      <p id="squawk-status" role="status" class="col-span-2 text-xs text-muted-fg">{{ busy ? 'Waiting for aircraft response…' : !ready ? 'Waiting for fresh, powered transponder data.' : lastResult || (squawkSupported ? 'Four digits, 0–7. IDENT requires ATC transmitting.' : 'IDENT button request. Set the squawk code in the cockpit.') }}</p>
    </form>
  </section>
</template>

<style scoped>
.transponder-controls {
  container: aircraft-transponder / inline-size;
  min-width: 0;
}

.transponder-controls :is(input, button) {
  min-height: 3rem;
}

@container aircraft-transponder (min-width: 44rem) {
  .transponder-heading {
    justify-content: flex-start;
  }

  form {
    grid-template-columns: minmax(8rem, 14rem) minmax(6rem, 9rem) minmax(6rem, 9rem) minmax(12rem, 1fr);
    align-items: end;
  }

  form > :is(label, p) {
    grid-column: auto;
    min-width: 0;
  }

  form > p {
    align-self: center;
  }
}
</style>
