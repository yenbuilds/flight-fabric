// Central outbound WebSocket projection for clients that do not hold the
// full per-session token.
//
// The Trusted-LAN connection is intentionally useful for live dashboards, but
// it must not inherit local filesystem paths, privileged mutation results, or
// diagnostic payloads just because those messages share the same broadcaster.

const { MSG } = require('./message-types') as {
  MSG: Readonly<Record<string, string>>;
};

type ClientScopeFlags = {
  __ffPrivilegedClient?: boolean;
  __ffAircraftControlClient?: boolean;
};

type ServerMessage = Record<string, any>;

const PRIVILEGE_REQUIRED_ERROR = 'Privileged session required for this action.';
const AIRCRAFT_CONTROL_AUTH_ERROR =
  'Aircraft controls require a privileged session or trusted-LAN aircraft control permission.';
const LOCAL_SETTINGS_LABEL = 'Stored locally in your Flight Fabric settings directory';

// Every MSG value must live in exactly one of these lists. The regression test
// compares their union with MSG so a new server message fails closed until its
// unpaired-client behavior is reviewed deliberately.
export const UNPAIRED_PASSTHROUGH_SERVER_MESSAGE_TYPES: ReadonlyArray<string> = Object.freeze([
  MSG.IAS,
  MSG.VS,
  MSG.GS,
  MSG.ALTITUDE,
  MSG.HEADING,
  MSG.IAS_TREND,
  MSG.CROSSWIND,
  MSG.THROTTLE,
  MSG.RATES,
  MSG.FUEL,
  MSG.PHASE,
  MSG.ULTIMATE_STABILITY_SCORE,
  MSG.VRE_SAMPLING,
  MSG.LIGHTS,
  MSG.GEAR,
  MSG.FLAPS,
  MSG.SPOILERS,
  MSG.ENGINES,
  MSG.LANDING,
  MSG.FLIGHT_VIOLATION,
  MSG.ATTITUDE,
  MSG.SURFACE,
  MSG.POSITION,
  MSG.CONTROLS,
  MSG.CABIN_ANNOUNCEMENT,
  MSG.SIM_STATE,
  MSG.AIRCRAFT_SPECIFIC_STATE,
  MSG.ASSISTS,
  MSG.SIGNAL_RELIABILITY,
  MSG.RUNWAY_CONTEXT,
  MSG.AIRPORT_LOOKUP_RESULT,
  MSG.DESTINATION_TARGET_ERROR,
  MSG.ORIGIN_TARGET_ERROR,
  MSG.OVERSPEED,
  MSG.STALL,
  MSG.FUEL_EXHAUSTED,
  MSG.CABIN_ALTITUDE_WARNING,
  MSG.ENVIRONMENT,
  MSG.AUTOPILOT,
  MSG.DISK_WARNING,
  MSG.UPDATE_AVAILABLE,
  MSG.FUEL_UNIT,
  MSG.SHOW_BRANDING,
  MSG.AUTHORIZATION_SCOPE,
]);

export const UNPAIRED_PROJECTED_SERVER_MESSAGE_TYPES: ReadonlyArray<string> = Object.freeze([
  MSG.AIRCRAFT_CHANGED,
  MSG.AIRCRAFT_PROFILE,
  MSG.DATA_SOURCES,
  MSG.FLIGHT_SUMMARY,
  MSG.FLIGHT_TIME,
  MSG.FLIGHT_RECORDING,
  MSG.RECORDING_STATE,
  MSG.FLIGHT_STATUS,
  MSG.DELETE_FLIGHT_CSV_RESULT,
  MSG.FLIGHT_ANALYSIS_RESCORE_RESULT,
  MSG.AIRCRAFT_COMMAND_RESULT,
  MSG.AIRCRAFT_CONTROL_RESULT,
  MSG.FLIGHT_PLAN,
  MSG.DESTINATION_TARGET,
  MSG.ORIGIN_TARGET,
  MSG.APP_SETTINGS,
  MSG.APP_SETTINGS_SAVED,
  MSG.START_FLIGHT_RESULT,
  MSG.END_FLIGHT_RESULT,
  MSG.TIMELINE_ERROR,
  MSG.TIMELINE_LIST_ERROR,
  MSG.HISTORY_INDEX_STATUS,
  MSG.PROFILE_ERROR,
]);

export const UNPAIRED_SUPPRESSED_SERVER_MESSAGE_TYPES: ReadonlyArray<string> = Object.freeze([
  MSG.DEBUG,
  MSG.RECORDING_STOPPED,
  MSG.TIMELINE,
  MSG.TIMELINE_LIST,
  MSG.LOGBOOK,
  MSG.PROFILE_EXPORTED,
  MSG.PROFILE_LIST,
  MSG.LVAR_DEBUG_WATCH_ACK,
  MSG.TEST_SHAKE_ACK,
  // Reserved or currently unproduced types stay closed until a producer shape
  // is reviewed and covered by a projection test.
  MSG.ENVELOPE_STATUS,
  MSG.STABILITY_SCORE,
  MSG.CALLOUT,
  MSG.FLIGHT_STARTED,
  MSG.FLIGHT_ENDED,
  MSG.CONNECTED,
  MSG.SAFETY_DATA,
  MSG.RECORDING_STARTED,
]);

const PASSTHROUGH_UNPAIRED_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  UNPAIRED_PASSTHROUGH_SERVER_MESSAGE_TYPES,
);
const PROJECTED_UNPAIRED_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  UNPAIRED_PROJECTED_SERVER_MESSAGE_TYPES,
);
const SUPPRESSED_UNPAIRED_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  UNPAIRED_SUPPRESSED_SERVER_MESSAGE_TYPES,
);

const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;
const UNC_PATH = /^[/\\]{2}[^/\\]/;
const EMBEDDED_POSIX_PATH =
  /(?:^|[\s("'`=:,;])\/(?:[A-Za-z0-9._-]+\/)+(?:[A-Za-z0-9._-]+)?/;
const PROFILE_ID = '[a-z0-9][a-z0-9_-]*';
const PROFILE_LOCATOR = new RegExp(
  `^(?:auto|${PROFILE_ID}|(?:msfs|xplane|bundled|community|local)/${PROFILE_ID}|(?:bundled|community|local)/(?:msfs|xplane)/${PROFILE_ID})$`,
  'i',
);
const SAFE_CONTROL_TOKEN = /^[A-Za-z0-9_.-]+$/;
const SAFE_CONTROL_CODE = /^[a-z0-9_]+$/;
const SAFE_BACKEND_SOURCE = /^[A-Za-z0-9 _.-]+$/;
const SAFE_ACTION_TEXT = /^[A-Za-z0-9 _./:#+%()-]+$/;
const SAFE_ACTION_TYPES = new Set([
  'key-event',
  'input-event',
  'html-event',
  'lvar',
  'simvar',
  'aircraft-integration',
  'command',
  'dataref',
]);
const SAFE_ACTION_VALUE_TYPES = new Set([
  'float',
  'double',
  'int',
  'int_array',
  'float_array',
  'data',
]);
const SAFE_ACTION_VERIFICATION = new Set(['untested', 'partial', 'verified']);
const SAFE_TRANSPORT_MODES = new Set(['direct-lvar', 'mobiflight']);
const SENSITIVE_FIELD_NAMES = new Set([
  'aircraftconfigpath',
  'previousaircraftconfigpath',
  'filepath',
  'sourcepath',
  'outputdir',
  'libraryspec',
  'resolvedpath',
  'dllpath',
  'binarypath',
  'configpath',
  'profilepath',
  'appdatadir',
  'settingsfile',
  'aircraftprofilesdir',
  'bundledaircraftprofilesdir',
  'cabinannouncementaudiodir',
  'themesdir',
  'logbookfile',
  'destinationtargetfile',
  'origintargetfile',
  'flightlogsdir',
  'token',
  'wsauthtoken',
  'aircraftcontroltoken',
  'authorization',
  'password',
  'secret',
  'apikey',
]);

function hasOwn(value: ServerMessage, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isAbsoluteLocalPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return WINDOWS_ABSOLUTE_PATH.test(trimmed)
    || UNC_PATH.test(trimmed)
    || trimmed.startsWith('/');
}

function isAircraftPathLike(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return isSensitivePathLike(trimmed);
}

function isSensitivePathLike(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return false;
  return isAbsoluteLocalPath(trimmed)
    || /^file:/i.test(trimmed)
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    || trimmed.includes('\\')
    || EMBEDDED_POSIX_PATH.test(trimmed)
    || /(?:^|\/)(?:simobjects|aircraft|users|home)\//i.test(trimmed)
    || /\.(?:cfg|acf)$/i.test(trimmed);
}

function safeBoundedString(
  value: unknown,
  maxLength: number,
  pattern?: RegExp,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > maxLength
    || isSensitivePathLike(trimmed)
    || (pattern && !pattern.test(trimmed))
  ) {
    return null;
  }
  return trimmed;
}

function safeAircraftLabel(value: unknown, fallback: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= 240 && !isAircraftPathLike(trimmed)) {
      return trimmed;
    }
  }
  if (typeof fallback === 'string') {
    const trimmed = fallback.trim();
    if (trimmed && trimmed.length <= 240 && !isAircraftPathLike(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function safeProfileLocator(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= 180 && PROFILE_LOCATOR.test(trimmed) ? trimmed : null;
}

function safeRequestId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.length > 160 || isSensitivePathLike(trimmed)) return null;
  return trimmed;
}

function safeTimelineRequestId(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return safeRequestId(value);
}

function safeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeSimpleValue(value: unknown, maxStringLength = 160): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      trimmed.length <= maxStringLength
      && !isSensitivePathLike(trimmed)
    ) {
      return trimmed;
    }
  }
  return undefined;
}

function stripKnownSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (typeof value === 'string') {
    return isSensitivePathLike(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stripKnownSensitiveFields(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;

  const projected: ServerMessage = {};
  for (const [key, nested] of Object.entries(value as ServerMessage)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) continue;
    const sanitized = stripKnownSensitiveFields(nested, depth + 1);
    if (sanitized !== undefined) projected[key] = sanitized;
  }
  return projected;
}

function sanitizeMetadataValue(
  value: unknown,
  depth = 0,
  maxDepth = 5,
  maxCollectionEntries = 100,
): unknown {
  if (depth > maxDepth) return undefined;
  const simple = safeSimpleValue(value, 240);
  if (simple !== undefined) return simple;
  if (Array.isArray(value)) {
    return value
      .slice(0, maxCollectionEntries)
      .map((item) => sanitizeMetadataValue(item, depth + 1, maxDepth, maxCollectionEntries))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return undefined;

  const projected: ServerMessage = {};
  for (const [key, nested] of Object.entries(value as ServerMessage).slice(0, maxCollectionEntries)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) continue;
    const sanitized = sanitizeMetadataValue(nested, depth + 1, maxDepth, maxCollectionEntries);
    if (sanitized !== undefined) projected[key] = sanitized;
  }
  return projected;
}

function sanitizeControlCapabilities(value: unknown): unknown {
  // Command input enum values and speech strings are scalar leaves at depth 6:
  // aircraftCommands -> commands[] -> command -> input/speech -> array -> value.
  // Aircraft integrations can legitimately expose more than 100 reviewed
  // readbacks/actions, so keep this trusted catalogue complete for the UI.
  // Keep the broader metadata surface on the stricter default depth limit.
  return sanitizeMetadataValue(value, 0, 6, 512);
}

function sanitizeEndReason(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('aircraft_change:')) return 'aircraft_change';
  if (!trimmed || trimmed.length > 80 || !/^[a-z0-9_-]+$/.test(trimmed)) {
    return 'unknown';
  }
  return trimmed;
}

function safeFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > 255
    || trimmed.includes('/')
    || trimmed.includes('\\')
  ) {
    return null;
  }
  return trimmed;
}

function projectProvenance(value: unknown): ServerMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provenance = value as ServerMessage;
  const projected: ServerMessage = {};
  for (const key of [
    'verificationStatus',
    'dataQuality',
    'sourceCount',
    'hasOfficialSource',
    'lastVerified',
  ]) {
    if (!hasOwn(provenance, key)) continue;
    const sanitized = sanitizeMetadataValue(provenance[key]);
    if (sanitized !== undefined) projected[key] = sanitized;
  }
  // Detailed issue text is intentionally omitted from an unpaired projection.
  return projected;
}

function projectAircraftProfile(message: ServerMessage): ServerMessage {
  const rawProfile = message.profile && typeof message.profile === 'object' && !Array.isArray(message.profile)
    ? message.profile as ServerMessage
    : {};
  const profile: ServerMessage = {};
  for (const key of [
    'id',
    'name',
    'namespace',
    'simulator',
    'aircraftSpecificTemplateId',
    'visualSupport',
    'throttleType',
  ]) {
    const sanitized = safeBoundedString(rawProfile[key], 240);
    if (sanitized !== null) profile[key] = sanitized;
  }
  for (const key of ['_qualifiedId', '_profileKey']) {
    const locator = safeProfileLocator(rawProfile[key]);
    if (locator) profile[key] = locator;
  }
  if (Number.isSafeInteger(rawProfile.profileRevision) && rawProfile.profileRevision >= 0) {
    profile.profileRevision = rawProfile.profileRevision;
  }
  profile.aircraftTitle = safeAircraftLabel(rawProfile.aircraftTitle, rawProfile.name);
  if (rawProfile.controlCapabilities && typeof rawProfile.controlCapabilities === 'object') {
    profile.controlCapabilities = sanitizeControlCapabilities(rawProfile.controlCapabilities);
  }

  const projected: ServerMessage = {
    type: message.type,
    profile,
    previousTitle: safeAircraftLabel(message.previousTitle, message.previousDisplayName),
  };
  const previousDisplayName = safeAircraftLabel(message.previousDisplayName, null);
  const source = safeBoundedString(message.source, 80, SAFE_CONTROL_TOKEN);
  const provenance = projectProvenance(message.provenance);
  const controlCapabilities = sanitizeControlCapabilities(message.controlCapabilities);
  if (previousDisplayName) projected.previousDisplayName = previousDisplayName;
  if (source) projected.source = source;
  if (provenance) projected.provenance = provenance;
  if (controlCapabilities !== undefined) projected.controlCapabilities = controlCapabilities;
  return projected;
}

function projectAircraftChanged(message: ServerMessage): ServerMessage {
  const projected: ServerMessage = {
    type: message.type,
    newTitle: safeAircraftLabel(message.newTitle, message.displayName),
    previousTitle: safeAircraftLabel(message.previousTitle, message.previousDisplayName),
  };
  const displayName = safeAircraftLabel(message.displayName, null);
  const previousDisplayName = safeAircraftLabel(message.previousDisplayName, null);
  if (displayName) projected.displayName = displayName;
  if (previousDisplayName) projected.previousDisplayName = previousDisplayName;
  return projected;
}

function projectDataSource(source: unknown): unknown {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const value = source as ServerMessage;

  // Keep only dashboard/status fields. In particular, raw bridge errors,
  // expressions, resolved DLL paths, and path-bearing descriptions stay local.
  const projected: ServerMessage = {};
  for (const key of [
    'type',
    'name',
    'connected',
    'status',
    'categories',
    'adapterId',
    'mode',
    'subscriptionCount',
    'liveValueCount',
  ]) {
    if (!hasOwn(value, key)) continue;
    const sanitized = sanitizeMetadataValue(value[key]);
    if (sanitized !== undefined) projected[key] = sanitized;
  }
  if (Array.isArray(value.preview)) {
    projected.preview = value.preview.slice(0, 100).map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const preview = item as ServerMessage;
      const safePreview: ServerMessage = {};
      const key = safeBoundedString(preview.key, 128, SAFE_ACTION_TEXT);
      const previewValue = safeSimpleValue(preview.value, 160);
      if (key) safePreview.key = key;
      if (previewValue !== undefined) safePreview.value = previewValue;
      if (typeof preview.live === 'boolean') safePreview.live = preview.live;
      return safePreview;
    });
  }
  return projected;
}

function projectDataSources(message: ServerMessage): ServerMessage {
  const primary = projectDataSource(message.primary);
  const secondary = Array.isArray(message.secondary)
    ? message.secondary.map(projectDataSource)
    : [];
  const sources = Array.isArray(message.sources)
    ? message.sources.map(projectDataSource)
    : [primary, ...secondary].filter(Boolean);

  const projected: ServerMessage = {
    type: message.type,
    primary,
    secondary,
    sources,
  };
  const profileKey = safeProfileLocator(message.profileKey);
  if (profileKey) projected.profileKey = profileKey;
  if (Number.isSafeInteger(message.profileRevision) && message.profileRevision >= 0) {
    projected.profileRevision = message.profileRevision;
  }
  const controlCapabilities = sanitizeControlCapabilities(message.controlCapabilities);
  if (controlCapabilities !== undefined) projected.controlCapabilities = controlCapabilities;
  return projected;
}

function projectFlightPlan(message: ServerMessage): ServerMessage {
  const projected: ServerMessage = { type: message.type };
  if (typeof message.cleared === 'boolean') projected.cleared = message.cleared;

  const stringFields: ReadonlyArray<[string, number]> = [
    ['originName', 80],
    ['destinationName', 80],
    ['aircraft', 20],
    ['aircraftName', 80],
    ['callsign', 20],
    ['flightNumber', 20],
    ['route', 2000],
    ['cruiseAltFl', 10],
    ['cruiseMach', 10],
  ];
  for (const [key, maxLength] of stringFields) {
    if (!hasOwn(message, key)) continue;
    if (message[key] === null) {
      projected[key] = null;
      continue;
    }
    const sanitized = safeBoundedString(message[key], maxLength);
    if (sanitized !== null) projected[key] = sanitized;
  }

  for (const key of ['origin', 'destination', 'alternate']) {
    if (!hasOwn(message, key)) continue;
    if (message[key] === null) {
      projected[key] = null;
      continue;
    }
    const icao = safeBoundedString(message[key], 4, /^[A-Z0-9]{3,4}$/i);
    if (icao) projected[key] = icao.toUpperCase();
  }

  for (const key of [
    'fetchedAt',
    'eteSeconds',
    'fuelLbs',
    'costIndex',
  ]) {
    if (!hasOwn(message, key)) continue;
    if (message[key] === null) {
      projected[key] = null;
      continue;
    }
    const numericValue = safeFiniteNumber(message[key]);
    if (numericValue !== null) projected[key] = numericValue;
  }
  return projected;
}

function projectRouteTarget(message: ServerMessage): ServerMessage {
  const projected: ServerMessage = {
    type: message.type,
    target: null,
  };
  if (
    message.target
    && typeof message.target === 'object'
    && !Array.isArray(message.target)
  ) {
    const target = message.target as ServerMessage;
    const icao = safeBoundedString(target.icao, 4, /^[A-Z0-9]{3,4}$/i);
    const name = safeBoundedString(target.name, 200);
    const lat = safeFiniteNumber(target.lat);
    const lon = safeFiniteNumber(target.lon);
    const initialDistanceNm = target.initialDistanceNm === null
      ? null
      : safeFiniteNumber(target.initialDistanceNm);
    if (
      icao
      && lat !== null
      && Math.abs(lat) <= 90
      && lon !== null
      && Math.abs(lon) <= 180
    ) {
      projected.target = {
        icao: icao.toUpperCase(),
        name: name || icao.toUpperCase(),
        lat,
        lon,
        initialDistanceNm:
          initialDistanceNm !== null && initialDistanceNm > 0
            ? initialDistanceNm
            : null,
      };
    }
  }
  const error = safeBoundedString(message.error, 160);
  if (error) projected.error = error;
  return projected;
}

function projectFlightSummary(message: ServerMessage): ServerMessage {
  const projected: ServerMessage = { type: message.type };
  for (const key of [
    'departure_time_ms',
    'departure_time_utc',
    'max_alt_ft',
    'max_ias_kts',
    'go_around_count',
    'overspeed_count',
    'violations',
    'dutch_roll',
    'holding',
    'insights',
    'departure_icao',
    'arrival_icao',
  ]) {
    if (hasOwn(message, key)) {
      projected[key] = stripKnownSensitiveFields(message[key]);
    }
  }
  projected.aircraft = safeAircraftLabel(message.aircraft, null);
  return projected;
}

function projectFlightTime(message: ServerMessage): ServerMessage {
  const projected: ServerMessage = { type: message.type };
  for (const key of [
    'startedAt',
    'now',
    'elapsedMs',
    'elapsedSec',
    'elapsedHms',
    'active',
    'flightId',
  ]) {
    if (hasOwn(message, key)) projected[key] = message[key];
  }
  if (hasOwn(message, 'endReason')) {
    projected.endReason = sanitizeEndReason(message.endReason);
  }
  return projected;
}

function projectFlightRecording(message: ServerMessage): ServerMessage {
  const projected: ServerMessage = { type: message.type };
  for (const key of [
    'status',
    'flightId',
    'recordingSessionId',
    'rowsWritten',
    'rowCount',
  ]) {
    if (hasOwn(message, key)) projected[key] = message[key];
  }
  const fileName = safeFileName(message.fileName);
  const error = safeBoundedString(message.error, 300);
  if (fileName) projected.fileName = fileName;
  if (error) projected.error = error;
  if (hasOwn(message, 'endReason')) {
    projected.endReason = sanitizeEndReason(message.endReason);
  }
  return projected;
}

function projectRecordingState(message: ServerMessage): ServerMessage {
  const projected: ServerMessage = { type: message.type };
  for (const key of [
    'isRecording',
    'sessionId',
    'startedAt',
    'sampleCount',
    'duration',
  ]) {
    if (hasOwn(message, key)) projected[key] = message[key];
  }
  const lastError = safeBoundedString(message.lastError, 300);
  if (lastError) projected.lastError = lastError;
  else if (hasOwn(message, 'lastError')) projected.lastError = null;
  return projected;
}

function projectFlightStatus(message: ServerMessage): ServerMessage {
  const projected: ServerMessage = {
    type: message.type,
    aircraftTitle: safeAircraftLabel(message.aircraftTitle, null),
  };
  for (const key of ['active', 'flightId', 'startTime', 'recording']) {
    if (hasOwn(message, key)) projected[key] = message[key];
  }
  return projected;
}

function projectDeleteFlightResult(message: ServerMessage): ServerMessage {
  const success = message.success === true;
  return {
    type: message.type,
    requestId: safeRequestId(message.requestId),
    success,
    error: success
      ? null
      : (message.error === PRIVILEGE_REQUIRED_ERROR
        ? message.error
        : 'Request failed'),
  };
}

function sanitizeControlRequest(value: unknown): ServerMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as ServerMessage;
  const projected: ServerMessage = {};
  for (const key of ['control', 'operation', 'target', 'actionId']) {
    const token = safeBoundedString(request[key], 96, SAFE_CONTROL_TOKEN);
    if (token) projected[key] = token;
  }
  const profileKey = safeProfileLocator(request.profileKey);
  if (profileKey) projected.profileKey = profileKey;
  if (Number.isSafeInteger(request.profileRevision) && request.profileRevision >= 0) {
    projected.profileRevision = request.profileRevision;
  }
  const requestId = safeRequestId(request.requestId);
  if (requestId) projected.requestId = requestId;
  const safeValue = safeSimpleValue(request.value, 120);
  if (safeValue !== undefined) projected.value = safeValue;
  return projected;
}

function sanitizeAircraftCommandRequest(value: unknown): ServerMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as ServerMessage;
  const commandId = safeBoundedString(request.commandId, 96, SAFE_CONTROL_TOKEN);
  if (!commandId) return null;

  const projected: ServerMessage = { commandId };
  const rawInput = request.input;
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const inputKeys = Object.keys(rawInput);
    if (inputKeys.length === 0) {
      projected.input = {};
    } else if (inputKeys.length === 1 && inputKeys[0] === 'value') {
      const inputValue = safeSimpleValue((rawInput as ServerMessage).value, 120);
      if (inputValue !== undefined) projected.input = { value: inputValue };
    }
  }
  const profileKey = safeProfileLocator(request.profileKey);
  if (profileKey) projected.profileKey = profileKey;
  if (Number.isSafeInteger(request.profileRevision) && request.profileRevision >= 0) {
    projected.profileRevision = request.profileRevision;
  }
  const requestId = safeRequestId(request.requestId);
  if (requestId) projected.requestId = requestId;
  return projected;
}

function sanitizeControlAction(value: unknown): ServerMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = value as ServerMessage;
  if (!SAFE_ACTION_TYPES.has(action.type)) return null;

  const projected: ServerMessage = { type: action.type };
  const name = safeBoundedString(action.name, 160, SAFE_ACTION_TEXT);
  const unit = safeBoundedString(action.unit, 48, SAFE_ACTION_TEXT);
  if (name) projected.name = name;
  if (unit) projected.unit = unit;

  const actionValue = safeSimpleValue(action.value, 120);
  if (actionValue !== undefined) projected.value = actionValue;
  if (Array.isArray(action.parameters) && action.parameters.length <= 8) {
    const parameters = action.parameters.map((parameter: unknown) => safeSimpleValue(parameter, 120));
    if (parameters.every((parameter: unknown) => parameter !== undefined)) {
      projected.parameters = parameters;
    }
  }
  if (SAFE_ACTION_VALUE_TYPES.has(action.valueType)) projected.valueType = action.valueType;
  if (SAFE_ACTION_VERIFICATION.has(action.verification)) {
    projected.verification = action.verification;
  }
  return projected;
}

function projectAircraftControlResult(
  client: ClientScopeFlags | null | undefined,
  message: ServerMessage,
): ServerMessage | null {
  const requestId = safeRequestId(message.requestId);
  if (client?.__ffAircraftControlClient !== true) {
    if (
      message.ok !== false
      || message.code !== 'auth_required'
      || message.error !== AIRCRAFT_CONTROL_AUTH_ERROR
    ) {
      return null;
    }
    return {
      type: message.type,
      requestId,
      ok: false,
      code: 'auth_required',
      error: AIRCRAFT_CONTROL_AUTH_ERROR,
    };
  }

  const ok = message.ok === true;
  const projected: ServerMessage = {
    type: message.type,
    requestId,
    ok,
  };
  const code = safeBoundedString(message.code, 80, SAFE_CONTROL_CODE);
  if (code) projected.code = code;
  if (!ok) {
    projected.error = 'Aircraft control request failed.';
    if (message.executionStarted === true) projected.executionStarted = true;
  }

  const request = sanitizeControlRequest(message.request);
  const profileKey = safeProfileLocator(message.profileKey);
  const action = sanitizeControlAction(message.action);
  const backendSource = safeBoundedString(message.backendSource, 80, SAFE_BACKEND_SOURCE);
  if (request) projected.request = request;
  if (profileKey) projected.profileKey = profileKey;
  if (Number.isSafeInteger(message.profileRevision) && message.profileRevision >= 0) {
    projected.profileRevision = message.profileRevision;
  }
  if (message.resolvedBy === 'profile' || message.resolvedBy === 'generic') {
    projected.resolvedBy = message.resolvedBy;
  }
  if (action) projected.action = action;
  if (backendSource) projected.backendSource = backendSource;
  if (SAFE_TRANSPORT_MODES.has(message.transportMode)) {
    projected.transportMode = message.transportMode;
  }
  return projected;
}

function projectAircraftCommandResult(
  client: ClientScopeFlags | null | undefined,
  message: ServerMessage,
): ServerMessage | null {
  const projected = projectAircraftControlResult(client, {
    ...message,
    request: message.controlRequest,
  });
  if (!projected || client?.__ffAircraftControlClient !== true) return projected;

  const command = sanitizeAircraftCommandRequest(message.request || message.command);
  const controlRequest = sanitizeControlRequest(message.controlRequest);
  const commandId = safeBoundedString(message.commandId, 96, SAFE_CONTROL_TOKEN);
  const commandLabel = safeBoundedString(message.commandLabel, 160, SAFE_ACTION_TEXT);
  const configurationId = safeBoundedString(message.configurationId, 96, SAFE_CONTROL_TOKEN);
  if (command) {
    projected.request = command;
    projected.command = command;
  } else {
    delete projected.request;
  }
  if (controlRequest) projected.controlRequest = controlRequest;
  if (commandId) projected.commandId = commandId;
  if (commandLabel) projected.commandLabel = commandLabel;
  if (configurationId) projected.configurationId = configurationId;
  if (Number.isSafeInteger(message.stepCount) && message.stepCount > 0 && message.stepCount <= 64) {
    projected.stepCount = message.stepCount;
  }
  if (
    Number.isSafeInteger(message.completedStepCount)
    && message.completedStepCount >= 0
    && message.completedStepCount <= 64
  ) {
    projected.completedStepCount = message.completedStepCount;
  }
  return projected;
}

function projectAppSettings(message: ServerMessage): ServerMessage {
  const rawSettings = message.settings && typeof message.settings === 'object' && !Array.isArray(message.settings)
    ? message.settings as ServerMessage
    : {};
  const settings = sanitizeMetadataValue(rawSettings) as ServerMessage || {};
  if (!settings.aircraft || typeof settings.aircraft !== 'object' || Array.isArray(settings.aircraft)) {
    settings.aircraft = { profile: 'auto' };
  } else {
    const profile = safeProfileLocator((settings.aircraft as ServerMessage).profile);
    (settings.aircraft as ServerMessage).profile = profile || 'auto';
  }

  const storage = message.storage && typeof message.storage === 'object' && !Array.isArray(message.storage)
    ? message.storage as ServerMessage
    : {};
  return {
    type: message.type,
    settings,
    settingsFile: LOCAL_SETTINGS_LABEL,
    storage: {
      appDataDir: 'Stored locally in your Flight Fabric app-data directory',
      settingsFile: LOCAL_SETTINGS_LABEL,
      bundledAircraftProfilesDir: 'Release-owned and read-only',
      cabinAnnouncementAudioDir: 'Stored locally for cabin-audio overrides',
      themesDir: 'Stored locally for theme overrides',
      logbookFile: 'Stored locally with your flight-log data',
      destinationTargetFile: 'Stored locally in the destination target cache',
      originTargetFile: 'Stored locally in the origin target cache',
      flightLogsDir: 'Stored locally in your flight-logs directory',
      flightLogsExists: storage.flightLogsExists === true,
      flightLogsFileCount: safeFiniteNumber(storage.flightLogsFileCount) || 0,
      flightLogsTotalBytes: safeFiniteNumber(storage.flightLogsTotalBytes) || 0,
    },
    backendVersion: safeBoundedString(message.backendVersion, 80) || '',
  };
}

function projectPrivilegeDeniedResult(message: ServerMessage): ServerMessage | null {
  const type = message.type;
  const requestId = safeRequestId(message.requestId);
  if (
    type === MSG.PROFILE_ERROR
    && Array.isArray(message.errors)
    && message.errors.length === 1
    && message.errors[0] === PRIVILEGE_REQUIRED_ERROR
  ) {
    return { type, errors: [PRIVILEGE_REQUIRED_ERROR] };
  }
  if (message.error !== PRIVILEGE_REQUIRED_ERROR) return null;

  switch (type) {
    case MSG.APP_SETTINGS_SAVED:
      return {
        type,
        ok: false,
        error: PRIVILEGE_REQUIRED_ERROR,
        settingsFile: LOCAL_SETTINGS_LABEL,
      };
    case MSG.START_FLIGHT_RESULT:
    case MSG.END_FLIGHT_RESULT:
      return { type, success: false, error: PRIVILEGE_REQUIRED_ERROR };
    case MSG.TIMELINE_ERROR:
      return {
        type,
        requestId: safeTimelineRequestId(message.requestId),
        scoringMode: message.scoringMode === 'current-preview' ? 'current-preview' : 'recorded',
        error: PRIVILEGE_REQUIRED_ERROR,
      };
    case MSG.TIMELINE_LIST_ERROR:
      return { type, requestId, error: PRIVILEGE_REQUIRED_ERROR };
    case MSG.HISTORY_INDEX_STATUS:
      return { type, success: false, error: PRIVILEGE_REQUIRED_ERROR };
    case MSG.FLIGHT_ANALYSIS_RESCORE_RESULT:
      return {
        type,
        requestId: safeTimelineRequestId(message.requestId),
        action: message.action === 'revert' ? 'revert' : 'apply',
        success: false,
        error: PRIVILEGE_REQUIRED_ERROR,
      };
    default:
      return null;
  }
}

export function projectServerMessageForClient(
  client: ClientScopeFlags | null | undefined,
  message: unknown,
): ServerMessage | null {
  if (client?.__ffPrivilegedClient === true) {
    return message && typeof message === 'object' && !Array.isArray(message)
      ? message as ServerMessage
      : null;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;

  const value = message as ServerMessage;
  const type = typeof value.type === 'string' ? value.type : '';
  if (!type || SUPPRESSED_UNPAIRED_MESSAGE_TYPE_SET.has(type)) return null;

  if (PASSTHROUGH_UNPAIRED_MESSAGE_TYPE_SET.has(type)) {
    return stripKnownSensitiveFields(value) as ServerMessage;
  }
  if (!PROJECTED_UNPAIRED_MESSAGE_TYPE_SET.has(type)) {
    // Unknown server messages never become remotely visible by omission.
    return null;
  }

  switch (type) {
    case MSG.AIRCRAFT_PROFILE:
      return projectAircraftProfile(value);
    case MSG.AIRCRAFT_CHANGED:
      return projectAircraftChanged(value);
    case MSG.DATA_SOURCES:
      return projectDataSources(value);
    case MSG.FLIGHT_SUMMARY:
      return projectFlightSummary(value);
    case MSG.FLIGHT_TIME:
      return projectFlightTime(value);
    case MSG.FLIGHT_RECORDING:
      return projectFlightRecording(value);
    case MSG.RECORDING_STATE:
      return projectRecordingState(value);
    case MSG.FLIGHT_STATUS:
      return projectFlightStatus(value);
    case MSG.DELETE_FLIGHT_CSV_RESULT:
      return projectDeleteFlightResult(value);
    case MSG.AIRCRAFT_CONTROL_RESULT:
      return projectAircraftControlResult(client, value);
    case MSG.AIRCRAFT_COMMAND_RESULT:
      return projectAircraftCommandResult(client, value);
    case MSG.FLIGHT_PLAN:
      return projectFlightPlan(value);
    case MSG.DESTINATION_TARGET:
    case MSG.ORIGIN_TARGET:
      return projectRouteTarget(value);
    case MSG.APP_SETTINGS:
      return projectAppSettings(value);
    case MSG.APP_SETTINGS_SAVED:
    case MSG.START_FLIGHT_RESULT:
    case MSG.END_FLIGHT_RESULT:
    case MSG.TIMELINE_ERROR:
    case MSG.TIMELINE_LIST_ERROR:
    case MSG.HISTORY_INDEX_STATUS:
    case MSG.PROFILE_ERROR:
    case MSG.FLIGHT_ANALYSIS_RESCORE_RESULT:
      return projectPrivilegeDeniedResult(value);
    default:
      return null;
  }
}

export function projectSerializedServerMessageForClient(
  client: ClientScopeFlags | null | undefined,
  payload: string,
): string | null {
  if (client?.__ffPrivilegedClient === true) return payload;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Flight Fabric's server protocol is JSON-only. Fail closed for unpaired
    // clients if a caller tries to bypass the structured message boundary.
    return null;
  }

  const projected = projectServerMessageForClient(client, parsed);
  if (!projected) return null;
  try {
    return JSON.stringify(projected);
  } catch {
    return null;
  }
}
