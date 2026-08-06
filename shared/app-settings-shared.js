(function initFlightFabricAppSettings(rootFactory) {
  const root = typeof globalThis !== 'undefined' ? globalThis : this;
  const api = rootFactory();

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }

  root.FlightFabricAppSettings = api;
})(function createFlightFabricAppSettings() {
  // Production telemetry acquisition is intentionally fixed at 10 Hz. Keep
  // this outside user settings so stale files and save payloads cannot alter it.
  const FIXED_TELEMETRY_POLL_RATE_MS = 100;

  const APP_SETTINGS_DEFAULTS = Object.freeze({
    aircraftProfile: 'auto',
    simconnectProtocol: 'KittyHawk',
    wsPort: 8099,
    httpPort: 8100,
    remoteAccess: false,
    remoteAircraftControl: false,
    updateChecks: true,
    onlineMapTiles: true,
    recordingAutoStart: true,
    cabinAnnouncementsEnabled: false,
    cabinAnnouncementsStartupGraceMs: 5000,
    stabilityCriteria: Object.freeze({
      gateRaFt: 1000,
      speedMinusKts: 5,
      speedPlusKts: 5,
      vsMinFpm: -1000,
      vsMaxClimbFpm: 200,
      glidepathAngleDeg: 3,
      glidepathVsDeltaMaxFpm: 200,
      speedTrendMaxKtsPerSec: 2.5,
      thrustIdleMinPct: 15,
      thrustStableMaxPctPerSec: 10,
      pitchMinDeg: -5,
      pitchMaxDeg: 15,
      bankMaxDeg: 25,
      passPct: 80,
    }),
  });

  function sanitizeOptionalString(value, maxLength = 255) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.slice(0, maxLength);
  }

  function sanitizeNonEmptyString(value, fallback) {
    return sanitizeOptionalString(value, 4096) || fallback;
  }

  function sanitizeSimulatorProtocol(value, fallback = 'KittyHawk') {
    const normalized = sanitizeOptionalString(value, 64).toUpperCase();
    if (normalized === 'XPLANE_WEB') return 'XPLANE_WEB';
    if (normalized === 'KITTYHAWK') return 'KittyHawk';
    return sanitizeOptionalString(fallback, 64).toUpperCase() === 'XPLANE_WEB'
      ? 'XPLANE_WEB'
      : 'KittyHawk';
  }

  function sanitizeBool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function sanitizeClampedInt(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.round(num)));
  }

  function sanitizeNonNegativeInt(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.round(num));
  }

  function sanitizeCabinAnnouncementStyle(value) {
    const sanitized = sanitizeOptionalString(value, 128).replace(/[^a-zA-Z0-9_-]/g, '');
    return sanitized || 'standard';
  }

  function sanitizeClampedNumber(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
  }

  function sanitizeStabilityCriteria(value, defaults) {
    const input = value && typeof value === 'object' ? value : {};
    const base = defaults && typeof defaults === 'object'
      ? defaults
      : APP_SETTINGS_DEFAULTS.stabilityCriteria;

    return {
      gateRaFt: sanitizeClampedNumber(input.gateRaFt, base.gateRaFt, 100, 2500),
      speedMinusKts: sanitizeClampedNumber(input.speedMinusKts, base.speedMinusKts, 0, 50),
      speedPlusKts: sanitizeClampedNumber(input.speedPlusKts, base.speedPlusKts, 0, 50),
      vsMinFpm: sanitizeClampedNumber(input.vsMinFpm, base.vsMinFpm, -3000, -100),
      vsMaxClimbFpm: sanitizeClampedNumber(input.vsMaxClimbFpm, base.vsMaxClimbFpm, 0, 2000),
      glidepathAngleDeg: sanitizeClampedNumber(input.glidepathAngleDeg, base.glidepathAngleDeg, 1, 8),
      glidepathVsDeltaMaxFpm: sanitizeClampedNumber(input.glidepathVsDeltaMaxFpm, base.glidepathVsDeltaMaxFpm, 0, 1000),
      speedTrendMaxKtsPerSec: sanitizeClampedNumber(input.speedTrendMaxKtsPerSec, base.speedTrendMaxKtsPerSec, 0, 20),
      thrustIdleMinPct: sanitizeClampedNumber(input.thrustIdleMinPct, base.thrustIdleMinPct, 0, 100),
      thrustStableMaxPctPerSec: sanitizeClampedNumber(input.thrustStableMaxPctPerSec, base.thrustStableMaxPctPerSec, 0, 100),
      pitchMinDeg: sanitizeClampedNumber(input.pitchMinDeg, base.pitchMinDeg, -30, 10),
      pitchMaxDeg: sanitizeClampedNumber(input.pitchMaxDeg, base.pitchMaxDeg, 0, 30),
      bankMaxDeg: sanitizeClampedNumber(input.bankMaxDeg, base.bankMaxDeg, 0, 45),
      passPct: sanitizeClampedNumber(input.passPct, base.passPct, 1, 100),
    };
  }

  function normalizeAppSettings(settings, options = {}) {
    const root = settings && typeof settings === 'object' ? settings : {};
    const defaults = options.defaults && typeof options.defaults === 'object'
      ? { ...APP_SETTINGS_DEFAULTS, ...options.defaults }
      : APP_SETTINGS_DEFAULTS;

    const aircraft = root.aircraft && typeof root.aircraft === 'object' ? root.aircraft : {};
    const simulator = root.simulator && typeof root.simulator === 'object' ? root.simulator : {};
    const network = root.network && typeof root.network === 'object' ? root.network : {};
    const recording = root.recording && typeof root.recording === 'object' ? root.recording : {};
    const cabinAnnouncements = root.cabinAnnouncements && typeof root.cabinAnnouncements === 'object'
      ? root.cabinAnnouncements
      : {};
    const debrief = root.debrief && typeof root.debrief === 'object' ? root.debrief : {};
    const remoteAccess = sanitizeBool(network.remoteAccess, defaults.remoteAccess);

    return {
      aircraft: {
        profile: sanitizeNonEmptyString(aircraft.profile, defaults.aircraftProfile),
      },
      simulator: {
        protocol: sanitizeSimulatorProtocol(simulator.protocol, defaults.simconnectProtocol),
      },
      network: {
        wsPort: sanitizeClampedInt(network.wsPort, defaults.wsPort, 1024, 65535),
        httpPort: sanitizeClampedInt(network.httpPort, defaults.httpPort, 1024, 65535),
        remoteAccess,
        remoteAircraftControl: remoteAccess
          && sanitizeBool(network.remoteAircraftControl, defaults.remoteAircraftControl),
        updateChecks: sanitizeBool(network.updateChecks, defaults.updateChecks),
        onlineMapTiles: sanitizeBool(network.onlineMapTiles, defaults.onlineMapTiles),
      },
      recording: {
        autoStart: sanitizeBool(recording.autoStart, defaults.recordingAutoStart),
      },
      cabinAnnouncements: {
        enabled: sanitizeBool(cabinAnnouncements.enabled, defaults.cabinAnnouncementsEnabled),
        style: sanitizeCabinAnnouncementStyle(cabinAnnouncements.style),
        startupGraceMs: sanitizeNonNegativeInt(
          cabinAnnouncements.startupGraceMs,
          defaults.cabinAnnouncementsStartupGraceMs
        ),
      },
      debrief: {
        stabilityCriteria: sanitizeStabilityCriteria(
          debrief.stabilityCriteria,
          defaults.stabilityCriteria
        ),
      },
    };
  }

  function sanitizeAppSettingsPatch(input, options = {}) {
    const settings = input && typeof input === 'object' ? input : {};
    const normalized = normalizeAppSettings(settings, options);
    const next = {};

    if (settings.aircraft && typeof settings.aircraft === 'object') next.aircraft = normalized.aircraft;
    if (settings.simulator && typeof settings.simulator === 'object') next.simulator = normalized.simulator;
    if (settings.network && typeof settings.network === 'object') next.network = normalized.network;
    if (settings.recording && typeof settings.recording === 'object') next.recording = normalized.recording;
    if (settings.cabinAnnouncements && typeof settings.cabinAnnouncements === 'object') {
      next.cabinAnnouncements = normalized.cabinAnnouncements;
    }
    if (settings.debrief && typeof settings.debrief === 'object') next.debrief = normalized.debrief;

    return next;
  }

  return Object.freeze({
    APP_SETTINGS_DEFAULTS,
    FIXED_TELEMETRY_POLL_RATE_MS,
    normalizeAppSettings,
    sanitizeAppSettingsPatch,
    sanitizeBool,
    sanitizeCabinAnnouncementStyle,
    sanitizeClampedInt,
    sanitizeClampedNumber,
    sanitizeNonEmptyString,
    sanitizeNonNegativeInt,
    sanitizeOptionalString,
    sanitizeSimulatorProtocol,
    sanitizeStabilityCriteria,
  });
});
