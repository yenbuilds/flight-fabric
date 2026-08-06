// config.ts
// Centralized configuration module. ALL env var parsing happens here.
// Modules import config values instead of reading process.env directly.
//
// No module except config.ts should reference process.env.
//
// Priority (highest to lowest):
//   1. Environment variables (always win)
//   2. User settings file (Flight Fabric app-data settings.json)
//   3. Built-in defaults
//
// The simulator telemetry poll interval is a fixed runtime safety invariant,
// not a user setting or environment override.

type UserSettings = Record<string, unknown>;

type GetSettingFn = <T>(
  settings: UserSettings,
  settingPath: string,
  envVar: string,
  defaultValue: T,
) => T;

type SimConnectProvider = 'auto' | 'rust';
type SimulatorProtocol = 'KittyHawk' | 'XPLANE_WEB';
type CsvWriterMode = 'inline' | 'worker';

const env = process.env as Record<string, string | undefined>;

// -----------------------------------------------------------------------------
// User Settings (loaded from the Flight Fabric app-data settings file)
// -----------------------------------------------------------------------------
const { settings: userSettings, getSetting } = require('./user-settings.js') as {
  settings: UserSettings;
  getSetting: GetSettingFn;
};
const { FIXED_TELEMETRY_POLL_RATE_MS } = require('../../shared/app-settings-shared.js') as {
  FIXED_TELEMETRY_POLL_RATE_MS: number;
};
const { resolveXPlaneStartupSelection } = require('./xplane-startup-gate.js') as {
  resolveXPlaneStartupSelection: (options: {
    explicitEnable?: boolean;
    cliRequested?: boolean;
    simulatorProtocol?: unknown;
  }) => {
    simulatorProtocol: SimulatorProtocol;
  };
};

// -----------------------------------------------------------------------------
// Helper functions for parsing env vars
// -----------------------------------------------------------------------------

function int(key: string, defaultVal: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultVal;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultVal;
}

function float(key: string, defaultVal: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultVal;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : defaultVal;
}

function bool(key: string, defaultVal: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultVal;
  return raw === '1' || raw === 'true';
}

function str<T extends string | null>(key: string, defaultVal: T): string | T {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultVal;
  return raw;
}

function normalizeSimConnectProvider(raw: unknown): SimConnectProvider {
  const value = String(raw || '').trim().toLowerCase();
  switch (value) {
    case 'rust':
      return 'rust';
    default:
      return 'auto';
  }
}

function normalizeSimulatorProtocol(raw: unknown): SimulatorProtocol {
  return String(raw || '').trim().toUpperCase() === 'XPLANE_WEB'
    ? 'XPLANE_WEB'
    : 'KittyHawk';
}

function normalizeCsvWriterMode(raw: unknown): CsvWriterMode {
  const value = String(raw || '').trim().toLowerCase();
  return value === 'worker' ? 'worker' : 'inline';
}

// -----------------------------------------------------------------------------
// Environment Mode Detection
// -----------------------------------------------------------------------------
// FLIGHT_ENV_MODE determines dev vs packaged behavior:
//   'dev'      - Full logging, no limits (your local dev environment)
//   'packaged' - Rolling buffer, fixed-size storage, disk-safe (Electron release)
//   'auto'     - Auto-detect: 'packaged' if ELECTRON_PACKAGED=1, else 'dev'
//
// Electron main.js sets ELECTRON_PACKAGED=1 when app.isPackaged is true.
const envModeRaw = str('FLIGHT_ENV_MODE', 'auto');
const isElectronPackaged = bool('ELECTRON_PACKAGED', false);
const isElectronBackend = env.FF_ELECTRON_BACKEND === '1' || env.ELECTRON_RUN_AS_NODE === '1';
const isLocalBatchLaunch = env.FF_LOCAL_BAT_LAUNCH === '1';
const stabilityDebugLogBlocked = isElectronPackaged || isElectronBackend || isLocalBatchLaunch;
// pkg sets process.pkg when bundled into a standalone binary.
const isPkgPackaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
const envMode = envModeRaw === 'auto'
  ? ((isElectronPackaged || isPkgPackaged) ? 'packaged' : 'dev')
  : envModeRaw;
const simConnectProvider = normalizeSimConnectProvider(str('SIMCONNECT_PROVIDER', 'auto'));
const requestedSimulatorProtocol = normalizeSimulatorProtocol(
  str('SIMCONNECT_PROTOCOL', getSetting(userSettings, 'simulator.protocol', 'SIMCONNECT_PROTOCOL', 'KittyHawk')),
);
const xplaneExperimentalEnable = bool('FF_ENABLE_EXPERIMENTAL_XPLANE', false);
const simulatorProtocol = resolveXPlaneStartupSelection({
  explicitEnable: xplaneExperimentalEnable,
  cliRequested: process.argv.includes('--xplane'),
  simulatorProtocol: requestedSimulatorProtocol,
}).simulatorProtocol;
const csvWriterMode = normalizeCsvWriterMode(str('CSV_WRITER_MODE', 'worker'));
const remoteAccessEnable = bool(
  'REMOTE_ACCESS_ENABLE',
  getSetting(userSettings, 'network.remoteAccess', 'REMOTE_ACCESS_ENABLE', false),
);
const remoteAircraftControlEnable = remoteAccessEnable && bool(
  'REMOTE_AIRCRAFT_CONTROL_ENABLE',
  getSetting(userSettings, 'network.remoteAircraftControl', 'REMOTE_AIRCRAFT_CONTROL_ENABLE', false),
);

// -----------------------------------------------------------------------------
// Configuration object (frozen to prevent accidental mutation)
// -----------------------------------------------------------------------------
const config = Object.freeze({
  // ---------------------------------------------------------------------------
  // Environment Mode
  // ---------------------------------------------------------------------------
  env: Object.freeze({
    mode: envMode, // 'dev' | 'packaged'
    isDev: envMode === 'dev',
    isPackaged: envMode === 'packaged',
    isElectronPackaged, // True only when running inside packaged Electron
    isElectronBackend, // True when the backend was launched by Electron
    isLocalBatchLaunch, // True when started from start-simbridge.bat
    isPkgPackaged, // True only when running inside pkg-built binary
    parentStdinLifeline: bool('FF_PARENT_STDIN_LIFELINE', false),
  }),

  // ---------------------------------------------------------------------------
  // Debug & Logging
  // ---------------------------------------------------------------------------
  debug: Object.freeze({
    // Support/developer-only switch. User settings cannot enable backend debug events.
    enable: bool('DEBUG_ENABLE', false),
    flightLifecycleConsoleLog: bool('FLIGHT_LIFECYCLE_CONSOLE_LOG', false),
    flightLifecycleConsoleVerbose: bool('FLIGHT_LIFECYCLE_CONSOLE_VERBOSE', false),
  }),

  // ---------------------------------------------------------------------------
  // Poll & Timing
  // ---------------------------------------------------------------------------
  poll: Object.freeze({
    rateMs: FIXED_TELEMETRY_POLL_RATE_MS,
    intervalMs: FIXED_TELEMETRY_POLL_RATE_MS,
  }),

  // ---------------------------------------------------------------------------
  // WebSocket Server
  // ---------------------------------------------------------------------------
  ws: Object.freeze({
    port: int('SIMBRIDGE_WS_PORT', getSetting(userSettings, 'network.wsPort', 'SIMBRIDGE_WS_PORT', 8099)),
  }),

  // ---------------------------------------------------------------------------
  // HTTP/WS Server (remote device access)
  // Remote access enables mobile/tablet connections over LAN.
  // Disabled by default; users can opt in from Settings when needed.
  // ---------------------------------------------------------------------------
  http: Object.freeze({
    // Bind to all interfaces (0.0.0.0) for LAN access, or localhost (127.0.0.1) for local-only
    remoteAccessEnable,
    // Narrow opt-in: same-origin trusted-LAN browsers may send aircraft controls only.
    remoteAircraftControlEnable,
    port: int('HTTP_PORT', getSetting(userSettings, 'network.httpPort', 'HTTP_PORT', 8100)),
  }),

  // ---------------------------------------------------------------------------
  // Networked Public Services
  // Automatic update checks are enabled by default, but opt-out.
  // ---------------------------------------------------------------------------
  updates: Object.freeze({
    enabled: bool('UPDATE_CHECKS_ENABLED', getSetting(userSettings, 'network.updateChecks', 'UPDATE_CHECKS_ENABLED', true)),
  }),

  // ---------------------------------------------------------------------------
  // Flight Logging
  // ---------------------------------------------------------------------------
  logging: Object.freeze({
    intervalMs: int('FLIGHT_LOG_INTERVAL_MS', 1000),
    root: str('FLIGHT_LOG_ROOT', 'logs'),
    // Rolling buffer settings (only active in packaged mode)
    // In dev mode: unlimited logging (rollingBufferEnable defaults to false)
    // In packaged mode: fixed-size rolling buffer (prevents disk exhaustion)
    rollingBufferEnable: envMode === 'packaged'
      ? bool('ROLLING_BUFFER_ENABLE', true) // Default ON in packaged
      : bool('ROLLING_BUFFER_ENABLE', false), // Default OFF in dev
    rollingBufferMaxMb: int('ROLLING_BUFFER_MAX_MB', 500), // Max total size in MB
    rollingBufferMaxFiles: int('ROLLING_BUFFER_MAX_FILES', 50), // Max number of flight logs
    rollingBufferMaxAgeDays: int('ROLLING_BUFFER_MAX_AGE_DAYS', 30), // Auto-delete after N days
  }),

  // ---------------------------------------------------------------------------
  // Flight Lifecycle
  // ---------------------------------------------------------------------------
  flightStart: Object.freeze({
    requireCount: Math.max(1, int('FLIGHT_START_REQUIRE_COUNT', 2)),
    iasKts: float('FLIGHT_START_IAS_KTS', 40),
    gsKts: float('FLIGHT_START_GS_KTS', 20),
    raFt: float('FLIGHT_START_RA_FT', 10),
    requireMovement: bool('FLIGHT_START_REQUIRE_MOVEMENT', true),
    moveWindowMs: Math.max(0, int('FLIGHT_START_MOVE_WINDOW_MS', 3000)),
    moveIasDeltaKts: Math.max(0, float('FLIGHT_START_MOVE_IAS_DELTA_KTS', 2)),
    moveGsDeltaKts: Math.max(0, float('FLIGHT_START_MOVE_GS_DELTA_KTS', 2)),
    // Globe view rejection: MSFS menu uses an internal "aircraft" at ~100,000+ ft
    // Real aircraft ceiling is ~45,000ft (civilian) or ~85,000ft (SR-71).
    // Reject flight start if MSL altitude exceeds this ceiling.
    maxAltMslFt: float('FLIGHT_START_MAX_ALT_MSL_FT', 60000), // 60,000 ft ceiling
    // Telemetry activity detection: require minimum number of actively updating variables
    // to distinguish active flight from menu state (where only ~3 variables update)
    requireTelemetryActivity: bool('FLIGHT_START_REQUIRE_TELEMETRY_ACTIVITY', false), // Opt-in while menu-state detection remains the default policy
    minActiveFields: Math.max(0, int('FLIGHT_START_MIN_ACTIVE_FIELDS', 5)), // Require at least 5 actively updating fields
  }),

  // Flight End Detection (auto-end when parked with engines off)
  // Conservative: requires PARKED phase + all engines off for N seconds
  flightEnd: Object.freeze({
    parkedEnginesOffMs: Math.max(0, int('FLIGHT_END_PARKED_ENGINES_OFF_MS', 60000)), // 60s default
    parkedEnginesOffEnable: bool('FLIGHT_END_PARKED_ENGINES_OFF_ENABLE', true),
  }),

  // Slew-state handling for telemetry continuity and flight segmentation.
  slew: Object.freeze({
    // Block flight start while slewing to prevent false lifecycle transitions.
    blockFlightStart: bool('SLEW_BLOCK_FLIGHT_START', true),
    // Suppress CSV samples during slew and preserve a recording gap.
    suppressSamples: bool('SLEW_SUPPRESS_SAMPLES', true),
    // End flight if slew persists for this long (0 = never auto-end)
    autoEndFlightMs: Math.max(0, int('SLEW_AUTO_END_FLIGHT_MS', 0)), // Disabled by default
  }),

  // ---------------------------------------------------------------------------
  // Phase Detection
  // ---------------------------------------------------------------------------
  phase: Object.freeze({
    holdSamples: int('PHASE_HOLD_SAMPLES', 8),
    groundHoldSamples: int('PHASE_GROUND_HOLD_SAMPLES', 2), // Lower threshold for PARKED<->TAXI
    minDwellMs: int('PHASE_MIN_DWELL_MS', 2000),
    // 45s: filters turbulence-induced VS excursions (brief -900 fpm gusts in cruise
    // easily last 8-15s; genuine top-of-descent is a sustained multi-minute event).
    // Step-down approach legs (30-60s) are fine: once DESCENT is first confirmed,
    // the FSM stays there across brief level-offs (descentToCruiseConfirmMs gate).
    // Previous value 8s was too aggressive; brief downdrafts triggered DESCENT.
    descentConfirmMs: int('PHASE_DESCENT_CONFIRM_MS', 45000),
    climbConfirmMs: int('PHASE_CLIMB_CONFIRM_MS', 8000),
    // 45s: once CRUISE is established, short altitude-capture / VNAV cleanup
    // bursts above the climb VS gate should not flip the timeline back to CLIMB.
    // A real en-route step climb remains visible after sustained positive VS.
    cruiseToClimbConfirmMs: int('PHASE_CRUISE_TO_CLIMB_CONFIRM_MS', 45000),
    // 90s: after the 10-min takeoff gate expires, en-route ATC step restrictions
    // (e.g. level at FL200 for traffic) should not trigger CRUISE. Genuine top-of-
    // climb levels off for many hours; 90s of sustained level flight is a minimal
    // bar that cleanly separates a real cruise level-off from a transient one.
    // Previous value 10s meant any 10-second level-off at altitude flipped phase.
    cruiseConfirmMs: int('PHASE_CRUISE_CONFIRM_MS', 90000),
    // Extended IDLE timeout to re-enter CRUISE from DESCENT (handles ATC steps)
    descentToCruiseConfirmMs: int('PHASE_DESCENT_TO_CRUISE_CONFIRM_MS', 60000),
    // Max altitude drop (ft MSL) from descent-start before CRUISE re-entry is permanently
    // blocked for that descent. Genuine step-down cruise re-assignments are typically
    // 1000-4000ft; approach descents are 10,000-35,000ft. 0 = disabled.
    descentToCruiseMaxDropFt: int('PHASE_DESCENT_TO_CRUISE_MAX_DROP_FT', 5000),
    // Minimum flight time after takeoff before CRUISE can trigger.
    // Prevents SID level-offs (e.g., EGLL 6000ft constraint) from triggering CRUISE.
    // Default 10 minutes - airliners rarely reach cruise altitude faster than this.
    minFlightTimeForCruiseMs: int('PHASE_MIN_FLIGHT_TIME_FOR_CRUISE_MS', 600000),
    levelBandFpm: float('PHASE_LEVEL_BAND_FPM', Number.NaN), // NaN means use default logic

    // Takeoff gating
    takeoffGatingEnable: bool('TAKEOFF_GATING_ENABLE', true),
    takeoffGatingWindowMs: int('TAKEOFF_GATING_WINDOW_MS', 3000),
    takeoffGatingRaFtMax: int('TAKEOFF_GATING_RA_FT_MAX', 800),
  }),

  // ---------------------------------------------------------------------------
  // Phase Thresholds (env overrides for phase.js)
  // ---------------------------------------------------------------------------
  phaseThresholds: Object.freeze({
    taxiMaxKts: float('TAXI_MAX_KTS', Number.NaN),
    parkedMaxKts: float('PARKED_MAX_KTS', Number.NaN),
    takeoffRollMinIasKts: float('TAKEOFF_ROLL_MIN_IAS_KTS', Number.NaN),
    takeoffMinIasKts: float('TAKEOFF_MIN_IAS_KTS', Number.NaN),
    takeoffMinVsFpm: float('TAKEOFF_MIN_VS_FPM', Number.NaN),
    takeoffMaxRaFt: float('TAKEOFF_MAX_RA_FT', Number.NaN),
    climbMinVsFpm: float('CLIMB_MIN_VS_FPM', Number.NaN),
    climbMinRaFt: float('CLIMB_MIN_RA_FT', Number.NaN),
    cruiseMinRaFt: float('CRUISE_MIN_RA_FT', Number.NaN),
    cruiseMinMslFt: float('CRUISE_MIN_MSL_FT', Number.NaN), // MSL altitude for cruise detection (default: 10000)
    cruiseMaxVsAbsFpm: float('CRUISE_MAX_VS_ABS_FPM', Number.NaN),
    descentMinRaFt: float('DESCENT_MIN_RA_FT', Number.NaN),
    descentMinVsFpm: float('DESCENT_MIN_VS_FPM', Number.NaN),
    approachMaxRaFt: float('APPROACH_MAX_RA_FT', Number.NaN),
    approachMinVsFpm: float('APPROACH_MIN_VS_FPM', Number.NaN),
    maxApproachKts: float('MAX_APPROACH_KTS', Number.NaN),
    landingMaxRaFt: float('LANDING_MAX_RA_FT', Number.NaN),
    landingMinVsFpm: float('LANDING_MIN_VS_FPM', Number.NaN),
    taxiInMaxKts: float('TAXI_IN_MAX_KTS', Number.NaN),
  }),

  // ---------------------------------------------------------------------------
  // Stability Scoring
  // ---------------------------------------------------------------------------
  stability: Object.freeze({
    debugLog: stabilityDebugLogBlocked ? false : bool('STABILITY_DEBUG_LOG', false),
    // Disabled intentionally: stability debug logging must stay altitude-gated.
    // Keep the exported value false so a stray environment variable cannot
    // widen logging to every altitude.
    debugAlwaysActive: false,
    gateRaFt: float('STABILITY_GATE_RA_FT', getSetting(userSettings, 'debrief.stabilityCriteria.gateRaFt', 'STABILITY_GATE_RA_FT', 1000)),
    speedMinusKts: float('STABILITY_SPEED_MINUS_KTS', getSetting(userSettings, 'debrief.stabilityCriteria.speedMinusKts', 'STABILITY_SPEED_MINUS_KTS', 5)),
    speedPlusKts: float('STABILITY_SPEED_PLUS_KTS', getSetting(userSettings, 'debrief.stabilityCriteria.speedPlusKts', 'STABILITY_SPEED_PLUS_KTS', 5)),
    vsMinFpm: float('STABILITY_VS_MIN_FPM', getSetting(userSettings, 'debrief.stabilityCriteria.vsMinFpm', 'STABILITY_VS_MIN_FPM', -1000)),
    vsMaxClimbFpm: float('STABILITY_VS_MAX_CLIMB_FPM', getSetting(userSettings, 'debrief.stabilityCriteria.vsMaxClimbFpm', 'STABILITY_VS_MAX_CLIMB_FPM', 200)),
    glidepathAngleDeg: float('STABILITY_GLIDEPATH_ANGLE_DEG', getSetting(userSettings, 'debrief.stabilityCriteria.glidepathAngleDeg', 'STABILITY_GLIDEPATH_ANGLE_DEG', 3)),
    glidepathVsDeltaMaxFpm: float('STABILITY_GLIDEPATH_VS_DELTA_MAX_FPM', getSetting(userSettings, 'debrief.stabilityCriteria.glidepathVsDeltaMaxFpm', 'STABILITY_GLIDEPATH_VS_DELTA_MAX_FPM', 200)),
    speedTrendMaxKtsPerSec: float('STABILITY_SPEED_TREND_MAX_KTS_PER_SEC', getSetting(userSettings, 'debrief.stabilityCriteria.speedTrendMaxKtsPerSec', 'STABILITY_SPEED_TREND_MAX_KTS_PER_SEC', 2.5)),
    thrustIdleMinPct: float('STABILITY_THRUST_IDLE_MIN_PCT', getSetting(userSettings, 'debrief.stabilityCriteria.thrustIdleMinPct', 'STABILITY_THRUST_IDLE_MIN_PCT', 15)),
    thrustStableMaxPctPerSec: float('STABILITY_THRUST_STABLE_MAX_PCT_PER_SEC', getSetting(userSettings, 'debrief.stabilityCriteria.thrustStableMaxPctPerSec', 'STABILITY_THRUST_STABLE_MAX_PCT_PER_SEC', 10)),
    pitchMinDeg: float('STABILITY_PITCH_MIN_DEG', getSetting(userSettings, 'debrief.stabilityCriteria.pitchMinDeg', 'STABILITY_PITCH_MIN_DEG', -5)),
    pitchMaxDeg: float('STABILITY_PITCH_MAX_DEG', getSetting(userSettings, 'debrief.stabilityCriteria.pitchMaxDeg', 'STABILITY_PITCH_MAX_DEG', 15)),
    bankMaxDeg: float('STABILITY_BANK_MAX_DEG', getSetting(userSettings, 'debrief.stabilityCriteria.bankMaxDeg', 'STABILITY_BANK_MAX_DEG', 25)),
    passPct: float('STABILITY_PASS_PCT', getSetting(userSettings, 'debrief.stabilityCriteria.passPct', 'STABILITY_PASS_PCT', 80)),
    highAltResetRaFt: int('STABILITY_HIGH_ALT_RESET_RA_FT', 5000),
  }),

  // ---------------------------------------------------------------------------
  // Variable Rate Encoding (flight-recording sample-rate escalation)
  // ---------------------------------------------------------------------------
  vre: Object.freeze({
    ultraFidelityEnable: bool('VRE_ULTRA_FIDELITY_ENABLE', true),
  }),

  // ---------------------------------------------------------------------------
  // Violation Detection Thresholds (aviation safety rules)
  // ---------------------------------------------------------------------------
  violationThresholds: Object.freeze({
    // Approach violations (only checked during APPROACH/LANDING phases)
    highSinkRateFpm: float('VIOLATION_HIGH_SINK_RATE_FPM', -1000), // VS below this triggers violation
    highSinkRateMinDurationMs: Math.max(0, int('VIOLATION_HIGH_SINK_RATE_MIN_DURATION_MS', 3000)),
    highSinkRateHysteresisFpm: Math.max(0, float('VIOLATION_HIGH_SINK_RATE_HYSTERESIS_FPM', 100)),
    excessiveBankDeg: float('VIOLATION_EXCESSIVE_BANK_DEG', 15), // Bank angle above this triggers violation
    excessIasDeviationKts: float('VIOLATION_EXCESS_IAS_DEVIATION_KTS', 15), // IAS deviation from ref triggers violation
    glidepathDeviationDots: float('VIOLATION_GLIDEPATH_DEVIATION_DOTS', 1.5), // GS deviation above this triggers violation

    // Cabin environment violations (checked throughout flight when airborne)
    cabinAltitudeWarningFt: float('VIOLATION_CABIN_ALTITUDE_WARNING_FT', 10000), // Hypoxia onset without supplemental O2
    cabinAltitudeCriticalFt: float('VIOLATION_CABIN_ALTITUDE_CRITICAL_FT', 14000), // Time of useful consciousness drops rapidly

    // Violation debounce (must persist for this long before being recorded)
    debounceMs: int('VIOLATION_DEBOUNCE_MS', 1000),

    // Upset / G-force detection (flight-violation-runner.js)
    // Hysteresis prevents chattering when values hover near the threshold boundary
    upsetHysteresisDeg: float('VIOLATION_UPSET_HYSTERESIS_DEG', 2), // deg: attitude clears only after retreating by this margin
    upsetMinDurationMs: int('VIOLATION_UPSET_MIN_DURATION_MS', 500), // ms: must persist this long before broadcasting (jitter guard)
    gForceAdvisoryG: float('VIOLATION_GFORCE_ADVISORY_G', 1.8), // g: generic load-factor caution
    gForceHighG: float('VIOLATION_GFORCE_HIGH_G', 2.5), // g: generic high-load alert; not an aircraft-specific structural limit
    gForceNegativeG: float('VIOLATION_GFORCE_NEGATIVE_G', -0.3), // g: negative G threshold (pushover / negative load)
    gForceHysteresis: float('VIOLATION_GFORCE_HYSTERESIS', 0.1), // g: G-force clears only after retreating by this margin
    approachOverspeedBufferKts: float('VIOLATION_APPROACH_OVERSPEED_BUFFER_KTS', 20),
    approachOverspeedHysteresisKts: float('VIOLATION_APPROACH_OVERSPEED_HYSTERESIS_KTS', 10),
    approachOverspeedMinDurationMs: int('VIOLATION_APPROACH_OVERSPEED_MIN_DURATION_MS', 2000),
  }),

  // ---------------------------------------------------------------------------
  // Aircraft Profile & Speed Reference
  // ---------------------------------------------------------------------------
  aircraft: Object.freeze({
    profile: str('AIRCRAFT_PROFILE', getSetting(userSettings, 'aircraft.profile', 'AIRCRAFT_PROFILE', 'auto')).toLowerCase(), // 'auto' = detect from SimConnect title
    vrefKts: float('VREF_KTS', Number.NaN),
    vrefAddKts: float('VREF_ADD_KTS', 0),
  }),

  // ---------------------------------------------------------------------------
  // Control Profile (for profile-driven aircraft control)
  // ---------------------------------------------------------------------------
  controlProfile: str('CONTROL_PROFILE', null),

  // ---------------------------------------------------------------------------
  // Touchdown camera shake
  // Disabled by default. Requires lvar-sidecar (LVAR_SIDECAR_AUTO_ENABLE or LVAR_SIDECAR_ENABLE).
  // ---------------------------------------------------------------------------
  touchdownShake: Object.freeze({
    enable: bool('TOUCHDOWN_SHAKE_ENABLE', getSetting(userSettings, 'effects.touchdownShake', 'TOUCHDOWN_SHAKE_ENABLE', false)),
  }),

  // LVAR sidecar runtime.
  // Disabled by default. When enabled, SimConnect provider can enrich frame.lvars
  // with values from the Rust sidecar bridge.
  //
  // `SIMCONNECT_PROVIDER` selects sidecar startup mode:
  //   auto -> use the Rust sidecar when it is available
  //   rust -> require the Rust sidecar
  // ---------------------------------------------------------------------------
  lvarSidecar: Object.freeze({
    enable: bool('LVAR_SIDECAR_ENABLE', false),
    autoEnable: bool('LVAR_SIDECAR_AUTO_ENABLE', true),
    provider: simConnectProvider,
    binaryPath: str('LVAR_SIDECAR_BINARY', ''),
    dllPath: str('FF_SIMCONNECT_DLL_PATH', getSetting(userSettings, 'simulator.simConnectDllPath', 'FF_SIMCONNECT_DLL_PATH', '')),
  }),

  // ---------------------------------------------------------------------------
  // Landing
  // ---------------------------------------------------------------------------
  landing: Object.freeze({
    rolloutWindowMs: int('LANDING_ROLLOUT_WINDOW_MS', 20000),
    touchdownCooldownMs: int('LANDING_TOUCHDOWN_COOLDOWN_MS', 6000),
    touchdownPreSampleWindowMs: int('LANDING_TOUCHDOWN_PRE_SAMPLE_WINDOW_MS', 350),
    // Touchdown validation: reject false touchdowns during sim load/teleport
    // A real landing requires meaningful airspeed OR descent rate
    touchdownMinIasKts: float('LANDING_TOUCHDOWN_MIN_IAS_KTS', 30),
    touchdownMinVsFpm: float('LANDING_TOUCHDOWN_MIN_VS_FPM', 50), // positive value, used as -X
    // Reject "touchdowns" that occur immediately after takeoff without the aircraft
    // ever climbing meaningfully (e.g., lifted off then sank straight back onto runway).
    // Requires the aircraft to have reached at least this radio-altitude (ft) while
    // airborne since the last ground contact before the next WOW transition is
    // accepted as a real touchdown.
    touchdownMinAirborneRaFt: float('LANDING_TOUCHDOWN_MIN_AIRBORNE_RA_FT', 50),
  }),

  // ---------------------------------------------------------------------------
  // Contract Check (diagnostic tool)
  // ---------------------------------------------------------------------------
  contractCheck: Object.freeze({
    durationSec: int('CONTRACT_CHECK_DURATION_SEC', 15),
  }),

  // ---------------------------------------------------------------------------
  // SimConnect
  // ---------------------------------------------------------------------------
  simconnect: Object.freeze({
    enable: str('SIMCONNECT_ENABLE', 'auto'),
    provider: simConnectProvider,
    // KittyHawk = supported MSFS 2024 path.
    // XPLANE_WEB = request the experimental X-Plane provider. Startup also
    // requires xplane.experimentalEnable to fail closed on stale settings.
    requestedProtocol: requestedSimulatorProtocol,
    protocol: simulatorProtocol,
    // Exit backend when MSFS shuts down (default: true for packaged, false for dev)
    exitOnClose: bool('SIMCONNECT_EXIT_ON_CLOSE', envMode === 'packaged'),
    chunkSize: int('SIMCONNECT_CHUNK_SIZE', 20),
    rustMaxVars: int('RUST_SIMVARS_MAX_VARS', 0), // 0 = let Rust try the full restored list
    rustStaleDisconnectMs: Math.max(3000, int('RUST_SIMVARS_STALE_DISCONNECT_MS', 12000)),
    facilitiesEnable: bool('MSFS_FACILITIES_ENABLE', true),
    // Disabled by default to avoid repeated console noise while MSFS is closed.
    // Re-enable temporarily with MSFS_FACILITIES_PROBE_ENABLE=1 if Facilities diagnostics are needed.
    facilitiesProbeEnable: bool('MSFS_FACILITIES_PROBE_ENABLE', false),
    facilitiesProbeIntervalMs: Math.max(1000, int('MSFS_FACILITIES_PROBE_INTERVAL_MS', 10000)),
    facilitiesProbeRadiusNm: Math.max(1, float('MSFS_FACILITIES_PROBE_RADIUS_NM', 12)),
    facilitiesProbeTimeoutMs: Math.max(500, Math.min(4000, int('MSFS_FACILITIES_PROBE_TIMEOUT_MS', 1500))),
    facilitiesProbeFailureBackoffMs: Math.max(10000, int('MSFS_FACILITIES_PROBE_FAILURE_BACKOFF_MS', 60000)),
    facilitiesProbeMaxFailures: Math.max(1, int('MSFS_FACILITIES_PROBE_MAX_FAILURES', 3)),
  }),

  // ---------------------------------------------------------------------------
  // X-Plane Web API
  // ---------------------------------------------------------------------------
  xplane: Object.freeze({
    // Explicit opt-in gate. The provider is selected only when this and an
    // existing X-Plane protocol or CLI request are both set.
    experimentalEnable: xplaneExperimentalEnable,
    host: str('XPLANE_HOST', '127.0.0.1'),
    port: int('XPLANE_PORT', 8086),
  }),

  // ---------------------------------------------------------------------------
  // Recording Session (manual start/stop flight logging)
  // Recordings are retained until the user deletes them. The free-disk floor is
  // safety admission control only and never prunes completed history.
  // ---------------------------------------------------------------------------
  recording: Object.freeze({
    // When false, automatic flight detection still marks lifecycle state active,
    // but the durable CSV recorder is not started automatically.
    autoStart: bool('RECORDING_AUTO_START', getSetting(userSettings, 'recording.autoStart', 'RECORDING_AUTO_START', true)),
    // Refuse to start or continue only when the drive reaches its safety floor.
    minFreeDiskGb: float('RECORDING_MIN_FREE_DISK_GB', getSetting(userSettings, 'recording.minFreeDiskGB', 'RECORDING_MIN_FREE_DISK_GB', 2.0)),
    // inline preserves the historical in-process CSV writer.
    // worker moves file append/flush/rename work to a Node worker thread.
    csvWriterMode,
    // Default export path (user can change in file picker)
    defaultExportPath: str('RECORDING_EXPORT_PATH', ''), // Empty = Documents/Flight Fabric/Flight Logs
  }),

  // ---------------------------------------------------------------------------
  // Telemetry Schema
  // ---------------------------------------------------------------------------
  telemetry: Object.freeze({
    // Schema version for CSV format. Increment when adding/removing/changing columns.
    // Consumers use this to handle backward compatibility.
    schemaVersion: 3, // v3: normalizes MSFS last-touchdown pitch/bank to app attitude convention
  }),

  // ---------------------------------------------------------------------------
  // Cabin Announcements (phase-triggered PA via pre-recorded MP3 files)
  // ---------------------------------------------------------------------------
  cabinAnnouncements: Object.freeze({
    enabled: bool('CABIN_ANNOUNCEMENTS_ENABLED', getSetting(userSettings, 'cabinAnnouncements.enabled', 'CABIN_ANNOUNCEMENTS_ENABLED', false)),
    style: str('CABIN_ANNOUNCEMENTS_STYLE', getSetting(userSettings, 'cabinAnnouncements.style', 'CABIN_ANNOUNCEMENTS_STYLE', 'standard')),
    startupGraceMs: Math.max(0, int('CABIN_ANNOUNCEMENTS_STARTUP_GRACE_MS', getSetting(userSettings, 'cabinAnnouncements.startupGraceMs', 'CABIN_ANNOUNCEMENTS_STARTUP_GRACE_MS', 5000))),
    envOverrides: Object.freeze({
      enabled: env.CABIN_ANNOUNCEMENTS_ENABLED !== undefined && env.CABIN_ANNOUNCEMENTS_ENABLED !== '',
      style: env.CABIN_ANNOUNCEMENTS_STYLE !== undefined && env.CABIN_ANNOUNCEMENTS_STYLE !== '',
      startupGraceMs: env.CABIN_ANNOUNCEMENTS_STARTUP_GRACE_MS !== undefined
        && env.CABIN_ANNOUNCEMENTS_STARTUP_GRACE_MS !== '',
    }),
  }),

  // ---------------------------------------------------------------------------
  // OS Path Environment Variables
  // Used by flight-logs-dir.js for Documents folder discovery on Windows/macOS/Linux.
  // These are OS-set variables, not user-configurable application settings.
  // ---------------------------------------------------------------------------
  osPaths: Object.freeze({
    appData: env.APPDATA || null,
    userProfile: env.USERPROFILE || null,
    home: env.HOME || null,
    xdgConfigHome: env.XDG_CONFIG_HOME || null,
    oneDrive: env.OneDrive || null,
    oneDriveLower: env.ONEDRIVE || null,
    oneDriveConsumer: env.OneDriveConsumer || null,
    oneDriveCommercial: env.OneDriveCommercial || null,
  }),
});

module.exports = config;

export {};
