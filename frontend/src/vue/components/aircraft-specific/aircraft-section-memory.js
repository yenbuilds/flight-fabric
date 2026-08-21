import {
  nextTick,
  onBeforeUnmount,
  unref,
  watch,
} from 'vue';
import { useTabsStore } from '../../stores/tabs.js';

const STORAGE_PREFIX = 'flight-fabric:aircraft-section:v1:';
const MAX_MEMORY_KEY_LENGTH = 200;

function resolveValue(value) {
  return typeof value === 'function' ? value() : unref(value);
}

function validSectionIds(sections) {
  return new Set((Array.isArray(sections) ? sections : [])
    .map((section) => (typeof section?.id === 'string' ? section.id.trim() : ''))
    .filter(Boolean));
}

export function aircraftSectionStorageKey(memoryKey) {
  const normalized = String(memoryKey || '').trim().toLowerCase();
  if (!normalized || normalized.length > MAX_MEMORY_KEY_LENGTH) return '';
  return `${STORAGE_PREFIX}${encodeURIComponent(normalized)}`;
}

export function readRememberedAircraftSection({ storage, memoryKey, sections } = {}) {
  const storageKey = aircraftSectionStorageKey(memoryKey);
  if (!storageKey || !storage || typeof storage.getItem !== 'function') return null;

  try {
    const sectionId = storage.getItem(storageKey);
    return validSectionIds(sections).has(sectionId) ? sectionId : null;
  } catch {
    return null;
  }
}

export function writeRememberedAircraftSection({ storage, memoryKey, sections, sectionId } = {}) {
  const storageKey = aircraftSectionStorageKey(memoryKey);
  const normalizedSectionId = typeof sectionId === 'string' ? sectionId.trim() : '';
  if (
    !storageKey
    || !storage
    || typeof storage.setItem !== 'function'
    || !validSectionIds(sections).has(normalizedSectionId)
  ) return false;

  try {
    storage.setItem(storageKey, normalizedSectionId);
    return true;
  } catch {
    return false;
  }
}

function sessionStorageOrNull() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

export function useAircraftSectionMemory({ memoryKey, sections, onRestore } = {}) {
  const tabs = useTabsStore();
  let restoredStorageKey = '';
  let resetIfMissing = false;
  let restoreTimer = null;
  let disposed = false;

  const currentMemoryKey = () => String(resolveValue(memoryKey) || '').trim();
  const currentSections = () => {
    const value = resolveValue(sections);
    return Array.isArray(value) ? value : [];
  };
  const aircraftTabIsActive = () => tabs.activeTabId === 'autopilot';

  function clearRestoreTimer() {
    if (restoreTimer == null || typeof window === 'undefined') return;
    window.clearTimeout(restoreTimer);
    restoreTimer = null;
  }

  function rememberSection(sectionId) {
    if (!aircraftTabIsActive()) return false;
    return writeRememberedAircraftSection({
      storage: sessionStorageOrNull(),
      memoryKey: currentMemoryKey(),
      sections: currentSections(),
      sectionId,
    });
  }

  function restoreSection(storageKey, shouldReset) {
    if (
      disposed
      || !aircraftTabIsActive()
      || aircraftSectionStorageKey(currentMemoryKey()) !== storageKey
    ) return false;

    const availableSections = currentSections();
    const rememberedSectionId = readRememberedAircraftSection({
      storage: sessionStorageOrNull(),
      memoryKey: currentMemoryKey(),
      sections: availableSections,
    });
    const fallbackSectionId = shouldReset ? availableSections[0]?.id : null;
    const sectionId = rememberedSectionId || fallbackSectionId;
    if (!sectionId || typeof onRestore !== 'function') return false;

    try {
      return onRestore(sectionId) !== false;
    } catch {
      return false;
    }
  }

  function scheduleRestore() {
    if (disposed || !aircraftTabIsActive()) return;
    const storageKey = aircraftSectionStorageKey(currentMemoryKey());
    if (!storageKey || restoredStorageKey === storageKey) return;

    restoredStorageKey = storageKey;
    const shouldReset = resetIfMissing;
    resetIfMissing = false;
    clearRestoreTimer();
    nextTick(() => {
      if (
        disposed
        || !aircraftTabIsActive()
        || aircraftSectionStorageKey(currentMemoryKey()) !== storageKey
        || typeof window === 'undefined'
      ) return;
      restoreTimer = window.setTimeout(() => {
        restoreTimer = null;
        restoreSection(storageKey, shouldReset);
      }, 0);
    });
  }

  const stopTabWatch = watch(
    () => tabs.activeTabId,
    (tabId) => {
      if (tabId === 'autopilot') {
        scheduleRestore();
      } else {
        restoredStorageKey = '';
      }
    },
    { immediate: true },
  );
  const stopMemoryKeyWatch = watch(
    currentMemoryKey,
    (nextKey, previousKey) => {
      if (nextKey === previousKey) return;
      clearRestoreTimer();
      restoredStorageKey = '';
      resetIfMissing = Boolean(previousKey);
      scheduleRestore();
    },
  );

  onBeforeUnmount(() => {
    disposed = true;
    clearRestoreTimer();
    stopTabWatch();
    stopMemoryKeyWatch();
  });

  return {
    aircraftTabIsActive,
    rememberSection,
  };
}
