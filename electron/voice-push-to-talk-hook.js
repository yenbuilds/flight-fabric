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
const FAILURE_MESSAGES = Object.freeze({
  'startup-failure': 'Push-to-talk helper could not start.',
  'startup-timeout': 'Push-to-talk helper did not become ready.',
  'runtime-failure': 'Push-to-talk helper stopped while reading input.',
  'output-queue-full': 'Push-to-talk helper stopped because input delivery could not keep up.',
  'output-pipe-failure': 'Push-to-talk helper output closed.',
  'protocol-error': 'Invalid push-to-talk output.',
  'watchdog-timeout': 'Controller input stopped responding.',
  'helper-exited': 'Push-to-talk helper stopped.',
});
const EXIT_FAILURES = Object.freeze({ 10: 'startup-failure', 11: 'runtime-failure',
  12: 'output-queue-full', 13: 'output-pipe-failure' });
const PROGRESS_EVENTS = new Set(['press', 'release', 'baseline', 'device', 'heartbeat', 'paused', 'resumed']);

// Only fixed categories and messages leave this owner. Native diagnostics and
// operating-system errors can contain paths; they are never recovery status.
function helperFailure(reason) {
  const failureReason = Object.hasOwn(FAILURE_MESSAGES, reason) ? reason : 'helper-exited';
  return Object.assign(new Error(FAILURE_MESSAGES[failureReason]), { reason: failureReason });
}

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
    case 'cancel':
      return text(event.reason, 128) && (event.source === undefined
        ? event.path === undefined || devicePath(event.path)
        : event.source === 'keyboard' && event.path === undefined
          && ['device-removed', 'input-reset'].includes(event.reason));
    case 'stopped':
      return text(event.reason, 128) && (event.path === undefined || devicePath(event.path));
    case 'device-error':
      return text(event.message, 4096) && (event.scope === undefined
        ? event.path === undefined || devicePath(event.path)
        : event.scope === 'discovery' ? event.path === undefined
          : event.scope === 'device' && devicePath(event.path));
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
  if (!path.isAbsolute(helperPath) || !fs.existsSync(helperPath)) return Promise.reject(helperFailure('startup-failure'));
  return new Promise((resolve, reject) => {
    let child, ready = false, active = false, stopped = false, ended = null, output = '';
    const pending = [];
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => fail(helperFailure('startup-timeout')), HELPER_READY_TIMEOUT_MS);
    function stop(error = new Error('Push-to-talk helper was stopped.')) {
      if (stopped) return;
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
    } catch { fail(helperFailure('startup-failure')); return; }
    child.stdout?.on('data', (chunk) => {
      if (stopped) return;
      if (chunk.length > 1024 * 1024) { fail(helperFailure('protocol-error')); return; }
      output += decoder.write(Buffer.from(chunk));
      while (output.includes('\n') && !stopped) {
        const index = output.indexOf('\n');
        const line = output.slice(0, index).replace(/\r$/, '');
        output = output.slice(index + 1);
        if (!line || Buffer.byteLength(line) > MAX_HELPER_LINE_BYTES) { fail(helperFailure('protocol-error')); break; }
        let event;
        try { event = JSON.parse(line); } catch { fail(helperFailure('protocol-error')); break; }
        if (!validHelperEvent(event)) { fail(helperFailure('protocol-error')); break; }
        if (event.type === 'stopped' && (!active || event.reason !== 'timeout')) {
          fail(helperFailure(event.reason)); break;
        }
        if (event.type === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(session);
        } else if (active) onEvent(event, session);
        else {
          if (pending.length >= 256) { fail(helperFailure('protocol-error')); break; }
          pending.push(event);
        }
      }
      if (Buffer.byteLength(output) > MAX_HELPER_LINE_BYTES) fail(helperFailure('protocol-error'));
    });
    // Losing the event pipe also loses release/cancel delivery, even if the
    // child process has not exited yet. Stream errors must never escape into
    // Electron's main process as unhandled EventEmitter errors.
    child.stdout?.on('error', () => fail(helperFailure('output-pipe-failure')));
    child.stdout?.on('end', () => fail(helperFailure('output-pipe-failure')));
    child.stdout?.on('close', () => fail(helperFailure('output-pipe-failure')));
    child.stderr?.on('data', () => {});
    child.stderr?.on('error', () => fail(helperFailure('output-pipe-failure')));
    child.on('error', () => fail(helperFailure(ready ? 'runtime-failure' : 'startup-failure')));
    child.on('exit', code => fail(helperFailure(EXIT_FAILURES[code] || 'helper-exited')));
  });
}

function createPushToTalkHook({ helperPath, onDown, onUp, onCancel = () => {}, onError = () => {},
  onStateChange = () => {}, controllerEnabled = false, spawnProcess = spawn, now = () => performance.now() }) {
  if (!path.isAbsolute(helperPath) || typeof onDown !== 'function' || typeof onUp !== 'function') {
    throw new TypeError('Valid push-to-talk helper options are required');
  }
  let current = null, binding = { accelerator: '', controller: null }, registered = false, disposed = false, revision = 0;
  let controllerState = 'unbound', controllerError = '', heartbeat = null;
  let helperState = 'idle', failureReason = '';
  let controllerLabel = '';
  // Observed hardware holds outlive a cancelled voice attempt. Only fresh downs
  // join the next attempt; a retired hold cannot block or release another input.
  const heldSources = new Set(), participatingSources = new Set();
  let inputAttempt = null, nextInputAttempt = 0;
  const sessions = new Set();
  function getInfo() {
    return Object.freeze({ accelerator: binding.accelerator, registered, helperState, failureReason,
      retryable: helperState === 'failed' && Boolean(binding.accelerator || binding.controller),
      ...(controllerEnabled ? { controller: controllerSummary(binding.controller, controllerState, controllerError, controllerLabel || undefined) } : {}) });
  }
  function transition(source, down) {
    if (down) {
      if (heldSources.has(source)) return;
      heldSources.add(source);
      participatingSources.add(source);
      if (inputAttempt === null) {
        inputAttempt = ++nextInputAttempt;
        onDown(binding.accelerator, inputAttempt);
      }
    } else {
      heldSources.delete(source);
      if (!participatingSources.delete(source) || participatingSources.size) return;
      const completed = inputAttempt;
      inputAttempt = null;
      onUp(binding.accelerator, completed);
    }
  }
  function retireAttempt(attempt) {
    if (inputAttempt === null || attempt !== inputAttempt) return false;
    participatingSources.clear(); inputAttempt = null;
    return true;
  }
  function cancel(reason, source = null) {
    const affected = !source || participatingSources.has(source);
    const cancelled = affected ? inputAttempt : null;
    if (affected) retireAttempt(cancelled);
    // Device removal and native suspend/rebind own their own fresh-input
    // arming. Other observed holds remain disarmed until their actual release.
    if (source) heldSources.delete(source); else heldSources.clear();
    if (affected) onCancel(reason, cancelled, source);
  }
  function clearHeartbeat() { clearInterval(heartbeat); heartbeat = null; }
  function stopSession(session) { session?.stop(); sessions.delete(session); }
  function recordFailure(error) {
    helperState = 'failed'; failureReason = helperFailure(error?.reason).reason;
    controllerState = binding.controller ? 'error' : 'unbound';
    controllerError = binding.controller ? 'Controller input stopped. Retry push-to-talk to reconnect.' : '';
  }
  function failed(error, session) {
    if (session !== current) return;
    stopSession(current); current = null; registered = false;
    clearHeartbeat(); heldSources.clear(); participatingSources.clear(); inputAttempt = null;
    recordFailure(error);
    onError(error); onStateChange(getInfo());
  }
  function handle(event, session) {
    if (session !== current || disposed) return;
    // Only validated events from the controller loop prove its progress. The
    // separate keyboard thread must not conceal a stalled Raw Input loop.
    if (PROGRESS_EVENTS.has(event.type)) session.lastProgress = now();
    if (event.type === 'stopped') { failed(helperFailure(event.reason), session); return; }
    if (event.type === 'down') transition('keyboard', true);
    else if (event.type === 'up') transition('keyboard', false);
    else if (event.type === 'cancel') {
      if (event.source === 'keyboard') {
        // Raw keyboard loss/reset retires only a participating keyboard hold.
        // Controller-only capture and the controller watchdog remain untouched.
        cancel(event.reason, 'keyboard');
        return;
      }
      if (event.path && event.path.toLowerCase() !== binding.controller?.devicePath.toLowerCase()) return;
      if (binding.controller && event.reason === 'device-removed') controllerState = 'disconnected';
      if (event.reason === 'suspend') session.suspended = true;
      cancel(event.reason, event.path ? 'controller' : null);
      onStateChange(getInfo());
    } else if (event.type === 'paused') {
      session.suspended = true; registered = false; helperState = 'paused';
      if (binding.controller) controllerState = 'paused';
      onStateChange(getInfo());
    } else if (event.type === 'resumed') {
      session.suspended = false;
      if (controllerState === 'paused') controllerState = 'disconnected';
      registered = true; helperState = 'ready'; onStateChange(getInfo());
    } else if (binding.controller) {
      if (event.type === 'press' || event.type === 'release') {
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
        if (!event.connected && heldSources.has('controller')) cancel('device-removed', 'controller');
        onStateChange(getInfo());
      } else if (event.type === 'baseline') {
        if (event.path?.toLowerCase() !== binding.controller.devicePath.toLowerCase() || event.reportId !== binding.controller.reportId) return;
        controllerState = event.heldButtons ? 'release-required' : 'ready';
        onStateChange(getInfo());
      } else if (event.type === 'device-error') {
        // Discovery has no established owner. It cannot invalidate an existing
        // selected capture, nor establish readiness during connection.
        if (event.scope === 'discovery') return;
        if (event.scope === 'device' && event.path.toLowerCase() !== binding.controller.devicePath.toLowerCase()) return;
        cancel('controller-error', 'controller'); controllerState = 'error';
        controllerError = 'Controller input could not be read. Reconnect it or select the button again.';
        onStateChange(getInfo());
      }
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
      if (heldSources.size) cancel('binding-changed');
      binding = next; registered = false; controllerState = 'unbound'; controllerError = ''; controllerLabel = '';
      helperState = 'idle'; failureReason = '';
      return getInfo();
    }
    const candidate = await launchHelperSession({ helperPath,
      args: next.controller ? controllerArguments(next.controller, next.accelerator) : pushToTalkHelperArguments(next),
      spawnProcess, onEvent: handle, onStopped: failed,
      onSpawn: session => { sessions.add(session); session.child.once('close', () => sessions.delete(session)); } }).catch(error => {
        if (disposed) throw new Error('Push-to-talk hook is disposed.');
        if (request === revision && !current) { binding = next; recordFailure(error); }
        throw error;
      });
    if (disposed || request !== revision) {
      stopSession(candidate);
      throw new Error(disposed ? 'Push-to-talk hook is disposed.' : 'Push-to-talk change was superseded.');
    }
    const previous = current;
    const previousBinding = binding;
    const previousState = { registered, controllerState, controllerError, controllerLabel, helperState, failureReason };
    if (heldSources.size) cancel('binding-changed');
    current = candidate; binding = next; registered = true;
    helperState = 'ready'; failureReason = '';
    controllerState = next.controller ? 'disconnected' : 'unbound'; controllerError = ''; controllerLabel = '';
    try { candidate.activate(); }
    catch (error) {
      current = previous; binding = previousBinding;
      ({ registered, controllerState, controllerError, controllerLabel, helperState, failureReason } = previousState);
      if (!previous) { binding = next; recordFailure(error); }
      stopSession(candidate); throw error;
    }
    stopSession(previous); clearHeartbeat();
    if (next.controller && current === candidate) {
      candidate.lastProgress = now();
      heartbeat = setInterval(() => {
        if (!candidate.suspended && now() - candidate.lastProgress > 5000) failed(helperFailure('watchdog-timeout'), candidate);
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
    helperState = 'idle'; failureReason = '';
    controllerState = 'unbound'; controllerError = ''; controllerLabel = '';
    heldSources.clear(); participatingSources.clear(); inputAttempt = null;
  }
  return Object.freeze({ dispose, getInfo, setBinding, retireAttempt });
}

module.exports = { createPushToTalkHelperSpawnOptions, createPushToTalkHook, resolvePushToTalkHelperPath, launchHelperSession };
