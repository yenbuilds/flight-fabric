// update-checker.js
// Periodically fetches a remote version manifest and broadcasts updateAvailable
// to connected clients when a newer version is detected.
//
// Manifest JSON format (hosted at MANIFEST_URL):
//   {
//     "version":     "0.2.0",          // required - semver string
//     "downloadUrl": "https://...",    // required - link shown in the update banner
//     "message":     "Security fix",   // optional - short note displayed in banner
//     "urgent":      false             // optional - true makes the banner red
//   }
//
// To configure: update MANIFEST_URL to point at a publicly accessible raw JSON file.
// Recommended: a GitHub Gist, a public GitHub repo raw URL, or any static HTTPS host.

const https = require('https') as typeof import('https');
const { MSG } = require('./message-types.js') as {
  MSG: {
    UPDATE_AVAILABLE: string;
  };
};

type UpdateManifest = {
  version?: unknown;
  downloadUrl?: unknown;
  message?: unknown;
  urgent?: unknown;
} | null;

export type UpdateAvailableMessage = {
  type: string;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string | null;
  message: string | null;
  urgent: boolean;
};

type BroadcastFn = (payload: UpdateAvailableMessage) => void;
type UpdateCheckerHandle = {
  stop: () => void;
};

// Configuration. Must be HTTPS and publicly accessible without auth.
const MANIFEST_URL = 'https://raw.githubusercontent.com/yenbuilds/ff-releases/main/update-manifest.json';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // re-check daily
const INITIAL_DELAY_MS = 30 * 1000; // first check 30 s after startup
const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_MANIFEST_BYTES = 128 * 1024;
const RELEASE_DOWNLOAD_HOST = 'github.com';
const RELEASE_DOWNLOAD_PATH_PREFIX = '/yenbuilds/flight-fabric/releases';

// Cached result - replayed to newly-connected clients on requestState.
let lastUpdateMsg: UpdateAvailableMessage | null = null;

/**
 * Fetch and parse the remote manifest JSON over HTTPS.
 * @returns {Promise<object>}
 */
function fetchManifest(): Promise<UpdateManifest> {
  return new Promise((resolve, reject) => {
    const req = https.get(MANIFEST_URL, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if ((res.statusCode ?? 500) !== 200) {
        res.resume(); // drain so socket is freed
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      let byteLength = 0;
      res.on('data', (chunk: Buffer | string) => {
        byteLength += Buffer.byteLength(String(chunk), 'utf8');
        if (byteLength > MAX_MANIFEST_BYTES) {
          req.destroy(new Error('Update manifest response exceeded 128 KB.'));
          return;
        }
        body += String(chunk);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as UpdateManifest);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Returns true if semver string `a` is strictly greater than `b`.
 * Handles standard MAJOR.MINOR.PATCH format.
 */
function semverGt(a: string, b: string): boolean {
  const parse = (v: string): number[] => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

export function sanitizeUpdateDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== RELEASE_DOWNLOAD_HOST) return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    if (parsed.search || parsed.hash) return null;

    const pathname = parsed.pathname.toLowerCase();
    if (
      pathname !== RELEASE_DOWNLOAD_PATH_PREFIX
      && !pathname.startsWith(`${RELEASE_DOWNLOAD_PATH_PREFIX}/`)
    ) return null;

    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Start the periodic update check.
 *
 * @param {object} options
 * @param {function} options.broadcast      - broadcast(obj) fan-out to all WS clients
 * @param {string}  options.currentVersion  - current app version string (e.g. "0.1.2")
 */
export function startUpdateChecker({
  broadcast,
  currentVersion,
}: {
  broadcast: BroadcastFn;
  currentVersion: string;
}): UpdateCheckerHandle {
  let stopped = false;

  async function check(): Promise<void> {
    if (stopped) return;

    try {
      const manifest = await fetchManifest();

      if (stopped) return;
      if (!manifest || typeof manifest.version !== 'string') return;
      if (!semverGt(manifest.version, currentVersion)) return;

      lastUpdateMsg = {
        type: MSG.UPDATE_AVAILABLE,
        currentVersion,
        latestVersion: manifest.version,
        downloadUrl: sanitizeUpdateDownloadUrl(manifest.downloadUrl),
        message: typeof manifest.message === 'string' ? manifest.message : null,
        urgent: manifest.urgent === true,
      };

      broadcast(lastUpdateMsg);
      console.log(`[update-checker] New version available: ${currentVersion} -> ${manifest.version}`);
    } catch {
      // Silently skip - network errors are expected when offline or manifest not yet live.
    }
  }

  const initialTimer = setTimeout(check, INITIAL_DELAY_MS);
  initialTimer.unref();
  const intervalTimer = setInterval(check, CHECK_INTERVAL_MS);
  intervalTimer.unref(); // don't prevent process exit

  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

/**
 * Returns the last detected update message (or null), for replay on requestState.
 */
export function getLastUpdateMsg(): UpdateAvailableMessage | null {
  return lastUpdateMsg;
}
