import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  DEFAULT_TAB_ID,
  EXPERIMENTAL_TABS,
  normalizeTabId,
  resolveTabs,
  resolveNavigation,
  navigationTabId,
} from '../tab-config.js';

const EXPERIMENTAL_TAB_IDS = new Set(EXPERIMENTAL_TABS.map((tab) => tab.id));

export const useTabsStore = defineStore('tabs', () => {
  const activeTabId = ref(DEFAULT_TAB_ID);
  const lastFlightTabId = ref(DEFAULT_TAB_ID);
  const moreSheetOpen = ref(false);
  const lastTransitionDirection = ref(null);
  const transitionTabId = ref(null);
  const transitionDirection = ref(null);
  const pullRefreshVisible = ref(false);
  const pullRefreshRefreshing = ref(false);
  const pullRefreshLabel = ref('Pull to reconnect');
  const beforeChangeGuards = new Set();

  const routeTabs = resolveTabs();
  const desktopPrimaryTabs = computed(() => routeTabs.desktopPrimary);
  const desktopSecondaryTabs = computed(() => routeTabs.desktopSecondary);
  const mobilePrimaryTabs = computed(() => routeTabs.mobilePrimary);
  const mobileMoreTabs = computed(() => routeTabs.mobileMore);
  const navigation = resolveNavigation();
  const desktopNavigationPrimaryTabs = computed(() => navigation.desktopPrimary);
  const desktopNavigationSecondaryTabs = computed(() => navigation.desktopSecondary);
  const mobileNavigationPrimaryTabs = computed(() => navigation.mobilePrimary);
  const mobileNavigationMoreTabs = computed(() => navigation.mobileMore);
  const activeNavigationTabId = computed(() => navigationTabId(activeTabId.value));
  const isMoreTabActive = computed(() => (
    EXPERIMENTAL_TAB_IDS.has(activeTabId.value)
    || mobileNavigationMoreTabs.value.some((tab) => tab.id === activeNavigationTabId.value)
  ));
  const pullRefreshClass = computed(() => ({
    visible: pullRefreshVisible.value,
    refreshing: pullRefreshRefreshing.value,
  }));

  function setActiveTab(tabId) {
    activeTabId.value = normalizeTabId(tabId);
    if (navigationTabId(activeTabId.value) === 'livemap') lastFlightTabId.value = activeTabId.value;
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

  function requestNavigationTabChange(tabId, options = {}) {
    return requestTabChange(tabId === 'livemap' ? lastFlightTabId.value : tabId, options);
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
    activeNavigationTabId,
    desktopNavigationPrimaryTabs,
    desktopNavigationSecondaryTabs,
    mobileNavigationPrimaryTabs,
    mobileNavigationMoreTabs,
    requestNavigationTabChange,
    beginSectionTransition,
    desktopPrimaryTabs,
    desktopSecondaryTabs,
    mobileMoreTabs,
    mobilePrimaryTabs,
    clearPullRefresh,
    clearSectionTransition,
    closeMoreSheet,
    isMoreTabActive,
    registerBeforeChangeGuard,
    moreSheetOpen,
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
