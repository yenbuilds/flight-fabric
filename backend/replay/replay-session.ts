const fs = require('node:fs') as typeof import('node:fs');
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LandingReplayClip } from './landing-clip';

const { createReplayController, createReplayOutputReader } = require('./native-controller');
const { resolveRustBinaryPath, buildSidecarEnv } = require('../telemetry-provider/rust-simvar-bridge');
const { getAppDataRoot } = require('../utils/storage-paths');
const execute = promisify(execFile);
const CONTROL_STATES = new Set(['ready', 'arming', 'paused', 'playing', 'recovery', 'restoring', 'done', 'recovery-required']);

// This service owns one shared session, independent of UI tabs/connections.
// The native lease and durable journal remain the authority for simulator writes.
export function createReplaySession(options: {
  enabled?: boolean;
  prepareClip: (file: string, landing: number) => Promise<any>;
  suspend: () => Promise<void>;
  resume: () => Promise<void>;
  entryBlocker: () => string;
  publish: (message: any) => void;
  directory?: string;
  launch?: (session: string, clipPath: string | null) => Promise<any>;
}) {
  const enabled = options.enabled === true;
  const directory = options.directory || path.join(getAppDataRoot(), 'Replay');
  const journalPath = path.join(directory, 'recovery.json');
  let clip: LandingReplayClip | null = null;
  let child: any = null;
  let controller: any = null;
  let busy = false;
  let blocked = fs.existsSync(journalPath);
  let closed = false;
  let sequence = 0;
  let generation = 0;
  let workerTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNativeAt = 0;
  let state: any = {
    type: 'inSimReplayState', enabled, session: crypto.randomUUID(), state: blocked ? 'recoveryRequired' : 'idle',
    title: '', loadedTitle: '', durationMs: 0, positionMs: 0, touchdownMs: 0, readyToStart: false,
    detail: blocked ? 'A previous replay needs recovery. Reconnect recovery, then reload the same aircraft parked with engines off.' : '',
    error: '', pending: false, blocked,
  };
  if (blocked) {
    try {
      if (fs.statSync(journalPath).size <= 4096) state.title = String(JSON.parse(fs.readFileSync(journalPath, 'utf8')).title || '').slice(0, 255);
    } catch { /* Native recovery validates the authoritative journal. */ }
  }
  const publish = (patch: any = {}) => {
    state = { ...state, ...patch, blocked, revision: ++sequence };
    options.publish({ ...state });
  };
  const fail = (error: string) => { publish({ error, pending: false }); };
  const closeController = (reason: string) => {
    controller?.close();
    publish({ state: 'recoveryRequired', readyToStart: false, pending: false, error: reason });
  };
  async function launch(session: string, clipPath: string | null) {
    if (options.launch) return options.launch(session, clipPath);
    if (process.platform !== 'win32') throw new Error('In-simulator replay needs Windows and MSFS 2024.');
    const binary = resolveRustBinaryPath();
    if (!binary) throw new Error('Replay helper is missing. Rebuild or update FlightFabric.');
    const env = buildSidecarEnv();
    const probe = await execute(binary, ['--probe'], { env, windowsHide: true, timeout: 8000, maxBuffer: 65536 });
    const compatible = probe.stdout.split(/\r?\n/).some(line => {
      try { const value = JSON.parse(line); return value.ok === true && value.replayProtocolVersion === 1; } catch { return false; }
    });
    if (!compatible) throw new Error('Replay needs the matching updated simulator helper. Rebuild or update FlightFabric.');
    // Older helpers cannot honor the replay lease. Do not terminate another app.
    const running = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Process -Filter \"Name = 'ff-rust-simconnect-sidecar.exe'\" -ErrorAction Stop).Count"],
    { windowsHide: true, timeout: 8000, maxBuffer: 4096 });
    if (!/^0\s*$/.test(running.stdout)) throw new Error('Close other simulator companion apps or replay helpers, then try again.');
    return spawn(binary, ['--dedicated-replay', `--replay-session=${session}`,
      ...(clipPath ? [`--replay-clip=${clipPath}`] : ['--replay-recover'])],
    { env, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  async function resumeLive() {
    if (closed) return;
    // Never resume based only on an acknowledgement or a closed pipe.
    if (fs.existsSync(journalPath)) throw new Error('Reload recovery is still required.');
    await options.resume();
    blocked = false;
    generation++;
  }
  async function connect(recover: boolean) {
    generation++;
    blocked = true; // synchronous: closes command/recording gates before any await
    publish({ state: 'connecting', pending: true, readyToStart: false, error: '' });
    let clipPath: string | null = null;
    try {
      await options.suspend();
      if (closed) throw new Error('FlightFabric is closing.');
      if (!recover) {
        fs.mkdirSync(directory, { recursive: true });
        clipPath = path.join(directory, `clip-${state.session}.json`);
        fs.writeFileSync(clipPath, JSON.stringify(clip), { flag: 'wx' });
      }
      child = await launch(state.session, clipPath);
      controller = createReplayController({ input: child.stdin, session: state.session, notice: (reason: string) => closeController(reason) });
      const currentChild = child;
      if (closed) controller.close();
      let sawDone = false;
      lastNativeAt = Date.now();
      workerTimer = setInterval(() => {
        if (Date.now() - lastNativeAt > 5000) closeController('Replay helper stopped responding. Keep MSFS open and use recovery.');
      }, 1000);
      workerTimer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', createReplayOutputReader((message: any) => {
        if (message.session !== state.session) throw new Error('Unexpected replay session');
        lastNativeAt = Date.now();
        if (message.type === 'replayStatus' && CONTROL_STATES.has(message.state)) {
          sawDone = message.state === 'done';
          publish({ state: message.state === 'recovery-required' ? 'recoveryRequired' : message.state, positionMs: message.positionMs, detail: message.detail || (['playing', 'paused'].includes(message.state) ? '' : state.detail),
            pending: controller.isPending(), readyToStart: message.state === 'ready' && state.readyToStart });
        } else if (message.type === 'replayEligibility') {
          publish({ readyToStart: state.state === 'ready' && message.readyToStart === true,
            loadedTitle: String(message.loadedTitle || '').slice(0, 255),
            ...(state.state === 'ready' ? { detail: String(message.detail || '').slice(0, 512) } : {}) });
        } else if (message.type === 'replayAck' && controller.acknowledge(message)) {
          publish({ pending: false, error: message.ok ? '' : String(message.error || 'Replay command was rejected.').slice(0, 512) });
        }
      }, (reason: string) => closeController(reason)));
      // Drain stderr without accumulating native diagnostics or exposing paths.
      child.stderr.on('data', () => {});
      child.on('error', () => fail('Replay helper could not start. Check the FlightFabric installation.'));
      child.on('close', async (code: number) => {
        if (child !== currentChild) return;
        if (workerTimer) clearInterval(workerTimer);
        controller?.close(); controller = null; child = null;
        if (clipPath) { try { fs.unlinkSync(clipPath); } catch {} }
        if (closed) return;
        try {
          if (code !== 0 || !sawDone) throw new Error('Replay helper stopped. Reconnect recovery if requested; do not resume flight from a replay frame.');
          await resumeLive();
          publish({ state: 'done', pending: false, readyToStart: false, detail: 'Replay ended. Live FlightFabric connection restored.', error: '' });
        } catch (error) {
          publish({ state: 'recoveryRequired', pending: false, readyToStart: false, error: (error as Error).message });
        }
      });
    } catch (error) {
      if (clipPath) { try { fs.unlinkSync(clipPath); } catch {} }
      // Keep live mode suspended if shutdown did not complete or recovery exists.
      publish({ state: 'recoveryRequired', pending: false, error: (error as Error).message });
    }
  }
  return {
    isBlocking: () => blocked,
    generation: () => generation,
    snapshot: () => ({ ...state }),
    async request(message: any, privileged: boolean) {
      if (closed) return;
      if (message.operation === 'status') return;
      // Keep recovery available after a development session or downgrade, while
      // rejecting every operation that could prepare or play another clip.
      if (!enabled && !['recover', 'stop', 'dismiss'].includes(message.operation)) {
        throw new Error('In-simulator replay is disabled in this build.');
      }
      if (busy) throw new Error('Replay is preparing. Wait for it to finish.');
      const operation = message.operation;
      if (operation === 'prepare') {
        if (!privileged) throw new Error('Choose the recording in the FlightFabric client.');
        if (blocked || child) throw new Error('Finish the current replay and recovery first.');
        if (typeof message.filePath !== 'string' || !Number.isSafeInteger(message.landingIndex) || message.landingIndex < 0) throw new Error('Choose a saved landing first.');
        busy = true;
        publish({ state: 'preparing', pending: true, error: '', title: '', loadedTitle: '', durationMs: 0, positionMs: 0, touchdownMs: 0, readyToStart: false });
        try {
          const result = await options.prepareClip(message.filePath, message.landingIndex);
          if (!result.success || !result.clip) throw new Error(result.error || 'This landing cannot be replayed.');
          clip = result.clip;
          publish({ session: crypto.randomUUID(), state: 'prepared', title: clip.title, profileId: clip.profileId,
            durationMs: clip.durationMs, touchdownMs: clip.touchdownMs, positionMs: 0, pending: false, detail: 'Follow the aircraft setup steps, then check the aircraft.' });
        } catch (error) { clip = null; publish({ state: 'idle', pending: false, error: (error as Error).message }); }
        finally { busy = false; }
        return;
      }
      if (message.session !== state.session) throw new Error('Replay selection changed. Wait for the current session and try again.');
      if (operation === 'dismiss') {
        if (!privileged || blocked || child) throw new Error('Finish replay and recovery before closing the replay panel.');
        clip = null;
        publish({ state: 'idle', title: '', loadedTitle: '', durationMs: 0, positionMs: 0, touchdownMs: 0, detail: '', error: '', pending: false });
        return;
      }
      if (operation === 'connect') {
        if (!privileged) throw new Error('Prepare replay in the FlightFabric client first.');
        if (blocked || child || !clip || state.state !== 'prepared') throw new Error('Prepare a saved landing first.');
        if (message.recordedAt1x !== true || message.acceptReload !== true) throw new Error('Confirm the recording was at 1x and that you understand the reload step.');
        const blocker = options.entryBlocker();
        if (blocker) throw new Error(blocker);
        busy = true;
        try { await connect(false); } finally { busy = false; }
        return;
      }
      if (operation === 'recover') {
        if (child || !blocked) throw new Error('Follow the current recovery instructions.');
        busy = true;
        try {
          if (fs.existsSync(journalPath)) await connect(true);
          else { await resumeLive(); publish({ state: clip ? 'prepared' : 'idle', pending: false, error: '', detail: 'Live connection restored. You can retry setup.' }); }
        } finally { busy = false; }
        return;
      }
      if (!controller) throw new Error('Check the aircraft in the client before starting replay.');
      if (!['start', 'play', 'pause', 'seek', 'stop'].includes(operation)) throw new Error('Unknown replay command.');
      if (operation === 'seek' && (!Number.isFinite(message.positionMs) || message.positionMs < 0 || message.positionMs > state.durationMs)) throw new Error('Choose a position within this landing clip.');
      if (operation === 'start' && state.readyToStart !== true) throw new Error(state.detail || 'The aircraft is not ready.');
      publish({ pending: true, error: '' });
      if (!controller.send({ type: operation, ...(operation === 'seek' ? { positionMs: message.positionMs } : {}) })) fail('Wait for the previous replay command to finish.');
    },
    stop() {
      closed = true;
      if (workerTimer) clearInterval(workerTimer);
      // EOF sends the surviving native worker into reload recovery, never an
      // airborne unfreeze. On restart the durable journal keeps live mode out.
      controller?.close();
    },
  };
}
