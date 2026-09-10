<script setup>
import { computed, ref } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';

const controls = useAircraftControlsStore();
const sending = ref(false);
const lights = [
  { target: 'landing', label: 'Landing lights', voice: 'landing lights' },
  { target: 'taxi', label: 'Taxi lights', voice: 'taxi lights' },
  { target: 'runwayTurnoff', label: 'Runway turnoff lights', voice: 'runway turnoff lights' },
];
const commandId = light => `lights.${light.target}.set`;
const command = light => controls.getAircraftCommand(commandId(light));
const visible = computed(() => lights.some(command));
const busy = computed(() => sending.value || Object.entries(controls.pendingCommands).some(([key, pending]) => pending
  && (key.startsWith('aircraft-command:lights.') || key === 'aircraft-command:configuration.lights.takeoff')));
const disabled = light => busy.value || !command(light) || !controls.availability.enabled;
async function apply(light, value) {
  if (disabled(light)) return false;
  sending.value = true;
  try { return await controls.requestControlCommand({ type: 'canonical', commandId: commandId(light), input: { value } }); }
  finally { sending.value = false; }
}
</script>

<template>
  <section v-if="visible" class="ff-panel rounded-xl border border-surface-200 bg-surface-100 p-3 sm:p-4"
    aria-label="Individual exterior lights" data-exterior-light-controls>
    <h2 class="mb-3 text-sm font-semibold text-gray-100">Exterior lights</h2>
    <div class="grid gap-3 sm:grid-cols-3">
      <div v-for="light in lights" :key="light.target" class="rounded-lg border border-surface-300 p-3" :data-exterior-light="light.target">
        <h3 class="text-sm font-semibold text-gray-100">{{ light.label }}</h3>
        <p v-if="command(light)?.description" class="mt-1 text-xs leading-relaxed text-gray-400">{{ command(light).description }}</p>
        <div class="mt-3 flex gap-2">
          <button v-for="value in [true, false]" :key="String(value)" type="button"
            class="min-h-11 flex-1 rounded border border-cyan-400/50 bg-cyan-400/10 px-3 text-xs font-semibold text-cyan-100 disabled:opacity-45"
            :data-aircraft-command="commandId(light)" :data-light-value="String(value)"
            :aria-label="`${light.label} ${value ? 'on' : 'off'}`" :disabled="disabled(light)" @click="apply(light, value)">
            {{ value ? 'On' : 'Off' }}
          </button>
        </div>
        <p class="mt-2 text-xs text-gray-400">{{ command(light) ? `Say “set ${light.voice} on” or “off”` : 'Unavailable on this aircraft.' }}</p>
      </div>
    </div>
    <p v-if="busy" class="mt-2 text-xs text-amber-300" role="status">Applying exterior lights…</p>
    <p v-else-if="!controls.availability.enabled" class="mt-2 text-xs text-amber-300" role="status">{{ controls.availability.reason || 'Aircraft controls are unavailable.' }}</p>
  </section>
</template>
