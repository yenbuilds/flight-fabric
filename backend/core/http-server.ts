const http = require('http') as typeof import('http');
const https = require('https') as typeof import('https');
const net = require('net') as typeof import('net');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const fs = require('fs') as typeof import('fs');
const crypto = require('crypto') as typeof import('crypto');
const {
  getCabinAnnouncementAudioDir,
  getThemesDir,
} = require('../utils/storage-paths.js') as {
  getCabinAnnouncementAudioDir: () => string;
  getThemesDir: () => string;
};
const {
  isPathInside,
  resolveWithinRoot,
} = require('../utils/path-guard') as {
  isPathInside: (parentDir: string | null | undefined, childPath: string | null | undefined, options?: { allowEqual?: boolean }) => boolean;
  resolveWithinRoot: (rootDir: string | null | undefined, relativePath: string, options?: { allowEqual?: boolean }) => string | null;
};
const timeSource = require('./time-source.js') as {
  now: () => number;
};
const config = require('./config.js') as {
  env: { isElectronPackaged: boolean };
};

type DebugLike = {
  log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};

type RequestLike = import('http').IncomingMessage & {
  url?: string | null;
  headers: import('http').IncomingHttpHeaders;
  method?: string | null;
};

type ResponseLike = import('http').ServerResponse;

// Rate limiter for the SimBrief proxy: one accepted attempt per username per 30 s.
// Failed attempts remain in cooldown so nonexistent usernames cannot be hammered.
const SIMBRIEF_RATE_LIMIT_MS = 30 * 1000;
const SIMBRIEF_RATE_LIMIT_RETENTION_MS = 10 * 60 * 1000;
const SIMBRIEF_RATE_LIMIT_MAX_KEYS = 500;
const SIMBRIEF_MAX_IN_FLIGHT = 8;
const SIMBRIEF_MAX_IN_FLIGHT_PER_CLIENT = 2;
const SIMBRIEF_ATTEMPT_WINDOW_MS = 60 * 1000;
const SIMBRIEF_MAX_ATTEMPTS_PER_WINDOW = 30;
const SIMBRIEF_MAX_ATTEMPTS_PER_CLIENT_WINDOW = 10;
const SIMBRIEF_REQUEST_TIMEOUT_MS = 15 * 1000;

type SimbriefLimiterLease = {
  allowed: true;
  release: () => void;
};

type SimbriefLimiterRejection = {
  allowed: false;
  statusCode: 429 | 503;
  retryAfterSeconds: number;
  error: string;
};

function normalizeSimbriefClientAddress(remoteAddress: string | null | undefined): string {
  let value = String(remoteAddress || '').trim().toLowerCase();
  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  return value || 'unknown';
}

export function createSimbriefRequestLimiter({
  now = () => timeSource.now(),
  cooldownMs = SIMBRIEF_RATE_LIMIT_MS,
  retentionMs = SIMBRIEF_RATE_LIMIT_RETENTION_MS,
  maxKeys = SIMBRIEF_RATE_LIMIT_MAX_KEYS,
  maxInFlight = SIMBRIEF_MAX_IN_FLIGHT,
  maxInFlightPerClient = SIMBRIEF_MAX_IN_FLIGHT_PER_CLIENT,
  attemptWindowMs = SIMBRIEF_ATTEMPT_WINDOW_MS,
  maxAttemptsPerWindow = SIMBRIEF_MAX_ATTEMPTS_PER_WINDOW,
  maxAttemptsPerClientWindow = SIMBRIEF_MAX_ATTEMPTS_PER_CLIENT_WINDOW,
}: {
  now?: () => number;
  cooldownMs?: number;
  retentionMs?: number;
  maxKeys?: number;
  maxInFlight?: number;
  maxInFlightPerClient?: number;
  attemptWindowMs?: number;
  maxAttemptsPerWindow?: number;
  maxAttemptsPerClientWindow?: number;
} = {}): {
  acquire: (username: string, remoteAddress: string | null | undefined) => SimbriefLimiterLease | SimbriefLimiterRejection;
} {
  const lastAttemptByUsername = new Map<string, number>();
  const inFlightUsernames = new Set<string>();
  const inFlightByClient = new Map<string, number>();
  const attemptWindowsByClient = new Map<string, { startedAt: number; count: number }>();
  let globalAttemptWindow: { startedAt: number; count: number } | null = null;
  let inFlightTotal = 0;
  let lastSweep = 0;

  function prune(at: number): void {
    for (const [clientKey, window] of attemptWindowsByClient) {
      if (at < window.startedAt || at - window.startedAt >= attemptWindowMs) {
        attemptWindowsByClient.delete(clientKey);
      }
    }
    if (at - lastSweep < cooldownMs && lastAttemptByUsername.size <= maxKeys) return;
    lastSweep = at;

    const cutoff = at - retentionMs;
    for (const [username, lastAttempt] of lastAttemptByUsername) {
      if (lastAttempt <= cutoff && !inFlightUsernames.has(username)) {
        lastAttemptByUsername.delete(username);
      }
    }

    if (lastAttemptByUsername.size <= maxKeys) return;
    const removable = [...lastAttemptByUsername.entries()]
      .filter(([username]) => !inFlightUsernames.has(username))
      .sort((left, right) => left[1] - right[1]);
    const excess = lastAttemptByUsername.size - maxKeys;
    for (const [username] of removable.slice(0, excess)) {
      lastAttemptByUsername.delete(username);
    }
  }

  function acquire(username: string, remoteAddress: string | null | undefined): SimbriefLimiterLease | SimbriefLimiterRejection {
    const at = now();
    const clientKey = normalizeSimbriefClientAddress(remoteAddress);
    prune(at);

    if (inFlightUsernames.has(username)) {
      return {
        allowed: false,
        statusCode: 429,
        retryAfterSeconds: 1,
        error: 'A SimBrief request for this username is already in progress.',
      };
    }

    const lastAttempt = lastAttemptByUsername.get(username);
    if (lastAttempt !== undefined && at - lastAttempt < cooldownMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((cooldownMs - (at - lastAttempt)) / 1000));
      return {
        allowed: false,
        statusCode: 429,
        retryAfterSeconds,
        error: `Rate limited. Retry in ${retryAfterSeconds}s.`,
      };
    }

    const clientInFlight = inFlightByClient.get(clientKey) || 0;
    if (clientInFlight >= maxInFlightPerClient) {
      return {
        allowed: false,
        statusCode: 429,
        retryAfterSeconds: 1,
        error: 'Too many SimBrief requests are already in progress from this client.',
      };
    }
    if (inFlightTotal >= maxInFlight) {
      return {
        allowed: false,
        statusCode: 503,
        retryAfterSeconds: 1,
        error: 'The SimBrief proxy is busy. Try again shortly.',
      };
    }

    const clientAttemptWindow = attemptWindowsByClient.get(clientKey);
    if (clientAttemptWindow && clientAttemptWindow.count >= maxAttemptsPerClientWindow) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((clientAttemptWindow.startedAt + attemptWindowMs - at) / 1000),
      );
      return {
        allowed: false,
        statusCode: 429,
        retryAfterSeconds,
        error: `Too many SimBrief requests from this client. Retry in ${retryAfterSeconds}s.`,
      };
    }

    if (
      globalAttemptWindow
      && (at < globalAttemptWindow.startedAt || at - globalAttemptWindow.startedAt >= attemptWindowMs)
    ) {
      globalAttemptWindow = null;
    }
    if (globalAttemptWindow && globalAttemptWindow.count >= maxAttemptsPerWindow) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((globalAttemptWindow.startedAt + attemptWindowMs - at) / 1000),
      );
      return {
        allowed: false,
        statusCode: 429,
        retryAfterSeconds,
        error: `The SimBrief proxy rate limit was reached. Retry in ${retryAfterSeconds}s.`,
      };
    }

    lastAttemptByUsername.set(username, at);
    inFlightUsernames.add(username);
    inFlightByClient.set(clientKey, clientInFlight + 1);
    inFlightTotal += 1;
    if (clientAttemptWindow) clientAttemptWindow.count += 1;
    else attemptWindowsByClient.set(clientKey, { startedAt: at, count: 1 });
    if (globalAttemptWindow) globalAttemptWindow.count += 1;
    else globalAttemptWindow = { startedAt: at, count: 1 };

    let released = false;
    return {
      allowed: true,
      release() {
        if (released) return;
        released = true;
        inFlightUsernames.delete(username);
        inFlightTotal = Math.max(0, inFlightTotal - 1);
        const remainingForClient = (inFlightByClient.get(clientKey) || 1) - 1;
        if (remainingForClient > 0) inFlightByClient.set(clientKey, remainingForClient);
        else inFlightByClient.delete(clientKey);
      },
    };
  }

  return { acquire };
}

const HTTP_PORT_OFFSET = 1; // HTTP port is WS port + this offset
const CABIN_ANNOUNCEMENTS_DIR = getCabinAnnouncementAudioDir();
const THEMES_DIR = getThemesDir();
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function resolveRepoAssetPath(...segments: string[]): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', ...segments),
    path.resolve(__dirname, '..', '..', '..', ...segments),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

const FRONTEND_SOURCE_DIR = resolveRepoAssetPath('frontend');
const FRONTEND_DIST_DIR = resolveRepoAssetPath('frontend-dist');
export function resolvePackagedFrontendDir(moduleDir: string, packaged: boolean): string | null {
  return packaged ? path.resolve(moduleDir, '..', '..', 'frontend') : null;
}
const FRONTEND_PACKAGED_DIR = resolvePackagedFrontendDir(
  __dirname,
  config.env.isElectronPackaged,
);
const BUNDLED_THEMES_DIR = resolveRepoAssetPath('frontend', 'themes');
const STATIC_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.html': 'text/html',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};
const STATIC_ASSET_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
};

const VIRTUAL_INTERFACE_RE = /(docker|wsl|hyper-v|vethernet|vmware|virtualbox|vbox|tailscale|zerotier|vpn|tunnel|tun|tap|bridge|loopback)/i;
const WIFI_INTERFACE_RE = /(wi-?fi|wlan|wireless)/i;
const ETHERNET_INTERFACE_RE = /(ethernet|^eth\d*$|^en\d+$|lan)/i;

function isPrivateLanIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (
    octets.length !== 4
    || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function scoreLocalIPv4(interfaceName: string, address: string): number {
  let score = 0;

  if (address.startsWith('192.168.')) score += 400;
  else if (address.startsWith('10.')) score += 300;
  else if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(address)) score += 200;
  else if (address.startsWith('169.254.')) score -= 1000;
  else score -= 500;

  if (WIFI_INTERFACE_RE.test(interfaceName)) score += 120;
  else if (ETHERNET_INTERFACE_RE.test(interfaceName)) score += 80;

  if (VIRTUAL_INTERFACE_RE.test(interfaceName)) score -= 250;

  return score;
}

export function getLocalIPsFromInterfaces(nets: ReturnType<typeof os.networkInterfaces>): string[] {
  const results: Array<{ address: string; interfaceName: string; score: number; index: number }> = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal || !net.address) continue;
      results.push({
        address: net.address,
        interfaceName: name,
        score: scoreLocalIPv4(name, net.address),
        index: results.length,
      });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return results.map((entry) => entry.address);
}

function getLocalIPs(): string[] {
  return getLocalIPsFromInterfaces(os.networkInterfaces());
}

function resolveSafeAssetPath(rootDir: string, relativePath: string): string | null {
  const candidate = resolveWithinRoot(rootDir, relativePath);
  if (!candidate || !fs.existsSync(candidate)) return candidate;

  try {
    const rootStat = fs.lstatSync(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const targetStat = fs.lstatSync(candidate);
    if (targetStat.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(rootDir);
    const realTarget = fs.realpathSync(candidate);
    return isPathInside(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

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

function formatCspHostSource(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

function isLoopbackHost(hostname: string | null | undefined): boolean {
  return LOOPBACK_HOSTS.has(normalizeHostname(hostname));
}

function isLoopbackRemoteAddress(remoteAddress: string | null | undefined): boolean {
  const value = String(remoteAddress || '').trim().toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function isPrivateNetworkAddress(address: string | null | undefined): boolean {
  let value = normalizeHostname(address);
  if (!value) return false;

  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);

  const ipVersion = net.isIP(value);
  if (ipVersion === 4) return isPrivateLanIpv4(value);
  if (ipVersion !== 6) return false;

  const firstIpv6Hextet = value.split(':', 1)[0];
  const parsedHextet = Number.parseInt(firstIpv6Hextet, 16);
  return Number.isFinite(parsedHextet) && (parsedHextet & 0xfe00) === 0xfc00;
}

function isPrivateOrLoopbackNetworkAddress(address: string | null | undefined): boolean {
  return isLoopbackRemoteAddress(address) || isPrivateNetworkAddress(address);
}

export function isTrustedHttpRequest(
  req: RequestLike,
  remoteAccessEnable: boolean,
): boolean {
  const remoteAddress = req.socket?.remoteAddress;
  const requestHost = extractHostnameFromHostHeader(req.headers.host);

  if (isLoopbackRemoteAddress(remoteAddress) && isLoopbackHost(requestHost)) {
    return true;
  }

  return remoteAccessEnable
    && isPrivateOrLoopbackNetworkAddress(remoteAddress)
    && isPrivateNetworkAddress(requestHost);
}

function isLoopbackRequest(req: RequestLike): boolean {
  return isLoopbackRemoteAddress(req.socket?.remoteAddress)
    && isLoopbackHost(extractHostnameFromHostHeader(req.headers.host));
}

function isLoopbackSecretRequest(req: RequestLike): boolean {
  // Browser requests from another localhost origin carry an Origin header and
  // must not inherit desktop session secrets merely because both peers use
  // loopback. Same-origin browser GETs and the Electron main-process proxy do
  // not send Origin, preserving the supported local bootstrap paths.
  return isLoopbackRequest(req) && req.headers.origin === undefined;
}

function resolveCorsAllowOrigin(
  origin: string | null | undefined,
  req: RequestLike,
  remoteAccessEnable: boolean,
): string | null {
  if (!origin) return null;
  if (origin === 'null') {
    return null;
  }

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const originHost = normalizeHostname(parsed.hostname);
    const requestHost = extractHostnameFromHostHeader(req.headers.host);
    if (isLoopbackHost(originHost)) {
      return isLoopbackHost(requestHost) ? origin : null;
    }

    if (
      remoteAccessEnable
      && requestHost
      && originHost === requestHost
      && isPrivateNetworkAddress(requestHost)
    ) {
      return origin;
    }
  } catch {
    return null;
  }

  return null;
}

export function buildContentSecurityPolicy(
  req: RequestLike,
  nonce: string,
  remoteAccessEnable: boolean,
): string {
  const connectSources = new Set([
    "'self'",
    'http://localhost:*',
    'http://127.0.0.1:*',
    'http://[::1]:*',
    'ws://localhost:*',
    'ws://127.0.0.1:*',
    'ws://[::1]:*',
  ]);
  const requestHost = extractHostnameFromHostHeader(req.headers.host);
  if (remoteAccessEnable && isPrivateLanIpv4(requestHost)) {
    const hostSource = formatCspHostSource(requestHost);
    connectSources.add(`http://${hostSource}:*`);
    connectSources.add(`ws://${hostSource}:*`);
  }

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.basemaps.cartocdn.com",
    "media-src 'self' data: blob:",
    `connect-src ${[...connectSources].join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}

export function injectCspNonce(html: string, nonce: string): string {
  if (!nonce) return html;
  return html.replace(
    /<script\b(?![^>]*\bsrc\s*=)(?![^>]*\bnonce\s*=)([^>]*)>/gi,
    `<script nonce="${nonce}"$1>`,
  );
}

export function buildBootstrapPayload(
  req: RequestLike,
  wsAuthToken: string,
  aircraftControlToken: string,
  networkInfo: { ips: string[]; httpPort: number | null; wsPort: number | null } = { ips: [], httpPort: null, wsPort: null },
  remoteAccessEnabled = false,
): {
  ok: true;
  wsAuthToken: string;
  aircraftControlToken: string;
  remoteAccessEnabled: boolean;
  networkInfo: { ips: string[]; httpPort: number | null; wsPort: number | null };
} {
  // The peer address alone is insufficient: under DNS rebinding or a second
  // localhost web app, a browser can reach this listener with another Origin.
  // Keep session secrets local only when the peer and Host are loopback and
  // the request is not a cross-origin browser request.
  const isLoopbackClient = isLoopbackSecretRequest(req);
  return {
    ok: true,
    wsAuthToken: isLoopbackClient ? wsAuthToken : '',
    aircraftControlToken: isLoopbackClient ? aircraftControlToken : '',
    remoteAccessEnabled: remoteAccessEnabled === true,
    networkInfo: isLoopbackClient
      ? {
        ips: Array.isArray(networkInfo.ips) ? networkInfo.ips : [],
        httpPort: Number.isInteger(networkInfo.httpPort) ? networkInfo.httpPort : null,
        wsPort: Number.isInteger(networkInfo.wsPort) ? networkInfo.wsPort : null,
      }
      : { ips: [], httpPort: null, wsPort: null },
  };
}

function buildMobileBrowserUrl(
  host: string,
  httpPort: number,
  wsPort: number,
  aircraftControlToken: string,
  exposeAircraftControlToken: boolean,
): string {
  const baseUrl = `http://${host}:${httpPort}/remote`;
  const query = new URLSearchParams();
  if (Number.isInteger(wsPort) && wsPort > 0) query.set('wsPort', String(wsPort));
  if (exposeAircraftControlToken && aircraftControlToken) {
    query.set('aircraftControlToken', aircraftControlToken);
  }
  const serializedQuery = query.toString();
  return serializedQuery ? `${baseUrl}?${serializedQuery}` : baseUrl;
}

function resolveFrontendAssetCandidates(relativePath: string): string[] {
  const seen = new Set<string>();
  const candidates = [
    FRONTEND_PACKAGED_DIR && resolveSafeAssetPath(FRONTEND_PACKAGED_DIR, relativePath),
    resolveSafeAssetPath(FRONTEND_DIST_DIR, relativePath),
    resolveSafeAssetPath(FRONTEND_SOURCE_DIR, relativePath),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function streamFirstExistingFile(
  res: ResponseLike,
  filePaths: string[],
  contentType?: string,
  htmlNonce?: string,
): void {
  function tryNext(index: number): void {
    if (index >= filePaths.length) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const filePath = filePaths[index];
    fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0), (openErr, descriptor) => {
      if (openErr) {
        tryNext(index + 1);
        return;
      }

      fs.fstat(descriptor, (statErr, stat) => {
        if (statErr || !stat.isFile()) {
          fs.close(descriptor, () => tryNext(index + 1));
          return;
        }

        if (contentType === 'text/html' && htmlNonce) {
          fs.readFile(descriptor, 'utf8', (readErr, html) => {
            fs.close(descriptor, () => {
              if (readErr) {
                tryNext(index + 1);
                return;
              }
              const body = injectCspNonce(html, htmlNonce);
              res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': Buffer.byteLength(body),
                ...STATIC_ASSET_HEADERS,
              });
              res.end(body);
            });
          });
          return;
        }

        res.writeHead(200, {
          'Content-Type': contentType || 'application/octet-stream',
          'Content-Length': stat.size,
          ...STATIC_ASSET_HEADERS,
        });
        const stream = fs.createReadStream(filePath, { fd: descriptor, autoClose: true });
        stream.on('error', () => { try { res.end(); } catch {} });
        stream.pipe(res);
      });
    });
  }

  tryNext(0);
}

export function startHttpServer({
  wsPort,
  httpPort,
  remoteAccessEnable,
  wsAuthToken = '',
  aircraftControlToken = '',
  Debug,
  onFatalError,
}: {
  wsPort: number;
  httpPort: number | null | undefined;
  remoteAccessEnable: boolean;
  wsAuthToken?: string;
  aircraftControlToken?: string;
  Debug: DebugLike;
  onFatalError?: (error: Error) => void;
}): {
  httpServer: import('http').Server;
  httpPort: number;
  httpBindAddress: string;
} {
  const resolvedHttpPort = Number.isFinite(Number(httpPort))
    ? Number(httpPort)
    : (wsPort + HTTP_PORT_OFFSET);
  const httpBindAddress = remoteAccessEnable ? '0.0.0.0' : '127.0.0.1';
  const simbriefRequestLimiter = createSimbriefRequestLimiter();

  const httpServer = http.createServer((req: RequestLike, res: ResponseLike) => {
    if (!isTrustedHttpRequest(req, remoteAccessEnable)) {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'Connection': 'close',
      });
      res.end('Forbidden');
      return;
    }

    const cspNonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', buildContentSecurityPolicy(req, cspNonce, remoteAccessEnable));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const requestUrl = req.url || '/';
    let requestPathname = '/';
    try {
      requestPathname = new URL(requestUrl, 'http://localhost').pathname;
    } catch {}
    console.log('[http] Request:', req.method, requestPathname);
    const localIPs = getLocalIPs();
    const primaryIP = localIPs[0] || 'localhost';

    // CORS: allow localhost/loopback origins always; allow private-LAN origins
    // when remote access is enabled; block public (internet) origins.
    const origin = req.headers.origin;
    if (origin) {
      const allowOrigin = resolveCorsAllowOrigin(origin, req, remoteAccessEnable);
      if (allowOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowOrigin);
        res.setHeader('Vary', 'Origin');
      }
    } else {
      // No Origin header: native/mobile apps or same-origin Electron requests.
      // Allow by omitting the ACAO header - browser same-origin policy does not
      // apply when there is no Origin, so this is safe.
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && requestUrl === '/api/bootstrap') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0',
      });
      res.end(JSON.stringify(buildBootstrapPayload(
        req,
        wsAuthToken,
        aircraftControlToken,
        {
          ips: localIPs.filter(isPrivateLanIpv4),
          httpPort: resolvedHttpPort,
          wsPort,
        },
        remoteAccessEnable,
      )));
      return;
    }

    // GET /api/simbrief
    // Proxy: fetches the user's latest OFP from SimBrief and returns the
    // JSON response. Rate-limited to 1 request per username per 30 seconds
    // (user-initiated, per architecture rule 2.11).
    //
    // Query params:
    //   username - SimBrief username / pilot ID (required)
    if (req.method === 'GET' && requestUrl.startsWith('/api/simbrief')) {
      const qs = new URL(requestUrl, 'http://localhost').searchParams;
      const rawUsername = (qs.get('username') || '').trim();

      // Validate: alphanumeric + underscore/hyphen, 1-40 chars
      if (!rawUsername || !/^[A-Za-z0-9_-]{1,40}$/.test(rawUsername)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid or missing username parameter' }));
        return;
      }

      const username = rawUsername.toLowerCase();
      const admission = simbriefRequestLimiter.acquire(username, req.socket?.remoteAddress);
      if (admission.allowed === false) {
        res.writeHead(admission.statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, max-age=0',
          'Retry-After': String(admission.retryAfterSeconds),
        });
        res.end(JSON.stringify({ ok: false, error: admission.error }));
        return;
      }

      const simbriefUrl = `https://www.simbrief.com/api/xml.fetcher.php?username=${encodeURIComponent(username)}&json=1`;
      let fetchRequest: import('http').ClientRequest | null = null;
      let terminal = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const finish = (
        statusCode?: number,
        payload?: Record<string, unknown>,
      ): void => {
        if (terminal) return;
        terminal = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        admission.release();

        if (statusCode === undefined || res.destroyed || res.writableEnded) return;
        if (!res.headersSent) {
          res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, max-age=0',
          });
        }
        res.end(JSON.stringify(payload));
      };

      const cancelForClientDisconnect = (): void => {
        if (terminal) return;
        finish();
        fetchRequest?.destroy();
      };
      req.once('aborted', cancelForClientDisconnect);
      res.once('close', () => {
        if (!res.writableEnded) cancelForClientDisconnect();
      });

      timeoutHandle = setTimeout(() => {
        if (terminal) return;
        const requestToDestroy = fetchRequest;
        finish(504, { ok: false, error: 'SimBrief request timed out' });
        requestToDestroy?.destroy();
      }, SIMBRIEF_REQUEST_TIMEOUT_MS);
      timeoutHandle.unref?.();

      try {
        fetchRequest = https.get(
          simbriefUrl,
          { timeout: SIMBRIEF_REQUEST_TIMEOUT_MS },
          (sbRes) => {
            let data = '';

            const failUpstreamResponse = (error: string): void => {
              if (terminal) return;
              const requestToDestroy = fetchRequest;
              finish(502, { ok: false, error });
              requestToDestroy?.destroy();
            };

            sbRes.on('data', (chunk) => {
              if (terminal) return;
              data += String(chunk);
              // Safety cap - SimBrief OFPs are large but not >2 MB
              if (data.length > 2 * 1024 * 1024) {
                failUpstreamResponse('SimBrief response too large');
              }
            });
            sbRes.once('aborted', () => {
              failUpstreamResponse('SimBrief response was interrupted');
            });
            sbRes.once('error', () => {
              failUpstreamResponse('SimBrief response failed');
            });
            sbRes.once('close', () => {
              if (!sbRes.complete) {
                failUpstreamResponse('SimBrief response was interrupted');
              }
            });
            sbRes.once('end', () => {
              if (terminal) return;
              let ofp: any;
              try {
                ofp = JSON.parse(data);
              } catch {
                finish(502, { ok: false, error: 'SimBrief returned non-JSON response' });
                return;
              }
              // SimBrief returns HTTP 400 (Bad Request) for invalid usernames or
              // other errors. Do NOT rely on the body's fetch.status string -
              // the actual error text is e.g. "Error: Unknown UserID", not
              // "Not Found". Use the HTTP status code as the authoritative signal.
              if (sbRes.statusCode !== 200) {
                const errMsg = ofp?.fetch?.status || `SimBrief error (HTTP ${sbRes.statusCode})`;
                finish(404, { ok: false, error: errMsg });
                return;
              }
              finish(200, { ok: true, ofp });
            });
          },
        );
        fetchRequest.once('timeout', () => {
          if (terminal) return;
          const requestToDestroy = fetchRequest;
          finish(504, { ok: false, error: 'SimBrief request timed out' });
          requestToDestroy?.destroy();
        });
        fetchRequest.once('error', (error) => {
          const err = error as { message?: string };
          finish(502, { ok: false, error: 'Failed to reach SimBrief: ' + (err.message || 'unknown error') });
        });
      } catch (error) {
        const err = error as { message?: string };
        finish(502, { ok: false, error: 'Failed to reach SimBrief: ' + (err.message || 'unknown error') });
      }
      return;
    }

    // --- /setup: mobile browser connection page ---
    if (requestUrl === '/setup' || requestUrl.startsWith('/setup?')) {
      const browserUrl = buildMobileBrowserUrl(
        primaryIP,
        resolvedHttpPort,
        wsPort,
        aircraftControlToken,
        isLoopbackSecretRequest(req),
      );
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store, max-age=0',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flight Fabric - Mobile Browser Setup</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 2rem; text-align: center; }
    h1 { color: #58a6ff; margin-bottom: 0.25rem; }
    .sub { color: #8b949e; margin-bottom: 1.5rem; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.5rem; margin: 1rem auto; max-width: 420px; }
    .url { font-size: 1rem; color: #58a6ff; word-break: break-all; font-family: monospace; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .steps { text-align: left; line-height: 1.8; }
    .steps b { color: #3fb950; }
    .ip { font-size: 2rem; font-weight: bold; color: #3fb950; font-family: monospace; letter-spacing: 1px; }
    .alt { font-size: 0.85rem; color: #8b949e; margin-top: 1rem; }
    .warn { border-color: #8a5a1f; background: #211a10; color: #f0d59a; text-align: left; line-height: 1.6; }
    .warn b { color: #f6c15f; }
  </style>
</head><body>
  <h1>Mobile Browser Setup</h1>
  <p class="sub">Open the Flight Fabric dashboard in your phone browser</p>
  <div class="card">
    <div style="color:#8b949e;font-size:0.9rem;margin-bottom:0.5rem;">Your PC's LAN IP</div>
    <div class="ip">${primaryIP}</div>
    ${localIPs.length > 1 ? '<div class="alt">Other IPs: ' + localIPs.slice(1).join(', ') + '</div>' : ''}
  </div>
  <div class="card">
    <div style="color:#8b949e;font-size:0.9rem;margin-bottom:0.5rem;">Phone browser URL</div>
    <div class="url"><a href="${browserUrl}">${browserUrl}</a></div>
  </div>
  <div class="card warn">
    <b>Trusted LAN only.</b> Use this setup page only on a private home network you trust.
    Do not use Flight Fabric remote access on hotel, airport, school, workplace, hotspot, or other public/shared networks.
  </div>
  <div class="card steps">
    <b>1.</b> Connect your phone to the <b>same WiFi</b> network<br>
    <b>2.</b> Open the URL above in your phone browser<br>
    <b>3.</b> The live dashboard will appear
  </div>
  <div class="card">
    <div style="color:#8b949e;font-size:0.95rem;line-height:1.6;">
      When this page is opened on the simulator PC, its phone URL includes a session-only aircraft-control pairing token.
      Treat the URL as private. A setup page opened from another device shows a read-only URL instead.
    </div>
  </div>
  <!-- browser link for programmatic use, not shown prominently -->
  <div style="display:none;"><a href="${browserUrl}">${browserUrl}</a></div>
</body></html>`);
      return;
    }

    if (requestUrl === '/' || requestUrl === '/remote' || requestUrl === '/remote.html' || requestUrl === '/overlay' || requestUrl.startsWith('/remote?') || requestUrl.startsWith('/?')) {
      res.setHeader('Referrer-Policy', 'no-referrer');
      streamFirstExistingFile(res, resolveFrontendAssetCandidates('index.html'), 'text/html', cspNonce);
      return;
    }

    const urlPath = requestUrl.split('?')[0];
    if (urlPath.startsWith('/user-assets/cabin/')) {
      const relativePath = urlPath.slice('/user-assets/cabin/'.length);
      const userFilePath = resolveSafeAssetPath(CABIN_ANNOUNCEMENTS_DIR, relativePath);
      if (!userFilePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const ext = path.extname(relativePath).toLowerCase();
      streamFirstExistingFile(
        res,
        [userFilePath],
        STATIC_MIME_TYPES[ext] || 'application/octet-stream',
      );
      return;
    }

    if (urlPath.startsWith('/user-assets/themes/')) {
      const relativePath = urlPath.slice('/user-assets/themes/'.length);
      const userThemePath = resolveSafeAssetPath(THEMES_DIR, relativePath);
      const bundledThemePath = resolveSafeAssetPath(BUNDLED_THEMES_DIR, relativePath);
      if (!userThemePath || !bundledThemePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const ext = path.extname(userThemePath).toLowerCase();
      streamFirstExistingFile(
        res,
        [userThemePath, bundledThemePath],
        STATIC_MIME_TYPES[ext] || 'application/octet-stream',
      );
      return;
    }

    if (urlPath.match(/^\/shared\/.*\.js$/)) {
      const sharedRoot = resolveRepoAssetPath('shared');
      const relativePath = urlPath.slice('/shared/'.length);
      const filePath = resolveSafeAssetPath(sharedRoot, relativePath);
      if (!filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      streamFirstExistingFile(
        res,
        [filePath],
        STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      );
      return;
    }

    if (urlPath.match(/^\/(tailwind\.css|style\.css|themes\/.*|audio\/.*|vendor\/.*|.*\.js|.*\.css|.*\.png|.*\.svg|.*\.ico|.*\.html)$/)) {
      const relativePath = urlPath.replace(/^\//, '');
      const candidatePaths = resolveFrontendAssetCandidates(relativePath);
      if (candidatePaths.length === 0) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const ext = path.extname(relativePath).toLowerCase();
      streamFirstExistingFile(
        res,
        candidatePaths,
        STATIC_MIME_TYPES[ext] || 'application/octet-stream',
        ext === '.html' ? cspNonce : undefined,
      );
      return;
    }

    const browserUrl = buildMobileBrowserUrl(
      primaryIP,
      resolvedHttpPort,
      wsPort,
      aircraftControlToken,
      isLoopbackSecretRequest(req),
    );
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flight Fabric</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; text-align: center; }
    h1 { color: #58a6ff; }
    .box { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.5rem; margin: 1rem auto; max-width: 400px; }
    .ip { font-size: 2rem; font-weight: bold; color: #3fb950; font-family: monospace; }
    a { color: #58a6ff; }
    code { background: #21262d; padding: 0.2rem 0.5rem; border-radius: 4px; }
    .step { text-align: left; margin: 0.5rem 0; }
  </style>
</head>
<body>
  <h1>Flight Fabric</h1>
  <div class="box">
    <div>Your PC's IP address:</div>
    <div class="ip">${primaryIP}</div>
  </div>
  <div class="box">
    <h3>Connect from your phone:</h3>
    <div class="step">1. Ensure your phone is on the same WiFi network</div>
    <div class="step">2. Open this URL in your phone browser:</div>
    <div class="step"><a href="${browserUrl}"><code>${browserUrl}</code></a></div>
    <div class="step">3. The live dashboard will appear</div>
  </div>
  <div class="box">
    <div>WebSocket endpoint for custom apps:</div>
    <code>ws://${primaryIP}:${wsPort}</code>
  </div>
  ${localIPs.length > 1 ? '<div class="box" style="font-size:0.9rem; color:#8b949e;">Other IPs: ' + localIPs.slice(1).join(', ') + '</div>' : ''}
</body>
</html>`);
  });

  httpServer.on('error', (error) => {
    const err = error as { message?: string };
    try {
      Debug.log('http', 'HTTP server error', { error: err?.message || String(err) });
    } catch {}
    console.error('[http] HTTP server error:', err?.message || err);
    if (typeof onFatalError === 'function') {
      onFatalError(error);
      return;
    }
    process.exit(1);
  });

  httpServer.listen(resolvedHttpPort, httpBindAddress, () => {
    console.log(`[http] Bound to ${httpBindAddress}:${resolvedHttpPort}`);
    const localIPs = getLocalIPs();
    console.log(`[simbridge:init] HTTP server: http://localhost:${resolvedHttpPort}`);
    if (httpBindAddress === '0.0.0.0' && localIPs.length > 0) {
      console.log(`[simbridge:init] Remote URL: http://${localIPs[0]}:${resolvedHttpPort}/remote`);
      console.log(`[simbridge:init] Mobile setup: http://localhost:${resolvedHttpPort}/setup`);
    } else if (httpBindAddress === '127.0.0.1') {
      console.log('[simbridge:init] Remote access disabled (REMOTE_ACCESS_ENABLE=1 to enable)');
    }
  });

  return { httpServer, httpPort: resolvedHttpPort, httpBindAddress };
}
