/**
 * simbridge.js
 *
 * Backend process entry point.
 *
 * The truth loop lives in `simbridge-core.js` and consumes a `TelemetryProvider`.
 */

const path = require('path') as typeof import('path');
const readline = require('readline') as typeof import('readline');

type ConfigLike = {
  env: { isPackaged: boolean; parentStdinLifeline: boolean };
  poll: { rateMs: number };
  logging: { intervalMs: number };
  simconnect: { protocol: string; requestedProtocol: string };
  xplane: { experimentalEnable: boolean };
  ws: { port: number };
};

type ProviderFactory = (options: {
  isMock: boolean;
  isXPlane: boolean;
  simulatorProtocol: string;
}) => unknown;

type RunSimbridgeCore = (options: {
  provider: unknown;
  pollRateMs: number;
  logIntervalMs: number;
  wsPort: number;
  httpPort: number | null;
  shutdownSignal?: AbortSignal;
  onFatalError?: (source: string, error: unknown) => void;
}) => Promise<void>;

function loadEnvFiles(fileName: string, options: { override?: boolean } = {}): void {
  const candidates = [
    path.resolve(__dirname, '..', fileName),
    path.resolve(__dirname, '..', '..', fileName),
    path.resolve(__dirname, '..', '..', '..', fileName),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      require('dotenv').config({ path: candidate, quiet: true, ...options });
    } catch {}
  }
}

// Load env vars: .env first, then .env.local (local overrides, gitignored)
loadEnvFiles('.env');
loadEnvFiles('.env.local', { override: true });

const config = require('./config.js') as ConfigLike;
const { createProvider } = require('../telemetry-provider') as {
  createProvider: ProviderFactory;
};
const { resolveXPlaneStartupSelection } = require('./xplane-startup-gate.js') as {
  resolveXPlaneStartupSelection: (options: {
    explicitEnable: boolean;
    cliRequested: boolean;
    simulatorProtocol: string;
  }) => {
    requested: boolean;
    enabled: boolean;
    blocked: boolean;
    isXPlane: boolean;
    simulatorProtocol: string;
  };
};
const { runSimbridgeCore } = require('./simbridge-core.js') as {
  runSimbridgeCore: RunSimbridgeCore;
};

// CONFIG / FLAGS
const IS_MOCK = process.argv.includes('--mock');
const XPLANE_SELECTION = resolveXPlaneStartupSelection({
  explicitEnable: config.xplane.experimentalEnable,
  cliRequested: process.argv.includes('--xplane'),
  simulatorProtocol: config.simconnect.requestedProtocol,
});
const POLL_RATE = config.poll.rateMs;
const LOG_INTERVAL_MS = config.logging.intervalMs;
// Electron and the standalone wrapper own the final Windows process-tree kill
// at 12 seconds. Keep the backend's last-resort parent-only exit later so a
// supervised shutdown cannot reparent native sidecars before that tree kill.
const CORE_SHUTDOWN_WAIT_TIMEOUT_MS = 14000;
const BACKEND_FORCE_EXIT_TIMEOUT_MS = 15000;

// Shutdown handler - backup on exit
let shutdownInProgress = false;
let shutdownExitCode = 0;
const shutdownController = new AbortController();
let coreRunPromise: Promise<void> | null = null;

function waitForCoreShutdown(timeoutMs: number): Promise<void> {
  if (!coreRunPromise) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      console.warn('[simbridge] Core cleanup timed out; exiting.');
      finish();
    }, timeoutMs);
    timeout.unref();

    coreRunPromise
      .then(() => finish())
      .catch((error) => {
        console.error('[simbridge] Core cleanup failed:', error?.message || error);
        finish();
      });
  });
}

async function handleShutdown(signal: string, exitCode = 0): Promise<void> {
  if (Number.isInteger(exitCode) && exitCode > shutdownExitCode) {
    shutdownExitCode = exitCode;
  }
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  console.log(`\n[simbridge] Received ${signal}, shutting down...`);

  // Direct/unsupervised launches still get a last-resort exit. Supervised
  // launches force-stop the complete process tree before this timer fires.
  const forceExitTimer = setTimeout(() => {
    console.log('[simbridge] Force exit (cleanup timeout)');
    process.exit(shutdownExitCode);
  }, BACKEND_FORCE_EXIT_TIMEOUT_MS);
  forceExitTimer.unref();

  if (!shutdownController.signal.aborted) {
    shutdownController.abort(signal);
  }

  await waitForCoreShutdown(CORE_SHUTDOWN_WAIT_TIMEOUT_MS);

  clearTimeout(forceExitTimer);
  process.exit(shutdownExitCode);
}

// Register signal handlers
process.on('SIGINT', () => { void handleShutdown('SIGINT'); }); // Ctrl+C
process.on('SIGTERM', () => { void handleShutdown('SIGTERM'); }); // kill command
process.on('SIGHUP', () => { void handleShutdown('SIGHUP'); }); // terminal closed

// Electron opts into a stdin lifeline when it launches the backend. A structured
// command provides the normal graceful-shutdown path on Windows, where signals
// can terminate the child abruptly. EOF covers Electron crashes and hard exits.
// Do not enable this for ordinary CLI launches: ignored/redirected stdin can be
// at EOF from process startup.
if (config.env.parentStdinLifeline && !process.stdin.isTTY) {
  const parentInput = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  parentInput.on('line', (line: string) => {
    let message: { type?: unknown; reason?: unknown } | null = null;
    try {
      message = JSON.parse(line);
    } catch {
      console.warn('[simbridge] Ignoring malformed parent control message.');
      return;
    }

    if (message?.type !== 'shutdown') return;
    const reason = typeof message.reason === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(message.reason)
      ? message.reason
      : 'parent_shutdown_request';
    void handleShutdown(reason);
  });

  parentInput.on('close', () => {
    void handleShutdown('parent_stdin_eof');
  });

  process.stdin.on('error', (error) => {
    console.warn('[simbridge] Parent stdin lifeline failed:', error.message);
    void handleShutdown('parent_stdin_error');
  });
}

// Windows-specific: handle Ctrl+C and window close (interactive terminals only)
if (process.platform === 'win32' && process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { void handleShutdown('SIGINT'); });
  rl.on('close', () => { void handleShutdown('close'); });

  // Enable raw mode to ensure Ctrl+C is captured even in tight loops
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key: Buffer) => {
    // Ctrl+C sends byte 0x03
    if (key[0] === 0x03) {
      void handleShutdown('SIGINT');
    }
  });
}

function readArgValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const prefix = name + '=';
  const hit = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

void (async () => {
  if (IS_MOCK && config.env.isPackaged) {
    console.error('[simbridge] Refusing to start in --mock mode when packaged (V1 release).');
    process.exit(1);
  }

  if (XPLANE_SELECTION.blocked) {
    console.warn(
      '[simbridge] Ignoring an X-Plane startup request because the temporary '
      + 'FF_ENABLE_EXPERIMENTAL_XPLANE=1 developer gate is not enabled.',
    );
  }

  const provider = createProvider({
    isMock: IS_MOCK,
    isXPlane: XPLANE_SELECTION.isXPlane,
    simulatorProtocol: XPLANE_SELECTION.simulatorProtocol,
  });

  const wsPortArgRaw = Number.parseInt(readArgValue('--ws-port') || 'NaN', 10);
  const wsPortEnvRaw = config.ws.port;
  const wsPort = Number.isFinite(wsPortArgRaw)
    ? wsPortArgRaw
    : (Number.isFinite(wsPortEnvRaw) ? wsPortEnvRaw : 8099);

  const httpPortArgRaw = Number.parseInt(readArgValue('--http-port') || 'NaN', 10);
  const httpPort = Number.isFinite(httpPortArgRaw) ? httpPortArgRaw : null;

  coreRunPromise = runSimbridgeCore({
    provider,
    pollRateMs: POLL_RATE,
    logIntervalMs: LOG_INTERVAL_MS,
    wsPort,
    httpPort,
    shutdownSignal: shutdownController.signal,
    onFatalError: (source, error) => {
      console.error(`[simbridge] Fatal ${source} error:`, (error as Error)?.message || error);
      void handleShutdown(`fatal_${source}`, 1);
    },
  });
  await coreRunPromise;
})().catch((error) => {
  console.error('Fatal error in simbridge:', error);
  // runSimbridgeCore can reject while acquiring resources, before its runtime
  // loop has entered the core-level try/finally. Merely logging that rejection
  // leaves any already-open servers and native sidecars keeping this process
  // alive. Enter the supervised shutdown path so the backend exits non-zero;
  // sidecars watching this exact backend process then terminate as well.
  void handleShutdown('fatal_error', 1);
});

export {};
