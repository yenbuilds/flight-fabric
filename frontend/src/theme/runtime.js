import { THEMES, normalizeThemeName } from './definition.js';

export function createThemeRuntime({
  documentRef = document,
} = {}) {
  function applyThemeAttributes(name) {
    const normalized = normalizeThemeName(name);
    const config = THEMES[normalized];
    const root = documentRef?.documentElement;
    const body = documentRef?.body || null;
    const meta = documentRef?.querySelector?.('meta[name="theme-color"]') || null;

    if (root) {
      root.dataset.theme = normalized;
      root.dataset.themeMode = config.mode;
      root.classList.toggle('dark', config.mode === 'dark');
    }

    if (body) {
      body.dataset.theme = normalized;
      body.dataset.themeMode = config.mode;
    }

    if (meta) {
      meta.setAttribute('content', config.metaColor);
    }

    return normalized;
  }

  return {
    applyThemeAttributes,
  };
}
