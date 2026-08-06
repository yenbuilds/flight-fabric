import { writeStorageValue } from '../app/browser-environment.js';

export const THEME_STORAGE_KEY = 'ff-theme-v2';
export const DEFAULT_THEME = 'dark';

const LEGACY_THEME_ALIASES = Object.freeze({
  default: 'dark',
  'web3-dark': 'dark',
  'web3-light': 'dark',
  light: 'dark',
});

export const THEMES = Object.freeze({
  dark: {
    id: 'dark',
    label: 'Night Shift',
    mode: 'dark',
    metaColor: '#09111a',
  },
});

export function normalizeThemeName(name) {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';

  if (Object.prototype.hasOwnProperty.call(THEMES, normalized)) {
    return normalized;
  }

  if (Object.prototype.hasOwnProperty.call(LEGACY_THEME_ALIASES, normalized)) {
    return LEGACY_THEME_ALIASES[normalized];
  }

  return DEFAULT_THEME;
}

export function readSavedTheme() {
  return DEFAULT_THEME;
}

export function persistThemeName(name, {
  storage = null,
} = {}) {
  const normalized = normalizeThemeName(name);
  writeStorageValue(THEME_STORAGE_KEY, normalized, { storage });
  return normalized;
}
