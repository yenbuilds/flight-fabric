<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
} from 'vue';
import {
  adjustAutopilotTargetValue,
  formatAutopilotTargetValue,
  getAutopilotTargetDefinition,
  parseAutopilotTargetDisplay,
  resolveAutopilotTargetStatus,
  validateAutopilotTargetValue,
} from '../../aircraft/autopilot-targets.js';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  mode: { type: String, default: '' },
  displayValue: { type: String, default: '---' },
  liveValue: { type: Number, default: null },
  busy: { type: Boolean, default: false },
  disabledReason: { type: String, default: '' },
  feedbackStatus: { type: String, default: 'idle' },
  feedbackCommandKey: { type: String, default: '' },
  feedbackMessage: { type: String, default: '' },
  requestApply: { type: Function, default: null },
});

const emit = defineEmits(['close']);
const panelRef = ref(null);
const inputRef = ref(null);
const draft = ref('');
const dirty = ref(false);
const submittedValue = ref(null);
const localError = ref('');
const applyingLocally = ref(false);
let repeatDelayTimer = null;
let repeatIntervalTimer = null;

const definition = computed(() => getAutopilotTargetDefinition(props.mode));
const validation = computed(() => validateAutopilotTargetValue(props.mode, draft.value));
const commandKey = computed(() => (props.mode ? `selector-set:${props.mode}` : ''));
const feedbackBelongsToEditor = computed(() => (
  Boolean(commandKey.value) && props.feedbackCommandKey === commandKey.value
));
const liveReadbackValue = computed(() => {
  const direct = validateAutopilotTargetValue(props.mode, props.liveValue);
  return direct.ok ? direct.value : null;
});
const initialNumericValue = computed(() => (
  liveReadbackValue.value ?? parseAutopilotTargetDisplay(props.mode, props.displayValue)
));
const liveDisplayValue = computed(() => formatAutopilotTargetValue(props.mode, initialNumericValue.value));
const liveValueLabel = computed(() => (liveReadbackValue.value == null ? 'Displayed' : 'Aircraft'));
const applyDisabled = computed(() => (
  !validation.value.ok
  || props.busy
  || applyingLocally.value
  || typeof props.requestApply !== 'function'
  || Boolean(props.disabledReason)
));
const statusState = computed(() => resolveAutopilotTargetStatus({
  mode: props.mode,
  busy: props.busy,
  feedbackMatches: feedbackBelongsToEditor.value,
  feedbackStatus: props.feedbackStatus,
  feedbackMessage: props.feedbackMessage,
  submittedValue: submittedValue.value,
  liveReadbackValue: liveReadbackValue.value,
  liveDisplayValue: liveDisplayValue.value,
}));

useBodyClass(() => props.open, 'ff-dialog-open');

function resetDraftFromLive() {
  const nextValue = initialNumericValue.value ?? definition.value?.defaultValue ?? 0;
  draft.value = String(nextValue);
  dirty.value = false;
  localError.value = '';
}

function focusInput() {
  nextTick(() => {
    inputRef.value?.focus?.({ preventScroll: true });
    inputRef.value?.select?.();
  });
}

watch(
  () => [props.open, props.mode],
  ([open]) => {
    stopRepeat();
    submittedValue.value = null;
    applyingLocally.value = false;
    if (!open) return;
    resetDraftFromLive();
    focusInput();
  },
  { immediate: true },
);

function updateDraft(event) {
  draft.value = event?.target?.value ?? '';
  dirty.value = true;
  localError.value = '';
}

function releaseNumericInputForScroll(event) {
  event?.currentTarget?.blur?.();
}

function adjustDraft(delta) {
  const nextValue = adjustAutopilotTargetValue(props.mode, draft.value, delta);
  if (nextValue == null) return;
  draft.value = String(nextValue);
  dirty.value = true;
  localError.value = '';
}

function stopRepeat() {
  if (repeatDelayTimer != null) {
    clearTimeout(repeatDelayTimer);
    repeatDelayTimer = null;
  }
  if (repeatIntervalTimer != null) {
    clearInterval(repeatIntervalTimer);
    repeatIntervalTimer = null;
  }
}

function startRepeat(event, delta) {
  if (event?.button != null && event.button !== 0) return;
  event?.preventDefault?.();
  stopRepeat();
  adjustDraft(delta);
  repeatDelayTimer = setTimeout(() => {
    repeatDelayTimer = null;
    repeatIntervalTimer = setInterval(() => adjustDraft(delta), 120);
  }, 420);
}

async function applyTarget() {
  localError.value = '';
  if (!validation.value.ok) {
    localError.value = validation.value.error;
    inputRef.value?.focus?.({ preventScroll: true });
    return;
  }
  if (applyDisabled.value) return;

  submittedValue.value = validation.value.value;
  applyingLocally.value = true;
  try {
    const sent = await props.requestApply({
      mode: props.mode,
      value: validation.value.value,
    });
    if (sent !== false) return;
    localError.value = 'The command could not be sent. Check the connection and active aircraft profile.';
  } catch {
    localError.value = 'The command could not be sent. Check the connection and active aircraft profile.';
  } finally {
    applyingLocally.value = false;
  }
}

function closeEditor() {
  stopRepeat();
  emit('close');
}

function handleKeydown(event) {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeEditor();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(panelRef.value?.querySelectorAll?.(
    'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ) || []);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

useDocumentEvent('keydown', handleKeydown);
onBeforeUnmount(stopRepeat);
</script>

<template>
  <div
    v-if="open && definition"
    class="autopilot-target-overlay ff-keyboard-safe-overlay"
    data-no-swipe
    @click.self="closeEditor"
  >
    <section
      ref="panelRef"
      class="autopilot-target-panel"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="`autopilot-target-title-${mode}`"
    >
      <header class="autopilot-target-header">
        <div class="min-w-0">
          <div class="controls-kicker">One-thumb tuner</div>
          <h2 :id="`autopilot-target-title-${mode}`" class="mt-1 text-lg font-semibold text-gray-100">
            {{ definition.label }}
          </h2>
        </div>
        <button type="button" class="modal-close-button ff-touch-target" aria-label="Close target editor" @click="closeEditor">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div class="autopilot-target-body ff-scroll-y">
        <div class="autopilot-target-live" aria-live="polite">
          <span>{{ liveValueLabel }}</span>
          <strong>{{ liveDisplayValue }}</strong>
          <span>{{ definition.units }}</span>
        </div>

        <div>
          <label :for="`autopilot-target-input-${mode}`" class="autopilot-target-label">Target</label>
          <div class="autopilot-target-input-row">
            <input
              :id="`autopilot-target-input-${mode}`"
              ref="inputRef"
              type="number"
              :value="draft"
              :min="definition.min"
              :max="definition.max"
              :step="definition.step"
              :inputmode="definition.inputMode"
              enterkeyhint="done"
              autocomplete="off"
              :aria-invalid="(!validation.ok || localError) ? 'true' : 'false'"
              :aria-describedby="`autopilot-target-help-${mode} autopilot-target-status-${mode}`"
              @input="updateDraft"
              @wheel="releaseNumericInputForScroll"
              @keydown.enter.prevent="applyTarget"
            >
            <span>{{ definition.units }}</span>
          </div>
          <div :id="`autopilot-target-help-${mode}`" class="autopilot-target-help">
            {{ definition.min.toLocaleString() }}–{{ definition.max.toLocaleString() }} in {{ definition.step.toLocaleString() }} {{ definition.units }} increments
          </div>
        </div>

        <div class="autopilot-target-adjustments" aria-label="Adjust target">
          <button
            type="button"
            class="autopilot-target-adjust autopilot-target-adjust--coarse"
            :aria-label="`Decrease by ${definition.coarseStep} ${definition.units}`"
            @pointerdown="startRepeat($event, -definition.coarseStep)"
            @pointerup="stopRepeat"
            @pointercancel="stopRepeat"
            @pointerleave="stopRepeat"
            @keydown.enter.prevent="adjustDraft(-definition.coarseStep)"
            @keydown.space.prevent="adjustDraft(-definition.coarseStep)"
          >
            <span>−{{ definition.coarseStep.toLocaleString() }}</span>
            <small>COARSE</small>
          </button>
          <button
            type="button"
            class="autopilot-target-adjust"
            :aria-label="`Decrease by ${definition.fineStep} ${definition.units}`"
            @pointerdown="startRepeat($event, -definition.fineStep)"
            @pointerup="stopRepeat"
            @pointercancel="stopRepeat"
            @pointerleave="stopRepeat"
            @keydown.enter.prevent="adjustDraft(-definition.fineStep)"
            @keydown.space.prevent="adjustDraft(-definition.fineStep)"
          >
            <span>−{{ definition.fineStep.toLocaleString() }}</span>
            <small>FINE</small>
          </button>
          <button
            type="button"
            class="autopilot-target-adjust"
            :aria-label="`Increase by ${definition.fineStep} ${definition.units}`"
            @pointerdown="startRepeat($event, definition.fineStep)"
            @pointerup="stopRepeat"
            @pointercancel="stopRepeat"
            @pointerleave="stopRepeat"
            @keydown.enter.prevent="adjustDraft(definition.fineStep)"
            @keydown.space.prevent="adjustDraft(definition.fineStep)"
          >
            <span>+{{ definition.fineStep.toLocaleString() }}</span>
            <small>FINE</small>
          </button>
          <button
            type="button"
            class="autopilot-target-adjust autopilot-target-adjust--coarse"
            :aria-label="`Increase by ${definition.coarseStep} ${definition.units}`"
            @pointerdown="startRepeat($event, definition.coarseStep)"
            @pointerup="stopRepeat"
            @pointercancel="stopRepeat"
            @pointerleave="stopRepeat"
            @keydown.enter.prevent="adjustDraft(definition.coarseStep)"
            @keydown.space.prevent="adjustDraft(definition.coarseStep)"
          >
            <span>+{{ definition.coarseStep.toLocaleString() }}</span>
            <small>COARSE</small>
          </button>
        </div>

        <button type="button" class="autopilot-target-current ff-touch-target" @click="resetDraftFromLive">
          Reset to live target
        </button>

        <p v-if="localError || (!validation.ok && dirty)" class="autopilot-target-error" role="alert">
          {{ localError || validation.error }}
        </p>
        <p v-else-if="disabledReason" class="autopilot-target-error" role="status">{{ disabledReason }}</p>

        <div
          :id="`autopilot-target-status-${mode}`"
          class="autopilot-target-status"
          :class="`is-${statusState.tone}`"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span class="autopilot-target-status-dot" aria-hidden="true"></span>
          <span>{{ statusState.text }}</span>
        </div>
      </div>

      <footer class="autopilot-target-footer">
        <button type="button" class="ff-button-secondary ff-touch-target" @click="closeEditor">Close</button>
        <button
          type="button"
          class="ff-button-primary ff-touch-target autopilot-target-apply"
          :disabled="applyDisabled"
          :aria-busy="busy || applyingLocally ? 'true' : 'false'"
          @click="applyTarget"
        >
          {{ busy || applyingLocally ? 'Sending…' : `Apply ${definition.shortLabel}` }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.autopilot-target-overlay {
  z-index: 120;
  display: grid;
  align-items: end;
  padding: max(0.5rem, env(safe-area-inset-top, 0px)) max(0.5rem, env(safe-area-inset-right, 0px)) max(0.5rem, env(safe-area-inset-bottom, 0px)) max(0.5rem, env(safe-area-inset-left, 0px));
  background: rgb(0 0 0 / 0.72);
}

.autopilot-target-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(100%, 34rem);
  max-height: calc(var(--ff-visual-viewport-height, 100dvh) - 1rem);
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid rgb(var(--border-strong) / 0.78);
  border-radius: 14px 14px 8px 8px;
  background: rgb(var(--panel) / 0.995);
  box-shadow: 0 -24px 70px rgb(0 0 0 / 0.62);
}

.autopilot-target-header,
.autopilot-target-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.8rem 0.9rem;
  background: rgb(var(--panel-elevated) / 0.42);
}

.autopilot-target-header {
  border-bottom: 1px solid rgb(var(--border) / 0.72);
}

.autopilot-target-footer {
  border-top: 1px solid rgb(var(--border) / 0.72);
  padding-bottom: max(0.8rem, env(safe-area-inset-bottom, 0px));
}

.autopilot-target-footer > button {
  flex: 1 1 0;
}

.autopilot-target-body {
  display: grid;
  gap: 1rem;
  min-height: 0;
  padding: 1rem;
  overflow-y: auto;
}

.autopilot-target-live {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: baseline;
  gap: 0.55rem;
  padding: 0.75rem 0.85rem;
  border: 1px solid rgb(var(--border) / 0.7);
  border-radius: 8px;
  background: rgb(var(--panel-subtle) / 0.82);
  color: rgb(var(--muted-foreground));
  font-family: var(--ff-font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.autopilot-target-live strong {
  color: rgb(var(--foreground));
  font-size: 1.35rem;
  letter-spacing: 0;
}

.autopilot-target-label {
  display: block;
  margin-bottom: 0.4rem;
  color: rgb(var(--muted-foreground));
  font-family: var(--ff-font-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.autopilot-target-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  min-height: 4rem;
  padding: 0.35rem 0.8rem;
  border: 1px solid rgb(var(--primary) / 0.52);
  border-radius: 10px;
  background: rgb(var(--background) / 0.86);
  box-shadow: inset 0 0 0 1px rgb(var(--primary) / 0.06);
}

.autopilot-target-input-row input {
  min-width: 0;
  border: 0 !important;
  outline: 0;
  background: transparent !important;
  color: rgb(var(--foreground));
  font-family: var(--ff-font-mono);
  font-size: clamp(1.65rem, 8vw, 2.3rem) !important;
  font-weight: 700;
  text-align: right;
}

.autopilot-target-input-row > span {
  color: rgb(var(--primary));
  font-family: var(--ff-font-mono);
  font-size: 0.78rem;
  font-weight: 700;
}

.autopilot-target-help {
  margin-top: 0.4rem;
  color: rgb(var(--muted-foreground));
  font-size: 0.7rem;
}

.autopilot-target-adjustments {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
  touch-action: manipulation;
}

.autopilot-target-adjust {
  display: grid;
  min-height: 4.25rem;
  place-content: center;
  gap: 0.2rem;
  border: 1px solid rgb(var(--border-strong) / 0.76);
  border-radius: 10px;
  background: rgb(var(--panel-elevated) / 0.62);
  color: rgb(var(--foreground));
  font-family: var(--ff-font-mono);
  font-size: 1.18rem;
  font-weight: 750;
  user-select: none;
  -webkit-user-select: none;
}

.autopilot-target-adjust--coarse {
  border-color: rgb(var(--primary) / 0.38);
  background: rgb(var(--primary) / 0.09);
}

.autopilot-target-adjust:active {
  border-color: rgb(var(--primary) / 0.72);
  background: rgb(var(--primary) / 0.17);
  transform: scale(0.985);
}

.autopilot-target-adjust small {
  color: rgb(var(--muted-foreground));
  font-size: 0.58rem;
  letter-spacing: 0.14em;
}

.autopilot-target-current {
  justify-self: stretch;
  border: 1px solid rgb(var(--border) / 0.75);
  border-radius: 8px;
  background: rgb(var(--panel-subtle) / 0.72);
  color: rgb(var(--gray-300));
  font-size: 0.78rem;
  font-weight: 650;
}

.autopilot-target-error {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border: 1px solid rgb(var(--danger) / 0.38);
  border-radius: 8px;
  background: rgb(var(--danger) / 0.08);
  color: rgb(var(--danger));
  font-size: 0.75rem;
}

.autopilot-target-status {
  display: flex;
  min-height: 2.75rem;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid rgb(var(--border) / 0.7);
  border-radius: 8px;
  color: rgb(var(--muted-foreground));
  font-size: 0.75rem;
}

.autopilot-target-status-dot {
  width: 0.55rem;
  height: 0.55rem;
  flex: 0 0 auto;
  border-radius: 9999px;
  background: rgb(var(--gray-600));
}

.autopilot-target-status.is-sending,
.autopilot-target-status.is-waiting {
  border-color: rgb(var(--warning) / 0.34);
  color: rgb(var(--warning));
}

.autopilot-target-status.is-sending .autopilot-target-status-dot,
.autopilot-target-status.is-waiting .autopilot-target-status-dot {
  background: rgb(var(--warning));
}

.autopilot-target-status.is-confirmed {
  border-color: rgb(var(--success) / 0.38);
  color: rgb(var(--success));
}

.autopilot-target-status.is-confirmed .autopilot-target-status-dot {
  background: rgb(var(--success));
}

.autopilot-target-status.is-failed {
  border-color: rgb(var(--danger) / 0.42);
  color: rgb(var(--danger));
}

.autopilot-target-status.is-failed .autopilot-target-status-dot {
  background: rgb(var(--danger));
}

.autopilot-target-apply {
  font-weight: 750;
}

@media (min-width: 700px) and (min-height: 620px) {
  .autopilot-target-overlay {
    align-items: center;
  }

  .autopilot-target-panel {
    border-radius: 12px;
  }
}

@media (max-height: 520px) and (pointer: coarse) {
  .autopilot-target-panel {
    width: min(100%, 46rem);
  }

  .autopilot-target-body {
    grid-template-columns: minmax(12rem, 0.9fr) minmax(18rem, 1.1fr);
    align-items: start;
  }

  .autopilot-target-adjustments {
    grid-column: 2;
    grid-row: 1 / span 3;
  }

  .autopilot-target-current,
  .autopilot-target-error,
  .autopilot-target-status {
    grid-column: 1;
  }
}
</style>
