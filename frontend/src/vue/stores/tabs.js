import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { DEFAULT_TAB_ID, MOBILE_MORE_TAB_IDS, normalizeTabId } from '../tab-config.js';

export const useTabsStore = defineStore('tabs', () => {
  const activeTabId = ref(DEFAULT_TAB_ID);
  const moreSheetOpen = ref(false);
  const lastTransitionDirection = ref(null);
  const transitionTabId = ref(null);
  const transitionDirection = ref(null);
  const pullRefreshVisible = ref(false);
  const pullRefreshRefreshing = ref(false);
  const pullRefreshLabel = ref('Pull to reconnect');
  const beforeChangeGuards = new Set();

  const isMoreTabActive = computed(() => MOBILE_MORE_TAB_IDS.has(activeTabId.value));
  const pullRefreshClass = computed(() => ({
    visible: pullRefreshVisible.value,
    refreshing: pullRefreshRefreshing.value,
  }));

  function setActiveTab(tabId) {
    activeTabId.value = normalizeTabId(tabId);
    moreSheetOpen.value = false;
  }

  function requestTabChange(tabId, options = {}) {
    const normalizedTabId = normalizeTabId(tabId);
    const direction = typeof options.direction === 'string' ? options.direction : null;

    for (const guard of beforeChangeGuards) {
      if (guard(activeTabId.value, normalizedTabId) === false) {
        return false;
      }
    }

    lastTransitionDirection.value = direction;
    setActiveTab(normalizedTabId);
    return true;
  }

  function takeLastTransitionDirection() {
    const direction = lastTransitionDirection.value;
    lastTransitionDirection.value = null;
    return direction;
  }

  function beginSectionTransition(tabId, direction = null) {
    transitionTabId.value = normalizeTabId(tabId);
    transitionDirection.value = direction === 'left' || direction === 'right' ? direction : null;
  }

  function clearSectionTransition(tabId) {
    if (tabId && transitionTabId.value !== normalizeTabId(tabId)) return;
    transitionDirection.value = null;
  }

  function tabSectionClass(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    const isTransitionTarget = transitionTabId.value === normalizedTabId;

    return {
      active: activeTabId.value === normalizedTabId,
      'swipe-enter-left': isTransitionTarget && transitionDirection.value === 'left',
      'swipe-enter-right': isTransitionTarget && transitionDirection.value === 'right',
    };
  }

  function registerBeforeChangeGuard(guard) {
    if (typeof guard !== 'function') return () => {};
    beforeChangeGuards.add(guard);
    return () => {
      beforeChangeGuards.delete(guard);
    };
  }

  function openMoreSheet() {
    moreSheetOpen.value = true;
  }

  function closeMoreSheet() {
    moreSheetOpen.value = false;
  }

  function toggleMoreSheet() {
    moreSheetOpen.value = !moreSheetOpen.value;
  }

  function showPullRefreshPrompt(readyToRefresh = false) {
    pullRefreshVisible.value = true;
    pullRefreshRefreshing.value = false;
    pullRefreshLabel.value = readyToRefresh ? 'Release to reconnect' : 'Pull to reconnect';
  }

  function startPullRefresh() {
    pullRefreshVisible.value = true;
    pullRefreshRefreshing.value = true;
    pullRefreshLabel.value = 'Reconnecting...';
  }

  function clearPullRefresh() {
    pullRefreshVisible.value = false;
    pullRefreshRefreshing.value = false;
    pullRefreshLabel.value = 'Pull to reconnect';
  }

  return {
    activeTabId,
    beginSectionTransition,
    clearPullRefresh,
    clearSectionTransition,
    closeMoreSheet,
    isMoreTabActive,
    registerBeforeChangeGuard,
    moreSheetOpen,
    openMoreSheet,
    pullRefreshClass,
    pullRefreshLabel,
    pullRefreshRefreshing,
    pullRefreshVisible,
    requestTabChange,
    setActiveTab,
    showPullRefreshPrompt,
    startPullRefresh,
    tabSectionClass,
    takeLastTransitionDirection,
    toggleMoreSheet,
    transitionDirection,
    transitionTabId,
  };
});
