// Central authorization policy for inbound WebSocket client messages.
//
// Trusted-LAN sockets are intentionally useful for live, read-only dashboards,
// but new commands must not become remotely callable by omission. Keep this
// allowlist narrow; everything else requires the full per-session token, except
// for the separately paired aircraft-control capability.

type ClientAuthorizationFlags = {
  __ffPrivilegedClient?: boolean;
  __ffAircraftControlClient?: boolean;
};

export const TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES = Object.freeze([
  'requestState',
  'requestAppSettings',
  'getRecordingState',
  'getFlightStatus',
  'requestAirportLookup',
  'requestDestinationTarget',
  'requestOriginTarget',
] as const);

export const AIRCRAFT_CONTROL_MESSAGE_TYPES = Object.freeze([
  'executeAircraftControl',
] as const);

export const PRIVILEGED_CLIENT_MESSAGE_TYPES = Object.freeze([
  'saveAppSettings',
  'fuelUnit',
  'showBranding',
  'flightPlan',
  'startRecording',
  'stopRecording',
  'endFlightManual',
  'requestTimeline',
  'requestTimelineList',
  'deleteFlightCsv',
  'setDestinationTarget',
  'clearDestinationTarget',
  'setOriginTarget',
  'clearOriginTarget',
  'exportProfile',
  'listProfiles',
  'requestLogbook',
  'requestHistoryIndexStatus',
  'checkHistoryIndex',
  'rebuildHistoryIndex',
  'lvarDebugWatch',
  'testShake',
] as const);

const TRUSTED_LAN_SAFE_READ_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES,
);
const AIRCRAFT_CONTROL_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  AIRCRAFT_CONTROL_MESSAGE_TYPES,
);
const PRIVILEGED_CLIENT_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  PRIVILEGED_CLIENT_MESSAGE_TYPES,
);

export function isClientMessageAuthorized(
  client: ClientAuthorizationFlags | null | undefined,
  messageType: unknown,
): boolean {
  if (typeof messageType !== 'string' || messageType.length === 0) return false;
  if (TRUSTED_LAN_SAFE_READ_MESSAGE_TYPE_SET.has(messageType)) return true;
  if (AIRCRAFT_CONTROL_MESSAGE_TYPE_SET.has(messageType)) {
    return client?.__ffPrivilegedClient === true
      || client?.__ffAircraftControlClient === true;
  }
  if (PRIVILEGED_CLIENT_MESSAGE_TYPE_SET.has(messageType)) {
    return client?.__ffPrivilegedClient === true;
  }
  return false;
}
