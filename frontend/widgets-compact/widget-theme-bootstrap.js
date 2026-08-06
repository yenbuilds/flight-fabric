// ES module - strict mode is implicit in modules.
var DEFAULT_THEME = 'dark';

var THEMES = {
  'dark': {
    mode: 'dark',
    metaColor: '#09111a'
  }
};

var LEGACY_THEME_ALIASES = {
  'default': 'dark',
  'web3-dark': 'dark',
  'web3-light': 'dark',
  'light': 'dark'
};

function normalizeThemeName(name) {
  var normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (normalized && Object.prototype.hasOwnProperty.call(THEMES, normalized)) {
    return normalized;
  }
  if (normalized && Object.prototype.hasOwnProperty.call(LEGACY_THEME_ALIASES, normalized)) {
    return LEGACY_THEME_ALIASES[normalized];
  }
  return DEFAULT_THEME;
}

function applyTheme(name) {
  var normalized = normalizeThemeName(name);
  var config = THEMES[normalized];
  var root = document.documentElement;
  var body = document.body || null;
  var meta = document.querySelector('meta[name="theme-color"]');

  root.dataset.theme = normalized;
  root.dataset.themeMode = config.mode;
  root.classList.toggle('dark', config.mode === 'dark');

  if (body) {
    body.dataset.theme = normalized;
    body.dataset.themeMode = config.mode;
  }

  if (meta) {
    meta.setAttribute('content', config.metaColor);
  }
}

applyTheme(DEFAULT_THEME);
