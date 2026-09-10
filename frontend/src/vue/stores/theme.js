import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  DEFAULT_THEME,
  normalizeThemeName,
  persistThemeName,
} from '../../theme/definition.js';

export const useThemeStore = defineStore('theme', () => {
  const currentTheme = ref(DEFAULT_THEME);
  const runtimeBound = ref(false);
  let applyThemeAttributesAction = null;

  function persistTheme(name) {
    persistThemeName(name);
  }

  function bindRuntime({
    applyThemeAttributes = null,
  } = {}) {
    applyThemeAttributesAction = typeof applyThemeAttributes === 'function'
      ? applyThemeAttributes
      : null;
    runtimeBound.value = applyThemeAttributesAction != null;
  }

  function applyTheme(name, shouldPersist = true) {
    const normalized = normalizeThemeName(name);
    currentTheme.value = normalized;
    applyThemeAttributesAction?.(normalized);
    if (shouldPersist) {
      persistTheme(normalized);
    }
    return normalized;
  }

  function initialize() {
    applyTheme(DEFAULT_THEME, false);
  }

  return {
    applyTheme,
    bindRuntime,
    currentTheme,
    initialize,
    runtimeBound,
  };
});
