<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import AircraftArtwork from './AircraftArtwork.vue';
import TimelineDetailPanel from './TimelineDetailPanel.vue';
import { useTimelineStore } from '../stores/timeline.js';
import { INSPECTOR_FILTER_OPTIONS } from '../../timeline/constants.js';

const props = defineProps({ inlineDetails: { type: Boolean, default: false } });
const timeline = useTimelineStore();
const eventList = ref(null);
const eventScroller = ref(null);
const hiddenListTypeCount = computed(() => INSPECTOR_FILTER_OPTIONS.filter(option => timeline.inspectorFilters[option.key] === false).length);
const scrollBehavior = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
const isExpanded = (row) => timeline.detailVisible && timeline.inspectorSelectedRowKey === row.rowKey;
const selectedButton = () => Array.from(eventList.value?.querySelectorAll('[data-row-key]') || [])
  .find(button => button.dataset.rowKey === timeline.inspectorSelectedRowKey);

watch(() => timeline.inspectorRevealRequest, async () => {
  if (!props.inlineDetails) return;
  // Wait for pagination and a temporary filter exception to render before
  // moving to the event. Repeated map clicks request another scroll too.
  await nextTick();
  const button = selectedButton();
  button?.focus({ preventScroll: true });
  const scroller = eventScroller.value;
  if (button && scroller) {
    const row = button.getBoundingClientRect();
    const clip = scroller.getBoundingClientRect();
    scroller.scrollTo({ top: scroller.scrollTop + row.top - clip.top - (scroller.clientHeight - row.height) / 2, behavior: scrollBehavior() });
  }
});

watch(() => [timeline.detailVisible, timeline.inspectorSelectedRowKey, props.inlineDetails], async ([visible, rowKey, inline]) => {
  if (!visible || !inline) return;
  await nextTick();
  if (!timeline.detailVisible || timeline.inspectorSelectedRowKey !== rowKey || !props.inlineDetails) return;
  const button = selectedButton();
  const detail = button?.closest('.timeline-event-item')?.querySelector('.timeline-event-detail');
  const scroller = eventScroller.value;
  if (!button || !detail || !scroller) return;
  const row = button.getBoundingClientRect();
  const content = detail.getBoundingClientRect();
  const clip = scroller.getBoundingClientRect();
  const top = clip.top + 8;
  const bottom = clip.top + scroller.clientHeight - 8;
  if (row.top < top || content.bottom > bottom) {
    // Reveal the complete detail when it fits; taller details start beneath
    // their visible heading. Scroll only the event pane, never the whole app.
    scroller.scrollTo({ top: scroller.scrollTop + Math.min(content.bottom - bottom, row.top - top), behavior: scrollBehavior() });
  }
});

watch(() => timeline.detailVisible, async (visible) => {
  if (!props.inlineDetails || visible) return;
  const focusInDetail = eventList.value?.querySelector('#timeline-detail')?.contains(document.activeElement);
  if (!focusInDetail && selectedButton() !== document.activeElement) return;
  await nextTick();
  if (timeline.detailVisible) return;
  const button = selectedButton();
  button?.focus({ preventScroll: true });
  const scroller = eventScroller.value;
  if (!button || !scroller) return;
  const row = button.getBoundingClientRect();
  const clip = scroller.getBoundingClientRect();
  const delta = row.top < clip.top + 8 ? row.top - clip.top - 8
    : row.bottom > clip.bottom - 8 ? row.bottom - clip.bottom + 8 : 0;
  if (delta) scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: scrollBehavior() });
});
const timelineAircraftName = computed(() => {
  const label = String(timeline.loadedTimelineAircraftLabel || '').trim();
  return /^(?:unknown|n\/?a|--?)$/i.test(label) ? '' : label;
});
</script>

<template>
  <div>
    <div class="timeline-card-header flex items-center justify-between gap-3 p-3 sm:p-4 border-b border-surface-200">
      <div class="flex items-center gap-2 sm:gap-3">
        <svg class="w-4 h-4 sm:w-5 sm:h-5 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <div class="text-xs sm:text-sm font-semibold">Flight events</div>
          <div id="timeline-flight-id" class="text-[10px] sm:text-xs text-gray-500">{{ timeline.inspectorFlightIdText }}</div>
          <div
            id="timeline-flight-route"
            class="text-xs text-accent"
            :class="{ hidden: !timeline.inspectorRouteVisible }"
          >
            {{ timeline.inspectorRouteText }}
          </div>
          <div v-if="timelineAircraftName" class="mt-0.5 max-w-[24rem] truncate text-[10px] text-gray-500">
            {{ timelineAircraftName }}
          </div>
        </div>
      </div>
      <AircraftArtwork
        v-if="!timeline.timelineLoading && timeline.loadedTimelineFlightLabel"
        class="timeline-inspector-aircraft-art"
        :profile-id="timeline.loadedTimelineAircraftProfileId"
        :aircraft-name="timelineAircraftName"
      />
    </div>

    <details v-if="timeline.inspectorAllRows.length" class="border-b border-surface-200 px-4 text-xs">
      <summary class="flex flex-wrap min-h-[44px] cursor-pointer items-center gap-2 py-2 text-gray-400 hover:text-gray-200">
        <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4h16v3l-6 6v6l-4 2v-8L4 7z" />
        </svg>
        Filter event list
        <span v-if="hiddenListTypeCount" class="ml-auto text-accent" role="status">{{ timeline.inspectorHiddenRowCount ? `${timeline.inspectorHiddenRowCount} hidden` : `${hiddenListTypeCount} ${hiddenListTypeCount === 1 ? 'type' : 'types'} off` }}</span>
      </summary>
      <div class="pb-2" role="group" aria-label="Show in timeline list">
        <p class="py-2 text-muted-fg">These filters affect the list only. Map events are filtered separately.</p>
        <label v-for="option in INSPECTOR_FILTER_OPTIONS" :key="option.key" class="flex min-h-[44px] cursor-pointer items-center gap-3 py-1.5">
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 accent-accent"
            :data-timeline-event-filter="option.key"
            :checked="timeline.inspectorFilters[option.key]"
            @change="timeline.setInspectorFilter(option.key, $event.target.checked)"
          >
          <span>
            <span class="block text-gray-300">{{ option.label }}</span>
            <span class="text-[10px] text-gray-500">{{ option.detail }}</span>
          </span>
        </label>
      </div>
    </details>

    <div id="timeline-events" ref="eventScroller" class="relative h-96 overflow-y-auto px-4 py-2">
      <div v-if="timeline.inspectorAllRows.length && !timeline.inspectorTotalRowCount" class="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-gray-500" role="status">
        <span>No events match these filters.</span>
        <span>Enable an event type above to show it.</span>
      </div>
      <div
        id="timeline-empty"
        class="flex flex-col items-center justify-center h-full text-gray-500"
        :class="{ hidden: !timeline.inspectorEmptyVisible }"
      >
        <div
          v-if="timeline.timelineLoading"
          class="w-10 h-10 mb-3 rounded-full border-2 border-accent/25 border-t-accent animate-spin"
          aria-hidden="true"
        ></div>
        <svg v-else class="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div class="text-sm text-center px-4">{{ timeline.inspectorEmptyMessage }}</div>
        <div class="text-xs text-gray-600 mt-1">
          {{ timeline.timelineLoading ? `Preparing ${timeline.timelineLoadingFlightLabel}` : 'Choose a flight from Recent flights to begin' }}
        </div>
      </div>

      <div
        id="timeline-event-list"
        ref="eventList"
        class="space-y-1"
        :class="{ hidden: !timeline.inspectorEventListVisible }"
      >
        <div v-for="row in timeline.inspectorRows" :key="row.rowKey" class="timeline-event-item">
          <button
            :id="`timeline-event-${row.rowKey}`"
            type="button"
            class="timeline-event block w-full appearance-none border-0 bg-transparent text-left"
            :class="{
              selected: timeline.inspectorSelectedRowKey === row.rowKey,
            }"
            :data-index="String(row.index)"
            :data-row-key="row.rowKey"
            :data-type="row.type"
            :aria-current="timeline.inspectorSelectedRowKey === row.rowKey ? 'true' : undefined"
            :aria-expanded="inlineDetails ? isExpanded(row) : undefined"
            :aria-controls="inlineDetails && isExpanded(row) ? 'timeline-detail' : undefined"
            :aria-haspopup="inlineDetails ? undefined : 'dialog'"
            @click="inlineDetails ? timeline.toggleEventRowDetail(row.rowKey) : timeline.selectEventRow(row.rowKey)"
          >
            <div class="timeline-event-row">
              <div class="timeline-event-time">{{ row.timeOffsetText }}</div>
              <span class="timeline-event-dot" aria-hidden="true"></span>
              <div class="timeline-event-body">
                <div class="timeline-event-title-row">
                  <span class="timeline-event-title">{{ row.title }}</span>
                  <span
                    v-for="badge in row.badges"
                    :key="`${row.rowKey}-${badge.text}`"
                    class="timeline-score-badge"
                    :class="badge.toneClass"
                  >
                    {{ badge.text }}
                  </span>
                  <span v-if="row.countText" class="timeline-count-badge">{{ row.countText }}</span>
                </div>
                <div v-if="row.subtitle" class="timeline-event-subtitle">{{ row.subtitle }}</div>
                <div v-if="timeline.inspectorFilters[row.event?.type] === false" class="timeline-event-subtitle">Shown from map · hidden by list filters</div>
                <div
                  v-if="row.showEndpointDateTime && (row.localDateTimeText || row.utcDateTimeText)"
                  class="mt-0.5 flex flex-wrap gap-x-2 gap-y-0 text-[10px] font-mono text-gray-500"
                >
                  <span v-if="row.localDateTimeText">LT {{ row.localDateTimeText }}</span>
                  <span v-if="row.utcDateTimeText">UTC {{ row.utcDateTimeText }}</span>
                </div>
                <span v-if="inlineDetails" class="timeline-event-disclosure">
                  {{ isExpanded(row) ? 'Hide details' : 'Details' }}
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" :class="{ 'is-expanded': isExpanded(row) }"><path d="m4 6 4 4 4-4" stroke-width="1.5" /></svg>
                </span>
              </div>
            </div>
          </button>
          <TimelineDetailPanel v-if="inlineDetails && isExpanded(row)" inline :labelled-by="`timeline-event-${row.rowKey}`" />
        </div>
        <div v-if="timeline.hasMoreInspectorRows" class="pt-2">
          <div v-if="timeline.inspectorRowsMeta" class="mb-2 text-center text-[11px] text-gray-500">
            {{ timeline.inspectorRowsMeta }}
          </div>
          <button
            type="button"
            class="w-full px-3 py-2 text-xs font-medium rounded border border-surface-300 text-gray-300 hover:bg-surface-300/40 transition-colors"
            @click="timeline.showMoreInspectorRows()"
          >
            Show more events
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
