'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { validateKeys, verifyInstaller, versionGreater, updateError } = require('./update-manifest');

const INITIAL_DELAY_MS = 30000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const REPAIR_URL = 'https://github.com/yenbuilds/flight-fabric/releases';

function createUpdateService({ currentVersion, supported, trust, feed, createEngine, prepare,
  handoff, recover = async () => false, onState = () => {}, verify = verifyInstaller, cachePath, spacePaths = [], receiptPath = null,
  timers = globalThis, downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  let enabled = supported && trust.enabled === true;
  try { validateKeys(trust.keys); } catch { enabled = false; }
  let state = { supported: enabled, phase: enabled ? 'idle' : 'unavailable', currentVersion,
    version: '', notes: '', progress: null, message: enabled ? '' : 'Use the website download to update this build.', repairUrl: REPAIR_URL };
  let operation = null;
  let ready = null;
  let disposed = false;
  let endingSession = false;
  let initialTimer;
  let intervalTimer;
  const snapshot = () => ({ ...state });
  const publish = (patch) => { state = { ...state, ...patch }; onState(snapshot()); };
  const sameRelease = (a, b) => Boolean(a && b && a.version === b.version && a.sha512 === b.sha512 && a.size === b.size && a.url === b.url);
  const discardReady = () => { ready?.engine.dispose(); ready = null; };
  const isCurrent = (op) => operation === op && !op.controller.signal.aborted && !disposed && !endingSession;
  const requireCurrent = (op) => { if (!isCurrent(op)) throw updateError('cancelled', 'Update cancelled.'); };
  async function requireSpace(size) {
    await fs.mkdir(cachePath, { recursive: true });
    for (const directory of new Set([cachePath, ...spacePaths].map(value => path.resolve(value)))) {
      const space = await fs.statfs(directory);
      if (space.bavail * space.bsize < size * 3 + 256 * 1024 * 1024) {
        throw updateError('storage', 'There is not enough free space to download and prepare this update.');
      }
    }
  }

  async function refresh(op) {
    const payload = await feed.read(op.controller.signal);
    requireCurrent(op);
    const release = payload.release && versionGreater(payload.release.version, currentVersion) ? payload.release : null;
    if (!sameRelease(release, ready?.release)) discardReady();
    return release;
  }

  function run(phase, action) {
    if (!enabled || disposed || endingSession) return Promise.resolve(snapshot());
    if (operation) return operation.promise;
    const op = { controller: new AbortController(), promise: null };
    operation = op;
    publish({ phase, message: '', progress: null });
    op.promise = Promise.resolve().then(() => action(op)).catch((error) => {
      if (disposed || operation !== op) return;
      if (error.code === 'integrity') discardReady();
      publish({ phase: ready ? 'ready' : 'error', progress: null,
        message: op.controller.signal.aborted ? 'Update cancelled. You can try again.'
          : ['trust', 'expired', 'integrity', 'storage', 'blocked', 'network'].includes(error.code)
            ? error.message : 'The update could not be completed. Try again or use the website download.' });
    }).finally(() => {
      if (operation === op) operation = null;
    }).then(snapshot);
    return op.promise;
  }

  const service = {
    snapshot,
    check() {
      return run('checking', async (op) => {
        const release = await refresh(op);
        publish({ phase: ready ? 'ready' : release ? 'available' : 'current', version: release?.version || '',
          notes: release?.notes || '', message: release ? '' : 'You have the latest available version.' });
      });
    },
    download() {
      return run('checking', async (op) => {
        const release = await refresh(op);
        if (!release) {
          publish({ phase: 'current', version: '', notes: '', message: 'This update is no longer offered. Check again later.' });
          return;
        }
        if (ready) { publish({ phase: 'ready' }); return; }
        await requireSpace(release.size);
        requireCurrent(op);
        const engine = createEngine({ release, currentVersion, signal: op.controller.signal,
          onProgress: (progress) => { if (isCurrent(op)) publish({ progress }); } });
        publish({ phase: 'downloading', version: release.version, notes: release.notes, progress: 0 });
        const timer = timers.setTimeout(() => op.controller.abort(), downloadTimeoutMs);
        try {
          const file = await engine.download();
          requireCurrent(op);
          publish({ phase: 'verifying', progress: null });
          await verify(file, release, op.controller.signal);
          requireCurrent(op);
          ready = { file, release, engine };
          publish({ phase: 'ready', message: 'Ready when you are. Finish your simulator session before restarting.' });
        } finally {
          timers.clearTimeout(timer);
          if (ready?.engine !== engine) engine.dispose();
        }
      });
    },
    install() {
      if (!ready) return Promise.resolve(snapshot());
      return run('preparing', async (op) => {
        const selected = ready;
        const release = await refresh(op);
        if (ready !== selected || !sameRelease(release, selected.release)) {
          publish({ phase: release ? 'available' : 'current', version: release?.version || '',
            notes: release?.notes || '', message: 'The offered update changed. Check and download the current release.' });
          return;
        }
        await verify(selected.file, release, op.controller.signal);
        await requireSpace(release.size);
        requireCurrent(op);
        let receiptWritten = false;
        try {
          // Preparation must positively acknowledge clean backend shutdown.
          await prepare(op.controller.signal);
          requireCurrent(op);
          // Rehash after asynchronous cleanup, immediately before handing off.
          await verify(selected.file, release, op.controller.signal);
          requireCurrent(op);
          if (receiptPath) {
            await fs.mkdir(path.dirname(receiptPath), { recursive: true });
            await fs.writeFile(receiptPath, JSON.stringify({ version: release.version, previousVersion: currentVersion }), { mode: 0o600 });
            receiptWritten = true;
          }
          requireCurrent(op);
          publish({ phase: 'installing', message: 'Restarting FlightFabric to install the update.' });
          await handoff(() => selected.engine.install(), op.controller.signal);
        } catch (error) {
          if (receiptWritten) await fs.unlink(receiptPath).catch(() => {});
          if (!disposed && !endingSession) {
            publish({ phase: 'preparing', message: 'The update did not start. Restoring FlightFabric…' });
            let restored = false;
            try { restored = await recover(); } catch {}
            if (!restored) {
              if (error.code === 'integrity') discardReady();
              throw updateError('blocked', 'The update did not start and services could not be restored. Restart FlightFabric before trying again.');
            }
          }
          throw error;
        }
      });
    },
    cancel() {
      if (operation && !['preparing', 'installing'].includes(state.phase)) {
        operation.controller.abort();
        publish({ message: 'Cancelling update…' });
      }
      return snapshot();
    },
    sessionEnding() { endingSession = true; operation?.controller.abort(); },
    async completeStartup(healthy) {
      if (!receiptPath || !enabled || operation || disposed) return;
      let pending;
      try {
        const text = await fs.readFile(receiptPath, 'utf8');
        if (text.length > 1024) return;
        pending = JSON.parse(text);
      } catch { return; }
      if (operation || disposed || !pending || typeof pending.version !== 'string') return;
      if (pending.version === currentVersion && healthy) {
        await fs.unlink(receiptPath).catch(() => {});
        publish({ message: `Updated to version ${currentVersion}.` });
      } else {
        publish({ phase: 'error', message: 'The previous update did not finish starting successfully. Try again or use the website download to repair FlightFabric.' });
      }
    },
    start() {
      if (!enabled || initialTimer || intervalTimer) return;
      initialTimer = timers.setTimeout(() => { void service.check(); }, INITIAL_DELAY_MS);
      intervalTimer = timers.setInterval(() => { if (!operation && !ready) void service.check(); }, CHECK_INTERVAL_MS);
      initialTimer.unref?.();
      intervalTimer.unref?.();
    },
    dispose() {
      disposed = true;
      operation?.controller.abort();
      timers.clearTimeout(initialTimer);
      timers.clearInterval(intervalTimer);
      discardReady();
    },
  };
  return service;
}

module.exports = { createUpdateService, REPAIR_URL };
