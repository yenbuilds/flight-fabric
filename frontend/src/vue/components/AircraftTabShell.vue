<script setup>
import { computed, nextTick, provide, ref, watch } from 'vue';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { AIRCRAFT_CATEGORY_PROFILE_IDS, FEATURED_AIRCRAFT_PROFILE_IDS, resolveAircraftSpecificTemplate } from '../aircraft-specific/template-registry.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';
import { openVoiceSettings } from '../settings-navigation.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useStatusStore } from '../stores/status.js';
import { useProfilesStore } from '../stores/profiles.js';
import { AIRCRAFT_PAGE_SECTIONS } from './aircraft-specific/aircraft-page-sections.js';
import { AIRCRAFT_SECTION_VISIBILITY } from './aircraft-specific/aircraft-section-memory.js';
import AircraftIntegrationCheatSheetModal from './AircraftIntegrationCheatSheetModal.vue';
import AircraftPageSearch from './AircraftPageSearch.vue';
import AircraftPresets from './AircraftPresets.vue';
import PmdgSdkSetup from './PmdgSdkSetup.vue';
import AircraftAvionics from './AircraftAvionics.vue';
import ExteriorLightControls from './ExteriorLightControls.vue';
import AircraftControlsModal from './AircraftControlsModal.vue';
import AircraftCduModal from './AircraftCduModal.vue';
import AircraftSpecificSection from './aircraft-specific/AircraftSpecificSection.vue';
import AircraftVoiceControlModal from './AircraftVoiceControlModal.vue';
import AutopilotControlsTab from './AutopilotControlsTab.vue';
import AutotaxiPanel from './aircraft-specific/AutotaxiPanel.vue';
import { getFlightFabricAppSettings } from '../../app/shared-globals.js';
import { readStorageValue, writeStorageValue } from '../../app/browser-environment.js';
import SetupIllustration from './SetupIllustration.vue';
import AircraftWaitingScene from './AircraftWaitingScene.vue';

const { LIVE_AUTOTAXI_ENABLED } = getFlightFabricAppSettings();
const aircraftSpecific = useAircraftSpecificStore();
const voice = useVoiceControlStore();
const tabs = useTabsStore();
const controls = useAircraftControlsStore();
const status = useStatusStore();
const profiles = useProfilesStore();
const aircraftView = ref('presets');
const viewButtons = ref(null);
const viewScroll = { presets: 0, controls: 0 };
let viewRevision = 0;
let lastProfileKey = '';
provide(AIRCRAFT_SECTION_VISIBILITY, computed(() => aircraftView.value === 'controls'));
const hasPresets = computed(() => Object.values(controls.aircraftCommandCatalogue.commands || {})
  .some(command => command.kind === 'preset'));

async function selectAircraftView(view) {
  if (!['presets', 'controls'].includes(view) || aircraftView.value === view) return;
  const revision = ++viewRevision;
  const scroller = document.getElementById('vue-main-root');
  const previousFocus = document.activeElement;
  const panelOwnedFocus = document.getElementById(aircraftView.value === 'presets' ? 'aircraft-presets-view' : 'aircraft-cockpit-view')?.contains(previousFocus);
  if (scroller) viewScroll[aircraftView.value] = scroller.scrollTop;
  if (view === 'presets') pageSearch.value?.close({ focusLauncher: false });
  aircraftView.value = view;
  await nextTick();
  if (revision !== viewRevision || aircraftView.value !== view || tabs.activeTabId !== 'autopilot') return;
  if (scroller) scroller.scrollTop = viewScroll[view];
  if (panelOwnedFocus && (document.activeElement === previousFocus || document.activeElement === document.body)) {
    viewButtons.value?.querySelector(`[data-aircraft-view="${view}"]`)?.focus({ preventScroll: true });
  }
}
function handleViewKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const view = event.key === 'Home' ? 'presets' : event.key === 'End' ? 'controls'
    : aircraftView.value === 'presets' ? 'controls' : 'presets';
  selectAircraftView(view);
  viewButtons.value?.querySelector(`[data-aircraft-view="${view}"]`)?.focus({ preventScroll: true });
}
function handleSearchExpanded(expanded) {
  searchExpanded.value = expanded;
  if (expanded) selectAircraftView('controls');
}
watch(() => aircraftSpecific.activeProfileKey || controls.aircraftCommandCatalogue.profileKey, key => {
  if (!key) return;
  if (lastProfileKey && key !== lastProfileKey) {
    const revision = ++viewRevision;
    const previousFocus = document.activeElement;
    const panelOwnedFocus = previousFocus?.closest?.('#aircraft-cockpit-view, #aircraft-presets-view');
    aircraftView.value = 'presets';
    viewScroll.presets = viewScroll.controls = 0;
    nextTick(() => {
      if (revision !== viewRevision || tabs.activeTabId !== 'autopilot') return;
      const scroller = document.getElementById('vue-main-root');
      if (scroller) scroller.scrollTop = 0;
      if (panelOwnedFocus && (document.activeElement === previousFocus || document.activeElement === document.body)) {
        viewButtons.value?.querySelector('[data-aircraft-view="presets"]')?.focus({ preventScroll: true });
      }
    });
  }
  lastProfileKey = key;
}, { immediate: true });
const msfsAircraft = computed(() => profiles.builtInProfiles
  .filter(profile => profile.simulator === 'msfs' && !profile.abstract && !AIRCRAFT_CATEGORY_PROFILE_IDS.includes(profile.id))
  .map(profile => ({ id: profile.id, key: profile.qualifiedId || `${profile.simulator}/${profile.id}`, name: profile.name, simulator: profile.simulator }))
  .sort((left, right) => left.name.localeCompare(right.name)));
const featuredAircraft = computed(() => FEATURED_AIRCRAFT_PROFILE_IDS
  .map(id => msfsAircraft.value.find(profile => profile.id === id))
  .filter(Boolean));
const otherAircraft = computed(() => msfsAircraft.value
  .filter(profile => !FEATURED_AIRCRAFT_PROFILE_IDS.includes(profile.id)));
const avionicsPlacement = {
  'pmdg-737': 'radios', 'pmdg-777': 'mcp', 'fenix-a32x': 'fcu',
  'fbw-a32nx': 'fcu', 'fbw-a380x': 'fcu-autopilot', 'inibuilds-a350': 'a350-fcu',
};
const hasStructuredLayout = computed(() => hasResolvedAircraftTemplate.value
  && Object.hasOwn(avionicsPlacement, aircraftSpecific.templateId));
const pageSections = computed(() => [
  ...(LIVE_AUTOTAXI_ENABLED
    ? [{ id: 'page-autotaxi', label: 'Pushback & taxi', title: 'Pushback & taxi', detail: 'Automatic pushback towards your departure taxi route, then manual taxi guidance. Optional Autotaxi.', targetId: 'aircraft-page-autotaxi' }] : []),
  ...(['radios.com1.setStandby', 'radios.com2.setStandby', 'baro.both.qnhHpa',
    'surveillance.squawk.set', 'surveillance.ident.activate', 'approach.minimums.baro',
    'navigation.captain.range', 'navigation.firstOfficer.range'].some(id => controls.isAircraftCommandSupported(id))
    ? [{ id: 'page-avionics', label: 'Radios / approach', title: 'Radios & approach',
      targetId: 'aircraft-page-avionics', after: avionicsPlacement[aircraftSpecific.templateId] || 'radios' }] : []),
]);
provide(AIRCRAFT_PAGE_SECTIONS, pageSections);
const searchableContent = ref(null);
const pageSearch = ref(null);
// Missing preference starts compact; an explicitly opened guide stays open.
const orientationOpen = ref(readStorageValue('ff_aircraft_orientation_closed_v1') === '');
function rememberOrientation(event) {
  orientationOpen.value = event.currentTarget.open;
  writeStorageValue('ff_aircraft_orientation_closed_v1', orientationOpen.value ? '' : '1');
}
watch(() => voice.status, async value => {
  if (value !== 'sent' || !orientationOpen.value) return;
  const guide = searchableContent.value?.querySelector('[data-aircraft-orientation]');
  const ownedFocus = guide?.contains(document.activeElement);
  orientationOpen.value = false;
  writeStorageValue('ff_aircraft_orientation_closed_v1', '1');
  await nextTick();
  if (ownedFocus && (guide?.contains(document.activeElement) || document.activeElement === document.body)) {
    guide?.querySelector('summary')?.focus({ preventScroll: true });
  }
});
async function showPresets() {
  await selectAircraftView('presets');
  if (aircraftView.value !== 'presets') return;
  const target = searchableContent.value?.querySelector('#aircraft-page-presets');
  target?.scrollIntoView({ block: 'center', behavior: 'instant' });
  target?.focus({ preventScroll: true });
}
const integrationGuideButton = ref(null);
const voiceControlButton = ref(null);
const integrationCheatSheetOpen = ref(false);
const integrationCheatSheetFilter = ref('all');
const integrationGuideReturnTarget = ref(null);
// Operational voice controls stay on Aircraft; configuration lives in Settings.
const voiceControlOpen = computed({ get: () => voice.panelOpen, set: value => { voice.panelOpen = value; } });
const voiceReturnTarget = ref(null);
const searchExpanded = ref(false);
const secondaryTools = ref(null);
const secondaryToolsButton = ref(null);
const secondaryToolsOpen = ref(false);
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
    const visibleTarget = [target, secondaryToolsButton.value,
      ...document.querySelectorAll('.desktop-tab[aria-current="page"], .mobile-tab[aria-current="page"], #mobile-more-btn')]
      .find(element => element?.isConnected && element.getClientRects().length > 0);
    visibleTarget?.focus({ preventScroll: true });
  });
}

function closeSecondaryTools({ restoreFocus = false } = {}) {
  secondaryToolsOpen.value = false;
  if (restoreFocus) restoreToolFocus(secondaryToolsButton.value);
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

watch(voiceControlOpen, open => {
  if (open) {
    voiceReturnTarget.value = document.activeElement;
    closeSecondaryTools();
  }
});

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
const waitingForAircraft = computed(() => !hasResolvedAircraftTemplate.value && !status.hasIdentifiedAircraft);
watch(waitingForAircraft, () => {
  const previousFocus = document.activeElement;
  const pageOwnedFocus = searchableContent.value?.contains(previousFocus);
  searchExpanded.value = false;
  closeSecondaryTools();
  nextTick(() => {
    if (pageOwnedFocus && !previousFocus?.isConnected && document.activeElement === document.body) {
      restoreToolFocus(searchableContent.value?.querySelector(waitingForAircraft.value ? '#aircraft-welcome-title' : '.aircraft-tools-toggle'));
    }
  });
});
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
  nextTick(() => {
    const targets = [voiceReturnTarget.value, voiceControlButton.value, secondaryToolsButton.value,
      ...document.querySelectorAll('.desktop-tab[aria-current="page"], .mobile-tab[aria-current="page"], #mobile-more-btn')];
    targets.find(element => element?.isConnected && !element.closest('[inert]')
      && element !== document.body && element.getClientRects().length > 0)?.focus({ preventScroll: true });
  });
}

function openVoiceCommandGuide() {
  voiceControlOpen.value = false;
  nextTick(() => openIntegrationGuide('voice', voiceReturnTarget.value || voiceControlButton.value));
}

function configureVoice() {
  return openVoiceSettings(tabs, voice, { fromAircraft: true });
}
</script>

<template>
  <div
    class="aircraft-tab-shell"
    :class="{ 'aircraft-tab-shell--finding': searchExpanded }"
    :data-aircraft-page-mode="waitingForAircraft ? 'waiting' : hasResolvedAircraftTemplate ? 'specific' : 'generic'"
    :data-aircraft-workspace="aircraftView"
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
            ref="pageSearch"
            v-if="!waitingForAircraft"
            :target="searchableContent"
            :content-key="`${hasResolvedAircraftTemplate ? 'specific' : 'generic'}:${aircraftSpecific.activeProfileKey || aircraftSpecific.templateId || ''}`"
            @expanded-change="handleSearchExpanded"
          />
          <button v-if="!waitingForAircraft" ref="voiceControlButton" type="button" class="aircraft-integration-guide-button ff-touch-target"
            aria-haspopup="dialog" aria-controls="aircraft-voice-control-modal" :aria-expanded="voiceControlOpen"
            data-aircraft-voice-control-trigger @click="openVoiceControl">
            <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="2.5" width="6" height="12" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
            </svg>
            <span>{{ voice.bridgeAvailable ? 'Voice commands' : 'Voice phrases' }}</span>
          </button>
          <button v-if="hasCdu" ref="cduButton" type="button" class="aircraft-integration-guide-button ff-touch-target"
            aria-haspopup="dialog" :aria-expanded="cduOpen" data-cdu-trigger aria-label="Open MCDU / CDU" @click="cduOpen = true">
            <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <path d="M7.5 6.5h9v4.5h-9zM7.5 14.5h1.5M11.25 14.5h1.5M15 14.5h1.5M7.5 17.5h1.5M11.25 17.5h1.5M15 17.5h1.5" />
            </svg>
            <span class="aircraft-cdu-label">MCDU / CDU</span><span class="aircraft-cdu-short-label" aria-hidden="true">CDU</span>
          </button>
          <div v-if="!waitingForAircraft" ref="secondaryTools" class="aircraft-secondary-tools" @focusout="handleToolsFocusout" data-no-swipe>
            <button ref="secondaryToolsButton" type="button" class="aircraft-tools-toggle"
              :aria-expanded="secondaryToolsOpen" aria-controls="aircraft-secondary-tools-panel"
              @click="secondaryToolsOpen = !secondaryToolsOpen">
              <span>Tools</span><span aria-hidden="true">⌄</span>
            </button>
            <div id="aircraft-secondary-tools-panel" class="aircraft-secondary-tools-panel" v-show="secondaryToolsOpen">
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
              <button ref="controlsButton" type="button" class="aircraft-integration-guide-button ff-touch-target"
                aria-haspopup="dialog" aria-controls="aircraft-controls-modal" :aria-expanded="controlsModalOpen"
                data-aircraft-controls-trigger @click="openControlsModal">Control library</button>
            </div>
          </div>
        </div>
      </div>
      <details v-if="!waitingForAircraft" class="setup-details aircraft-orientation" :open="orientationOpen" @toggle="rememberOrientation" data-aircraft-orientation>
        <summary>Help with aircraft controls</summary>
        <div class="aircraft-orientation-actions">
          <button v-if="hasPresets" type="button" @click="showPresets"><SetupIllustration kind="aircraft" /><span><strong>Start with a preset</strong><small>Grouped actions for a flight phase</small></span></button>
          <button type="button" @click="pageSearch?.open()"><SetupIllustration kind="keyboard" /><span><strong>Find a control</strong><small>Search a switch, value or system</small></span></button>
          <button type="button" @click="voice.bridgeAvailable ? configureVoice() : openVoiceControl()"><SetupIllustration kind="headset" /><span><strong>{{ voice.bridgeAvailable ? voice.settingsAction : 'Browse voice phrases' }}</strong><small>{{ voice.bridgeAvailable ? (voice.setupTask?.detail || 'Microphone and push-to-talk preferences') : 'Use your simulator PC microphone' }}</small></span></button>
        </div>
      </details>
      <section v-if="waitingForAircraft" class="aircraft-welcome" aria-labelledby="aircraft-welcome-title">
        <AircraftWaitingScene class="mb-4" />
        <p class="aircraft-welcome-status" role="status">{{ status.simConnected ? 'Load an aircraft to get started' : 'Waiting for your simulator' }}</p>
        <h3 id="aircraft-welcome-title" tabindex="-1">Your aircraft controls will appear here</h3>
        <p class="aircraft-welcome-copy">Load an aircraft in your simulator. FlightFabric will detect it and show its available cockpit controls, presets and voice commands.</p>
        <button v-if="voice.bridgeAvailable" type="button" class="ff-button-primary aircraft-welcome-voice" data-aircraft-voice-setup @click="configureVoice">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="2.5" width="6" height="12" rx="3" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
          </svg>
          <span>{{ voice.settingsAction }}</span>
        </button>
        <p v-else class="aircraft-welcome-copy">Set up voice control in FlightFabric on your PC. You can view your aircraft here, and use cockpit controls once this device is paired for control.</p>
        <div v-if="featuredAircraft.length" class="aircraft-welcome-featured">
          <h4>Dedicated aircraft controls</h4>
          <ul aria-label="Aircraft with dedicated controls"><li v-for="aircraft in featuredAircraft" :key="aircraft.key">{{ aircraft.name }}</li></ul>
        </div>
        <details v-if="otherAircraft.length || !msfsAircraft.length" class="aircraft-welcome-catalogue">
          <summary>Other MSFS aircraft</summary>
          <template v-if="otherAircraft.length">
            <p>Support varies; some controls may be unavailable.</p>
            <ul aria-label="Other MSFS aircraft" tabindex="0" data-no-swipe>
              <li v-for="aircraft in otherAircraft" :key="aircraft.key">{{ aircraft.name }}</li>
            </ul>
          </template>
          <p v-else>{{ voice.bridgeAvailable ? 'The aircraft list will appear when FlightFabric connects to its local service.' : 'Open FlightFabric on your PC to browse its bundled aircraft profiles.' }}</p>
        </details>
      </section>
      <div v-if="!waitingForAircraft" class="aircraft-view-bar">
        <div ref="viewButtons" class="workspace-view-switch" role="tablist" aria-label="Aircraft view" @keydown="handleViewKeydown">
          <button id="aircraft-presets-tab" type="button" role="tab" data-aircraft-view="presets"
            :aria-selected="aircraftView === 'presets'" :tabindex="aircraftView === 'presets' ? 0 : -1"
            aria-controls="aircraft-presets-view" :class="{ active: aircraftView === 'presets' }" @click="selectAircraftView('presets')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <path d="m12 3 9 5-9 5-9-5 9-5Z" />
              <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
            </svg>
            <span>Presets</span>
          </button>
          <button id="aircraft-cockpit-tab" type="button" role="tab" data-aircraft-view="controls"
            :aria-selected="aircraftView === 'controls'" :tabindex="aircraftView === 'controls' ? 0 : -1"
            aria-controls="aircraft-cockpit-view" :class="{ active: aircraftView === 'controls' }" @click="selectAircraftView('controls')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <path d="M4 6h6m4 0h6M4 12h6m4 0h6M4 18h10m4 0h2" />
              <circle cx="12" cy="6" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="16" cy="18" r="2" />
            </svg>
            <span>Cockpit controls</span>
          </button>
        </div>
      </div>
      <PmdgSdkSetup v-if="['pmdg-737', 'pmdg-777'].includes(aircraftSpecific.templateId)"
        :key="aircraftSpecific.activeProfileKey" :family="aircraftSpecific.templateId" :profile-key="aircraftSpecific.activeProfileKey"
        :sdk-connected="aircraftSpecific.sourceStatuses.sdk === 'connected'" />
      <AircraftSpecificSection v-if="hasResolvedAircraftTemplate" :controls-visible="aircraftView === 'controls'" :aircraft-name="status.aircraftNameLabel">
        <template #before-controls>
          <AutotaxiPanel v-if="LIVE_AUTOTAXI_ENABLED && !hasStructuredLayout" id="aircraft-page-autotaxi" class="aircraft-mobile-navigable-section mb-5" tabindex="-1" />
        </template>
        <template #presets>
          <AutotaxiPanel v-if="LIVE_AUTOTAXI_ENABLED && hasStructuredLayout" id="aircraft-page-autotaxi" class="aircraft-mobile-navigable-section" tabindex="-1" />
        </template>
        <template #avionics><AircraftAvionics /></template>
        <template #after-controls><AircraftAvionics v-if="!hasStructuredLayout" class="mt-5" /></template>
      </AircraftSpecificSection>
      <div v-if="!waitingForAircraft" id="aircraft-presets-view" v-show="aircraftView === 'presets'" :inert="aircraftView !== 'presets'"
        role="tabpanel" aria-labelledby="aircraft-presets-tab" tabindex="0">
        <p v-if="!hasResolvedAircraftTemplate" class="mb-3 text-sm text-muted-fg">{{ status.aircraftNameLabel }}</p>
        <AircraftPresets />
        <section v-if="!hasPresets" class="ff-panel p-5" aria-labelledby="aircraft-no-presets-title">
          <h3 id="aircraft-no-presets-title" class="text-base font-semibold">Presets</h3>
          <p class="mt-2 text-sm text-muted-fg">{{ controls.availability.reason || (controls.aircraftCommandCatalogue.profileKey ? 'There are no presets for this aircraft. Its individual controls are available in Cockpit controls.' : 'Waiting for the aircraft’s supported presets.') }}</p>
          <button type="button" class="ff-button-secondary mt-4" @click="selectAircraftView('controls')">Open cockpit controls</button>
        </section>
      </div>
      <div v-if="!waitingForAircraft && !hasResolvedAircraftTemplate" id="aircraft-cockpit-view"
        v-show="aircraftView === 'controls'" :inert="aircraftView !== 'controls'" role="tabpanel" aria-labelledby="aircraft-cockpit-tab" tabindex="0">
        <AutopilotControlsTab>
          <template #page-tasks><AutotaxiPanel v-if="LIVE_AUTOTAXI_ENABLED" id="aircraft-page-autotaxi" class="aircraft-mobile-navigable-section" tabindex="-1" /></template>
        </AutopilotControlsTab>
        <AircraftAvionics class="mt-5" />
        <ExteriorLightControls class="mt-5" />
      </div>
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
      @open-settings="configureVoice"
    />
    <AircraftControlsModal :open="controlsModalOpen" @close="closeControlsModal" />
    <AircraftCduModal :open="cduOpen" @close="closeCdu" />
  </div>
</template>

<style scoped>
.aircraft-tab-shell { --aircraft-view-offset: 4rem; }
.aircraft-view-bar {
  position: sticky;
  top: 0;
  z-index: 45;
  display: flex;
  align-items: center;
  min-height: var(--aircraft-view-offset);
  padding: .25rem 0;
  background: rgb(var(--background));
}
.aircraft-view-bar button {
  justify-content: center;
  min-height: 2.75rem;
  min-width: 9rem;
  padding-inline: 1rem;
  border-bottom-width: 3px;
  font-size: .875rem;
  white-space: nowrap;
}
.aircraft-view-bar button svg { width: 1.125rem; height: 1.125rem; pointer-events: none; }
.aircraft-view-bar button.active {
  background: rgb(var(--selection) / .22);
  border-color: rgb(var(--selection) / .55);
  border-bottom-color: rgb(var(--selection));
}
.aircraft-tab-shell :deep(.aircraft-desktop-section-anchor),
.aircraft-tab-shell :deep([data-aircraft-template="inibuilds-a350"] > nav) {
  top: calc(var(--aircraft-view-offset) + .5rem);
}
.aircraft-tab-shell :deep(.aircraft-mobile-navigable-section),
.aircraft-tab-shell :deep(.pmdg-mobile-navigable-section),
.aircraft-tab-shell :deep(.pmdg777-mobile-navigable-section),
.aircraft-tab-shell :deep(.controls-section) {
  scroll-margin-top: calc(4.5rem + var(--aircraft-view-offset));
}
.aircraft-tab-shell--finding .aircraft-view-bar { position: static; }
.aircraft-tab-shell--finding .aircraft-page-tools {
  position: sticky;
  top: 0;
  z-index: 60;
  background: rgb(var(--background));
}
@media (max-width: 760px) {
  .aircraft-view-bar .workspace-view-switch { display: flex; width: 100%; }
  .aircraft-view-bar button { flex: 1 1 auto; min-width: 0; padding-inline: .6rem; }
}
.aircraft-welcome {
  max-width: 54rem;
  margin: 2rem auto;
  padding: clamp(1.25rem, 4vw, 3rem);
  border: 1px solid rgb(var(--border) / 0.65);
  border-radius: 12px;
  background: rgb(var(--panel) / 0.7);
}
.aircraft-welcome-status {
  margin: 0 0 1rem;
  color: rgb(var(--primary));
  font-size: 0.8125rem;
  font-weight: 600;
}
.aircraft-welcome h3 {
  max-width: 28rem;
  color: rgb(var(--foreground));
  font-size: clamp(1.5rem, 3vw, 2rem);
  font-weight: 650;
  line-height: 1.2;
}
.aircraft-welcome-copy, .aircraft-welcome-catalogue p {
  max-width: 38rem;
  margin: 1rem 0;
  color: rgb(var(--muted-foreground));
  font-size: 0.875rem;
  line-height: 1.6;
}
.aircraft-welcome-voice { min-height: 3rem; gap: 0.6rem; margin: 0.25rem 0 1rem; padding: 0.75rem 1.1rem; font-size: 0.9375rem; }
.aircraft-welcome-voice svg { width: 1.125rem; height: 1.125rem; flex: none; }
@media (max-width: 600px) { .aircraft-welcome-voice { width: 100%; } }
.aircraft-welcome-featured { margin: 1.25rem 0; }
.aircraft-welcome-featured h4 { color: rgb(var(--foreground)); font-size: 1rem; font-weight: 600; }
.aircraft-welcome-featured ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 0.65rem 1.5rem; margin: 0.75rem 0 0; padding: 0; list-style: none; color: rgb(var(--foreground)); font-size: 0.9375rem; font-weight: 500; line-height: 1.5; }
.aircraft-welcome-catalogue { margin-top: 1rem; border-top: 1px solid rgb(var(--border) / 0.55); }
.aircraft-welcome-catalogue summary {
  padding: 0.85rem 0;
  min-height: 2.75rem;
  color: rgb(var(--foreground));
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 600;
}
.aircraft-welcome-catalogue summary:focus-visible, .aircraft-welcome-catalogue ul:focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 4px; }
.aircraft-welcome-catalogue ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: 0.5rem 1rem; max-height: 16rem; overflow-y: auto; overscroll-behavior: contain; margin: 1rem 0 0; padding: 0.25rem; list-style: none; scrollbar-color: rgb(var(--border)) transparent; scrollbar-width: thin; }
.aircraft-welcome-catalogue li { color: rgb(var(--foreground)); font-size: 0.8125rem; overflow-wrap: anywhere; }

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

.aircraft-secondary-tools {
  display: block;
  position: relative;
  flex: none;
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

.aircraft-cdu-short-label {
  display: none;
}

.aircraft-page-tool-actions > .aircraft-find--expanded {
  width: auto;
  max-width: none;
  flex: 1 1 28rem;
}

.aircraft-integration-guide-button,
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
.aircraft-tools-toggle:hover {
  border-color: rgb(var(--border-strong) / 0.8);
  background: rgb(var(--panel-elevated) / 0.7);
  color: rgb(var(--foreground));
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
.aircraft-tab-shell[data-aircraft-workspace="presets"] :deep(#aircraft-specific-section) {
  padding: 0;
  gap: 0;
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
    scroll-margin-top: calc(4.5rem + var(--aircraft-view-offset));
  }

  .aircraft-tab-shell :deep([data-aircraft-template="inibuilds-a350"] > nav) {
    position: sticky;
    top: calc(var(--aircraft-view-offset) + .5rem);
    z-index: 40;
    background: rgb(var(--panel));
  }
}

@media (max-width: 1100px), (max-height: 500px) and (pointer: coarse) {
  .aircraft-page-tools {
    gap: 0.6rem;
  }

  .aircraft-page-tool-actions {
    width: auto;
    flex: 1;
  }
}

@media (pointer: coarse) {
  .aircraft-integration-guide-button,
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
    flex-wrap: wrap;
  }

  .aircraft-page-tool-actions > .aircraft-find {
    margin-left: 0;
    margin-right: auto;
  }

  .aircraft-secondary-tools {
    margin-left: auto;
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
    > .aircraft-integration-guide-button:not([data-aircraft-voice-control-trigger]),
  .aircraft-page-tool-actions--search-expanded > .aircraft-secondary-tools {
    display: none;
  }

  .aircraft-page-tool-actions--search-expanded > .aircraft-find {
    flex: 1 0 100%;
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

  .aircraft-tab-shell :deep([data-aircraft-template="inibuilds-a350"] > nav) {
    margin-inline: 0;
  }

  .aircraft-tab-shell :deep([data-aircraft-template] > :not([hidden]) ~ :not([hidden])) {
    margin-top: 0.75rem;
  }
}
</style>
