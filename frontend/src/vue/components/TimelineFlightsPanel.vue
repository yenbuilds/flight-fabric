<script setup>
import { computed, ref } from 'vue';
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
const routeFilterInput = ref(null);

const flights = computed(() => timeline.visibleFlights);
const hasFilters = computed(() => Boolean(timeline.routeFilter.trim() || timeline.aircraftFilter.trim()));
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

function isFlightSelected(flight) {
  return Boolean((flight.filePath && flight.filePath === timeline.loadedTimelineFilePath)
    || (flight.flightId && flight.flightId === timeline.loadedTimelineFlightId));
}

function clearFilters() {
  timeline.setRouteFilter('');
  timeline.setAircraftFilter('');
  routeFilterInput.value?.focus?.({ preventScroll: true });
}

const emptyTitle = computed(() => {
  if (timeline.listStatus === 'not-connected') return 'Your flight history is waiting';
  if (timeline.listStatus === 'loading') return 'Loading your flights';
  if (timeline.listStatus === 'error') return 'Couldn’t load your flights';
  if (timeline.listStatus === 'restricted') return 'Open your history on desktop';
  if (timeline.historyIndexStatus?.busy) return 'Preparing your flight history';
  if (hasFilters.value) return 'No matching flights';
  return 'Your flights, ready to replay';
});
const emptyDescription = computed(() => {
  if (timeline.listStatus === 'not-connected') return 'Connect to Flight Fabric on your simulator PC to browse saved flights.';
  if (timeline.listStatus === 'error' || timeline.listStatus === 'restricted' || timeline.historyIndexStatus?.busy) return timeline.emptyStateMessage;
  if (timeline.listStatus === 'loading') return 'Recent recordings will appear here as they load.';
  if (hasFilters.value) return 'Try another airport or aircraft, or clear your filters to see all flights.';
  return 'Record a flight to revisit its route, flight events, and landing.';
});

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
        <h2 class="text-sm font-semibold text-gray-200">Recent flights</h2>
        <div class="text-xs text-gray-400 mt-0.5">Choose a flight to explore its route, events, and landing.</div>
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
          class="ff-button-secondary timeline-refresh-button"
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
        <label class="timeline-filter-field">
          <span>Route or airport</span>
        <input
          ref="routeFilterInput"
          :value="timeline.routeFilter"
          type="search"
          placeholder="e.g. YSSY or EGLL"
          style="color-scheme: dark"
          class="timeline-filter-control w-full px-3 py-2 text-xs rounded border border-surface-300 bg-surface-200 text-gray-200 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-accent/50"
          @input="timeline.setRouteFilter($event.target.value)"
        />
        </label>
        <label class="timeline-filter-field">
          <span>Aircraft</span>
        <input
          :value="timeline.aircraftFilter"
          type="search"
          placeholder="e.g. A320"
          style="color-scheme: dark"
          class="timeline-filter-control w-full px-3 py-2 text-xs rounded border border-surface-300 bg-surface-200 text-gray-200 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-accent/50"
          @input="timeline.setAircraftFilter($event.target.value)"
        />
        </label>
        <label class="timeline-filter-field">
          <span>Sort by</span>
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
        </label>
      </div>
      <div class="timeline-filter-summary">
        <span role="status" aria-live="polite">{{ timeline.flightsMeta }}</span>
        <button v-if="hasFilters" type="button" class="timeline-clear-filters" @click="clearFilters">Clear filters</button>
      </div>
    </div>

    <div v-if="timeline.listStatus === 'error' && flights.length" class="px-4 py-3 text-xs text-amber-300 border-b border-surface-200" role="status">
      {{ timeline.listErrorMessage || 'Couldn’t refresh your flights. Your previous results are still available.' }}
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

    <div class="timeline-flight-list" :aria-busy="timeline.listStatus === 'loading'">
      <div
        v-if="timeline.timelineLoading"
        role="status"
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

      <div v-if="timeline.emptyStateMessage" class="ff-empty-state" role="status">
        <div
          v-if="timeline.listStatus === 'loading'"
          class="mx-auto mb-2 h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin"
          role="status"
          aria-label="Loading saved flights"
        ></div>
        <svg v-else class="ff-empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 5.5 9 3l6 2.5L20 3v15.5L15 21l-6-2.5L4 21V5.5Z M9 3v15.5M15 5.5V21" /></svg>
        <h3>{{ emptyTitle }}</h3>
        <p>{{ emptyDescription }}</p>
      </div>

      <template v-else>
        <div
          v-for="flight in flights"
          :key="flight.filePath || flight.flightId"
          class="timeline-flight-row"
          :class="{ 'is-loading': isFlightLoading(flight), 'is-selected': isFlightSelected(flight) }"
        >
        <div class="timeline-flight-row-layout">
          <button
            type="button"
            class="timeline-flight-open"
            :aria-label="`Replay ${getFlightRouteLabel(flight) || 'flight'}, ${getFlightAircraftLabel(flight) || 'unknown aircraft'}, ${flightDateTimeLabel(flight)}`"
            :aria-current="isFlightSelected(flight) ? 'true' : undefined"
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
                  class="timeline-flight-route"
                >
                  {{ getFlightRouteLabel(flight) || 'Route unavailable' }}
                </div>
                <div v-if="isFlightLoading(flight)" class="h-3 w-3 rounded-full border-2 border-accent/30 border-t-accent animate-spin flex-shrink-0" aria-label="Loading timeline"></div>
              </div>
              <div class="timeline-flight-aircraft">{{ getFlightAircraftLabel(flight) || 'Aircraft unavailable' }}</div>
              <div class="timeline-flight-meta">
                <span>{{ flightTimestampKind(flight) }} {{ flightDateTimeLabel(flight) }}</span>
                <span v-if="flight.durationFormatted || flight.durationMs">{{ flight.durationFormatted || formatDuration(flight.durationMs) }}</span>
                <span v-if="getFiniteDistanceNm(flight.distanceNm) !== null">{{ formatDistanceNm(flight.distanceNm) }}</span>
              </div>
            </div>
            <div class="timeline-flight-replay-hint" aria-hidden="true">
              <span>{{ isFlightLoading(flight) ? 'Opening' : isFlightSelected(flight) ? 'Open again' : 'Replay' }}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 5 7 7-7 7" /></svg>
            </div>
          </button>
          <div class="timeline-flight-actions">
            <AppTooltip v-slot="{ tooltipId }" :content="`${flight.eventCount ?? 0} samples${getFlightBundleSizeBytes(flight) !== null ? ` · ${formatBytes(getFlightBundleSizeBytes(flight))}` : ''}`">
              <button type="button" class="timeline-flight-info" :aria-describedby="tooltipId" :aria-label="`Recording details for ${getFlightRouteLabel(flight) || 'flight'}`">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></svg>
              </button>
            </AppTooltip>
            <button
              v-if="hasLandingAction(flight)"
              type="button"
              class="ff-button-secondary timeline-flight-landing"
              title="Open the recorded landing card"
              @click.stop="openLanding(flight)"
            >
              Landing
            </button>
            <AppTooltip content="Delete this flight log">
              <button
                type="button"
                aria-label="Delete this flight log"
                class="timeline-flight-delete"
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
