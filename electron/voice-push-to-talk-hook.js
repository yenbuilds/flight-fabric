'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  normalizePushToTalkJoystick,
  normalizePushToTalkShortcut,
  pushToTalkHelperArguments,
} = require('./voice-push-to-talk');

// Device events carry a product string and a Windows device path, so lines
// are longer than the bare down/up events but still far below this bound.
const MAX_HELPER_LINE_BYTES = 4096;
const HELPER_READY_TIMEOUT_MS = 3000;

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

// The helper reports what Windows told it about a stick; treat it like any
// other input before it reaches settings or the renderer.
function joystickIdentityFromEvent(event) {
  try {
    const identity = normalizePushToTalkJoystick({
      vendorId: event?.vendorId,
      productId: event?.productId,
      button: 1,
      name: event?.name,
      path: event?.path,
    });
    const buttons = Number(event?.buttons);
    return Object.freeze({
      vendorId: identity.vendorId,
      productId: identity.productId,
      name: identity.name,
      path: identity.path,
      buttons: Number.isSafeInteger(buttons) && buttons > 0 ? buttons : 0,
    });
  } catch {
    return null;
  }
}

function stopHelper(target, intentionallyStopped) {
  if (!target) return;
  intentionallyStopped.add(target);
  try { target.kill(); } catch {}
}

// Spawns one helper process and resolves once it reports ready. Events after
// that go to onEvent; an unexpected end goes to onStopped. The caller owns
// the returned child and stops it through stopHelper.
function launchHelper({ helperPath, args, onEvent, onStopped, spawnProcess, spawnedChildren, intentionallyStopped }) {
  if (!fs.existsSync(helperPath)) return Promise.reject(new Error('Push-to-talk helper is not built.'));
  return new Promise((resolve, reject) => {
    let candidate;
    let ready = false;
    let settled = false;
    let output = '';
    const timer = setTimeout(() => fail(new Error('Push-to-talk helper did not become ready.')), HELPER_READY_TIMEOUT_MS);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopHelper(candidate, intentionallyStopped);
      reject(error);
    };
    try {
      candidate = spawnProcess(helperPath, args, createPushToTalkHelperSpawnOptions());
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
      if (!ready || intentionallyStopped.has(candidate)) return;
      onEvent(event, candidate);
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
      else if (!intentionallyStopped.has(candidate)) onStopped(error, candidate);
    });
    candidate.on('exit', (code) => {
      if (!ready) fail(new Error(`Push-to-talk helper exited before ready (${code ?? 'unknown'}).`));
      else if (!intentionallyStopped.has(candidate)) {
        onStopped(new Error(`Push-to-talk helper stopped (${code ?? 'unknown'}).`), candidate);
      }
    });
  });
}

function sameBinding(left, right) {
  return left.accelerator === right.accelerator
    && JSON.stringify(left.joystick) === JSON.stringify(right.joystick);
}

function createPushToTalkHook({
  helperPath,
  onDown,
  onUp,
  onDevice = () => {},
  onError = () => {},
  spawnProcess = spawn,
}) {
  if (!path.isAbsolute(helperPath) || typeof onDown !== 'function' || typeof onUp !== 'function') {
    throw new TypeError('Valid push-to-talk helper options are required');
  }
  let child = null;
  let binding = { accelerator: '', joystick: null };
  let registered = false;
  let joystickConnected = false;
  let disposed = false;
  const spawnedChildren = new Set();
  const intentionallyStopped = new WeakSet();

  function getInfo() {
    return Object.freeze({
      accelerator: binding.accelerator,
      joystick: binding.joystick,
      joystickConnected,
      registered,
    });
  }

  function launch(nextBinding) {
    return launchHelper({
      helperPath,
      args: pushToTalkHelperArguments(nextBinding),
      spawnProcess,
      spawnedChildren,
      intentionallyStopped,
      onEvent: (event, candidate) => {
        if (candidate !== child) return;
        if (event?.type === 'down') onDown(binding.accelerator);
        else if (event?.type === 'up') onUp(binding.accelerator);
        else if (event?.type === 'device' && binding.joystick) {
          joystickConnected = event.connected === true;
          onDevice(getInfo());
        }
      },
      onStopped: (error, candidate) => {
        if (candidate !== child) return;
        child = null;
        registered = false;
        joystickConnected = false;
        onError(error);
      },
    });
  }

  // Applies a keyboard shortcut and/or a joystick button. The helper holds
  // both at once, so any change restarts it with the full set; clearing both
  // stops it.
  async function setBinding(value) {
    if (disposed) throw new Error('Push-to-talk hook is disposed.');
    const next = {
      accelerator: value?.accelerator ? normalizePushToTalkShortcut(value.accelerator) : '',
      joystick: normalizePushToTalkJoystick(value?.joystick),
    };
    if (registered && child && sameBinding(next, binding)) return getInfo();
    if (!next.accelerator && !next.joystick) {
      const previous = child;
      child = null;
      binding = next;
      registered = false;
      joystickConnected = false;
      stopHelper(previous, intentionallyStopped);
      return getInfo();
    }
    const candidate = await launch(next);
    if (disposed) {
      stopHelper(candidate, intentionallyStopped);
      throw new Error('Push-to-talk hook is disposed.');
    }
    const previous = child;
    child = candidate;
    binding = next;
    registered = true;
    joystickConnected = false;
    stopHelper(previous, intentionallyStopped);
    return getInfo();
  }

  function dispose() {
    disposed = true;
    for (const spawnedChild of spawnedChildren) stopHelper(spawnedChild, intentionallyStopped);
    child = null;
    binding = { accelerator: '', joystick: null };
    registered = false;
    joystickConnected = false;
  }

  return Object.freeze({ dispose, getInfo, setBinding });
}

// Runs the helper in learn mode: it lists every joystick it can read and
// reports each button press until stopped. Nothing is recorded here; the
// caller decides what a press means.
async function startJoystickLearnSession({
  helperPath,
  onButton,
  onDevice,
  onStopped = () => {},
  spawnProcess = spawn,
}) {
  if (!path.isAbsolute(helperPath) || typeof onButton !== 'function' || typeof onDevice !== 'function') {
    throw new TypeError('Valid joystick learn options are required');
  }
  const spawnedChildren = new Set();
  const intentionallyStopped = new WeakSet();
  const child = await launchHelper({
    helperPath,
    args: ['--learn-joystick'],
    spawnProcess,
    spawnedChildren,
    intentionallyStopped,
    onEvent: (event) => {
      const identity = joystickIdentityFromEvent(event);
      if (!identity) return;
      if (event.type === 'device') {
        onDevice({ ...identity, connected: event.connected === true });
      } else if (event.type === 'button') {
        const button = Number(event.button);
        if (!Number.isSafeInteger(button) || button < 1) return;
        onButton({ ...identity, button, down: event.down === true });
      }
    },
    onStopped: (error) => onStopped(error),
  });
  return Object.freeze({
    stop() { stopHelper(child, intentionallyStopped); },
  });
}

module.exports = {
  createPushToTalkHelperSpawnOptions,
  createPushToTalkHook,
  resolvePushToTalkHelperPath,
  startJoystickLearnSession,
};
