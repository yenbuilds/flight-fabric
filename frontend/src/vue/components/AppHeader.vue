<script setup>
import AppTooltip from './AppTooltip.vue';
import AppStatusStrip from './AppStatusStrip.vue';
import AircraftProfileSelector from './AircraftProfileSelector.vue';
import DestinationProgressBar from './DestinationProgressBar.vue';
import FlightStatusBadges from './FlightStatusBadges.vue';
import { useStatusStore } from '../stores/status.js';

const status = useStatusStore();
const samplingDetailRowClass = 'flex justify-between gap-3';
const samplingDetailLabelClass = 'text-muted-fg';
const samplingDetailValueClass = 'text-right font-mono text-gray-200';

const samplingDetails = [
  { id: 'sampling-rate', label: 'Rate', valueKey: 'vreSamplingRateDetail' },
  { id: 'sampling-reason', label: 'Reason', valueKey: 'vreSamplingReasonLabel' },
  { id: 'sampling-decision', label: 'Decision', valueKey: 'vreSamplingDecisionLabel' },
  { id: 'sampling-last', label: 'Frame', valueKey: 'vreSamplingLastLabel' },
  { id: 'sampling-safety', label: 'Ultra', valueKey: 'vreSamplingSafetyLabel' },
];

function handleStartRecordingManual() {
  status.requestStartRecordingManual();
}

function handleEndFlightManual() {
  status.requestEndFlightManual();
}
</script>

<template>
  <header id="app-header" class="app-header sticky top-0 z-50 flex-none border-b border-border/80 bg-panel/88 backdrop-blur-xl">
    <div class="app-header-shell app-shell-container">
      <div class="app-header-row flex items-center justify-between gap-4">
        <div class="app-brand-block flex items-center gap-4">
          <img id="app-brand-logo" class="app-brand-mark" src="/assets/app-icon.png" alt="" aria-hidden="true">
          <div class="app-brand-copy min-w-0">
            <div class="app-brand-title">Flight Fabric</div>
          </div>
          <div id="legacy-status-annunciator" class="hidden">
            <div id="status-dot" class="w-3 h-3 rounded-sm bg-danger" style="box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);"></div>
            <div class="flex flex-col leading-tight">
              <span id="status-text" class="text-sm text-muted-fg">Disconnected</span>
            </div>
          </div>
          <div id="vue-status-root">
            <AppStatusStrip />
          </div>
        </div>

        <div class="hidden sm:flex items-center gap-3">
          <div id="vue-flight-status-root" class="contents">
            <FlightStatusBadges mode="header" />
          </div>

          <div id="assists-indicator" :class="{ hidden: !status.assistsVisible }">
            <AppTooltip placement="bottom" tooltip-class="w-56" anchor-tag="div">
              <div class="flex cursor-help items-center gap-1.5 rounded-full border border-warning/35 bg-warning/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-warning">
                <svg class="h-3.5 w-3.5 text-warning" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
                <span>ASSISTS</span>
                <span id="assists-count" class="rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-bold text-gray-950">{{ status.activeAssistCount }}</span>
              </div>
              <template #content>
                <div class="mb-2 text-xs font-semibold text-warning">Warning: Non-Realistic Settings Detected:</div>
                <ul id="assists-list" class="space-y-0.5 text-xs text-gray-300">
                  <template v-for="category in status.activeAssistCategories" :key="category.key">
                    <li class="mt-2 text-[10px] uppercase tracking-wide text-muted-fg first:mt-0">{{ category.label }}</li>
                    <li
                      v-for="item in category.items"
                      :key="item.key"
                      class="flex items-center gap-1.5 ml-2 py-0.5"
                    >
                      <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning"></span>
                      <span>{{ item.name }}</span>
                    </li>
                  </template>
                </ul>
                <div class="mt-2 border-t border-border/70 pt-2 text-[10px] text-muted-fg">
                  Note: Cannot detect Aircraft Systems assists (auto-rudder, auto-mixture)
                </div>
              </template>
            </AppTooltip>
          </div>
        </div>

        <div class="header-controls flex items-center gap-4 text-sm">
          <div class="header-activity-controls flex min-w-0 items-center gap-4">
            <div id="sampling-indicator" :class="{ hidden: !status.vreSamplingVisible }">
              <AppTooltip placement="bottom-end" tooltip-class="w-72" anchor-tag="div">
                <div
                  id="sampling-pill"
                  class="ff-status-chip cursor-help"
                  :class="status.vreSamplingPillToneClass"
                >
                  <div id="sampling-dot" class="h-2 w-2 rounded-full" :class="status.vreSamplingDotToneClass"></div>
                  <span id="sampling-band" class="font-medium" :class="status.vreSamplingLabelToneClass">{{ status.vreSamplingSummaryLabel }}</span>
                </div>
                <template #content>
                  <div class="mb-2 text-xs font-semibold text-gray-200">CSV Sampling</div>
                  <dl class="space-y-1 text-[10px] text-gray-400">
                    <div
                      v-for="detail in samplingDetails"
                      :key="detail.id"
                      :class="samplingDetailRowClass"
                    >
                      <dt :class="samplingDetailLabelClass">{{ detail.label }}</dt>
                      <dd :id="detail.id" :class="samplingDetailValueClass">{{ status[detail.valueKey] }}</dd>
                    </div>
                  </dl>
                </template>
              </AppTooltip>
            </div>

            <AppTooltip
              v-if="status.startRecordingActionBound && status.recordingStartAvailable && !status.recordingVisible"
              content="Start Recording Manually"
            >
              <button
                id="start-recording-btn"
                class="ff-status-chip border-red-500/35 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                @click="handleStartRecordingManual"
              >
                <span class="h-2 w-2 rounded-full bg-red-500"></span>
                <span class="font-medium">START REC</span>
              </button>
            </AppTooltip>

            <div id="recording-indicator" :class="{ hidden: !status.recordingVisible }">
              <AppTooltip placement="bottom-end" tooltip-class="w-72" anchor-tag="div" interactive>
                <div class="ff-status-chip cursor-help" :class="status.recordingPillToneClass">
                  <div class="h-2 w-2 rounded-full animate-pulse" :class="status.recordingDotToneClass"></div>
                  <span class="font-medium" :class="status.recordingLabelToneClass">{{ status.recordingBadgeLabel }}</span>
                </div>
                <template #content>
                  <div class="mb-2 text-xs font-semibold" :class="status.recordingTitleToneClass">{{ status.recordingTitle }}</div>
                  <div id="recording-path" class="break-all font-mono text-[10px] text-gray-400">
                    <template v-if="status.recordingFailed">
                      <strong class="text-warning">Recording Failed</strong><br>
                      <span>{{ status.recordingDetail }}</span>
                    </template>
                    <template v-else>
                      <strong>Saving to:</strong><br>
                      <span>{{ status.recordingDetail }}</span>
                    </template>
                  </div>
                  <div class="mt-2 border-t border-border/70 pt-2">
                    <div class="mb-2 text-[10px] text-muted-fg">
                      Flight logs are saved automatically when you land or change aircraft.
                    </div>
                    <button
                      id="end-flight-btn"
                      class="ff-button-secondary w-full justify-center px-3 py-1.5 text-xs"
                      @click="handleEndFlightManual"
                    >
                      End Flight Manually
                    </button>
                  </div>
                </template>
              </AppTooltip>
            </div>
          </div>

          <div class="header-flight-meta flex min-w-0 items-center gap-4">
            <span id="flight-time" class="header-flight-time tabular text-sm text-muted-fg">{{ status.flightTimeLabel }}</span>
            <div class="header-aircraft-summary flex min-w-0 items-center">
              <div class="header-aircraft-copy flex min-w-0 flex-col leading-tight">
                <span id="aircraft-name" class="max-w-[120px] truncate text-sm text-gray-200 sm:max-w-[200px] sm:text-base">{{ status.aircraftNameLabel }}</span>
                <AircraftProfileSelector />
              </div>
              <AppTooltip v-if="status.profileBadgeLabel" :content="status.profileBadgeTitle">
                <span id="profile-badge" :class="status.profileBadgeClass">{{ status.profileBadgeLabel }}</span>
              </AppTooltip>
            </div>
          </div>
        </div>
      </div>

      <div id="vue-destination-progress-root">
        <DestinationProgressBar />
      </div>
    </div>
  </header>
</template>
