// ws-bootstrap.js
// Minimal WebSocket bootstrap helper for the core runtime.

const WebSocket = require('ws');
const net = require('net') as typeof import('net');
const { MSG } = require('./message-types');
const {
  projectSerializedServerMessageForClient,
} = require('./server-message-projection');
const { toolbarPresetToken, createToolbarPresetStream } = require('./toolbar-presets') as typeof import('./toolbar-presets');
const { parseCookieHeader } = require('./device-pairing');
const { MAX_WS_BUFFERED_BYTES } = require('./ws-broadcaster') as typeof import('./ws-broadcaster');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Message types a client may subscribe to with `?subscribe=a,b,c`. A
// subscription is a narrowing filter: the socket receives only these types
// (plus its authorization scope) and never the per-tick telemetry stream.
// Embedded views such as the MSFS toolbar panel use it so a stalled or
// hidden simulator browser cannot accumulate high-frequency traffic. Only
// event-driven or once-per-second types are eligible.
export const SUBSCRIBABLE_MESSAGE_TYPES: ReadonlyArray<string> = Object.freeze([
  MSG.CONNECTED,
  MSG.SIM_STATE,
  MSG.PHASE,
  MSG.FLIGHT_TIME,
  MSG.SIM_TIME,
  MSG.FLIGHT_PLAN,
  MSG.VOICE_STATUS,
  MSG.AIRCRAFT_PROFILE,
  MSG.AIRCRAFT_CHANGED,
  MSG.LANDING,
  MSG.TAKEOFF,
  MSG.TOOLBAR_FLIGHT_HISTORY,
  MSG.TOOLBAR_PRESET_STATE,
  MSG.TOOLBAR_TAXI_STATE,
  MSG.PUSHBACK_STATE,
  MSG.AIRCRAFT_COMMAND_RESULT,
  MSG.FLIGHT_SUMMARY,
  MSG.FLIGHT_STATUS,
  MSG.FLIGHT_RECORDING,
  MSG.RECORDING_STATE,
  MSG.RECORDING_STARTED,
  MSG.RECORDING_STOPPED,
  MSG.FLIGHT_STARTED,
  MSG.FLIGHT_ENDED,
  MSG.DATA_SOURCES,
  MSG.SIGNAL_RELIABILITY,
  MSG.DESTINATION_TARGET,
  MSG.ORIGIN_TARGET,
  MSG.FUEL_UNIT,
  MSG.SHOW_BRANDING,
  MSG.UPDATE_AVAILABLE,
  MSG.SUPPORT_GOAL,
  MSG.ULTIMATE_STABILITY_SCORE,
  MSG.ENVELOPE_STATUS,
  MSG.FLIGHT_VIOLATION,
  MSG.CABIN_ANNOUNCEMENT,
  MSG.CALLOUT,
  MSG.OVERSPEED,
  MSG.STALL,
  MSG.FUEL_EXHAUSTED,
  MSG.CABIN_ALTITUDE_WARNING,
  MSG.DISK_WARNING,
  MSG.APP_SETTINGS,
]);
const SUBSCRIBABLE_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(SUBSCRIBABLE_MESSAGE_TYPES);
const MAX_SUBSCRIPTION_TYPES = 64;
const SERIALIZED_TYPE_PREFIX = /^\{"type":"([^"\\]{1,64})"/;

type DebugLike = {
  log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};

type LoggerFn = (...args: unknown[]) => void;
type WsSocketLike = {
  on: (eventName: string, handler: (...args: any[]) => void | Promise<void>) => void;
  send?: (payload: string, ...args: any[]) => void;
  bufferedAmount?: number;
  readyState?: number;
  terminate?: () => void;
  __ffPrivilegedClient?: boolean;
  __ffAircraftControlClient?: boolean;
  __ffToolbarPresetClient?: boolean;
  __ffAircraftControlPairingStatus?: AircraftControlPairingStatus;
  __ffSubscribedTypes?: ReadonlySet<string> | null;
};
type AircraftControlPairingStatus = 'not-requested' | 'accepted' | 'expired' | 'disabled';
type ClientConnectedHandler = (ws: WsSocketLike) => void;
type ClientMessageHandler = (ws: WsSocketLike, msg: Record<string, unknown>) => Promise<void> | void;
type RequestLike = import('http').IncomingMessage & {
  __ffWsMeta?: {
    isPrivilegedClient: boolean;
    isAircraftControlClient: boolean;
    isToolbarPresetClient: boolean;
    aircraftControlPairingStatus: AircraftControlPairingStatus;
    origin: string | null;
    remoteAddress: string | null;
    subscribedTypes: ReadonlySet<string> | null;
  };
};

// Maximum incoming WebSocket frame size. Keeps a malicious or buggy client from
// sending a gigabyte-sized message that would exhaust memory before the message
// handler is ever reached. 512 KB is generous for any legitimate command payload.
const WS_MAX_PAYLOAD_BYTES = 512 * 1024;

function normalizeHostname(hostname: string | null | undefined): string {
  return String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function extractHostnameFromHostHeader(value: string | string[] | null | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? normalizeHostname(trimmed.slice(1, end)) : normalizeHostname(trimmed);
  }
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > 0 && trimmed.indexOf(':') === lastColon) {
    return normalizeHostname(trimmed.slice(0, lastColon));
  }
  return normalizeHostname(trimmed);
}

function isLoopbackHost(hostname: string | null | undefined): boolean {
  return LOOPBACK_HOSTS.has(normalizeHostname(hostname));
}

function extractTokenFromRequestUrl(urlValue: string | null | undefined, parameterName: string): string {
  try {
    return new URL(urlValue || '/', 'ws://localhost').searchParams.get(parameterName) || '';
  } catch {
    return '';
  }
}

/**
 * Parse the optional `subscribe` handshake parameter. Returns null when the
 * client did not subscribe, a Set of message types when it did, or 'invalid'
 * when the request names an empty list or a type that is not subscribable.
 */
export function parseSubscriptionParameter(urlValue: string | null | undefined): ReadonlySet<string> | null | 'invalid' {
  let raw: string | null = null;
  try {
    raw = new URL(urlValue || '/', 'ws://localhost').searchParams.get('subscribe');
  } catch {
    return null;
  }
  if (raw === null) return null;
  const types = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (types.length === 0 || types.length > MAX_SUBSCRIPTION_TYPES) return 'invalid';
  if (types.some((type) => !SUBSCRIBABLE_MESSAGE_TYPE_SET.has(type))) return 'invalid';
  return new Set(types);
}

function serializedMessageType(payload: string): string | null {
  const quick = SERIALIZED_TYPE_PREFIX.exec(payload);
  if (quick) return quick[1];
  try {
    const parsed = JSON.parse(payload) as { type?: unknown };
    return parsed && typeof parsed.type === 'string' ? parsed.type : null;
  } catch {
    return null;
  }
}

/** Whether a subscribed socket should receive this serialized message. */
export function isSubscribedMessage(subscribedTypes: ReadonlySet<string> | null | undefined, payload: string): boolean {
  if (!subscribedTypes) return true;
  const type = serializedMessageType(payload);
  if (type === null) return false;
  return type === MSG.AUTHORIZATION_SCOPE || subscribedTypes.has(type);
}

function isPrivateOrLoopbackIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  return octets[0] === 127
    || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function isPrivateOrLoopbackRemoteAddress(remoteAddress: string | null | undefined): boolean {
  let value = String(remoteAddress || '').trim().toLowerCase();
  if (!value) return false;

  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);

  const ipVersion = net.isIP(value);
  if (ipVersion === 4) return isPrivateOrLoopbackIpv4(value);
  if (ipVersion !== 6) return false;
  if (value === '::1') return true;

  const firstIpv6Hextet = value.split(':', 1)[0];
  const parsedHextet = Number.parseInt(firstIpv6Hextet, 16);
  return Number.isFinite(parsedHextet) && (parsedHextet & 0xfe00) === 0xfc00;
}

function isTrustedWsOrigin(origin: string | null | undefined, requestHost: string, remoteAccessEnable: boolean): boolean {
  if (!origin || origin === 'null') return false;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const originHost = normalizeHostname(parsed.hostname);
    if (isLoopbackHost(originHost)) {
      return isLoopbackHost(requestHost);
    }

    // Trusted-LAN access is intentionally IP-scoped. Merely matching Origin
    // and Host is not enough because a public hostname can be DNS-rebound to
    // this listener while the browser keeps that attacker-controlled origin.
    // The supported phone URL uses a private interface address, so require the
    // matched non-loopback host itself to be private/ULA before accepting it.
    return remoteAccessEnable
      && Boolean(requestHost)
      && originHost === requestHost
      && isPrivateOrLoopbackRemoteAddress(originHost);
  } catch {
    return false;
  }
}

export function createWsServer({
  wsPort,
  remoteAccessEnable = false,
  remoteAircraftControlEnable = false,
  wsAuthToken = '',
  aircraftControlToken = '',
  devicePairing = null,
  Debug,
  tlog,
  onClientConnected,
  onClientMessage,
  onFatalError,
}: {
  wsPort: number;
  remoteAccessEnable?: boolean;
  remoteAircraftControlEnable?: boolean;
  wsAuthToken?: string;
  aircraftControlToken?: string;
  devicePairing?: {
    hasApprovedSession: (sessionId: unknown, remoteAddress: string | null | undefined) => boolean;
  } | null;
  Debug: DebugLike;
  tlog: LoggerFn;
  onClientConnected: ClientConnectedHandler;
  onClientMessage: ClientMessageHandler;
  onFatalError?: (error: Error) => void;
}): unknown {
  const wsBindAddress = remoteAccessEnable ? '0.0.0.0' : '127.0.0.1';
  const wss = new WebSocket.Server({
    host: wsBindAddress,
    port: wsPort,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    verifyClient: (info: { origin?: string; req: RequestLike }, done: (result: boolean, code?: number, name?: string) => void) => {
      const requestHost = extractHostnameFromHostHeader(info.req?.headers?.host);
      const origin = typeof info.origin === 'string' ? info.origin : '';
      const token = extractTokenFromRequestUrl(info.req?.url, 'token');
      const requestedAircraftControlToken = extractTokenFromRequestUrl(info.req?.url, 'aircraftControlToken');
      const devicePairingSessionId = parseCookieHeader(info.req?.headers?.cookie).ff_aircraft_pair || '';
      const subscribedTypes = parseSubscriptionParameter(info.req?.url);
      const hasValidToken = Boolean(wsAuthToken) && token === wsAuthToken;
      const remoteAddress = info.req?.socket?.remoteAddress || null;
      const trustedOrigin = isPrivateOrLoopbackRemoteAddress(remoteAddress)
        && isTrustedWsOrigin(origin, requestHost, remoteAccessEnable);
      const requestedPresetToken = extractTokenFromRequestUrl(info.req?.url, 'toolbarPresetToken');
      const hasToolbarPresetScope = trustedOrigin && isLoopbackHost(requestHost)
        && isLoopbackHost(String(remoteAddress || '').replace(/^::ffff:/, ''))
        && Boolean(wsAuthToken) && requestedPresetToken === toolbarPresetToken(wsAuthToken);
      const hasPairedDeviceSession = remoteAccessEnable
        && remoteAircraftControlEnable
        && trustedOrigin
        && Boolean(devicePairingSessionId)
        && devicePairing?.hasApprovedSession(devicePairingSessionId, remoteAddress) === true;
      const hasAircraftControlScope = remoteAccessEnable
        && remoteAircraftControlEnable
        && trustedOrigin
        && isPrivateOrLoopbackRemoteAddress(remoteAddress)
        && (
          hasPairedDeviceSession
          || (Boolean(aircraftControlToken) && requestedAircraftControlToken === aircraftControlToken)
        );
      const aircraftControlPairingStatus: AircraftControlPairingStatus = !requestedAircraftControlToken && !devicePairingSessionId
        ? 'not-requested'
        : (hasAircraftControlScope
          ? 'accepted'
          : (remoteAccessEnable && remoteAircraftControlEnable ? 'expired' : 'disabled'));

      if (!trustedOrigin && !hasValidToken) {
        Debug.log('ws', 'Rejected websocket handshake', {
          origin: origin || null,
          requestHost: requestHost || null,
          remoteAddress,
        });
        done(false, 401, 'Unauthorized');
        return;
      }

      if (subscribedTypes === 'invalid') {
        Debug.log('ws', 'Rejected websocket subscription', {
          origin: origin || null,
          remoteAddress,
        });
        done(false, 400, 'Bad Request');
        return;
      }

      if (info.req) {
        info.req.__ffWsMeta = {
          isPrivilegedClient: hasValidToken && !hasToolbarPresetScope,
          isAircraftControlClient: hasAircraftControlScope && !hasToolbarPresetScope,
          isToolbarPresetClient: hasToolbarPresetScope,
          aircraftControlPairingStatus,
          origin: origin || null,
          remoteAddress,
          subscribedTypes,
        };
      }

      done(true);
    },
  });

  // IMPORTANT: Ensure server-level errors don't crash the process via an unhandled 'error' event.
  // Treat listen/bind failures as fatal (matches prior unhandled-error behavior), but log clearly.
  wss.on('error', (error: Error) => {
    try {
      Debug.log('ws', 'WebSocket server error', { error: error?.message || String(error) });
    } catch {}
    console.error('[ws] WebSocket server error:', error?.message || error);
    if (typeof onFatalError === 'function') {
      onFatalError(error);
      return;
    }
    process.exit(1);
  });

  wss.on('listening', () => {
    console.log(`[ws] Bound to ${wsBindAddress}:${wsPort}`);
    console.log(`[simbridge:init] WS server: ws://localhost:${wsPort}`);
  });

  // Handle incoming WebSocket messages (for client requests)
  wss.on('connection', (ws: WsSocketLike, req: RequestLike) => {
    // Receiver errors (oversized frames, invalid UTF-8, protocol violations)
    // are emitted by the individual socket, not the server. Install this
    // before sending any state so a rejected frame cannot crash the backend.
    // ws closes the offending connection with the appropriate protocol code.
    ws.on('error', (error: { code?: unknown }) => {
      try {
        Debug.log('ws', 'WebSocket client error', {
          code: typeof error?.code === 'string' ? error.code.slice(0, 128) : null,
        });
      } catch {}
    });

    ws.__ffPrivilegedClient = req?.__ffWsMeta?.isPrivilegedClient === true;
    ws.__ffToolbarPresetClient = req?.__ffWsMeta?.isToolbarPresetClient === true;
    ws.__ffAircraftControlClient = req?.__ffWsMeta?.isAircraftControlClient === true;
    ws.__ffAircraftControlPairingStatus = req?.__ffWsMeta?.aircraftControlPairingStatus || 'not-requested';
    ws.__ffSubscribedTypes = req?.__ffWsMeta?.subscribedTypes || null;

    // Install the outbound boundary before connection-time state is sent.
    // This covers direct replies, reconnect snapshots, cached replay, and the
    // shared broadcaster without relying on every producer to remember the
    // client's authorization scope.
    if (typeof ws.send === 'function') {
      const rawSend = ws.send.bind(ws);
      const presetStream = ws.__ffSubscribedTypes?.has(MSG.TOOLBAR_PRESET_STATE) ? createToolbarPresetStream() : null;
      let outboundClosed = false;
      ws.send = (payload: string, ...args: any[]) => {
        if (outboundClosed || (ws.readyState !== undefined && ws.readyState !== WebSocket.OPEN)) return;
        // Direct replies and reconnect snapshots must not build an unbounded
        // queue when a client stops reading. Permit one large history reply on
        // an empty transport, but never add more replies behind a full queue.
        // Broadcasts retain their stricter per-message one-MiB limit.
        if (Number(ws.bufferedAmount || 0) >= MAX_WS_BUFFERED_BYTES) {
          outboundClosed = true;
          try {
            Debug.log('ws', 'Slow websocket client exceeded direct reply buffer limit - terminating', {
              bufferedBytes: ws.bufferedAmount,
              limitBytes: MAX_WS_BUFFERED_BYTES,
            });
          } catch {}
          try { ws.terminate?.(); } catch {}
          return;
        }
        if (presetStream) payload = presetStream(payload);
        // Avoid parsing and projecting the per-tick stream for subscribed
        // panels that will discard it. Retain the check after projection too.
        if (!isSubscribedMessage(ws.__ffSubscribedTypes, payload)) return;
        const projected = projectSerializedServerMessageForClient(ws, payload);
        if (projected === null) return;
        if (!isSubscribedMessage(ws.__ffSubscribedTypes, projected)) return;
        rawSend(projected, ...args);
      };
    }

    ws.send?.(JSON.stringify({
      type: MSG.AUTHORIZATION_SCOPE,
      scope: ws.__ffPrivilegedClient === true
        ? 'full-control'
        : (ws.__ffAircraftControlClient === true ? 'aircraft-control' : (ws.__ffToolbarPresetClient === true ? 'toolbar-presets' : 'read-only')),
      aircraftControlPairingStatus: ws.__ffAircraftControlPairingStatus,
    }));

    try {
      onClientConnected(ws);
    } catch (error) {
      const err = error as { message?: string };
      console.error('[ws] Error in onClientConnected:', err && err.message);
      Debug.log('ws', 'Error in onClientConnected', { error: err && err.message });
    }

    ws.on('message', async (data: { toString: () => string }) => {
      const rawPayload = data.toString();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawPayload) as Record<string, unknown>;
      } catch {
        const metadata = {
          payloadBytes: Buffer.byteLength(rawPayload, 'utf8'),
          privileged: ws.__ffPrivilegedClient === true,
          aircraftControl: ws.__ffAircraftControlClient === true,
        };
        console.error('[ws] Rejected invalid JSON message', metadata);
        Debug.log('ws', 'Rejected invalid JSON message', metadata);
        return;
      }

      try {
        tlog('[simbridge]', 'WS message received', {
          type: typeof msg.type === 'string' ? msg.type.slice(0, 128) : null,
          payloadBytes: Buffer.byteLength(rawPayload, 'utf8'),
          privileged: ws.__ffPrivilegedClient === true,
          aircraftControl: ws.__ffAircraftControlClient === true,
        });
        await onClientMessage(ws, msg);
      } catch (error) {
        const err = error as { message?: string };
        console.error('[ws] Error handling message:', err.message);
        Debug.log('ws', 'Error handling client message', { error: err.message });
      }
    });
  });

  return wss;
}
