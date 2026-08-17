// ES module - strict mode is implicit in modules.
import { nextTick, watch } from 'vue';
import { readStorageValue, writeStorageValue } from '../app/browser-environment.js';
import {
  DEFAULT_TAB_ID,
  TAB_ORDER,
  VALID_TAB_IDS,
  normalizeTabId,
} from '../vue/tab-config.js';

export const LAST_ACTIVE_TAB_STORAGE_KEY = 'ff_last_active_tab_v1';

export function resolveInitialTabId({
  requestedTabId = '',
  persistedTabId = '',
} = {}) {
  const normalizedRequestedTabId = normalizeTabId(requestedTabId, '');
  if (VALID_TAB_IDS.has(normalizedRequestedTabId)) return normalizedRequestedTabId;

  const normalizedPersistedTabId = normalizeTabId(persistedTabId, '');
  if (VALID_TAB_IDS.has(normalizedPersistedTabId)) return normalizedPersistedTabId;

  return DEFAULT_TAB_ID;
}

const MICRO_REVEAL_SELECTOR = [
  '.card-hover',
  '.desktop-tab',
  '.mobile-tab',
  '.mobile-more-item',
  '.timeline-filter-control',
  '.timeline-storage-btn',
  '.timeline-card-actions > button',
  '.timeline-detail-action',
  '.ap-mode-btn',
  '.ap-nav-btn',
  '.ap-engage-btn',
  '.ap-adj-btn',
  '.light-indicator',
  '.brake-indicator',
  '#phase-badge',
  '#phase-badge-mobile',
  '#menu-state-top',
  '.logbook-mobile-card',
].join(',');

const TOUCH_NAVIGATION_EXCLUSION_SELECTOR = [
  '.leaflet-container',
  '[data-no-swipe]',
  'a',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="slider"]',
].join(',');

export function initTabsRuntime({
  tabsStore = null,
  reconnect = null,
  canPullToReconnect = () => true,
  windowRef = window,
  documentRef = document,
  storage = null,
} = {}) {
  if (!tabsStore) {
    throw new Error('Tabs store is required before tabs runtime');
  }
  const resolvedTabsStore = tabsStore;
  const params = new URLSearchParams(windowRef.location.search);
  const motionDisabled = windowRef.matchMedia && windowRef.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cleanupFns = [];
  const tabScrollPositions = new Map();

  function addListener(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
    cleanupFns.push(() => target.removeEventListener?.(type, handler, options));
  }

  function collectMotionTargets(root) {
    if (!root || motionDisabled) return [];
    return Array.from(root.querySelectorAll(MICRO_REVEAL_SELECTOR)).filter((element) => element.getClientRects().length > 0);
  }

  function queueMotionTargets(root, reset) {
    const targets = collectMotionTargets(root);
    targets.forEach((element, index) => {
      element.classList.add('ff-motion-target');
      element.style.setProperty('--ff-motion-index', String(index));
      if (reset) {
        element.classList.remove('ff-motion-in', 'ff-motion-queued');
      }
      element.classList.add('ff-motion-queued');
    });
    return targets;
  }

  function playMotionTargets(root, reset) {
    if (motionDisabled) return;
    const targets = queueMotionTargets(root, reset);
    if (!targets.length) return;
    const scheduleFrame = windowRef.requestAnimationFrame || globalThis.requestAnimationFrame;
    const reveal = () => {
      targets.forEach((element) => {
        element.classList.add('ff-motion-in');
      });
    };
    if (typeof scheduleFrame === 'function') {
      scheduleFrame.call(windowRef, reveal);
      return;
    }
    reveal();
  }

  function animateSection(tabId, reset) {
    const section = documentRef.getElementById(`tab-${tabId}`);
    if (!section || motionDisabled) return;
    section.classList.add('ff-tab-animating');
    playMotionTargets(section, reset);
    windowRef.setTimeout(() => {
      section.classList.remove('ff-tab-animating');
    }, 520);
  }

  function applyActiveTabState(tabId, direction) {
    const normalizedTabId = normalizeTabId(tabId);
    resolvedTabsStore.beginSectionTransition(normalizedTabId, direction);

    nextTick(() => {
      animateSection(normalizedTabId, true);

      if (direction) {
        windowRef.setTimeout(() => {
          resolvedTabsStore.clearSectionTransition(normalizedTabId);
        }, 260);
      }
    });
  }

  function requestTabChange(tabId, direction = null) {
    resolvedTabsStore.requestTabChange(tabId, { direction });
  }

  function bindKeyboardShortcuts() {
    const tabKeys = {
      '1': 'livemap',
      '2': 'flight',
      '3': 'dispatch',
      '4': 'timeline',
      '5': 'settings',
      '6': 'system',
      '7': 'landing',
    };

    addListener(documentRef, 'keydown', (event) => {
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      const tabId = tabKeys[event.key];
      if (!tabId) return;
      event.preventDefault();
      requestTabChange(tabId);
    });
  }

  function bindTouchNavigation() {
    const mainEl = documentRef.querySelector('main');
    if (!mainEl) return;

    function touchNavigationExcluded(target) {
      return Boolean(target?.closest?.(TOUCH_NAVIGATION_EXCLUSION_SELECTOR));
    }

    let touchStartX = 0;
    let touchStartY = 0;
    let swiping = false;

    addListener(mainEl, 'touchstart', (event) => {
      if (event.touches.length !== 1) {
        swiping = false;
        return;
      }
      if (touchNavigationExcluded(event.target)) {
        swiping = false;
        return;
      }
      touchStartX = event.touches[0].clientX;
      touchStartY = event.touches[0].clientY;
      swiping = true;
    }, { passive: true });

    addListener(mainEl, 'touchend', (event) => {
      if (!swiping) return;
      swiping = false;
      const dx = event.changedTouches[0].clientX - touchStartX;
      const dy = event.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
      const currentIndex = TAB_ORDER.indexOf(resolvedTabsStore.activeTabId);
      if (currentIndex === -1) return;
      if (dx < 0 && currentIndex < TAB_ORDER.length - 1) {
        requestTabChange(TAB_ORDER[currentIndex + 1], 'right');
      } else if (dx > 0 && currentIndex > 0) {
        requestTabChange(TAB_ORDER[currentIndex - 1], 'left');
      }
    }, { passive: true });

    let ptrStartY = 0;
    let ptrActive = false;
    let ptrClearTimer = null;

    function pullReconnectAvailable() {
      if (typeof canPullToReconnect !== 'function') return true;
      try {
        return canPullToReconnect() === true;
      } catch {
        return false;
      }
    }

    function clearPullReconnectTimer() {
      if (ptrClearTimer == null) return;
      windowRef.clearTimeout?.(ptrClearTimer);
      ptrClearTimer = null;
    }

    function cancelPullReconnect() {
      ptrActive = false;
      clearPullReconnectTimer();
      resolvedTabsStore.clearPullRefresh();
    }

    cleanupFns.push(cancelPullReconnect);

    addListener(mainEl, 'touchstart', (event) => {
      if (touchNavigationExcluded(event.target)) {
        cancelPullReconnect();
        return;
      }
      if (!pullReconnectAvailable()) {
        cancelPullReconnect();
        return;
      }
      if (mainEl.scrollTop <= 0 && event.touches.length === 1) {
        cancelPullReconnect();
        ptrStartY = event.touches[0].clientY;
        ptrActive = true;
      } else {
        cancelPullReconnect();
      }
    }, { passive: true });

    addListener(mainEl, 'touchmove', (event) => {
      if (!ptrActive) return;
      if (!pullReconnectAvailable()) {
        cancelPullReconnect();
        return;
      }
      const dy = event.touches[0].clientY - ptrStartY;
      if (dy > 30) {
        resolvedTabsStore.showPullRefreshPrompt(dy > 80);
      } else if (dy <= 0) {
        cancelPullReconnect();
      }
    }, { passive: true });

    addListener(mainEl, 'touchend', (event) => {
      if (!ptrActive) {
        resolvedTabsStore.clearPullRefresh();
        return;
      }
      ptrActive = false;
      if (!pullReconnectAvailable()) {
        cancelPullReconnect();
        return;
      }
      const dy = event.changedTouches[0].clientY - ptrStartY;
      if (dy > 80) {
        resolvedTabsStore.startPullRefresh();
        if (typeof reconnect === 'function') {
          reconnect();
        }
        clearPullReconnectTimer();
        ptrClearTimer = windowRef.setTimeout(() => {
          ptrClearTimer = null;
          resolvedTabsStore.clearPullRefresh();
        }, 1200);
      } else {
        resolvedTabsStore.clearPullRefresh();
      }
    }, { passive: true });

    addListener(mainEl, 'touchcancel', () => {
      swiping = false;
      cancelPullReconnect();
    }, { passive: true });
  }

  const initialTabId = resolveInitialTabId({
    requestedTabId: params.get('tab') || '',
    persistedTabId: readStorageValue(LAST_ACTIVE_TAB_STORAGE_KEY, { storage, fallback: '' }),
  });

  resolvedTabsStore.setActiveTab(initialTabId);

  const stopActiveTabWatch = watch(
    () => resolvedTabsStore.activeTabId,
    (tabId, previousTabId) => {
      const mainEl = documentRef.querySelector('main');
      if (mainEl && previousTabId) {
        tabScrollPositions.set(previousTabId, mainEl.scrollTop || 0);
      }
      if (VALID_TAB_IDS.has(tabId)) {
        writeStorageValue(LAST_ACTIVE_TAB_STORAGE_KEY, tabId, { storage });
      }
      applyActiveTabState(tabId, resolvedTabsStore.takeLastTransitionDirection());
      nextTick(() => {
        if (mainEl) {
          mainEl.scrollTop = tabScrollPositions.get(tabId) || 0;
        }
      });
    },
    { immediate: true },
  );
  cleanupFns.push(stopActiveTabWatch);

  bindKeyboardShortcuts();
  bindTouchNavigation();

  if (!motionDisabled) {
    documentRef.documentElement.classList.add('ff-motion-enabled');
    playMotionTargets(documentRef.querySelector('header'), true);
    playMotionTargets(documentRef.querySelector('.desktop-tab-bar'), true);
    playMotionTargets(documentRef.querySelector('.mobile-tab-bar'), true);
  }

  return () => {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      try {
        cleanup();
      } catch {}
    }
  };
}
