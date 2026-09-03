'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizePushToTalkShortcut } = require('./voice-push-to-talk');

const MAX_HELPER_LINE_BYTES = 512;

function resolvePushToTalkHelperPath({ appDir, isPackaged, resourcesPath }) {
  return isPackaged
    ? path.join(resourcesPath, 'voice', 'ptt-hook.exe')
    : path.join(appDir, 'voice-native', 'ptt-hook', 'target', 'release', 'flight-fabric-ptt-hook.exe');
}

function createPushToTalkHelperSpawnOptions() {
  return {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // libuv puts non-detached Windows children in Node's kill-on-close job.
    detached: false,
  };
}

function createPushToTalkHook({
  helperPath,
  onDown,
  onUp,
  onError = () => {},
  spawnProcess = spawn,
}) {
  if (!path.isAbsolute(helperPath) || typeof onDown !== 'function' || typeof onUp !== 'function') {
    throw new TypeError('Valid push-to-talk helper options are required');
  }
  let child = null;
  let accelerator = '';
  let registered = false;
  let disposed = false;
  const spawnedChildren = new Set();
  const intentionallyStopped = new WeakSet();

  function getInfo() {
    return Object.freeze({ accelerator, registered });
  }

  function stop(target) {
    if (!target) return;
    intentionallyStopped.add(target);
    try { target.kill(); } catch {}
  }

  function launch(nextAccelerator) {
    if (!fs.existsSync(helperPath)) return Promise.reject(new Error('Push-to-talk helper is not built.'));
    return new Promise((resolve, reject) => {
      let candidate;
      let ready = false;
      let settled = false;
      let output = '';
      const timer = setTimeout(() => fail(new Error('Push-to-talk helper did not become ready.')), 3000);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop(candidate);
        reject(error);
      };
      try {
        candidate = spawnProcess(
          helperPath,
          ['--shortcut', nextAccelerator],
          createPushToTalkHelperSpawnOptions(),
        );
        spawnedChildren.add(candidate);
        candidate.once('close', () => spawnedChildren.delete(candidate));
      } catch (error) {
        fail(error);
        return;
      }
      const consumeLine = (line) => {
        if (!line || line.length > MAX_HELPER_LINE_BYTES) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event?.type === 'ready' && !ready) {
          ready = true;
          settled = true;
          clearTimeout(timer);
          resolve(candidate);
          return;
        }
        if (!ready || candidate !== child) return;
        if (event?.type === 'down') onDown(nextAccelerator);
        if (event?.type === 'up') onUp(nextAccelerator);
      };
      candidate.stdout?.on('data', (chunk) => {
        output += Buffer.from(chunk).toString('utf8');
        while (output.includes('\n')) {
          const index = output.indexOf('\n');
          const line = output.slice(0, index).replace(/\r$/, '');
          output = output.slice(index + 1);
          consumeLine(line);
        }
        if (output.length > MAX_HELPER_LINE_BYTES) output = '';
      });
      candidate.stderr?.on('data', () => {});
      candidate.on('error', (error) => {
        if (!ready) fail(error);
        else if (candidate === child && !intentionallyStopped.has(candidate)) {
          child = null;
          registered = false;
          onError(error);
        }
      });
      candidate.on('exit', (code) => {
        if (!ready) fail(new Error(`Push-to-talk helper exited before ready (${code ?? 'unknown'}).`));
        else if (candidate === child && !intentionallyStopped.has(candidate)) {
          child = null;
          registered = false;
          onError(new Error(`Push-to-talk helper stopped (${code ?? 'unknown'}).`));
        }
      });
    });
  }

  async function setShortcut(value) {
    if (disposed) throw new Error('Push-to-talk hook is disposed.');
    const next = normalizePushToTalkShortcut(value);
    if (registered && child && next === accelerator) return getInfo();
    const candidate = await launch(next);
    if (disposed) {
      stop(candidate);
      throw new Error('Push-to-talk hook is disposed.');
    }
    const previous = child;
    child = candidate;
    accelerator = next;
    registered = true;
    stop(previous);
    return getInfo();
  }

  function dispose() {
    disposed = true;
    for (const spawnedChild of spawnedChildren) stop(spawnedChild);
    child = null;
    accelerator = '';
    registered = false;
  }

  return Object.freeze({ dispose, getInfo, setShortcut });
}

module.exports = {
  createPushToTalkHelperSpawnOptions,
  createPushToTalkHook,
  resolvePushToTalkHelperPath,
};
