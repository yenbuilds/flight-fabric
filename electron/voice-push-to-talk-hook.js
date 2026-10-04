'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  normalizePushToTalkShortcut,
  pushToTalkHelperArguments,
} = require('./voice-push-to-talk');

const { StringDecoder } = require('node:string_decoder');
const { normalizeControllerBinding, sameControllerButton, controllerArguments, controllerSummary, controllerDisplayName } = require('./voice-controller-button');
const MAX_HELPER_LINE_BYTES = 32768;
const HELPER_READY_TIMEOUT_MS = 3000;

// Validate the fields consumed by either binding setup or the live hook. A
// malformed release must stop capture, not be ignored or throw in main.
function validHelperEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const devicePath = value => text(value, 4096) && !/[\x00-\x1f\x7f]/.test(value);
  switch (event.type) {
    case 'ready': case 'down': case 'up': case 'heartbeat': case 'paused': case 'resumed':
      return true;
    case 'device':
      return devicePath(event.path) && typeof event.connected === 'boolean'
        && (event.name === undefined || (typeof event.name === 'string' && event.name.length <= 200
          && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(event.name)))
        && ['vendorId', 'productId'].every(key => event[key] === undefined
          || (typeof event[key] === 'string' && /^[0-9a-f]{4}$/i.test(event[key])));
    case 'press': case 'release':
      return devicePath(event.path) && integer(event.reportId, 0, 255)
        && integer(event.linkCollection, 0, 65535) && integer(event.button, 1, 65535);
    case 'baseline':
      return devicePath(event.path) && integer(event.reportId, 0, 255) && integer(event.heldButtons, 0, 4096);
    case 'cancel': case 'stopped':
      return text(event.reason, 128) && (event.path === undefined || devicePath(event.path));
    case 'device-error':
      return text(event.message, 4096);
    default:
      return false;
  }
}

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


// A ready helper is not yet owned by its caller. Buffer bounded startup events
// until activate(), including devices enumerated before ready, and remember any
// exit between ready and promotion. Never silently drop an input transition.
function launchHelperSession({ helperPath, args, onEvent, onStopped, spawnProcess = spawn, onSpawn = () => {} }) {
  if (!path.isAbsolute(helperPath) || !fs.existsSync(helperPath)) return Promise.reject(new Error('Push-to-talk helper is not built.'));
  return new Promise((resolve, reject) => {
    let child, ready = false, active = false, stopped = false, ended = null, output = '';
    const pending = [];
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => fail(new Error('Push-to-talk helper did not become ready.')), HELPER_READY_TIMEOUT_MS);
    function stop(error = new Error('Push-to-talk helper was stopped.')) {
      if (!ready) reject(error);
      stopped = true;
      clearTimeout(timer);
      pending.length = 0;
      try { child?.kill(); } catch {}
    }
    function fail(error) {
      if (ended || stopped) return;
      ended = error;
      clearTimeout(timer);
      if (!ready) { stop(error); }
      else if (active) { stop(); onStopped(error, session); }
      else stop();
    }
    const session = {
      get child() { return child; }, stop,
      activate() {
        if (ended) throw ended;
        if (stopped) throw new Error('Push-to-talk helper was stopped.');
        active = true;
        for (const event of pending.splice(0)) {
          if (stopped) break;
          onEvent(event, session);
        }
      },
    };
    try {
      child = spawnProcess(helperPath, args, createPushToTalkHelperSpawnOptions());
      onSpawn(session);
    } catch (error) { fail(error); return; }
    child.stdout?.on('data', (chunk) => {
      if (stopped) return;
      if (chunk.length > 1024 * 1024) { fail(new Error('Push-to-talk output exceeded its limit.')); return; }
      output += decoder.write(Buffer.from(chunk));
      while (output.includes('\n') && !stopped) {
        const index = output.indexOf('\n');
        const line = output.slice(0, index).replace(/\r$/, '');
        output = output.slice(index + 1);
        if (!line || Buffer.byteLength(line) > MAX_HELPER_LINE_BYTES) { fail(new Error('Invalid push-to-talk output.')); break; }
        let event;
        try { event = JSON.parse(line); } catch { fail(new Error('Invalid push-to-talk output.')); break; }
        if (!validHelperEvent(event)) { fail(new Error('Invalid push-to-talk event.')); break; }
        if (event.type === 'stopped' && !active) { fail(new Error('Push-to-talk helper stopped before activation.')); break; }
        if (event.type === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(session);
        } else if (active) onEvent(event, session);
        else {
          if (pending.length >= 256) { fail(new Error('Push-to-talk startup output exceeded its limit.')); break; }
          pending.push(event);
        }
      }
      if (Buffer.byteLength(output) > MAX_HELPER_LINE_BYTES) fail(new Error('Push-to-talk output exceeded its limit.'));
    });
    // Losing the event pipe also loses release/cancel delivery, even if the
    // child process has not exited yet. Stream errors must never escape into
    // Electron's main process as unhandled EventEmitter errors.
    child.stdout?.on('error', fail);
    child.stdout?.on('end', () => fail(new Error('Push-to-talk helper output closed.')));
    child.stdout?.on('close', () => fail(new Error('Push-to-talk helper output closed.')));
    child.stderr?.on('data', () => {});
    child.stderr?.on('error', fail);
    child.on('error', fail);
    child.on('exit', code => fail(new Error(`Push-to-talk helper stopped (${code ?? 'unknown'}).`)));
  });
}

function createPushToTalkHook({ helperPath, onDown, onUp, onCancel = () => {}, onError = () => {},
  onStateChange = () => {}, controllerEnabled = false, spawnProcess = spawn, now = () => performance.now() }) {
  if (!path.isAbsolute(helperPath) || typeof onDown !== 'function' || typeof onUp !== 'function') {
    throw new TypeError('Valid push-to-talk helper options are required');
  }
  let current = null, binding = { accelerator: '', controller: null }, registered = false, disposed = false, revision = 0;
  let controllerState = 'unbound', controllerError = '', heartbeat = null;
  let controllerLabel = '';
  let sources = new Set(), blocked = false;
  const sessions = new Set();
  function getInfo() {
    return Object.freeze({ accelerator: binding.accelerator, registered,
      ...(controllerEnabled ? { controller: controllerSummary(binding.controller, controllerState, controllerError, controllerLabel || undefined) } : {}) });
  }
  function transition(source, down) {
    const wasHeld = sources.size > 0;
    if (down) sources.add(source); else sources.delete(source);
    if (blocked) { if (!sources.size) blocked = false; return; }
    if (!wasHeld && sources.size) onDown(binding.accelerator);
    else if (wasHeld && !sources.size) onUp(binding.accelerator);
  }
  function cancel(reason, source = null) {
    if (source) sources.delete(source); else sources.clear();
    blocked = sources.size > 0;
    onCancel(reason);
  }
  function clearHeartbeat() { clearInterval(heartbeat); heartbeat = null; }
  function stopSession(session) { session?.stop(); sessions.delete(session); }
  function failed(error, session) {
    if (session !== current) return;
    stopSession(current); current = null; registered = false;
    clearHeartbeat(); sources.clear(); blocked = false;
    controllerState = binding.controller ? 'error' : 'unbound';
    controllerError = binding.controller ? 'Controller input stopped. Turn voice off and on to retry.' : '';
    onError(error); onStateChange(getInfo());
  }
  function handle(event, session) {
    if (session !== current || disposed) return;
    if (event.type === 'down') transition('keyboard', true);
    else if (event.type === 'up') transition('keyboard', false);
    else if (binding.controller) {
      if (event.type === 'heartbeat') session.lastHeartbeat = now();
      else if (event.type === 'press' || event.type === 'release') {
        if (!sameControllerButton(event, binding.controller)) return;
        controllerState = 'ready';
        transition('controller', event.type === 'press');
        onStateChange(getInfo());
      } else if (event.type === 'device') {
        if (typeof event.path !== 'string' || event.path.toLowerCase() !== binding.controller.devicePath.toLowerCase()) return;
        controllerState = event.connected === true ? 'waiting' : 'disconnected';
        if (event.connected === true) controllerLabel = controllerDisplayName(event.name) || controllerLabel;
        controllerError = '';
        // Normally cancelled before this notification; also fail closed if it was omitted.
        if (!event.connected && sources.has('controller')) cancel('device-removed', 'controller');
        onStateChange(getInfo());
      } else if (event.type === 'baseline') {
        if (event.path?.toLowerCase() !== binding.controller.devicePath.toLowerCase() || event.reportId !== binding.controller.reportId) return;
        controllerState = event.heldButtons ? 'release-required' : 'ready';
        onStateChange(getInfo());
      } else if (event.type === 'cancel') {
        if (event.path && event.path.toLowerCase() !== binding.controller.devicePath.toLowerCase()) return;
        if (event.reason === 'device-removed') controllerState = 'disconnected';
        if (event.reason === 'suspend') session.suspended = true;
        cancel(event.reason || 'controller-cancel', event.path ? 'controller' : null);
        onStateChange(getInfo());
      } else if (event.type === 'paused') {
        registered = false; controllerState = 'paused'; onStateChange(getInfo());
      } else if (event.type === 'resumed') {
        session.suspended = false; session.lastHeartbeat = now();
        if (controllerState === 'paused') controllerState = 'disconnected';
        registered = true; onStateChange(getInfo());
      } else if (event.type === 'device-error') {
        cancel('controller-error', 'controller'); controllerState = 'error';
        controllerError = 'Controller input could not be read. Reconnect it or select the button again.';
        onStateChange(getInfo());
      } else if (event.type === 'stopped') failed(new Error('Controller input stopped.'), session);
    }
  }
  async function setBinding(value) {
    if (disposed) throw new Error('Push-to-talk hook is disposed.');
    const next = { accelerator: value?.accelerator ? normalizePushToTalkShortcut(value.accelerator) : '',
      controller: controllerEnabled ? normalizeControllerBinding(value?.controller) : null };
    const request = ++revision;
    if (registered && current && JSON.stringify(next) === JSON.stringify(binding)) return getInfo();
    if (!next.accelerator && !next.controller) {
      stopSession(current); current = null; clearHeartbeat();
      if (sources.size) cancel('binding-changed');
      binding = next; registered = false; controllerState = 'unbound'; controllerError = ''; controllerLabel = '';
      return getInfo();
    }
    const candidate = await launchHelperSession({ helperPath,
      args: next.controller ? controllerArguments(next.controller, next.accelerator) : pushToTalkHelperArguments(next),
      spawnProcess, onEvent: handle, onStopped: failed,
      onSpawn: session => { sessions.add(session); session.child.once('close', () => sessions.delete(session)); } }).catch(error => {
        if (disposed) throw new Error('Push-to-talk hook is disposed.');
        throw error;
      });
    if (disposed || request !== revision) {
      stopSession(candidate);
      throw new Error(disposed ? 'Push-to-talk hook is disposed.' : 'Push-to-talk change was superseded.');
    }
    const previous = current;
    const previousBinding = binding;
    const previousState = { registered, controllerState, controllerError, controllerLabel };
    if (sources.size) cancel('binding-changed');
    current = candidate; binding = next; registered = true;
    controllerState = next.controller ? 'disconnected' : 'unbound'; controllerError = ''; controllerLabel = '';
    try { candidate.activate(); }
    catch (error) {
      current = previous; binding = previousBinding;
      ({ registered, controllerState, controllerError, controllerLabel } = previousState);
      stopSession(candidate); throw error;
    }
    stopSession(previous); clearHeartbeat();
    if (next.controller && current === candidate) {
      candidate.lastHeartbeat = now();
      heartbeat = setInterval(() => {
        if (!candidate.suspended && now() - candidate.lastHeartbeat > 5000) failed(new Error('Controller input stopped responding.'), candidate);
      }, 1000);
      heartbeat.unref?.();
    }
    return getInfo();
  }
  function dispose() {
    disposed = true; revision++;
    for (const session of sessions) session.stop();
    sessions.clear(); clearHeartbeat();
    current = null; binding = { accelerator: '', controller: null }; registered = false;
    controllerState = 'unbound'; controllerError = ''; controllerLabel = ''; sources.clear(); blocked = false;
  }
  return Object.freeze({ dispose, getInfo, setBinding });
}

module.exports = { createPushToTalkHelperSpawnOptions, createPushToTalkHook, resolvePushToTalkHelperPath, launchHelperSession };
