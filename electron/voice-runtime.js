'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createVoiceSpeechEngine } = require('./voice-speech-engine');
const { createVoiceCloudEngine } = require('./voice-cloud-engine');
const { createVoiceCloudCredentials } = require('./voice-cloud-credentials');
const { getProvider, listProviders, resolveSelection } = require('./voice-cloud-provider');
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
const PTT_ATTEMPT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Source-only release gate. Keep the preview implementation and saved keys for
// later qualification; neither preferences nor renderer IPC can enable it.
const CLOUD_VOICE_ENABLED = false;

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
  cloudEngine = null,
  credentialStore = null,
  cloudVoiceEnabled = CLOUD_VOICE_ENABLED,
  controllerSetupFactory = createControllerSetup,
}) {
  if (!app || !ipcMain || typeof getMainWindow !== 'function'
      || typeof registerTrustedIpcHandler !== 'function') {
    throw new TypeError('Voice runtime dependencies are invalid');
  }
  const offlineSpeech = speechEngine || createVoiceSpeechEngine({
    appDir,
    isPackaged: app.isPackaged,
    resourcesPath,
  });
  const credentials = cloudVoiceEnabled
    ? credentialStore || createVoiceCloudCredentials({ directory: app.getPath('userData') }) : null;
  let cloudSelection = resolveSelection();
  let cloudRevision = 0;
  let cloudSelectionError = '';
  const cloudSpeech = cloudVoiceEnabled ? cloudEngine || createVoiceCloudEngine({
    loadContract: () => require(app.isPackaged
      ? path.join(resourcesPath, 'voice', 'voice-intent.js') : '../shared/voice-intent'),
    getApiKey: providerId => credentials.read(providerId),
    getSelection: () => ({ ...cloudSelection, revision: cloudRevision }),
  }) : null;
  let speech = offlineSpeech;
  let mode = 'offline';
  let preferredMode = 'offline';
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
  let pushToTalkRetry = null;
  let inputAttempt = null;
  let recognitionInputOwner = null;
  let shortcutRecording = null;
  let shortcutRecordingRevision = 0;
  let shortcutRestore = null;

  function requirePttAttemptId(value) {
    if (typeof value !== 'string' || !PTT_ATTEMPT_ID_RE.test(value)) throw new TypeError('Invalid push-to-talk attempt identifier');
    return value;
  }

  function findInputAttempt(pttAttemptId) {
    return inputAttempt?.pttAttemptId === pttAttemptId ? inputAttempt
      : recognitionInputOwner?.attempt.pttAttemptId === pttAttemptId ? recognitionInputOwner.attempt : null;
  }

  function retireInputAttempt(attempt, cancelRecognition = false) {
    if (!attempt) return false;
    const recognized = recognitionInputOwner?.attempt === attempt ? recognitionInputOwner : null;
    if (inputAttempt === attempt) inputAttempt = null;
    if (recognized) recognitionInputOwner = null;
    attempt.hook.retireAttempt?.(attempt.inputId);
    if (cancelRecognition && recognized && recognized.engine === speech
      && speech.getInfo().activeSessionId === recognized.sessionId) {
      revokeCaptureAuthorization(recognized.sessionId);
      speech.cancel(recognized.sessionId);
    }
    return true;
  }

  function retireRecognitionInput(engine, sessionId) {
    const owner = recognitionInputOwner;
    if (!owner || owner.engine !== engine || owner.sessionId !== sessionId) return false;
    return retireInputAttempt(owner.attempt);
  }

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
    if (!recognitionEnabled || controllerSetupActive || shortcutRecording) return false;
    if (!captureAuthorization || webContentsId(webContents) !== captureAuthorization.webContentsId) return false;
    return speech.getInfo().activeSessionId === captureAuthorization.sessionId;
  }

  function cancelActiveSession() {
    const sessionId = captureAuthorization?.sessionId || speech.getInfo().activeSessionId;
    // This is the application-wide cancellation path (disable, setup, mode,
    // navigation or helper failure), including an attempt still starting.
    retireInputAttempt(inputAttempt);
    if (recognitionInputOwner) retireInputAttempt(recognitionInputOwner.attempt);
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
    preferredMode = parsed?.voiceMode === 'cloud' ? 'cloud' : 'offline';
    mode = cloudVoiceEnabled ? preferredMode : 'offline';
    try { cloudSelection = resolveSelection(storedSettings.voiceCloud); }
    catch { cloudSelectionError = 'The saved cloud voice provider or model is unsupported. Choose one in Voice settings.'; }
    speech = mode === 'cloud' ? cloudSpeech : offlineSpeech;
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

  function saveSettings({ enabled = recognitionEnabled, accelerator = shortcut, controller = controllerBinding, voiceMode = preferredMode,
    voiceCloud = !cloudVoiceEnabled || cloudSelectionError ? storedSettings.voiceCloud : cloudSelection } = {}) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const temporary = `${settingsFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      ...storedSettings,
      ...(controllerEnabled ? { controllerBindingV1: controller } : {}),
      pushToTalkShortcut: accelerator,
      voiceRecognitionEnabled: enabled,
      voiceMode,
      voiceCloud,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, settingsFile);
  }

  function runtimeInfo() {
    const input = hook?.getInfo();
    return Object.freeze({
      available: recognitionEnabled && speech.getInfo().ready,
      enabled: recognitionEnabled,
      mode,
      cloud: cloudVoiceEnabled ? { enabled: true, ...cloudSelection, revision: cloudRevision, selectionValid: !cloudSelectionError, ...credentials.info(cloudSelection.providerId),
        providerLabel: getProvider(cloudSelection.providerId).label,
        providers: listProviders().map(provider => ({ ...provider, keyConfigured: credentials.info(provider.id).keyConfigured })) } : { enabled: false },
      // The renderer may relax its aircraft-readiness UI only in an unpackaged
      // Electron run. Packaged builds always keep the normal aircraft gates.
      development: app.isPackaged !== true,
      controllerSetup: controllerEnabled ? { active: controllerSetupActive, ...controllerSetup?.getInfo() } : undefined,
      shortcutRecording: { active: Boolean(shortcutRecording) },
      engine: speech.getInfo(),
      error: recognitionEnabled ? speechError : '',
      modelBundled: speech.getInfo().state !== 'failed' || !/model file/i.test(speechError),
      pushToTalk: Object.freeze({
        ...(controllerEnabled ? { controllerEnabled: true, controller: input?.controller || controllerSummary(controllerBinding, controllerBinding ? 'inactive' : 'unbound') } : {}),
        accelerator: input?.accelerator || shortcut,
        error: recognitionEnabled ? shortcutError : '',
        registered: recognitionEnabled && input?.registered === true,
        helperState: shortcutRecording ? 'paused' : input?.helperState || 'idle',
        failureReason: recognitionEnabled ? input?.failureReason || '' : '',
        retryable: recognitionEnabled && !shuttingDown && !controllerSetupActive && !shortcutRecording && input?.retryable === true,
        retrying: Boolean(pushToTalkRetry && !pushToTalkRetry.invalidated),
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
    let ownedHook;
    let suppressedHold = false;
    ownedHook = pushToTalkHookFactory({
      helperPath: helperPath(),
      controllerEnabled,
      onStateChange: () => { if (hook === ownedHook) send('voice:runtime-state', runtimeInfo()); },
      onCancel: (reason, inputId, source) => {
        suppressedHold = false;
        if (hook !== ownedHook) return;
        if (source && inputId !== undefined && inputId !== null) {
          const attempt = inputAttempt?.hook === ownedHook && inputAttempt.inputId === inputId ? inputAttempt
            : recognitionInputOwner?.attempt.hook === ownedHook && recognitionInputOwner.attempt.inputId === inputId
              ? recognitionInputOwner.attempt : null;
          if (!attempt) return;
          retireInputAttempt(attempt, true);
          send('voice:push-to-talk', { type: 'cancel', reason, pttAttemptId: attempt.pttAttemptId });
          return;
        }
        cancelActiveSession();
        send('voice:push-to-talk', { type: 'cancel', reason });
      },
      onDown: (accelerator, inputId) => {
        if (hook !== ownedHook || shortcutRecording) { suppressedHold = true; return; }
        if (!suppressedHold) {
          inputAttempt = { hook: ownedHook, inputId, pttAttemptId: randomUUID(), claimed: false };
          send('voice:push-to-talk', { type: 'down', accelerator, pttAttemptId: inputAttempt.pttAttemptId });
        }
      },
      onUp: (accelerator, inputId) => {
        // A press observed before promotion has no renderer owner. Its release
        // cannot finish another attempt; require the next complete fresh hold.
        if (suppressedHold) { suppressedHold = false; return; }
        if (hook === ownedHook && inputAttempt?.hook === ownedHook && inputAttempt.inputId === inputId) {
          send('voice:push-to-talk', { type: 'up', accelerator, pttAttemptId: inputAttempt.pttAttemptId });
        }
      },
      onError: (error) => {
        if (hook !== ownedHook) return;
        cancelActiveSession();
        shortcutError = error?.message || 'Push-to-talk helper stopped.';
        send('voice:push-to-talk', { type: 'error', error: shortcutError });
      },
    });
    return ownedHook;
  }

  async function startRecognitionRuntime() {
    if (!recognitionEnabled || shuttingDown || controllerSetupActive) return;
    speechError = '';
    shortcutError = '';
    try {
      if (mode === 'cloud' && cloudSelectionError) throw new Error(cloudSelectionError);
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
    // A recorder may end while model initialization is still pending. Its
    // queued restore owns the next helper, including after the lease clears.
    // Starting another here could lose a new hold when that restore promotes.
    if (controllerSetupActive || shortcutRecording || shortcutRestore) return;
    if (!hook) {
      try {
        hook = createHook();
      } catch (error) {
        shortcutError = error?.message || 'Push-to-talk is unavailable.';
        return;
      }
    }
    if (!shortcut && !controllerBinding) return;
    const startingHook = hook;
    try {
      await startingHook.setBinding({ accelerator: shortcut, ...(controllerEnabled ? { controller: controllerBinding } : {}) });
    } catch (error) {
      if (hook === startingHook && !shortcutRecording) shortcutError = error?.message || 'Push-to-talk is unavailable.';
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

  function invalidatePushToTalkRetry() {
    if (!pushToTalkRetry || pushToTalkRetry.invalidated) return;
    pushToTalkRetry.invalidated = true;
    pushToTalkRetry.candidate?.dispose();
    send('voice:runtime-state', runtimeInfo());
  }

  function invalidateShortcutRecording() {
    shortcutRecordingRevision++;
    const previous = shortcutRecording;
    shortcutRecording = null;
    previous?.owner?.removeListener?.('destroyed', previous.abandon);
    previous?.owner?.removeListener?.('did-start-navigation', previous.abandon);
    shortcutRestore?.candidate?.dispose();
    shortcutRestore = null;
  }

  function endShortcutRecording(recordingId, owner) {
    if (!shortcutRecording || shortcutRecording.id !== recordingId || shortcutRecording.owner !== owner) return Promise.resolve(runtimeInfo());
    invalidateShortcutRecording();
    const request = { revision: shortcutRecordingRevision, candidate: null };
    shortcutRestore = request;
    const current = () => shortcutRestore === request && request.revision === shortcutRecordingRevision
      && !shortcutRecording && !controllerSetupActive && recognitionEnabled && !shuttingDown;
    return queueRuntimeTransition(async () => {
      try {
        if (current() && (shortcut || controllerBinding)) {
          request.candidate = createHook();
          await request.candidate.setBinding({ accelerator: shortcut,
            ...(controllerEnabled ? { controller: controllerBinding } : {}) });
          if (current()) {
            const info = request.candidate.getInfo();
            if (!info.registered && info.helperState !== 'paused') throw new Error('Push-to-talk could not restart. Try again.');
            hook?.dispose(); hook = request.candidate; request.candidate = null;
            shortcutError = '';
          }
        }
      } catch (error) {
        if (current()) {
          if (request.candidate?.getInfo().helperState === 'failed') {
            hook?.dispose(); hook = request.candidate; request.candidate = null;
          }
          shortcutError = error?.message || 'Push-to-talk could not restart. Try again.';
        }
      } finally {
        request.candidate?.dispose();
        if (shortcutRestore === request) {
          shortcutRestore = null;
          send('voice:runtime-state', runtimeInfo());
        }
      }
      return runtimeInfo();
    });
  }

  function beginShortcutRecording(owner) {
    if (!recognitionEnabled || shuttingDown) throw new Error('Enable voice control before recording a shortcut.');
    if (controllerSetupActive) throw new Error('Finish controller button setup first.');
    if (!owner || owner.isDestroyed?.()) throw new Error('Shortcut recording sender is unavailable.');
    invalidatePushToTalkRetry();
    invalidateShortcutRecording();
    controllerSetupRevision++;
    const request = { id: randomUUID(), owner, abandon: null };
    request.abandon = (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      void endShortcutRecording(request.id, owner).catch(() => {});
    };
    shortcutRecording = request;
    owner.once?.('destroyed', request.abandon);
    owner.on?.('did-start-navigation', request.abandon);
    cancelActiveSession();
    // Retiring this exact helper also invalidates buffered native events. A
    // fresh helper after setup observes startup-held keys without replaying them.
    hook?.dispose(); hook = null;
    send('voice:push-to-talk', { type: 'cancel', reason: 'shortcut-recording' });
    send('voice:runtime-state', runtimeInfo());
    return { recordingId: request.id, runtimeInfo: runtimeInfo() };
  }

  function retryPushToTalk() {
    if (pushToTalkRetry && !pushToTalkRetry.invalidated) return pushToTalkRetry.promise;
    if (!runtimeInfo().pushToTalk.retryable) return Promise.resolve(runtimeInfo());
    const request = { previous: hook, candidate: null, invalidated: false, promise: null };
    const current = () => pushToTalkRetry === request && !request.invalidated && hook === request.previous
      && recognitionEnabled && !shuttingDown && !controllerSetupActive && !shortcutRecording;
    pushToTalkRetry = request;
    cancelActiveSession();
    send('voice:push-to-talk', { type: 'cancel', reason: 'push-to-talk-retry' });
    send('voice:runtime-state', runtimeInfo());
    request.promise = queueRuntimeTransition(async () => {
      try {
        if (current()) {
          request.candidate = createHook();
          await request.candidate.setBinding({ accelerator: shortcut,
            ...(controllerEnabled ? { controller: controllerBinding } : {}) });
          if (current()) {
            const info = request.candidate.getInfo();
            if (!info.registered && info.helperState !== 'paused') {
              throw new Error('Push-to-talk could not restart. Try again.');
            }
            request.previous.dispose();
            hook = request.candidate;
            request.candidate = null;
            shortcutError = '';
          }
        }
      } catch (error) {
        if (current()) {
          // Keep the latest bounded failure available for another explicit
          // attempt. A failed candidate never receives input authority.
          if (request.candidate?.getInfo().helperState === 'failed') {
            request.previous.dispose();
            hook = request.candidate;
            request.candidate = null;
          }
          shortcutError = error?.message || 'Push-to-talk could not restart. Try again.';
        }
      } finally {
        request.candidate?.dispose();
        if (pushToTalkRetry === request) {
          pushToTalkRetry = null;
          send('voice:runtime-state', runtimeInfo());
        }
      }
      return runtimeInfo();
    });
    return request.promise;
  }

  function setRecognitionEnabled(value) {
    if (typeof value !== 'boolean') throw new TypeError('Voice recognition enabled state must be boolean');
    if (shuttingDown) throw new Error('Voice recognition is shutting down');
    invalidatePushToTalkRetry();
    invalidateShortcutRecording();
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

  for (const engine of [offlineSpeech, cloudSpeech].filter(Boolean)) engine.onEvent((event) => {
    if (engine !== speech) return;
    const fatalError = event?.type === 'error' && event.fatal === true;
    if (fatalError) speechError = event.message || 'Local voice recognition stopped.';
    if (event?.sessionId && ['final', 'cancelled', 'error'].includes(event.type)) {
      retireRecognitionInput(engine, event.sessionId);
      revokeCaptureAuthorization(event.sessionId);
    } else if (event?.type === 'error' && event.fatal === true) {
      if (recognitionInputOwner?.engine === engine) retireInputAttempt(recognitionInputOwner.attempt);
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
    if (shortcutRecording) throw new Error('Finish shortcut recording first.');
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

  function requireCloudVoice() {
    if (!cloudVoiceEnabled) throw new Error('Cloud voice is disabled in this release. Use offline voice.');
  }

  function installIpc() {
    registerTrustedIpcHandler('voice:get-runtime-info', () => runtimeInfo());
    registerTrustedIpcHandler('voice:retry-push-to-talk', () => retryPushToTalk());
    registerTrustedIpcHandler('voice:shortcut-recording-begin', event => beginShortcutRecording(event?.sender));
    registerTrustedIpcHandler('voice:shortcut-recording-end', (event, recordingId) =>
      endShortcutRecording(requirePttAttemptId(recordingId), event?.sender));
    registerTrustedIpcHandler('voice:retire-push-to-talk-attempt', (_event, value) => ({
      retired: retireInputAttempt(findInputAttempt(requirePttAttemptId(value)), true),
    }));
    registerTrustedIpcHandler('voice:set-mode', (_event, value) => {
      if (!['offline', 'cloud'].includes(value)) throw new TypeError('Invalid voice mode.');
      if (value === 'cloud') requireCloudVoice();
      return changeCloudSetting(() => { saveSettings({ voiceMode: value }); preferredMode = mode = value; });
    });
    registerTrustedIpcHandler('voice:set-cloud-provider', (_event, value) => {
      requireCloudVoice();
      const selection = resolveSelection(value);
      return changeCloudSetting(() => { saveSettings({ voiceCloud: selection }); cloudSelection = selection; cloudSelectionError = ''; });
    });
    registerTrustedIpcHandler('voice:save-cloud-key', (_event, value) => {
      requireCloudVoice();
      if (!value || Object.keys(value).sort().join(',') !== 'key,providerId') throw new Error('Invalid cloud key request.');
      getProvider(value.providerId);
      return changeCloudSetting(() => { credentials.save(value.providerId, value.key); });
    });
    registerTrustedIpcHandler('voice:remove-cloud-key', (_event, providerId) => {
      requireCloudVoice();
      getProvider(providerId);
      return changeCloudSetting(() => { credentials.remove(providerId); });
    });
    registerTrustedIpcHandler('voice:controller-setup-start', (event) => {
      requireControllerIntegration();
      if (!recognitionEnabled) throw new Error('Enable voice control before choosing a button.');
      invalidatePushToTalkRetry();
      invalidateShortcutRecording();
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
      invalidatePushToTalkRetry();
      endControllerSetup();
      return queueRuntimeTransition(async () => {
        if (recognitionEnabled) await startRecognitionRuntime();
        send('voice:runtime-state', runtimeInfo());
        return runtimeInfo();
      });
    });
    registerTrustedIpcHandler('voice:controller-setup-save', () => {
      requireControllerIntegration();
      invalidatePushToTalkRetry();
      return queueRuntimeTransition(() => {
        if (!controllerSetupActive) throw new Error('Choose a controller button first.');
        return savePushToTalkBinding({ controller: controllerSetup.bindingToSave() });
      });
    });
    registerTrustedIpcHandler('voice:controller-binding-clear', () => {
      requireControllerIntegration();
      invalidatePushToTalkRetry();
      invalidateShortcutRecording();
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
    registerTrustedIpcHandler('voice:speech-start', (event, options) => {
      if (!recognitionEnabled) throw new Error('Voice recognition is disabled');
      if (mode === 'cloud' && cloudSelectionError) throw new Error(cloudSelectionError);
      if (controllerSetupActive) throw new Error('Voice input is paused during button setup.');
      if (shortcutRecording) throw new Error('Voice input is paused during shortcut recording.');
      const pttAttemptId = options?.pttAttemptId === undefined ? null : requirePttAttemptId(options.pttAttemptId);
      const attempt = pttAttemptId ? inputAttempt : null;
      if (pttAttemptId && (!attempt || attempt.pttAttemptId !== pttAttemptId || attempt.hook !== hook || attempt.claimed)) {
        throw new Error('Push-to-talk press is no longer active.');
      }
      let recognition;
      try {
        if (attempt) attempt.claimed = true;
        // PTT identity belongs to this runtime; providers receive only their
        // existing context, never input tokens or controller identities.
        recognition = speech.start(mode === 'cloud' ? { context: options?.context } : undefined);
      } catch (error) {
        if (attempt) retireInputAttempt(attempt);
        throw error;
      }
      if (recognitionInputOwner) retireInputAttempt(recognitionInputOwner.attempt);
      recognitionInputOwner = attempt ? { attempt, engine: speech, sessionId: recognition.sessionId } : null;
      const senderId = webContentsId(event?.sender);
      if (senderId === null) {
        retireRecognitionInput(speech, recognition.sessionId);
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
      retireRecognitionInput(speech, sessionId);
      const cancelled = speech.cancel(sessionId);
      if (cancelled) revokeCaptureAuthorization(sessionId);
      return { cancelled };
    });
    registerTrustedIpcHandler('voice:set-push-to-talk-shortcut', (event, value) => {
      const accelerator = normalizePushToTalkShortcut(value);
      const recording = shortcutRecording;
      invalidatePushToTalkRetry();
      return queueRuntimeTransition(async () => {
        if (controllerSetupActive) throw new Error('Finish controller button setup first.');
        if (recording) {
          if (shortcutRecording !== recording || recording.owner !== event?.sender) throw new Error('Shortcut recording was superseded.');
          // Recording keeps both input sources paused through Save. Registration
          // is restored from this validated saved binding only when its owner ends.
          saveSettings({ accelerator });
          shortcut = accelerator;
          send('voice:runtime-state', runtimeInfo());
          return runtimeInfo().pushToTalk;
        }
        if (shortcutRecording) throw new Error('Finish shortcut recording first.');
        if (!hook) throw new Error('Push-to-talk is unavailable');
        const info = await savePushToTalkBinding({ accelerator });
        return info.pushToTalk;
      });
    });
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
        const sessionId = captureAuthorization?.sessionId || speech.getInfo().activeSessionId;
        revokeCaptureAuthorization();
        // Report the cause while the renderer still owns this session. A
        // cancellation event first would retire it and hide the following error.
        send('voice:speech-event', {
          type: 'error', sessionId, code: error?.code === 'CAPTURE_TIMEOUT' ? 'CAPTURE_TIMEOUT' : 'INVALID_AUDIO', fatal: false,
          message: error?.message || 'Microphone audio was rejected.',
        });
        cancelActiveSession();
      }
    }, { listener: true });
  }

  function changeCloudSetting(operation) {
    if (shuttingDown) throw new Error('Voice recognition is shutting down.');
    invalidatePushToTalkRetry();
    invalidateShortcutRecording();
    cloudRevision++;
    cancelActiveSession();
    send('voice:push-to-talk', { type: 'cancel', reason: 'voice-settings-changed' });
    return queueRuntimeTransition(async () => {
      await stopRecognitionRuntime();
      try { operation(); }
      finally {
        speech = mode === 'cloud' ? cloudSpeech : offlineSpeech;
        if (recognitionEnabled && !shuttingDown) await startRecognitionRuntime();
        send('voice:runtime-state', runtimeInfo());
      }
      return runtimeInfo();
    });
  }

  async function initialize() {
    if (recognitionEnabled) await queueRuntimeTransition(startRecognitionRuntime);
    send('voice:runtime-state', runtimeInfo());
    return runtimeInfo();
  }

  async function shutdown() {
    invalidatePushToTalkRetry();
    invalidateShortcutRecording();
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
