'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createVoiceSpeechEngine } = require('./voice-speech-engine');
const {
  createPushToTalkHook,
  resolvePushToTalkHelperPath,
  startJoystickLearnSession,
} = require('./voice-push-to-talk-hook');
const {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  normalizePushToTalkJoystick,
  normalizePushToTalkShortcut,
} = require('./voice-push-to-talk');
const { createWindowsLocalTts } = require('./windows-local-tts');

const AUDIO_CHANNEL = 'voice:speech-audio';
const JOYSTICK_LEARN_CHANNEL = 'voice:joystick-learn';
// A binding session that nobody finishes must not leave a helper listening.
const JOYSTICK_LEARN_TIMEOUT_MS = 60_000;
// Release hold: docs/JOYSTICK-PTT-REVIEW-2026-09-20.md. Saved bindings are
// retained, but no joystick may be exposed, bound or detected in this build.
// The native helper independently rejects joystick modes before device I/O.
const JOYSTICK_PUSH_TO_TALK_ENABLED = false;

function requireJoystickPushToTalk() {
  if (!JOYSTICK_PUSH_TO_TALK_ENABLED) {
    throw new Error('Joystick push-to-talk is disabled in this release. Use a keyboard shortcut or the on-screen button.');
  }
}

function createVoiceRuntime({
  app,
  appDir,
  debugLog = () => {},
  getMainWindow,
  ipcMain,
  pushToTalkHookFactory = createPushToTalkHook,
  joystickLearnSessionFactory = startJoystickLearnSession,
  registerTrustedIpcHandler,
  readbackEngine = null,
  resourcesPath = process.resourcesPath,
  speechEngine = null,
}) {
  if (!app || !ipcMain || typeof getMainWindow !== 'function'
      || typeof registerTrustedIpcHandler !== 'function') {
    throw new TypeError('Voice runtime dependencies are invalid');
  }
  const speech = speechEngine || createVoiceSpeechEngine({
    appDir,
    isPackaged: app.isPackaged,
    resourcesPath,
  });
  // A failed readback, and its later recovery, are reported through the same
  // runtime-state channel the renderer already watches, so the voice panel can
  // show why nothing was heard and clear the notice once readbacks work again.
  const readback = readbackEngine || createWindowsLocalTts({
    debugLog,
    onErrorChange: () => send('voice:runtime-state', runtimeInfo()),
  });
  const settingsFile = path.join(app.getPath('userData'), 'voice-control.json');
  let speechError = '';
  let shortcutError = '';
  let shortcut = DEFAULT_PUSH_TO_TALK_SHORTCUT;
  let joystick = null;
  let recognitionEnabled = false;
  let hook = null;
  let joystickLearn = null;
  let captureAuthorization = null;
  let runtimeTransition = Promise.resolve();
  let shuttingDown = false;

  function webContentsId(webContents) {
    const value = Number(webContents?.id);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function revokeCaptureAuthorization(sessionId = null) {
    if (!captureAuthorization) return false;
    if (sessionId && captureAuthorization.sessionId !== sessionId) return false;
    captureAuthorization = null;
    return true;
  }

  function isAudioCaptureAuthorized(webContents) {
    if (!recognitionEnabled) return false;
    if (!captureAuthorization || webContentsId(webContents) !== captureAuthorization.webContentsId) return false;
    return speech.getInfo().activeSessionId === captureAuthorization.sessionId;
  }

  function cancelActiveSession() {
    // A renderer that navigates away or loses its session is no longer
    // waiting for a joystick button either.
    stopJoystickLearn('cancelled');
    const sessionId = captureAuthorization?.sessionId || speech.getInfo().activeSessionId;
    revokeCaptureAuthorization();
    return typeof sessionId === 'string' && sessionId ? speech.cancel(sessionId) : false;
  }

  function send(channel, payload) {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    const contents = window.webContents;
    if (!contents || contents.isDestroyed()) return;
    try {
      contents.send(channel, payload);
    } catch (error) {
      debugLog('Voice renderer send failed:', error?.message || error);
    }
  }

  function loadSettings() {
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      parsed = {};
    }
    recognitionEnabled = parsed?.voiceRecognitionEnabled === true;
    try {
      shortcut = parsed?.pushToTalkShortcut
        ? normalizePushToTalkShortcut(parsed.pushToTalkShortcut)
        : DEFAULT_PUSH_TO_TALK_SHORTCUT;
    } catch {
      shortcut = DEFAULT_PUSH_TO_TALK_SHORTCUT;
    }
    try {
      joystick = normalizePushToTalkJoystick(parsed?.pushToTalkJoystick);
    } catch {
      joystick = null;
    }
  }

  function saveSettings() {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const temporary = `${settingsFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      pushToTalkJoystick: joystick,
      pushToTalkShortcut: shortcut,
      voiceRecognitionEnabled: recognitionEnabled,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, settingsFile);
  }

  function runtimeInfo() {
    return Object.freeze({
      available: recognitionEnabled && speech.getInfo().ready,
      enabled: recognitionEnabled,
      // The renderer may relax its aircraft-readiness UI only in an unpackaged
      // Electron run. Packaged builds always keep the normal aircraft gates.
      development: app.isPackaged !== true,
      engine: speech.getInfo(),
      error: recognitionEnabled ? speechError : '',
      modelBundled: speech.getInfo().state !== 'failed' || !/model file/i.test(speechError),
      pushToTalk: Object.freeze({
        accelerator: hook?.getInfo().accelerator || shortcut,
        error: recognitionEnabled ? shortcutError : '',
        joystickAvailable: JOYSTICK_PUSH_TO_TALK_ENABLED,
        joystick: activeJoystickBinding(),
        joystickConnected: JOYSTICK_PUSH_TO_TALK_ENABLED && recognitionEnabled && hook?.getInfo().joystickConnected === true,
        registered: recognitionEnabled && hook?.getInfo().registered === true,
      }),
      readback: readback.getInfo(),
    });
  }

  function helperPath() {
    return resolvePushToTalkHelperPath({
      appDir,
      isPackaged: app.isPackaged,
      resourcesPath,
    });
  }

  function activeJoystickBinding() {
    return JOYSTICK_PUSH_TO_TALK_ENABLED ? joystick : null;
  }

  function createHook() {
    return pushToTalkHookFactory({
      helperPath: helperPath(),
      onDown: (accelerator) => send('voice:push-to-talk', { type: 'down', accelerator }),
      onUp: (accelerator) => send('voice:push-to-talk', { type: 'up', accelerator }),
      // The bound stick came or went: the panel shows which.
      onDevice: () => send('voice:runtime-state', runtimeInfo()),
      onError: (error) => {
        cancelActiveSession();
        shortcutError = error?.message || 'Push-to-talk helper stopped.';
        send('voice:push-to-talk', { type: 'error', error: shortcutError });
      },
    });
  }

  async function startRecognitionRuntime() {
    if (!recognitionEnabled || shuttingDown) return;
    speechError = '';
    shortcutError = '';
    try {
      await speech.initialize();
    } catch (error) {
      speechError = error?.message || 'Voice recognition is unavailable.';
      debugLog('Voice recognition unavailable:', speechError);
      return;
    }
    if (!recognitionEnabled || shuttingDown) {
      await speech.shutdown();
      return;
    }
    if (!hook) {
      try {
        hook = createHook();
      } catch (error) {
        shortcutError = error?.message || 'Push-to-talk is unavailable.';
        debugLog('Push-to-talk unavailable:', shortcutError);
        return;
      }
    }
    if (!shortcut && !activeJoystickBinding()) return;
    try {
      await hook.setBinding({ accelerator: shortcut, joystick: activeJoystickBinding() });
    } catch (error) {
      shortcutError = error?.message || 'Push-to-talk is unavailable.';
      debugLog('Push-to-talk unavailable:', shortcutError);
    }
  }

  async function stopRecognitionRuntime() {
    cancelActiveSession();
    stopJoystickLearn('disabled');
    hook?.dispose();
    hook = null;
    shortcutError = '';
    await speech.shutdown();
  }

  function queueRuntimeTransition(operation) {
    const next = runtimeTransition.then(operation, operation);
    runtimeTransition = next.catch(() => {});
    return next;
  }

  function setRecognitionEnabled(value) {
    if (typeof value !== 'boolean') throw new TypeError('Voice recognition enabled state must be boolean');
    if (shuttingDown) throw new Error('Voice recognition is shutting down');
    recognitionEnabled = value;
    if (!recognitionEnabled) {
      cancelActiveSession();
      stopJoystickLearn('disabled');
      hook?.dispose();
      hook = null;
    }
    saveSettings();
    return queueRuntimeTransition(async () => {
      if (recognitionEnabled) await startRecognitionRuntime();
      else await stopRecognitionRuntime();
      const info = runtimeInfo();
      send('voice:runtime-state', info);
      return info;
    });
  }

  function stopJoystickLearn(reason = 'stopped') {
    const session = joystickLearn;
    if (!session) return false;
    joystickLearn = null;
    clearTimeout(session.timer);
    session.stop?.();
    send(JOYSTICK_LEARN_CHANNEL, { type: 'stopped', reason });
    return true;
  }

  // Lists the sticks Windows can read and relays each button press to the
  // renderer, which shows them and lets the user confirm one. Only one
  // session runs at a time and it ends by itself after a minute.
  async function startJoystickLearn() {
    requireJoystickPushToTalk();
    if (!recognitionEnabled) throw new Error('Voice recognition is disabled');
    if (shuttingDown) throw new Error('Voice recognition is shutting down');
    stopJoystickLearn('restarted');
    const session = { stop: null, timer: null };
    joystickLearn = session;
    const relay = (payload) => {
      if (joystickLearn === session) send(JOYSTICK_LEARN_CHANNEL, payload);
    };
    let started;
    try {
      started = await joystickLearnSessionFactory({
        helperPath: helperPath(),
        onDevice: (device) => relay({ type: 'device', ...device }),
        onButton: (press) => relay({ type: 'button', ...press }),
        onStopped: (error) => {
          if (joystickLearn !== session) return;
          joystickLearn = null;
          clearTimeout(session.timer);
          send(JOYSTICK_LEARN_CHANNEL, {
            type: 'stopped', reason: 'error', error: error?.message || 'Joystick detection stopped.',
          });
        },
      });
    } catch (error) {
      if (joystickLearn === session) joystickLearn = null;
      throw error;
    }
    if (joystickLearn !== session) {
      started.stop();
      return { started: false };
    }
    session.stop = () => started.stop();
    session.timer = setTimeout(() => stopJoystickLearn('timeout'), JOYSTICK_LEARN_TIMEOUT_MS);
    session.timer.unref?.();
    return { started: true };
  }

  speech.onEvent((event) => {
    const fatalError = event?.type === 'error' && event.fatal === true;
    if (fatalError) speechError = event.message || 'Local voice recognition stopped.';
    if (event?.sessionId && ['final', 'cancelled', 'error'].includes(event.type)) {
      revokeCaptureAuthorization(event.sessionId);
    } else if (event?.type === 'error' && event.fatal === true) {
      revokeCaptureAuthorization();
    }
    send('voice:speech-event', event);
    // Worker crashes can be global events without a session ID. Publish the
    // failed engine state as well so the UI cannot keep offering a dead engine.
    if (fatalError) send('voice:runtime-state', runtimeInfo());
  });

  function installIpc() {
    registerTrustedIpcHandler('voice:get-runtime-info', () => runtimeInfo());
    registerTrustedIpcHandler('voice:set-recognition-enabled', (_event, value) => (
      setRecognitionEnabled(value)
    ));
    registerTrustedIpcHandler('voice:get-readback-info', () => readback.getInfo());
    registerTrustedIpcHandler('voice:readback-speak', (_event, text) => ({
      started: readback.speak(text),
    }));
    registerTrustedIpcHandler('voice:readback-cancel', () => ({
      cancelled: readback.cancel(),
    }));
    registerTrustedIpcHandler('voice:speech-start', (event) => {
      if (!recognitionEnabled) throw new Error('Voice recognition is disabled');
      const recognition = speech.start();
      const senderId = webContentsId(event?.sender);
      if (senderId === null) {
        speech.cancel(recognition.sessionId);
        throw new Error('Voice capture sender is unavailable');
      }
      captureAuthorization = Object.freeze({
        sessionId: recognition.sessionId,
        webContentsId: senderId,
      });
      return recognition;
    });
    registerTrustedIpcHandler('voice:speech-finish', (_event, sessionId) => {
      const finishing = speech.finish(sessionId);
      if (finishing) revokeCaptureAuthorization(sessionId);
      return { finishing };
    });
    registerTrustedIpcHandler('voice:speech-cancel', (_event, sessionId) => {
      const cancelled = speech.cancel(sessionId);
      if (cancelled) revokeCaptureAuthorization(sessionId);
      return { cancelled };
    });
    registerTrustedIpcHandler('voice:set-push-to-talk-shortcut', async (_event, value) => {
      if (!hook) throw new Error('Push-to-talk is unavailable');
      const next = normalizePushToTalkShortcut(value);
      const info = await hook.setBinding({ accelerator: next, joystick: activeJoystickBinding() });
      shortcut = info.accelerator;
      saveSettings();
      shortcutError = '';
      return runtimeInfo().pushToTalk;
    });
    registerTrustedIpcHandler('voice:set-push-to-talk-joystick', async (_event, value) => {
      requireJoystickPushToTalk();
      if (!hook) throw new Error('Push-to-talk is unavailable');
      const next = normalizePushToTalkJoystick(value);
      const info = await hook.setBinding({ accelerator: shortcut, joystick: next });
      joystick = info.joystick;
      saveSettings();
      shortcutError = '';
      return runtimeInfo().pushToTalk;
    });
    registerTrustedIpcHandler('voice:joystick-learn-start', () => startJoystickLearn());
    registerTrustedIpcHandler('voice:joystick-learn-stop', () => ({
      stopped: stopJoystickLearn('stopped'),
    }));

    registerTrustedIpcHandler(AUDIO_CHANNEL, (event, payload) => {
      if (!isAudioCaptureAuthorized(event.sender)) return;
      try {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid audio payload');
        const keys = Object.keys(payload).sort().join(',');
        if (keys !== 'sampleRate,samples,sequence,sessionId') throw new Error('Invalid audio payload shape');
        if (!(payload.samples instanceof ArrayBuffer)
            || payload.samples.byteLength === 0
            || payload.samples.byteLength > 8192 * Float32Array.BYTES_PER_ELEMENT
            || payload.samples.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
          throw new Error('Invalid audio buffer');
        }
        speech.pushAudio({ ...payload, samples: new Float32Array(payload.samples) });
      } catch (error) {
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
        cancelActiveSession();
        send('voice:speech-event', {
          type: 'error', sessionId, code: 'INVALID_AUDIO', fatal: false,
          message: error?.message || 'Microphone audio was rejected.',
        });
      }
    }, { listener: true });
  }

  async function initialize() {
    if (recognitionEnabled) await queueRuntimeTransition(startRecognitionRuntime);
    send('voice:runtime-state', runtimeInfo());
    return runtimeInfo();
  }

  async function shutdown() {
    shuttingDown = true;
    recognitionEnabled = false;
    cancelActiveSession();
    stopJoystickLearn('shutdown');
    readback.cancel();
    hook?.dispose();
    hook = null;
    ipcMain.removeAllListeners(AUDIO_CHANNEL);
    await runtimeTransition;
    await speech.shutdown();
  }

  loadSettings();
  installIpc();
  return Object.freeze({
    cancelActiveSession,
    initialize,
    isAudioCaptureAuthorized,
    runtimeInfo,
    shutdown,
  });
}

module.exports = { AUDIO_CHANNEL, JOYSTICK_LEARN_CHANNEL, createVoiceRuntime };
