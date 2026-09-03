import { emitAppSettings } from './runtime-signals.js';
export { RELEASE_LABEL, RELEASE_WARNING, formatReleaseVersion, BETA_LABEL, BETA_WARNING, formatBetaVersion } from './version-labels.js';
import { formatReleaseVersion } from './version-labels.js';

export function createAppSettingsController({
  $,
  getCabinAnnouncements = () => null,
} = {}) {
  let currentAppSettings = null;
  let currentAppStorage = null;

  function apply(settings, meta = {}) {
    currentAppSettings = settings && typeof settings === 'object' ? settings : {};
    if (meta.storage && typeof meta.storage === 'object') {
      currentAppStorage = meta.storage;
    }

    let backendVersion = null;
    if (meta.backendVersion) {
      backendVersion = formatReleaseVersion(meta.backendVersion);
      const verEl = typeof $ === 'function' ? $('app-version') : null;
      if (verEl) verEl.textContent = backendVersion;
    }

    const cabinAnnouncements = getCabinAnnouncements();
    if (
      cabinAnnouncements &&
      typeof cabinAnnouncements.applySettings === 'function'
    ) {
      cabinAnnouncements.applySettings(currentAppSettings.cabinAnnouncements);
    }

    emitAppSettings({
      backendVersion,
      settings: currentAppSettings,
      settingsFile: meta.settingsFile || null,
      storage: currentAppStorage,
    });
  }

  return {
    apply,
    getSettings: () => currentAppSettings,
    getStorage: () => currentAppStorage,
  };
}
