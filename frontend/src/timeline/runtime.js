import { watch } from 'vue';

const TIMELINE_LIST_TRANSIENT_RETRY_LIMIT = 4;
const TIMELINE_LIST_TRANSIENT_RETRY_DELAY_MS = 500;
const TIMELINE_LIST_TRANSIENT_RETRY_MAX_DELAY_MS = 4000;
const TIMELINE_LIST_NOT_READY_MESSAGE = 'Saved flights are still being prepared. Select Refresh Page to try again.';

export function createTimelineRuntime({
  windowRef = window,
  subscribeLandingReceivedSignal = null,
  subscribeWsMessageSignal = null,
  tabsStore = null,
  statusStore = null,
  getAuthorizationScope = null,
  timelineStore,
  timelinePage,
  timelineMapController,
  getCurrentTimeline = () => null,
} = {}) {
  const cleanupFns = [];
  const pendingRequestTimers = new Set();
  let initialized = false;
  let pendingTimelineListRequestCount = 0;
  let timelineListRetryCount = 0;
  let timelineListRetryTimer = null;

  function hasFullControl() {
    return typeof getAuthorizationScope !== 'function'
      || getAuthorizationScope() === 'full-control';
  }

  function requestTimelineList() {
    if (!hasFullControl()) {
      timelineStore.markListRestricted?.();
      return false;
    }
    return timelineStore.requestList();
  }

  function scheduleTrackedTimeout(callback, delayMs = 0) {
    let fired = false;
    let timerId = null;
    timerId = windowRef.setTimeout(() => {
      fired = true;
      if (timerId != null) pendingRequestTimers.delete(timerId);
      callback();
    }, delayMs);
    if (!fired) pendingRequestTimers.add(timerId);
    return timerId;
  }

  function clearTimelineListRetry({ resetCount = true } = {}) {
    if (timelineListRetryTimer != null) {
      windowRef.clearTimeout?.(timelineListRetryTimer);
      pendingRequestTimers.delete(timelineListRetryTimer);
      timelineListRetryTimer = null;
    }
    if (resetCount) timelineListRetryCount = 0;
  }

  function isCurrentTimelineListMessage(msg) {
    return !Number.isSafeInteger(msg?.requestId)
      || msg.requestId === timelineStore.timelineListRequestId;
  }

  function scheduleTimelineListRetry(msg) {
    if (!isCurrentTimelineListMessage(msg) || timelineListRetryTimer != null) return;
    if (timelineListRetryCount >= TIMELINE_LIST_TRANSIENT_RETRY_LIMIT) {
      timelineStore.failList?.(TIMELINE_LIST_NOT_READY_MESSAGE);
      timelineListRetryCount = 0;
      return;
    }

    const requestedDelay = Number(msg?.retryAfterMs);
    const baseDelay = Number.isFinite(requestedDelay) && requestedDelay > 0
      ? requestedDelay
      : TIMELINE_LIST_TRANSIENT_RETRY_DELAY_MS;
    const delayMs = Math.min(
      TIMELINE_LIST_TRANSIENT_RETRY_MAX_DELAY_MS,
      baseDelay * (2 ** timelineListRetryCount),
    );
    timelineListRetryCount += 1;
    timelineListRetryTimer = scheduleTrackedTimeout(() => {
      timelineListRetryTimer = null;
      requestTimelineList();
    }, delayMs);
  }

  function finishTimelineLoading() {
    if (typeof timelineStore.finishTimelineLoading === 'function') {
      timelineStore.finishTimelineLoading();
      return;
    }
    timelineStore.clearTimelineLoading?.();
  }

  function scheduleTimelineListRequest(delayMs = 500) {
    pendingTimelineListRequestCount += 1;
    return scheduleTrackedTimeout(() => {
      pendingTimelineListRequestCount = Math.max(0, pendingTimelineListRequestCount - 1);
      requestTimelineList();
    }, delayMs);
  }

  function handleWsMessage(msg) {
    if (!msg) return;

    if (msg.type === 'authorizationScope') {
      if (msg.scope === 'full-control') {
        // Reuse a pending ready-state refresh when there is one. If it already
        // fired before authorization arrived, request now so desktop history
        // cannot remain in the fail-closed placeholder state.
        if (pendingTimelineListRequestCount === 0) requestTimelineList();
      } else {
        clearTimelineListRetry();
        timelineStore.markListRestricted?.();
      }
      return;
    }

    if (msg.type === 'timelineList' && isCurrentTimelineListMessage(msg)) {
      clearTimelineListRetry();
    }

    if (msg.type === 'timelineListError' && isCurrentTimelineListMessage(msg)) {
      if (msg.retryable === true) {
        scheduleTimelineListRetry(msg);
      } else {
        clearTimelineListRetry();
      }
    }

    if (msg.type === 'timeline' && msg.timeline) {
      timelinePage.loadTimeline(msg.timeline);
      finishTimelineLoading();
      timelineStore.openPendingFlightLandingFromTimeline?.(timelinePage.getCurrentTimeline?.() || msg.timeline);
      if (timelineStore.timelineMobileViewerOpen) {
        scheduleTimelineViewerMapRender();
      }
    }

    if (msg.type === 'timelineError') {
      const errorMessage = `Could not load timeline: ${msg.error || 'unknown error'}`;
      finishTimelineLoading();
      timelineStore.failPendingFlightLanding?.(errorMessage);
      timelinePage.showEmpty?.({ message: errorMessage });
    }

    if (msg.type === 'deleteFlightCsvResult' && !msg.success) {
      windowRef.alert(`Could not delete flight log: ${msg.error || 'unknown error'}`);
    }
  }

  function handleTimelineActivated() {
    requestTimelineList();
    const currentTimeline = getCurrentTimeline();
    if (currentTimeline) {
      timelineMapController.render(currentTimeline);
    } else {
      timelineMapController.invalidateSizeStaggered();
    }
  }

  function handleMapFiltersChanged() {
    const currentTimeline = getCurrentTimeline();
    if (currentTimeline) {
      timelineMapController.render(currentTimeline);
    }
  }

  function renderCurrentTimelineMap() {
    const currentTimeline = getCurrentTimeline();
    if (currentTimeline) {
      timelineMapController.render(currentTimeline);
    } else {
      timelineMapController.invalidateSizeStaggered();
    }
  }

  function scheduleTimelineViewerMapRender() {
    if (typeof windowRef?.requestAnimationFrame === 'function') {
      windowRef.requestAnimationFrame(renderCurrentTimelineMap);
    } else {
      renderCurrentTimelineMap();
    }
    if (typeof windowRef?.setTimeout === 'function') {
      scheduleTrackedTimeout(renderCurrentTimelineMap, 160);
    }
  }

  function bindWindowEvents() {
    if (typeof subscribeWsMessageSignal === 'function') {
      const unsubscribe = subscribeWsMessageSignal(handleWsMessage);
      if (typeof unsubscribe === 'function') {
        cleanupFns.push(unsubscribe);
      }
    }
    if (typeof subscribeLandingReceivedSignal === 'function') {
      const unsubscribe = subscribeLandingReceivedSignal(() => {
        scheduleTimelineListRequest(500);
      });
      if (typeof unsubscribe === 'function') {
        cleanupFns.push(unsubscribe);
      }
    }
    const handleResize = () => {
      timelineMapController.invalidateSizeStaggered();
    };
    windowRef.addEventListener('resize', handleResize);
    cleanupFns.push(() => windowRef.removeEventListener?.('resize', handleResize));
  }

  function init() {
    if (initialized) return;
    initialized = true;
    bindWindowEvents();
    if (statusStore) {
      const stopWatch = watch(
        () => statusStore.websocket,
        (state, previousState) => {
          if (state === 'ready' && previousState !== 'ready') {
            scheduleTimelineListRequest(500);
          }
        },
        { immediate: true },
      );
      cleanupFns.push(stopWatch);
    }
    if (tabsStore) {
      const stopWatch = watch(
        () => tabsStore.activeTabId,
        (tabId) => {
          if (tabId === 'timeline') {
            handleTimelineActivated();
          }
        },
      );
      cleanupFns.push(stopWatch);
    }
    const stopMapFilterWatch = watch(
      () => timelineStore.mapFilters,
      () => {
        handleMapFiltersChanged();
      },
      { deep: true },
    );
    cleanupFns.push(stopMapFilterWatch);
    const stopTimelineViewerWatch = watch(
      () => timelineStore.timelineMobileViewerOpen,
      (isOpen) => {
        if (isOpen) scheduleTimelineViewerMapRender();
      },
    );
    cleanupFns.push(stopTimelineViewerWatch);
    const stopTimelineLoadingWatch = watch(
      () => timelineStore.timelineLoading,
      (isLoading) => {
        if (isLoading) timelinePage.clearForLoading?.();
      },
    );
    cleanupFns.push(stopTimelineLoadingWatch);
  }

  function cleanup() {
    clearTimelineListRetry();
    while (cleanupFns.length > 0) {
      cleanupFns.pop()?.();
    }
    for (const timerId of pendingRequestTimers) {
      windowRef.clearTimeout?.(timerId);
    }
    pendingRequestTimers.clear();
    pendingTimelineListRequestCount = 0;
    initialized = false;
  }

  return {
    cleanup,
    init,
    requestTimelineList,
  };
}
