<script setup>
import AircraftTabShell from './AircraftTabShell.vue';
import FlightWorkspaceBar from './FlightWorkspaceBar.vue';
import FlightTabShell from './FlightTabShell.vue';
import LandingPanel from './LandingPanel.vue';
import LiveMapTabShell from './LiveMapTabShell.vue';
import LvarInspectorTab from './LvarInspectorTab.vue';
import SettingsTabShell from './SettingsTabShell.vue';
import SecondScreenGuide from './SecondScreenGuide.vue';
import DevicePairingRequest from './DevicePairingRequest.vue';
import SimbriefTab from './SimbriefTab.vue';
import SystemTabShell from './SystemTabShell.vue';
import TakeoffPanel from './TakeoffPanel.vue';
import TimelineTabShell from './TimelineTabShell.vue';
import FlightCuesTabShell from './FlightCuesTabShell.vue';
import { useLandingStore } from '../stores/landing.js';
import { useTabsStore } from '../stores/tabs.js';
import { useFlightCuesStore } from '../stores/flight-cues.js';
import { getFlightFabricAppSettings } from '../../settings/shared-runtime.js';

const { TAKEOFF_SCORING_ENABLED } = getFlightFabricAppSettings();
const landing = useLandingStore();
const tabs = useTabsStore();
useFlightCuesStore();
</script>

<template>
  <div class="dashboard-shell app-shell-container py-6">
    <SecondScreenGuide />
    <DevicePairingRequest />

    <FlightWorkspaceBar v-if="tabs.activeTabId === 'flight' || tabs.activeTabId === 'livemap'" />

    <div id="tab-flight" class="tab-section" :class="tabs.tabSectionClass('flight')">
      <div id="vue-flight-tab-root">
        <FlightTabShell />
      </div>
    </div>

    <div id="tab-cues" class="tab-section" :class="tabs.tabSectionClass('cues')">
      <div id="vue-flight-cues-tab-root">
        <FlightCuesTabShell v-if="tabs.activeTabId === 'cues'" />
      </div>
    </div>

    <div id="tab-autopilot" class="tab-section" :class="tabs.tabSectionClass('autopilot')">
      <div id="vue-autopilot-root">
        <AircraftTabShell />
      </div>
    </div>

    <div id="tab-landing" class="tab-section" :class="tabs.tabSectionClass('landing')">
      <div id="vue-landing-root">
        <LandingPanel v-if="!landing.landingModalOpen" />
      </div>
      <div v-if="TAKEOFF_SCORING_ENABLED" id="vue-takeoff-root" class="mt-6">
        <TakeoffPanel v-if="!landing.landingModalOpen" />
      </div>
    </div>

    <div id="tab-timeline" class="tab-section" :class="tabs.tabSectionClass('timeline')">
      <div id="vue-timeline-tab-root">
        <TimelineTabShell />
      </div>
    </div>

    <div id="tab-livemap" class="tab-section" :class="tabs.tabSectionClass('livemap')">
      <div id="vue-live-map-tab-root">
        <LiveMapTabShell />
      </div>
    </div>

    <div id="tab-lvars" class="tab-section" :class="tabs.tabSectionClass('lvars')">
      <div id="vue-lvars-root">
        <LvarInspectorTab />
      </div>
    </div>

    <div id="tab-settings" class="tab-section" :class="tabs.tabSectionClass('settings')">
      <div id="vue-settings-root">
        <SettingsTabShell />
      </div>
    </div>

    <div id="tab-system" class="tab-section" :class="tabs.tabSectionClass('system')">
      <div id="vue-system-root">
        <SystemTabShell />
      </div>
    </div>

    <div id="tab-dispatch" class="tab-section" :class="tabs.tabSectionClass('dispatch')">
      <div id="vue-simbrief-root" class="w-full">
        <SimbriefTab />
      </div>
    </div>
  </div>
</template>
