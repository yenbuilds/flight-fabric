<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { freshAircraftValue } from '../../voice/state-queries.js';

const props = defineProps({ displaysOnly: { type: Boolean, default: false } });
const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
const draft = reactive({ cockpit: '50', displays: '75' });
const now = ref(Date.now()), sending = ref(false);
const id = target => `configuration.lighting.${target}`;
const command = target => controls.getAircraftCommand(id(target));
const targets = computed(() => (props.displaysOnly ? ['displays'] : ['cockpit', 'displays']).filter(target => command(target)));
const context = computed(() => `${controls.aircraftCommandCatalogue.profileKey}:${controls.aircraftCommandCatalogue.profileRevision}`);
watch(context, () => { draft.cockpit = '50'; draft.displays = '75'; sending.value = false; });
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 500); });
onUnmounted(() => clearInterval(timer));
const busy = computed(() => sending.value || ['cockpit', 'displays'].some(target => controls.isCommandPending(`aircraft-command:${id(target)}`)));
const freshContext = computed(() => specific.available && specific.sourceStatus === 'connected'
  && specific.activeProfileKey === controls.aircraftCommandCatalogue.profileKey
  && specific.activeProfileRevision === controls.aircraftCommandCatalogue.profileRevision);
function readValues(target) {
  const fields = command(target)?.brightnessFields;
  if (!freshContext.value || !Array.isArray(fields) || !fields.length) return null;
  const values = fields.map(field => freshAircraftValue(specific, field, Math.max(now.value, Date.now())));
  return values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) ? values : null;
}
function current(target) {
  const values = readValues(target);
  return !values ? 'Unavailable' : values.every(value => value === values[0]) ? `${values[0]}%` : 'Mixed';
}
function value(target) {
  const text = String(draft[target]).trim();
  const value = text ? Number(text) : NaN;
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}
function reason(target) {
  if (!controls.availability.enabled) return controls.availability.reason || 'Aircraft controls are unavailable.';
  if (busy.value) return 'A lighting preset is being applied.';
  if (!readValues(target)) return 'Waiting for live dimmer readings.';
  if (value(target) === null) return 'Enter a whole percentage from 0 to 100.';
  return '';
}
async function apply(target) {
  if (!command(target) || reason(target)) return false;
  const sentContext = context.value;
  sending.value = true;
  try { return await controls.requestControlCommand({ type: 'canonical', commandId: id(target), input: { value: value(target) } }); }
  finally { if (context.value === sentContext) sending.value = false; }
}
const label = target => target === 'cockpit' ? 'Global cockpit lighting' : 'All flight displays';
const voice = target => target === 'cockpit' ? 'set cockpit lighting fifty percent' : 'set display brightness seventy five percent';
</script>

<template>
  <section v-if="targets.length" class="ff-panel rounded-xl border border-surface-200 bg-surface-100 p-3 sm:p-4"
    aria-label="Cockpit brightness presets" data-cockpit-lighting-presets>
    <h2 v-if="!displaysOnly" class="text-sm font-semibold text-gray-100">Cockpit lighting</h2>
    <p class="mb-3 text-xs leading-relaxed text-gray-400" :class="{ 'mt-1': !displaysOnly }">
      Set the cockpit lighting, then adjust the flight displays to their own brightness.
    </p>
    <div class="grid gap-3" :class="{ 'lg:grid-cols-2': targets.length > 1 }">
      <form v-for="target in targets" :key="target" class="min-w-0 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] p-3"
        :data-lighting-preset="target" @submit.prevent="apply(target)">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-gray-100">{{ label(target) }}</h3>
          <span class="font-mono text-xs text-gray-300" :data-lighting-current="target">{{ current(target) }}</span>
        </div>
        <p class="mt-1 text-xs leading-relaxed text-gray-400">{{ command(target).description }}</p>
        <label :for="`lighting-${target}-range`" class="mt-3 flex items-center justify-between text-xs text-gray-300">
          Target brightness <output class="font-mono text-cyan-100">{{ value(target) ?? '--' }}%</output>
        </label>
        <input :id="`lighting-${target}-range`" v-model="draft[target]" type="range" min="0" max="100" step="1"
          class="h-9 w-full accent-cyan-400" :aria-label="`${label(target)} target percentage`" :disabled="busy" />
        <div class="mt-1 flex gap-2">
          <input v-model="draft[target]" type="number" min="0" max="100" step="1" inputmode="numeric"
            class="h-10 min-w-0 flex-1 rounded border border-surface-300 bg-surface-50 px-2 font-mono text-sm text-gray-100"
            :aria-label="`${label(target)} percentage`" :disabled="busy" />
          <button type="submit" class="min-h-10 rounded border border-cyan-400/55 bg-cyan-400/10 px-4 text-xs font-semibold text-cyan-100 disabled:opacity-45"
            :data-aircraft-command="id(target)" :aria-label="`Set ${label(target).toLowerCase()}`" :disabled="Boolean(reason(target))"
            :aria-describedby="reason(target) ? `lighting-${target}-reason` : undefined">
            {{ busy ? 'Applying…' : 'Set' }}
          </button>
        </div>
        <p class="mt-2 text-xs text-gray-400">Say “{{ voice(target) }}”</p>
        <p v-if="reason(target)" :id="`lighting-${target}-reason`" class="mt-2 text-xs text-amber-300" role="status">{{ reason(target) }}</p>
      </form>
    </div>
  </section>
</template>
