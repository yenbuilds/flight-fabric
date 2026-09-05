<script setup>
import { computed, nextTick, ref } from 'vue';
import { resolveAircraftSpecificTemplate } from '../aircraft-specific/template-registry.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import AircraftIntegrationCheatSheetModal from './AircraftIntegrationCheatSheetModal.vue';
import AircraftPageSearch from './AircraftPageSearch.vue';
import AircraftQuickActions from './AircraftQuickActions.vue';
import AircraftSpecificSection from './aircraft-specific/AircraftSpecificSection.vue';
import AircraftVoiceControlModal from './AircraftVoiceControlModal.vue';
import AutopilotControlsTab from './AutopilotControlsTab.vue';

const aircraftSpecific = useAircraftSpecificStore();
const voice = useVoiceControlStore();
const searchableContent = ref(null);
const integrationGuideButton = ref(null);
const voiceControlButton = ref(null);
const integrationCheatSheetOpen = ref(false);
const integrationCheatSheetFilter = ref('all');
const integrationGuideReturnTarget = ref(null);
const voiceControlOpen = ref(false);
const searchExpanded = ref(false);

// A trusted profile template owns the Aircraft page even while its live data is
// awaiting, stale, or disconnected. Falling back based on transient source
// health would make the page jump between two unrelated control surfaces.
const hasResolvedAircraftTemplate = computed(() => Boolean(
  aircraftSpecific.hasTemplate
  && resolveAircraftSpecificTemplate(aircraftSpecific.templateId),
));
const MOBILE_RIBBON_TEMPLATES = Object.freeze([
  'fbw-a32nx',
  'fbw-a380x',
  'fenix-a32x',
  'inibuilds-a350',
  'pmdg-737',
  'pmdg-777',
]);
const usesAircraftMobileRibbon = computed(() => (
  !hasResolvedAircraftTemplate.value
  || MOBILE_RIBBON_TEMPLATES.includes(aircraftSpecific.templateId)
));
const VOICE_ATTENTION_STATUSES = Object.freeze(new Set([
  'error',
  'failed',
  'blocked',
  'unavailable',
  'unmatched',
]));

const voiceLauncherState = computed(() => {
  if (voice.status === 'disabled') return 'off';
  if (voice.status === 'listening') return 'listening';
  if (voice.finishing || ['initializing', 'starting', 'sending'].includes(voice.status)) return 'busy';
  if (VOICE_ATTENTION_STATUSES.has(voice.status)) return 'attention';
  if (voice.ready) return 'ready';
  return 'attention';
});

const voiceLauncherStatus = computed(() => {
  if (voice.status === 'disabled') return 'Off';
  if (voice.status === 'listening') return 'Listening';
  if (voice.finishing) return 'Processing';
  if (['initializing', 'starting'].includes(voice.status)) return 'Starting';
  if (voice.status === 'sending') return 'Sending';
  if (voice.status === 'sent') return 'Command sent';
  if (voice.status === 'failed') return 'Command failed';
  if (voice.status === 'error') return 'Needs attention';
  if (voice.status === 'unmatched') return 'Try again';
  if (voice.status === 'transcribed') return 'Transcribed';
  if (voiceLauncherState.value === 'ready') return 'Ready';
  return 'Check setup';
});

function openIntegrationGuide(filter = 'all', returnTarget = integrationGuideButton.value) {
  integrationCheatSheetFilter.value = filter;
  integrationGuideReturnTarget.value = returnTarget;
  integrationCheatSheetOpen.value = true;
}

function closeIntegrationGuide() {
  integrationCheatSheetOpen.value = false;
  const returnTarget = integrationGuideReturnTarget.value;
  nextTick(() => returnTarget?.focus?.({ preventScroll: true }));
}

function closeVoiceControl() {
  voiceControlOpen.value = false;
  nextTick(() => voiceControlButton.value?.focus?.({ preventScroll: true }));
}

function openVoiceCommandGuide() {
  voiceControlOpen.value = false;
  nextTick(() => openIntegrationGuide('voice', voiceControlButton.value));
}
</script>

<template>
  <div
    class="aircraft-tab-shell"
    :data-aircraft-page-mode="hasResolvedAircraftTemplate ? 'specific' : 'generic'"
    :data-mobile-aircraft-navigation="usesAircraftMobileRibbon ? 'section-ribbon' : 'search'"
  >
    <div ref="searchableContent" class="aircraft-tab-search-content">
      <div class="aircraft-page-tools">
        <div
          class="aircraft-page-tool-actions"
          :class="{ 'aircraft-page-tool-actions--search-expanded': searchExpanded }"
        >
          <button
            ref="integrationGuideButton"
            type="button"
            class="aircraft-integration-guide-button ff-touch-target"
            aria-haspopup="dialog"
            aria-controls="aircraft-integration-cheatsheet-modal"
            :aria-expanded="integrationCheatSheetOpen"
            data-aircraft-integration-guide-trigger
            @click="openIntegrationGuide()"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Zm16 0A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z" />
            </svg>
            <span>Integration guide</span>
          </button>
          <button
            ref="voiceControlButton"
            type="button"
            class="aircraft-voice-control-button ff-touch-target"
            :data-voice-state="voiceLauncherState"
            aria-haspopup="dialog"
            aria-controls="aircraft-voice-control-modal"
            :aria-expanded="voiceControlOpen"
            :aria-label="`Open voice control, ${voiceLauncherStatus}`"
            data-aircraft-voice-control-trigger
            @click="voiceControlOpen = true"
          >
            <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="2.5" width="6" height="12" rx="3" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
            </svg>
            <span class="aircraft-voice-control-button__copy">
              <span>Voice control</span>
              <span class="aircraft-voice-control-button__status">
                <span class="aircraft-voice-control-button__dot" aria-hidden="true" />
                {{ voiceLauncherStatus }}
              </span>
            </span>
          </button>
          <AircraftPageSearch
            :target="searchableContent"
            :content-key="`${hasResolvedAircraftTemplate ? 'specific' : 'generic'}:${aircraftSpecific.activeProfileKey || aircraftSpecific.templateId || ''}`"
            :hide-on-mobile="hasResolvedAircraftTemplate && usesAircraftMobileRibbon"
            @expanded-change="searchExpanded = $event"
          />
        </div>
        <AircraftQuickActions class="aircraft-page-presets" />
      </div>
      <AircraftSpecificSection v-if="hasResolvedAircraftTemplate" />
      <AutopilotControlsTab v-else />
    </div>
    <AircraftIntegrationCheatSheetModal
      :open="integrationCheatSheetOpen"
      :initial-filter="integrationCheatSheetFilter"
      @close="closeIntegrationGuide"
    />
    <AircraftVoiceControlModal
      :open="voiceControlOpen"
      @close="closeVoiceControl"
      @open-guide="openVoiceCommandGuide"
    />
  </div>
</template>

<style scoped>
.aircraft-page-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.aircraft-page-tool-actions {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 0.625rem;
}

.aircraft-page-tool-actions--search-expanded {
  align-items: flex-start;
}

.aircraft-page-tool-actions > .aircraft-find {
  min-width: 0;
  margin-left: auto;
}

.aircraft-page-tool-actions > .aircraft-find--expanded {
  width: auto;
  max-width: none;
  flex: 1 1 28rem;
}

.aircraft-integration-guide-button,
.aircraft-voice-control-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 3.75rem;
  padding: 0 1.1rem;
  border: 1px solid rgb(var(--color-accent, 0 212 255) / 0.38);
  border-radius: 9999px;
  background: rgb(var(--color-accent, 0 212 255) / 0.07);
  color: rgb(var(--color-accent, 0 212 255));
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
  transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
}

.aircraft-integration-guide-button:hover,
.aircraft-voice-control-button:hover {
  border-color: rgb(var(--color-accent, 0 212 255) / 0.65);
  background: rgb(var(--color-accent, 0 212 255) / 0.13);
  color: white;
}

.aircraft-voice-control-button {
  min-width: 8.75rem;
  text-align: left;
}

.aircraft-voice-control-button__copy {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.aircraft-voice-control-button__status {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.25rem;
  color: rgb(156 163 175);
  font-size: 0.625rem;
  font-weight: 500;
}

.aircraft-voice-control-button__dot {
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 9999px;
  background: rgb(52 211 153);
}

.aircraft-voice-control-button[data-voice-state='off'] .aircraft-voice-control-button__dot {
  background: rgb(107 114 128);
}

.aircraft-voice-control-button[data-voice-state='listening'] {
  border-color: rgb(248 113 113 / 0.65);
  background: rgb(127 29 29 / 0.22);
  color: rgb(254 202 202);
}

.aircraft-voice-control-button[data-voice-state='listening'] .aircraft-voice-control-button__dot {
  background: rgb(248 113 113);
  animation: voice-launcher-pulse 1.2s ease-in-out infinite;
}

.aircraft-voice-control-button[data-voice-state='busy'] .aircraft-voice-control-button__dot {
  background: rgb(125 211 252);
}

.aircraft-voice-control-button[data-voice-state='attention'] {
  border-color: rgb(251 191 36 / 0.38);
  background: rgb(120 53 15 / 0.12);
  color: rgb(252 211 77);
}

.aircraft-voice-control-button[data-voice-state='attention'] .aircraft-voice-control-button__dot {
  background: rgb(251 191 36);
}

@keyframes voice-launcher-pulse {
  50% { opacity: 0.35; }
}

.aircraft-page-presets {
  width: 100%;
  min-width: 0;
}

@media (max-width: 1100px) {
  .aircraft-page-tool-actions {
    flex-wrap: wrap;
  }

  .aircraft-page-tool-actions--search-expanded > .aircraft-find {
    order: 2;
    width: 100%;
    max-width: none;
    flex-basis: 100%;
    margin-left: 0;
  }
}

@media (max-width: 760px), (max-height: 500px) and (pointer: coarse) {
  .aircraft-page-tool-actions {
    align-items: stretch;
    justify-content: flex-start;
    gap: 0.5rem;
  }

  .aircraft-voice-control-button {
    display: none;
  }

  .aircraft-integration-guide-button {
    min-height: 3rem;
    padding-inline: 0.9rem;
  }

  .aircraft-page-tool-actions--search-expanded
    .aircraft-integration-guide-button {
    display: none;
  }

  .aircraft-page-tool-actions--search-expanded > .aircraft-find {
    order: initial;
  }
}
</style>
