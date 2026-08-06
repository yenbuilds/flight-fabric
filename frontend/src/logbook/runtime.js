// ES module - strict mode is implicit in modules.
import { watch } from 'vue';

const LOGBOOK_ENTRY_LIMIT = 500;

export function initLogbookRuntime({
  logbookStore = null,
  timelineStore = null,
  tabsStore = null,
  statusStore = null,
  getAuthorizationScope = null,
  sendMessage = null,
  subscribeLandingReceivedSignal = null,
  subscribeWsMessageSignal = null,
  subscribeWsOpenSignal = null,
  windowRef = window,
} = {}) {
  if (!logbookStore) {
    throw new Error('Logbook store is required before logbook runtime');
  }

  const cleanupFns = [];
  let landingRefreshTimer = null;
  let indexStatusTimer = null;
  let indexPollCount = 0;

  function hasFullControl() {
    return typeof getAuthorizationScope !== 'function'
      || getAuthorizationScope() === 'full-control';
  }

  logbookStore.bindRequestAction(() => (
    hasFullControl() && typeof sendMessage === 'function'
      ? sendMessage({ type: 'requestLogbook', limit: LOGBOOK_ENTRY_LIMIT })
      : false
  ));

  function requestLogbook() {
    logbookStore.request();
  }

  function requestHistoryIndexStatus() {
    if (!hasFullControl() || typeof sendMessage !== 'function') return false;
    return sendMessage({ type: 'requestHistoryIndexStatus' });
  }

  if (typeof subscribeWsOpenSignal === 'function') {
    cleanupFns.push(subscribeWsOpenSignal(() => {
      requestLogbook();
      requestHistoryIndexStatus();
    }));
  }

  if (typeof subscribeWsMessageSignal === 'function') {
    cleanupFns.push(subscribeWsMessageSignal((message) => {
      if (message?.type !== 'authorizationScope' || message.scope !== 'full-control') return;
      requestLogbook();
      requestHistoryIndexStatus();
    }));
  }

  cleanupFns.push(watch(
    () => Number(logbookStore.historyIndexStatus?.generation) || 0,
    (generation, previousGeneration) => {
      if (generation <= previousGeneration) return;
      requestLogbook();
      timelineStore?.refreshTimelinePage?.();
    },
  ));

  indexStatusTimer = windowRef.setInterval?.(() => {
    if (!logbookStore.historyIndexBusy) return;
    requestHistoryIndexStatus();
    indexPollCount += 1;
    // Refresh the bounded SQLite pages while a long first-time migration is
    // running so recent flights appear progressively instead of only at 100%.
    if (indexPollCount % 2 === 0) {
      requestLogbook();
      timelineStore?.refreshTimelinePage?.();
    }
  }, 1000) ?? null;

  if (typeof subscribeLandingReceivedSignal === 'function') {
    cleanupFns.push(subscribeLandingReceivedSignal(() => {
      if (landingRefreshTimer != null) {
        windowRef.clearTimeout?.(landingRefreshTimer);
      }
      landingRefreshTimer = windowRef.setTimeout(() => {
        landingRefreshTimer = null;
        requestLogbook();
      }, 500);
    }));
  }

  if (tabsStore) {
    const stopTabsWatch = watch(
      () => tabsStore.activeTabId,
      (tabId) => {
        if (tabId === 'timeline') {
          requestLogbook();
        }
      },
    );
    cleanupFns.push(stopTabsWatch);
  }

  if (statusStore?.websocket === 'ready') {
    requestLogbook();
    requestHistoryIndexStatus();
  }

  return function cleanupLogbookRuntime() {
    for (const cleanup of cleanupFns.splice(0).reverse()) {
      try {
        cleanup?.();
      } catch {}
    }
    if (landingRefreshTimer != null) {
      windowRef.clearTimeout?.(landingRefreshTimer);
      landingRefreshTimer = null;
    }
    if (indexStatusTimer != null) {
      windowRef.clearInterval?.(indexStatusTimer);
      indexStatusTimer = null;
    }
    logbookStore.bindRequestAction(null);
  };
}
