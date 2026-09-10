<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { A32NX_QUERY_PROFILE, aircraftQueryFamily, efisFieldId, freshAircraftValue } from '../../voice/state-queries.js';

const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
const sides = [{ id: 'captain', label: 'Captain' }, { id: 'firstOfficer', label: 'First officer' }];
const sending = ref(false), drafts = ref({}), now = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 500); });
onUnmounted(() => clearInterval(timer));
const profile = computed(() => controls.aircraftCommandCatalogue.profileKey);
const context = computed(() => `${profile.value}:${controls.aircraftCommandCatalogue.profileRevision}`);
const supported = computed(() => profile.value !== A32NX_QUERY_PROFILE && sides.some((side) => controls.isAircraftCommandSupported(`navigation.${side.id}.range`)));
const current = computed(() => profile.value === specific.activeProfileKey
  && controls.aircraftCommandCatalogue.profileRevision === specific.activeProfileRevision);
const id = (side, type) => type === 'minimumsMode' ? `approach.${side}.${type}` : `navigation.${side}.${type}`;
const command = (side, type) => controls.getAircraftCommand(id(side, type));
const read = (side, type) => current.value ? freshAircraftValue(specific, efisFieldId(profile.value, side, type), Math.max(now.value, Date.now())) : null;
const busy = computed(() => sending.value || sides.some((side) => ['range', 'ls', 'minimumsMode'].some((type) => controls.isCommandPending(`aircraft-command:${id(side.id, type)}`))));
const disabled = (side, type) => !controls.availability.enabled || !current.value || busy.value || !command(side, type) || read(side, type) === null;
watch(context, () => { drafts.value = {}; sending.value = false; });
watch([current, () => controls.availability.enabled], () => { drafts.value = {}; });
async function send(side, type, value) {
  if (disabled(side, type) || (type !== 'ls' && !command(side, type).input.values.includes(value))) return;
  const sentContext = context.value;
  sending.value = true;
  try { await controls.requestControlCommand({ type: 'canonical', commandId: id(side, type), input: { value } }); }
  finally { if (context.value === sentContext) sending.value = false; }
}
function minimums(side) {
  const mode = read(side, 'minimumsMode');
  if (!['baro', 'radio'].includes(mode)) return '—';
  const time = Math.max(now.value, Date.now());
  const set = freshAircraftValue(specific, `efis.${side}.${mode}MinimumsSet`, time);
  const value = freshAircraftValue(specific, `efis.${side}.${mode}MinimumsFt`, time);
  return set === false ? `${mode.toUpperCase()} not set` : set === true && Number.isInteger(value) ? `${mode.toUpperCase()} ${value} ft` : '—';
}
</script>

<template>
  <section v-if="supported" class="rounded-xl border border-surface-200 bg-surface-100 p-3 sm:p-4" aria-label="EFIS controls" data-efis-controls>
    <h2 class="text-sm font-semibold">EFIS &amp; approach</h2>
    <div class="mt-3 grid gap-4 sm:grid-cols-2">
      <fieldset v-for="side in sides" :key="side.id" class="min-w-0 space-y-2" :aria-busy="busy">
        <legend class="mb-2 text-xs font-semibold">{{ side.label }}</legend>
        <form v-if="command(side.id, 'range')" class="flex items-end gap-2" @submit.prevent="send(side.id, 'range', drafts[side.id])">
          <label class="min-w-0 flex-1 text-xs">ND range <span class="text-muted-fg">({{ read(side.id, 'range') ?? '—' }})</span>
            <select v-model="drafts[side.id]" :aria-label="`${side.label} ND range`" :disabled="disabled(side.id, 'range')"
              class="mt-1 block w-full rounded-md border border-surface-200 bg-surface-50 px-2 text-base">
              <option :value="undefined" disabled>Select range</option>
              <option v-for="value in command(side.id, 'range').input.values" :key="value" :value="value">{{ value }} NM</option>
            </select>
          </label>
          <button :disabled="disabled(side.id, 'range') || !drafts[side.id]" :aria-label="`Set ${side.label.toLowerCase()} range`" class="rounded-md border border-surface-300 px-3 py-2 text-sm disabled:opacity-40">Set</button>
        </form>
        <div v-if="command(side.id, 'ls')" class="flex items-center gap-2 text-xs">
          <span class="flex-1">LS: {{ read(side.id, 'ls') === null ? '—' : read(side.id, 'ls') ? 'ON' : 'OFF' }}</span>
          <button v-for="on in [true, false]" :key="String(on)" :disabled="disabled(side.id, 'ls')" :aria-label="`${side.label} LS ${on ? 'on' : 'off'}`"
            class="rounded-md border border-surface-300 px-3 py-2 disabled:opacity-40" @click="send(side.id, 'ls', on)">{{ on ? 'ON' : 'OFF' }}</button>
        </div>
        <div v-if="command(side.id, 'minimumsMode')" class="flex flex-wrap items-center gap-2 text-xs">
          <span class="flex-1">Minimums: {{ read(side.id, 'minimumsMode')?.toUpperCase() ?? '—' }}</span>
          <button v-for="mode in ['baro', 'radio']" :key="mode" :disabled="disabled(side.id, 'minimumsMode')" :aria-label="`${side.label} minimums ${mode}`"
            class="rounded-md border border-surface-300 px-3 py-2 disabled:opacity-40" @click="send(side.id, 'minimumsMode', mode)">{{ mode.toUpperCase() }}</button>
          <output v-if="aircraftQueryFamily(profile) === 'pmdg-777'" class="w-full font-mono" :aria-label="`${side.label} current minimums`">{{ minimums(side.id) }}</output>
        </div>
      </fieldset>
    </div>
    <p v-if="aircraftQueryFamily(profile)?.startsWith('pmdg-')" class="mt-3 text-xs text-muted-fg">Enter numeric minimums in the cockpit. BARO/RADIO selects the reference only.</p>
    <p v-if="aircraftQueryFamily(profile) === 'inibuilds-a350'" class="mt-3 text-xs text-muted-fg">Normal range detents. The displayed map scale also depends on ND mode.</p>
  </section>
</template>
