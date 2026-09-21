<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { resolveAircraftSpecificTemplate } from '../aircraft-specific/template-registry.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { AIRCRAFT_PAGE_SECTIONS } from './aircraft-specific/aircraft-page-sections.js';
import AircraftIntegrationCheatSheetModal from './AircraftIntegrationCheatSheetModal.vue';
import AircraftPageSearch from './AircraftPageSearch.vue';
import AircraftPresets from './AircraftPresets.vue';
import AircraftAvionics from './AircraftAvionics.vue';
import ExteriorLightControls from './ExteriorLightControls.vue';
import AircraftControlsModal from './AircraftControlsModal.vue';
import AircraftCduModal from './AircraftCduModal.vue';
import AircraftSpecificSection from './aircraft-specific/AircraftSpecificSection.vue';
import AircraftVoiceControlModal from './AircraftVoiceControlModal.vue';
import AutopilotControlsTab from './AutopilotControlsTab.vue';
import AutotaxiPanel from './aircraft-specific/AutotaxiPanel.vue';
import { getFlightFabricAppSettings } from '../../settings/shared-runtime.js';

const { LIVE_AUTOTAXI_ENABLED } = getFlightFabricAppSettings();
const aircraftSpecific = useAircraftSpecificStore();
const voice = useVoiceControlStore();
const controls = useAircraftControlsStore();
const avionicsPlacement = {
  'pmdg-737': 'radios', 'pmdg-777': 'mcp', 'fenix-a32x': 'fcu',
  'fbw-a32nx': 'fcu', 'fbw-a380x': 'fcu-autopilot', 'inibuilds-a350': 'a350-fcu',
};
const hasStructuredLayout = computed(() => hasResolvedAircraftTemplate.value
  && Object.hasOwn(avionicsPlacement, aircraftSpecific.templateId));
const pageSections = computed(() => [
  ...(Object.values(controls.aircraftCommandCatalogue.commands || {}).some(command => command.kind === 'preset')
    ? [{ id: 'page-presets', label: 'Presets', title: 'Presets', targetId: 'aircraft-page-presets' }] : []),
  ...(LIVE_AUTOTAXI_ENABLED
    ? [{ id: 'page-autotaxi', label: 'Taxi', title: 'Autotaxi', detail: 'Taxi to a runway holding point or stand.', targetId: 'aircraft-page-autotaxi' }] : []),
  ...(['radios.com1.setStandby', 'radios.com2.setStandby', 'baro.both.qnhHpa',
    'surveillance.squawk.set', 'surveillance.ident.activate', 'approach.minimums.baro',
    'navigation.captain.range', 'navigation.firstOfficer.range'].some(id => controls.isAircraftCommandSupported(id))
    ? [{ id: 'page-avionics', label: 'Radios / approach', title: 'Radios & approach',
      targetId: 'aircraft-page-avionics', after: avionicsPlacement[aircraftSpecific.templateId] || 'radios' }] : []),
]);
provide(AIRCRAFT_PAGE_SECTIONS, pageSections);
const searchableContent = ref(null);
const integrationGuideButton = ref(null);
const voiceControlButton = ref(null);
const integrationCheatSheetOpen = ref(false);
const integrationCheatSheetFilter = ref('all');
const integrationGuideReturnTarget = ref(null);
const voiceControlOpen = ref(false);
const searchExpanded = ref(false);
const secondaryTools = ref(null);
const secondaryToolsButton = ref(null);
const secondaryToolsOpen = ref(false);
const compactTools = ref(false);
let compactToolsMedia = null;
const controlsModalOpen = ref(false);
const controlsButton = ref(null);
const cduOpen = ref(false), cduButton = ref(null);
const hasCdu = computed(() => ['fenix-a32x', 'fbw-a32nx', 'pmdg-737', 'pmdg-777'].includes(aircraftSpecific.templateId));
function closeCdu() { cduOpen.value = false; nextTick(() => cduButton.value?.focus?.({ preventScroll: true })); }
function closeControlsModal() {
  controlsModalOpen.value = false;
  restoreToolFocus(controlsButton.value);
}

function restoreToolFocus(target) {
  nextTick(() => {
    const visibleTarget = [target, secondaryToolsButton.value]
      .find(element => element?.isConnected && element.getClientRects().length > 0);
    visibleTarget?.focus({ preventScroll: true });
  });
}

function closeSecondaryTools({ restoreFocus = false } = {}) {
  secondaryToolsOpen.value = false;
  if (restoreFocus) restoreToolFocus(secondaryToolsButton.value);
}

function syncCompactTools() {
  const previousFocus = document.activeElement;
  const focusWasInTools = secondaryTools.value?.contains(previousFocus);
  compactTools.value = compactToolsMedia?.matches === true;
  closeSecondaryTools();
  if (focusWasInTools) nextTick(() => {
    if (previousFocus?.getClientRects().length === 0
      && (document.activeElement === previousFocus || document.activeElement === document.body)) {
      restoreToolFocus(compactTools.value ? secondaryToolsButton.value : integrationGuideButton.value);
    }
  });
}

function handleToolsFocusout(event) {
  // Native pointer focus briefly passes through the body before reaching a
  // tool. Keep that internal move open until its click can launch the dialog.
  if (secondaryTools.value?.contains(event.relatedTarget)) return;
  nextTick(() => {
    if (!secondaryTools.value?.contains(document.activeElement)) closeSecondaryTools();
  });
}

function openControlsModal() {
  closeSecondaryTools();
  controlsModalOpen.value = true;
}

function openVoiceControl() {
  closeSecondaryTools();
  voiceControlOpen.value = true;
}

onMounted(() => {
  compactToolsMedia = window.matchMedia('(max-width: 1100px), (max-height: 500px) and (pointer: coarse)');
  compactToolsMedia.addEventListener('change', syncCompactTools);
  syncCompactTools();
});
onBeforeUnmount(() => compactToolsMedia?.removeEventListener('change', syncCompactTools));
useDocumentEvent('pointerdown', event => {
  if (!secondaryTools.value?.contains(event.target)) closeSecondaryTools();
});
useDocumentEvent('keydown', event => {
  if (event.defaultPrevented || event.key !== 'Escape' || !secondaryToolsOpen.value) return;
  event.preventDefault();
  closeSecondaryTools({ restoreFocus: true });
});

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
  closeSecondaryTools();
  integrationCheatSheetFilter.value = filter;
  integrationGuideReturnTarget.value = returnTarget;
  integrationCheatSheetOpen.value = true;
}

function closeIntegrationGuide() {
  integrationCheatSheetOpen.value = false;
  const returnTarget = integrationGuideReturnTarget.value;
  restoreToolFocus(returnTarget);
}

function closeVoiceControl() {
  voiceControlOpen.value = false;
  restoreToolFocus(voiceControlButton.value);
}

function openVoiceCommandGuide() {
  voiceControlOpen.value = false;
  nextTick(() => openIntegrationGuide('voice', voiceControlButton.value));
}
</script>

<template>
  <div
    class="aircraft-tab-shell"
    :class="{ 'aircraft-tab-shell--finding': searchExpanded }"
    :data-aircraft-page-mode="hasResolvedAircraftTemplate ? 'specific' : 'generic'"
    :data-mobile-aircraft-navigation="usesAircraftMobileRibbon ? 'section-ribbon' : 'search'"
  >
    <div ref="searchableContent" class="aircraft-tab-search-content">
      <div class="aircraft-page-tools" aria-label="Aircraft tools">
        <h2 class="aircraft-page-title">Aircraft</h2>
        <div
          class="aircraft-page-tool-actions"
          :class="{ 'aircraft-page-tool-actions--search-expanded': searchExpanded }"
        >
          <AircraftPageSearch
            :target="searchableContent"
            :content-key="`${hasResolvedAircraftTemplate ? 'specific' : 'generic'}:${aircraftSpecific.activeProfileKey || aircraftSpecific.templateId || ''}`"
            @expanded-change="searchExpanded = $event"
          />
          <button v-if="hasCdu" ref="cduButton" type="button" class="aircraft-integration-guide-button ff-touch-target"
            aria-haspopup="dialog" :aria-expanded="cduOpen" data-cdu-trigger aria-label="Open MCDU / CDU" @click="cduOpen = true">
            <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <path d="M7.5 6.5h9v4.5h-9zM7.5 14.5h1.5M11.25 14.5h1.5M15 14.5h1.5M7.5 17.5h1.5M11.25 17.5h1.5M15 17.5h1.5" />
            </svg>
            <span class="aircraft-cdu-label">MCDU / CDU</span><span class="aircraft-cdu-short-label" aria-hidden="true">CDU</span>
          </button>
          <div ref="secondaryTools" class="aircraft-secondary-tools" @focusout="handleToolsFocusout" data-no-swipe>
            <button ref="secondaryToolsButton" type="button" class="aircraft-tools-toggle"
              :aria-expanded="secondaryToolsOpen" aria-controls="aircraft-secondary-tools-panel"
              @click="secondaryToolsOpen = !secondaryToolsOpen">
              <span>Tools</span><span aria-hidden="true">⌄</span>
            </button>
            <div id="aircraft-secondary-tools-panel" class="aircraft-secondary-tools-panel" v-show="!compactTools || secondaryToolsOpen">
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
                @click="openVoiceControl"
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
              <button ref="controlsButton" type="button" class="aircraft-integration-guide-button ff-touch-target"
                aria-haspopup="dialog" aria-controls="aircraft-controls-modal" :aria-expanded="controlsModalOpen"
                data-aircraft-controls-trigger @click="openControlsModal">Control library</button>
            </div>
          </div>
        </div>
      </div>
      <AircraftPresets v-if="hasResolvedAircraftTemplate && !hasStructuredLayout" class="mb-5" />
      <AutotaxiPanel v-if="LIVE_AUTOTAXI_ENABLED && hasResolvedAircraftTemplate && !hasStructuredLayout" id="aircraft-page-autotaxi" class="aircraft-mobile-navigable-section mb-5" tabindex="-1" />
      <AircraftSpecificSection v-if="hasResolvedAircraftTemplate">
        <template #presets>
          <AircraftPresets />
          <AutotaxiPanel v-if="LIVE_AUTOTAXI_ENABLED && hasStructuredLayout" id="aircraft-page-autotaxi" class="aircraft-mobile-navigable-section" tabindex="-1" />
        </template>
        <template #avionics><AircraftAvionics /></template>
      </AircraftSpecificSection>
      <AutopilotControlsTab v-else>
        <template #page-tasks>
          <AircraftPresets />
          <AutotaxiPanel v-if="LIVE_AUTOTAXI_ENABLED" id="aircraft-page-autotaxi" class="aircraft-mobile-navigable-section" tabindex="-1" />
        </template>
      </AutopilotControlsTab>
      <AircraftAvionics v-if="!hasStructuredLayout" class="mt-5" />
      <ExteriorLightControls v-if="!hasResolvedAircraftTemplate" class="mt-5" />
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
    <AircraftControlsModal :open="controlsModalOpen" @close="closeControlsModal" />
    <AircraftCduModal :open="cduOpen" @close="closeCdu" />
  </div>
</template>

<style scoped>
.aircraft-page-tools {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid rgb(var(--border) / 0.55);
}

.aircraft-page-title {
  margin: 0;
  color: rgb(var(--foreground));
  font-size: 1rem;
  font-weight: 650;
}

.aircraft-page-tool-actions {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 0.4rem;
}

.aircraft-page-tool-actions--search-expanded {
  align-items: flex-start;
}

.aircraft-page-tool-actions > .aircraft-find {
  min-width: 0;
  margin-left: auto;
}

.aircraft-secondary-tools,
.aircraft-secondary-tools-panel {
  display: contents;
}

.aircraft-secondary-tools > .aircraft-tools-toggle,
.aircraft-cdu-short-label {
  display: none;
}

.aircraft-page-tool-actions > .aircraft-find--expanded {
  width: auto;
  max-width: none;
  flex: 1 1 28rem;
}

.aircraft-integration-guide-button,
.aircraft-voice-control-button,
.aircraft-tools-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0.4rem 0.7rem;
  border: 1px solid rgb(var(--border) / 0.65);
  border-radius: 6px;
  background: rgb(var(--panel) / 0.7);
  color: rgb(var(--foreground));
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
  transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
}

.aircraft-integration-guide-button:hover,
.aircraft-voice-control-button:hover,
.aircraft-tools-toggle:hover {
  border-color: rgb(var(--border-strong) / 0.8);
  background: rgb(var(--panel-elevated) / 0.7);
  color: rgb(var(--foreground));
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
  color: rgb(var(--muted-foreground));
  font-size: 0.625rem;
  font-weight: 500;
}

.aircraft-voice-control-button__dot {
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 9999px;
  background: rgb(var(--success));
}

.aircraft-voice-control-button[data-voice-state='off'] .aircraft-voice-control-button__dot {
  background: rgb(var(--muted-foreground));
}

.aircraft-voice-control-button[data-voice-state='listening'] {
  border-color: rgb(var(--danger) / 0.65);
  background: rgb(var(--danger) / 0.12);
  color: rgb(var(--danger));
}

.aircraft-voice-control-button[data-voice-state='listening'] .aircraft-voice-control-button__dot {
  background: rgb(var(--danger));
  animation: voice-launcher-pulse 1.2s ease-in-out infinite;
}

.aircraft-voice-control-button[data-voice-state='busy'] .aircraft-voice-control-button__dot {
  background: rgb(var(--primary));
}

.aircraft-voice-control-button[data-voice-state='attention'] {
  border-color: rgb(var(--warning) / 0.38);
  background: rgb(var(--warning) / 0.08);
  color: rgb(var(--warning));
}

.aircraft-voice-control-button[data-voice-state='attention'] .aircraft-voice-control-button__dot {
  background: rgb(var(--warning));
}

/* The family owns its control groups. The workspace does not need another
   elevated card around the entire cockpit. Keep overflow visible for its nav. */
.aircraft-tab-shell :deep(#aircraft-specific-section) {
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none;
}

.aircraft-tab-shell :deep([data-aircraft-template]) {
  min-width: 0;
}

@media (min-width: 761px) and (pointer: fine), (min-width: 761px) and (min-height: 501px) {
  .aircraft-tab-shell :deep(.aircraft-mobile-navigable-section),
  .aircraft-tab-shell :deep(.pmdg-mobile-navigable-section),
  .aircraft-tab-shell :deep(.controls-section),
  .aircraft-tab-shell :deep(#aircraft-page-presets),
  .aircraft-tab-shell :deep(#aircraft-page-avionics) {
    scroll-margin-top: 4.5rem;
  }

  .aircraft-tab-shell :deep([data-aircraft-template="inibuilds-a350"] > nav) {
    position: sticky;
    top: 0.5rem;
    z-index: 40;
    background: rgb(var(--panel));
  }
}

@keyframes voice-launcher-pulse {
  50% { opacity: 0.35; }
}

@media (max-width: 1100px), (max-height: 500px) and (pointer: coarse) {
  .aircraft-page-tools {
    gap: 0.6rem;
  }

  .aircraft-page-tool-actions {
    width: auto;
    flex: 1;
  }

  .aircraft-secondary-tools {
    display: block;
    position: relative;
    flex: none;
  }

  .aircraft-secondary-tools > .aircraft-tools-toggle {
    display: inline-flex;
  }

  .aircraft-secondary-tools-panel {
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    z-index: 65;
    display: grid;
    gap: 0.35rem;
    width: min(16rem, calc(100vw - 2rem));
    padding: 0.5rem;
    border: 1px solid rgb(var(--border-strong) / 0.8);
    border-radius: 6px;
    background: rgb(var(--panel));
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.3);
  }

  .aircraft-secondary-tools-panel > button {
    width: 100%;
    justify-content: flex-start;
  }
}

@media (pointer: coarse) {
  .aircraft-integration-guide-button,
  .aircraft-voice-control-button,
  .aircraft-tools-toggle {
    min-height: var(--ff-touch-target-flight);
  }
}

@media (max-width: 760px), (max-height: 500px) and (pointer: coarse) {
  .aircraft-page-tools {
    padding-bottom: 0.5rem;
    gap: 0;
  }

  .aircraft-page-title {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .aircraft-page-tool-actions {
    width: 100%;
    align-items: stretch;
    justify-content: flex-start;
    gap: 0.4rem;
    flex-wrap: nowrap;
  }

  .aircraft-page-tool-actions > .aircraft-find {
    margin-left: 0;
    margin-right: auto;
  }

  .aircraft-cdu-label {
    display: none;
  }

  .aircraft-cdu-short-label {
    display: inline;
  }

  .aircraft-integration-guide-button,
  .aircraft-tools-toggle {
    min-height: 2.75rem;
    padding-inline: 0.55rem;
    font-size: 0.75rem;
  }

  .aircraft-page-tool-actions--search-expanded
    > .aircraft-integration-guide-button,
  .aircraft-page-tool-actions--search-expanded > .aircraft-secondary-tools {
    display: none;
  }

  .aircraft-page-tool-actions--search-expanded > .aircraft-find {
    flex: 1;
    width: 100%;
  }

  .aircraft-tab-shell--finding .aircraft-page-tools {
    position: sticky;
    top: 0;
    z-index: 55;
    background: rgb(var(--background));
  }

  .aircraft-tab-shell--finding :deep(.aircraft-section-ribbon-anchor),
  .aircraft-tab-shell--finding :deep(.pmdg-mobile-section-ribbon-anchor),
  .aircraft-tab-shell--finding :deep([data-aircraft-template="inibuilds-a350"] > nav) {
    position: static;
  }

  .aircraft-tab-shell :deep([data-aircraft-template]) {
    padding-top: 0.5rem;
    padding-inline: 0;
  }

  .aircraft-tab-shell :deep([data-aircraft-template] > :not([hidden]) ~ :not([hidden])) {
    margin-top: 0.75rem;
  }
}
</style>
