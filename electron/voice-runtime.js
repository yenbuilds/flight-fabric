'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createVoiceSpeechEngine } = require('./voice-speech-engine');
const {
  createPushToTalkHook,
  resolvePushToTalkHelperPath,
} = require('./voice-push-to-talk-hook');
const {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  normalizePushToTalkShortcut,
} = require('./voice-push-to-talk');
const { createWindowsLocalTts } = require('./windows-local-tts');

const { normalizeControllerBinding, controllerSummary } = require('./voice-controller-button');
const { createControllerSetup } = require('./voice-controller-setup');

const AUDIO_CHANNEL = 'voice:speech-audio';

function createVoiceRuntime({
  app,
  appDir,
  debugLog = () => {},
  getMainWindow,
  ipcMain,
  pushToTalkHookFactory = createPushToTalkHook,
  registerTrustedIpcHandler,
  readbackEngine = null,
  resourcesPath = process.resourcesPath,
  speechEngine = null,
  controllerSetupFactory = createControllerSetup,
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
  const controllerEnabled = process.platform === 'win32';
  let controllerBinding = null;
  let controllerSetup = null;
  let controllerSetupActive = false;
  let controllerSetupOwner = null;
  let controllerSetupRevision = 0;
  let speechError = '';
  let shortcutError = '';
  let shortcut = DEFAULT_PUSH_TO_TALK_SHORTCUT;
  let storedSettings = {};
  let recognitionEnabled = false;
  let hook = null;
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
    if (!recognitionEnabled || controllerSetupActive) return false;
    if (!captureAuthorization || webContentsId(webContents) !== captureAuthorization.webContentsId) return false;
    return speech.getInfo().activeSessionId === captureAuthorization.sessionId;
  }

  function cancelActiveSession() {
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
    // Retain unknown preferences as inert data across saves, including retired settings.
    storedSettings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    recognitionEnabled = parsed?.voiceRecognitionEnabled === true;
    if (controllerEnabled) {
      try { controllerBinding = normalizeControllerBinding(parsed?.controllerBindingV1); } catch { controllerBinding = null; }
    }
    try {
      shortcut = parsed?.pushToTalkShortcut
        ? normalizePushToTalkShortcut(parsed.pushToTalkShortcut)
        : DEFAULT_PUSH_TO_TALK_SHORTCUT;
    } catch {
      shortcut = DEFAULT_PUSH_TO_TALK_SHORTCUT;
    }
  }

  function saveSettings({ enabled = recognitionEnabled, accelerator = shortcut, controller = controllerBinding } = {}) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const temporary = `${settingsFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      ...storedSettings,
      ...(controllerEnabled ? { controllerBindingV1: controller } : {}),
      pushToTalkShortcut: accelerator,
      voiceRecognitionEnabled: enabled,
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
      controllerSetup: controllerEnabled ? { active: controllerSetupActive, ...controllerSetup?.getInfo() } : undefined,
      engine: speech.getInfo(),
      error: recognitionEnabled ? speechError : '',
      modelBundled: speech.getInfo().state !== 'failed' || !/model file/i.test(speechError),
      pushToTalk: Object.freeze({
        ...(controllerEnabled ? { controllerEnabled: true, controller: hook?.getInfo().controller || controllerSummary(controllerBinding, controllerBinding ? 'inactive' : 'unbound') } : {}),
        accelerator: hook?.getInfo().accelerator || shortcut,
        error: recognitionEnabled ? shortcutError : '',
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

  function createHook() {
    return pushToTalkHookFactory({
      helperPath: helperPath(),
      controllerEnabled,
      onStateChange: () => send('voice:runtime-state', runtimeInfo()),
      onCancel: (reason) => {
        cancelActiveSession();
        send('voice:push-to-talk', { type: 'cancel', reason });
      },
      onDown: (accelerator) => send('voice:push-to-talk', { type: 'down', accelerator }),
      onUp: (accelerator) => send('voice:push-to-talk', { type: 'up', accelerator }),
      onError: (error) => {
        cancelActiveSession();
        shortcutError = error?.message || 'Push-to-talk helper stopped.';
        send('voice:push-to-talk', { type: 'error', error: shortcutError });
      },
    });
  }

  async function startRecognitionRuntime() {
    if (!recognitionEnabled || shuttingDown || controllerSetupActive) return;
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
    if (!shortcut && !controllerBinding) return;
    try {
      await hook.setBinding({ accelerator: shortcut, ...(controllerEnabled ? { controller: controllerBinding } : {}) });
    } catch (error) {
      shortcutError = error?.message || 'Push-to-talk is unavailable.';
      debugLog('Push-to-talk unavailable:', shortcutError);
    }
  }

  async function stopRecognitionRuntime() {
    cancelActiveSession();
    endControllerSetup();
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
    let persistenceError = null;
    if (!value) {
      recognitionEnabled = false;
      endControllerSetup();
      cancelActiveSession();
      send('voice:push-to-talk', { type: 'cancel', reason: 'voice-disabled' });
      hook?.dispose();
      hook = null;
    }
    try { saveSettings({ enabled: value }); }
    catch (error) {
      // Enabling needs a saved preference. Disabling must still close the
      // microphone and engine even when the preference cannot be persisted.
      if (value) throw error;
      persistenceError = new Error('Voice control is off for this session, but the setting could not be saved. It may be enabled again after restarting FlightFabric.', { cause: error });
    }
    recognitionEnabled = value;
    return queueRuntimeTransition(async () => {
      if (recognitionEnabled) await startRecognitionRuntime();
      else await stopRecognitionRuntime();
      const info = runtimeInfo();
      send('voice:runtime-state', info);
      if (persistenceError) throw persistenceError;
      return info;
    });
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

  function endControllerSetup(invalidate = true) {
    if (invalidate) controllerSetupRevision++;
    controllerSetupActive = false;
    if (controllerSetupOwner) {
      controllerSetupOwner.removeListener?.('destroyed', abandonControllerSetup);
      controllerSetupOwner.removeListener?.('did-start-navigation', abandonControllerSetup);
      controllerSetupOwner = null;
    }
    controllerSetup?.stop();
  }

  function abandonControllerSetup() {
    if (!controllerSetupActive) return;
    endControllerSetup();
    void queueRuntimeTransition(async () => {
      if (!shuttingDown && recognitionEnabled) await startRecognitionRuntime();
      send('voice:runtime-state', runtimeInfo());
    });
  }

  function requireControllerIntegration() {
    if (!controllerEnabled) throw new Error('Controller push-to-talk is not enabled in this build.');
    if (shuttingDown) throw new Error('Voice recognition is shutting down');
  }

  async function savePushToTalkBinding({ accelerator = shortcut, controller = controllerBinding }) {
    const previousShortcut = shortcut;
    const previousController = controllerBinding;
    cancelActiveSession();
    send('voice:push-to-talk', { type: 'cancel', reason: 'binding-changed' });
    endControllerSetup();
    try {
      if (recognitionEnabled) {
        if (!hook) hook = createHook();
        await hook.setBinding({ accelerator, ...(controllerEnabled ? { controller } : {}) });
      }
      // Other settings actions can run while the helper starts. Until both
      // registration and persistence succeed, they must save the old binding.
      saveSettings({ accelerator, controller });
      shortcut = accelerator;
      controllerBinding = controller;
    } catch (error) {
      if (recognitionEnabled && hook) {
        const rollbackHook = hook;
        try { await rollbackHook.setBinding({ accelerator: previousShortcut, ...(controllerEnabled ? { controller: previousController } : {}) }); }
        catch {
          rollbackHook.dispose();
          if (hook === rollbackHook) {
            hook = null;
            shortcutError = 'Push-to-talk could not restart. Turn voice off and on to retry.';
          }
        }
      }
      send('voice:runtime-state', runtimeInfo());
      throw error;
    }
    shortcutError = '';
    send('voice:runtime-state', runtimeInfo());
    return runtimeInfo();
  }

  function installIpc() {
    registerTrustedIpcHandler('voice:get-runtime-info', () => runtimeInfo());
    registerTrustedIpcHandler('voice:controller-setup-start', (event) => {
      requireControllerIntegration();
      if (!recognitionEnabled) throw new Error('Enable voice control before choosing a button.');
      const request = ++controllerSetupRevision;
      const owner = event?.sender;
      const invalidatePendingSetup = () => { if (request === controllerSetupRevision) controllerSetupRevision++; };
      const releasePendingOwner = () => {
        owner?.removeListener?.('destroyed', invalidatePendingSetup);
        owner?.removeListener?.('did-start-navigation', invalidatePendingSetup);
      };
      // The renderer may leave before this operation reaches the runtime queue.
      // Track that interval as well as the active native setup session.
      owner?.once?.('destroyed', invalidatePendingSetup);
      owner?.once?.('did-start-navigation', invalidatePendingSetup);
      return queueRuntimeTransition(async () => {
        releasePendingOwner();
        if (!recognitionEnabled || shuttingDown) throw new Error('Voice recognition is disabled');
        if (request !== controllerSetupRevision || owner?.isDestroyed?.()) return runtimeInfo();
        endControllerSetup(false);
        controllerSetupActive = true;
        cancelActiveSession();
        send('voice:push-to-talk', { type: 'cancel', reason: 'button-setup' });
        hook?.dispose(); hook = null;
        controllerSetupOwner = event?.sender || null;
        controllerSetupOwner?.once?.('destroyed', abandonControllerSetup);
        controllerSetupOwner?.once?.('did-start-navigation', abandonControllerSetup);
        if (!controllerSetup) controllerSetup = controllerSetupFactory({ helperPath: helperPath(),
          onChange: () => send('voice:runtime-state', runtimeInfo()) });
        send('voice:runtime-state', runtimeInfo());
        await controllerSetup.start();
        return runtimeInfo();
      }).finally(releasePendingOwner);
    });
    registerTrustedIpcHandler('voice:controller-setup-cancel', () => {
      requireControllerIntegration();
      endControllerSetup();
      return queueRuntimeTransition(async () => {
        if (recognitionEnabled) await startRecognitionRuntime();
        send('voice:runtime-state', runtimeInfo());
        return runtimeInfo();
      });
    });
    registerTrustedIpcHandler('voice:controller-setup-save', () => {
      requireControllerIntegration();
      return queueRuntimeTransition(() => {
        if (!controllerSetupActive) throw new Error('Choose a controller button first.');
        return savePushToTalkBinding({ controller: controllerSetup.bindingToSave() });
      });
    });
    registerTrustedIpcHandler('voice:controller-binding-clear', () => {
      requireControllerIntegration();
      return queueRuntimeTransition(() => savePushToTalkBinding({ controller: null }));
    });
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
      if (controllerSetupActive) throw new Error('Voice input is paused during button setup.');
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
    registerTrustedIpcHandler('voice:set-push-to-talk-shortcut', (_event, value) => queueRuntimeTransition(async () => {
      if (controllerSetupActive) throw new Error('Finish controller button setup first.');
      if (!hook) throw new Error('Push-to-talk is unavailable');
      const info = await savePushToTalkBinding({ accelerator: normalizePushToTalkShortcut(value) });
      return info.pushToTalk;
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
    endControllerSetup();
    cancelActiveSession();
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

module.exports = { AUDIO_CHANNEL, createVoiceRuntime };
