<script setup>
import { computed } from 'vue';
import { useAircraftControlsStore } from '../../stores/aircraft-controls.js';

const props = defineProps({
  sourceStatus: { type: String, default: 'awaiting-values' },
});
const controls = useAircraftControlsStore();
const request = Object.freeze({ type: 'canonical', commandId: 'configuration.lights.takeoff', input: {} });
const command = computed(() => controls.getAircraftCommand(request.commandId));
const pending = computed(() => controls.isCommandPending(request));
const otherLightPending = computed(() => Object.entries(controls.pendingCommands).some(([key, value]) => value && key.startsWith('aircraft-command:lights.')));
const disabled = computed(() => props.sourceStatus !== 'connected'
  || otherLightPending.value
  || !command.value
  || controls.isCommandDisabled(request));
const status = computed(() => {
  if (pending.value) return 'Applying takeoff lights…';
  if (otherLightPending.value) return 'An exterior light command is being applied.';
  if (controls.availability.enabled !== true) return controls.availability.reason || 'Aircraft controls are unavailable.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (!controls.isAircraftCommandSupported(request.commandId)) return 'Takeoff lights are unavailable for this aircraft connection.';
  return '';
});

function apply() {
  if (disabled.value) return false;
  return controls.requestControlCommand(request);
}
</script>

<template>
  <div class="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-400/25 bg-emerald-500/[0.06] p-3" data-takeoff-lights-preset>
    <button
      type="button"
      class="min-h-11 shrink-0 rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-45"
      data-aircraft-command="configuration.lights.takeoff"
      aria-label="Set takeoff lights"
      aria-describedby="aircraft-takeoff-lights-status"
      :aria-busy="pending"
      :disabled="disabled"
      @click="apply"
    >
      {{ pending ? 'Applying…' : 'Set takeoff lights' }}
    </button>
    <div class="min-w-0 flex-1 basis-60 text-xs">
      <p class="text-muted-fg">{{ command?.description || 'Apply the aircraft’s takeoff light configuration.' }}</p>
      <p class="mt-1 text-gray-400">Say “set takeoff lights”</p>
      <p id="aircraft-takeoff-lights-status" role="status" :class="status ? 'mt-1 text-amber-300' : ''">{{ status }}</p>
    </div>
  </div>
</template>
