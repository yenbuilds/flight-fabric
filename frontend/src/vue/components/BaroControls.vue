<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { aircraftQueryFamily, freshAircraftValue } from '../../voice/state-queries.js';
import { BARO_SIDE_LABELS, baroSides, parseBaroPressure } from '../../aircraft/baro.js';

const controls = useAircraftControlsStore();
const specific = useAircraftSpecificStore();
const target = ref('both'), unit = ref('hPa'), draft = ref(''), sending = ref(false), now = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 500); });
onUnmounted(() => clearInterval(timer));
const context = computed(() => `${controls.aircraftCommandCatalogue.profileKey}:${controls.aircraftCommandCatalogue.profileRevision}`);
const fenix = computed(() => aircraftQueryFamily(controls.aircraftCommandCatalogue.profileKey) === 'fenix-a32x');
const supported = computed(() => controls.isAircraftCommandSupported('baro.both.std'));
const standardOnly = computed(() => controls.aircraftCommandCatalogue.profileKey === 'bundled/msfs/fbw-a380x');
const fresh = computed(() => specific.available && specific.sourceStatus === 'connected'
  && specific.activeProfileKey === controls.aircraftCommandCatalogue.profileKey
  && specific.activeProfileRevision === controls.aircraftCommandCatalogue.profileRevision
  && Number.isFinite(Date.parse(specific.updatedAt)) && now.value - Date.parse(specific.updatedAt) <= 2000
  && now.value - Date.parse(specific.updatedAt) >= -1000);
function field(side, property) {
  return property === 'unitInHg' ? `flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}` : `baro.${side}.${property}`;
}
function read(id) { return fresh.value ? freshAircraftValue(specific, id, Math.max(now.value, Date.now())) : null; }
const sideReady = (side) => standardOnly.value
  ? read(`baro.${side}.active`) === true && typeof read(`baro.${side}.std`) === 'boolean'
  : fenix.value
  ? typeof read(`baro.${side}.qnh`) === 'boolean' && ['hpa', 'inhg'].includes(read(field(side, 'unitInHg')))
  : [0, 1, 2].includes(read(field(side, 'mode'))) && [0, 1, 2].includes(read(field(side, 'valueMode')))
  && typeof read(field(side, 'value')) === 'number' && Number.isFinite(read(field(side, 'value')))
  && typeof read(field(side, 'unitInHg')) === 'boolean';
const healthy = computed(() => standardOnly.value || read('baro.healthy') === true);
const ready = computed(() => controls.availability.enabled && healthy.value && baroSides(target.value).every(sideReady));
const busy = computed(() => sending.value
  || ['captain', 'firstOfficer', 'both'].some((side) => ['qnhHpa', 'qnhInHg', 'std'].some((op) => controls.isCommandPending(`aircraft-command:baro.${side}.${op}`))));
const value = computed(() => parseBaroPressure(draft.value, unit.value));
const commandId = (operation) => `baro.${target.value}.${operation}`;
const disabled = (operation) => !ready.value || busy.value || !controls.isAircraftCommandSupported(commandId(operation)) || (operation !== 'std' && value.value == null);
function display(side) {
  if (!healthy.value || !sideReady(side)) return '—';
  if (standardOnly.value) return read(`baro.${side}.std`) ? 'STD' : 'STD off';
  if (fenix.value) {
    if (read(`baro.${side}.qnh`) === false) return 'STD';
    const units = read(field(side, 'unitInHg')), pressure = read(`baro.${side}.${units}`);
    return typeof pressure === 'number' && Number.isFinite(pressure) && parseBaroPressure(pressure, units === 'inhg' ? 'inHg' : 'hPa') != null
      ? `QNH ${pressure.toFixed(units === 'inhg' ? 2 : 0)} ${units === 'inhg' ? 'inHg' : 'hPa'}` : '\u2014';
  }
  const mode = read(field(side, 'mode')), valueMode = read(field(side, 'valueMode'));
  if (mode === 0 && valueMode === 0) return 'STD';
  if (mode === 0 || valueMode === 0) return '—';
  return `${mode === 1 ? 'QNH' : 'QFE'} ${read(field(side, 'value')).toFixed(valueMode === 2 ? 2 : 0)} ${valueMode === 2 ? 'inHg' : 'hPa'}`;
}
function clearDraft() { draft.value = ''; }
watch(context, () => { clearDraft(); sending.value = false; target.value = 'both'; });
watch([target, unit, () => controls.availability.enabled], clearDraft);
watch(fresh, (isFresh) => { if (!isFresh) clearDraft(); });
async function send(operation) {
  if (disabled(operation)) return;
  const sentContext = context.value;
  sending.value = true;
  try {
    await controls.requestControlCommand({ type: 'canonical', commandId: commandId(operation), input: operation === 'std' ? {} : { value: value.value } });
  } finally { if (context.value === sentContext) sending.value = false; }
}
</script>

<template>
  <section v-if="supported" class="baro-controls ff-panel rounded-xl border border-surface-200 bg-surface-100 p-3 sm:p-4" aria-label="Altimeters" data-baro-controls data-aircraft-search-label="Altimeters QNH STD standard pressure captain first officer both">
    <h2 class="text-sm font-semibold text-gray-100">Altimeters</h2>
    <div class="my-3 grid grid-cols-2 gap-3 text-xs text-muted-fg">
      <div v-for="side in ['captain', 'firstOfficer']" :key="side">{{ BARO_SIDE_LABELS[side] }}
        <output class="mt-1 block font-mono text-base text-emerald-200" :aria-label="`${BARO_SIDE_LABELS[side]} altimeter`">{{ display(side) }}</output>
      </div>
    </div>
    <form class="grid gap-3 sm:grid-cols-2" :aria-busy="busy" @submit.prevent="send(unit === 'hPa' ? 'qnhHpa' : 'qnhInHg')">
      <label class="text-xs">Apply to
        <select v-model="target" aria-label="Altimeter target" :disabled="busy" class="mt-1 block w-full rounded-md border border-surface-200 bg-surface-50 px-3 text-base">
          <option value="both">Both altimeters</option><option value="captain">Captain</option><option value="firstOfficer">First officer</option>
        </select>
      </label>
      <label v-if="!standardOnly" class="text-xs">Units
        <select v-model="unit" aria-label="Altimeter units" :disabled="busy" class="mt-1 block w-full rounded-md border border-surface-200 bg-surface-50 px-3 text-base">
          <option value="hPa">hPa</option><option value="inHg">inHg</option>
        </select>
      </label>
      <label v-if="!standardOnly" class="text-xs sm:col-span-2">QNH ({{ unit }})
        <input v-model="draft" aria-label="QNH pressure" type="text" inputmode="decimal" autocomplete="off" maxlength="5"
          :placeholder="unit === 'hPa' ? '1016' : '29.92'" :disabled="!ready || busy" :aria-invalid="draft !== '' && value == null"
          aria-describedby="baro-status" class="mt-1 block w-full min-w-0 rounded-md border border-surface-200 bg-surface-50 px-3 font-mono text-base" @focus="$event.target.select()" />
      </label>
      <p id="baro-status" class="text-xs text-muted-fg sm:col-span-2" role="status">{{ busy ? 'Waiting for altimeter confirmation…'
        : !ready ? 'Waiting for fresh, powered altimeter data.' : standardOnly ? 'Each selected side must confirm STD.' : `${unit === 'hPa' ? '948–1084 hPa · whole numbers' : '27.99–32.01 inHg · up to two decimals'}. Each selected side must confirm.` }}</p>
      <button v-if="!standardOnly" type="submit" :disabled="disabled(unit === 'hPa' ? 'qnhHpa' : 'qnhInHg')">Set QNH</button>
      <button type="button" :disabled="disabled('std')" @click="send('std')">Set STD</button>
    </form>
    <p class="mt-3 text-xs text-muted-fg">Say “Set baro standard” for both altimeters, or “Set captain baro standard”.</p>
  </section>
</template>

<style scoped>
.baro-controls :is(input, select, button) { height: 3rem; min-height: 3rem; }
.baro-controls button { border: 1px solid rgb(var(--color-accent, 0 212 255) / .4); border-radius: .5rem; padding: .5rem; font-size: .875rem; background: rgb(var(--color-accent, 0 212 255) / .08); }
.baro-controls :disabled { opacity: .45; cursor: not-allowed; }
.baro-controls :is(input, select, button):focus-visible { outline: 2px solid rgb(var(--color-accent, 0 212 255)); outline-offset: 3px; }
</style>
