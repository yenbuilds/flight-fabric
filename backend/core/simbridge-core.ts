// simbridge-core.js
// - Broadcast payload compatibility is preserved while tick timing uses measured cadence.
// - This module must not reference offsets or mock mode logic.

const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const { MSG } = require('./message-types');
const { computeCrosswind, decodeGearState, rad2deg } = require('../utils/helpers');
const {
  runStability,
  resetStability,
  SimpleStabilityScorer,
  frameToSample,
  getStabilityCriteria,
  resolveGlidepathAngleForApproach,
} = require('../stability/stability-runner');
const {
  resolveStabilityPolicy,
  buildStabilityScoringContext,
} = require('../stability/stability-policy');
const { sendBasicStreams, sendAttitude, sendGear, sendFlapsSpoilers, sendSurface, sendFuel, sendPosition, sendEnvironment, assessAutopilotReliability, sendAutopilot, sendControls } = require('../events/broadcasters');
const { normalizeSurface } = require('../aircraft/surface-normalizer');
const { updatePhase, getPhase } = require('../lifecycle/phase-runner');
const { PHASES, APPROACH_PHASES } = require('../lifecycle/phases');
const Debug = optionalRequire('./debug', {
  log: () => {},
  tlog: () => {},
  twarn: () => {},
});
const { tlog } = Debug;

const { createLandingRunner } = require('../landing/landing-runner');
const { createFlightViolationRunner } = require('../flight-violations/flight-violation-runner');
const { createConvectiveRiskRunner } = require('../flight-violations/convective-risk-runner');
const { makeFlapsObj, makeFlapsObjFromLvar } = require('../aircraft/flaps');
const {
  LifecycleState,
  checkFlightStartEligibility,
  logStateTransition,
  resetStateLogger,
  updateActiveFlightEndGuard,
  updateMotionDetector,
  buildFlightStartReason,
  updateManualAutoStartSuppression,
} = require('../lifecycle/flight-lifecycle');

const { computeIasTrend, computePitchBankRates } = require('../utils/flight-kinematics');

const flightCsvWriter = require('../flight-recording/flight-csv-writer');
const { createFlightCsvStore } = require('../flight-recording/flight-csv-store') as {
  createFlightCsvStore: (_options?: AnyRecord) => AnyRecord;
};
const {
  createLowDiskError,
  createRecordingDiskGuard,
  isDiskCapacityError,
} = require('../flight-recording/recording-disk-guard') as {
  createLowDiskError: (_decision: AnyRecord) => Error;
  createRecordingDiskGuard: (_options: AnyRecord) => AnyRecord;
  isDiskCapacityError: (_error: unknown) => boolean;
};
const automationJsonlRecorder = require('../flight-recording/automation-jsonl-recorder');
const aircraftSpecificJsonlRecorder = require('../flight-recording/aircraft-specific-jsonl-recorder');
const { publishRecordingBundleStatus } = require('../flight-recording/recording-bundle-status') as {
  publishRecordingBundleStatus: (_options: AnyRecord) => Promise<AnyRecord>;
};
const recordingBundleLifecycle = require('../flight-recording/recording-bundle-lifecycle') as {
  allocateBundleBaseName: (_outputDir: string, _preferredBaseName: string) => string;
  beginRecordingBundle: (_input: AnyRecord) => AnyRecord;
  beginRecordingBundleStartup: (_input: AnyRecord) => AnyRecord;
  commitRecordingBundleStartup: (_recordingSessionId: string) => AnyRecord;
  discardUncommittedBundle: (_outputDir: string, _baseName: string, _artifacts: unknown[]) => void;
  finishRecordingBundle: (_recordingSessionId: string) => void;
  finishRecordingBundleStartup: (_recordingSessionId: string) => void;
  getActiveRecordingBundle: () => AnyRecord | null;
  getFinalizingRecordingBundle: () => AnyRecord | null;
  getStartingRecordingBundle: () => AnyRecord | null;
  isOwnedRecordingBundleCsvPath: (_csvPath: unknown) => boolean;
  getRecordingBundleStartBlocker: () => string;
  markRecordingBundleFinalizing: (_recordingSessionId: string) => AnyRecord | null;
  markRecordingBundleDegraded: (_recordingSessionId: string, _reason: unknown) => void;
  updateRecordingBundleBaseName: (_recordingSessionId: string, _baseName: string) => AnyRecord;
};
const recordingBundleLayout = require('../flight-recording/recording-bundle-layout') as {
  buildBundleName: (_flightId: unknown, _recordingSessionId: unknown) => string;
  getBundlePaths: (_outputDir: string, _bundleName: string) => { csv: string };
};
const { buildLandingCsvEventData } = require('../flight-recording/landing-csv-contract');
const timeSource = require('./time-source');
const eventBus = require('./event-bus');
const { getAppVersion } = require('./app-version');
const { getUserId, getSessionId } = require('../utils/user-identity');
const profileLoader = require('../aircraft/aircraft-profile-loader');
const { finalizeRecordingForShutdown, runSimbridgeShutdownSequence } = require('./simbridge-shutdown') as {
  finalizeRecordingForShutdown: (options: AnyRecord) => Promise<void>;
  runSimbridgeShutdownSequence: (options: AnyRecord) => Promise<void>;
};
const { createAircraftSpecificStateProjector } = require('../aircraft/aircraft-specific-state') as {
  createAircraftSpecificStateProjector: (params: AnyRecord) => {
    reset: () => void;
    update: (input: AnyRecord) => AnyRecord | null;
  };
};
const aircraftControlService = require('../aircraft/aircraft-control-service');
const recordingSession = require('../flight-recording/recording-session');
const { isoFromMs, createEventId } = require('./time-id');

const { createTickFrameFactory } = require('../lifecycle/tick-frame');
const flightLogbook = require('../landing/flight-logbook');
const { getDataSourceInfo } = require('../telemetry-provider');
const {
  createSourceOverlayContext,
  overlayParkingBrakeSources,
  resolveAutopilotSourceOverlay,
  resolveLightsForBroadcast,
  resolveSpoilersForBroadcast,
} = require('../telemetry-provider/source-overlays') as {
  createSourceOverlayContext: (params: {
    frame: AnyRecord | null | undefined;
    dataSourceInfo: AnyRecord | null | undefined;
    profile?: AnyRecord | null | undefined;
  }) => AnyRecord;
  overlayParkingBrakeSources: (params: { gear: AnyRecord; profile: AnyRecord | null | undefined; sourceContext: AnyRecord }) => AnyRecord;
  resolveAutopilotSourceOverlay: (params: { baseFdm: AnyRecord; profile: AnyRecord | null | undefined; sourceContext: AnyRecord }) => AnyRecord;
  resolveLightsForBroadcast: (params: { baseLights: AnyRecord | null | undefined; profile: AnyRecord | null | undefined; sourceContext: AnyRecord }) => AnyRecord | null | undefined;
  resolveSpoilersForBroadcast: (params: { baseSpoilers: AnyRecord | null | undefined; profile: AnyRecord | null | undefined; frame: AnyRecord | null | undefined; sourceContext: AnyRecord }) => AnyRecord | null | undefined;
};
const { createVreEvaluator } = require('../events/vre-evaluator');
const { handleClientMessage: handleClientMessageImpl } = require('./client-message-handler');
const { isClientMessageAuthorized } = require('./client-message-authorization');
const { buildClientMessageContext } = require('./client-message-context');
const { createWsServer } = require('./ws-bootstrap');
const { createBroadcast } = require('./ws-broadcaster');
const { startHttpServer } = require('./http-server');
const {
  createCabinAnnouncementsController,
  resolveCabinAnnouncementsReconfigureSettings,
} = require('../cabin-announcements/cabin-announcements-controller');
const { startUpdateChecker } = require('./update-checker');
const {
  sanitizeTarget,
  readDestinationTarget,
  writeDestinationTarget,
  clearDestinationTargetFile,
  readOriginTarget,
  writeOriginTarget,
  clearOriginTargetFile,
} = require('./destination-target-store');
const {
  createSimbridgeRuntimeState,
  getReplayMessages,
  rememberReplayMessage,
  resetSimbridgeBroadcastState,
} = require('./simbridge-runtime-state.js') as {
  createSimbridgeRuntimeState: (params: AnyRecord) => AnyRecord;
  getReplayMessages: (runtimeState: AnyRecord) => AnyRecord[];
  rememberReplayMessage: (runtimeState: AnyRecord, message: AnyRecord | null | undefined) => void;
  resetSimbridgeBroadcastState: (runtimeState: AnyRecord) => void;
};
const {
  buildSignalReliabilityPayload,
  resolveAircraftSpecificTemplateId,
  computeSimStateMenuFlag,
  computeHeadingAndMagvar,
  computeElapsedMs,
  formatElapsedHms,
  mergeFdmData,
  getEngineLevels,
  getProfileEngineCount,
  extractActivityFields,
  countActiveTelemetryFields,
  buildVreEnrichedFrame,
  isVreCsvSampleDue,
  resolveVreSamplingRate,
  shouldCollectCurrentApproachSample,
  shouldStartCurrentApproachScorer,
  shouldResetCurrentApproachScorerForParked,
  resetGoAroundScoringState,
  buildEnginesBroadcastData,
  computeGearBroadcastState,
  deriveApproachConfigurationState,
  advanceDebouncedChangeState,
  buildVreEvaluationFrame,
  deriveOverallSignalReliability,
  normalizePitchBankDegrees,
  extractThrottlePercents,
  computeBrakePct,
  resolveLandingGeometryScoringInputs,
} = require('./simbridge-core-utils');

type AnyRecord = Record<string, any>;
type FrameAcquisitionResult =
  | { status: 'frame'; frame: AnyRecord }
  | { status: 'shutdown'; frame: null };

function snapshotStabilityScoringInputs({
  profile,
  commonCriteria,
  profileCriteria,
}: {
  profile?: AnyRecord | null;
  commonCriteria?: AnyRecord | null;
  profileCriteria?: AnyRecord | null;
}): AnyRecord {
  const resolvedPolicy = resolveStabilityPolicy({
    profile,
    commonCriteria,
    profileCriteria,
  });
  const criteria = Object.freeze({ ...(resolvedPolicy.criteria || {}) });
  const profileSnapshot = profile && typeof profile === 'object'
    ? Object.freeze({
      id: typeof profile.id === 'string' && profile.id.trim() ? profile.id.trim() : 'generic',
      name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : null,
      aircraft: Object.freeze({
        category: profile.aircraft?.category ?? null,
      }),
      signalReliability: Object.freeze({
        stabilityScore: profile.signalReliability?.stabilityScore ?? null,
      }),
    })
    : null;
  const policy = Object.freeze({
    ...resolvedPolicy,
    criteria,
  });
  const engineCount = getProfileEngineCount(profile) || 4;

  return Object.freeze({ profile: profileSnapshot, criteria, policy, engineCount });
}

function resolveRecordedStabilityScoringInputs(
  recordedProfileId: unknown,
  options: {
    profileLoaderApi?: AnyRecord;
    commonCriteria?: AnyRecord | null;
  } = {},
): AnyRecord {
  const loader = options.profileLoaderApi || profileLoader;
  const normalizedProfileId = typeof recordedProfileId === 'string' && recordedProfileId.trim()
    ? recordedProfileId.trim()
    : 'generic';
  let profile = null;
  try {
    profile = typeof loader.loadProfile === 'function'
      ? loader.loadProfile(normalizedProfileId)
      : null;
  } catch (_e) {}
  if (!profile && normalizedProfileId !== 'generic') {
    try {
      profile = typeof loader.loadProfile === 'function' ? loader.loadProfile('generic') : null;
    } catch (_e) {}
  }

  let profileCriteria = null;
  try {
    profileCriteria = typeof loader.getStabilityScoringCriteria === 'function'
      ? loader.getStabilityScoringCriteria(profile)
      : null;
  } catch (_e) {}

  return snapshotStabilityScoringInputs({
    profile,
    commonCriteria: options.commonCriteria ?? getStabilityCriteria(),
    profileCriteria,
  });
}

function averageFinite(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function resolveApproachScoringThrottlePct(frame, engineLevels) {
  const throttleSnapshot = frame?.throttle || null;
  const { thr1Pct, thr2Pct, thr3Pct, thr4Pct } = extractThrottlePercents(throttleSnapshot);
  const leverPct = averageFinite([thr1Pct, thr2Pct, thr3Pct, thr4Pct]);
  if (leverPct !== null) return leverPct;

  // Historical/provider fallback: engine levels may be N1-like rather than
  // lever position, so prefer explicit throttle data whenever it exists.
  return averageFinite(Array.isArray(engineLevels) ? engineLevels : []);
}

function optionalRequire(modulePath, fallbackModule) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(modulePath);
  } catch (err) {
    // In release builds, certain modules are intentionally excluded by profile.
    // We treat missing modules as a disabled feature.
    if (err && err.code !== 'MODULE_NOT_FOUND') {
      try {
        Debug.log('simbridge-core', 'optional_module_load_failed', { modulePath, error: err.message });
      } catch {
        // Swallow logging errors during early startup.
      }
    }
    return fallbackModule;
  }
}

function isTelemetryWarmupFrame(frame: AnyRecord | null | undefined): boolean {
  return frame?.simconnect?.warmup === true || frame?.telemetryWarmup === true;
}

function getActiveAircraftSpecificTemplateId(profile: AnyRecord | null | undefined): string | null {
  let aircraftSpecificConfig = null;
  try {
    aircraftSpecificConfig = typeof profileLoader.getAircraftSpecificConfig === 'function'
      ? profileLoader.getAircraftSpecificConfig()
      : null;
  } catch {
    // Retain the legacy profile-field fallback if effective config resolution fails.
  }
  return resolveAircraftSpecificTemplateId(aircraftSpecificConfig, profile);
}

const SHUTDOWN_RECORDING_FINALIZATION_TIMEOUT_MS = 12000;

function isShutdownRequested(shutdownSignal) {
  return shutdownSignal?.aborted === true;
}

function getShutdownReason(shutdownSignal) {
  const reason = shutdownSignal?.reason;
  return typeof reason === 'string' && reason ? reason : 'process_shutdown';
}

function waitForShutdownOrTimeout(shutdownSignal, timeoutMs) {
  if (isShutdownRequested(shutdownSignal)) {
    return Promise.resolve('shutdown');
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (shutdownSignal && typeof shutdownSignal.removeEventListener === 'function') {
        shutdownSignal.removeEventListener('abort', onAbort);
      }
      resolve(result);
    };
    const onAbort = () => finish('shutdown');
    const timer = setTimeout(() => finish('timeout'), Math.max(0, Number(timeoutMs) || 0));
    if (typeof timer.unref === 'function') timer.unref();

    if (shutdownSignal && typeof shutdownSignal.addEventListener === 'function') {
      shutdownSignal.addEventListener('abort', onAbort, { once: true });
      if (shutdownSignal.aborted) finish('shutdown');
    }
  });
}

async function waitForNextFrameOrShutdown(provider, shutdownSignal): Promise<FrameAcquisitionResult> {
  if (isShutdownRequested(shutdownSignal)) {
    return { status: 'shutdown', frame: null };
  }

  let onAbort: (() => void) | null = null;
  const shutdownPromise = new Promise<FrameAcquisitionResult>((resolve) => {
    onAbort = () => resolve({ status: 'shutdown', frame: null });
    if (shutdownSignal && typeof shutdownSignal.addEventListener === 'function') {
      shutdownSignal.addEventListener('abort', onAbort, { once: true });
      if (shutdownSignal.aborted) onAbort();
    }
  });

  const framePromise: Promise<FrameAcquisitionResult> = Promise.resolve()
    .then(() => provider.nextFrame(shutdownSignal ?? undefined))
    .then((frame) => ({ status: 'frame', frame }));

  try {
    return await Promise.race([framePromise, shutdownPromise]);
  } finally {
    if (onAbort && shutdownSignal && typeof shutdownSignal.removeEventListener === 'function') {
      shutdownSignal.removeEventListener('abort', onAbort);
    }
  }
}

function runWithTimeout(promiseFactory, timeoutMs, label) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      console.warn(`[simbridge] ${label} timed out after ${timeoutMs}ms.`);
      finish(null);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    Promise.resolve()
      .then(promiseFactory)
      .then((value) => finish(value))
      .catch((error) => {
        console.warn(`[simbridge] ${label} failed:`, error?.message || String(error));
        finish(null);
      });
  });
}

function stopHandle(handle, label, timeoutMs = 2000) {
  if (!handle || typeof handle.stop !== 'function') return Promise.resolve(null);
  return runWithTimeout(() => handle.stop(), timeoutMs, `${label} stop`);
}

function closeHttpServer(httpServer, timeoutMs = 2000) {
  if (!httpServer || typeof httpServer.close !== 'function') return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    };
    const timer = setTimeout(() => {
      try {
        if (typeof httpServer.closeAllConnections === 'function') {
          httpServer.closeAllConnections();
        }
      } catch {}
      finish();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      httpServer.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
          console.warn('[simbridge] HTTP server close failed:', error?.message || String(error));
        }
        finish();
      });
    } catch (error) {
      if (error?.code !== 'ERR_SERVER_NOT_RUNNING') {
        console.warn('[simbridge] HTTP server close failed:', error?.message || String(error));
      }
      finish();
    }
  });
}

function closeWsServer(wss, timeoutMs = 2000) {
  if (!wss || typeof wss.close !== 'function') return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    };
    const closeClients = () => {
      try {
        if (wss.clients && typeof wss.clients.forEach === 'function') {
          wss.clients.forEach((client) => {
            try {
              if (typeof client.close === 'function') client.close(1001, 'Server shutdown');
            } catch {}
          });
        }
      } catch {}
    };
    const terminateClients = () => {
      try {
        if (wss.clients && typeof wss.clients.forEach === 'function') {
          wss.clients.forEach((client) => {
            try {
              if (typeof client.terminate === 'function') client.terminate();
            } catch {}
          });
        }
      } catch {}
    };

    const timer = setTimeout(() => {
      terminateClients();
      finish();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    closeClients();
    try {
      wss.close((error) => {
        if (error) {
          console.warn('[simbridge] WebSocket server close failed:', error?.message || String(error));
        }
        finish();
      });
    } catch (error) {
      console.warn('[simbridge] WebSocket server close failed:', error?.message || String(error));
      finish();
    }
  });
}

function waitForServerListening(server, label) {
  if (!server || typeof server.once !== 'function') {
    return Promise.reject(new Error(`${label} server is unavailable`));
  }
  if (server.listening === true || server?._server?.listening === true) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.removeListener?.('error', onError);
      resolve();
    };
    const onError = (error) => {
      server.removeListener?.('listening', onListening);
      reject(error instanceof Error ? error : new Error(`${label} server failed to listen`));
    };
    server.once('listening', onListening);
    server.once('error', onError);
    if (server.listening === true || server?._server?.listening === true) {
      server.removeListener?.('listening', onListening);
      server.removeListener?.('error', onError);
      resolve();
    }
  });
}

function createProviderBroadcastRelay({
  broadcast,
  buildControlCapabilities,
  getActiveProfile,
  getActiveProfileRevision,
}: AnyRecord = {}) {
  let lastControlCapabilitiesSignature: string | null = null;

  return (message: AnyRecord = {}) => {
    if (message?.type !== MSG.DATA_SOURCES) {
      broadcast(message);
      return;
    }

    try {
      const profile = getActiveProfile?.() || null;
      const profileKey = profile?._profileKey
        || profile?._qualifiedId
        || (profile?.namespace && profile?.simulator && profile?.id
          ? `${profile.namespace}/${profile.simulator}/${profile.id}`
          : (profile?.id || 'generic'));
      const profileRevision = Number(getActiveProfileRevision?.());
      const normalizedProfileRevision = Number.isSafeInteger(profileRevision) && profileRevision >= 0
        ? profileRevision
        : null;
      const controlCapabilities = buildControlCapabilities?.(profile) || null;
      const signature = JSON.stringify({
        profileKey,
        profileRevision: normalizedProfileRevision,
        controlCapabilities,
      });

      if (signature !== lastControlCapabilitiesSignature) {
        lastControlCapabilitiesSignature = signature;
        broadcast({
          ...message,
          profileKey,
          profileRevision: normalizedProfileRevision,
          controlCapabilities,
        });
        return;
      }
    } catch {}

    broadcast(message);
  };
}

async function runSimbridgeCore({
  provider,
  pollRateMs = 100,
  wsPort = 8099,
  httpPort = null,
  shutdownSignal = null,
  onFatalError = null,
}: AnyRecord = {}) {
  let httpServerHandle = null;
  let cabinAnnouncementsHandle = null;
  let updateCheckerHandle = null;
  let flightCsvStore: AnyRecord | null = null;
  let coreShutdownStarted = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // Sim state cache (for menu/flight status on reconnect)
  // ═══════════════════════════════════════════════════════════════════════════
  const runtimeState = createSimbridgeRuntimeState({
    destinationTarget: readDestinationTarget(),
    originTarget: readOriginTarget(),
  });

  function getProviderControlCapabilities() {
    if (provider && typeof provider.getAircraftControlCapabilities === 'function') {
      return provider.getAircraftControlCapabilities();
    }
    return provider?.aircraftControlCapabilities || provider?.controlCapabilities || null;
  }

  function buildControlCapabilities(profile: AnyRecord | null | undefined) {
    if (!aircraftControlService || typeof aircraftControlService.buildAircraftControlCapabilities !== 'function') {
      return null;
    }
    return aircraftControlService.buildAircraftControlCapabilities(profile, {
      capabilities: getProviderControlCapabilities(),
    });
  }

  function getDestinationTarget() {
    return runtimeState.targets.destination || null;
  }

  function setDestinationTarget(target) {
    const sanitized = sanitizeTarget(target);
    if (!sanitized) return null;
    writeDestinationTarget(sanitized);
    runtimeState.targets.destination = sanitized;
    return sanitized;
  }

  function clearDestinationTarget() {
    clearDestinationTargetFile();
    runtimeState.targets.destination = null;
  }

  function getOriginTarget() {
    return runtimeState.targets.origin || null;
  }

  function setOriginTarget(target) {
    const sanitized = sanitizeTarget(target);
    if (!sanitized) return null;
    writeOriginTarget(sanitized);
    runtimeState.targets.origin = sanitized;
    return sanitized;
  }

  function clearOriginTarget() {
    clearOriginTargetFile();
    runtimeState.targets.origin = null;
  }

  // Flight-time tracking (for UI + CSV). Start when we leave ground phases.
  let flightStartEpochMs = null;
  let flightStartIso = '';
  let flightRecordingStartEpochMs = null;
  let flightRecordingStartIso = '';
  let flightRecordingSessionId = '';
  let lastFlightTimeBroadcastSec = null;

  // Flight lifecycle gate: only log/broadcast flight timer during a real flight.
  // Declared early so WS handlers can safely read on immediate client messages.
  let flightActive = false;
  let flightId = '';
  let aircraftSpecificRecordingFinalizing = false;
  let recordingBundleFailureHandling = false;
  let recordingBundleAggregateFinalizingSessionId = '';
  const pendingRecordingBundleStartupErrors = new Map<string, Error>();
  let activeFlightFinalizationPromise: Promise<unknown> | null = null;

  // Track aircraft title at flight start to detect mid-flight aircraft changes.
  let flightStartAircraftTitle = null;

  // Track last broadcast notch/state so we only set changed:true on transitions.
  // Debounce spoilers: some integrations report transient SPOILERS ARMED/HANDLE
  // changes. Require 2 consecutive stable ticks before emitting changed:true.
  const SPOILERS_DEBOUNCE_TICKS = 2;

  const FLIGHT_START_COOLDOWN_MS = 30000; // 30 seconds minimum gap between flights
  const MANUAL_AUTO_START_REARM_PARKED_DWELL_MS = 30000;
  const MANUAL_AUTO_START_CONTEXT_RESET_DWELL_MS = 5000;
  const MANUAL_AUTO_START_STOPPED_GS_KTS = 1;
  const MANUAL_AUTO_START_STOPPED_IAS_KTS = 5;
  const MANUAL_AUTO_START_ENGINE_OFF_MAX_PCT = 1;
  const SIMCONNECT_DISCONNECT_GRACE_MS = 5000; // Wait 5s before ending flight on disconnect
  const DISK_CHECK_INTERVAL_MS = 30 * 1000;
  const DISK_RESUME_MARGIN_GB = 0.5;
  const SIM_STATE_BROADCAST_THROTTLE_MS = 1000; // Throttle simState broadcasts to 1Hz
  const VERBOSE_LOG_THROTTLE_MS = 2000; // Throttle verbose logging to every 2s
  const DEBUG_LOG_PROBABILITY = 0.01; // 1% probability for random debug logs
  const GPS_CHANGE_THRESHOLD = 0.000001; // GPS coordinate change threshold
  const ALTITUDE_CHANGE_THRESHOLD_FT = 0.1; // Altitude change threshold in feet
  const HEADING_CHANGE_THRESHOLD_DEG = 0.1; // Heading change threshold in degrees
  const MAX_PITCH_BANK_DEG = 90; // Maximum valid pitch/bank angle for logging
  const configuredMinFreeDiskGb = Number(config.recording?.minFreeDiskGb);
  const minFreeDiskGb = Number.isFinite(configuredMinFreeDiskGb)
    ? Math.max(0, configuredMinFreeDiskGb)
    : 2;
  const recordingDiskGuard = createRecordingDiskGuard({
    minFreeGb: minFreeDiskGb,
    resumeMarginGb: DISK_RESUME_MARGIN_GB,
    recheckIntervalMs: DISK_CHECK_INTERVAL_MS,
    now: () => timeSource.now(),
  });

  function getAirportGeometryLookupContext(): AnyRecord {
    const dataSource = getDataSourceInfo().primary?.type || null;
    return { simulator: dataSource, dataSource };
  }

  if (!provider || typeof provider.start !== 'function' || typeof provider.nextFrame !== 'function') {
    throw new Error('[simbridge-core] provider missing start()/nextFrame()');
  }

  const capabilities = provider.capabilities || {};

  // WEBSOCKET SERVER
  let broadcast: (_message?: AnyRecord) => void = () => {};
  const wsAuthToken = crypto.randomBytes(32).toString('hex');
  const aircraftControlToken = crypto.randomBytes(32).toString('hex');

  const wss = createWsServer({
    wsPort,
    remoteAccessEnable: config.http?.remoteAccessEnable === true,
    remoteAircraftControlEnable: config.http?.remoteAircraftControlEnable === true,
    wsAuthToken,
    aircraftControlToken,
    Debug,
    tlog,
    onFatalError: typeof onFatalError === 'function'
      ? (error) => onFatalError('websocket_server', error)
      : undefined,
    onClientConnected: (ws) => {
    // Send current phase to new clients immediately so they don't wait for a phase change
    try {
      const currentPhase = getPhase();
      if (currentPhase && currentPhase !== PHASES.UNKNOWN) {
        ws.send(JSON.stringify({ type: MSG.PHASE, value: currentPhase }));
      }
    } catch {}

    // Send current flight recording status to new clients
    // This ensures the recording indicator shows correctly after page refresh
    try {
      if (!recordingBundleFailureHandling && flightCsvWriter.isRecording()) {
        const csvStats = flightCsvWriter.getStats();
        ws.send(JSON.stringify({
          type: MSG.FLIGHT_RECORDING,
          status: 'recording',
          fileName: typeof csvStats?.filePath === 'string' ? path.basename(csvStats.filePath) : '',
          // outputDir intentionally omitted: it is a full local disk path that
          // would be sent to any connected client including remote mobile clients
          // when REMOTE_ACCESS_ENABLE=1. The frontend falls back to filePath for
          // display (index-app.js: msg.outputDir || msg.filePath || fallback).
          flightId: csvStats?.flightId,
          rowsWritten: csvStats?.rowCount,
        }));
      }
    } catch {}

    // Send current aircraft profile to new clients
    // This ensures aircraft type displays correctly after page refresh
    try {
      const profile = profileLoader.getActiveProfile();
      const lastTitle = profileLoader.getLastDetectedTitle?.() || null;
      if (profile || lastTitle) {
        ws.send(JSON.stringify({
          type: MSG.AIRCRAFT_PROFILE,
          profile: {
            id: profile?.id || 'generic',
            name: profile?.name || 'Generic',
            namespace: profile?.namespace,
            simulator: profile?.simulator,
            _qualifiedId: profile?._qualifiedId || profile?._profileKey || null,
            _profileKey: profile?._profileKey || profile?._qualifiedId || null,
            profileRevision: typeof profileLoader.getActiveProfileRevision === 'function'
              ? profileLoader.getActiveProfileRevision()
              : null,
            aircraftSpecificTemplateId: getActiveAircraftSpecificTemplateId(profile),
            aircraftTitle: lastTitle,
            visualSupport: profile?.visualSupport || 'basic',
            throttleType: profile?.throttle?.type || null,
          },
          controlCapabilities: buildControlCapabilities(profile),
          source: 'reconnect',
        }));
      }
    } catch {}

    // Send current signal reliability to new clients
    try {
      const profile = profileLoader.getActiveProfile();
      ws.send(JSON.stringify(buildSignalReliabilityPayload(profile)));
    } catch {}

    // Send active data sources to new clients
    try {
      const dataSourceInfo = getDataSourceInfo();
      ws.send(JSON.stringify({
        type: MSG.DATA_SOURCES,
        ...dataSourceInfo,
      }));
    } catch {}

    // Send current sim state to new clients (menu/flight status)
    try {
      if (runtimeState.sim.lastState) {
        ws.send(JSON.stringify(runtimeState.sim.lastState));
      }
    } catch {}

    // Send shared destination target to new clients
    try {
      ws.send(JSON.stringify({
        type: MSG.DESTINATION_TARGET,
        target: getDestinationTarget(),
      }));
    } catch {}

    // Send shared origin target to new clients
    try {
      ws.send(JSON.stringify({
        type: MSG.ORIGIN_TARGET,
        target: getOriginTarget(),
      }));
    } catch {}

    },
    onClientMessage: async (ws, msg) => {
      if (!isClientMessageAuthorized(ws, msg?.type)) {
        // Preserve the standard command-specific denial envelopes without
        // constructing replay/storage/provider context for a denied command.
        await handleClientMessageImpl(ws, msg, { Debug });
        return;
      }
      const context = buildClientMessageContext({
          lastSimState: runtimeState.sim.lastState,
          getSimState: () => runtimeState.sim.lastState,
          getPhase,
          flightCsvWriter,
          flightCsvStore,
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
          replayMessages: getReplayMessages(runtimeState),
          provider,
          broadcast,
          getCabinAnnouncementsConfig: () => (
            cabinAnnouncementsHandle?.getConfig?.() || config.cabinAnnouncements
          ),
          reconfigureCabinAnnouncements: (settings) => {
            if (
              !cabinAnnouncementsHandle
              || typeof cabinAnnouncementsHandle.reconfigure !== 'function'
            ) {
              throw new Error('Cabin announcement controller is unavailable');
            }
            return cabinAnnouncementsHandle.reconfigure(
              resolveCabinAnnouncementsReconfigureSettings(
                settings,
                config.cabinAnnouncements,
              ),
            );
          },
          timeNow: timeSource.now,
          Debug
      });
      if (msg.type === 'lvarDebugWatch') {
        const rawSubscriptions = Array.isArray(msg.subscriptions) ? msg.subscriptions : [];
        if (capabilities.isMock || typeof provider.setDebugLvarSubscriptions !== 'function') {
          ws.send(JSON.stringify({
            type: MSG.LVAR_DEBUG_WATCH_ACK,
            ok: false,
            error: 'lvar_debug_watch_unavailable',
          }));
          return;
        }

        const applied = provider.setDebugLvarSubscriptions(rawSubscriptions);
        ws.send(JSON.stringify({
          type: MSG.LVAR_DEBUG_WATCH_ACK,
          ok: true,
          count: Array.isArray(applied) ? applied.length : 0,
        }));
        return;
      }
      // Handle test shake command (requires provider, not in standard context)
      if (msg.type === 'testShake') {
        const vsFpm = (typeof msg.vs_fpm === 'number') ? msg.vs_fpm : -400;
        console.log(`[TouchdownShake] testShake received: vs_fpm=${vsFpm} isMock=${capabilities.isMock} hasFn=${typeof provider.triggerTouchdownShake === 'function'}`);

        const diagInfo = {
          isMock: capabilities.isMock,
          hasTriggerFn: typeof provider.triggerTouchdownShake === 'function',
          lvarBridge: !!provider._lvarBridge,
          lvarStarted: provider._lvarBridge?._started,
          lvarProcAlive: provider._lvarBridge?._proc && !provider._lvarBridge._proc.killed,
          sdkBridge: !!provider._sdkBridge,
          sdkStarted: provider._sdkBridge?._started,
          sdkProcAlive: provider._sdkBridge?._proc && !provider._sdkBridge._proc.killed,
          connected: provider._connected,
          handle: !!provider._handle,
        };
        console.log('[TouchdownShake] diag:', JSON.stringify(diagInfo));

        if (!capabilities.isMock && typeof provider.triggerTouchdownShake === 'function') {
          try { provider.triggerTouchdownShake(vsFpm); } catch (e) { console.warn('[TouchdownShake] testShake failed:', e.message); }
        } else {
          console.warn('[TouchdownShake] testShake: provider not available or is mock');
        }
        ws.send(JSON.stringify({ type: MSG.TEST_SHAKE_ACK, vs_fpm: vsFpm, diag: diagInfo }));
        return;
      }
      await handleClientMessageImpl(ws, msg, context);
    },
  });

  // Core broadcast function - sends to WebSocket clients AND event bus.
  // Keep a compact latest-state replay cache so page refreshes, reconnects, and
  // foregrounded browser tabs can immediately converge to the current simulator
  // state instead of waiting for every per-field telemetry stream to tick again.
  const rawBroadcast = createBroadcast({ wss, eventBus, Debug });
  broadcast = (message) => {
    rememberReplayMessage(runtimeState, message);
    rawBroadcast(message);
  };
  let recorderFieldCatalogConfig: AnyRecord | null = null;
  let recorderFieldCatalog: AnyRecord[] = [];
  const aircraftSpecificStateProjector = createAircraftSpecificStateProjector({
    broadcast,
    profileLoader,
    onStateBuilt: (state, context) => {
      if (
        aircraftSpecificRecordingFinalizing
        || flightCsvWriter.isRecording?.() !== true
        || aircraftSpecificJsonlRecorder.isRecording?.() !== true
      ) return;
      const csvStats = flightCsvWriter.getStats?.();
      const aircraftStats = aircraftSpecificJsonlRecorder.getStats?.();
      if (
        !csvStats?.recordingSessionId
        || csvStats.recordingSessionId !== aircraftStats?.recordingSessionId
        || csvStats.recordingSessionId !== flightRecordingSessionId
      ) return;

      const aircraftSpecificConfig = context?.config || {};
      if (aircraftSpecificConfig !== recorderFieldCatalogConfig) {
        recorderFieldCatalogConfig = aircraftSpecificConfig;
        recorderFieldCatalog = Array.isArray(aircraftSpecificConfig.fields)
          ? aircraftSpecificConfig.fields.map((field) => ({
            id: field?.id,
            valueType: field?.decode?.type,
          }))
          : [];
      }

      aircraftSpecificJsonlRecorder.recordAircraftSpecificState({
        profileKey: state.profileKey,
        profileRevision: state.profileRevision,
        integrationId: aircraftSpecificConfig.integrationId || null,
        templateId: state.templateId,
        available: state.available,
        sourceStatus: state.sourceStatus,
        values: state.values,
        unavailable: state.unavailable,
        updatedAt: state.updatedAt,
        fieldCatalog: recorderFieldCatalog,
        timeMs: context.nowEpochMs,
        timestampIso: context.timestampIso,
        flightElapsedMs: computeElapsedMs(context.nowEpochMs, flightRecordingStartEpochMs),
        flightId,
        flightStartIso: flightRecordingStartIso,
        aircraftTitle: flightStartAircraftTitle,
      });
    },
    onStateObserverError: (error) => {
      console.warn('[aircraft-specific-jsonl] State write failed (non-critical):', error?.message || String(error));
    },
    getCapabilities: () => {
      const capabilities = buildControlCapabilities(profileLoader.getActiveProfile());
      return {
        actions: capabilities?.aircraftSpecific || {},
        dependencies: capabilities?.aircraftSpecificDependencies || {},
      };
    },
  });
  const wsListeningPromise = waitForServerListening(wss, 'WebSocket');

  // HTTP server (remote device access)
  httpServerHandle = startHttpServer({
    wsPort,
    httpPort: httpPort ?? config.http?.port,
    remoteAccessEnable: config.http?.remoteAccessEnable,
    wsAuthToken,
    aircraftControlToken,
    Debug,
    onFatalError: typeof onFatalError === 'function'
      ? (error) => onFatalError('http_server', error)
      : undefined,
  });
  const httpListeningPromise = waitForServerListening(
    httpServerHandle?.httpServer,
    'HTTP',
  );

  // Initialize debug module with WS broadcast
  try {
    Debug.init(broadcast);
  } catch {}

  // Cabin announcements — play PA audio in frontend at flight phase transitions.
  // Keep the controller alive while disabled so settings can reconfigure it
  // without restarting the backend.
  try {
    cabinAnnouncementsHandle = createCabinAnnouncementsController({
      eventBus,
      broadcast,
      getCurrentPhase: () => getPhase(),
      getLatestTelemetryFrame: () => runtimeState.sim.latestTickFrame,
    });
    cabinAnnouncementsHandle.reconfigure(config);
  } catch (err) {
    console.warn('[cabin-announcements] failed to start:', err.message);
  }

  // Update checker - desktop app builds check at a low cadence unless the user
  // disables update checks in settings or via UPDATE_CHECKS_ENABLED=0.
  const APP_VERSION = getAppVersion();
  const updateChecksAllowed = config.env.isPackaged
    || config.env.isElectronBackend
    || config.env.isLocalBatchLaunch;
  if (APP_VERSION && updateChecksAllowed) {
    if (config.updates?.enabled === true) {
      try {
        updateCheckerHandle = startUpdateChecker({ broadcast, currentVersion: APP_VERSION });
      } catch (err) {
        console.warn('[update-checker] failed to start:', err.message);
      }
    }
  }

  // Pending aircraft change for flight end detection
  // This flag is set by the event handler below and checked by the main loop
  // to end any active flight when the aircraft changes (conservative approach).
  let pendingAircraftChange = null;  // { newTitle, previousTitle } or null
  
  // Flag to capture VS0 on next telemetry frame (for ICAO category inference)
  let pendingVs0Capture = false;

  // Subscribe to aircraft changes for profile auto-detection
  eventBus.on('simconnect:aircraftChanged', (payload: any = {}) => {
    const { title, displayName, previousTitle } = payload;
    const xplaneIdentity = payload.xplane && typeof payload.xplane === 'object'
      ? payload.xplane
      : null;
    const previousXplaneIdentity = payload.previousXplane && typeof payload.previousXplane === 'object'
      ? payload.previousXplane
      : null;
    const isXplaneAircraftChange = xplaneIdentity !== null || previousXplaneIdentity !== null || payload.source === 'xplane-web';
    const xplaneAcfPath = typeof xplaneIdentity?.acfPath === 'string' && xplaneIdentity.acfPath
      ? xplaneIdentity.acfPath
      : null;
    const previousXplaneAcfPath = typeof previousXplaneIdentity?.acfPath === 'string' && previousXplaneIdentity.acfPath
      ? previousXplaneIdentity.acfPath
      : null;
    const xplaneDisplayFallback = typeof xplaneIdentity?.acfFileName === 'string' && xplaneIdentity.acfFileName
      ? xplaneIdentity.acfFileName
      : (typeof xplaneIdentity?.id === 'string' && xplaneIdentity.id ? xplaneIdentity.id : null);
    const previousXplaneDisplayFallback = typeof previousXplaneIdentity?.acfFileName === 'string' && previousXplaneIdentity.acfFileName
      ? previousXplaneIdentity.acfFileName
      : (typeof previousXplaneIdentity?.id === 'string' && previousXplaneIdentity.id ? previousXplaneIdentity.id : null);
    const isFilePath = (s) => typeof s === 'string' && (s.includes('\\') || s.includes('/') || /\.cfg$/i.test(s));
    const aircraftConfigPath = payload.aircraftConfigPath || xplaneAcfPath || (isFilePath(title) ? title : null);
    const previousAircraftConfigPath = payload.previousAircraftConfigPath || previousXplaneAcfPath || (isFilePath(previousTitle) ? previousTitle : null);
    const aircraftDisplayName = (displayName && !isFilePath(displayName))
      ? displayName
      : (!aircraftConfigPath && title && !isFilePath(title) ? title : xplaneDisplayFallback);
    const previousDisplayName = (payload.previousDisplayName && !isFilePath(payload.previousDisplayName))
      ? payload.previousDisplayName
      : (!previousAircraftConfigPath && previousTitle && !isFilePath(previousTitle) ? previousTitle : previousXplaneDisplayFallback);
    const newAircraftTitle = aircraftConfigPath || aircraftDisplayName || title;
    const previousAircraftTitle = previousAircraftConfigPath || previousDisplayName || previousTitle;

    // Prefer the human-readable TITLE simvar (displayName) for profile matching.
    // AircraftLoaded returns the config file path (e.g. "SimObjects\Airplanes\FNX_32X\..."),
    // while the TITLE simvar returns the name from aircraft.cfg (e.g. "FNX A320 CFM").
    // If displayName looks like a file path, ignore it and fall back to the config path.
    const matchTitle = isXplaneAircraftChange ? null : (aircraftDisplayName || aircraftConfigPath || title);
    // Pass the configPath (title) as a hint so profile matching can use it as a
    // fallback when the display name alone doesn't contain enough identity info.
    // e.g. some liveries use display names without the manufacturer prefix,
    // but the configPath contains the full aircraft name which matches the profile regex.
    const matchHint = (!isXplaneAircraftChange && aircraftConfigPath && matchTitle !== aircraftConfigPath) ? aircraftConfigPath : undefined;
    const sameAircraftIdentity = Boolean(
      newAircraftTitle &&
      previousAircraftTitle &&
      newAircraftTitle === previousAircraftTitle
    );

    if (!sameAircraftIdentity) {
      // Signal pending flight end due to aircraft change (main loop will handle)
      pendingAircraftChange = { newTitle: newAircraftTitle, previousTitle: previousAircraftTitle };

      // Clear VS0 cache and flag for capture on next frame
      profileLoader.clearVs0Cache();
      pendingVs0Capture = true;
    }

    try {
      const profile = profileLoader.setActiveProfileFromTitle(matchTitle, { hint: matchHint, xplane: xplaneIdentity });
      console.log(`[Profile] Aircraft: configPath="${aircraftConfigPath || '(unknown)'}" displayName="${aircraftDisplayName || '(unknown)'}" matchedOn="${matchTitle}"${matchHint ? ' (hint: configPath)' : ''} → profile: "${profile?.name || 'generic'}" (id: ${profile?.id || 'generic'})`);
      Debug.log('profile', 'Aircraft profile auto-detected', {
        title,
        displayName: aircraftDisplayName,
        previousTitle,
        aircraftConfigPath,
        previousAircraftConfigPath,
        previousDisplayName,
        matchTitle,
        profileId: profile?.id,
        profileName: profile?.name,
      });
      
      // When this is a real aircraft change (not first load), signal frontends to
      // reset their displayed state before the new profile arrives.  This gives
      // every overlay a clean slate — same principle as SimConnect disconnect reset.
      if (previousAircraftTitle && !sameAircraftIdentity) {
        broadcast({
          type: MSG.AIRCRAFT_CHANGED,
          previousTitle: previousAircraftTitle,
          newTitle: newAircraftTitle,
          previousAircraftConfigPath,
          aircraftConfigPath,
          previousDisplayName,
          displayName: aircraftDisplayName,
        });
        console.log(`[aircraft] Broadcast aircraftChanged: "${previousAircraftTitle}" → "${newAircraftTitle}"`);
      }

      // Broadcast profile change to frontend
      // Include provenance summary for UI quality indicators 
      const provenanceSummary = profile?.provenance ? {
        verificationStatus: profile.provenance.verification?.status || 'unverified',
        dataQuality: profile.provenance.dataQuality || {},
        sourceCount: profile.provenance.sources?.length || 0,
        hasOfficialSource: (profile.provenance.sources || []).some(s => 
          ['official-sdk', 'official-docs'].includes(s.type)
        ),
        lastVerified: profile.provenance.verification?.lastVerified || null,
        knownIssues: profile.provenance.verification?.knownIssues || [],
      } : null;
      
      broadcast({
        type: MSG.AIRCRAFT_PROFILE,
        profile: {
          id: profile?.id,
          name: profile?.name,
          namespace: profile?.namespace,
          simulator: profile?.simulator,
          _qualifiedId: profile?._qualifiedId || profile?._profileKey || null,
          _profileKey: profile?._profileKey || profile?._qualifiedId || null,
          profileRevision: typeof profileLoader.getActiveProfileRevision === 'function'
            ? profileLoader.getActiveProfileRevision()
            : null,
          aircraftSpecificTemplateId: getActiveAircraftSpecificTemplateId(profile),
          aircraftTitle: matchTitle || aircraftDisplayName || aircraftConfigPath || title,
          aircraftConfigPath,
          visualSupport: profile?.visualSupport || 'basic',
          throttleType: profile?.throttle?.type || null,
        },
        controlCapabilities: buildControlCapabilities(profile),
        provenance: provenanceSummary,
        previousTitle: previousAircraftTitle,
        previousAircraftConfigPath,
        previousDisplayName,
        source: 'auto-detect',
      });
      
      // Broadcast signal reliability for UI greying
      broadcast(buildSignalReliabilityPayload(profile));
    } catch (e) {
      Debug.log('profile', 'Profile auto-detect error', { error: e.message, title });
    }
  });

  // Landing runner (handles touchdown grading/logging)
  const landingRunner = createLandingRunner();

  // Flight violation runner (in-flight upset detection, entire flight)
  const flightViolationRunner = createFlightViolationRunner();
  const convectiveRiskRunner = createConvectiveRiskRunner();

  // Subscribe to aircraft changes for STATE RESET
  // When user changes aircraft (e.g., via menu), reset transient scoring/tracking state.
  // This complements the profile auto-detection subscription registered earlier.
  eventBus.on('simconnect:aircraftChanged', (payload: any = {}) => {
    const title = payload.aircraftConfigPath || payload.displayName || payload.title;
    const previousTitle = payload.previousAircraftConfigPath || payload.previousDisplayName || payload.previousTitle;
    if (!previousTitle) {
      // First aircraft load, not a change - skip reset
      Debug.log('aircraft', 'Initial aircraft load, skipping state reset', { title });
      return;
    }
    if (title && previousTitle && title === previousTitle) {
      Debug.log('aircraft', 'Aircraft identity unchanged - skipping transient state reset', { title });
      return;
    }
    
    Debug.log('aircraft', 'Aircraft changed - resetting transient state', {
      from: previousTitle,
      to: title,
    });
    
    try {
      // Reset scoring state (stability windows, etc.)
      resetStability();
      
      // Reset landing runner state (prevents stale WOW/touchdown data across flights)
      // Guard: do NOT reset if a rollout is in progress — the aircraft polling fires
      // every 2 seconds and can trigger a spurious title change event during the 20-second
      // rollout window, which would discard the in-flight landing:final computation.
      if (!landingRunner.isRolloutActive()) {
        landingRunner.reset();
        currentApproachScorer = null;
        currentApproachScoringInputs = null;
      } else {
        Debug.log('landing', 'Preserved landing and approach scorer context on aircraft change (rollout active)');
      }

      // Reset flight violation runner (clears any in-progress upset state)
      flightViolationRunner.reset();
      convectiveRiskRunner.reset();

      // Reset phase detection state (prevents carryover of flight phase from old aircraft)
      try {
        const { resetPhaseRunner } = require('../lifecycle/phase-runner');
        resetPhaseRunner();
      } catch {}
      
      // Reset change-detection sentinels for flaps, gear, and spoilers.
      // These only gate the `changed` flag in the payload (broadcasts fire every tick
      // regardless), but resetting ensures the first tick after an aircraft change
      // correctly emits changed:true — important for event-log consumers that record
      // the "initial state" of a new aircraft on the first transition.
      //
      // NOTE: if you add new delta-broadcast sentinels in the main telemetry loop,
      // reset them here too to keep aircraft-change behaviour consistent.
      resetSimbridgeBroadcastState(runtimeState);

      console.log('[aircraft] State reset complete after aircraft change');
    } catch (e) {
      Debug.log('aircraft', 'State reset failed', { error: e.message });
    }
  });

  // Flight data goes to the resolved Flight Fabric logs folder.
  if (!capabilities.isMock) {
    console.log('[simbridge:init] Flight events: using a synchronized CSV + two-JSONL recording bundle');
  } else {
    console.log('[simbridge:init] Flight events: DISABLED (mock mode)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Touchdown screen shake — fires at the moment of wheel contact.
  // Fires EYEPOINT_DOWN / EYEPOINT_UP key events via transmitClientEvent on
  // touchdown to produce a V/S-scaled cockpit jolt. Key events are fully
  // supported from external SimConnect clients (unlike SimVar writes).
  // ═══════════════════════════════════════════════════════════════════════════
  if (!capabilities.isMock && config.touchdownShake.enable && typeof provider.triggerTouchdownShake === 'function') {
    eventBus.on('landing:early', (payload) => {
      if (!payload) return;
      console.log(`[TouchdownShake] landing:early received, vs_fpm=${payload.vs_fpm}`);
      try {
        provider.triggerTouchdownShake(payload.vs_fpm);
      } catch (e) {
        console.warn('[TouchdownShake] shake trigger failed:', e.message);
      }
    });
  } else {
    console.log(`[TouchdownShake] Not subscribing: isMock=${capabilities.isMock}, enabled=${config.touchdownShake.enable}, hasTriggerFn=${typeof provider.triggerTouchdownShake === 'function'}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Subscribe to landing events for CSV
  // Write LANDING rows to the authoritative flight CSV.
  // ═══════════════════════════════════════════════════════════════════════════
  const recordingBundleGuard = {
    isOwnedCsvPath: (csvPath: unknown) => recordingBundleLifecycle.isOwnedRecordingBundleCsvPath(csvPath),
    isFinalizing: () => Boolean(recordingBundleLifecycle.getFinalizingRecordingBundle?.()),
    isBusy: () => Boolean(recordingBundleLifecycle.getStartingRecordingBundle?.()),
    getActiveCsvPath: () => (
      recordingBundleLifecycle.getActiveRecordingBundle()?.csvPath
      || recordingBundleLifecycle.getStartingRecordingBundle?.()?.csvPath
      || recordingBundleLifecycle.getFinalizingRecordingBundle?.()?.csvPath
      || null
    ),
    async flushActiveBundle(): Promise<boolean> {
      if (recordingBundleLifecycle.getFinalizingRecordingBundle?.()) return false;
      const activeBundle = recordingBundleLifecycle.getActiveRecordingBundle();
      if (!activeBundle) return true;
      try {
        const stats = [
          flightCsvWriter.getStats?.(),
          automationJsonlRecorder.getStats?.(),
          aircraftSpecificJsonlRecorder.getStats?.(),
        ];
        if (stats.some((entry) => (
          entry?.recordingSessionId !== activeBundle.recordingSessionId
          || entry?.flightId !== activeBundle.flightId
          || entry?.recordingStartEpochMs !== activeBundle.recordingStartEpochMs
          || entry?.recordingStartIso !== activeBundle.recordingStartIso
          || entry?.bundleBaseName !== activeBundle.baseName
          || entry?.hasError === true
          || entry?.captureDisabled === true
        ))) return false;
        const results = await Promise.all([
          flightCsvWriter.flush(),
          automationJsonlRecorder.flush(),
          aircraftSpecificJsonlRecorder.flush(),
        ]);
        if (!results.every((result) => result !== false)) return false;
        if (recordingBundleLifecycle.getFinalizingRecordingBundle?.()) {
          return false;
        }
        const afterFlushBundle = recordingBundleLifecycle.getActiveRecordingBundle();
        if (
          !afterFlushBundle
          || afterFlushBundle.recordingSessionId !== activeBundle.recordingSessionId
          || afterFlushBundle.baseName !== activeBundle.baseName
          || afterFlushBundle.degradedReason
        ) return false;
        const afterStats = [
          flightCsvWriter.getStats?.(),
          automationJsonlRecorder.getStats?.(),
          aircraftSpecificJsonlRecorder.getStats?.(),
        ];
        return afterStats.every((entry) => (
          entry?.recordingSessionId === afterFlushBundle.recordingSessionId
          && entry?.flightId === afterFlushBundle.flightId
          && entry?.recordingStartEpochMs === afterFlushBundle.recordingStartEpochMs
          && entry?.recordingStartIso === afterFlushBundle.recordingStartIso
          && entry?.bundleBaseName === afterFlushBundle.baseName
          && entry?.hasError !== true
          && entry?.captureDisabled !== true
        ));
      } catch {
        return false;
      }
    },
  };
  flightCsvStore = createFlightCsvStore({ flightCsvWriter, recordingBundleGuard, Debug });
  if (!capabilities.isMock) {
    eventBus.on('landing:final', (payload) => {
      if (!payload) return;
      
      console.log(`[landing] landing:final received — vs=${payload.vs_fpm} fpm, grade=${payload.grade}, icao=${payload.icao}, runway=${payload.runway}, tdz_ft=${payload.touchdown_distance_ft}, tdz_grade=${payload.touchdown_distance_grade}`);
      // The scorer and these inputs are one approach-scoped unit. The payload
      // fallback also resolves its recorded profile explicitly; neither path
      // consults whichever aircraft happens to be selected after touchdown.
      const landingStabilityScoringInputs = currentApproachScoringInputs
        || resolveRecordedStabilityScoringInputs(payload.aircraft_profile_id);
      let landingCsvReady = Promise.resolve(false);
      let landingCsvReadPath = null;
      let currentApproachScorePayload: AnyRecord | null = null;

      // Score the in-memory current-approach buffer before writing the LANDING
      // row so `ultimate_stability_*` fields are available in the CSV/logbook,
      // not just in the immediate frontend broadcast.
      try {
        if (currentApproachScorer && !currentApproachScorer.hasScored) {
          const {
            thresholdElevFt,
            runwayReferenceElevationSource,
            runwayReferenceElevationKind,
            runwayHdg,
            runwayWidthFt,
            runwayLengthFt,
            runwayThreshold,
            runwayId,
            airportIcao,
          } = resolveLandingGeometryScoringInputs(payload);
          const glidepathAngle = resolveGlidepathAngleForApproach({
            airportIcao,
            runwayId: runwayId || payload.runway,
          });
          const scoringInputs = landingStabilityScoringInputs;

          const stabScore = currentApproachScorer.getScore(thresholdElevFt, {
            lateralOffsetFt: Number.isFinite(payload.lateral_offset_ft) ? payload.lateral_offset_ft : null,
            runwayWidthFt,
            lateralOffsetSuspect: payload.lateral_offset_suspect === true || payload.lateral_offset_suspect === 1,
            airportIcao,
            runwayId: runwayId || payload.runway || null,
            criteria: scoringInputs.criteria,
          });
          const scoringContext = buildStabilityScoringContext({
            scoreResult: stabScore,
            profile: scoringInputs.profile,
            glidepathAngle,
            policy: scoringInputs.policy,
          });
          const approachProfile = currentApproachScorer.getApproachProfile(120);
          currentApproachScorer = null; // consumed — prevent accidental re-use

          currentApproachScoringInputs = null;
          const breakdown = stabScore.breakdown || {};
          const pct = (key: string): number | null => Number.isFinite(breakdown[key]) ? breakdown[key] : null;
          Object.assign(payload, {
            ultimate_stability_score: stabScore.score,
            ultimate_stability_verdict: stabScore.verdict,
            ultimate_stability_samples: stabScore.samples,
            ultimate_stability_gate_stable: stabScore.gateStable,
            ultimate_stability_gate_failures: stabScore.gateFailures,
            ultimate_stability_breakdown: breakdown,
            ultimate_stability_context: scoringContext,
            ultimate_stability_gear_ok_pct: pct('gear_ok'),
            ultimate_stability_flaps_ok_pct: pct('flaps_ok'),
            ultimate_stability_spoilers_ok_pct: pct('spoilers_ok'),
            ultimate_stability_config_ok_pct: pct('config_ok'),
            ultimate_stability_speed_ok_pct: pct('speed_ok'),
            ultimate_stability_speed_trend_ok_pct: pct('speed_trend_ok'),
            ultimate_stability_vs_ok_pct: pct('vs_ok'),
            ultimate_stability_glidepath_ok_pct: pct('glidepath_ok'),
            ultimate_stability_glidepath_below_ok_pct: pct('glidepath_below_ok'),
            ultimate_stability_glidepath_above_ok_pct: pct('glidepath_above_ok'),
            ultimate_stability_thrust_ok_pct: pct('thrust_ok'),
            ultimate_stability_thrust_not_idle_ok_pct: pct('thrust_not_idle_ok'),
            ultimate_stability_thrust_stable_ok_pct: pct('thrust_stable_ok'),
            ultimate_stability_pitch_ok_pct: pct('pitch_ok'),
            ultimate_stability_bank_ok_pct: pct('bank_ok'),
            ultimate_stability_lateral_offset_ok_pct: pct('lateral_offset_ok'),
          });

          currentApproachScorePayload = {
            stabScore,
            approachProfile,
            // Compatibility name: the resolved value can describe the whole
            // runway or airport rather than a surveyed individual threshold.
            thresholdElevFt,
            runwayReferenceElevationSource,
            runwayReferenceElevationKind,
            runwayHdg,
            runwayWidthFt,
            runwayLengthFt,
            runwayThreshold,
            runwayId,
            glidepathAngle,
            scoringContext,
          };
        }
      } catch (e) {
        console.error('[landing] Current approach stability score failed before CSV write:', e.message);
      }
      
      try {
        if (!recordingBundleFailureHandling && flightCsvWriter.isRecording()) {
          const csvStatsBeforeLanding = flightCsvWriter.getStats();
          landingCsvReadPath = csvStatsBeforeLanding?.filePath || null;
          // Pass full landing payload to CSV writer for complete record
          // The payload from buildLandingPayload includes all fields needed for analysis
          const writeOk = flightCsvWriter.writeEvent('LANDING', {
            ...buildLandingCsvEventData(payload, createEventId('landing')),
            // Core metrics
            vs: payload.vs_fpm,
            gforce: payload.gforce,
            ias_kts: payload.ias_kts,
            gs_kts: payload.gs_kts,
            grade: payload.grade,
            // Location
            icao: payload.icao,
            runway: payload.runway,
            lat_deg: payload.lat_deg,
            lon_deg: payload.lon_deg,
            alt_msl_ft: payload.alt_msl_ft,
            ra_ft: payload.ra_ft,
            hdg_true_deg: payload.hdg_true_deg,
            hdg_mag_deg: payload.hdg_mag_deg,
            // Touchdown distance + scoring (authoritative — from landing-runner rollout calculation)
            touchdown_distance_ft: payload.touchdown_distance_ft,
            touchdown_distance_score: payload.touchdown_distance_score,
            touchdown_distance_grade: payload.touchdown_distance_grade,
            runway_length_ft: payload.runway_length_ft,
            // Bounce scoring
            bounce_count: payload.bounce_count,
            bounce_grade: payload.bounce_grade,
            bounce_score: payload.bounce_score,
            bounce_distance_ft: payload.bounce_distance_ft,
            bounce_worst_gforce: payload.bounce_worst_gforce,
            // Timestamps
            timestamp_ms: payload.timestamp_ms,
            timestamp_utc: payload.timestamp_utc,
            // Weather
            wind_speed_kts: payload.wind_speed_kts,
            wind_dir_deg: payload.wind_dir_deg,
            xwind_kts: payload.xwind_kts,
            fdm_surface_condition: payload.fdm_surface_condition,
            fdm_precip_state: payload.fdm_precip_state,
            fdm_precip_rate_mm: payload.fdm_precip_rate_mm,
            fdm_oat_c: payload.fdm_oat_c,
            // Attitude
            pitch_deg: payload.pitch_deg,
            bank_deg: payload.bank_deg,
            // Config
            flaps_notch: payload.flaps_notch,
            spoiler_state: payload.spoiler_state,
            // Ultimate stability (retrospective)
            ultimate_stability_score: payload.ultimate_stability_score,
            ultimate_stability_verdict: payload.ultimate_stability_verdict,
            ultimate_stability_samples: payload.ultimate_stability_samples,
            ultimate_stability_gate_stable: payload.ultimate_stability_gate_stable,
            ultimate_stability_gate_failures: payload.ultimate_stability_gate_failures,
            ultimate_stability_breakdown: payload.ultimate_stability_breakdown,
            ultimate_stability_context: payload.ultimate_stability_context,
            ultimate_stability_gear_ok_pct: payload.ultimate_stability_gear_ok_pct,
            ultimate_stability_flaps_ok_pct: payload.ultimate_stability_flaps_ok_pct,
            ultimate_stability_spoilers_ok_pct: payload.ultimate_stability_spoilers_ok_pct,
            ultimate_stability_config_ok_pct: payload.ultimate_stability_config_ok_pct,
            ultimate_stability_speed_ok_pct: payload.ultimate_stability_speed_ok_pct,
            ultimate_stability_speed_trend_ok_pct: payload.ultimate_stability_speed_trend_ok_pct,
            ultimate_stability_vs_ok_pct: payload.ultimate_stability_vs_ok_pct,
            ultimate_stability_glidepath_ok_pct: payload.ultimate_stability_glidepath_ok_pct,
            ultimate_stability_glidepath_below_ok_pct: payload.ultimate_stability_glidepath_below_ok_pct,
            ultimate_stability_glidepath_above_ok_pct: payload.ultimate_stability_glidepath_above_ok_pct,
            ultimate_stability_thrust_ok_pct: payload.ultimate_stability_thrust_ok_pct,
            ultimate_stability_thrust_not_idle_ok_pct: payload.ultimate_stability_thrust_not_idle_ok_pct,
            ultimate_stability_thrust_stable_ok_pct: payload.ultimate_stability_thrust_stable_ok_pct,
            ultimate_stability_pitch_ok_pct: payload.ultimate_stability_pitch_ok_pct,
            ultimate_stability_bank_ok_pct: payload.ultimate_stability_bank_ok_pct,
            ultimate_stability_lateral_offset_ok_pct: payload.ultimate_stability_lateral_offset_ok_pct,
          });
          
          if (writeOk) {
            console.log(`[landing] LANDING row written to CSV — icao=${payload.icao}, runway=${payload.runway}, tdz_ft=${payload.touchdown_distance_ft}, geometry=${payload.runway_geometry_source || 'none'}`);
          } else {
            console.warn('[landing] LANDING row write returned false (check for earlier event write error)');
          }
          
          // The shared basename is immutable for the lifetime of a recording.
          // Route data remains in the LANDING row; avoiding live multi-file
          // renames means a process crash can never split the three artifacts.
          if (writeOk) {
            landingCsvReady = recordingBundleGuard.flushActiveBundle().then((flushed) => {
              const currentStats = flightCsvWriter.getStats();
              landingCsvReadPath = currentStats?.filePath || landingCsvReadPath;
              return flushed;
            }).catch(e => {
              console.warn('[flight] Recording bundle flush failed before landing summary:', e.message);
              return false;
            });
          }
        } else {
          console.warn('[landing] landing:final received but CSV is not recording — LANDING row will NOT be written');
        }
      } catch (e) {
        console.error('[flight-csv] Landing event write failed:', e.message);
      }

      // Persist to local flight logbook
      try {
        flightLogbook.addEntry(payload);
      } catch (e) {
        console.error('[logbook] Landing entry write failed:', e.message);
      }

      // ── Broadcast full-flight summary (violations, altitude, duration) ────
      // Read the current CSV to extract in-flight events so the landing card
      // PNG (and later the server share) can show more than just the landing.
      landingCsvReady.then(() => {
        try {
          const csvStats = flightCsvWriter.getStats();
          const csvFilePath = csvStats?.filePath || landingCsvReadPath;
          if (csvFilePath) {
            const { readFlightSummary } = require('../flight-recording/read-flight-summary');
            const summary = readFlightSummary(csvFilePath);
            if (summary) {
              summary.departure_icao = payload.departure_icao || null;
              summary.arrival_icao   = payload.icao           || null;
              summary.aircraft       = payload.aircraft       || null;
              broadcast({ type: MSG.FLIGHT_SUMMARY, ...summary });
              Debug.log('landing', 'flightSummary broadcast', {
                violations: summary.violations.length,
                go_arounds: summary.go_around_count,
                max_alt_ft: summary.max_alt_ft,
              });
            }
          }
        } catch (e) {
          console.error('[landing] Flight summary broadcast failed:', e.message);
        }
      }).catch(e => {
        console.error('[landing] Flight summary broadcast failed:', e.message);
      });

      // ── Compute current-approach stability and broadcast to frontend ──────
      // This is not a continuous per-tick scorer. It is an in-memory retrospective
      // buffer for the current approach, scored once at landing so the popup can
      // render immediately. The CSV-replay path remains authoritative for
      // historical/timeline views.
      try {
        if (currentApproachScorePayload) {
          const {
            stabScore,
            approachProfile,
            thresholdElevFt,
            runwayReferenceElevationSource,
            runwayReferenceElevationKind,
            runwayHdg,
            runwayWidthFt,
            runwayLengthFt,
            runwayThreshold,
            runwayId,
            glidepathAngle,
            scoringContext,
          } = currentApproachScorePayload;
          publishCurrentApproachStabilityStatus({
            state: 'scored',
            event: 'landing_scored',
            reason: 'landing_final',
            sampleCount: stabScore.samples,
            hasScored: true,
            scorerPresent: false,
            score: stabScore.score,
            gateStable: stabScore.gateStable,
            gateFailures: stabScore.gateFailures,
          }, { force: true });
          broadcast({
            type: MSG.ULTIMATE_STABILITY_SCORE,
            score: stabScore.score,
            verdict: stabScore.verdict,
            breakdown: stabScore.breakdown,
            samples: stabScore.samples,
            gateStable: stabScore.gateStable,
            gateFailures: stabScore.gateFailures,
            scoringContext,
            approachProfile,
            runwayReferenceElevFt: thresholdElevFt,
            runwayReferenceElevationSource,
            runwayReferenceElevationKind,
            thresholdElevFt,
            runwayHdg,
            runwayWidthFt,
            runwayLengthFt,
            runwayThreshold,
            runwayId,
            glidepathAngle,
          });
          Debug.log('landing', 'Current approach ultimateStabilityScore broadcast', {
            score: stabScore.score,
            samples: stabScore.samples,
            gateStable: stabScore.gateStable,
            approachProfilePoints: approachProfile.length,
          });
        } else if (currentApproachScorer && !currentApproachScorer.hasScored) {
          // Resolve the runway elevation reference FIRST so the scorer uses
          // runway-relative height for gate detection (fixes high-elevation
          // and terrain-heavy airports where raFt diverges from HAT).
          // Also resolve runway geometry for the top-down renderer.
          // Mirrors the CSV-replay path in timeline-generator.js.
          const {
            thresholdElevFt,
            runwayReferenceElevationSource,
            runwayReferenceElevationKind,
            runwayHdg,
            runwayWidthFt,
            runwayLengthFt,
            runwayThreshold,
            runwayId,
            airportIcao,
          } = resolveLandingGeometryScoringInputs(payload);
          const glidepathAngle = resolveGlidepathAngleForApproach({
            airportIcao,
            runwayId: runwayId || payload.runway,
          });
          const scoringInputs = landingStabilityScoringInputs;
          const stabScore = currentApproachScorer.getScore(thresholdElevFt, {
            lateralOffsetFt: Number.isFinite(payload.lateral_offset_ft) ? payload.lateral_offset_ft : null,
            runwayWidthFt,
            lateralOffsetSuspect: payload.lateral_offset_suspect === true || payload.lateral_offset_suspect === 1,
            airportIcao,
            runwayId: runwayId || payload.runway || null,
            criteria: scoringInputs.criteria,
          });
          const scoringContext = buildStabilityScoringContext({
            scoreResult: stabScore,
            profile: scoringInputs.profile,
            glidepathAngle,
            policy: scoringInputs.policy,
          });
          const approachProfile = currentApproachScorer.getApproachProfile(120);
          currentApproachScorer = null; // consumed — prevent accidental re-use
          currentApproachScoringInputs = null;
          publishCurrentApproachStabilityStatus({
            state: 'scored',
            event: 'landing_scored',
            reason: 'landing_final',
            sampleCount: stabScore.samples,
            hasScored: true,
            scorerPresent: false,
            score: stabScore.score,
            gateStable: stabScore.gateStable,
            gateFailures: stabScore.gateFailures,
          }, { force: true });
          broadcast({
            type: MSG.ULTIMATE_STABILITY_SCORE,
            score: stabScore.score,
            verdict: stabScore.verdict,
            breakdown: stabScore.breakdown,
            samples: stabScore.samples,
            gateStable: stabScore.gateStable,
            gateFailures: stabScore.gateFailures,
            scoringContext,
            approachProfile,
            runwayReferenceElevFt: thresholdElevFt,
            runwayReferenceElevationSource,
            runwayReferenceElevationKind,
            thresholdElevFt,
            runwayHdg,
            runwayWidthFt,
            runwayLengthFt,
            runwayThreshold,
            runwayId,
            glidepathAngle,
          });
          Debug.log('landing', 'Current approach ultimateStabilityScore broadcast', {
            score: stabScore.score,
            samples: stabScore.samples,
            gateStable: stabScore.gateStable,
            approachProfilePoints: approachProfile.length,
          });
        }
      } catch (e) {
        console.error('[landing] Current approach stability score broadcast failed:', e.message);
      }
    });
    
    // Subscribe to go-around events
    eventBus.on('phase:goAround', (payload) => {
      // Reset stability scoring for the new approach.
      // The previous approach's stability data is invalid for the new attempt.
      // This ensures the simmer gets fresh scoring on their next approach.
      try {
        currentApproachScorer = resetGoAroundScoringState({
          resetStability,
          landingRunner,
          createCurrentApproachScorer,
        });
        publishCurrentApproachStabilityStatus({
          state: 'reset',
          event: 'go_around_reset',
          reason: 'go_around',
          sampleCount: 0,
          phase: PHASES.GO_AROUND,
          raFt: payload?.altitude_ft,
          vsFpm: payload?.vs_fpm,
        }, { force: true });
        Debug.log('stability', 'Stability reset on go-around', {
          aircraft: payload?.aircraft,
          altitude_ft: payload?.altitude_ft,
          previous_phase: payload?.previous_phase,
        });
      } catch (e) {
        console.error('[stability] Reset on go-around failed:', e.message);
      }
      
      // Write to flight CSV
      try {
        if (!recordingBundleFailureHandling && flightCsvWriter.isRecording()) {
          const goAroundTs = timeSource.now();
          flightCsvWriter.writeEvent('GO_AROUND', {
            event_id: createEventId('goaround', goAroundTs),
            icao: payload?.icao,
            runway: payload?.runway,
            altitude_ft: payload?.altitude_ft,
            ias_kts: payload?.ias_kts,
            vs_fpm: payload?.vs_fpm,
            previous_phase: payload?.previous_phase,
            timestamp_ms: goAroundTs,
            timestamp_utc: isoFromMs(goAroundTs),
          });
        }
      } catch (e) {
        console.error('[flight-csv] Go-around event write failed:', e.message);
      }
    });
    
    console.log('[simbridge:init] Flight CSV event subscriptions: initialized');
  }

  // Initialize warning event broadcasting
  try {
    const { MSG } = require('./message-types');
    
    // ═════════════════════════════════════════════════════════════════════════
    // OVERSPEED / STALL WARNING EVENTS
    // Broadcast to frontend when aircraft warnings activate/deactivate
    // ═════════════════════════════════════════════════════════════════════════
    // Track overspeed state for duration calculation
    let overspeedStartTime = null;
    
    eventBus.on('sim:overspeed', (data) => {
      const overspeedMsg = {
        type: MSG.OVERSPEED,
        timestamp: data.timestamp,
        active: data.active,
        ias: data.ias,
        overspeedType: data.overspeedType,  // 'vfe' (flap limit) or 'vmo' (aircraft limit)
        barberPoleKts: data.barberPoleKts,
        flapsPercent: data.flapsPercent,
      };
      broadcast(overspeedMsg);
      
      // Write to flight CSV (critical safety event)
      if (data.active) {
        overspeedStartTime = timeSource.now();
        const typeLabel = data.overspeedType === 'vfe' ? 'VFE (flap limit)' : 'VMO/MMO';
        console.log(`⚠️  OVERSPEED: Exceeding ${typeLabel} at ${data.ias?.toFixed(0) ?? '?'}kts (limit: ${data.barberPoleKts?.toFixed(0) ?? '?'}kts)`);
        
        // Record START of overspeed violation
        if (!recordingBundleFailureHandling && flightCsvWriter.isRecording()) {
          const nowMs = timeSource.now();
          flightCsvWriter.writeEvent('OVERSPEED', {
            event_id: `overspeed-${nowMs}`,
            warning_type: data.overspeedType === 'vfe' ? 'VFE' : 'VMO',
            warning_active: true,
            overspeed_type: data.overspeedType,
            barber_pole_kts: data.barberPoleKts,
            ias_kts: data.ias,
            flaps_percent: data.flapsPercent,
            timestamp_ms: nowMs,
            timestamp_utc: data.timestamp,
          });
        }
      } else if (overspeedStartTime) {
        // Record END of overspeed violation with duration
        const nowMs = timeSource.now();
        const durationMs = nowMs - overspeedStartTime;
        console.log(`✓  Overspeed cleared (duration: ${(durationMs / 1000).toFixed(1)}s)`);
        
        if (!recordingBundleFailureHandling && flightCsvWriter.isRecording()) {
          flightCsvWriter.writeEvent('OVERSPEED_END', {
            event_id: `overspeed-end-${nowMs}`,
            warning_type: 'OVERSPEED_END',
            warning_active: false,
            warning_duration_ms: durationMs,
            ias_kts: data.ias,
            timestamp_ms: nowMs,
            timestamp_utc: data.timestamp,
          });
        }
        overspeedStartTime = null;
      }
    });
    
    // Track stall state for duration calculation
    let stallStartTime = null;
    
    eventBus.on('sim:stall', (data) => {
      const stallMsg = {
        type: MSG.STALL,
        timestamp: data.timestamp,
        active: data.active,
        ias: data.ias,
      };
      broadcast(stallMsg);
      
      // Persist active stall warnings in the flight CSV.
      if (data.active) {
        stallStartTime = timeSource.now();
        console.log(`⚠️  STALL WARNING: Aircraft approaching stall at ${data.ias?.toFixed(0) ?? '?'}kts`);
        
        // Record START of stall warning
        if (!recordingBundleFailureHandling && flightCsvWriter.isRecording()) {
          const nowMs = timeSource.now();
          flightCsvWriter.writeEvent('STALL', {
            event_id: `stall-${nowMs}`,
            warning_type: 'STALL',
            warning_active: true,
            ias_kts: data.ias,
            timestamp_ms: nowMs,
            timestamp_utc: data.timestamp,
          });
        }
      } else if (stallStartTime) {
        // Record END of stall warning with duration
        const nowMs = timeSource.now();
        const durationMs = nowMs - stallStartTime;
        console.log(`✓  Stall warning cleared (duration: ${(durationMs / 1000).toFixed(1)}s)`);
        
        if (!recordingBundleFailureHandling && flightCsvWriter.isRecording()) {
          flightCsvWriter.writeEvent('STALL_END', {
            event_id: `stall-end-${nowMs}`,
            warning_type: 'STALL_END',
            warning_active: false,
            warning_duration_ms: durationMs,
            ias_kts: data.ias,
            timestamp_ms: nowMs,
            timestamp_utc: data.timestamp,
          });
        }
        stallStartTime = null;
      }
    });
    
    // ═════════════════════════════════════════════════════════════════════════
    // FUEL EXHAUSTION EVENT
    // Broadcast to frontend when fuel runs out
    // ═════════════════════════════════════════════════════════════════════════
    eventBus.on('sim:fuelExhausted', (data) => {
      const fuelMsg = {
        type: MSG.FUEL_EXHAUSTED,
        timestamp: data.timestamp,
        fuelGal: data.fuelGal,
        exhausted: data.exhausted,
      };
      broadcast(fuelMsg);
      console.log(`⛽ FUEL EXHAUSTED: Aircraft out of fuel (${data.fuelGal?.toFixed(2) ?? '0'} gal remaining)`);
    });
    
    // ═════════════════════════════════════════════════════════════════════════
    // CABIN ALTITUDE WARNING EVENT
    // Broadcast to frontend when cabin altitude exceeds safe limits
    // ═════════════════════════════════════════════════════════════════════════
    eventBus.on('sim:cabinAltitude', (data) => {
      const cabinMsg = {
        type: MSG.CABIN_ALTITUDE_WARNING,
        timestamp: data.timestamp,
        cabinAltFt: data.cabinAltFt,
        severity: data.severity,  // 'warning' (>10k), 'critical' (>14k), or null
        active: data.active,
      };
      broadcast(cabinMsg);
      if (data.active) {
        const level = data.severity === 'critical' ? '🔴 CRITICAL' : '🟡 WARNING';
        console.log(`⚠️  CABIN ALTITUDE ${level}: ${data.cabinAltFt} ft`);
      }
    });
    
    // ═════════════════════════════════════════════════════════════════════════
    // DISK EXHAUSTION EVENT
    // Broadcast to frontend when CSV recording fails due to disk space
    // ═════════════════════════════════════════════════════════════════════════
    eventBus.on('storage:diskExhausted', (data) => {
      const diskMsg = {
        type: MSG.DISK_WARNING,
        level: 'critical',
        message: data.message,
        fileName: typeof data.filePath === 'string' ? path.basename(data.filePath) : '',
        rowsWritten: data.rowsWritten,
      };
      broadcast(diskMsg);
      console.error(`💾 DISK EXHAUSTED: Recording stopped - ${data.rowsWritten} rows preserved`);
    });
    
  } catch (e) {
    console.warn('[simbridge] warning event init failed:', e.message);
  }

  // Start provider connections and wire provider broadcasts before start().
  if (typeof provider.setBroadcast === 'function') {
    provider.setBroadcast(createProviderBroadcastRelay({
      broadcast,
      buildControlCapabilities,
      getActiveProfile: () => profileLoader.getActiveProfile(),
      getActiveProfileRevision: () => profileLoader.getActiveProfileRevision?.(),
    }));
  }
  try {
    await Promise.all([wsListeningPromise, httpListeningPromise]);
    await provider.start();
  } catch (error) {
    // Startup is transactional. Several optional components start before the
    // telemetry provider so they can serve the first connected client; none of
    // them may survive a listener/provider failure. Reuse the all-settled
    // shutdown sequence so one broken stop cannot skip another owned handle.
    try {
      await runSimbridgeShutdownSequence({
        provider,
        historyIndexHandle: flightCsvStore,
        cabinAnnouncementsHandle,
        updateCheckerHandle,
        stopHandle,
        closeServersTask: () => Promise.all([
          closeWsServer(wss, 2000),
          closeHttpServer(httpServerHandle?.httpServer, 2000),
        ]),
      });
    } catch (cleanupError) {
      console.warn(
        '[simbridge] Startup rollback reported cleanup failures:',
        cleanupError?.message || String(cleanupError),
      );
    }
    throw error;
  }

  if (!isShutdownRequested(shutdownSignal)) {
    // Canonical readiness means both network listeners are bound and the
    // required telemetry provider completed its startup contract.
    console.log('[SIMBRIDGE_READY]');
  }

  console.log('[simbridge:init] Polling loop: start');

  // IAS TREND / PITCH-BANK RATE STATE
  let previousIAS = 0;
  let previousPitch = 0;
  let previousBank = 0;
  let streamingContinuityBroken = false;

  // Conservative flight end detection (avoids false positives from pause/AI takeover)
  // Flight ends when: (1) aircraft title changes, OR (2) SimConnect disconnects for >5s,
  // OR (3) the simulator stops while SimConnect stays open for >5s,
  // OR (4) parked with all engines off for PARKED_ENGINES_OFF_MS
  let flightEndGuardState = {
    lastSimconnectConnectedMs: null,
    simconnectDisconnectedSinceMs: null,
    simStoppedSinceMs: null,
    pendingReason: null,
  };
  let lastConsoleSimconnectConnected = null;

  // Parked + engines off detection state
  let parkedEnginesOffSinceMs = null;    // Timestamp when PARKED + all engines off started

  // Slew mode detection state
  let slewActiveSinceMs = null;          // Timestamp when slew mode started (null = not slewing)
  let slewSamplesSuppressed = 0;         // Count of samples suppressed during current slew

  // Flight end cooldown - prevents immediate re-start after a flight ends
  // This avoids spurious 1-sample flights when parked at destination
  let lastFlightEndMs = null;
  let manualAutoStartSuppression = {
    active: false,
    sinceMs: null,
    aircraftTitle: null,
    parkedResetSinceMs: null,
    contextResetSinceMs: null,
  };

  // Telemetry activity detection for menu state filtering
  let previousFrameForActivity = null;

  // Diagnostic throttles
  let lastSimStateBroadcastMs = 0;  // Throttle simState broadcasts to 1Hz
  let lastSimStateBroadcastSignature = '';

  // Flight lifecycle config (from centralized config.js)
  const FLIGHT_START_REQUIRE_COUNT = config.flightStart.requireCount;
  const FLIGHT_START_IAS_KTS = config.flightStart.iasKts;
  const FLIGHT_START_GS_KTS = config.flightStart.gsKts;
  const FLIGHT_START_RA_FT = config.flightStart.raFt;
  const FLIGHT_START_MAX_ALT_MSL_FT = config.flightStart.maxAltMslFt;
  const FLIGHT_START_REQUIRE_MOVEMENT = config.flightStart.requireMovement;
  const FLIGHT_START_MOVE_WINDOW_MS = config.flightStart.moveWindowMs;
  const FLIGHT_START_MOVE_IAS_DELTA_KTS = config.flightStart.moveIasDeltaKts;
  const FLIGHT_START_MOVE_GS_DELTA_KTS = config.flightStart.moveGsDeltaKts;
  const FLIGHT_START_REQUIRE_TELEMETRY_ACTIVITY = config.flightStart.requireTelemetryActivity;
  const FLIGHT_START_MIN_ACTIVE_FIELDS = config.flightStart.minActiveFields;
  const SLEW_BLOCK_FLIGHT_START = config.slew.blockFlightStart;
  const SLEW_SUPPRESS_SAMPLES = config.slew.suppressSamples;
  const SLEW_AUTO_END_FLIGHT_MS = config.slew.autoEndFlightMs;
  const FLIGHT_LIFECYCLE_CONSOLE_LOG = config.debug.flightLifecycleConsoleLog;
  const FLIGHT_LIFECYCLE_CONSOLE_VERBOSE = config.debug.flightLifecycleConsoleVerbose;
  const FLIGHT_END_PARKED_ENGINES_OFF_MS = config.flightEnd.parkedEnginesOffMs;
  const FLIGHT_END_PARKED_ENGINES_OFF_ENABLE = config.flightEnd.parkedEnginesOffEnable;
  const STABILITY_HIGH_ALT_RESET_RA_FT = config.stability.highAltResetRaFt;
  const RECORDING_AUTO_START = config.recording?.autoStart !== false;
  const telemetryActivityThresholds = {
    gpsChangeThreshold: GPS_CHANGE_THRESHOLD,
    altitudeChangeThresholdFt: ALTITUDE_CHANGE_THRESHOLD_FT,
    headingChangeThresholdDeg: HEADING_CHANGE_THRESHOLD_DEG,
  };

  // Avoid probing on every telemetry tick; the guard also independently
  // throttles and de-duplicates checks as a second line of defense.
  let lastDiskCheckMs = 0;

  // Movement detector state (only used while flightActive=false)
  let motionBaseline = null; // { ts:number, ias:number, gs:number }

  // Globe view detection (MSFS 2024 menu at extreme altitude)
  let globeViewLogged = false;  // Prevent log spam when in globe view

  // ─── Current approach scorer ────────────────────────────────────────────────
  // In-memory retrospective buffer for the active approach only. It mirrors the
  // CSV-replay SimpleStabilityScorer so the landing popup can render immediately;
  // the CSV-replay path remains authoritative for historical/timeline views.
  const CURRENT_APPROACH_GATE_ALTITUDE_FT = 1000;
  const CURRENT_APPROACH_COLLECTION_CEILING_FT = 1500;
  let currentApproachScorer = null;
  // Captured together with the scorer. Post-touchdown profile/title changes
  // must never reconfigure the approach that the scorer already collected.
  let currentApproachScoringInputs: AnyRecord | null = null;
  const VRE_SAMPLING_STATUS_INTERVAL_MS = 1000;
  let lastVreSamplingStatusBroadcastMs = 0;
  let lastVreSamplingStatusSignature = '';
  let lastVreCsvWriteAttemptTs: number | null = null;

  function getCurrentApproachSampleCount() {
    if (!currentApproachScorer || typeof currentApproachScorer.getSampleCount !== 'function') return 0;
    return currentApproachScorer.getSampleCount();
  }

  function getActiveStabilityCriteria() {
    return getActiveStabilityScoringInputs().criteria;
  }

  function getActiveStabilityScoringInputs() {
    let profile = null;
    try {
      profile = profileLoader.getActiveProfile?.() || null;
    } catch (_e) {}
    let profileCriteria = null;
    try {
      profileCriteria = typeof profileLoader.getStabilityScoringCriteria === 'function'
        ? profileLoader.getStabilityScoringCriteria(profile)
        : null;
    } catch (_e) {}
    return snapshotStabilityScoringInputs({
      profile,
      commonCriteria: getStabilityCriteria(),
      profileCriteria,
    });
  }

  function getActiveStabilityGateAltitudeFt() {
    const criteria = getActiveStabilityCriteria();
    return Number.isFinite(criteria?.gateRaFt) ? criteria.gateRaFt : CURRENT_APPROACH_GATE_ALTITUDE_FT;
  }

  function getCurrentApproachCollectionCeilingFt() {
    const frozenGateRaFt = currentApproachScoringInputs?.criteria?.gateRaFt;
    const gateRaFt = Number.isFinite(frozenGateRaFt)
      ? frozenGateRaFt
      : getActiveStabilityGateAltitudeFt();
    return Math.max(CURRENT_APPROACH_COLLECTION_CEILING_FT, gateRaFt);
  }

  function createCurrentApproachScorer() {
    currentApproachScoringInputs = getActiveStabilityScoringInputs();
    const gateRaFt = Number.isFinite(currentApproachScoringInputs.criteria?.gateRaFt)
      ? currentApproachScoringInputs.criteria.gateRaFt
      : CURRENT_APPROACH_GATE_ALTITUDE_FT;
    return new SimpleStabilityScorer(gateRaFt);
  }

  function publishCurrentApproachStabilityStatus(_status: AnyRecord = {}, _options: { force?: boolean } = {}) {
    // Deliberately no-op: we keep the in-memory current-approach scorer only to
    // produce the retrospective landing score/profile, not a live approach monitor.
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VRE (Variable Rate Encoding) - Physics-driven sampling
  // Sample faster ONLY when aircraft dynamics demand it.
  // ═══════════════════════════════════════════════════════════════════════════
  function publishVreSamplingStatus(
    vreResult: AnyRecord | null = null,
    vreFrame: AnyRecord | null = null,
    options: { force?: boolean; active?: boolean; event?: string | null; pollRateMs?: number } = {},
  ) {
    const now = timeSource.now();
    const state = vreEvaluator.getState();
    const active = typeof options.active === 'boolean'
      ? options.active
      : (flightActive && !capabilities.isMock);
    const band = active && vreResult?.band ? vreResult.band : state.band;
    const evaluatorTargetRateHz = Number.isFinite(vreResult?.rateHz) ? vreResult.rateHz : state.rateHz;
    const {
      targetRateHz,
      effectiveRateHz,
      intervalMs,
    } = resolveVreSamplingRate(evaluatorTargetRateHz, options.pollRateMs ?? pollRateMs);
    // Backward-compatible alias: rateHz now reports the achievable logger rate.
    const rateHz = effectiveRateHz;
    const shouldSample = active && vreResult?.shouldSample === true;
    const reason = active
      ? (typeof vreResult?.escalationString === 'string' ? vreResult.escalationString : state.escalationString)
      : 'inactive';
    const escalationReasons = active
      ? (Number.isFinite(vreResult?.escalationReasons) ? vreResult.escalationReasons : state.escalationReasons)
      : 0;
    const lastSampleTs = Number.isFinite(state.lastSampleTs) ? state.lastSampleTs : null;
    const timeSinceLastSampleMs = active && lastSampleTs !== null
      ? Math.max(0, Math.round(now - lastSampleTs))
      : null;
    const nextSampleInMs = active && timeSinceLastSampleMs !== null
      ? Math.max(0, intervalMs - timeSinceLastSampleMs)
      : null;
    const phase = typeof vreFrame?.phase === 'string' ? vreFrame.phase : null;
    const raFt = Number.isFinite(vreFrame?.ra) ? vreFrame.ra : null;
    const vsFpm = Number.isFinite(vreFrame?.vs) ? vreFrame.vs : null;
    const ultraFidelityDisabled = state.ultraFidelityDisabled === true;
    const ultraFidelityTimeRemaining = Number.isFinite(state.ultraFidelityTimeRemaining)
      ? state.ultraFidelityTimeRemaining
      : 0;
    const ultraFidelitySamplesRemaining = Number.isFinite(state.ultraFidelitySamplesRemaining)
      ? state.ultraFidelitySamplesRemaining
      : 0;
    const event = options.event || null;
    const signature = [
      active,
      band,
      targetRateHz,
      effectiveRateHz,
      rateHz,
      reason,
      escalationReasons,
      phase,
      ultraFidelityDisabled,
      event,
    ].join('|');

    if (
      !options.force
      && signature === lastVreSamplingStatusSignature
      && now - lastVreSamplingStatusBroadcastMs < VRE_SAMPLING_STATUS_INTERVAL_MS
    ) {
      return;
    }

    lastVreSamplingStatusBroadcastMs = now;
    lastVreSamplingStatusSignature = signature;

    broadcast({
      type: MSG.VRE_SAMPLING,
      active,
      band,
      targetRateHz,
      effectiveRateHz,
      rateHz,
      shouldSample,
      reason,
      escalationReasons,
      phase,
      raFt,
      vsFpm,
      intervalMs,
      timeSinceLastSampleMs,
      nextSampleInMs,
      ultraFidelityDisabled,
      ultraFidelityTimeRemaining,
      ultraFidelitySamplesRemaining,
      event,
      timestamp_ms: now,
      timestamp_utc: isoFromMs(now),
    });
  }

  const vreEvaluator = createVreEvaluator({
    timeNow: () => timeSource.now(),
  });

  function clearManualAutoStartSuppression(reason = 'unknown') {
    if (manualAutoStartSuppression.active) {
      Debug.log('flight', 'Manual auto-start suppression cleared', { reason });
    }
    manualAutoStartSuppression = {
      active: false,
      sinceMs: null,
      aircraftTitle: null,
      parkedResetSinceMs: null,
      contextResetSinceMs: null,
    };
    motionBaseline = null;
  }

  function armManualAutoStartSuppression(nowEpochMs, reason = 'user_manual') {
    if (!RECORDING_AUTO_START || capabilities.isMock) return;
    manualAutoStartSuppression = {
      active: true,
      sinceMs: nowEpochMs,
      aircraftTitle: flightStartAircraftTitle || null,
      parkedResetSinceMs: null,
      contextResetSinceMs: null,
    };
    motionBaseline = null;
    Debug.log('flight', 'Manual auto-start suppression armed', {
      reason,
      aircraftTitle: manualAutoStartSuppression.aircraftTitle,
    });
  }

  function checkRecordingDiskFloorBeforeStart(
    reason = 'automatic',
    outputDir = flightCsvWriter.getDefaultFlightLogsDir(),
  ): AnyRecord {
    // Blocked decisions are cached briefly for both automatic and manual
    // attempts, so ENOSPC/EDQUOT and low-space failures cannot form a rapid
    // retry loop. Recovery is re-probed after that quiet period.
    const decision = recordingDiskGuard.checkBeforeStart(outputDir);
    if (decision.allowed) return decision;

    if (decision.newlyBlocked || (reason === 'user_manual' && !decision.cached)) {
      console.error(`[flight] Recording blocked by disk safety floor: ${decision.reason}`);
      broadcast({
        type: MSG.DISK_WARNING,
        level: 'critical',
        message: decision.reason,
        freeDiskGb: decision.checked ? decision.freeDiskGb : undefined,
        minFreeGb: decision.minFreeGb,
        resumeFreeGb: decision.minFreeGb + DISK_RESUME_MARGIN_GB,
      });
      broadcast({
        type: MSG.FLIGHT_RECORDING,
        status: 'failed',
        error: decision.reason,
      });
    }
    return decision;
  }

  async function publishFinalRecordingBundleStatus(
    bundle: AnyRecord | null,
    options: {
      healthy: boolean;
      finalizedAtEpochMs: number;
      endReason: string;
      degradedReason?: string;
    },
  ): Promise<'complete' | 'degraded' | 'incomplete'> {
    if (!bundle?.recordingSessionId || !bundle?.outputDir || !bundle?.baseName) return 'incomplete';
    const finalizedAtEpochMs = Math.max(
      Number(bundle.recordingStartEpochMs),
      Math.round(Number(options.finalizedAtEpochMs)),
    );
    const baseOptions = {
      flightId: bundle.flightId,
      recordingSessionId: bundle.recordingSessionId,
      recordingStartEpochMs: bundle.recordingStartEpochMs,
      recordingStartIso: bundle.recordingStartIso,
      outputDir: bundle.outputDir,
      bundleBaseName: bundle.baseName,
      finalizedAtEpochMs,
      finalizedAtIso: new Date(finalizedAtEpochMs).toISOString(),
      endReason: String(options.endReason || 'unknown'),
    };

    if (options.healthy) {
      try {
        await publishRecordingBundleStatus({ ...baseOptions, status: 'complete' });
        return 'complete';
      } catch (error) {
        recordingBundleLifecycle.markRecordingBundleDegraded(
          bundle.recordingSessionId,
          'bundle completion certificate failed',
        );
        console.error('[flight] Durable bundle completion status failed:', error?.message || String(error));
      }
    }

    try {
      await publishRecordingBundleStatus({
        ...baseOptions,
        status: 'degraded',
        // Persist a stable, path-free category. Detailed storage errors remain
        // in process logs and recorder stats, not in the on-disk certificate.
        degradedReason: options.degradedReason || 'recording member failed',
      });
      return 'degraded';
    } catch (error) {
      console.error('[flight] Durable degraded bundle status failed:', error?.message || String(error));
      return 'incomplete';
    }
  }

  function handleRecordingBundleTerminalError(recordingSessionId: string, error: unknown): void {
    const diskCapacityFailure = isDiskCapacityError(error);
    if (diskCapacityFailure) recordingDiskGuard.markDiskCapacityFailure();
    const ownedBundle = recordingBundleLifecycle.getActiveRecordingBundle()
      || recordingBundleLifecycle.getFinalizingRecordingBundle();
    if (!ownedBundle || ownedBundle.recordingSessionId !== recordingSessionId) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      pendingRecordingBundleStartupErrors.set(recordingSessionId, normalized);
      return;
    }
    recordingBundleLifecycle.markRecordingBundleDegraded(recordingSessionId, error);
    // A normal end/shutdown aggregate already owns all three close promises and
    // will publish the degraded certificate after they settle. Never start a
    // second close/status publisher from a member callback racing that owner.
    if (recordingBundleAggregateFinalizingSessionId === recordingSessionId) return;
    if (recordingBundleFailureHandling) return;
    recordingBundleFailureHandling = true;
    aircraftSpecificRecordingFinalizing = true;
    if ((error as { code?: unknown } | null)?.code === 'FF_LOW_DISK') {
      const lowDiskError = error as AnyRecord;
      broadcast({
        type: MSG.DISK_WARNING,
        level: 'critical',
        message: 'Flight recording stopped at the free disk safety floor.',
        freeDiskGb: Number.isFinite(lowDiskError.freeDiskGb) ? lowDiskError.freeDiskGb : undefined,
        minFreeGb: Number.isFinite(lowDiskError.minFreeGb) ? lowDiskError.minFreeGb : minFreeDiskGb,
        resumeFreeGb: minFreeDiskGb + DISK_RESUME_MARGIN_GB,
      });
    }
    broadcast({
      type: MSG.FLIGHT_RECORDING,
      status: 'error',
      error: diskCapacityFailure
        ? 'Flight recording stopped at the disk capacity safety limit; all recording files are closing'
        : 'A flight recording bundle member failed; all recorders are stopping',
      flightId,
      recordingSessionId,
    });
    const errorTimeMs = timeSource.now();
    const errorEndReason = diskCapacityFailure
      ? ((error as { code?: unknown } | null)?.code === 'FF_LOW_DISK'
        ? 'low_disk_safety_floor'
        : 'disk_capacity_error')
      : 'recording_bundle_error';
    const errorContext = {
      timeMs: errorTimeMs,
      timestampIso: new Date(errorTimeMs).toISOString(),
      flightElapsedMs: computeElapsedMs(errorTimeMs, flightRecordingStartEpochMs),
      flightId,
      flightStartIso: flightRecordingStartIso,
      aircraftTitle: flightStartAircraftTitle,
      endReason: errorEndReason,
      // A safety-floor or native capacity stop must only drain already
      // accepted bytes. Do not append final-checkpoint rows while closing.
      skipFinalCheckpoint: diskCapacityFailure,
    };
    try { recordingSession.markStopped(); } catch {}
    try { recordingBundleLifecycle.markRecordingBundleFinalizing(recordingSessionId); } catch {}
    flightRecordingStartEpochMs = null;
    flightRecordingStartIso = '';
    flightRecordingSessionId = '';
    aircraftSpecificStateProjector.reset();
    recorderFieldCatalogConfig = null;
    recorderFieldCatalog = [];
    queueMicrotask(() => {
      const finalizeAfterRoute = Promise.all([
        flightCsvWriter.endFlight().catch(() => null),
        automationJsonlRecorder.endFlight(errorContext).catch(() => null),
        aircraftSpecificJsonlRecorder.endFlight(errorContext).catch(() => null),
      ]).then(() => publishFinalRecordingBundleStatus(ownedBundle, {
        healthy: false,
        finalizedAtEpochMs: errorTimeMs,
        endReason: errorEndReason,
        degradedReason: diskCapacityFailure ? 'low disk safety stop' : 'recording member failed',
      }));
      const tracked = finalizeAfterRoute.finally(() => {
        try { recordingBundleLifecycle.finishRecordingBundle(recordingSessionId); } catch {}
        aircraftSpecificRecordingFinalizing = false;
        recordingBundleFailureHandling = false;
        if (activeFlightFinalizationPromise === tracked) activeFlightFinalizationPromise = null;
      });
      activeFlightFinalizationPromise = tracked;
      void tracked.catch((finalizeError) => {
        console.error('[flight] Recording bundle error finalization failed:', finalizeError?.message || String(finalizeError));
      });
    });
  }

  function startCsvRecordingForCurrentFlight(
    reason = 'automatic',
    options: { diskPreflightPassed?: boolean } = {},
  ) {
    if (capabilities.isMock) {
      return { success: false, error: 'Recording is unavailable in mock mode', reason, flightId };
    }

    if (flightCsvWriter.isRecording?.() === true) {
      const stats = flightCsvWriter.getStats?.();
      return {
        success: false,
        error: 'Recording is already active',
        reason,
        flightId: flightId || stats?.flightId || '',
        fileName: typeof stats?.filePath === 'string' ? path.basename(stats.filePath) : '',
      };
    }

    const startBlocker = getRecordingStartBlocker();
    if (startBlocker) {
      broadcast({
        type: MSG.FLIGHT_RECORDING,
        status: 'stopped',
        flightId,
      });
      return { success: false, error: startBlocker, reason, flightId };
    }

    const outputDir = flightCsvWriter.getDefaultFlightLogsDir();
    if (options.diskPreflightPassed !== true) {
      const diskDecision = checkRecordingDiskFloorBeforeStart(reason, outputDir);
      if (!diskDecision.allowed) {
        return { success: false, error: diskDecision.reason, reason, flightId };
      }
    }

    const recordingStartEpochMs = timeSource.now();
    const recordingStartIso = new Date(recordingStartEpochMs).toISOString();
    const recordingSessionId = crypto.randomUUID();
    const preferredBaseName = recordingBundleLayout.buildBundleName(recordingStartIso, recordingSessionId);
    let bundleBaseName = '';
    try {
      bundleBaseName = recordingBundleLifecycle.allocateBundleBaseName(outputDir, preferredBaseName);
    } catch (error) {
      return {
        success: false,
        error: 'Could not allocate a unique flight recording bundle',
        reason,
        flightId,
      };
    }
    const sharedRecorderOptions = {
      flightId,
      recordingSessionId,
      recordingStartEpochMs,
      recordingStartIso,
      bundleBaseName,
      bundleStatusRequired: true,
      outputDir,
      onTerminalError: (error: Error) => handleRecordingBundleTerminalError(recordingSessionId, error),
    };
    try {
      recordingBundleLifecycle.beginRecordingBundleStartup({
        recordingSessionId,
        flightId,
        recordingStartEpochMs,
        recordingStartIso,
        outputDir,
        baseName: bundleBaseName,
        csvPath: recordingBundleLayout.getBundlePaths(outputDir, bundleBaseName).csv,
      });
    } catch (error) {
      return {
        success: false,
        error: 'Failed to reserve flight recording bundle startup ownership',
        reason,
        flightId,
      };
    }
    const clearFailedStartupState = () => {
      if (!flightRecordingSessionId || flightRecordingSessionId === recordingSessionId) {
        flightRecordingStartEpochMs = null;
        flightRecordingStartIso = '';
        flightRecordingSessionId = '';
      }
      pendingRecordingBundleStartupErrors.delete(recordingSessionId);
      recordingBundleFailureHandling = false;
      aircraftSpecificStateProjector.reset();
      recorderFieldCatalogConfig = null;
      recorderFieldCatalog = [];
    };
    let writer = null;
    try {
      writer = flightCsvWriter.startFlight(sharedRecorderOptions);
    } catch (error) {
      clearFailedStartupState();
      try { recordingBundleLifecycle.finishRecordingBundleStartup(recordingSessionId); } catch {}
      console.error('[flight] Flight CSV writer threw during bundle startup:', error?.message || String(error));
      broadcast({
        type: MSG.FLIGHT_RECORDING,
        status: 'failed',
        error: 'Failed to start recording',
      });
      return { success: false, error: 'Failed to start recording', reason, flightId };
    }
    if (writer) {
      flightRecordingStartEpochMs = recordingStartEpochMs;
      flightRecordingStartIso = recordingStartIso;
      flightRecordingSessionId = recordingSessionId;
      aircraftSpecificRecordingFinalizing = false;

      const stats = flightCsvWriter.getStats();
      let automationWriter = null;
      try {
        automationWriter = automationJsonlRecorder.startFlight(sharedRecorderOptions);
      } catch (err) {
        console.warn('[automation-jsonl] Autopilot automation sidecar start failed:', err?.message || String(err));
      }

      let aircraftSpecificWriter = null;
      try {
        aircraftSpecificWriter = aircraftSpecificJsonlRecorder.startFlight(sharedRecorderOptions);
      } catch (err) {
        console.warn('[aircraft-specific-jsonl] Aircraft-specific sidecar start failed:', err?.message || String(err));
      }

      const startupMemberStats = [
        flightCsvWriter.getStats?.(),
        automationJsonlRecorder.getStats?.(),
        aircraftSpecificJsonlRecorder.getStats?.(),
      ];
      if (
        !automationWriter
        || !aircraftSpecificWriter
        || pendingRecordingBundleStartupErrors.has(recordingSessionId)
        || startupMemberStats.some((entry) => (
          entry?.recordingSessionId !== recordingSessionId
          || entry?.flightId !== flightId
          || entry?.recordingStartEpochMs !== recordingStartEpochMs
          || entry?.recordingStartIso !== recordingStartIso
          || entry?.bundleBaseName !== bundleBaseName
          || entry?.bundleStatusRequired !== true
          || entry?.hasError === true
          || entry?.captureDisabled === true
        ))
      ) {
        clearFailedStartupState();
        aircraftSpecificRecordingFinalizing = true;
        const rollback = Promise.all([
          flightCsvWriter.endFlight().catch(() => null),
          automationWriter ? automationJsonlRecorder.endFlight({ endReason: 'bundle_start_failed' }).catch(() => null) : null,
          aircraftSpecificWriter
            ? aircraftSpecificJsonlRecorder.endFlight({ endReason: 'bundle_start_failed' }).catch(() => null)
            : null,
        ]).then((artifacts) => {
          try {
            recordingBundleLifecycle.discardUncommittedBundle(outputDir, bundleBaseName, artifacts);
          } catch (error) {
            console.warn('[flight] Could not clean up an uncommitted recording bundle:', error?.message || String(error));
          }
          return artifacts;
        }).finally(() => {
          try { recordingBundleLifecycle.finishRecordingBundleStartup(recordingSessionId); } catch {}
          aircraftSpecificRecordingFinalizing = false;
          if (activeFlightFinalizationPromise === rollback) activeFlightFinalizationPromise = null;
        });
        activeFlightFinalizationPromise = rollback;
        broadcast({
          type: MSG.FLIGHT_RECORDING,
          status: 'failed',
          error: 'Failed to start the complete flight recording bundle',
        });
        return {
          success: false,
          error: 'Failed to start the complete flight recording bundle',
          reason,
          flightId,
        };
      }

      try {
        recordingBundleLifecycle.commitRecordingBundleStartup(recordingSessionId);
      } catch (error) {
        console.error('[flight] Recording bundle ownership failed:', error?.message || String(error));
        clearFailedStartupState();
        aircraftSpecificRecordingFinalizing = true;
        const rollback = Promise.all([
          flightCsvWriter.endFlight().catch(() => null),
          automationJsonlRecorder.endFlight({ endReason: 'bundle_ownership_failed' }).catch(() => null),
          aircraftSpecificJsonlRecorder.endFlight({ endReason: 'bundle_ownership_failed' }).catch(() => null),
        ]).then((artifacts) => {
          try {
            recordingBundleLifecycle.discardUncommittedBundle(outputDir, bundleBaseName, artifacts);
          } catch {}
          return artifacts;
        }).finally(() => {
          try { recordingBundleLifecycle.finishRecordingBundleStartup(recordingSessionId); } catch {}
          aircraftSpecificRecordingFinalizing = false;
          if (activeFlightFinalizationPromise === rollback) activeFlightFinalizationPromise = null;
        });
        activeFlightFinalizationPromise = rollback;
        return {
          success: false,
          error: 'Failed to claim flight recording bundle ownership',
          reason,
          flightId,
        };
      }
      recordingDiskGuard.noteRecordingStarted();
      lastDiskCheckMs = recordingStartEpochMs;
      recordingSession.markStarted(flightId);
      pendingRecordingBundleStartupErrors.delete(recordingSessionId);
      recordingBundleFailureHandling = false;
      aircraftSpecificStateProjector.reset();
      recorderFieldCatalogConfig = null;
      recorderFieldCatalog = [];

      const fileName = typeof stats?.filePath === 'string' ? path.basename(stats.filePath) : '';
      broadcast({
        type: MSG.FLIGHT_RECORDING,
        status: 'recording',
        fileName,
        // outputDir intentionally omitted: full local disk path should not
        // be broadcast to all clients (incl. remote mobile clients).
        flightId,
      });
      return { success: true, reason, flightId, fileName };
    }

    clearFailedStartupState();
    try { recordingBundleLifecycle.finishRecordingBundleStartup(recordingSessionId); } catch {}
    console.error('[flight] CRITICAL: Flight CSV writer failed to start. Flight will NOT be recorded.');
    broadcast({
      type: MSG.FLIGHT_RECORDING,
      status: 'failed',
      error: 'Failed to start recording',
      // outputDir intentionally omitted
    });
    return { success: false, error: 'Failed to start recording', reason, flightId };
  }

  function getRecordingFinalizationBlocker() {
    if (
      activeFlightFinalizationPromise
      || flightCsvWriter.isFinalizing?.() === true
      || automationJsonlRecorder.isFinalizing?.() === true
      || aircraftSpecificJsonlRecorder.isFinalizing?.() === true
    ) {
      return 'Previous flight recording is still finalizing';
    }
    return '';
  }

  function getRecordingStartBlocker() {
    const bundleBlocker = recordingBundleLifecycle.getRecordingBundleStartBlocker();
    if (bundleBlocker) return bundleBlocker;
    const finalizationBlocker = getRecordingFinalizationBlocker();
    if (finalizationBlocker) return finalizationBlocker;
    const latestTickFrame = runtimeState.sim.latestTickFrame;
    const simconnectState = latestTickFrame?.simconnect || null;
    if (simconnectState?.connected !== true) {
      return 'Simulator telemetry is not connected';
    }
    if (simconnectState?.inMenu === true) {
      return 'Simulator is still in menus';
    }
    return '';
  }

  function getManualFlightStartClock() {
    const latestTickFrame = runtimeState.sim.latestTickFrame;
    const nowEpochMs = Number.isFinite(latestTickFrame?.timestampMs)
      ? latestTickFrame.timestampMs
      : timeSource.now();
    const timestampIso = typeof latestTickFrame?.timestampIso === 'string' && latestTickFrame.timestampIso
      ? latestTickFrame.timestampIso
      : timeSource.nowIso();
    return { nowEpochMs, timestampIso };
  }

  function getManualFlightAircraftTitle() {
    return runtimeState.sim.latestTickFrame?.simconnect?.aircraftLoadedName
      || flightStartAircraftTitle
      || null;
  }

  function startFlight(nowEpochMs, timestampIso, aircraftTitle = null, options: { forceRecording?: boolean } = {}) {
    const forceRecording = options?.forceRecording === true;
    const recordingReason = forceRecording ? 'user_manual' : 'automatic';
    let diskPreflightPassed = false;
    let recordingStartResult: any = {
      success: false,
      reason: recordingReason,
      flightId: timestampIso,
      error: forceRecording ? 'Failed to start recording' : 'Automatic recording disabled',
    };

    // Do not transition the lifecycle to ACTIVE if its authoritative recorder
    // cannot start yet. Otherwise an automatic start during prior-flight flush
    // can become an active but permanently unrecorded flight.
    if (!capabilities.isMock && (RECORDING_AUTO_START || forceRecording)) {
      const finalizationBlocker = getRecordingFinalizationBlocker();
      if (finalizationBlocker) {
        return {
          ...recordingStartResult,
          error: finalizationBlocker,
        };
      }
      const diskDecision = checkRecordingDiskFloorBeforeStart(recordingReason);
      if (!diskDecision.allowed) {
        return {
          ...recordingStartResult,
          error: diskDecision.reason,
        };
      }
      diskPreflightPassed = true;
    }

    clearManualAutoStartSuppression('flight_started');
    flightActive = true;
    flightStartAircraftTitle = aircraftTitle;  // Track aircraft at flight start

    // Notify decoupled subsystems (e.g. cabin announcements) that a new flight
    // has started so they can reset per-flight state.
    eventBus.emit('flight:started', { flightId: timestampIso, aircraftTitle });
    
    // Reset VRE evaluator for new flight (deterministic starting state)
    vreEvaluator.reset();
    lastVreSamplingStatusBroadcastMs = 0;
    lastVreSamplingStatusSignature = '';
    lastVreCsvWriteAttemptTs = null;
    publishVreSamplingStatus(null, null, { force: true, active: true, event: 'flight_started' });
    
    // Reset landing runner for new flight (prevents stale WOW/touchdown state)
    landingRunner.reset();

    // Fresh approach scorer for this flight
    currentApproachScorer = createCurrentApproachScorer();
    publishCurrentApproachStabilityStatus({
      state: 'idle',
      event: 'flight_started',
      reason: 'flight_started',
      sampleCount: 0,
    }, { force: true });
    
    flightId = timestampIso;
    flightStartEpochMs = nowEpochMs;
    flightStartIso = timestampIso;
    
    lastFlightTimeBroadcastSec = null;
    try {
      Debug.log('flight', 'Flight START', { flightId, aircraftTitle });
      // ═══════════════════════════════════════════════════════════════════════
      // V1 AUTHORITY RULE: Start the authoritative CSV, then require both JSONL
      // members to claim the same immutable bundle identity before recording is
      // announced. Any partial startup is rolled back as one transaction.
      // ═══════════════════════════════════════════════════════════════════════
      if (!capabilities.isMock && (RECORDING_AUTO_START || forceRecording)) {
        recordingStartResult = startCsvRecordingForCurrentFlight(recordingReason, {
          diskPreflightPassed,
        });
      } else if (!capabilities.isMock) {
        Debug.log('flight', 'Automatic recording disabled by settings', { flightId });
        broadcast({
          type: MSG.FLIGHT_RECORDING,
          status: 'stopped',
          flightId,
        });
      }
    } catch {}
    return recordingStartResult;
  }

  function startFlightWithReason(nowEpochMs, timestampIso, reason, aircraftTitle = null, options: { forceRecording?: boolean } = {}) {
    const recordingStartResult = startFlight(nowEpochMs, timestampIso, aircraftTitle, options);
    if (!flightActive) return recordingStartResult;
    const payload = { flightId, aircraftTitle, ...reason };
    try {
      Debug.log('flight', 'Flight START reason', payload);
    } catch {}
    if (FLIGHT_LIFECYCLE_CONSOLE_LOG) {
      console.log('[flight] START', payload);
    }
    return recordingStartResult;
  }

  function startFlightManual() {
    if (capabilities.isMock) {
      return {
        success: false,
        reason: 'user_manual',
        error: 'Recording is unavailable in mock mode',
        flightId,
      };
    }

    if (flightCsvWriter.isRecording?.() === true) {
      const stats = flightCsvWriter.getStats?.();
      return {
        success: false,
        reason: 'user_manual',
        error: 'Recording is already active',
        flightId: flightId || stats?.flightId || '',
        fileName: typeof stats?.filePath === 'string' ? path.basename(stats.filePath) : '',
      };
    }

    const startBlocker = getRecordingStartBlocker();
    if (startBlocker) {
      return {
        success: false,
        reason: 'user_manual',
        error: startBlocker,
        flightId,
      };
    }

    if (flightActive) {
      return startCsvRecordingForCurrentFlight('user_manual');
    }

    const { nowEpochMs, timestampIso } = getManualFlightStartClock();
    return startFlightWithReason(
      nowEpochMs,
      timestampIso,
      { event: 'manual_start', reason: 'user_manual', manual: true },
      getManualFlightAircraftTitle(),
      { forceRecording: true }
    );
  }

  function endFlight(nowEpochMs, reason = 'unknown') {
    if (!flightActive) return Promise.resolve(null);  // Guard against double-end

    // A partial bundle startup or terminal member failure can already own a
    // close/rollback promise while the higher-level flight remains active.
    // Preserve that obligation if there are no newly-active recorders below.
    const preExistingRecordingFinalization = activeFlightFinalizationPromise;

    const activeBundleAtEnd = !capabilities.isMock
      ? recordingBundleLifecycle.getActiveRecordingBundle()
      : null;
    const csvStatsAtEnd = !capabilities.isMock ? flightCsvWriter.getStats?.() : null;
    const csvWasRecording = !capabilities.isMock && (
      flightCsvWriter.isRecording?.() === true
      || (
        activeBundleAtEnd?.recordingSessionId === flightRecordingSessionId
        && csvStatsAtEnd?.recordingSessionId === flightRecordingSessionId
      )
    );
    const automationWasRecording = !capabilities.isMock && automationJsonlRecorder.isRecording?.() === true;
    const aircraftSpecificWasRecording = !capabilities.isMock
      && aircraftSpecificJsonlRecorder.isRecording?.() === true;
    // Stop observer writes synchronously. In particular, an aircraft-change
    // profile can be selected before this tick ends; it must never enter the
    // sidecar belonging to the aircraft that is now finalizing.
    if (aircraftSpecificWasRecording) aircraftSpecificRecordingFinalizing = true;
    
    const endingFlightId = flightId;  // Capture before clearing
    const endingFlightAircraftTitle = flightStartAircraftTitle;
    const endingRecordingStartEpochMs = flightRecordingStartEpochMs;
    const endingRecordingStartIso = flightRecordingStartIso;
    const endingRecordingSessionId = flightRecordingSessionId;
    const elapsedMs = computeElapsedMs(nowEpochMs, flightStartEpochMs);
    const endingTimestampIso = new Date(nowEpochMs).toISOString();
    
    try {
      Debug.log('flight', 'Flight END', {
        flightId,
        reason,
        flightElapsedMs: elapsedMs,
        flightStartAircraftTitle,
      });
      
      // Mark recording session as stopped
      recordingSession.markStopped();
    } catch {}
    
    if (FLIGHT_LIFECYCLE_CONSOLE_LOG) {
      const elapsedSec = elapsedMs != null ? Math.round(elapsedMs / 1000) : '?';
      console.log(`[flight] END (reason: ${reason}, elapsed: ${elapsedSec}s, flightId: ${endingFlightId})`);
    }

    if (reason === 'user_manual') {
      armManualAutoStartSuppression(nowEpochMs, reason);
    } else {
      clearManualAutoStartSuppression(reason);
    }

    flightActive = false;
    flightId = '';
    flightStartEpochMs = null;
    flightStartIso = '';
    flightRecordingStartEpochMs = null;
    flightRecordingStartIso = '';
    flightRecordingSessionId = '';
    lastFlightTimeBroadcastSec = null;
    broadcastFlightTimeReset(nowEpochMs, reason, endingFlightId);
    flightStartAircraftTitle = null;  // Clear aircraft title
    aircraftSpecificStateProjector.reset();
    recorderFieldCatalogConfig = null;
    recorderFieldCatalog = [];
    currentApproachScorer = null;     // Discard approach samples after flight ends
    currentApproachScoringInputs = null;
    publishCurrentApproachStabilityStatus({
      state: 'reset',
      event: 'flight_ended',
      reason,
      sampleCount: 0,
      scorerPresent: false,
    }, { force: true });
    publishVreSamplingStatus(null, null, { force: true, active: false, event: 'flight_ended' });

    let finalizePromise: Promise<unknown> = preExistingRecordingFinalization
      ? Promise.resolve(preExistingRecordingFinalization)
      : Promise.resolve(null);

    const hadActiveRecording = csvWasRecording || automationWasRecording || aircraftSpecificWasRecording;

    if (hadActiveRecording) {
      try {
        recordingBundleLifecycle.markRecordingBundleFinalizing(endingRecordingSessionId);
      } catch (error) {
        console.error('[flight] Recording bundle finalization ownership failed:', error?.message || String(error));
      }
      recordingBundleAggregateFinalizingSessionId = endingRecordingSessionId;
      // ═══════════════════════════════════════════════════════════════════════
      // V1 AUTHORITY RULE: Finalize the authoritative flight CSV
      // ═══════════════════════════════════════════════════════════════════════
      const currentCsvStats = flightCsvWriter.getStats?.();
      broadcast({
        type: MSG.FLIGHT_RECORDING,
        status: 'finalizing',
        fileName: typeof currentCsvStats?.filePath === 'string' ? path.basename(currentCsvStats.filePath) : '',
        rowCount: currentCsvStats?.rowCount,
        flightId: endingFlightId,
        endReason: reason,
      });

      const endContext = {
        timeMs: nowEpochMs,
        timestampIso: endingTimestampIso,
        flightElapsedMs: computeElapsedMs(nowEpochMs, endingRecordingStartEpochMs),
        flightId: endingFlightId,
        flightStartIso: endingRecordingStartIso,
        aircraftTitle: endingFlightAircraftTitle,
        endReason: reason,
      };
      const aircraftSpecificEndContext = {
        ...endContext,
        flightElapsedMs: computeElapsedMs(nowEpochMs, endingRecordingStartEpochMs),
        flightStartIso: endingRecordingStartIso,
      };
      const automationFinalizePromise = automationWasRecording
        ? automationJsonlRecorder.endFlight(endContext).catch((error) => {
            recordingBundleLifecycle.markRecordingBundleDegraded(endingRecordingSessionId, error);
            console.warn('[automation-jsonl] Recording bundle finalization failed:', error?.message || String(error));
            return null;
          })
        : Promise.resolve(null);

      const aircraftSpecificFinalizePromise = aircraftSpecificWasRecording
        ? aircraftSpecificJsonlRecorder.endFlight(aircraftSpecificEndContext).catch((error) => {
            recordingBundleLifecycle.markRecordingBundleDegraded(endingRecordingSessionId, error);
            console.warn('[aircraft-specific-jsonl] Recording bundle finalization failed:', error?.message || String(error));
            return null;
          })
        : Promise.resolve(null);

      const csvFinalizePromise = csvWasRecording
        ? flightCsvWriter.endFlight().catch((e) => {
          recordingBundleLifecycle.markRecordingBundleDegraded(endingRecordingSessionId, e);
          console.error('[flight] CSV finalization error:', e.message);
          broadcast({
            type: MSG.FLIGHT_RECORDING,
            status: 'error',
            // e.message intentionally omitted: may contain local file paths
            error: 'Flight recording finalization failed',
          });
          return null;
        })
        : Promise.resolve(null);

      finalizePromise = Promise.all([
        csvFinalizePromise,
        automationFinalizePromise,
        aircraftSpecificFinalizePromise,
      ]).then(async ([csvStats, automationStats, aircraftSpecificStats]) => {
        if (automationStats) {
          Debug.log('flight', 'Automation JSONL finalized', automationStats);
          console.log(`[flight] Automation saved: ${automationStats.filePath} (${automationStats.rowCount} rows)`);
        }
        if (aircraftSpecificStats) {
          Debug.log('flight', 'Aircraft-specific JSONL finalized', aircraftSpecificStats);
          if (aircraftSpecificStats.hasError || aircraftSpecificStats.captureDisabled) {
            console.warn(`[flight] Aircraft-specific data saved partially: ${aircraftSpecificStats.filePath} (${aircraftSpecificStats.rowCount} accepted rows)`);
          } else {
            console.log(`[flight] Aircraft-specific data saved: ${aircraftSpecificStats.filePath} (${aircraftSpecificStats.rowCount} rows)`);
          }
        }
        let bundleHasError = Boolean(
          recordingBundleLifecycle.getFinalizingRecordingBundle()?.degradedReason
          || (csvWasRecording && !csvStats)
          || (automationWasRecording && !automationStats)
          || (aircraftSpecificWasRecording && !aircraftSpecificStats)
          || csvStats?.hasError
          || automationStats?.hasError
          || aircraftSpecificStats?.hasError
          || aircraftSpecificStats?.captureDisabled
        );
        const durableStatus = await publishFinalRecordingBundleStatus(activeBundleAtEnd, {
          healthy: !bundleHasError,
          finalizedAtEpochMs: nowEpochMs,
          endReason: reason,
          degradedReason: bundleHasError
            ? 'recording bundle finalized with a storage error'
            : 'bundle completion certificate failed',
        });
        if (durableStatus !== 'complete') bundleHasError = true;
        if (csvStats && !bundleHasError) {
          Debug.log('flight', 'Flight CSV finalized', csvStats);
          console.log(`[flight] CSV saved: ${csvStats.filePath} (${csvStats.rowCount} samples)`);
          // Notify UI that recording has stopped
          broadcast({
            type: MSG.FLIGHT_RECORDING,
            status: 'stopped',
            fileName: typeof csvStats.filePath === 'string' ? path.basename(csvStats.filePath) : '',
            // outputDir intentionally omitted
            rowCount: csvStats.rowCount,
            flightId: endingFlightId,
            endReason: reason,
          });
        } else {
          broadcast({
            type: MSG.FLIGHT_RECORDING,
            status: bundleHasError ? 'error' : 'stopped',
            // outputDir intentionally omitted
            error: bundleHasError ? 'Flight recording bundle finalized with a storage error' : undefined,
            endReason: reason,
          });
        }
        return csvStats || null;
      });

      const trackedFinalization = finalizePromise.finally(() => {
        try {
          recordingBundleLifecycle.finishRecordingBundle(endingRecordingSessionId);
        } catch (error) {
          console.error('[flight] Recording bundle completion ownership failed:', error?.message || String(error));
        }
        if (activeFlightFinalizationPromise === trackedFinalization) {
          activeFlightFinalizationPromise = null;
        }
        if (recordingBundleAggregateFinalizingSessionId === endingRecordingSessionId) {
          recordingBundleAggregateFinalizingSessionId = '';
        }
      });
      activeFlightFinalizationPromise = trackedFinalization;
      finalizePromise = trackedFinalization;

    }

    // Reset transient scoring state between flights.
    try {
      resetStability();
    } catch {}

    // Reset motion detector baseline to prevent immediate re-start
    // This ensures the aircraft must show NEW movement to start another flight
    motionBaseline = null;
    
    // Reset flight end detection state to prevent stale timers affecting next flight
    parkedEnginesOffSinceMs = null;
    flightEndGuardState = {
      lastSimconnectConnectedMs: null,
      simconnectDisconnectedSinceMs: null,
      simStoppedSinceMs: null,
      pendingReason: null,
    };
    
    // Reset telemetry activity baseline for clean start detection on next flight
    previousFrameForActivity = null;
    
    // Reset slew mode state
    slewActiveSinceMs = null;
    slewSamplesSuppressed = 0;
    
    // Record flight end time for cooldown period
    lastFlightEndMs = nowEpochMs;
    
    // Reset lifecycle state logger for clean state on next flight
    resetStateLogger();

    // Notify decoupled subsystems that the flight has ended.
    // Must be emitted after all state has been cleared so subscribers
    // see a clean flightActive=false world.
    eventBus.emit('flight:ended', { flightId: endingFlightId, reason, timestamp: new Date().toISOString() });
    return finalizePromise;
  }

  async function finalizeOpenRecordersForShutdown(nowEpochMs, reason) {
    if (capabilities.isMock) return;

    const bundle = recordingBundleLifecycle.getActiveRecordingBundle()
      || recordingBundleLifecycle.getFinalizingRecordingBundle();
    if (bundle?.recordingSessionId && recordingBundleLifecycle.getActiveRecordingBundle()) {
      try { recordingBundleLifecycle.markRecordingBundleFinalizing(bundle.recordingSessionId); } catch {}
    }
    if (bundle?.recordingSessionId) {
      recordingBundleAggregateFinalizingSessionId = bundle.recordingSessionId;
    }

    const csvWasRecording = flightCsvWriter.isRecording?.() === true;
    const automationWasRecording = automationJsonlRecorder.isRecording?.() === true;
    const aircraftWasRecording = aircraftSpecificJsonlRecorder.isRecording?.() === true;
    let csvStats: AnyRecord | null = null;
    let automationStats: AnyRecord | null = null;
    let aircraftStats: AnyRecord | null = null;
    const tasks: Promise<unknown>[] = [];
    if (csvWasRecording) {
      tasks.push(Promise.resolve().then(() => flightCsvWriter.endFlight()).then((stats) => {
        csvStats = stats;
        return stats;
      }).catch((error) => {
        console.warn('[flight-csv] Shutdown finalization failed:', error?.message || String(error));
        return null;
      }));
    }
    if (automationWasRecording) {
      tasks.push(Promise.resolve().then(() => automationJsonlRecorder.endFlight({
          timeMs: nowEpochMs,
          timestampIso: new Date(nowEpochMs).toISOString(),
          flightElapsedMs: computeElapsedMs(nowEpochMs, flightRecordingStartEpochMs),
          flightId,
          flightStartIso: flightRecordingStartIso,
          endReason: reason,
        })).then((stats) => {
          automationStats = stats;
          return stats;
        }).catch((error) => {
          console.warn('[automation-jsonl] Shutdown finalization failed:', error?.message || String(error));
          return null;
        }));
    }
    if (aircraftWasRecording) {
      aircraftSpecificRecordingFinalizing = true;
      tasks.push(Promise.resolve().then(() => aircraftSpecificJsonlRecorder.endFlight({
          timeMs: nowEpochMs,
          timestampIso: new Date(nowEpochMs).toISOString(),
          flightElapsedMs: computeElapsedMs(nowEpochMs, flightRecordingStartEpochMs),
          flightId,
          flightStartIso: flightRecordingStartIso,
          aircraftTitle: flightStartAircraftTitle,
          endReason: reason,
        })).then((stats) => {
          aircraftStats = stats;
          return stats;
        }).catch((error) => {
          console.warn('[aircraft-specific-jsonl] Shutdown finalization failed:', error?.message || String(error));
          return null;
        }));
    }

    try {
      if (tasks.length > 0) await Promise.all(tasks);
      if (bundle) {
        const bundleHasError = Boolean(
          !csvWasRecording
          || !automationWasRecording
          || !aircraftWasRecording
          || !csvStats
          || !automationStats
          || !aircraftStats
          || csvStats.hasError
          || automationStats.hasError
          || aircraftStats.hasError
          || aircraftStats.captureDisabled
          || csvStats.recordingSessionId !== bundle.recordingSessionId
          || automationStats.recordingSessionId !== bundle.recordingSessionId
          || aircraftStats.recordingSessionId !== bundle.recordingSessionId
        );
        await publishFinalRecordingBundleStatus(bundle, {
          healthy: !bundleHasError,
          finalizedAtEpochMs: nowEpochMs,
          endReason: reason,
          degradedReason: 'shutdown recorder finalization was incomplete',
        });
      }
    } finally {
      if (bundle?.recordingSessionId) {
        try { recordingBundleLifecycle.finishRecordingBundle(bundle.recordingSessionId); } catch {}
      }
      aircraftSpecificRecordingFinalizing = false;
      if (recordingBundleAggregateFinalizingSessionId === bundle?.recordingSessionId) {
        recordingBundleAggregateFinalizingSessionId = '';
      }
    }
  }

  async function shutdownCore() {
    if (coreShutdownStarted) return;
    coreShutdownStarted = true;

    const reason = getShutdownReason(shutdownSignal);
    const nowEpochMs = timeSource.now();
    console.log(`[simbridge] Core cleanup started (${reason}).`);

    await runSimbridgeShutdownSequence({
      finalizationTask: () => runWithTimeout(
        () => finalizeRecordingForShutdown({
          flightActive,
          endActiveFlight: () => endFlight(nowEpochMs, reason),
          getPendingFinalization: () => activeFlightFinalizationPromise,
          finalizeOpenRecorders: () => finalizeOpenRecordersForShutdown(nowEpochMs, reason),
        }),
        SHUTDOWN_RECORDING_FINALIZATION_TIMEOUT_MS,
        'recording finalization',
      ),
      provider,
      historyIndexHandle: flightCsvStore,
      cabinAnnouncementsHandle,
      updateCheckerHandle,
      stopHandle,
      closeServersTask: () => Promise.all([
        runWithTimeout(() => closeWsServer(wss, 2000), 2500, 'WebSocket server close'),
        runWithTimeout(() => closeHttpServer(httpServerHandle?.httpServer, 2000), 2500, 'HTTP server close'),
      ]),
    });

    console.log('[simbridge] Core cleanup complete.');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tick Helper Group: Flight-time and Stability Utilities
  // ───────────────────────────────────────────────────────────────────────────
  function broadcastFlightTimeIfDue(nowEpochMs, timestampIso) {
    if (!flightActive || !flightStartEpochMs) return;
    const elapsedMs = computeElapsedMs(nowEpochMs, flightStartEpochMs);
    const elapsedSec = Math.floor(elapsedMs / 1000);
    if (elapsedSec === lastFlightTimeBroadcastSec) return;

    lastFlightTimeBroadcastSec = elapsedSec;
    try {
      broadcast({
        type: MSG.FLIGHT_TIME,
        startedAt: flightStartIso,
        now: timestampIso,
        elapsedMs,
        elapsedSec,
        elapsedHms: formatElapsedHms(elapsedSec),
      });
    } catch {}
  }

  function broadcastFlightTimeReset(nowEpochMs, reason = 'unknown', endingFlightId = '') {
    const nowIso = Number.isFinite(nowEpochMs)
      ? new Date(nowEpochMs).toISOString()
      : timeSource.nowIso();
    try {
      broadcast({
        type: MSG.FLIGHT_TIME,
        startedAt: '',
        now: nowIso,
        elapsedMs: 0,
        elapsedSec: 0,
        elapsedHms: '00:00:00',
        active: false,
        flightId: endingFlightId || '',
        endReason: reason,
      });
    } catch {}
  }

  function resetStabilityForHighAltOrParked(raFeet, phase) {
    if (raFeet > STABILITY_HIGH_ALT_RESET_RA_FT || phase === PHASES.PARKED) {
      resetStability();
      if (!flightActive) return;
      if (
        phase === PHASES.PARKED &&
        !shouldResetCurrentApproachScorerForParked({
          phase,
          scorerPresent: !!currentApproachScorer,
          hasScored: currentApproachScorer?.hasScored === true,
          sampleCount: getCurrentApproachSampleCount(),
        })
      ) {
        publishCurrentApproachStabilityStatus({
          state: 'preserved',
          event: 'approach_preserved',
          reason: 'parked_before_landing_final',
          sampleCount: getCurrentApproachSampleCount(),
          phase,
          raFt: Number.isFinite(raFeet) ? raFeet : null,
        });
        return;
      }
      // Also reset the current approach scorer so a new approach starts clean
      currentApproachScorer = createCurrentApproachScorer();
      publishCurrentApproachStabilityStatus({
        state: 'reset',
        event: 'approach_reset',
        reason: phase === PHASES.PARKED ? 'parked' : 'high_altitude',
        sampleCount: 0,
        phase,
        raFt: Number.isFinite(raFeet) ? raFeet : null,
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tick Helper Group: Landing and Engine Output Utilities
  // ───────────────────────────────────────────────────────────────────────────
  function updateLandingRunnerIfEnabled(frame, xwind, stability, nowEpochMs, timestampIso, phaseHint = null, hdgMagDeg = null, hdgTrueDeg = null, convectiveContext = null, sampleDtMs = null, flapsForScoring = null) {
    if (!capabilities.enableLandingRunner || !flightActive) return;

    const sc = frame && frame.simconnect;
    const phase = phaseHint || getPhase();
    const telemetryWarmup = isTelemetryWarmupFrame(frame);
    const airportGeometryContext = getAirportGeometryLookupContext();

    let approachType = null;
    if (sc) {
      if (sc.apApprHold) {
        approachType = 'ILS';
      } else if (APPROACH_PHASES.has(phase)) {
        approachType = 'VISUAL';
      }
    }

    // Feed valid airborne frames into the current approach buffer. Collection
    // freezes as soon as landing-runner enters rollout so bounces and other
    // post-touchdown airborne transitions cannot contaminate approach scoring;
    // landing-runner continues owning bounce/excursion analysis independently.
    try {
      const display = frame.display && typeof frame.display === 'object' ? frame.display : {};
      const raFt = display.raFt ?? frame.ra ?? null;
      const vsFpm = display.vsFpm ?? null;
      const sampleEligible = shouldCollectCurrentApproachSample({
        phase,
        raFt,
        vsFpm,
        onGround: frame.wow,
        rolloutActive: landingRunner.isRolloutActive(),
        collectionCeilingFt: getCurrentApproachCollectionCeilingFt(),
        warmup: telemetryWarmup,
      });
      const eligible = sampleEligible;
      // A level/climbing frame may join an approach that is already being
      // tracked, but only a descending frame can arm a fresh scorer. This avoids
      // creating a new approach buffer during the first ticks of a go-around.
      const startEligible = eligible && Number.isFinite(vsFpm) && vsFpm < 0;

      if (shouldStartCurrentApproachScorer({
        flightActive,
        eligible: startEligible,
        scorerPresent: !!currentApproachScorer,
        hasScored: currentApproachScorer?.hasScored === true,
      })) {
        currentApproachScorer = createCurrentApproachScorer();
        publishCurrentApproachStabilityStatus({
          state: 'armed',
          event: 'approach_started',
          reason: 'eligible_sample_after_reset',
          sampleCount: 0,
          phase,
          raFt,
          vsFpm,
        }, { force: true });
      }

      if (currentApproachScorer && !currentApproachScorer.hasScored) {
        let sampleAccepted = false;
        if (eligible) {
          // frame.pitch and frame.bank are stored in radians by the SimConnect provider.
          // Augment with explicit degree fields so normalizeFrame picks them up preferentially.
          const pitchRad = frame.pitch;
          const bankRad  = frame.bank;
          // Explicit throttle telemetry wins. If it is unavailable, cap the
          // engine/N1 fallback using the same profile snapshot as the scorer.
          // A later active-profile switch must not change sample construction.
          const scoringEngineCount = Number.isInteger(currentApproachScoringInputs?.engineCount)
            ? currentApproachScoringInputs.engineCount
            : 4;
          const fallbackEngineLevels = getEngineLevels(
            frame,
            scoringEngineCount,
          );
          const scoringThrottlePct = resolveApproachScoringThrottlePct(frame, fallbackEngineLevels);
          const augFrame = {
            ...frame,
            dtMs: Number.isFinite(sampleDtMs) && sampleDtMs > 0 ? sampleDtMs : frame.dtMs,
            flaps: flapsForScoring || frame.flaps,
            pitchDeg: typeof pitchRad === 'number' ? rad2deg(pitchRad) : undefined,
            bankDeg:  typeof bankRad  === 'number' ? rad2deg(bankRad)  : undefined,
            thrust: scoringThrottlePct ?? frame.thrust,
          };
          const sample = frameToSample(augFrame);
          if (sample) {
            currentApproachScorer.addSample(sample);
            sampleAccepted = true;
          }
        }
        publishCurrentApproachStabilityStatus({
          state: sampleAccepted ? 'collecting' : undefined,
          collecting: sampleAccepted,
          eligible,
          reason: sampleAccepted ? 'sample_collected' : (telemetryWarmup ? 'telemetry_warmup' : (eligible ? 'sample_rejected' : 'outside_collection_gate')),
          sampleCount: getCurrentApproachSampleCount(),
          phase,
          raFt,
          vsFpm,
        });
      }
    } catch { /* non-fatal */ }

    landingRunner.update(
      frame,
      broadcast,
      {
        nowEpochMs,
        nowIso: timestampIso,
        flightStartEpochMs,
        flightStartIso,
      },
      {
        phase,
        xwind_kts: xwind,
        stability,
        aircraftName: (sc && sc.aircraftLoadedName) || null,
        icao: null,
        runway: null,
        approachType,
        simVersion: sc?.simVersion || null,
        aircraftProfileId: profileLoader.getActiveProfile()?.id || 'generic',
        simulator: airportGeometryContext.simulator,
        dataSource: airportGeometryContext.dataSource,
        // Computed heading passed through from processTelemetryFrame — more reliable
        // than frame.simconnect.hdgTrueDeg/hdgMagDeg which may be null if the raw
        // SimConnect heading SimVar is not populated.
        computedHdgMagDeg: hdgMagDeg,
        computedHdgTrueDeg: hdgTrueDeg,
      }
    );

    // In-flight upset detection (entire flight, not just approach)
    flightViolationRunner.update(
      frame,
      broadcast,
      { nowEpochMs, nowIso: timestampIso },
      { phase, flightCsvWriter, warmup: telemetryWarmup }
    );

    const convectivePitchBankDeg = normalizePitchBankDegrees({
      pitch: convectiveContext?.pitchDeg,
      bank: convectiveContext?.bankDeg,
    });

    convectiveRiskRunner.update(
      frame,
      broadcast,
      { nowEpochMs, nowIso: timestampIso },
      {
        phase,
        flightCsvWriter,
        iasKts: convectiveContext?.iasKts,
        vsFpm: convectiveContext?.vsFpm,
        pitchDeg: convectivePitchBankDeg.pitchDeg,
        bankDeg: convectivePitchBankDeg.bankDeg,
        pitchRateDeg: convectiveContext?.pitchRateDeg,
        bankRateDeg: convectiveContext?.bankRateDeg,
      }
    );
  }

  function processThrottleAndEngineBroadcast(frame) {
    try {
      const thr = frame && frame.throttle;
      if (thr) {
        broadcast({ type: MSG.THROTTLE, value: thr });
      }

      const enginesData = buildEnginesBroadcastData(frame, {
        profile: profileLoader.getActiveProfile(),
      });
      if (enginesData) {
        broadcast({ type: MSG.ENGINES, data: enginesData });
      }

    } catch (e) {
      // Preserve non-fatal behavior
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tick Helper Group: Lifecycle Guards and State Gates
  // ───────────────────────────────────────────────────────────────────────────
  function processFlightEndAndSafetyGuards(frame, nowEpochMs, simconnectConnectedForLifecycle) {
    if (pendingAircraftChange && flightActive) {
      // Aircraft identity polling can briefly churn after touchdown. Keep the
      // flight alive until landing-runner has emitted the accepted landing's
      // final rollout result; the pending change is then handled normally on
      // the first tick outside rollout.
      if (landingRunner.isRolloutActive()) {
        if (pendingAircraftChange.deferredForLandingRollout !== true) {
          pendingAircraftChange.deferredForLandingRollout = true;
          Debug.log('landing', 'Deferred aircraft-change flight end until rollout finalization', {
            from: pendingAircraftChange.previousTitle,
            to: pendingAircraftChange.newTitle,
          });
        }
      } else {
        const { newTitle } = pendingAircraftChange;
        if (flightStartAircraftTitle && newTitle !== flightStartAircraftTitle) {
          endFlight(nowEpochMs, `aircraft_change:${flightStartAircraftTitle}->${newTitle}`);
        }
        pendingAircraftChange = null;
      }
    } else if (pendingAircraftChange) {
      pendingAircraftChange = null;
    }

    const flightEndGuardUpdate = updateActiveFlightEndGuard({
      state: flightEndGuardState,
      flightActive,
      nowEpochMs,
      simconnectConnected: simconnectConnectedForLifecycle === true,
      simRunning: frame?.simconnect?.simRunning,
      disconnectGraceMs: SIMCONNECT_DISCONNECT_GRACE_MS,
      simStoppedGraceMs: SIMCONNECT_DISCONNECT_GRACE_MS,
    });
    flightEndGuardState = flightEndGuardUpdate.state;

    if (flightEndGuardUpdate.pendingReasonStarted === 'simconnect_disconnect') {
      const elapsedMs = flightEndGuardUpdate.pendingElapsedMs ?? 0;
      const graceSec = Math.round(SIMCONNECT_DISCONNECT_GRACE_MS / 1000);
      console.warn(`[flight] SimConnect disconnected during active flight; recording will auto-finalize if it stays offline for ${graceSec}s.`);
      Debug.log('flight', 'SimConnect disconnected, starting grace period', {
        gracePeriodMs: SIMCONNECT_DISCONNECT_GRACE_MS,
        disconnectDurationMs: elapsedMs,
      });
    } else if (flightEndGuardUpdate.pendingReasonStarted === 'sim_stopped') {
      const elapsedMs = flightEndGuardUpdate.pendingElapsedMs ?? 0;
      const graceSec = Math.round(SIMCONNECT_DISCONNECT_GRACE_MS / 1000);
      console.warn(`[flight] Simulator stopped during active flight; recording will auto-finalize if it stays stopped for ${graceSec}s.`);
      Debug.log('flight', 'Simulator stopped, starting flight-end grace period', {
        gracePeriodMs: SIMCONNECT_DISCONNECT_GRACE_MS,
        stoppedDurationMs: elapsedMs,
      });
    }

    if (flightActive && flightEndGuardUpdate.endReason) {
      const elapsedSec = Math.round((flightEndGuardUpdate.endElapsedMs ?? 0) / 1000);
      if (flightEndGuardUpdate.endReason.startsWith('simconnect_disconnect:')) {
        console.warn(`[flight] SimConnect stayed disconnected for ${elapsedSec}s; ending flight and finalizing recording.`);
      } else if (flightEndGuardUpdate.endReason.startsWith('sim_stopped:')) {
        console.warn(`[flight] Simulator stayed stopped for ${elapsedSec}s; ending flight and finalizing recording.`);
      }
      endFlight(nowEpochMs, flightEndGuardUpdate.endReason);
    }

    if (flightActive && FLIGHT_END_PARKED_ENGINES_OFF_ENABLE) {
      const currentPhase = getPhase();
      const fdm = frame && frame.fdm;
      const anyEngineRunning = fdm && fdm.anyEngineRunning;

      const isParked = currentPhase === PHASES.PARKED;
      const allEnginesOff = anyEngineRunning === false;

      if (isParked && allEnginesOff) {
        if (parkedEnginesOffSinceMs == null) {
          parkedEnginesOffSinceMs = nowEpochMs;
          Debug.log('flight', 'Parked with engines off, starting auto-end timer', {
            timeoutMs: FLIGHT_END_PARKED_ENGINES_OFF_MS,
          });
        } else {
          const parkedDurationMs = nowEpochMs - parkedEnginesOffSinceMs;
          if (parkedDurationMs >= FLIGHT_END_PARKED_ENGINES_OFF_MS) {
            endFlight(nowEpochMs, `parked_engines_off:${Math.round(parkedDurationMs / 1000)}s`);
          }
        }
      } else {
        if (parkedEnginesOffSinceMs != null) {
          Debug.log('flight', 'Parked+engines-off timer reset', {
            reason: !isParked ? 'not_parked' : 'engines_running',
            phase: currentPhase,
            anyEngineRunning,
          });
        }
        parkedEnginesOffSinceMs = null;
      }
    } else if (!flightActive) {
      parkedEnginesOffSinceMs = null;
    }

    const slewActiveNow = frame?.assists?.slewActive === true;

    if (flightActive) {
      if (slewActiveNow) {
        if (slewActiveSinceMs == null) {
          slewActiveSinceMs = nowEpochMs;
          slewSamplesSuppressed = 0;
          Debug.log('flight', 'Slew mode started', {
            suppressSamples: SLEW_SUPPRESS_SAMPLES,
            autoEndMs: SLEW_AUTO_END_FLIGHT_MS,
          });
          if (FLIGHT_LIFECYCLE_CONSOLE_LOG) {
            console.log('[flight] ⚠️  SLEW MODE ACTIVE - samples will be suppressed');
          }
        }

        if (SLEW_AUTO_END_FLIGHT_MS > 0) {
          const slewDurationMs = nowEpochMs - slewActiveSinceMs;
          if (slewDurationMs >= SLEW_AUTO_END_FLIGHT_MS) {
            endFlight(nowEpochMs, `slew_timeout:${Math.round(slewDurationMs / 1000)}s`);
          }
        }
      } else if (slewActiveSinceMs != null) {
        const slewDurationMs = nowEpochMs - slewActiveSinceMs;
        Debug.log('flight', 'Slew mode ended', {
          durationMs: slewDurationMs,
          samplesSuppressed: slewSamplesSuppressed,
        });
        if (FLIGHT_LIFECYCLE_CONSOLE_LOG) {
          console.log(`[flight] Slew mode ended (${Math.round(slewDurationMs / 1000)}s, ${slewSamplesSuppressed} samples suppressed)`);
        }
        slewActiveSinceMs = null;
        slewSamplesSuppressed = 0;
      }
    } else {
      slewActiveSinceMs = null;
      slewSamplesSuppressed = 0;
    }

    const activeRecordingBundle = !capabilities.isMock
      ? recordingBundleLifecycle.getActiveRecordingBundle()
      : null;
    if (
      flightActive
      && activeRecordingBundle?.recordingSessionId
      && flightCsvWriter.isRecording?.() === true
      && !recordingBundleFailureHandling
    ) {
      const timeSinceLastCheck = nowEpochMs - lastDiskCheckMs;
      if (timeSinceLastCheck >= DISK_CHECK_INTERVAL_MS) {
        lastDiskCheckMs = nowEpochMs;

        const checkedRecordingSessionId = activeRecordingBundle.recordingSessionId;
        void recordingDiskGuard.checkActive(activeRecordingBundle.outputDir).then((diskDecision) => {
          if (!diskDecision) return;
          if (!diskDecision.checked) {
            Debug.log('storage', 'Periodic Flight Logs volume check was unavailable', {
              reason: diskDecision.reason,
            });
            return;
          }
          if (diskDecision.shouldStop) {
            const stillActiveBundle = recordingBundleLifecycle.getActiveRecordingBundle();
            if (
              stillActiveBundle?.recordingSessionId !== checkedRecordingSessionId
              || flightCsvWriter.isRecording?.() !== true
              || recordingBundleFailureHandling
            ) {
              return;
            }
            handleRecordingBundleTerminalError(
              checkedRecordingSessionId,
              createLowDiskError(diskDecision),
            );
          }
        }).catch((err) => {
          Debug.log('storage', 'Periodic disk check failed', { error: err.message });
        });
      }
    } else {
      lastDiskCheckMs = 0;
    }

    return slewActiveNow;
  }

  function processFlightLifecycleGate({
    frame,
    nowEpochMs,
    timestampIso,
    activeFieldCount,
    iasKnots,
    gs,
    raFeet,
    wow,
    motion,
    engineLevels,
    maxEngine,
  }) {
    const sc = frame && frame.simconnect;
    const simconnectConnected = !!(sc && sc.connected === true);

    function publishSimState({ lifecycleState, isGlobeView }) {
      try {
        const simconnectGateOk = simconnectConnected && sc && sc.inFlightContext === true;
        const providerInMenu = frame?.inMenu === true;
        const lifecycleInMenu = lifecycleState === LifecycleState.IN_MENU;
        const simSystemInMenu = !!(sc && sc.systemStateAvailable === true && sc.systemSim === 0);
        const dialogInMenu = !!(sc && sc.dialogMode === 1);
        const inMenuState = computeSimStateMenuFlag({
          simconnectConnected,
          providerInMenu,
          lifecycleInMenu,
          simSystemInMenu,
          dialogInMenu,
          simconnectGateOk,
          isGlobeView,
        });

        const simState = {
          type: MSG.SIM_STATE,
          inMenu: inMenuState,
          isGlobeView: !!isGlobeView,
          inFlightContext: !!(sc && sc.inFlightContext),
          simconnectConnected: !!simconnectConnected,
          lifecycleState,
        };

        runtimeState.sim.lastState = simState;
        const simStateSignature = [
          simState.inMenu,
          simState.isGlobeView,
          simState.inFlightContext,
          simState.simconnectConnected,
          simState.lifecycleState,
        ].join('|');
        if (lastConsoleSimconnectConnected !== simState.simconnectConnected) {
          const previousSimconnectConnected = lastConsoleSimconnectConnected;
          lastConsoleSimconnectConnected = simState.simconnectConnected;
          if (simState.simconnectConnected === false) {
            const activeLabel = flightActive ? 'active flight' : 'no active flight';
            console.warn(`[simconnect] disconnected (${activeLabel}; lifecycle=${lifecycleState})`);
          } else if (previousSimconnectConnected === false) {
            console.log(`[simconnect] connected (lifecycle=${lifecycleState})`);
          }
        }
        const stateChanged = simStateSignature !== lastSimStateBroadcastSignature;
        if (stateChanged || !lastSimStateBroadcastMs || (nowEpochMs - lastSimStateBroadcastMs) >= SIM_STATE_BROADCAST_THROTTLE_MS) {
          lastSimStateBroadcastMs = nowEpochMs;
          lastSimStateBroadcastSignature = simStateSignature;
          broadcast(simState);
        }
      } catch (e) {
        console.error('[simState] Error:', e.message);
      }
    }

    if (!flightActive) {
      const altMslFt = frame?.alt_msl ?? 0;
      const slewActive = frame?.assists?.slewActive === true;

      if (manualAutoStartSuppression.active) {
        const suppressionUpdate = updateManualAutoStartSuppression({
          suppression: manualAutoStartSuppression,
          nowEpochMs,
          simconnectConnected,
          simRunning: sc?.simRunning,
          inFlightContext: !!(sc && sc.inFlightContext),
          paused: frame?.paused === true || sc?.paused === true,
          aircraftTitle: sc?.aircraftLoadedName || null,
          phase: getPhase(),
          wow,
          iasKnots,
          gsKnots: gs,
          anyEngineRunning: frame?.fdm?.anyEngineRunning,
          maxEnginePct: maxEngine,
          parkedResetDwellMs: MANUAL_AUTO_START_REARM_PARKED_DWELL_MS,
          contextResetDwellMs: MANUAL_AUTO_START_CONTEXT_RESET_DWELL_MS,
          stoppedGsKts: MANUAL_AUTO_START_STOPPED_GS_KTS,
          stoppedIasKts: MANUAL_AUTO_START_STOPPED_IAS_KTS,
          engineOffMaxPct: MANUAL_AUTO_START_ENGINE_OFF_MAX_PCT,
        });
        manualAutoStartSuppression = suppressionUpdate.suppression;

        if (suppressionUpdate.cleared) {
          Debug.log('flight', 'Manual auto-start suppression re-armed', {
            reason: suppressionUpdate.clearReason,
          });
          motionBaseline = null;
        } else {
          if (FLIGHT_LIFECYCLE_CONSOLE_LOG) {
            logStateTransition(LifecycleState.IDLE, suppressionUpdate.blockers, FLIGHT_LIFECYCLE_CONSOLE_VERBOSE);
          }
          publishSimState({
            lifecycleState: LifecycleState.IDLE,
            isGlobeView: Number.isFinite(altMslFt) && altMslFt > FLIGHT_START_MAX_ALT_MSL_FT,
          });
          return true;
        }
      }

      const eligibility = checkFlightStartEligibility({
        flightActive,
        lastFlightEndMs,
        nowEpochMs,

        simconnectConnected,
        inFlightContext: !!(sc && sc.inFlightContext),

        altMslFt,
        iasKnots,
        gsKnots: gs,
        raFeet,
        wow,
        slewActive,

        motionDetected: motion.motionOverWindow,
        activeFieldCount,

        cooldownMs: FLIGHT_START_COOLDOWN_MS,
        maxAltMslFt: FLIGHT_START_MAX_ALT_MSL_FT,
        minIasKts: FLIGHT_START_IAS_KTS,
        minGsKts: FLIGHT_START_GS_KTS,
        minRaFt: FLIGHT_START_RA_FT,
        requireCount: FLIGHT_START_REQUIRE_COUNT,
        requireMovement: FLIGHT_START_REQUIRE_MOVEMENT,
        requireTelemetryActivity: FLIGHT_START_REQUIRE_TELEMETRY_ACTIVITY,
        minActiveFields: FLIGHT_START_MIN_ACTIVE_FIELDS,
        blockOnSlew: SLEW_BLOCK_FLIGHT_START,
      });

      if (FLIGHT_LIFECYCLE_CONSOLE_LOG) {
        logStateTransition(eligibility.state, eligibility.blockers, FLIGHT_LIFECYCLE_CONSOLE_VERBOSE);
      }

      const isGlobeView = eligibility.checks.isGlobeView;
      if (globeViewLogged && !isGlobeView) {
        globeViewLogged = false;
      }

      publishSimState({ lifecycleState: eligibility.state, isGlobeView: !!isGlobeView });

      if (eligibility.state === LifecycleState.COOLDOWN) {
        return true;
      }
      if (eligibility.state === LifecycleState.IN_MENU) {
        if (isGlobeView && !globeViewLogged) {
          globeViewLogged = true;
          Debug.log('flight', 'Globe view detected, rejecting flight start', { altMslFt });
        }
        return true;
      }
      if (eligibility.state === LifecycleState.IDLE) {
        return true;
      }

      const movementOk = eligibility.checks.movement?.ok ?? false;
      const airStartOk = eligibility.checks.airStart?.ok ?? false;
      const airStartChecks = eligibility.checks.airStart ?? null;
      const telemetryActivityOk = eligibility.checks.telemetryActivityOk ?? true;

      if (eligibility.eligible) {
        startFlightWithReason(
          nowEpochMs,
          timestampIso,
          buildFlightStartReason({
            flightId,
            frame,
            gs,
            iasKnots,
            wow,
            raFeet,
            engineLevels,
            maxEngine,
            requireMovement: FLIGHT_START_REQUIRE_MOVEMENT,
            movementOk,
            airStartOk,
            airStartChecks,
            motionOverWindow: motion.motionOverWindow,
            windowMs: FLIGHT_START_MOVE_WINDOW_MS,
            motionDebug: motion.motionDebug,
            requireTelemetryActivity: FLIGHT_START_REQUIRE_TELEMETRY_ACTIVITY,
            activeFieldCount,
            minActiveFields: FLIGHT_START_MIN_ACTIVE_FIELDS,
            telemetryActivityOk,
          }),
          sc?.aircraftLoadedName || null
        );
      } else if (FLIGHT_LIFECYCLE_CONSOLE_LOG && FLIGHT_LIFECYCLE_CONSOLE_VERBOSE) {
        if (!lastStartDecisionLogTs || (nowEpochMs - lastStartDecisionLogTs) > VERBOSE_LOG_THROTTLE_MS) {
          lastStartDecisionLogTs = nowEpochMs;
          console.log('[flight] not-started', {
            state: eligibility.state,
            blockers: eligibility.blockers,
            checks: eligibility.checks,
            simconnect: sc ? {
              simRunning: sc.simRunning ?? null,
              aircraftLoadedName: sc.aircraftLoadedName || null,
              userInputEnabled: typeof sc.userInputEnabled === 'boolean' ? sc.userInputEnabled : null,
              lastEvent: sc.lastEvent || null,
            } : null,
            motion: {
              motionOverWindow: motion.motionOverWindow,
              motionDebug: motion.motionDebug,
            },
          });
        }
      }
    } else if (FLIGHT_LIFECYCLE_CONSOLE_LOG) {
      logStateTransition(LifecycleState.ACTIVE, []);
    }

    if (flightActive) {
      publishSimState({ lifecycleState: LifecycleState.ACTIVE, isGlobeView: false });
    }

    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tick Helper Group: Streaming, Scoring, and VRE Persistence
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * Process one telemetry tick for real-time streaming and stability scoring.
   *
   * High-level responsibilities (in order):
   * 1) Normalize/derive display values from the current frame.
   * 2) Broadcast UI streams (IAS/VS/altitude/lights/gear/flaps/spoilers/surface/etc.).
   * 3) Update phase and runway context.
  * 4) Compute rates every tick, and run the stability pipeline in retrospective mode
  *    (no continuous per-tick stability score). If/when an ultimate landing stability
  *    score becomes available (typically on touchdown), broadcast that score output.
   * 5) Return a compact snapshot object used by later tick stages
   *    (especially VRE sample persistence) to avoid recomputing the same values.
   *
   * Note: this function does NOT write CSV samples; that happens in
   * processVreSampleLogging(), which consumes this function's return object.
   */
  function processStreamingAndScoring(frame, {
    timestampIso,
    nowEpochMs,
    targetPeriodMs,
    engineLevels,
  }) {
    const maxContinuousGapMs = Math.max(1000, targetPeriodMs * 5);
    const measuredDeltaMs = frame?.meta?.actualDeltaMs;
    const continuityBroken = streamingContinuityBroken
      || !Number.isFinite(measuredDeltaMs)
      || measuredDeltaMs <= 0
      || measuredDeltaMs > maxContinuousGapMs;
    const evaluationDeltaMs = continuityBroken ? targetPeriodMs : measuredDeltaMs;
    streamingContinuityBroken = false;
    const activeProfile = profileLoader.getActiveProfile();
    const dataSourceInfo = getDataSourceInfo();
    const sourceOverlayContext = createSourceOverlayContext({ frame, dataSourceInfo, profile: activeProfile });
    const spoilersObj = resolveSpoilersForBroadcast({
      baseSpoilers: frame.spoilers,
      profile: activeProfile,
      frame,
      sourceContext: sourceOverlayContext,
    });

    const {
      ias,
      vs,
      ra,
      wow,
      gearDownLocked,
      lights,
      flaps,
      pitch,
      bank,
      gs,
      windSpeed,
      windDir,
      heading,
      alt_msl,
      surface,
      display,
    } = frame;

    if (continuityBroken) {
      // Do not infer motion across startup, disconnect, or a long event-loop gap.
      previousIAS = Number.isFinite(ias) ? ias : 0;
      previousPitch = Number.isFinite(pitch) ? pitch : 0;
      previousBank = Number.isFinite(bank) ? bank : 0;
    }

    const timestamp = timestampIso;
    const xwind = computeCrosswind(windSpeed, windDir, heading);

    const { iasKts: iasKnots, raFt: raFeet, vsFpm: vsFeetPerMin } = display;
    const alt_msl_ft = alt_msl;

    const flapsLvarConfigured = !!activeProfile?.dataSource?.lvars?.flaps;
    const flapsObj = (
      flapsLvarConfigured && sourceOverlayContext.lvarSidecarConnected
        ? makeFlapsObjFromLvar(sourceOverlayContext.lvarValues?.flaps)
        : null
    ) || makeFlapsObj(frame.flaps, frame.flapsIndex, frame.flapsAngleDeg);
    if (Math.random() < DEBUG_LOG_PROBABILITY) {
      Debug.log('flaps', `Raw flaps: ${frame.flaps?.toFixed?.(2) ?? frame.flaps}, index: ${frame.flapsIndex ?? 'N/A'}, mapped: notch=${flapsObj.notch}, source=${flapsObj.source}`);
      Debug.log('spoilers-broadcast', `Spoilers broadcast: state=${spoilersObj?.state}, pct=${spoilersObj?.percent}, obj=${JSON.stringify(spoilersObj)}`);
    }
    // Only broadcast flaps when the notch changes — avoids every frontend
    // needing its own change-detection and debounce logic. In-transit frames
    // (notch=null) are broadcast so the bottom strip can show movement, but
    // a flapsChanged field is set only on notch transitions for event-log consumers.
    const flapsNotchNow = flapsObj.notch ?? null;
    const flapsNotchChanged = flapsNotchNow !== null && flapsNotchNow !== runtimeState.broadcast.lastFlapsNotch;
    if (flapsNotchChanged) runtimeState.broadcast.lastFlapsNotch = flapsNotchNow;
    const spoilersStateName = spoilersObj?.state ?? 'N/A';
    const spoilersDebounce = advanceDebouncedChangeState({
      value: spoilersStateName,
      lastValue: runtimeState.broadcast.lastSpoilersState,
      pendingValue: runtimeState.broadcast.pendingSpoilersState,
      pendingTicks: runtimeState.broadcast.pendingSpoilersStateTicks,
      requiredTicks: SPOILERS_DEBOUNCE_TICKS,
    });
    runtimeState.broadcast.lastSpoilersState = spoilersDebounce.nextLastValue;
    runtimeState.broadcast.pendingSpoilersState = spoilersDebounce.nextPendingValue;
    runtimeState.broadcast.pendingSpoilersStateTicks = spoilersDebounce.nextPendingTicks;
    // Keep spoiler telemetry available to Systems/recording consumers, but do
    // not publish change indications. Panel movement can represent roll
    // augmentation rather than a pilot-commanded speedbrake input.
    sendFlapsSpoilers(broadcast, { ...flapsObj, changed: flapsNotchChanged }, { ...spoilersObj, changed: false });

    const sc = frame && frame.simconnect;
    const {
      hdgTrueDeg: hdgTrueDegStream,
      hdgMagDeg: hdgMagDegStream,
    } = computeHeadingAndMagvar({
      sc,
      fallbackTrueHeadingDeg: heading,
      fallbackMagvarDeg: frame.magvar,
    });

    const lightsForBroadcast = resolveLightsForBroadcast({
      baseLights: lights,
      profile: activeProfile,
      sourceContext: sourceOverlayContext,
    });

    sendBasicStreams(broadcast, {
      vsFeetPerMin,
      iasKnots,
      gsKnots: gs,
      alt_msl_ft,
      raFeet,
      altIndicatedFt: frame.fdm?.altIndicatedFt ?? alt_msl_ft,
      altCalibratedFt: frame.fdm?.altCalibratedFt ?? null,
      altPlaneFt: frame.fdm?.altPlaneFt ?? null,
      aircraftAglFt: frame.fdm?.aircraftAglFt ?? null,
      aircraftAboveObstaclesFt: frame.fdm?.aircraftAboveObstaclesFt ?? null,
      planeAglFt: frame.fdm?.planeAglFt ?? null,
      planeAglMinusCgFt: frame.fdm?.planeAglMinusCgFt ?? null,
      pressureAltFt: frame.fdm?.pressureAltFt ?? null,
      kohlsmanSettingMb: frame.fdm?.kohlsmanSettingMb ?? null,
      kohlsmanTunedMb: frame.fdm?.kohlsmanTunedMb ?? null,
      kohlsmanStd: typeof frame.fdm?.kohlsmanStd === 'boolean' ? frame.fdm.kohlsmanStd : null,
      xwind,
      lights: lightsForBroadcast,
      hdgMag: hdgMagDegStream,
      hdgTrue: hdgTrueDegStream,
    });

    const fdmForFuel = mergeFdmData(frame.fdm, frame.simconnect);
    if (fdmForFuel && (Number.isFinite(fdmForFuel.fuelTotalGal) || Number.isFinite(fdmForFuel.fuelTotalWeightLbs))) {
      sendFuel(broadcast, {
        totalGal: fdmForFuel.fuelTotalGal,
        totalPct: fdmForFuel.fuelTotalPct,
        totalWeightLbs: fdmForFuel.fuelTotalWeightLbs,
      });
    }

    if (fdmForFuel) {
      sendEnvironment(broadcast, {
        cabinAltFt: fdmForFuel.cabinAltFt,
        cabinAltRateFpm: fdmForFuel.cabinAltRateFpm,
        cabinDeltaPPsi: fdmForFuel.cabinDeltaPPsi,
        cabinAltTargetFt: fdmForFuel.cabinAltTargetFt,
        oatC: fdmForFuel.oatC,
      });
    }

    let autopilotReliabilityForRecording = null;
    let fdmForRecording = fdmForFuel;

    if (fdmForFuel) {
      const finalOverlay = resolveAutopilotSourceOverlay({
        baseFdm: fdmForFuel,
        profile: activeProfile,
        sourceContext: sourceOverlayContext,
      });

      autopilotReliabilityForRecording = assessAutopilotReliability({
        profile: activeProfile,
        lvarSidecarConnected: sourceOverlayContext.lvarSidecarConnected,
        lvarHasAutomationData: sourceOverlayContext.lvarHasAutomationData,
        lvarHasModeSelectorData: sourceOverlayContext.lvarHasModeSelectorData,
        lvarHasAutopilotData: sourceOverlayContext.lvarHasAutopilotData,
        lvarHasAutothrottleData: sourceOverlayContext.lvarHasAutothrottleData,
        lvarSource: sourceOverlayContext.lvarSidecarSource,
        sdkConnected: sourceOverlayContext.sdkConnected,
        sdkHasData: sourceOverlayContext.sdkHasData,
        sdkHasAutomationData: sourceOverlayContext.sdkHasAutomationData,
        sdkSource: sourceOverlayContext.sdkSource,
      });
      fdmForRecording = finalOverlay;

      sendAutopilot(broadcast, finalOverlay, {
        profile: activeProfile,
        lvarSidecarConnected: sourceOverlayContext.lvarSidecarConnected,
        lvarHasAutomationData: sourceOverlayContext.lvarHasAutomationData,
        lvarHasModeSelectorData: sourceOverlayContext.lvarHasModeSelectorData,
        lvarHasAutopilotData: sourceOverlayContext.lvarHasAutopilotData,
        lvarHasAutothrottleData: sourceOverlayContext.lvarHasAutothrottleData,
        lvarSource: sourceOverlayContext.lvarSidecarSource,
        sdkConnected: sourceOverlayContext.sdkConnected,
        sdkHasData: sourceOverlayContext.sdkHasData,
        sdkHasAutomationData: sourceOverlayContext.sdkHasAutomationData,
        sdkSource: sourceOverlayContext.sdkSource,
        reliability: autopilotReliabilityForRecording,
      });

      if (!capabilities.isMock && !recordingBundleFailureHandling && flightCsvWriter.isRecording?.() === true) {
        try {
          const csvRecordingStats = flightCsvWriter.getStats?.();
          const automationRecordingStats = automationJsonlRecorder.getStats?.();
          if (
            !csvRecordingStats?.recordingSessionId
            || csvRecordingStats.recordingSessionId !== automationRecordingStats?.recordingSessionId
            || csvRecordingStats.recordingSessionId !== flightRecordingSessionId
          ) {
            throw new Error('Recording bundle session identity mismatch');
          }
          automationJsonlRecorder.recordAutopilotState({
            timeMs: nowEpochMs,
            timestampIso,
            flightElapsedMs: computeElapsedMs(nowEpochMs, flightRecordingStartEpochMs),
            flightId,
            flightStartIso: flightRecordingStartIso,
            aircraftProfileId: activeProfile?.id || 'generic',
            aircraftTitle: frame?.simconnect?.aircraftLoadedName || flightStartAircraftTitle || null,
            dataSource: dataSourceInfo?.primary?.type || null,
            fdm: finalOverlay,
            baseFdm: fdmForFuel,
            simconnect: frame?.simconnect || null,
            reliability: autopilotReliabilityForRecording,
            sourceContext: sourceOverlayContext,
          });
        } catch (err) {
          console.warn('[automation-jsonl] Autopilot state write failed:', err?.message || String(err));
        }
      }
    }

    if (frame.assists) {
      broadcast({ type: MSG.ASSISTS, data: frame.assists });
    }

    try {
      const attitudeValid = frame && frame.attitudeValid === true;
      const pitchRad = attitudeValid && typeof frame.pitch === 'number' ? frame.pitch : null;
      const bankRad = attitudeValid && typeof frame.bank === 'number' ? frame.bank : null;
      const dbg = frame && frame.attitudeDebug && typeof frame.attitudeDebug === 'object'
        ? frame.attitudeDebug
        : null;
      sendAttitude(broadcast, {
        valid: attitudeValid,
        pitchDeg: attitudeValid && typeof pitchRad === 'number' ? rad2deg(pitchRad) : null,
        bankDeg: attitudeValid && typeof bankRad === 'number' ? rad2deg(bankRad) : null,
        pitchRad,
        bankRad,
        pitchSource: dbg ? dbg.pitchSource : undefined,
        bankSource: dbg ? dbg.bankSource : undefined,
        pitchRaw: dbg ? dbg.pitchRaw : undefined,
        bankRaw: dbg ? dbg.bankRaw : undefined,
        pitchDegPrimary: dbg ? dbg.pitchDegPrimary : undefined,
        bankDegPrimary: dbg ? dbg.bankDegPrimary : undefined,
        pitchModePrimary: dbg ? dbg.pitchModePrimary : undefined,
        bankModePrimary: dbg ? dbg.bankModePrimary : undefined,
      });
    } catch {}

    const normalizedSurface = normalizeSurface(surface, wow);
    sendSurface(broadcast, normalizedSurface);
    sendPosition(broadcast, { lat: frame.lat, lon: frame.lon, hdg: heading });

    sendControls(broadcast, {
      yokeX: fdmForFuel.yokeXPct != null ? fdmForFuel.yokeXPct / 100 : null,
      yokeY: fdmForFuel.yokeYPct != null ? fdmForFuel.yokeYPct / 100 : null,
      rudderPedalPct: fdmForFuel.rudderPedalPct,
    });

    const gearDecoded = overlayParkingBrakeSources({
      gear: decodeGearState(frame),
      profile: activeProfile,
      sourceContext: sourceOverlayContext,
    });

    const gearBroadcast = computeGearBroadcastState({
      gear: gearDecoded,
      gearHandleDown: frame?.gearHandle,
      previousGearState: runtimeState.broadcast.lastGearState,
      previousParkingBrake: runtimeState.broadcast.lastGearParkingBrake,
    });
    runtimeState.broadcast.lastGearState = gearBroadcast.nextGearState;
    runtimeState.broadcast.lastGearParkingBrake = gearBroadcast.nextParkingBrake;
    sendGear(broadcast, gearBroadcast.payload);

    const approachConfiguredForPhase = deriveApproachConfigurationState({
      gearDownLocked,
      gearConfigurationAvailable: typeof frame?.gearConfigurationAvailable === 'boolean'
        ? frame.gearConfigurationAvailable
        : null,
      flaps: flapsObj,
      flapsConfigurationAvailable: typeof frame?.flapsConfigurationAvailable === 'boolean'
        ? frame.flapsConfigurationAvailable
        : null,
    });

    const scForPhase = frame && frame.simconnect;
    const { phase } = updatePhase({
      iasKts: iasKnots,
      wow,
      vsFpm: vsFeetPerMin,
      raFt: raFeet,
      gsKts: gs,
      altMslFt: alt_msl_ft,
      approachConfigured: approachConfiguredForPhase,
      aircraftName: (scForPhase && scForPhase.aircraftLoadedName) || null,
      onRunway: typeof normalizedSurface?.onRunway === 'boolean'
        ? normalizedSurface.onRunway
        : (typeof normalizedSurface?.runwayLike === 'boolean' ? normalizedSurface.runwayLike : null),
    }, broadcast);

    broadcastFlightTimeIfDue(nowEpochMs, timestampIso);
    resetStabilityForHighAltOrParked(raFeet, phase);

    const fdmForVisibility = mergeFdmData(frame.fdm, frame.simconnect);
    const visibilityM = fdmForVisibility?.visibilityM ?? null;

    const stability = runStability({
      ias,
      vs,
      ra,
      display,
      alt_msl_ft,
      altCalibratedFt: frame.fdm?.altCalibratedFt ?? null,
      altPlaneFt: frame.fdm?.altPlaneFt ?? null,
      pressureAltFt: frame.fdm?.pressureAltFt ?? null,
      aircraftAglFt: frame.fdm?.aircraftAglFt ?? null,
      aircraftAboveObstaclesFt: frame.fdm?.aircraftAboveObstaclesFt ?? null,
      planeAglFt: frame.fdm?.planeAglFt ?? null,
      planeAglMinusCgFt: frame.fdm?.planeAglMinusCgFt ?? null,
      gearDownLocked,
      lights,
      flaps,
      spoilers: spoilersObj,
      pitch,
      bank,
      heading,
      lat: frame.lat,
      lon: frame.lon,
      engineLevels,
      gs,
      wow,
      dtMs: evaluationDeltaMs,
      visibilityM,
    });

    const { trend, nextPreviousIAS } = computeIasTrend({ ias, previousIAS });
    const trendKnots = Math.round(trend);
    broadcast({ type: MSG.IAS_TREND, value: trendKnots });
    previousIAS = nextPreviousIAS;

    const dtSeconds = evaluationDeltaMs / 1000;
    const {
      pitchRateDeg,
      bankRateDeg,
      nextPreviousPitch,
      nextPreviousBank,
    } = computePitchBankRates({
      previousPitch,
      previousBank,
      pitch,
      bank,
      dtSeconds,
    });

    broadcast({
      type: MSG.RATES,
      pitchRate: pitchRateDeg,
      bankRate: bankRateDeg,
    });

    previousPitch = nextPreviousPitch;
    previousBank = nextPreviousBank;

    return {
      spoilersObj,
      flapsView: flapsObj,
      ias,
      vs,
      ra,
      wow,
      gearDownLocked,
      flaps,
      pitch,
      bank,
      gs,
      windSpeed,
      windDir,
      heading,
      surface,
      timestamp,
      xwind,
      iasKnots,
      raFeet,
      vsFeetPerMin,
      alt_msl_ft,
      phase,
      stability,
      trend,
      pitchRateDeg,
      bankRateDeg,
      hdgMagDegStream,
      hdgTrueDegStream,
      fdmForRecording,
      autopilotReliabilityForRecording,
      stabilityDtMs: evaluationDeltaMs,
    };
  }

  function processVreSampleLogging(frame: AnyRecord, {
    nowEpochMs,
    slewActiveNow,
    spoilersObj,
    flapsView,
    wow,
    gearDownLocked,
    flaps,
    pitch,
    bank,
    gs,
    windSpeed,
    windDir,
    heading,
    timestamp,
    xwind,
    iasKnots,
    raFeet,
    vsFeetPerMin,
    alt_msl_ft,
    trend,
    pitchRateDeg,
    bankRateDeg,
    fdmForRecording,
    autopilotReliabilityForRecording,
  }: AnyRecord) {
    if (!flightActive || capabilities.isMock) return;

    const now = nowEpochMs;

    const resolvedFlapsView = flapsView || makeFlapsObj(frame.flaps, frame.flapsIndex, frame.flapsAngleDeg);
    const spoilerPct = spoilersObj && typeof spoilersObj.percent === 'number' ? spoilersObj.percent : null;
    const spoilerState = spoilersObj && typeof spoilersObj.state === 'string' ? spoilersObj.state : null;
    const spoilerAvailable = spoilersObj?.available === false ? false : spoilerPct !== null;
    const spoilerSource = spoilerAvailable ? (spoilersObj?._source ?? 'simconnect') : null;

    const vreFrame = buildVreEvaluationFrame({
      frame,
      vsFeetPerMin,
      raFeet,
      pitchRateDeg,
      bankRateDeg,
      gs,
      gearDownLocked,
      flapsNotch: resolvedFlapsView?.notch ?? null,
      spoilerState,
      wow,
      pitch,
      bank,
      phase: getPhase(),
    });

    const vreResult = vreEvaluator.evaluate(vreFrame);
    const vreSamplingRate = resolveVreSamplingRate(vreResult.rateHz, frame.pollRateMs);
    const vreCsvSampleDue = vreResult.shouldSample && isVreCsvSampleDue(
      now,
      lastVreCsvWriteAttemptTs,
      vreSamplingRate.intervalMs,
    );
    publishVreSamplingStatus(
      { ...vreResult, shouldSample: vreCsvSampleDue },
      vreFrame,
      { pollRateMs: frame.pollRateMs },
    );

    if (!vreCsvSampleDue) return;

    const phaseStr = getPhase();
    const stableStr = '--';

    try {
      const sc = frame && frame.simconnect;
      const aircraftName = (sc && sc.aircraftLoadedName) || null;

      const throttleSnapshot = frame.throttle || null;

      const { hdgTrueDeg, hdgMagDeg, magvarDeg } = computeHeadingAndMagvar({
        sc,
        fallbackTrueHeadingDeg: heading,
        fallbackMagvarDeg: frame.magvar,
      });

      const currentProfile = profileLoader.getActiveProfile();
      const profileId = currentProfile?.id || 'generic';

      const overallReliability = deriveOverallSignalReliability(currentProfile?.signalReliability);
      const { pitchDeg, bankDeg } = normalizePitchBankDegrees({ pitch, bank });
      const { thr1Pct, thr2Pct, thr3Pct, thr4Pct } = extractThrottlePercents(throttleSnapshot);
      const brakePct = computeBrakePct(frame);

      const fdmMerged = fdmForRecording || mergeFdmData(frame.fdm, sc);
      const elapsedMs = computeElapsedMs(nowEpochMs, flightStartEpochMs);

      const enrichedFrame = buildVreEnrichedFrame({
        frame,
        nowEpochMs,
        timestampIso: timestamp,
        flightId,
        flightStartIso,
        flightStartEpochMs,
        sampleRateHz: vreSamplingRate.effectiveRateHz,
        escalationReason: vreResult.escalationString,
        phase: phaseStr,
        stability: stableStr,
        iasKnots,
        gs,
        vsFeetPerMin,
        altMslFt: alt_msl_ft,
        raFeet,
        xwind,
        trend,
        headingData: { hdgTrueDeg, hdgMagDeg, magvarDeg },
        pitchDeg,
        bankDeg,
        maxPitchBankDeg: MAX_PITCH_BANK_DEG,
        windSpeed,
        windDir,
        gearDownLocked,
        flapsNotch: resolvedFlapsView?.notch,
        flaps,
        flapsSource: resolvedFlapsView?.source ?? null,
        spoilerPct,
        spoilerState,
        spoilerSource,
        spoilerAvailable,
        brakePct,
        thr1Pct,
        thr2Pct,
        thr3Pct,
        thr4Pct,
        profileId,
        signalReliability: overallReliability,
        dataSource: getDataSourceInfo().primary?.type || null,
        aircraftName,
        fdm: fdmMerged,
        autopilotReliability: autopilotReliabilityForRecording,
        elapsedMs,
        userId: getUserId(),
        sessionId: getSessionId(),
      });

      const shouldSuppressForSlew = SLEW_SUPPRESS_SAMPLES && slewActiveNow;
      if (!capabilities.isMock && !recordingBundleFailureHandling && flightCsvWriter.isRecording() && !shouldSuppressForSlew) {
        lastVreCsvWriteAttemptTs = now;
        if (flightCsvWriter.writeSample(enrichedFrame)) {
          recordingSession.incrementSampleCount();
        }
      } else if (shouldSuppressForSlew) {
        slewSamplesSuppressed++;
      }
    } catch (e) {
      /* non-fatal */
    }
  }

  let lastStartDecisionLogTs = 0;

  // NOTE: telemetry "arming" gate removed in favor of flightActive lifecycle.

  const targetPeriodMs = Math.max(1, Number.isFinite(pollRateMs) ? pollRateMs : 100);

  // Create TickFrame factory for deterministic tick-based evaluation.
  const tickFrameFactory = createTickFrameFactory({
    timeSource,
    pollRateMs: targetPeriodMs,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN TELEMETRY LOOP
  // 
  // The loop is serial: one cycle completes before the next begins, so work
  // can run late but TickFrames cannot queue up or execute concurrently.
  //
  // Tick pipeline (high-level order):
  // 1) Acquire frame + build TickFrame snapshot
  // 2) processFlightEndAndSafetyGuards()
  // 3) processFlightLifecycleGate() disconnected guard before live broadcasts
  // 4) processThrottleAndEngineBroadcast()
  // 5) processStreamingAndScoring()
  // 6) processFlightLifecycleGate() with early-continue for blocked states
  // 7) processVreSampleLogging()
  // 8) updateLandingRunnerIfEnabled()
  // 9) (reserved for future asymmetry hook)
  // ═══════════════════════════════════════════════════════════════════════════
  try {
  let isFirstIteration = true;

  while (!isShutdownRequested(shutdownSignal)) {
    // Every continue returns through this yield and wait. The serial loop
    // deliberately does not schedule catch-up work.
    if (!isFirstIteration) {
      await new Promise((r) => setImmediate(r));
      if (isShutdownRequested(shutdownSignal)) break;
      const waitResult = await waitForShutdownOrTimeout(shutdownSignal, targetPeriodMs);
      if (waitResult === 'shutdown') break;
    }
    isFirstIteration = false;
    if (isShutdownRequested(shutdownSignal)) break;

    const acquisition = await waitForNextFrameOrShutdown(provider, shutdownSignal);
    if (acquisition.status === 'shutdown' || isShutdownRequested(shutdownSignal)) break;

    const rawFrame = acquisition.frame;
    const frame = tickFrameFactory.create(rawFrame);
    runtimeState.sim.latestTickFrame = frame;

    // Track previous frame for telemetry activity detection
    // Retain only the primitive fields used for comparison to bound memory use.
    const activeFieldCount = countActiveTelemetryFields(frame, previousFrameForActivity, telemetryActivityThresholds);
    previousFrameForActivity = extractActivityFields(frame);

    // Capture VS0 from first telemetry frame after aircraft change
    // This enables ICAO category inference for unknown aircraft
    if (pendingVs0Capture && frame?.designSpeedVs0Kts) {
      profileLoader.setVs0FromSimConnect(frame.designSpeedVs0Kts);
      pendingVs0Capture = false;  // Only capture once per aircraft load
    }

    // Emit the same canonical frame used by every internal evaluator.
    eventBus.emit('telemetry:frame', frame);

    const nowEpochMs = frame.meta.timestampMs;
    const timestampIso = frame.meta.timestampIso;

    // Get SimConnect state for flight lifecycle checks
    const scLifecycle = frame && frame.simconnect;
    const simconnectConnectedForLifecycle = scLifecycle && scLifecycle.connected;

    const slewActiveNow = processFlightEndAndSafetyGuards(frame, nowEpochMs, simconnectConnectedForLifecycle);

    const activeProfileForEngineCount = profileLoader.getActiveProfile();
    const engineLevels = getEngineLevels(
      frame,
      getProfileEngineCount(activeProfileForEngineCount) || 4,
    );
    const displayForLifecycle = frame?.display || {};
    const lifecycleIasKnots = Number.isFinite(displayForLifecycle.iasKts) ? displayForLifecycle.iasKts : (Number.isFinite(frame?.ias) ? frame.ias : 0);
    const lifecycleGs = Number.isFinite(displayForLifecycle.gsKts) ? displayForLifecycle.gsKts : (Number.isFinite(frame?.gs) ? frame.gs : 0);
    const lifecycleRaFeet = Number.isFinite(displayForLifecycle.raFt) ? displayForLifecycle.raFt : (Number.isFinite(frame?.ra) ? frame.ra : 0);
    const lifecycleWow = frame?.wow === true;

    // ------------------------------
    // START MOTION DETECTOR (IAS/GS delta over window)
    // ------------------------------
    const motion = updateMotionDetector({
      flightActive,
      requireMovement: FLIGHT_START_REQUIRE_MOVEMENT,
      windowMs: FLIGHT_START_MOVE_WINDOW_MS,
      minIasDeltaKts: FLIGHT_START_MOVE_IAS_DELTA_KTS,
      minGsDeltaKts: FLIGHT_START_MOVE_GS_DELTA_KTS,
      nowEpochMs,
      iasKnots: lifecycleIasKnots,
      gs: lifecycleGs,
      baseline: motionBaseline,
    });
    motionBaseline = motion.baseline;

    // ------------------------------
    // FLIGHT LIFECYCLE (disconnected gate before any live-stream broadcasts)
    // ------------------------------
    const maxEngine = engineLevels.length ? Math.max(...engineLevels) : 0;
    const lifecycleGateBase = {
      frame,
      nowEpochMs,
      timestampIso,
      activeFieldCount,
      motion,
      engineLevels,
      maxEngine,
    };

    if (!simconnectConnectedForLifecycle) {
      streamingContinuityBroken = true;
      processFlightLifecycleGate({
        ...lifecycleGateBase,
        iasKnots: lifecycleIasKnots,
        gs: lifecycleGs,
        raFeet: lifecycleRaFeet,
        wow: lifecycleWow,
      });
      aircraftSpecificStateProjector.update({
        frame,
        simState: runtimeState.sim.lastState,
        nowEpochMs,
        timestampIso,
      });
      continue;
    }

    // Throttle snapshot broadcast timing (must remain early in connected live ticks)
    processThrottleAndEngineBroadcast(frame);

    const {
      spoilersObj,
      flapsView,
      ias,
      vs,
      ra,
      wow,
      gearDownLocked,
      flaps,
      pitch,
      bank,
      gs,
      windSpeed,
      windDir,
      heading,
      surface,
      timestamp,
      xwind,
      iasKnots,
      raFeet,
      vsFeetPerMin,
      alt_msl_ft,
      phase,
      stability,
      trend,
      pitchRateDeg,
      bankRateDeg,
      hdgMagDegStream,
      hdgTrueDegStream,
      fdmForRecording,
      autopilotReliabilityForRecording,
      stabilityDtMs,
    } = processStreamingAndScoring(frame, {
      timestampIso,
      nowEpochMs,
      targetPeriodMs: frame.pollRateMs,
      engineLevels,
    });

    // ------------------------------
    // FLIGHT LIFECYCLE (flightActive gate)
    // ------------------------------
    const shouldSkipTick = processFlightLifecycleGate({
      ...lifecycleGateBase,
      iasKnots,
      gs,
      raFeet,
      wow,
    });
    aircraftSpecificStateProjector.update({
      frame,
      simState: runtimeState.sim.lastState,
      nowEpochMs,
      timestampIso,
    });
    if (shouldSkipTick) {
      continue;
    }
    processVreSampleLogging(frame, {
      nowEpochMs,
      slewActiveNow,
      spoilersObj,
      flapsView,
      ias,
      vs,
      ra,
      wow,
      gearDownLocked,
      flaps,
      pitch,
      bank,
      gs,
      windSpeed,
      windDir,
      heading,
      surface,
      timestamp,
      xwind,
      iasKnots,
      raFeet,
      vsFeetPerMin,
      alt_msl_ft,
      stability,
      trend,
      pitchRateDeg,
      bankRateDeg,
      fdmForRecording,
      autopilotReliabilityForRecording,
    });

    // LANDING EVENT (delegated)
    updateLandingRunnerIfEnabled(
      frame,
      xwind,
      stability,
      nowEpochMs,
      timestampIso,
      phase,
      hdgMagDegStream,
      hdgTrueDegStream,
      { iasKts: iasKnots, vsFpm: vsFeetPerMin, pitchDeg: pitch, bankDeg: bank, pitchRateDeg, bankRateDeg },
      stabilityDtMs,
      flapsView,
    );

    // ENGINE ASYMMETRY DETECTION hook reserved for future implementation.
  }
  } finally {
    await shutdownCore();
  }
}

module.exports = {
  createProviderBroadcastRelay,
  runSimbridgeCore,
  snapshotStabilityScoringInputs,
  resolveRecordedStabilityScoringInputs,
};

export {};
