// client-message-handler.js
// Handles WebSocket client messages for simbridge-core.
//
// "Client message" means a JSON command/request sent FROM a connected UI client
// TO the backend over WebSocket (opposite of telemetry stream messages).
//
// Examples:
//   { type: 'requestState' }
//   { type: 'endFlightManual' }
//   { type: 'requestTimeline', flightId: '...' }
//
// Non-examples:
//   Telemetry push messages like { type: 'ias', value: ... } which are emitted
//   by the backend and consumed by clients.

const { MSG } = require('./message-types');
const path = require('path');
const timeSource = require('./time-source');
const { APP_DATA_DIR, loadUserSettings, updateUserSettings, SETTINGS_FILE } = require('./user-settings');
const { DESTINATION_TARGET_FILE, ORIGIN_TARGET_FILE } = require('./destination-target-store');
const { LOGBOOK_FILE } = require('../landing/flight-logbook');
const { createFlightCsvStore } = require('../flight-recording/flight-csv-store');
const {
  getCabinAnnouncementAudioDir,
  getThemesDir,
} = require('../utils/storage-paths');
const { getFlightLogsStorageInfo } = require('../utils/flight-logs-dir');
const { PHASES } = require('../lifecycle/phases');
const { getDisplayAppVersion } = require('./app-version');
const {
  APP_SETTINGS_DEFAULTS,
  normalizeAppSettings,
  sanitizeAppSettingsPatch: sanitizeSharedAppSettingsPatch,
} = require('../../shared/app-settings-shared.js');
const BACKEND_VERSION = getDisplayAppVersion();
const { getLastUpdateMsg } = require('./update-checker');
const aircraftControlService = require('../aircraft/aircraft-control-service');
const { isClientMessageAuthorized } = require('./client-message-authorization');

type AnyRecord = Record<string, any>;
type WsLike = {
  send: (_payload: string) => void;
  __ffPrivilegedClient?: boolean;
  __ffAircraftControlClient?: boolean;
};
type DebugLike = { log: (_scope: string, _event: string, _payload?: AnyRecord) => void };

// Last known fuel unit preference - replayed to newly-connected clients on requestState.
let lastFuelUnitPref = null;
const VALID_FUEL_UNITS = new Set(['gal', 'lbs', 'kg']);

// Last known branding visibility preference - replayed to newly-connected clients on requestState.
// Default is shown (null = not yet set by any client, overlays show branding by default).
let lastShowBrandingPref = null;

// Last known active SimBrief OFP - replayed to newly-connected clients on requestState.
// Allows strip overlays to recover the active flight plan after reconnect.
let lastFlightPlan = null;

/**
 * Sanitize an incoming flightPlan relay payload from a UI client.
 * Returns a clean object or null if the payload is too malformed to relay.
 */
function sanitizeFlightPlan(payload) {
  if (!payload || typeof payload !== 'object') return null;

  function safeStr(v, maxLen = 100) {
    if (typeof v !== 'string') return null;
    const t = v.trim().slice(0, maxLen);
    return t || null;
  }
  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function safeIcao(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return t.length >= 3 ? t : null;
  }

  // A cleared message only needs cleared:true - no flight data required.
  if (payload.cleared === true) {
    return { type: MSG.FLIGHT_PLAN, cleared: true, username: '' };
  }

  const username = safeStr(payload.username, 40);
  if (!username) return null; // Username is the minimum required field

  const origin      = safeIcao(payload.origin);
  const destination = safeIcao(payload.destination);
  const alternate   = safeIcao(payload.alternate);

  return {
    type: MSG.FLIGHT_PLAN,
    username,
    fetchedAt: safeNum(payload.fetchedAt) ?? timeSource.now(),
    origin,
    originName:      safeStr(payload.originName, 80),
    destination,
    destinationName: safeStr(payload.destinationName, 80),
    alternate,
    aircraft:   safeStr(payload.aircraft, 20),
    aircraftName: safeStr(payload.aircraftName, 80),
    callsign:   safeStr(payload.callsign, 20),
    flightNumber: safeStr(payload.flightNumber, 20),
    route:      safeStr(payload.route, 2000),
    cruiseAltFl: safeStr(payload.cruiseAltFl, 10),
    cruiseMach:  safeStr(payload.cruiseMach, 10),
    eteSeconds:  safeNum(payload.eteSeconds),
    fuelLbs:     safeNum(payload.fuelLbs),
    costIndex:   safeNum(payload.costIndex),
  };
}
const profileLoader = require('../aircraft/aircraft-profile-loader');
const CABIN_ANNOUNCEMENTS_DIR = getCabinAnnouncementAudioDir();
const SETTINGS_FILE_LABEL = 'Stored locally in your Flight Fabric settings directory';

function buildStorageSummary(options: { includeLocalPaths?: boolean } = {}) {
  const flightLogs = getFlightLogsStorageInfo();
  const includeLocalPaths = options.includeLocalPaths === true;

  if (includeLocalPaths) {
    return {
      appDataDir: APP_DATA_DIR,
      settingsFile: SETTINGS_FILE,
      bundledAircraftProfilesDir: profileLoader.BUILTIN_BUNDLED_DIR,
      cabinAnnouncementAudioDir: CABIN_ANNOUNCEMENTS_DIR,
      themesDir: getThemesDir(),
      logbookFile: LOGBOOK_FILE,
      destinationTargetFile: DESTINATION_TARGET_FILE,
      originTargetFile: ORIGIN_TARGET_FILE,
      flightLogsDir: flightLogs.dir,
      flightLogsExists: flightLogs.exists === true,
      flightLogsFileCount: Number(flightLogs.fileCount) || 0,
      flightLogsTotalBytes: Number(flightLogs.totalBytes) || 0,
    };
  }

  return {
    appDataDir: 'Stored locally in your Flight Fabric app-data directory',
    settingsFile: SETTINGS_FILE_LABEL,
    bundledAircraftProfilesDir: 'Release-owned and read-only',
    cabinAnnouncementAudioDir: 'Stored locally for cabin-audio overrides',
    themesDir: 'Stored locally for theme overrides',
    logbookFile: 'Stored locally with your flight-log data',
    destinationTargetFile: 'Stored locally in the destination target cache',
    originTargetFile: 'Stored locally in the origin target cache',
    flightLogsDir: 'Stored locally in your flight-logs directory',
    flightLogsExists: flightLogs.exists === true,
    flightLogsFileCount: Number(flightLogs.fileCount) || 0,
    flightLogsTotalBytes: Number(flightLogs.totalBytes) || 0,
  };
}

function buildClientSafeAppSettings(settings, effectiveCabinAnnouncements = null) {
  const normalized = normalizeAppSettings(settings, {
    defaults: APP_SETTINGS_DEFAULTS,
  });
  if (effectiveCabinAnnouncements && typeof effectiveCabinAnnouncements === 'object') {
    normalized.cabinAnnouncements = normalizeAppSettings(
      { cabinAnnouncements: effectiveCabinAnnouncements },
      { defaults: APP_SETTINGS_DEFAULTS },
    ).cabinAnnouncements;
  }
  return normalized;
}

function buildAppSettingsMessage(
  settings,
  options: {
    effectiveCabinAnnouncements?: AnyRecord | null;
    includeLocalPaths?: boolean;
  } = {},
) {
  const normalizedSettings = buildClientSafeAppSettings(
    settings,
    options.effectiveCabinAnnouncements,
  );
  const includeLocalPaths = options.includeLocalPaths === true;
  return {
    type: MSG.APP_SETTINGS,
    settings: normalizedSettings,
    settingsFile: includeLocalPaths ? SETTINGS_FILE : SETTINGS_FILE_LABEL,
    storage: buildStorageSummary({ includeLocalPaths }),
    backendVersion: BACKEND_VERSION,
  };
}

function sanitizeAppSettingsPatch(input) {
  return sanitizeSharedAppSettingsPatch(input, {
    defaults: APP_SETTINGS_DEFAULTS,
  });
}

function sanitizeTimelineRequestId(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const requestId = value.trim().slice(0, 128);
  return requestId || null;
}

function resolveTimelineScoringMode(value: unknown): 'recorded' | 'current-preview' {
  return value === 'current-preview' ? 'current-preview' : 'recorded';
}

function sanitizeAnalysisRevision(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function sanitizeAnalysisFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const fingerprint = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
}

let lastAppSettings;

function refreshAppSettingsMessage(
  options: {
    effectiveCabinAnnouncements?: AnyRecord | null;
    includeLocalPaths?: boolean;
  } = {},
) {
  const settings = loadUserSettings();
  const messageOptions = {
    effectiveCabinAnnouncements: options.effectiveCabinAnnouncements,
  };
  lastAppSettings = buildAppSettingsMessage(settings, messageOptions);
  return options.includeLocalPaths === true
    ? buildAppSettingsMessage(settings, { ...messageOptions, includeLocalPaths: true })
    : lastAppSettings;
}

function readEffectiveCabinAnnouncements(getCabinAnnouncementsConfig) {
  if (typeof getCabinAnnouncementsConfig !== 'function') return null;
  try {
    const config = getCabinAnnouncementsConfig();
    return config && typeof config === 'object' ? config : null;
  } catch {
    return null;
  }
}

function sendRequestStateSnapshot(ws: WsLike, {
  lastSimState,
  getPhase,
  getCabinAnnouncementsConfig,
  flightCsvWriter,
  replayMessages,
  Debug,
}: AnyRecord) {
  Debug.log('ws', 'State requested by client');

  if (lastSimState) {
    ws.send(JSON.stringify(lastSimState));
  }

  if (Array.isArray(replayMessages)) {
    for (const message of replayMessages) {
      if (!message || typeof message !== 'object') continue;
      if (message.type === MSG.SIM_STATE) continue;
      if (message.type === MSG.PHASE) continue;
      if (message.type === MSG.FLIGHT_RECORDING) continue;
      try {
        ws.send(JSON.stringify(message));
      } catch {}
    }
  }

  const currentPhase = getPhase();
  if (currentPhase && currentPhase !== PHASES.UNKNOWN) {
    ws.send(JSON.stringify({ type: MSG.PHASE, value: currentPhase }));
  }

  if (flightCsvWriter.isRecording()) {
    const csvStats = flightCsvWriter.getStats();
    ws.send(JSON.stringify({
      type: MSG.FLIGHT_RECORDING,
      status: 'recording',
      fileName: typeof csvStats?.filePath === 'string' ? path.basename(csvStats.filePath) : '',
      flightId: csvStats?.flightId,
    }));
  } else {
    ws.send(JSON.stringify({
      type: MSG.FLIGHT_RECORDING,
      status: 'stopped',
    }));
  }

  if (lastFuelUnitPref) {
    ws.send(JSON.stringify(lastFuelUnitPref));
  }
  if (lastShowBrandingPref) {
    ws.send(JSON.stringify(lastShowBrandingPref));
  }
  if (lastFlightPlan) {
    ws.send(JSON.stringify(lastFlightPlan));
  }

  const pendingUpdate = getLastUpdateMsg();
  if (pendingUpdate) {
    ws.send(JSON.stringify(pendingUpdate));
  }

  ws.send(JSON.stringify(refreshAppSettingsMessage({
    effectiveCabinAnnouncements: readEffectiveCabinAnnouncements(getCabinAnnouncementsConfig),
    includeLocalPaths: ws.__ffPrivilegedClient === true,
  })));
}

function sendPrivilegeDenied(ws: WsLike, msg: AnyRecord) {
  const error = 'Privileged session required for this action.';

  switch (msg.type) {
    case 'saveAppSettings':
      ws.send(JSON.stringify({
        type: MSG.APP_SETTINGS_SAVED,
        ok: false,
        error,
        settingsFile: SETTINGS_FILE_LABEL,
      }));
      return;
    case 'executeAircraftControl':
      ws.send(JSON.stringify({
        type: MSG.AIRCRAFT_CONTROL_RESULT,
        requestId: msg.requestId || null,
        ok: false,
        code: 'auth_required',
        error: 'Aircraft controls require a privileged session or trusted-LAN aircraft control permission.',
      }));
      return;
    case 'startRecording':
      ws.send(JSON.stringify({
        type: MSG.START_FLIGHT_RESULT,
        success: false,
        error,
      }));
      return;
    case 'endFlightManual':
      ws.send(JSON.stringify({
        type: MSG.END_FLIGHT_RESULT,
        success: false,
        error,
      }));
      return;
    case 'requestTimeline':
      ws.send(JSON.stringify({
        type: MSG.TIMELINE_ERROR,
        requestId: sanitizeTimelineRequestId(msg.requestId),
        scoringMode: resolveTimelineScoringMode(msg.scoringMode),
        error,
      }));
      return;
    case 'requestTimelineList':
      ws.send(JSON.stringify({
        type: MSG.TIMELINE_LIST_ERROR,
        requestId: msg.requestId || null,
        error,
      }));
      return;
    case 'deleteFlightCsv':
      ws.send(JSON.stringify({
        type: MSG.DELETE_FLIGHT_CSV_RESULT,
        requestId: msg.requestId || null,
        success: false,
        error,
      }));
      return;
    case 'applyFlightAnalysisRescore':
    case 'revertFlightAnalysisRescore':
      ws.send(JSON.stringify({
        type: MSG.FLIGHT_ANALYSIS_RESCORE_RESULT,
        requestId: sanitizeTimelineRequestId(msg.requestId),
        action: msg.type === 'revertFlightAnalysisRescore' ? 'revert' : 'apply',
        success: false,
        error,
      }));
      return;
    case 'requestHistoryIndexStatus':
    case 'checkHistoryIndex':
    case 'rebuildHistoryIndex':
      ws.send(JSON.stringify({
        type: MSG.HISTORY_INDEX_STATUS,
        success: false,
        error,
      }));
      return;
    case 'setDestinationTarget':
    case 'clearDestinationTarget':
      ws.send(JSON.stringify({
        type: MSG.DESTINATION_TARGET_ERROR,
        error,
      }));
      return;
    case 'setOriginTarget':
    case 'clearOriginTarget':
      ws.send(JSON.stringify({
        type: MSG.ORIGIN_TARGET_ERROR,
        error,
      }));
      return;
    case 'importProfile':
    case 'exportProfile':
    case 'listProfiles':
    case 'copyProfileToLocal':
    case 'deleteUserProfile':
      ws.send(JSON.stringify({
        type: MSG.PROFILE_ERROR,
        errors: [error],
      }));
      return;
    default:
      break;
  }
}

function getManualRecordingStateBlocker(lastSimState: unknown): string {
  if (!lastSimState || typeof lastSimState !== 'object') return '';
  const state = lastSimState as AnyRecord;
  if (state.type !== MSG.SIM_STATE && state.type !== 'simState') return '';
  if (state.simconnectConnected === false) return 'Simulator telemetry is not connected';
  if (state.inMenu === true) return 'Simulator is still in menus';
  return '';
}

function handleAirportLookup(ws: WsLike, msg: AnyRecord, Debug: DebugLike) {
  const requestedIcao = String(msg.icao || '').trim().toUpperCase();
  const requestId = msg.requestId || null;

  const sendLookupResult = (payload: AnyRecord) => {
    ws.send(JSON.stringify({
      type: MSG.AIRPORT_LOOKUP_RESULT,
      requestId,
      icao: requestedIcao,
      ...payload,
    }));
  };

  if (!/^[A-Z0-9]{3,4}$/.test(requestedIcao)) {
    sendLookupResult({
      success: false,
      error: 'Enter a valid ICAO code (3-4 letters/numbers)',
    });
    return;
  }

  try {
    const { getAirport, getDatabaseStats } = require('../landing/airport-geometry-service');
    const airport: AnyRecord | null = getAirport(requestedIcao);

    if (!airport) {
      const stats = getDatabaseStats();
      if (!stats || stats.airportCount === 0) {
        sendLookupResult({
          success: false,
          error: 'Airport database unavailable',
        });
        return;
      }

      sendLookupResult({
        success: false,
        error: `Airport not found: ${requestedIcao}`,
      });
      return;
    }

    const thresholds = Object.values(airport.runways || {})
      .map((runway: any) => runway?.threshold)
      .filter((threshold) => (
        threshold &&
        Number.isFinite(Number(threshold.lat)) &&
        Number.isFinite(Number(threshold.lon))
      )) as Array<{ lat: number | string; lon: number | string }>;

    if (thresholds.length === 0) {
      sendLookupResult({
        success: false,
        error: `No runway coordinates available for ${requestedIcao}`,
      });
      return;
    }

    const sums = thresholds.reduce<{ lat: number; lon: number }>((acc, threshold) => ({
      lat: acc.lat + Number(threshold.lat),
      lon: acc.lon + Number(threshold.lon),
    }), { lat: 0, lon: 0 });

    sendLookupResult({
      success: true,
      name: airport.name || requestedIcao,
      lat: sums.lat / thresholds.length,
      lon: sums.lon / thresholds.length,
      runwayCount: Object.keys(airport.runways || {}).length,
    });
  } catch (err) {
    Debug.log('ws', 'requestAirportLookup error', { error: err.message });
    sendLookupResult({
      success: false,
      error: 'Airport lookup failed',
    });
  }
}

function sendRouteTargetSnapshot(ws: WsLike, getTarget: unknown, {
  targetType,
  requestLog,
  errorLog,
  Debug,
}: AnyRecord) {
  try {
    const target = typeof getTarget === 'function'
      ? getTarget()
      : null;
    Debug.log('ws', requestLog, {
      hasTarget: !!target,
      icao: target?.icao || null,
    });
    ws.send(JSON.stringify({
      type: targetType,
      target: target || null,
    }));
  } catch (err) {
    Debug.log('ws', errorLog, { error: err.message });
    if (targetType === MSG.DESTINATION_TARGET) {
      ws.send(JSON.stringify({
        type: MSG.DESTINATION_TARGET,
        target: null,
        error: 'Internal error',
      }));
      return;
    }
    if (targetType === MSG.ORIGIN_TARGET) {
      ws.send(JSON.stringify({
        type: MSG.ORIGIN_TARGET,
        target: null,
        error: 'Internal error',
      }));
      return;
    }
    ws.send(JSON.stringify({ type: targetType, target: null, error: 'Internal error' }));
  }
}

function setRouteTarget(ws: WsLike, msg: AnyRecord, setTarget: unknown, broadcast: (_payload: AnyRecord) => void, {
  targetType,
  errorType,
  targetName,
  unavailableError,
  setLog,
  errorLog,
  Debug,
}: AnyRecord) {
  try {
    if (typeof setTarget !== 'function') {
      throw new Error(unavailableError);
    }

    const target = setTarget(msg.target);
    if (!target) {
      ws.send(JSON.stringify({
        type: errorType,
        error: `Invalid ${targetName} target payload`,
      }));
      return;
    }

    Debug.log('ws', setLog, {
      icao: target.icao,
      name: target.name,
      lat: target.lat,
      lon: target.lon,
      hasInitialDistance: Number.isFinite(target.initialDistanceNm),
    });

    broadcast({
      type: targetType,
      target,
    });
  } catch (err) {
    Debug.log('ws', errorLog, { error: err.message });
    ws.send(JSON.stringify({
      type: errorType,
      error: 'Internal error',
    }));
  }
}

function clearRouteTarget(ws: WsLike, clearTarget: unknown, broadcast: (_payload: AnyRecord) => void, {
  targetType,
  errorType,
  clearLog,
  errorLog,
  Debug,
}: AnyRecord) {
  try {
    if (typeof clearTarget === 'function') {
      clearTarget();
    }

    Debug.log('ws', clearLog);

    broadcast({
      type: targetType,
      target: null,
    });
  } catch (err) {
    Debug.log('ws', errorLog, { error: err.message });
    ws.send(JSON.stringify({
      type: errorType,
      error: 'Internal error',
    }));
  }
}

/**
 * Handle one incoming WebSocket client message.
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} msg - Parsed client->server command object (must include msg.type)
 * @param {Object} context - Backend capabilities required to service client commands
 *                           (state accessors, lifecycle controls, broadcaster, logger)
 */
async function handleClientMessage(ws, msg, context) {
  const {
    lastSimState,
    getPhase,
    flightCsvWriter,
    flightCsvStore : runtimeFlightCsvStore,
    recordingBundleGuard,
    flightActive,
    flightId,
    flightStartIso,
    flightStartAircraftTitle,
    recordingSession,
    startFlightManual,
    endFlight,
    getDestinationTarget,
    setDestinationTarget,
    clearDestinationTarget,
    getOriginTarget,
    setOriginTarget,
    clearOriginTarget,
    replayMessages,
    provider,
    broadcast,
    getCabinAnnouncementsConfig,
    reconfigureCabinAnnouncements,
    timeNow = Date.now,
    Debug
  } = context;

  if (!msg || !msg.type) return;
  if (!isClientMessageAuthorized(ws, msg.type)) {
    try {
      Debug?.log?.('ws', 'Denied client message', {
        type: typeof msg.type === 'string' ? msg.type.slice(0, 128) : null,
      });
    } catch {}
    sendPrivilegeDenied(ws, msg);
    return;
  }

  const flightCsvStore = runtimeFlightCsvStore
    || createFlightCsvStore({ flightCsvWriter, recordingBundleGuard, Debug });

  switch (msg.type) {
    // Request current state (for page refresh/reconnect)
    case 'requestState': {
      sendRequestStateSnapshot(ws, {
        lastSimState,
        getPhase,
        flightCsvWriter,
        replayMessages,
        getCabinAnnouncementsConfig,
        Debug,
      });
      break;
    }

    case 'requestAppSettings': {
      ws.send(JSON.stringify(refreshAppSettingsMessage({
        effectiveCabinAnnouncements: readEffectiveCabinAnnouncements(getCabinAnnouncementsConfig),
        includeLocalPaths: ws.__ffPrivilegedClient === true,
      })));
      break;
    }

    case 'saveAppSettings': {
      try {
        const patch = sanitizeAppSettingsPatch(msg.settings);
        const savedSettings = updateUserSettings(patch);

        const restartReasons = [];
        if (patch.simulator) restartReasons.push('Simulator protocol');
        if (patch.aircraft) restartReasons.push('Aircraft profile override');
        if (patch.network) restartReasons.push('Network ports / remote access');
        if (patch.recording) restartReasons.push('Automatic recording');
        if (patch.cabinAnnouncements) {
          if (typeof reconfigureCabinAnnouncements === 'function') {
            try {
              await reconfigureCabinAnnouncements(savedSettings);
            } catch (error) {
              const err = error as Error;
              restartReasons.push('Cabin announcements');
              try {
                Debug?.log?.('cabin-announcements', 'Live settings reconfiguration failed', {
                  error: err?.message || String(error),
                });
              } catch {}
            }
          } else {
            restartReasons.push('Cabin announcements');
          }
        }

        const effectiveCabinAnnouncements = readEffectiveCabinAnnouncements(
          getCabinAnnouncementsConfig,
        );
        lastAppSettings = buildAppSettingsMessage(savedSettings, {
          effectiveCabinAnnouncements,
        });
        const clientAppSettings = buildAppSettingsMessage(savedSettings, {
          effectiveCabinAnnouncements,
          includeLocalPaths: ws.__ffPrivilegedClient === true,
        });

        broadcast(lastAppSettings);
        ws.send(JSON.stringify({
          type: MSG.APP_SETTINGS_SAVED,
          ok: true,
          settings: clientAppSettings.settings,
          settingsFile: clientAppSettings.settingsFile,
          storage: clientAppSettings.storage,
          restartRequired: restartReasons.length > 0,
          restartReasons,
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: MSG.APP_SETTINGS_SAVED,
          ok: false,
          error: err.message || 'Failed to save settings',
          settingsFile: SETTINGS_FILE_LABEL,
        }));
      }
      break;
    }

    // ========================================
    // Fuel Unit Preference Relay
    // ========================================

    case MSG.FUEL_UNIT: {
      const unit = msg.unit;
      if (!VALID_FUEL_UNITS.has(unit)) break;
      const fuelUnitMsg = { type: MSG.FUEL_UNIT, unit };
      lastFuelUnitPref = fuelUnitMsg;
      broadcast(fuelUnitMsg);
      break;
    }

    // ========================================
    // Branding Visibility Relay
    // ========================================

    case MSG.SHOW_BRANDING: {
      const show = msg.show !== false;
      const brandingMsg = { type: MSG.SHOW_BRANDING, show };
      lastShowBrandingPref = brandingMsg;
      broadcast(brandingMsg);
      break;
    }

    // ========================================
    // Active SimBrief OFP Relay
    // ========================================

    case MSG.FLIGHT_PLAN: {
      // Sanitize and relay the active flight plan to all clients.
      // Stored in memory so strip overlays receive it on reconnect (requestState replay).
      const plan = sanitizeFlightPlan(msg);
      if (!plan) break;
      // A cleared message evicts the stored plan so reconnecting overlays don't
      // receive a stale plan after the user has cleared the dispatch.
      lastFlightPlan = plan.cleared ? null : plan;
      broadcast(plan);
      break;
    }

    case 'executeAircraftControl': {
      const requestId = msg.requestId || null;
      try {
        const activeProfile = profileLoader.getActiveProfile();
        const result = await aircraftControlService.executeAircraftControl(provider, msg, {
          profile: activeProfile,
          profileRevision: typeof profileLoader.getActiveProfileRevision === 'function'
            ? profileLoader.getActiveProfileRevision()
            : null,
          requireProfileToken: true,
          requireStableSimState: true,
          simState: lastSimState,
        });
        ws.send(JSON.stringify({
          type: MSG.AIRCRAFT_CONTROL_RESULT,
          requestId,
          ...result,
        }));
      } catch (err) {
        Debug.log('ws', 'executeAircraftControl error', { error: err.message });
        ws.send(JSON.stringify({
          type: MSG.AIRCRAFT_CONTROL_RESULT,
          requestId,
          ok: false,
          code: 'internal_error',
          error: 'Aircraft control request failed internally.',
        }));
      }
      break;
    }

    // ========================================
    // Recording Session Controls
    // ========================================

    case 'startRecording': {
      Debug.log('ws', 'Manual recording start requested');
      try {
        if (typeof startFlightManual !== 'function') {
          ws.send(JSON.stringify({
            type: MSG.START_FLIGHT_RESULT,
            success: false,
            error: 'Manual recording start is unavailable',
          }));
          break;
        }

        const stateBlocker = getManualRecordingStateBlocker(lastSimState);
        if (stateBlocker) {
          ws.send(JSON.stringify({
            type: MSG.START_FLIGHT_RESULT,
            success: false,
            reason: 'user_manual',
            error: stateBlocker,
          }));
          break;
        }

        const result = await startFlightManual();
        ws.send(JSON.stringify({
          type: MSG.START_FLIGHT_RESULT,
          success: result?.success === true,
          reason: result?.reason || 'user_manual',
          flightId: result?.flightId || undefined,
          fileName: result?.fileName || undefined,
          error: result?.success === true ? undefined : (result?.error || 'Failed to start recording'),
        }));
      } catch (err) {
        Debug.log('ws', 'startRecording error', { error: err.message });
        broadcast({
          type: MSG.FLIGHT_RECORDING,
          status: 'error',
          error: 'Failed to start recording',
        });
        ws.send(JSON.stringify({
          type: MSG.START_FLIGHT_RESULT,
          success: false,
          error: 'Failed to start recording',
        }));
      }
      break;
    }

    case 'stopRecording': {
      Debug.log('ws', 'Stop recording requested (automatic - no-op)');
      // Recording cannot be stopped - CSV always saved
      ws.send(JSON.stringify({
        type: MSG.RECORDING_STOPPED,
        duration: '00:00:00',
        sampleCount: 0,
      }));
      // Broadcast to all clients
      broadcast({
        type: MSG.RECORDING_STATE,
        isRecording: true, // Always recording
        duration: '00:00:00',
        sampleCount: 0,
      });
      break;
    }

    case 'getRecordingState': {
      Debug.log('ws', 'Recording state requested (automatic)');
      // Always recording
      ws.send(JSON.stringify({
        type: MSG.RECORDING_STATE,
        isRecording: true,
        sessionId: 'automatic',
        startedAt: null,
        sampleCount: 0,
        lastError: null,
        duration: '--:--:--',
      }));
      break;
    }

    // Manual flight end (user-initiated via UI)
    case 'endFlightManual': {
      Debug.log('ws', 'Manual flight end requested');
      try {
        if (!flightActive) {
          ws.send(JSON.stringify({
            type: MSG.END_FLIGHT_RESULT,
            success: false,
            error: 'No active flight to end',
          }));
        } else {
          const nowEpochMs = timeNow();
          const hasActiveRecording = flightCsvWriter?.isRecording?.() === true;
          if (hasActiveRecording) {
            const finalizingMessage = {
              type: MSG.FLIGHT_RECORDING,
              status: 'finalizing',
            };
            broadcast(finalizingMessage);
          }
          const finalizeResult = typeof endFlight === 'function'
            ? endFlight(nowEpochMs, 'user_manual')
            : null;
          const csvStats = finalizeResult && typeof finalizeResult.then === 'function'
            ? await finalizeResult
            : finalizeResult;
          const stoppedMessage = {
            type: MSG.FLIGHT_RECORDING,
            status: 'stopped',
          };
          broadcast(stoppedMessage);
          ws.send(JSON.stringify({
            type: MSG.END_FLIGHT_RESULT,
            success: true,
            reason: 'user_manual',
            fileName: typeof csvStats?.filePath === 'string' ? path.basename(csvStats.filePath) : undefined,
            rowCount: Number.isFinite(csvStats?.rowCount) ? csvStats.rowCount : undefined,
          }));
        }
      } catch (err) {
        Debug.log('ws', 'endFlightManual error', { error: err.message });
        broadcast({
          type: MSG.FLIGHT_RECORDING,
          status: 'error',
          error: 'Failed to end flight',
        });
        ws.send(JSON.stringify({
          type: MSG.END_FLIGHT_RESULT,
          success: false,
          error: 'Failed to end flight',
        }));
      }
      break;
    }

    // Get current flight status
    case 'getFlightStatus': {
      Debug.log('ws', 'Flight status requested');
      ws.send(JSON.stringify({
        type: MSG.FLIGHT_STATUS,
        active: flightActive,
        flightId: flightId || null,
        startTime: flightStartIso || null,
        aircraftTitle: flightStartAircraftTitle || null,
        recording: recordingSession.getState().isRecording,
      }));
      break;
    }

    // ========================================
    // Timeline Inspector
    // ========================================

    case 'requestTimeline': {
      const requestId = sanitizeTimelineRequestId(msg.requestId);
      const scoringMode = resolveTimelineScoringMode(msg.scoringMode);
      const timelineOptions = { requestId, scoringMode };
      Debug.log('ws', 'Timeline requested', {
        filePath: msg.filePath,
        flightId: msg.flightId,
        requestId,
        scoringMode,
      });
      try {
        const result = msg.filePath
          ? await flightCsvStore.generateTimelineFromFile(msg.filePath, timelineOptions)
          : (msg.flightId
              ? await flightCsvStore.generateTimelineForFlightId(msg.flightId, timelineOptions)
              : null);

        if (!result) {
          ws.send(JSON.stringify({
            type: MSG.TIMELINE_ERROR,
            requestId,
            scoringMode,
            error: 'Timeline requests must specify a filePath or flightId for historic data only',
          }));
        } else if (result.success) {
          ws.send(JSON.stringify({
            type: MSG.TIMELINE,
            requestId,
            scoringMode,
            timeline: result.timeline,
          }));
        } else {
          ws.send(JSON.stringify({
            type: MSG.TIMELINE_ERROR,
            requestId,
            scoringMode,
            error: result.error || 'Timeline not found',
          }));
        }
      } catch (err) {
        Debug.log('ws', 'requestTimeline error', { error: err.message });
        ws.send(JSON.stringify({
          type: MSG.TIMELINE_ERROR,
          requestId,
          scoringMode,
          error: 'Failed to generate timeline',
        }));
      }
      break;
    }

    case 'applyFlightAnalysisRescore':
    case 'revertFlightAnalysisRescore': {
      const action = msg.type === 'revertFlightAnalysisRescore' ? 'revert' : 'apply';
      const requestId = sanitizeTimelineRequestId(msg.requestId);
      try {
        const result = action === 'apply'
          ? await flightCsvStore.applyFlightAnalysisRescore({
              filePath: msg.filePath,
              flightId: msg.flightId,
              expectedRevision: sanitizeAnalysisRevision(msg.baseRevision),
              expectedSourceFingerprint: sanitizeAnalysisFingerprint(msg.sourceFingerprint),
              expectedPreviewFingerprint: sanitizeAnalysisFingerprint(msg.previewFingerprint),
              expectedAnalysisContractFingerprint: sanitizeAnalysisFingerprint(msg.analysisContractFingerprint),
            })
          : await flightCsvStore.revertFlightAnalysisRescore({
              filePath: msg.filePath,
              flightId: msg.flightId,
              expectedRevision: sanitizeAnalysisRevision(msg.expectedRevision),
              expectedSnapshotFingerprint: sanitizeAnalysisFingerprint(msg.expectedSnapshotFingerprint),
            });
        ws.send(JSON.stringify({
          type: MSG.FLIGHT_ANALYSIS_RESCORE_RESULT,
          requestId,
          action,
          success: result?.success === true,
          ...(Number.isSafeInteger(result?.revision) ? { revision: result.revision } : {}),
          ...(typeof result?.appliedAt === 'string' ? { appliedAt: result.appliedAt } : {}),
          ...(typeof result?.snapshotFingerprint === 'string'
            ? { snapshotFingerprint: result.snapshotFingerprint }
            : {}),
          ...(typeof result?.reverted === 'boolean' ? { reverted: result.reverted } : {}),
          ...(result?.success === true ? {} : { error: result?.error || 'Could not update the saved flight analysis' }),
        }));
      } catch (err) {
        Debug.log('ws', 'flight analysis rescore error', {
          action,
          error: err instanceof Error ? err.message : String(err || 'Unknown error'),
        });
        ws.send(JSON.stringify({
          type: MSG.FLIGHT_ANALYSIS_RESCORE_RESULT,
          requestId,
          action,
          success: false,
          error: 'Could not update the saved flight analysis',
        }));
      }
      break;
    }

    case 'requestTimelineList': {
      Debug.log('ws', 'Timeline list requested');
      try {
        const useHistoryIndex = msg.useHistoryIndex === true;
        const result = useHistoryIndex && typeof flightCsvStore.listFlightsIndexed === 'function'
          ? await flightCsvStore.listFlightsIndexed({
            aircraftFilter: msg.aircraftFilter,
            limit: msg.limit,
            offset: msg.offset,
            routeFilter: msg.routeFilter,
            sort: msg.sort,
          })
          : await flightCsvStore.listFlights();
        if (!result.success) {
          const retryable = result.error === 'Active flight CSV is not ready yet';
          ws.send(JSON.stringify({
            type: MSG.TIMELINE_LIST_ERROR,
            requestId: msg.requestId || null,
            error: result.error || 'Failed to list flights',
            ...(retryable ? { retryable: true, retryAfterMs: 500 } : {}),
          }));
          break;
        }

        ws.send(JSON.stringify({
          type: MSG.TIMELINE_LIST,
          requestId: msg.requestId || null,
          flights: result.flights,
          storage: result.storage,
          ...(result.index ? { index: result.index } : {}),
        }));
      } catch (err) {
        Debug.log('ws', 'Timeline list error', { error: err.message });
        ws.send(JSON.stringify({
          type: MSG.TIMELINE_LIST_ERROR,
          requestId: msg.requestId || null,
          error: 'Failed to list flights',
        }));
      }
      break;
    }

    case 'deleteFlightCsv': {
      // Delete a flight-log CSV through the guarded store, which blocks active
      // recordings and keeps raw disk paths out of the response.
      try {
        const result = flightCsvStore.deleteFlightCsv(msg.filePath, {
          mtimeMs: msg.mtimeMs,
          sizeBytes: msg.sizeBytes,
        });
        const response = {
          type: MSG.DELETE_FLIGHT_CSV_RESULT,
          requestId: msg.requestId || null,
          filePath: msg.filePath || null,
          // Explicitly list only safe fields - do NOT spread result directly,
          // as it includes 'deleted: <absolute path>' (disk path info-disclosure).
          success: result.success,
          error: result.error || null,
          storage: result.success ? (result.storage || null) : null,
        };

        ws.send(JSON.stringify(response));

        // Let any other connected windows remove the row without forcing the
        // backend to synchronously parse every CSV again.
        if (result.success) {
          broadcast({ ...response, requestId: null });
        }
      } catch (err) {
        Debug.log('ws', 'deleteFlightCsv error', { error: err.message });
        ws.send(JSON.stringify({
          type: MSG.DELETE_FLIGHT_CSV_RESULT,
          requestId: msg.requestId || null,
          success: false,
          error: 'Delete failed',
        }));
      }
      break;
    }

    case 'requestAirportLookup': {
      handleAirportLookup(ws, msg, Debug);
      break;
    }

    case 'requestDestinationTarget': {
      sendRouteTargetSnapshot(ws, getDestinationTarget, {
        targetType: MSG.DESTINATION_TARGET,
        requestLog: 'destination_target_requested',
        errorLog: 'requestDestinationTarget error',
        Debug,
      });
      break;
    }

    case 'setDestinationTarget': {
      setRouteTarget(ws, msg, setDestinationTarget, broadcast, {
        targetType: MSG.DESTINATION_TARGET,
        errorType: MSG.DESTINATION_TARGET_ERROR,
        targetName: 'destination',
        unavailableError: 'Destination target storage unavailable',
        setLog: 'destination_target_set',
        errorLog: 'setDestinationTarget error',
        Debug,
      });
      break;
    }

    case 'clearDestinationTarget': {
      clearRouteTarget(ws, clearDestinationTarget, broadcast, {
        targetType: MSG.DESTINATION_TARGET,
        errorType: MSG.DESTINATION_TARGET_ERROR,
        clearLog: 'destination_target_cleared',
        errorLog: 'clearDestinationTarget error',
        Debug,
      });
      break;
    }

    case 'requestOriginTarget': {
      sendRouteTargetSnapshot(ws, getOriginTarget, {
        targetType: MSG.ORIGIN_TARGET,
        requestLog: 'origin_target_requested',
        errorLog: 'requestOriginTarget error',
        Debug,
      });
      break;
    }

    case 'setOriginTarget': {
      setRouteTarget(ws, msg, setOriginTarget, broadcast, {
        targetType: MSG.ORIGIN_TARGET,
        errorType: MSG.ORIGIN_TARGET_ERROR,
        targetName: 'origin',
        unavailableError: 'Origin target storage unavailable',
        setLog: 'origin_target_set',
        errorLog: 'setOriginTarget error',
        Debug,
      });
      break;
    }

    case 'clearOriginTarget': {
      clearRouteTarget(ws, clearOriginTarget, broadcast, {
        targetType: MSG.ORIGIN_TARGET,
        errorType: MSG.ORIGIN_TARGET_ERROR,
        clearLog: 'origin_target_cleared',
        errorLog: 'clearOriginTarget error',
        Debug,
      });
      break;
    }

    // --- Read-only profile inspection ---------------------------------------
    case 'exportProfile': {
      try {
        const result = profileLoader.exportProfile(msg.id);
        if (result.ok) {
          ws.send(JSON.stringify({ type: MSG.PROFILE_EXPORTED, profile: result.profile, filename: result.filename }));
        } else {
          ws.send(JSON.stringify({ type: MSG.PROFILE_ERROR, errors: result.errors }));
        }
      } catch (err) {
        Debug.log('ws', 'exportProfile error', { error: err.message });
        ws.send(JSON.stringify({ type: MSG.PROFILE_ERROR, errors: ['Profile export failed'] }));
      }
      break;
    }

    case 'listProfiles': {
      try {
        const profiles = profileLoader.listProfiles();
        ws.send(JSON.stringify({ type: MSG.PROFILE_LIST, profiles }));
      } catch (err) {
        Debug.log('ws', 'listProfiles error', { error: err.message });
        ws.send(JSON.stringify({ type: MSG.PROFILE_ERROR, errors: ['Failed to list profiles'] }));
      }
      break;
    }

    case 'requestLogbook': {
      try {
        const result = await flightCsvStore.getLogbook({ entryLimit: msg.limit });
        if (!result.success) throw new Error(result.error);
        ws.send(JSON.stringify({
          type: MSG.LOGBOOK,
          entries: result.entries,
          stats: result.stats,
          index: result.index || null,
        }));
      } catch (err) {
        Debug.log('ws', 'requestLogbook error', { error: err.message });
        ws.send(JSON.stringify({
          type: MSG.LOGBOOK,
          entries: [],
          stats: {
            total: 0,
            grades: {},
            outcomeGrades: {},
            longLandingCount: 0,
            avgVsFpm: null,
            bestVsFpm: null,
            airports: 0,
            aircraft: 0,
            trends: { aircraft: [], airports: [], runways: [] },
          },
        }));
      }
      break;
    }

    case 'requestHistoryIndexStatus': {
      ws.send(JSON.stringify({
        type: MSG.HISTORY_INDEX_STATUS,
        success: true,
        status: flightCsvStore.getHistoryIndexStatus(),
      }));
      break;
    }

    case 'checkHistoryIndex':
    case 'rebuildHistoryIndex': {
      try {
        const result = await flightCsvStore.startHistoryIndex({
          rebuild: msg.type === 'rebuildHistoryIndex',
        });
        ws.send(JSON.stringify({
          type: MSG.HISTORY_INDEX_STATUS,
          success: result.success === true,
          status: result.status || flightCsvStore.getHistoryIndexStatus(),
          ...(result.error ? { error: result.error } : {}),
        }));
      } catch (err) {
        Debug.log('ws', 'history index action error', { error: err.message });
        ws.send(JSON.stringify({
          type: MSG.HISTORY_INDEX_STATUS,
          success: false,
          status: flightCsvStore.getHistoryIndexStatus(),
          error: 'Could not start the flight history index',
        }));
      }
      break;
    }

  }
}

const clientMessageHandlerApi = { handleClientMessage };

module.exports = clientMessageHandlerApi;

export {};
