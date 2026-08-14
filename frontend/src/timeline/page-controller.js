export function createTimelinePageController({
  timelineStore,
  timelineMapController,
  normalizeTimelineForUI,
  compactTimelineEvents,
  buildTimelineSummaryState,
  buildTimelineEventDetailState,
  buildTimelineEventRows,
  documentRef = document,
  typeLabels = {},
  markerLabels = {},
  formatTimeOffset = (ms) => String(ms),
  getEventPosition = () => null,
  setupTimelineScrubber = () => {},
  scrubToOffset = () => {},
  getTimelineScrubberPointsLength = () => 0,
  resetScrubberUi = () => {},
  buildDurationText = () => '--',
  getApproachProfileApi = () => null,
} = {}) {
  let currentTimeline = null;
  let displayedTimelineRows = [];

  function getRowOptions() {
    return {
      typeLabels,
      markerLabels,
      formatTimeOffset,
    };
  }

  function syncInspectorState({
    flightIdText = 'Select a saved flight to view timeline',
    routeText = '',
    routeVisible = false,
    rows = [],
    selectedRowKey = '',
    emptyVisible = false,
    emptyMessage = '',
  } = {}) {
    timelineStore.setInspectorState({
      flightIdText,
      routeText,
      routeVisible,
      rows,
      selectedRowKey,
      emptyVisible,
      emptyMessage,
    });
  }

  function showEventDetail(event, rowKey = '', options = {}) {
    timelineStore.setSelectedEventRowKey(rowKey || '');
    if (options.focusMap !== false) {
      timelineMapController.focusEvent(event);
    }
    timelineStore.setDetail(buildTimelineEventDetailState(event, {
      approachProfileApi: getApproachProfileApi(),
      typeLabels,
      markerLabels,
    }));
  }

  function findRenderedRowElement(rowKey) {
    if (!documentRef || typeof documentRef.querySelector !== 'function' || !rowKey) return null;
    return documentRef.querySelector(`[data-row-key="${rowKey}"]`);
  }

  function scrollRenderedRowIntoView(rowKey) {
    const element = findRenderedRowElement(rowKey);
    if (element) {
      element.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      return;
    }

    const windowRef = documentRef?.defaultView;
    if (typeof windowRef?.setTimeout === 'function') {
      windowRef.setTimeout(() => {
        findRenderedRowElement(rowKey)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      }, 0);
    }
  }

  function selectTimelineRowByOriginalIndex(originalIndex, options = {}) {
    if (!Number.isFinite(originalIndex) || originalIndex < 0) return;
    if (!Array.isArray(displayedTimelineRows) || displayedTimelineRows.length === 0) return;

    const row = displayedTimelineRows.find((item) => {
      if (!item || !item.event) return false;
      const start = Number(item.originalIndexStart);
      const end = Number(item.originalIndexEnd);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        return originalIndex >= start && originalIndex <= end;
      }
      if (Number.isFinite(start)) {
        return originalIndex === start;
      }
      return false;
    });

    if (!row) return;

    timelineStore.ensureInspectorRowVisible?.(row.rowKey);
    scrollRenderedRowIntoView(row.rowKey);
    showEventDetail(row.event, row.rowKey, options);
  }

  function handleStoreRowSelection(row) {
    if (!row?.event) return false;
    showEventDetail(row.event, row.rowKey);
    return true;
  }

  function loadTimeline(timeline) {
    const normalizedTimeline = normalizeTimelineForUI(timeline);
    currentTimeline = normalizedTimeline;
    displayedTimelineRows = [];
    timelineStore.setLoadedTimelineIdentity?.(normalizedTimeline);

    if (!normalizedTimeline || !normalizedTimeline.events || normalizedTimeline.events.length === 0) {
      showEmpty();
      return;
    }

    const routeStr = normalizedTimeline.route || '';
    const durationStr = buildDurationText(normalizedTimeline);
    const displayEvents = compactTimelineEvents(normalizedTimeline.events);
    const timelineTrackPoints = timelineMapController.render(normalizedTimeline);
    setupTimelineScrubber(normalizedTimeline, timelineTrackPoints);
    timelineStore.setSummary(buildTimelineSummaryState(normalizedTimeline, displayEvents));

    const startMs = normalizedTimeline.events[0]?.timestampMs ?? Date.now();
    displayedTimelineRows = buildTimelineEventRows(displayEvents, {
      startMs,
      rowOptions: getRowOptions(),
    });

    syncInspectorState({
      flightIdText: routeStr ? durationStr : (normalizedTimeline.flightId || 'Unknown Flight'),
      routeText: routeStr,
      routeVisible: Boolean(routeStr),
      rows: displayedTimelineRows,
      selectedRowKey: '',
      emptyVisible: false,
    });

    const firstWithPos = displayEvents.find((event) => getEventPosition(event));
    if (firstWithPos) {
      timelineMapController.focusEvent(firstWithPos);
    } else if (getTimelineScrubberPointsLength() > 0) {
      scrubToOffset(0, true);
    }

    timelineStore.clearDetail();
  }

  function showEmpty(options = {}) {
    const message = typeof options.message === 'string' ? options.message.trim() : '';
    currentTimeline = null;
    timelineStore.setLoadedTimelineIdentity?.(null);
    displayedTimelineRows = [];
    syncInspectorState({ emptyVisible: true, emptyMessage: message });
    timelineStore.clearSummary();
    timelineStore.clearDetail();
    if (message) {
      timelineStore.setMapEmptyState({ visible: true, message });
    } else {
      timelineStore.resetMapEmptyState();
    }
    resetScrubberUi();
    timelineMapController.reset();
  }

  function clearForLoading() {
    currentTimeline = null;
    displayedTimelineRows = [];
    resetScrubberUi();
    timelineMapController.reset();
  }

  timelineStore.bindInspectorActions({
    onSelectRow: handleStoreRowSelection,
  });

  function cleanup() {
    timelineStore.bindInspectorActions({});
    currentTimeline = null;
    displayedTimelineRows = [];
  }

  return {
    cleanup,
    clearForLoading,
    getCurrentTimeline: () => currentTimeline,
    loadTimeline,
    selectTimelineRowByOriginalIndex,
    showEmpty,
    showEventDetail,
  };
}
