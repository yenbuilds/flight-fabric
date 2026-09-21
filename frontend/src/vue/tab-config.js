export const DEFAULT_TAB_ID = 'flight';

export const TAB_ORDER = Object.freeze([
  'livemap',
  'flight',
  'autopilot',
  'dispatch',
  'timeline',
  'settings',
  'system',
]);

// Reachable from the footer, the mobile More sheet or in-app actions rather
// than the primary navigation.
const CONTEXTUAL_TAB_IDS = Object.freeze([
  'cues',
  'landing',
  'lvars',
]);

// Unfinished surfaces stay out of the main tab bars until they are ready.
export const EXPERIMENTAL_TABS = Object.freeze([
  { id: 'cues', label: 'Flight cues', icon: 'cues' },
]);

export const VALID_TAB_IDS = new Set([
  ...TAB_ORDER,
  ...CONTEXTUAL_TAB_IDS,
]);

// Stable route order also owns the existing 1..7 keyboard shortcuts.
const DESKTOP_TABS = Object.freeze([
  { id: 'livemap', label: 'Live', icon: 'livemap' },
  { id: 'flight', label: 'Overview', icon: 'flight' },
  { id: 'autopilot', label: 'Aircraft', icon: 'autopilot' },
  { id: 'dispatch', label: 'Simbrief', icon: 'dispatch' },
  { id: 'timeline', label: 'Logbook', icon: 'timeline' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'system', label: 'System', icon: 'system' },
]);

const MOBILE_PRIMARY_TABS = Object.freeze([
  { id: 'livemap', label: 'Live', icon: 'livemap' },
  { id: 'autopilot', label: 'Aircraft', icon: 'autopilot' },
  { id: 'dispatch', label: 'Simbrief', icon: 'dispatch' },
  { id: 'timeline', label: 'Logbook', icon: 'timeline' },
]);

// Navigation no longer depends on saved workspace choices. Keep every route
// reachable and group Map/Overview only at the presentation boundary.
export function resolveTabs() {
  return {
    desktopPrimary: DESKTOP_TABS,
    desktopSecondary: [],
    mobilePrimary: MOBILE_PRIMARY_TABS,
    mobileMore: DESKTOP_TABS.filter(tab => !MOBILE_PRIMARY_TABS.some(primary => primary.id === tab.id)),
  };
}

// Map and Overview retain their route IDs and number shortcuts, but share one
// primary navigation destination. The inner Flight switch selects the view.
export function navigationTabId(tabId) {
  return tabId === 'flight' ? 'livemap' : tabId;
}

export function resolveNavigation() {
  const resolved = resolveTabs();
  const group = (primary, secondary) => {
    const seen = new Set();
    const collect = list => list.flatMap(tab => {
      const id = navigationTabId(tab.id);
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ ...tab, id, ...(id === 'livemap' ? { label: 'Flight', icon: 'livemap' } : {}) }];
    });
    return [collect(primary), collect(secondary)];
  };
  const [desktopPrimary, desktopSecondary] = group(resolved.desktopPrimary, resolved.desktopSecondary);
  const [mobilePrimary, mobileMore] = group(resolved.mobilePrimary, resolved.mobileMore);
  return { desktopPrimary, desktopSecondary, mobilePrimary, mobileMore };
}

export function normalizeTabId(tabId, fallback = DEFAULT_TAB_ID) {
  const normalized = String(tabId || '').trim();
  const mapped = normalized === 'systems' || normalized === 'launcher'
    ? 'system'
    : normalized === 'zen'
      ? 'cues'
      : normalized === 'profiles'
      ? 'settings'
      : normalized;
  return VALID_TAB_IDS.has(mapped) ? mapped : fallback;
}
