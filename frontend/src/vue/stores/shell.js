import { computed, onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';
import { readStorageValue, writeStorageValue } from '../../app/browser-environment.js';

const SIDEBAR_STORAGE_KEY = 'ff_sidebar_collapsed_v1';

// Per-device presentation only. This store does not grant capabilities or own
// flight state; switching tasks still goes through the tabs store's guards.
export const useShellStore = defineStore('shell', () => {
  const sidebarPreference = ref(readStorageValue(SIDEBAR_STORAGE_KEY, { fallback: '' }));
  const compactQuery = typeof window !== 'undefined' ? window.matchMedia?.('(max-width: 1280px)') : null;
  const compactWindow = ref(compactQuery?.matches === true);
  const updateCompactWindow = event => { compactWindow.value = event.matches; };
  compactQuery?.addEventListener?.('change', updateCompactWindow);
  onScopeDispose(() => compactQuery?.removeEventListener?.('change', updateCompactWindow));
  // Adapt until the user chooses. Resizing never overwrites a saved preference.
  const sidebarCollapsed = computed({
    get: () => sidebarPreference.value === 'yes' || (sidebarPreference.value !== 'no' && compactWindow.value),
    set: value => {
      sidebarPreference.value = value ? 'yes' : 'no';
      writeStorageValue(SIDEBAR_STORAGE_KEY, sidebarPreference.value);
    },
  });
  const navigatorOpen = ref(false);
  const navigatorMode = ref('navigate');
  // Navigator visibility and search text are intentionally transient.

  function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }
  function openNavigator(mode = 'navigate') {
    navigatorMode.value = mode === 'help' ? 'help' : 'navigate';
    navigatorOpen.value = true;
  }
  function closeNavigator() { navigatorOpen.value = false; }

  return { sidebarCollapsed, navigatorOpen, navigatorMode, toggleSidebar, openNavigator, closeNavigator };
});
