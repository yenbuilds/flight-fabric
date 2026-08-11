<script setup>
import { computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { getAuthorizationScope, getCoordValidator } from '../../../app-shared.js';
import {
  subscribeLandingReceived,
  subscribeWsMessage,
} from '../../app/runtime-signals.js';
import { initTimelinePage } from '../../timeline/bootstrap.js';
import LogbookPanel from './LogbookPanel.vue';
import TimelineAnalysisRescoreModal from './TimelineAnalysisRescoreModal.vue';
import TimelineDetailPanel from './TimelineDetailPanel.vue';
import TimelineFlightsPanel from './TimelineFlightsPanel.vue';
import TimelineInspectorShell from './TimelineInspectorShell.vue';
import TimelineMapShell from './TimelineMapShell.vue';
import TimelineSummaryBar from './TimelineSummaryBar.vue';
import { useAppSettingsStore } from '../stores/app-settings.js';
import { useStatusStore } from '../stores/status.js';
import { useTabsStore } from '../stores/tabs.js';
import { useTimelineStore } from '../stores/timeline.js';

const appSettings = useAppSettingsStore();
const status = useStatusStore();
const tabs = useTabsStore();
const timeline = useTimelineStore();
let cleanupTimelinePage = null;

const timelineViewerClass = computed(() => [
  'timeline-split',
  timeline.timelineMobileViewerOpen ? 'timeline-mobile-viewer-open' : 'timeline-mobile-viewer-closed',
]);
const timelineViewerTitle = computed(() => {
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
const timelineViewerDocumentLockActive = computed(() => (
  tabs.activeTabId === 'timeline' && timeline.timelineMobileViewerOpen
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
  if (event?.key !== 'Escape') return;
  if (timeline.analysisRescoreModalOpen) {
    timeline.closeAnalysisRescoreModal();
    return;
  }
  if (timeline.detailVisible) {
    timeline.clearDetail();
    return;
  }
  if (timeline.timelineMobileViewerOpen) closeTimelineMobileViewer();
}

watch(
  () => timelineViewerDocumentLockActive.value,
  async (isActive) => {
    setTimelineViewerDocumentState(isActive);
    if (!isActive) return;
    await nextTick();
    notifyTimelineViewerResize();
  },
);

watch(
  () => tabs.activeTabId,
  (tabId) => {
    if (tabId !== 'timeline' && timeline.timelineMobileViewerOpen) {
      timeline.closeTimelineMobileViewer();
    }
    if (tabId !== 'timeline') {
      setTimelineViewerDocumentState(false);
    }
  },
);

onMounted(() => {
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
  document.removeEventListener('keydown', handleTimelineViewerKeydown);
  setTimelineViewerDocumentState(false);
  cleanupTimelinePage?.();
  cleanupTimelinePage = null;
});
</script>

<template>
  <div class="timeline-section-stack">
    <div id="vue-logbook-root">
      <LogbookPanel />
    </div>

    <div id="vue-timeline-flights-root">
      <TimelineFlightsPanel />
    </div>

    <div
      :class="timelineViewerClass"
      :role="timeline.timelineMobileViewerOpen ? 'dialog' : undefined"
      :aria-modal="timeline.timelineMobileViewerOpen ? 'true' : undefined"
      :aria-labelledby="timeline.timelineMobileViewerOpen ? 'timeline-mobile-viewer-title' : undefined"
    >
      <div
        v-if="timeline.timelineMobileViewerOpen"
        id="timeline-mobile-viewer-header"
        class="timeline-mobile-viewer-header"
      >
        <div class="min-w-0">
          <div class="text-[10px] uppercase tracking-widest text-gray-500">Timeline replay</div>
          <div class="flex min-w-0 items-baseline gap-2">
            <div id="timeline-mobile-viewer-title" class="min-w-0 truncate text-sm font-semibold text-gray-200">{{ timelineViewerTitle }}</div>
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
        </div>
        <button
          id="timeline-mobile-viewer-close"
          type="button"
          class="shrink-0 px-3 py-1.5 text-xs font-semibold rounded border border-surface-300 text-gray-200 hover:bg-surface-300/50 transition-colors"
          aria-label="Close timeline replay"
          @click="closeTimelineMobileViewer"
        >
          Close
        </button>
      </div>

      <div id="timeline-card" class="ff-card overflow-hidden">
        <div id="vue-timeline-inspector-shell-root">
          <TimelineInspectorShell />
        </div>

        <div id="vue-timeline-summary-root">
          <TimelineSummaryBar />
        </div>

      </div>

      <div id="vue-timeline-map-shell-root">
        <TimelineMapShell />
      </div>

      <div id="vue-timeline-detail-root">
        <TimelineDetailPanel />
      </div>
    </div>

    <TimelineAnalysisRescoreModal />
  </div>
</template>
