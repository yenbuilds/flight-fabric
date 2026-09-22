<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { containDialogFocus } from '../../ui/dialog-focus.js';
import { readStorageValue, writeStorageValue } from '../../app/browser-environment.js';
import { getAuthorizationScope, getCoordValidator } from '../../../app-shared.js';
import {
  subscribeLandingReceived,
  subscribeWsMessage,
} from '../../app/runtime-signals.js';
import { initTimelinePage } from '../../timeline/bootstrap.js';
import AircraftArtwork from './AircraftArtwork.vue';
import LogbookPanel from './LogbookPanel.vue';
import TimelineAnalysisRescoreModal from './TimelineAnalysisRescoreModal.vue';
import TimelineDetailPanel from './TimelineDetailPanel.vue';
import TimelineFlightsPanel from './TimelineFlightsPanel.vue';
import TimelineInspectorShell from './TimelineInspectorShell.vue';
import TimelineMapShell from './TimelineMapShell.vue';
import TimelineSummaryBar from './TimelineSummaryBar.vue';
import { useAppSettingsStore } from '../stores/app-settings.js';
import { useLandingStore } from '../stores/landing.js';
import { useStatusStore } from '../stores/status.js';
import { useTabsStore } from '../stores/tabs.js';
import { useTimelineStore } from '../stores/timeline.js';

const appSettings = useAppSettingsStore();
const landing = useLandingStore();
const status = useStatusStore();
const tabs = useTabsStore();
const timeline = useTimelineStore();
let cleanupTimelinePage = null;
const viewer = ref(null);
const viewerClose = ref(null);
let viewerReturnFocus = null;
const isCompactReview = ref(typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(max-width: 1100px)').matches : false);
const reviewViewStorageKey = 'flightFabric.logbookReviewView.v1';
const reviewView = ref(readStorageValue(reviewViewStorageKey) === 'map' ? 'map' : 'events');
let reviewMediaQuery = null;
const hasReview = computed(() => Boolean(timeline.timelineLoading || timeline.timelineLoadError || timeline.timelineMobileViewerOpen || timeline.loadedTimelineFilePath || timeline.loadedTimelineFlightId));
const isReviewModal = computed(() => isCompactReview.value && timeline.timelineMobileViewerOpen && timeline.listStatus !== 'restricted');

function syncReviewLayout(event) {
  isCompactReview.value = event.matches;
  notifyTimelineViewerResize();
}

function setReviewView(value) {
  reviewView.value = value;
  writeStorageValue(reviewViewStorageKey, value);
  timeline.clearDetail();
  nextTick(notifyTimelineViewerResize);
}

const timelineViewerClass = computed(() => [
  'timeline-split',
  timeline.timelineMobileViewerOpen ? 'timeline-mobile-viewer-open' : 'timeline-mobile-viewer-closed',
]);
const timelineViewerTitle = computed(() => {
  if (timeline.timelineLoadError) return timeline.timelineRetryRequest?.options?.flightLabel || 'Recording unavailable';
  if (timeline.timelineLoading) {
    return timeline.timelineLoadingFlightLabel || 'Loading timeline';
  }
  return timeline.loadedTimelineFlightLabel || timeline.inspectorFlightIdText;
});
const timelineViewerAircraft = computed(() => {
  if (timeline.timelineLoading) return '';
  const label = String(timeline.loadedTimelineAircraftLabel || '').trim();
  return /^(?:unknown|n\/?a|--?)$/i.test(label) ? '' : label;
});
function formatFlightDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value || '').trim());
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : '';
}
function formatRecordedDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const timelineViewerRecordingStartTime = computed(() => (
  timeline.timelineLoading ? '' : formatRecordedDateTime(timeline.loadedTimelineRecordingStartTime)
));
const timelineViewerLocalDateTime = computed(() => (
  timeline.timelineLoading ? '' : formatFlightDateTime(timeline.loadedTimelineSimDateTimeLocal)
));
const timelineViewerUtcDateTime = computed(() => (
  timeline.timelineLoading ? '' : formatFlightDateTime(timeline.loadedTimelineSimDateTimeUtc)
));
const timelineViewerDocumentLockActive = computed(() => (
  tabs.activeTabId === 'timeline' && isReviewModal.value
));

function notifyTimelineViewerResize() {
  if (typeof window === 'undefined') return;
  const dispatchResize = () => window.dispatchEvent(new Event('resize'));
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(dispatchResize);
  } else {
    dispatchResize();
  }
  window.setTimeout?.(dispatchResize, 160);
}

function setTimelineViewerDocumentState(isOpen) {
  if (typeof document === 'undefined') return;
  document.body?.classList.toggle('timeline-viewer-modal-open', isOpen);
}

function closeTimelineMobileViewer() {
  timeline.closeTimelineMobileViewer();
  notifyTimelineViewerResize();
}

function handleTimelineViewerKeydown(event) {
  if (event.defaultPrevented || tabs.activeTabId !== 'timeline') return;
  if (landing.landingModalOpen || landing.stabilityMetricModal.open) return;
  if (timeline.analysisRescoreModalOpen) return;
  if (isReviewModal.value) containDialogFocus(event, viewer.value);
  if (event?.key !== 'Escape') return;
  if (timeline.detailVisible) {
    timeline.clearDetail();
    return;
  }
  if (isReviewModal.value) closeTimelineMobileViewer();
}

watch(() => timeline.inspectorRevealRequest, () => {
  if (!isCompactReview.value) reviewView.value = 'events';
});

watch(
  () => timelineViewerDocumentLockActive.value,
  async (isActive) => {
    setTimelineViewerDocumentState(isActive);
    if (!isActive) {
      const target = viewerReturnFocus;
      viewerReturnFocus = null;
      await nextTick();
      // A wider window keeps the current event and keyboard focus in place.
      if (!isCompactReview.value && timeline.timelineMobileViewerOpen && tabs.activeTabId === 'timeline') {
        if (timeline.detailVisible) document.getElementById(`timeline-event-${timeline.inspectorSelectedRowKey}`)?.focus?.({ preventScroll: true });
        return;
      }
      if (target?.isConnected && tabs.activeTabId === 'timeline') target.focus?.({ preventScroll: true });
      return;
    }
    viewerReturnFocus = document.activeElement;
    await nextTick();
    if (!timelineViewerDocumentLockActive.value) return;
    const initialFocus = timeline.detailVisible ? document.getElementById('timeline-detail-close') : viewerClose.value;
    initialFocus?.focus?.({ preventScroll: true });
    notifyTimelineViewerResize();
  },
);

watch(
  () => tabs.activeTabId,
  (tabId) => {
    if (tabId !== 'timeline') {
      setTimelineViewerDocumentState(false);
    }
  },
);

onMounted(() => {
  reviewMediaQuery = window.matchMedia?.('(max-width: 1100px)');
  reviewMediaQuery?.addEventListener?.('change', syncReviewLayout);
  document.addEventListener('keydown', handleTimelineViewerKeydown);
  setTimelineViewerDocumentState(timelineViewerDocumentLockActive.value);

  cleanupTimelinePage = initTimelinePage({
    timelineStore: timeline,
    tabsStore: tabs,
    statusStore: status,
    getAuthorizationScope,
    getElementById: (id) => document.getElementById(id),
    isValidCoord: getCoordValidator(),
    windowRef: window,
    documentRef: document,
    allowOnlineMapTiles: () => appSettings.settings?.network?.onlineMapTiles !== false,
    subscribeLandingReceivedSignal: subscribeLandingReceived,
    subscribeWsMessageSignal: subscribeWsMessage,
  });
});

onUnmounted(() => {
  reviewMediaQuery?.removeEventListener?.('change', syncReviewLayout);
  document.removeEventListener('keydown', handleTimelineViewerKeydown);
  setTimelineViewerDocumentState(false);
  cleanupTimelinePage?.();
  cleanupTimelinePage = null;
});
</script>

<template>
  <div class="timeline-section-stack logbook-page" :class="{ 'is-restricted': timeline.listStatus === 'restricted' }">
    <div id="vue-logbook-root" class="logbook-history-summary">
      <LogbookPanel />
    </div>

    <div class="logbook-workspace">
    <div id="vue-timeline-flights-root">
      <TimelineFlightsPanel />
    </div>

    <div
      ref="viewer"
      :class="timelineViewerClass"
      :data-review-view="reviewView"
      :data-has-review="hasReview"
      tabindex="-1"
      :role="isReviewModal ? 'dialog' : 'region'"
      :aria-modal="isReviewModal ? 'true' : undefined"
      aria-labelledby="timeline-mobile-viewer-title"
    >
      <div
        id="timeline-mobile-viewer-header"
        class="timeline-mobile-viewer-header"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <AircraftArtwork
            v-if="!timeline.timelineLoading && timeline.loadedTimelineFlightLabel"
            class="timeline-mobile-aircraft-thumb"
            :profile-id="timeline.loadedTimelineAircraftProfileId"
            :aircraft-name="timelineViewerAircraft"
          />
          <div class="min-w-0">
            <div class="logbook-recorded-context">{{ hasReview ? 'Recorded flight' : 'Flight review' }}</div>
            <div class="flex min-w-0 items-baseline gap-2">
              <div id="timeline-mobile-viewer-title" class="min-w-0 truncate text-sm font-semibold text-gray-200">{{ hasReview ? timelineViewerTitle : 'Select a flight' }}</div>
              <span
                v-if="timelineViewerAircraft"
                aria-hidden="true"
                class="shrink-0 text-xs text-gray-600"
              >•</span>
              <div
                v-if="timelineViewerAircraft"
                id="timeline-mobile-viewer-aircraft"
                class="min-w-0 truncate text-xs text-gray-400"
                :title="timelineViewerAircraft"
              >
                {{ timelineViewerAircraft }}
              </div>
            </div>
            <div
              v-if="timelineViewerLocalDateTime || timelineViewerUtcDateTime || timelineViewerRecordingStartTime"
              id="timeline-mobile-viewer-flight-times"
              class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-400"
            >
              <span v-if="timelineViewerLocalDateTime">
                <span class="uppercase tracking-wide text-gray-500">Flight start local</span>
                <time
                  id="timeline-mobile-viewer-local-time"
                  class="ml-1 font-mono text-gray-300"
                  :datetime="timeline.loadedTimelineSimDateTimeLocal"
                >{{ timelineViewerLocalDateTime }}</time>
              </span>
              <span v-if="timelineViewerUtcDateTime">
                <span class="uppercase tracking-wide text-gray-500">Flight start UTC</span>
                <time
                  id="timeline-mobile-viewer-utc-time"
                  class="ml-1 font-mono text-gray-300"
                  :datetime="timeline.loadedTimelineSimDateTimeUtc"
                >{{ timelineViewerUtcDateTime }}</time>
              </span>
              <span
                v-if="timelineViewerRecordingStartTime"
                title="Recording start in this device's local timezone"
              >
                <span class="uppercase tracking-wide text-gray-500">Recorded</span>
                <time
                  id="timeline-mobile-viewer-recording-time"
                  class="ml-1 font-mono text-gray-300"
                  :datetime="timeline.loadedTimelineRecordingStartTime"
                >{{ timelineViewerRecordingStartTime }}</time>
              </span>
            </div>
          </div>
        </div>
        <div class="flex max-w-full shrink-0 flex-wrap items-center gap-2">
          <button
            v-if="timeline.latestLandingInspectorRow && timeline.detailLandingActionBound"
            id="timeline-mobile-viewer-landing-shortcut"
            type="button"
            class="ff-button-primary logbook-landing-shortcut"
            aria-haspopup="dialog"
            @click="timeline.openLatestLanding()"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <path d="M2 22h20M2 9.5l7 2-1-7 3 1 4 8 5 1.5a2 2 0 0 1-1 4L5 15 2 9.5Z" />
            </svg>
            Landing debrief
          </button>
          <button
            ref="viewerClose"
            v-if="isCompactReview"
            id="timeline-mobile-viewer-close"
            type="button"
            class="ff-button-secondary logbook-back-button"
            aria-label="Back to flights"
            @click="closeTimelineMobileViewer"
          >
            Back to flights
          </button>
        </div>
      </div>

      <div class="logbook-review-content">
      <div v-if="timeline.timelineLoadError" class="logbook-load-error" role="alert">
        <h3>Could not open this recording</h3>
        <p>{{ timeline.timelineLoadError }}</p>
        <button v-if="timeline.timelineRetryRequest" type="button" class="ff-button-secondary" :disabled="!timeline.canRetryTimeline" @click="timeline.retryTimeline()">Try again</button>
      </div>
      <div v-if="!hasReview" class="logbook-review-empty ff-empty-state">
        <svg class="ff-empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 5.5 9 3l6 2.5L20 3v15.5L15 21l-6-2.5L4 21V5.5Z M9 3v15.5M15 5.5V21" /></svg>
        <h3>Your flight, in context</h3>
        <p>Choose a saved flight to follow its route, inspect events, and review its landing.</p>
      </div>

      <div v-show="hasReview && !timeline.timelineLoadError" class="logbook-review-toolbar" role="group" aria-label="Recorded flight views">
        <div class="logbook-review-views">
          <button type="button" :aria-pressed="reviewView === 'events'" @click="setReviewView('events')">Events</button>
          <button type="button" :aria-pressed="reviewView === 'map'" @click="setReviewView('map')">Replay map</button>
        </div>
        <span class="logbook-history-label">Historical measurements</span>
      </div>

      <div v-show="hasReview && !timeline.timelineLoadError" id="vue-timeline-summary-root">
        <TimelineSummaryBar />
      </div>

      <div v-show="hasReview && !timeline.timelineLoadError" class="logbook-review-body">

      <div id="timeline-card" class="ff-card overflow-hidden">
        <div id="vue-timeline-inspector-shell-root">
          <TimelineInspectorShell :inline-details="!isCompactReview" />
        </div>

      </div>

      <div id="vue-timeline-map-shell-root">
        <TimelineMapShell />
      </div>

      <div v-if="isCompactReview" v-show="timeline.detailVisible" id="vue-timeline-detail-root">
        <TimelineDetailPanel />
      </div>

      </div>
      </div>
    </div>
    </div>

    <TimelineAnalysisRescoreModal />
  </div>
</template>

<style src="../../styles/logbook-workspace.css"></style>
