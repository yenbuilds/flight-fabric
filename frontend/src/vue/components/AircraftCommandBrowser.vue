<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { aircraftCommandInput, aircraftCommandValueLabel } from '../../aircraft/command-input.js';

const controls = useAircraftControlsStore();
const search = ref(''), group = ref(''), sending = ref(false), error = ref('');
const drafts = reactive({});
const context = computed(() => `${controls.aircraftCommandCatalogue.profileKey}:${controls.aircraftCommandCatalogue.profileRevision}`);
watch(context, () => {
  for (const key of Object.keys(drafts)) delete drafts[key];
  search.value = ''; group.value = ''; error.value = ''; sending.value = false;
});
const groupNames = { flightGuidance: 'Autopilot & flight guidance', surfaces: 'Gear, flaps & brakes',
  navigation: 'Navigation displays', radios: 'Radios', surveillance: 'Transponder',
  approach: 'Approach', baro: 'Altimeters', lights: 'Exterior lights', cabin: 'Cabin signs',
  visibility: 'Wipers', systems: 'Aircraft systems', propulsion: 'Thrust' };
// Presets have dedicated controls above. Every other advertised command has a
// usable editor here, even when a family's handcrafted panel lacks that editor.
const commands = computed(() => Object.values(controls.aircraftCommandCatalogue.commands || {})
  .filter(command => command.kind !== 'preset')
  .sort((a, b) => a.label.localeCompare(b.label)));
const groups = computed(() => [...new Set(commands.value.map(command => command.group))]
  .sort((a, b) => (groupNames[a] || a).localeCompare(groupNames[b] || b)));
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return commands.value.filter(command => (!group.value || command.group === group.value)
    && (!query || [command.label, command.description, ...(command.speech?.patterns || [])].join(' ').toLowerCase().includes(query)));
});
const busy = computed(() => sending.value || Object.values(controls.pendingCommands).some(Boolean));
const request = (command, input = {}) => ({ type: 'canonical', commandId: command.id, input });
const disabled = command => busy.value || controls.isCommandDisabled(request(command));
const value = command => aircraftCommandInput(command.input, drafts[command.id]);
const phrase = command => command.speech?.patterns?.[0] || '';
const unit = command => ({ 'feet-per-minute': 'ft/min', feet: 'ft', degrees: 'degrees',
  knots: 'kt', 'com-megahertz': 'MHz', megahertz: 'MHz', percent: '%', hpa: 'hPa', inhg: 'inHg' }[command.input.units]
  || command.input.units || '');
async function apply(command, input = value(command)) {
  if (disabled(command) || input === null) return false;
  const sentContext = context.value;
  sending.value = true; error.value = '';
  try {
    const sent = await controls.requestControlCommand(request(command, input));
    if (!sent && context.value === sentContext) error.value = 'Could not send the command. Check the connection and try again.';
    return sent;
  } catch {
    if (context.value === sentContext) error.value = 'Could not send the command. Check the connection and try again.';
    return false;
  } finally { if (context.value === sentContext) sending.value = false; }
}
</script>

<template>
  <details v-if="commands.length" class="ff-panel rounded-xl border border-surface-200 bg-surface-100 p-3 sm:p-4" data-aircraft-command-browser>
    <summary class="min-h-12 cursor-pointer text-sm font-semibold text-gray-100">All aircraft controls <span class="font-normal text-gray-400">({{ commands.length }})</span></summary>
    <p class="mb-3 text-xs leading-relaxed text-gray-400">Search the controls available for this aircraft. Each control shows its voice command too.</p>
    <div class="mb-3 flex flex-col gap-2 sm:flex-row">
      <input v-model="search" type="search" aria-label="Search aircraft controls" placeholder="Search controls or voice commands"
        class="min-h-12 min-w-0 flex-1 rounded border border-surface-300 bg-surface-50 px-3 text-base text-gray-100 sm:text-sm" />
      <select v-model="group" aria-label="Aircraft control category" class="min-h-12 min-w-0 rounded border border-surface-300 bg-surface-50 px-3 text-base text-gray-100 sm:text-sm">
        <option value="">All categories</option>
        <option v-for="id in groups" :key="id" :value="id">{{ groupNames[id] || id }}</option>
      </select>
    </div>
    <p v-if="!controls.availability.enabled" role="status" class="mb-3 text-xs text-amber-300">{{ controls.availability.reason || 'Aircraft controls are unavailable.' }}</p>
    <p v-if="error" role="alert" class="mb-3 text-xs text-amber-300">{{ error }}</p>
    <p v-if="busy" role="status" class="mb-3 text-xs text-cyan-100">Waiting for the current command…</p>
    <p v-if="controls.feedback.status !== 'idle'" role="status" class="mb-3 text-xs text-gray-300">{{ controls.feedback.actionText }}</p>
    <p v-if="!filtered.length" class="text-sm text-gray-400">No matching controls.</p>
    <div class="grid gap-3 lg:grid-cols-2">
      <form v-for="command in filtered" :key="`${context}:${command.id}`" class="min-w-0 rounded-lg border border-surface-300 p-3"
        :data-command-editor="command.id" @submit.prevent="apply(command)">
        <h3 class="text-sm font-semibold text-gray-100">{{ command.label }}</h3>
        <p v-if="command.description" class="mt-1 text-xs leading-relaxed text-gray-400">{{ command.description }}</p>
        <div v-if="command.input.kind === 'boolean'" class="mt-3 flex gap-2">
          <button v-for="state in [true, false]" :key="String(state)" type="button" :disabled="disabled(command)"
            :aria-label="`${command.label} ${state ? 'on' : 'off'}`" :data-command-value="String(state)"
            class="min-h-12 flex-1 rounded border border-cyan-400/50 bg-cyan-400/10 px-3 text-xs font-semibold text-cyan-100 disabled:opacity-45"
            @click="apply(command, { value: state })">{{ state ? 'On' : 'Off' }}</button>
        </div>
        <div v-else class="mt-3 flex gap-2">
          <input v-if="command.input.kind === 'number'" v-model="drafts[command.id]" type="text" :inputmode="command.input.min < 0 ? 'text' : 'decimal'"
            :aria-label="`${command.label} target`" :placeholder="`${command.input.min}–${command.input.max} ${unit(command)}`" :disabled="disabled(command)"
            class="min-h-12 min-w-0 flex-1 rounded border border-surface-300 bg-surface-50 px-3 font-mono text-base text-gray-100 sm:text-sm" />
          <select v-else-if="command.input.kind === 'enum'" v-model="drafts[command.id]" :aria-label="`${command.label} target`" :disabled="disabled(command)"
            class="min-h-12 min-w-0 flex-1 rounded border border-surface-300 bg-surface-50 px-3 text-base text-gray-100 sm:text-sm">
            <option :value="undefined" disabled>Select setting</option>
            <option v-for="setting in command.input.values" :key="setting" :value="setting">{{ aircraftCommandValueLabel(setting).toUpperCase() }}</option>
          </select>
          <button type="submit" :aria-label="`Apply ${command.label}`" :disabled="disabled(command) || value(command) === null"
            class="min-h-12 rounded border border-cyan-400/50 bg-cyan-400/10 px-4 text-xs font-semibold text-cyan-100 disabled:opacity-45">{{ command.input.kind === 'none' ? 'Execute' : 'Set' }}</button>
        </div>
        <p v-if="command.input.kind === 'number'" class="mt-2 text-xs text-gray-400">{{ command.input.min }}–{{ command.input.max }} {{ unit(command) }}; increments of {{ command.input.step }}.</p>
        <p v-if="phrase(command)" class="mt-2 break-words text-xs text-gray-400">Say “{{ phrase(command).replace('{value}', '[setting]') }}”</p>
      </form>
    </div>
  </details>
</template>

<style scoped>
/* Keep touch targets above the shared mobile form minimum. */
[data-aircraft-command-browser] :is(input, select, button) {
  min-height: 48px !important;
}
</style>
