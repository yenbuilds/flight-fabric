// Central authorization policy for inbound WebSocket client messages.
//
// Trusted-LAN sockets are intentionally useful for live, read-only dashboards,
// but new commands must not become remotely callable by omission. Keep this
// allowlist narrow; everything else requires the full per-session token, except
// for the separately paired aircraft-control capability.

type ClientAuthorizationFlags = {
  __ffPrivilegedClient?: boolean;
  __ffAircraftControlClient?: boolean;
  __ffToolbarPresetClient?: boolean;
};

export const TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES = Object.freeze([
  'requestState',
  'requestCduState',
  'requestAppSettings',
  'getRecordingState',
  'getFlightStatus',
  'requestAirportLookup',
  'requestDestinationTarget',
  'requestOriginTarget',
] as const);

export const AIRCRAFT_CONTROL_MESSAGE_TYPES = Object.freeze([
  'pushback',
  'autotaxi',
  'sendCduKey',
  'executeAircraftCommand',
  'executeAircraftControl',
] as const);

// Read-only planning still needs an authenticated toolbar or paired device.
export const TAXI_GUIDANCE_READ_MESSAGE_TYPES = Object.freeze([
  'requestTaxiGuidance',
] as const);

export const PRIVILEGED_CLIENT_MESSAGE_TYPES = Object.freeze([
  'saveAppSettings',
  'fuelUnit',
  'showBranding',
  'flightPlan',
  'voiceStatus',
  'startRecording',
  'stopRecording',
  'endFlightManual',
  'requestTimeline',
  'applyFlightAnalysisRescore',
  'revertFlightAnalysisRescore',
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
  'requestDevicePairingRequests',
  'approveDevicePairingRequest',
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
  if ((TAXI_GUIDANCE_READ_MESSAGE_TYPES as readonly string[]).includes(messageType)) return client?.__ffToolbarPresetClient === true
    || client?.__ffAircraftControlClient === true || client?.__ffPrivilegedClient === true;
  // The toolbar may run reviewed presets and the bounded pushback session.
  // It still has no Autotaxi, arbitrary cockpit-control, or settings permission.
  if (['executeAircraftCommand', 'pushback'].includes(messageType) && client?.__ffToolbarPresetClient === true) return true;
  if (AIRCRAFT_CONTROL_MESSAGE_TYPE_SET.has(messageType)) {
    return client?.__ffPrivilegedClient === true
      || client?.__ffAircraftControlClient === true;
  }
  if (PRIVILEGED_CLIENT_MESSAGE_TYPE_SET.has(messageType)) {
    return client?.__ffPrivilegedClient === true;
  }
  return false;
}
