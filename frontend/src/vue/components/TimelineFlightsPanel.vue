<script setup>
import { computed } from 'vue';
import AppTooltip from './AppTooltip.vue';
import AircraftArtwork from './AircraftArtwork.vue';
import { useLogbookStore } from '../stores/logbook.js';
import { useStatusStore } from '../stores/status.js';
import { useTimelineStore } from '../stores/timeline.js';
import {
  getFlightAircraftLabel,
  getFlightBundleSizeBytes,
  getFlightRouteLabel,
} from '../../timeline/flight-list.js';
import {
  formatBytes,
  formatDistanceNm,
  formatDuration,
  getFiniteDistanceNm,
} from '../../utils/formatting.js';

const logbook = useLogbookStore();
const status = useStatusStore();
const timeline = useTimelineStore();

const flights = computed(() => timeline.visibleFlights);
const pageRefreshing = computed(() => timeline.listStatus === 'loading' || timeline.timelineLoading);
const flightProgressLabel = computed(() => {
  if (status.recordingFinalizing) return 'Finalizing Flight';
  return status.recordingActive ? 'Flight In Progress' : '';
});
const flightProgressShortLabel = computed(() => {
  if (status.recordingFinalizing) return 'Finalizing';
  return status.recordingActive ? 'In Progress' : '';
});
const refreshButtonLabel = computed(() => (pageRefreshing.value ? 'Refreshing...' : 'Refresh Page'));
const historyIndex = computed(() => logbook.historyIndexStatus || {});
const historyIndexTitle = computed(() => (
  historyIndex.value.mode === 'rebuild' ? 'Rebuilding flight history index' : 'Indexing flight history'
));

function getFlightKey(flight) {
  return flight.filePath || flight.flightId || '';
}

function isFlightLoading(flight) {
  return timeline.timelineLoading && timeline.timelineLoadingFlightKey === getFlightKey(flight);
}

function openFlight(flight) {
  timeline.requestTimeline(flight.filePath, flight.flightId, {
    flightKey: getFlightKey(flight),
    flightLabel: getFlightRouteLabel(flight) || flight.flightId || 'selected flight',
  });
}

function hasLandingAction(flight) {
  return Boolean(flight?.latestLandingEvent && timeline.detailLandingActionBound);
}

function openLanding(flight) {
  timeline.openFlightLanding(flight);
}

function refreshTimelinePage() {
  timeline.refreshTimelinePage();
  logbook.request();
}

function deleteFlight(flight) {
  timeline.requestDeleteFlight(flight);
}

async function openStorageFolder() {
  await timeline.requestOpenStorageFolder();
}

async function copyStoragePath() {
  await timeline.requestCopyStoragePath();
}

function flightTimestampDate(flight) {
  const recordingStart = new Date(flight?.recordingStartIso);
  if (Number.isFinite(recordingStart.getTime())) return recordingStart;
  return new Date(flight?.timestamp);
}

function flightTimestampKind(flight) {
  return Number.isFinite(new Date(flight?.recordingStartIso).getTime()) ? 'Recorded' : 'Saved';
}

function flightDateTimeLabel(flight) {
  const date = flightTimestampDate(flight);
  if (!Number.isFinite(date.getTime())) return '--';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
</script>

<template>
  <div id="timeline-flights-card" class="ff-card overflow-hidden">
    <div class="p-3 sm:p-4 border-b border-surface-200 flex items-start justify-between gap-3 flex-wrap">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-gray-300">Recent Flights</div>
        <div class="text-xs text-gray-500 mt-0.5">Refresh saved flights, events, map, and scored landings.</div>
      </div>
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <div
          v-if="flightProgressLabel"
          class="inline-flex items-center gap-1.5 rounded border border-sky-500/35 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-300"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" aria-hidden="true"></span>
          <span class="hidden sm:inline">{{ flightProgressLabel }}</span>
          <span class="sm:hidden">{{ flightProgressShortLabel }}</span>
        </div>
        <button
          id="timeline-page-refresh-btn"
          type="button"
          class="px-3 py-1.5 text-xs font-medium bg-surface-200 text-gray-300 rounded hover:bg-surface-300 transition-colors disabled:cursor-wait disabled:opacity-70"
          :disabled="pageRefreshing"
          @click="refreshTimelinePage"
        >
          {{ refreshButtonLabel }}
        </button>
      </div>
    </div>
    <div
      v-if="logbook.historyIndexBusy"
      id="history-index-progress"
      class="border-b border-cyan-400/20 bg-cyan-400/5 px-3 py-3 sm:px-4"
      role="status"
      aria-live="polite"
    >
      <div class="flex items-center justify-between gap-3 text-xs">
        <div class="min-w-0">
          <div class="font-semibold text-cyan-200">{{ historyIndexTitle }}</div>
          <div class="mt-0.5 text-gray-400">
            {{ logbook.historyIndexProgressLabel }}. Recent flights appear first; you can keep using Flight Fabric.
          </div>
        </div>
        <div class="shrink-0 font-mono text-cyan-300">{{ historyIndex.percent || 0 }}%</div>
      </div>
      <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-300">
        <div
          class="h-full rounded-full bg-cyan-400 transition-[width] duration-300"
          :style="{ width: `${Math.max(1, historyIndex.percent || 0)}%` }"
        ></div>
      </div>
    </div>
    <div class="px-3 sm:px-4 py-3 border-b border-surface-200 bg-surface-50/60">
      <div class="timeline-filters-grid">
        <input
          :value="timeline.routeFilter"
          type="text"
          placeholder="Filter route or airport"
          style="color-scheme: dark"
          class="timeline-filter-control w-full px-3 py-2 text-xs rounded border border-surface-300 bg-surface-200 text-gray-200 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-accent/50"
          @input="timeline.setRouteFilter($event.target.value)"
        />
        <input
          :value="timeline.aircraftFilter"
          type="text"
          placeholder="Filter aircraft"
          style="color-scheme: dark"
          class="timeline-filter-control w-full px-3 py-2 text-xs rounded border border-surface-300 bg-surface-200 text-gray-200 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-accent/50"
          @input="timeline.setAircraftFilter($event.target.value)"
        />
        <select
          :value="timeline.sort"
          style="color-scheme: dark"
          class="timeline-filter-control w-full lg:w-48 px-3 py-2 text-xs rounded border border-surface-300 bg-surface-200 text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent/50"
          @change="timeline.setSort($event.target.value)"
        >
          <option style="background-color: rgb(var(--color-surface-200)); color: #e5e7eb" value="recent">Newest First</option>
          <option style="background-color: rgb(var(--color-surface-200)); color: #e5e7eb" value="oldest">Oldest First</option>
          <option style="background-color: rgb(var(--color-surface-200)); color: #e5e7eb" value="route">Route A - Z</option>
          <option style="background-color: rgb(var(--color-surface-200)); color: #e5e7eb" value="aircraft">Aircraft A - Z</option>
        </select>
      </div>
      <div class="mt-2 text-[11px] text-gray-500">{{ timeline.flightsMeta }}</div>
    </div>

    <div v-if="timeline.showStorage" class="px-3 sm:px-4 py-2 border-b border-surface-200 bg-surface-200/30 text-xs text-gray-400 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-[10px] uppercase tracking-widest text-gray-500" style="font-family: 'B612 Mono', monospace;">Flight logs folder</div>
        <AppTooltip :content="timeline.storagePath" placement="top-start" anchor-class="min-w-0" anchor-tag="div">
          <div class="truncate text-gray-300" style="font-family: 'B612 Mono', monospace;">{{ timeline.storagePath }}</div>
        </AppTooltip>
        <div class="text-[11px] text-gray-500 mt-0.5">{{ timeline.storageSummary }}</div>
      </div>
      <div class="timeline-storage-actions flex-shrink-0">
        <button type="button" class="timeline-storage-btn px-2 py-1 text-[11px] rounded border border-surface-300 text-gray-300 hover:bg-surface-300/40" @click="openStorageFolder">Open Folder</button>
        <button type="button" class="timeline-storage-btn px-2 py-1 text-[11px] rounded border border-surface-300 text-gray-300 hover:bg-surface-300/40" @click="copyStoragePath">{{ timeline.storagePathCopyLabel }}</button>
      </div>
    </div>

    <div class="relative overflow-y-auto" style="height: min(56vh, 42rem); min-height: 20rem;">
      <div
        v-if="timeline.timelineLoading"
        class="sticky top-0 z-10 mx-3 mt-3 mb-1 rounded border border-accent/30 bg-surface-100/95 px-3 py-2 text-xs text-gray-300 shadow-lg backdrop-blur"
      >
        <div class="flex items-center gap-2">
          <div class="h-3 w-3 rounded-full border-2 border-accent/30 border-t-accent animate-spin"></div>
          <div class="min-w-0">
            <div class="font-medium text-gray-200">Loading timeline</div>
            <div class="truncate text-gray-500">Please wait while {{ timeline.timelineLoadingFlightLabel }} opens.</div>
          </div>
        </div>
      </div>

      <div v-if="timeline.emptyStateMessage" class="p-4 text-center text-gray-500 text-sm">
        <div
          v-if="timeline.listStatus === 'loading'"
          class="mx-auto mb-2 h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin"
          role="status"
          aria-label="Loading saved flights"
        ></div>
        <div class="text-xs">{{ timeline.emptyStateMessage }}</div>
      </div>

      <template v-else>
        <div
          v-for="flight in flights"
          :key="flight.filePath || flight.flightId"
          class="px-4 py-3 border-b border-surface-200 last:border-0 hover:bg-surface-200/30 transition-colors"
          :class="{ 'bg-accent/5': isFlightLoading(flight) }"
        >
        <div class="flex items-center justify-between gap-2">
          <button
            type="button"
            class="flex flex-1 min-w-0 items-center justify-between gap-2 appearance-none border-0 bg-transparent p-0 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
            @click="openFlight(flight)"
          >
            <AircraftArtwork
              class="timeline-aircraft-thumb"
              :profile-id="flight.aircraftProfileId || flight.aircraft_profile_id || ''"
              :aircraft-name="getFlightAircraftLabel(flight)"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <div
                  class="text-sm font-medium truncate"
                  :class="flight.route ? 'text-accent' : 'text-gray-200'"
                >
                  {{ getFlightRouteLabel(flight) || 'Unknown' }}
                </div>
                <div v-if="isFlightLoading(flight)" class="h-3 w-3 rounded-full border-2 border-accent/30 border-t-accent animate-spin flex-shrink-0" aria-label="Loading timeline"></div>
              </div>
              <div class="flex items-center gap-2 mt-0.5 flex-wrap">
                <div class="text-xs text-gray-500">{{ flightTimestampKind(flight) }} {{ flightDateTimeLabel(flight) }}</div>
                <div v-if="getFlightAircraftLabel(flight)" class="text-xs text-gray-400">• {{ getFlightAircraftLabel(flight) }}</div>
                <div v-if="flight.durationFormatted || flight.durationMs" class="text-xs text-gray-500">• {{ flight.durationFormatted || formatDuration(flight.durationMs) }}</div>
                <div v-if="getFiniteDistanceNm(flight.distanceNm) !== null" class="text-xs text-gray-500">• {{ formatDistanceNm(flight.distanceNm) }}</div>
                <div v-if="getFlightBundleSizeBytes(flight) !== null" class="text-xs text-gray-500">• {{ formatBytes(getFlightBundleSizeBytes(flight)) }}</div>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <div v-if="isFlightLoading(flight)" class="h-3 w-3 rounded-full border-2 border-accent/30 border-t-accent animate-spin flex-shrink-0" aria-label="Loading timeline"></div>
              <div class="text-xs text-gray-500">{{ flight.eventCount }} samples</div>
            </div>
          </button>
          <div class="flex items-center gap-2 flex-shrink-0">
            <button
              v-if="hasLandingAction(flight)"
              type="button"
              class="px-2.5 py-1 text-[11px] font-semibold rounded border border-emerald-500/35 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
              title="Open the recorded landing card"
              @click.stop="openLanding(flight)"
            >
              Landing
            </button>
            <AppTooltip content="Delete this flight log">
              <button
                type="button"
                aria-label="Delete this flight log"
                class="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                @click.stop="deleteFlight(flight)"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/>
                </svg>
              </button>
            </AppTooltip>
          </div>
        </div>
        </div>
        <div v-if="timeline.hasMoreVisibleFlights" class="px-4 py-3">
          <button
            type="button"
            class="w-full px-3 py-2 text-xs font-medium rounded border border-surface-300 text-gray-300 hover:bg-surface-300/40 transition-colors"
            @click="timeline.showMoreFlights()"
          >
            Show more flights
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
