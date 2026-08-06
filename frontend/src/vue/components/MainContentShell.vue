<script setup>
import AircraftTabShell from './AircraftTabShell.vue';
import DesktopTabs from './DesktopTabs.vue';
import FlightStatusBadges from './FlightStatusBadges.vue';
import FlightTabShell from './FlightTabShell.vue';
import LandingPanel from './LandingPanel.vue';
import LiveMapTabShell from './LiveMapTabShell.vue';
import LvarInspectorTab from './LvarInspectorTab.vue';
import SettingsTabShell from './SettingsTabShell.vue';
import SimbriefTab from './SimbriefTab.vue';
import SystemTabShell from './SystemTabShell.vue';
import TimelineTabShell from './TimelineTabShell.vue';
import { useLandingStore } from '../stores/landing.js';
import { useTabsStore } from '../stores/tabs.js';

const landing = useLandingStore();
const tabs = useTabsStore();
</script>

<template>
  <div class="dashboard-shell app-shell-container py-6">
    <div class="sm:hidden mb-4 flex items-center justify-center gap-3">
      <div id="vue-phase-mobile-root" class="contents">
        <FlightStatusBadges mode="mobile" />
      </div>
    </div>

    <div id="vue-desktop-tabs-root">
      <DesktopTabs />
    </div>

    <div id="tab-flight" class="tab-section" :class="tabs.tabSectionClass('flight')">
      <div id="vue-flight-tab-root">
        <FlightTabShell />
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
