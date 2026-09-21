<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { buildFlightVoiceCues, flightPhaseBrief, isFlightCueDataLive } from '../../cues/flight-cues-model.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useFlightStore } from '../stores/flight.js';
import { useStatusStore } from '../stores/status.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useFlightCuesStore } from '../stores/flight-cues.js';

const controls = useAircraftControlsStore();
const flight = useFlightStore();
const status = useStatusStore();
const voice = useVoiceControlStore();
const aircraft = useAircraftSpecificStore();
const cues = useFlightCuesStore();
const now = ref(Date.now());
const restoreButton = ref(null);
const messageHeading = ref(null);
let clock = null;

const live = computed(() => isFlightCueDataLive({ status, flight, now: now.value }));
const phaseLabel = computed(() => {
  if (!status.phaseVisible) return 'Live';
  const label = String(status.phase).replaceAll('_', ' ').replaceAll('-', ' ').toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
});
const phaseBrief = computed(() => flightPhaseBrief(status.phase, { arrived: cues.arrived }));
const availableCues = computed(() => buildFlightVoiceCues({
  phase: status.phase,
  telemetry: flight.telemetry,
  catalogue: controls.aircraftCommandCatalogue,
  available: controls.availability.enabled === true,
  live: live.value,
  now: now.value,
  pendingCommands: controls.pendingCommands,
  activeProfileKey: status.aircraftProfile.profileKey,
  activeProfileRevision: aircraft.activeProfileRevision,
  aircraftSnapshot: aircraft,
  arrived: cues.arrived,
}));
const cue = computed(() => availableCues.value.find(item => !cues.dismissed.includes(`${item.id}:${item.phrase}`)) || null);
const remainingCueCount = computed(() => availableCues.value.filter(item => !cues.dismissed.includes(`${item.id}:${item.phrase}`)).length);
const cueKey = computed(() => cue.value ? `${status.phase}:${cue.value.id}:${cue.value.phrase}` : '');
const cueVisible = computed(() => Boolean(cue.value));
const quietTitle = computed(() => {
  if (!live.value) return 'Waiting for simulator data';
  return phaseBrief.value.title;
});
const voiceNote = computed(() => {
  if (voice.runtime.available !== true) return 'Use voice on the simulator PC.';
  if (voice.runtime.enabled === true && voice.runtime.shortcutRegistered === true && voice.runtime.shortcut) {
    return `Hold ${voice.runtime.shortcut} on the simulator PC to speak.`;
  }
  if (voice.runtime.enabled === true) return 'Push to talk: Aircraft on the simulator PC.';
  return 'Enable voice in Aircraft on the simulator PC.';
});

async function dismissCue() {
  if (cue.value) cues.dismiss(`${cue.value.id}:${cue.value.phrase}`);
  await nextTick();
  (messageHeading.value || restoreButton.value)?.focus?.({ preventScroll: true });
}

async function restoreCue() {
  cues.restore();
  await nextTick();
  messageHeading.value?.focus?.({ preventScroll: true });
}

onMounted(() => {
  clock = window.setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (clock !== null) window.clearInterval(clock);
});
</script>

<template>
  <section class="flight-cues-page" aria-labelledby="flight-cues-title" data-flight-cues-page>
    <header class="flight-cues-page__header">
      <h1 id="flight-cues-title">Flight cues</h1>
      <div v-if="live" class="flight-cues-page__phase ff-status-chip" role="status">
        <span class="flight-cues-page__phase-dot" aria-hidden="true"></span>
        <span>{{ phaseLabel }}</span>
      </div>
    </header>

    <div class="flight-cues-page__message" aria-live="polite" aria-atomic="true">
      <article v-if="cueVisible" :key="cueKey" class="flight-cues-card ff-card" aria-labelledby="flight-cues-message-title" data-flight-voice-cue>
        <div class="flight-cues-card__top">
          <div>
            <p class="flight-cues-card__eyebrow">{{ cue.title }}</p>
            <h2 id="flight-cues-message-title" ref="messageHeading" tabindex="-1">{{ cue.label }}</h2>
          </div>
          <button type="button" class="flight-cues-card__dismiss ff-toolbar-button ff-touch-target" @click="dismissCue">{{ remainingCueCount > 1 ? 'Next cue' : 'Dismiss' }}</button>
        </div>
        <div class="flight-cues-card__phrase">
          <span>{{ cue.kind === 'query' ? 'Ask' : 'Say' }}</span>
          <strong>“{{ cue.phrase }}”</strong>
        </div>
        <p v-if="cue.valueHint" class="flight-cues-card__note">{{ cue.valueHint }}</p>
        <p class="flight-cues-card__note">{{ voiceNote }}</p>
        <details class="flight-cues-card__details">
          <summary>Details</summary>
          <p>{{ cue.detail }}</p>
          <p v-if="cue.description"><strong>Preset changes:</strong> {{ cue.description }}</p>
          <p>Nothing is sent automatically.</p>
        </details>
      </article>

      <article v-else class="flight-cues-card ff-card flight-cues-card--quiet" aria-labelledby="flight-cues-quiet-title">
        <h2 id="flight-cues-quiet-title" ref="messageHeading" tabindex="-1">{{ quietTitle }}</h2>
        <p v-if="live && controls.availability.enabled !== true" class="flight-cues-card__note">{{ controls.availability.reason || 'Aircraft controls unavailable.' }}</p>
        <details v-if="live" class="flight-cues-card__details">
          <summary>Details</summary>
          <p>{{ phaseBrief.detail }}</p>
        </details>
      </article>
    </div>

    <button v-if="live && cues.dismissed.length" ref="restoreButton" type="button" class="flight-cues-card__restore ff-button-secondary ff-touch-target" @click="restoreCue">Restore dismissed cues</button>
  </section>
</template>

<style scoped>
.flight-cues-page {
  width: 100%;
  max-width: 48rem;
  margin-inline: auto;
  padding: 1.25rem;
}
.flight-cues-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  margin-bottom: 1rem;
}
.flight-cues-page__header h1 { margin: 0; color: rgb(var(--foreground)); font-family: var(--ff-font-display); font-size: 1.35rem; font-weight: 600; letter-spacing: -0.02em; }
.flight-cues-page__phase { gap: 0.5rem; font-size: 0.75rem; }
.flight-cues-page__phase-dot { width: 0.4rem; height: 0.4rem; flex: none; border-radius: 50%; background: rgb(var(--success)); }
.flight-cues-card { padding: 1.25rem; }
.flight-cues-card__top { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
.flight-cues-card__top > div { min-width: 0; }
.flight-cues-card__eyebrow { margin: 0 0 0.3rem; color: rgb(var(--muted-foreground)); font-size: 0.75rem; }
.flight-cues-card h2 { margin: 0; color: rgb(var(--foreground)); font-size: 1.1rem; font-weight: 600; line-height: 1.4; }
.flight-cues-card__dismiss { flex: none; min-height: var(--ff-touch-target); font-size: 0.75rem; }
.flight-cues-card__phrase { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.3rem 0.65rem; margin-top: 1rem; padding: 0.8rem; border-radius: var(--ff-radius-card); background: rgb(var(--background) / 0.5); }
.flight-cues-card__phrase span { color: rgb(var(--muted-foreground)); font-size: 0.75rem; }
.flight-cues-card__phrase strong { color: rgb(var(--foreground)); font-size: 1rem; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.flight-cues-card__note { margin: 0.65rem 0 0; color: rgb(var(--muted-foreground)); font-size: 0.8rem; line-height: 1.5; }
.flight-cues-card__details { margin-top: 0.5rem; color: rgb(var(--muted-foreground)); font-size: 0.8rem; line-height: 1.5; }
.flight-cues-card__details summary { display: list-item; width: fit-content; min-height: var(--ff-touch-target); padding-block: 0.75rem; cursor: pointer; }
.flight-cues-card__details summary:hover { color: rgb(var(--foreground)); }
.flight-cues-card__details summary:focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 2px; border-radius: var(--ff-radius-card); }
.flight-cues-card__details p { margin: 0 0 0.65rem; }
.flight-cues-card--quiet h2 { font-size: 0.95rem; font-weight: 500; }
.flight-cues-card__restore { min-height: var(--ff-touch-target); margin-top: 0.75rem; font-size: 0.75rem; }
@media (max-width: 760px) {
  .flight-cues-page { padding: 0.75rem; }
  .flight-cues-card { padding: 1rem; }
}
@media (max-width: 360px) {
  .flight-cues-card__top { flex-wrap: wrap; }
}
@media (forced-colors: active) {
  .flight-cues-card,
  .flight-cues-card__phrase { border: 1px solid CanvasText; background: Canvas; }
}
</style>
