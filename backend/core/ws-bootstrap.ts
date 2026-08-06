// ws-bootstrap.js
// Minimal WebSocket bootstrap helper for the core runtime.

const WebSocket = require('ws');
const net = require('net') as typeof import('net');
const { MSG } = require('./message-types');
const {
  projectSerializedServerMessageForClient,
} = require('./server-message-projection');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

type DebugLike = {
  log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};

type LoggerFn = (...args: unknown[]) => void;
type WsSocketLike = {
  on: (eventName: string, handler: (...args: any[]) => void | Promise<void>) => void;
  send?: (payload: string, ...args: any[]) => void;
  __ffPrivilegedClient?: boolean;
  __ffAircraftControlClient?: boolean;
};
type ClientConnectedHandler = (ws: WsSocketLike) => void;
type ClientMessageHandler = (ws: WsSocketLike, msg: Record<string, unknown>) => Promise<void> | void;
type RequestLike = import('http').IncomingMessage & {
  __ffWsMeta?: {
    isPrivilegedClient: boolean;
    isAircraftControlClient: boolean;
    origin: string | null;
    remoteAddress: string | null;
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
      const hasValidToken = Boolean(wsAuthToken) && token === wsAuthToken;
      const remoteAddress = info.req?.socket?.remoteAddress || null;
      const trustedOrigin = isPrivateOrLoopbackRemoteAddress(remoteAddress)
        && isTrustedWsOrigin(origin, requestHost, remoteAccessEnable);
      const hasAircraftControlScope = remoteAccessEnable
        && remoteAircraftControlEnable
        && trustedOrigin
        && isPrivateOrLoopbackRemoteAddress(remoteAddress)
        && Boolean(aircraftControlToken)
        && requestedAircraftControlToken === aircraftControlToken;

      if (!trustedOrigin && !hasValidToken) {
        Debug.log('ws', 'Rejected websocket handshake', {
          origin: origin || null,
          requestHost: requestHost || null,
          remoteAddress,
        });
        done(false, 401, 'Unauthorized');
        return;
      }

      if (info.req) {
        info.req.__ffWsMeta = {
          isPrivilegedClient: hasValidToken,
          isAircraftControlClient: hasAircraftControlScope,
          origin: origin || null,
          remoteAddress,
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
    ws.__ffPrivilegedClient = req?.__ffWsMeta?.isPrivilegedClient === true;
    ws.__ffAircraftControlClient = req?.__ffWsMeta?.isAircraftControlClient === true;

    // Install the outbound boundary before connection-time state is sent.
    // This covers direct replies, reconnect snapshots, cached replay, and the
    // shared broadcaster without relying on every producer to remember the
    // client's authorization scope.
    if (typeof ws.send === 'function') {
      const rawSend = ws.send.bind(ws);
      ws.send = (payload: string, ...args: any[]) => {
        const projected = projectSerializedServerMessageForClient(ws, payload);
        if (projected === null) return;
        rawSend(projected, ...args);
      };
    }

    ws.send?.(JSON.stringify({
      type: MSG.AUTHORIZATION_SCOPE,
      scope: ws.__ffPrivilegedClient === true
        ? 'full-control'
        : (ws.__ffAircraftControlClient === true ? 'aircraft-control' : 'read-only'),
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
