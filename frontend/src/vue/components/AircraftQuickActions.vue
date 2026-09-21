<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { presetObservation, presetSourceUnavailableReason } from '../../aircraft/preset-observation.js';

const aircraftControls = useAircraftControlsStore();
const aircraftSpecific = useAircraftSpecificStore();
const nowMs = ref(Date.now());
let freshnessTimer;
onMounted(() => { freshnessTimer = setInterval(() => { nowMs.value = Date.now(); }, 1000); });
onUnmounted(() => clearInterval(freshnessTimer));

// Typed values for presets that take a number. Cleared when the aircraft
// context changes so a draft cannot carry over to another profile.
const drafts = reactive({});
watch(
  () => `${aircraftControls.aircraftCommandCatalogue.profileKey}:${aircraftControls.aircraftCommandCatalogue.profileRevision}`,
  () => { for (const key of Object.keys(drafts)) delete drafts[key]; },
);
const UNIT_SYMBOLS = Object.freeze({ degrees: '°', megahertz: 'MHz', feet: 'ft', knots: 'kt', percent: '%' });

function observation(command) {
  return presetObservation(command, aircraftSpecific, Math.max(nowMs.value, Date.now()));
}

function isApuStart(command) {
  return command.id === 'configuration.apu.start';
}

// Brightness presets keep their own slider component. Everything else that
// takes no input or one number renders here: exterior-light phase presets
// share one grouped card, every other preset gets its own.
const presets = computed(() => Object.values(aircraftControls.aircraftCommandCatalogue.commands || {})
  .filter((command) => command?.kind === 'preset'
    && !String(command.id).startsWith('configuration.lighting.')
    && ['none', 'number'].includes(command?.input?.kind)));
const LIGHT_PRESET_ORDER = Object.freeze(['configuration.lights.takeoff', 'configuration.lights.afterTakeoff',
  'configuration.lights.landing', 'configuration.lights.afterLanding']);
const isLightPreset = (command) => String(command?.id || '').startsWith('configuration.lights.');
const cardPresets = computed(() => presets.value.filter((command) => !isLightPreset(command)));
const lightPresets = computed(() => presets.value.filter(isLightPreset)
  .sort((left, right) => {
    const order = (command) => { const index = LIGHT_PRESET_ORDER.indexOf(command.id); return index === -1 ? LIGHT_PRESET_ORDER.length : index; };
    return order(left) - order(right) || String(left.id).localeCompare(String(right.id));
  }));

function takesNumber(command) {
  return command?.input?.kind === 'number';
}

function unitSymbol(command) {
  return UNIT_SYMBOLS[command?.input?.units] || '';
}

function draftValue(command) {
  const input = command.input;
  const text = String(drafts[command.id] ?? '').trim();
  if (!text) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < input.min || numeric > input.max) return null;
  const position = (numeric - input.min) / input.step;
  return Math.abs(position - Math.round(position)) < 1e-7 ? numeric : null;
}

function controlCommand(command) {
  return {
    type: 'canonical',
    commandId: command.id,
    input: takesNumber(command) && draftValue(command) !== null ? { value: draftValue(command) } : {},
  };
}

function isPending(command) {
  return aircraftControls.isCommandPending(controlCommand(command));
}

function sourceUnavailableReason(command) {
  return presetSourceUnavailableReason(command, aircraftSpecific,
    aircraftControls.aircraftCommandCatalogue, Math.max(nowMs.value, Date.now()));
}

function isDisabled(command) {
  return aircraftControls.isCommandDisabled(controlCommand(command))
    || Boolean(sourceUnavailableReason(command))
    || observation(command)?.inhibitsRequest === true
    || (takesNumber(command) && draftValue(command) === null);
}

function hasTypedValue(command) {
  return takesNumber(command) && String(drafts[command.id] ?? '').trim() !== '';
}

function disabledReason(command) {
  if (aircraftControls.availability.enabled !== true) return aircraftControls.availability.reason;
  if (aircraftControls.isAircraftCommandSupported(command.id) !== true) {
    return 'This preset is not available for the active aircraft.';
  }
  if (isPending(command)) return 'This preset is already being applied.';
  if (sourceUnavailableReason(command)) return sourceUnavailableReason(command);
  if (observation(command)?.inhibitsRequest === true) return observation(command).label;
  if (hasTypedValue(command) && draftValue(command) === null) {
    const { min, max, step } = command.input;
    return `Enter a value from ${min} to ${max} in steps of ${step}.`;
  }
  return '';
}

function voicePhrase(command) {
  if (typeof command?.speech?.example === 'string' && command.speech.example) return command.speech.example;
  const pattern = command?.speech?.patterns?.find((candidate) => !String(candidate).includes('{value}'));
  return typeof pattern === 'string' ? pattern : '';
}

async function applyPreset(command) {
  if (isDisabled(command)) return false;
  const sent = await aircraftControls.requestControlCommand(controlCommand(command));
  if (sent !== false && takesNumber(command)) delete drafts[command.id];
  return sent;
}

function actionLabel(command) {
  if (isPending(command)) return isApuStart(command) ? 'Requesting…' : 'Applying…';
  if (observation(command)?.inhibitsRequest === true) return 'Already active';
  if (takesNumber(command)) return 'Set both';
  if (isDisabled(command)) return 'Unavailable';
  return isApuStart(command) ? 'Start' : 'Apply';
}

function actionAriaLabel(command) {
  if (isApuStart(command)) return isPending(command) ? 'Requesting APU start' : 'Start APU';
  if (isPending(command)) return `Applying ${command.label}`;
  if (takesNumber(command) && draftValue(command) === null && !disabledReason(command)) return `Enter a value for ${command.label}`;
  if (isDisabled(command)) return `${command.label} unavailable`;
  return `Apply ${command.label}`;
}

function disabledReasonId(command) {
  return `aircraft-preset-reason-${String(command.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function inputId(command) {
  return `aircraft-preset-input-${String(command.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function inputPlaceholder(command) {
  return command.id === 'flightGuidance.course.setBoth' ? '270'
    : command.id === 'radios.nav.setBothActive' ? '110.30'
      : String(command.input?.min ?? '');
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
        v-for="command in cardPresets"
        :key="command.id"
        class="aircraft-preset-container min-w-0"
      >
        <component
          :is="takesNumber(command) ? 'form' : 'article'"
          class="aircraft-preset-card flex flex-col gap-3 rounded-xl border border-surface-200 bg-surface-50 p-3"
          :data-aircraft-preset="command.id"
          @submit.prevent="takesNumber(command) && applyPreset(command)"
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
          <div class="aircraft-preset-action flex shrink-0 items-center gap-2">
            <div v-if="takesNumber(command)" class="relative min-w-0 flex-1">
              <input
                :id="inputId(command)"
                v-model="drafts[command.id]"
                class="h-11 w-full rounded-lg border border-surface-300 bg-surface-100 px-3 pr-12 font-mono text-sm text-gray-100 disabled:opacity-45"
                type="number"
                inputmode="decimal"
                :min="command.input.min"
                :max="command.input.max"
                :step="command.input.step"
                :placeholder="inputPlaceholder(command)"
                :aria-label="`${command.label} value`"
                :disabled="isPending(command)"
                :data-aircraft-preset-input="command.id"
              />
              <span v-if="unitSymbol(command)" class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[10px] text-gray-500">{{ unitSymbol(command) }}</span>
            </div>
            <button
              :type="takesNumber(command) ? 'submit' : 'button'"
              class="min-h-11 rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-200 transition-colors hover:border-emerald-300/70 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-gray-500"
              :class="takesNumber(command) ? 'shrink-0 whitespace-nowrap' : 'w-full'"
              :disabled="isDisabled(command)"
              :title="disabledReason(command) || actionAriaLabel(command)"
              :aria-label="actionAriaLabel(command)"
              :aria-describedby="isDisabled(command) && disabledReason(command) ? disabledReasonId(command) : undefined"
              :data-aircraft-command="takesNumber(command) ? command.id : undefined"
              @click="takesNumber(command) ? undefined : applyPreset(command)"
            >
              {{ actionLabel(command) }}
            </button>
          </div>
        </component>
      </div>
      <div v-if="lightPresets.length" class="aircraft-preset-container aircraft-preset-container--lights min-w-0">
        <article
          class="aircraft-preset-group flex flex-col gap-2 rounded-xl border border-surface-200 bg-surface-50 p-3"
          aria-labelledby="aircraft-preset-group-lights-title"
          data-aircraft-preset-group="lights"
        >
          <div>
            <h3 id="aircraft-preset-group-lights-title" class="text-sm font-semibold text-gray-100">Exterior lights</h3>
            <p class="mt-1 text-xs leading-relaxed text-muted-fg">Reviewed light configurations by flight phase.</p>
          </div>
          <ul class="aircraft-preset-group__list divide-y divide-white/[0.06]">
            <li
              v-for="command in lightPresets"
              :key="command.id"
              class="aircraft-preset-row flex flex-col gap-2 py-2 first:pt-0 last:pb-0"
              :data-aircraft-preset="command.id"
            >
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h4 class="text-xs font-semibold text-gray-100">{{ command.label }}</h4>
                  <span v-if="voicePhrase(command)" class="rounded-full border border-white/10 bg-black/15 px-2 py-0.5 text-[10px] text-gray-400">
                    Say &ldquo;{{ voicePhrase(command) }}&rdquo;
                  </span>
                </div>
                <p class="mt-0.5 text-[11px] leading-relaxed text-muted-fg">{{ command.description }}</p>
                <p
                  v-if="isDisabled(command) && disabledReason(command)"
                  :id="disabledReasonId(command)"
                  class="mt-1 text-[11px] leading-relaxed text-amber-300"
                >
                  {{ disabledReason(command) }}
                </p>
              </div>
              <div class="aircraft-preset-row__action flex shrink-0 items-center">
                <button
                  type="button"
                  class="min-h-10 w-full rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-4 py-1.5 text-xs font-semibold text-emerald-200 transition-colors hover:border-emerald-300/70 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-gray-500"
                  :disabled="isDisabled(command)"
                  :title="disabledReason(command) || actionAriaLabel(command)"
                  :aria-label="actionAriaLabel(command)"
                  :aria-describedby="isDisabled(command) && disabledReason(command) ? disabledReasonId(command) : undefined"
                  @click="applyPreset(command)"
                >
                  {{ actionLabel(command) }}
                </button>
              </div>
            </li>
          </ul>
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

  .aircraft-preset-card:is(form) .aircraft-preset-action {
    width: 18rem;
  }

  .aircraft-preset-row {
    flex-direction: row;
    align-items: center;
  }

  .aircraft-preset-row__action > button {
    width: auto;
  }
}
</style>
