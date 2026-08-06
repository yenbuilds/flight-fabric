export const TAB_ORDER = Object.freeze([
  'livemap',
  'flight',
  'autopilot',
  'dispatch',
  'timeline',
  'settings',
  'system',
]);

export const CONTEXTUAL_TAB_IDS = Object.freeze([
  'landing',
  'lvars',
]);

export const VALID_TAB_IDS = new Set([
  ...TAB_ORDER,
  ...CONTEXTUAL_TAB_IDS,
]);

export const DESKTOP_TABS = Object.freeze([
  { id: 'livemap', label: 'Live', icon: 'livemap' },
  { id: 'flight', label: 'Overview', icon: 'flight' },
  { id: 'autopilot', label: 'Aircraft', icon: 'autopilot' },
  { id: 'dispatch', label: 'Simbrief', icon: 'dispatch' },
  { id: 'timeline', label: 'Logbook', icon: 'timeline' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'system', label: 'System', icon: 'system' },
]);

export const MOBILE_PRIMARY_TABS = Object.freeze([
  { id: 'livemap', label: 'Live', icon: 'livemap' },
  { id: 'autopilot', label: 'Aircraft', icon: 'autopilot' },
  { id: 'dispatch', label: 'Simbrief', icon: 'dispatch' },
  { id: 'timeline', label: 'Logbook', icon: 'timeline' },
]);

export const MOBILE_MORE_TABS = Object.freeze([
  { id: 'flight', label: 'Overview', icon: 'flight' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'system', label: 'System', icon: 'system' },
]);

export const MOBILE_MORE_TAB_IDS = new Set(MOBILE_MORE_TABS.map((tab) => tab.id));

export function normalizeTabId(tabId) {
  const normalized = String(tabId || '').trim();
  const mapped = normalized === 'systems' || normalized === 'launcher'
    ? 'system'
    : normalized === 'profiles'
      ? 'settings'
      : normalized;
  return VALID_TAB_IDS.has(mapped) ? mapped : 'livemap';
}
