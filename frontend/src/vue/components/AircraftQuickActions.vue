<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { presetObservation } from '../../aircraft/preset-observation.js';

const aircraftControls = useAircraftControlsStore();
const aircraftSpecific = useAircraftSpecificStore();
const nowMs = ref(Date.now());
let freshnessTimer;
onMounted(() => { freshnessTimer = setInterval(() => { nowMs.value = Date.now(); }, 1000); });
onUnmounted(() => clearInterval(freshnessTimer));

function observation(command) {
  return presetObservation(command, aircraftSpecific, Math.max(nowMs.value, Date.now()));
}

function isApuStart(command) {
  return command.id === 'configuration.apu.start';
}

const presets = computed(() => Object.values(aircraftControls.aircraftCommandCatalogue.commands || {})
  .filter((command) => command?.kind === 'preset' && command?.input?.kind === 'none'));

function controlCommand(command) {
  return {
    type: 'canonical',
    commandId: command.id,
    input: {},
  };
}

function isPending(command) {
  return aircraftControls.isCommandPending(controlCommand(command));
}

function sourceUnavailableReason(command) {
  if (!['pmdg-737', 'pmdg-777'].includes(aircraftSpecific.templateId)
    || !['configuration.lights.takeoff', 'configuration.apu.start'].includes(command.id)) return '';
  const sdkStatus = aircraftSpecific.sourceStatuses.sdk || aircraftSpecific.sourceStatus;
  return aircraftSpecific.sourceStatus !== 'connected' || sdkStatus !== 'connected'
    ? 'Waiting for live PMDG SDK data.'
    : '';
}

function isDisabled(command) {
  return aircraftControls.isCommandDisabled(controlCommand(command))
    || Boolean(sourceUnavailableReason(command))
    || observation(command)?.inhibitsRequest === true;
}

function disabledReason(command) {
  if (aircraftControls.availability.enabled !== true) return aircraftControls.availability.reason;
  if (aircraftControls.isAircraftCommandSupported(command.id) !== true) {
    return 'This preset is not available for the active aircraft.';
  }
  if (isPending(command)) return 'This preset is already being applied.';
  if (sourceUnavailableReason(command)) return sourceUnavailableReason(command);
  if (observation(command)?.inhibitsRequest === true) return observation(command).label;
  return '';
}

function voicePhrase(command) {
  const pattern = command?.speech?.patterns?.find((candidate) => !String(candidate).includes('{value}'));
  return typeof pattern === 'string' ? pattern : '';
}

function applyPreset(command) {
  if (isDisabled(command)) return false;
  return aircraftControls.requestControlCommand(controlCommand(command));
}

function actionLabel(command) {
  if (isPending(command)) return isApuStart(command) ? 'Requesting…' : 'Applying…';
  if (observation(command)?.inhibitsRequest === true) return 'Already active';
  if (isDisabled(command)) return 'Unavailable';
  return isApuStart(command) ? 'Start' : 'Apply';
}

function actionAriaLabel(command) {
  if (isApuStart(command)) return isPending(command) ? 'Requesting APU start' : 'Start APU';
  if (isPending(command)) return `Applying ${command.label}`;
  if (isDisabled(command)) return `${command.label} unavailable`;
  return `Apply ${command.label}`;
}

function disabledReasonId(command) {
  return `aircraft-preset-reason-${String(command.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}
</script>

<template>
  <section
    v-if="presets.length"
    class="aircraft-quick-actions ff-panel border border-surface-200 bg-surface-100 p-2.5 sm:p-3"
    aria-label="Aircraft presets"
    data-aircraft-quick-actions
  >
    <div class="aircraft-preset-grid grid gap-2.5">
      <div
        v-for="command in presets"
        :key="command.id"
        class="aircraft-preset-container min-w-0"
      >
        <article
          class="aircraft-preset-card flex flex-col gap-3 rounded-xl border border-surface-200 bg-surface-50 p-3"
          :data-aircraft-preset="command.id"
        >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 class="text-sm font-semibold text-gray-100">{{ command.label }}</h3>
              <span v-if="voicePhrase(command)" class="rounded-full border border-white/10 bg-black/15 px-2 py-0.5 text-[10px] text-gray-400">
                Say &ldquo;{{ voicePhrase(command) }}&rdquo;
              </span>
            </div>
            <p class="mt-1 text-xs leading-relaxed text-muted-fg">{{ command.description }}</p>
            <p v-if="isApuStart(command)" class="mt-1 text-xs text-muted-fg" role="status">
              {{ observation(command)?.label || 'APU status unknown' }}
            </p>
            <p
              v-if="isDisabled(command) && disabledReason(command)"
              :id="disabledReasonId(command)"
              class="mt-1.5 text-xs leading-relaxed text-amber-300"
            >
              {{ disabledReason(command) }}
            </p>
          </div>
          <div class="aircraft-preset-action flex shrink-0 items-center">
            <button
              type="button"
              class="min-h-11 w-full rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-200 transition-colors hover:border-emerald-300/70 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-gray-500"
              :disabled="isDisabled(command)"
              :title="disabledReason(command) || actionAriaLabel(command)"
              :aria-label="actionAriaLabel(command)"
              :aria-describedby="isDisabled(command) && disabledReason(command) ? disabledReasonId(command) : undefined"
              @click="applyPreset(command)"
            >
              {{ actionLabel(command) }}
            </button>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.aircraft-preset-grid {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 30rem), 1fr));
}

.aircraft-preset-container {
  container-type: inline-size;
}

@container (min-width: 30rem) {
  .aircraft-preset-card {
    flex-direction: row;
    align-items: center;
  }

  .aircraft-preset-action {
    align-self: stretch;
  }

  .aircraft-preset-action > button {
    width: auto;
  }
}
</style>
