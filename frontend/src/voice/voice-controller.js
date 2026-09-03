import { readStorageJson, writeStorageJson } from '../app/browser-environment.js';
import {
  createPcmCapture,
  discoverAudioInputDevices,
  enumerateAudioInputDevices,
} from './pcm-capture.js';
import {
  collectVoiceHints,
  incompleteVoiceCommandPrompt,
  interpretAircraftVoiceCommand,
} from './command-interpreter.js';
import { createLocalReadback, formatAviationReadback } from './local-readback.js';
import { createPushToTalkTone } from './push-to-talk-tone.js';

const VOICE_CAPTURE_PREFERENCES_KEY = 'flight-fabric.voice-capture-preferences.v1';
const VOICE_RELEASE_TAIL_MS = 250;

function formatCommand(match) {
  const value = Object.prototype.hasOwnProperty.call(match.input || {}, 'value')
    ? `: ${String(match.input.value)}`
    : '';
  return `${match.label}${value}`;
}

export function createVoiceControlController({
  api = globalThis?.electronAPI?.voice,
  aircraftControl,
  aircraftControlsStore,
  voiceStore,
  globalRef = globalThis,
  createCapture = createPcmCapture,
  readback = null,
  pushToTalkTone = null,
  releaseTailMs = VOICE_RELEASE_TAIL_MS,
} = {}) {
  if (!Number.isFinite(releaseTailMs) || releaseTailMs < 0 || releaseTailMs > 500) {
    throw new RangeError('Voice release tail must be between 0 and 500 milliseconds.');
  }
  let active = null;
  let pendingCommand = null;
  let resultHeld = false;
  let disposed = false;
  let capturePreferencesLoaded = false;
  let deviceDiscoveryPromise = null;
  const spokenReadback = readback || createLocalReadback({ globalRef });
  const acknowledgementTone = pushToTalkTone || createPushToTalkTone({ globalRef });
  const unsubscribers = [];

  function storageRef() {
    try { return globalRef?.localStorage || null; } catch { return null; }
  }

  function loadCapturePreferences() {
    if (capturePreferencesLoaded) return;
    capturePreferencesLoaded = true;
    const preferences = readStorageJson(VOICE_CAPTURE_PREFERENCES_KEY, {
      fallback: {},
      storage: storageRef(),
    });
    voiceStore.setSelectedInputDevice?.(preferences?.deviceId);
    voiceStore.setSpokenReadbacks?.(preferences?.spokenReadbacks !== false);
  }

  function saveCapturePreferences() {
    writeStorageJson(VOICE_CAPTURE_PREFERENCES_KEY, {
      deviceId: String(voiceStore.selectedInputDeviceId || ''),
      spokenReadbacks: voiceStore.spokenReadbacks === true,
    }, { storage: storageRef() });
  }

  async function refreshInputDevices({ requestAccess = false } = {}) {
    if (voiceStore.runtime.enabled !== true) {
      voiceStore.setInputDevices?.([]);
      return [];
    }
    if (requestAccess && !active && !deviceDiscoveryPromise) {
      deviceDiscoveryPromise = (async () => {
        let sessionId = '';
        try {
          const recognition = await api?.startRecognition?.();
          sessionId = typeof recognition?.sessionId === 'string' ? recognition.sessionId : '';
          if (!sessionId) throw new Error('Microphone discovery session could not start.');
          const devices = await discoverAudioInputDevices(globalRef);
          if (voiceStore.runtime.enabled !== true) {
            voiceStore.setInputDevices?.([]);
            return [];
          }
          voiceStore.setInputDevices?.(devices);
          refreshReadyState();
          return devices;
        } catch (error) {
          voiceStore.setState(
            'error',
            error?.message || 'Microphones could not be detected. Check Windows microphone access and try again.',
          );
          return Array.isArray(voiceStore.inputDevices) ? voiceStore.inputDevices : [];
        } finally {
          if (sessionId) {
            try { await api?.cancelRecognition?.(sessionId); } catch {}
          }
        }
      })().finally(() => { deviceDiscoveryPromise = null; });
      return deviceDiscoveryPromise;
    }
    if (deviceDiscoveryPromise) return deviceDiscoveryPromise;
    try {
      const devices = await enumerateAudioInputDevices(globalRef);
      voiceStore.setInputDevices?.(devices);
      return devices;
    } catch {
      return Array.isArray(voiceStore.inputDevices) ? voiceStore.inputDevices : [];
    }
  }

  function setInputDevice(value = '') {
    voiceStore.setSelectedInputDevice?.(value);
    saveCapturePreferences();
    return true;
  }

  function setSpokenReadbacks(value = true) {
    voiceStore.setSpokenReadbacks?.(value === true);
    if (value !== true) spokenReadback.cancel?.();
    saveCapturePreferences();
    return true;
  }

  function speakReadback(value) {
    if (voiceStore.spokenReadbacks !== true) return false;
    return spokenReadback.speak?.(value) === true;
  }

  function activeCatalogue() {
    return aircraftControlsStore?.aircraftCommandCatalogue || {};
  }

  function voiceCommandCount() {
    return Object.values(activeCatalogue().commands || {})
      .filter((command) => Array.isArray(command?.speech?.patterns) && command.speech.patterns.length > 0)
      .length;
  }

  function isDevelopmentTranscriptionOnly() {
    return voiceStore.runtime.development === true
      && (aircraftControlsStore?.availability?.enabled !== true || voiceCommandCount() === 0);
  }

  function readyStatusText({ transcriptionOnly = false } = {}) {
    if (voiceStore.runtime.shortcutRegistered === true) {
      return transcriptionOnly
        ? 'Ready.'
        : `Hold ${voiceStore.runtime.shortcut} or the button, speak the complete command, then release.`;
    }
    const shortcutError = typeof voiceStore.runtime.shortcutError === 'string'
      ? voiceStore.runtime.shortcutError.trim().replace(/[.\s]+$/u, '')
      : '';
    if (!voiceStore.runtime.shortcut && !shortcutError) {
      return `Choose a push-to-talk shortcut in Voice settings, or use the on-screen button to ${transcriptionOnly ? 'transcribe' : 'speak'}.`;
    }
    const unavailable = shortcutError
      ? `Global push-to-talk unavailable: ${shortcutError}.`
      : 'Global push-to-talk is unavailable.';
    return `${unavailable} Use the on-screen button to ${transcriptionOnly ? 'transcribe' : 'speak'}.`;
  }

  function refreshReadyState() {
    if (disposed || active) return;
    if (!api) {
      resultHeld = false;
      voiceStore.setState('unavailable', 'Voice control is available in the desktop app.');
      return;
    }
    if (voiceStore.runtime.enabled !== true) {
      resultHeld = false;
      voiceStore.setState('disabled', 'Voice control is off. Enable it to use local speech recognition.');
      return;
    }
    if (!voiceStore.runtime.available) {
      resultHeld = false;
      voiceStore.setState('unavailable', voiceStore.runtime.error || 'Offline recognition is unavailable.');
      return;
    }
    if (isDevelopmentTranscriptionOnly()) {
      resultHeld = false;
      voiceStore.setState(
        'ready',
        readyStatusText({ transcriptionOnly: true }),
      );
      return;
    }
    // Routine capability/profile replays can temporarily remove every voice
    // command. Keep ownership of an in-flight command or its correlated result
    // until the command completes or the user starts a real replacement.
    if (pendingCommand || resultHeld) return;
    if (aircraftControlsStore?.availability?.enabled !== true) {
      resultHeld = false;
      voiceStore.setState('blocked', aircraftControlsStore?.availability?.reason || 'Aircraft control is unavailable.');
      return;
    }
    if (voiceCommandCount() === 0) {
      resultHeld = false;
      voiceStore.setState('blocked', 'This aircraft profile has no voice-enabled commands.');
      return;
    }
    voiceStore.setState('ready', readyStatusText());
  }

  function handleCommandResult(command, result = {}) {
    if (pendingCommand !== command) return;
    pendingCommand = null;
    resultHeld = true;
    if (result.ok === true) {
      voiceStore.setState('sent', `Sent ${command.description}.`);
      speakReadback(command.spokenResult);
      return;
    }
    const detail = typeof result.error === 'string' && result.error.trim()
      ? ` ${result.error.trim()}`
      : '';
    const completedStepCount = Number(result.completedStepCount);
    const stepCount = Number(result.stepCount);
    const executionStarted = result.executionStarted === true;
    const hasIncompleteStepProgress = Number.isSafeInteger(completedStepCount)
      && completedStepCount >= 0
      && Number.isSafeInteger(stepCount)
      && stepCount > 0
      && completedStepCount < stepCount
      && (completedStepCount > 0 || executionStarted);
    const stepProgress = hasIncompleteStepProgress
      ? (completedStepCount > 0
          ? ` ${completedStepCount} of ${stepCount} steps completed before failure. Verify aircraft state.`
          : ` 0 of ${stepCount} ${stepCount === 1 ? 'step' : 'steps'} confirmed before failure. Verify aircraft state.`)
      : '';
    voiceStore.setState('failed', `Could not send ${command.description}.${stepProgress}${detail}`);
    speakReadback(hasIncompleteStepProgress
      ? 'Command failed. Verify aircraft state.'
      : 'Command failed.');
  }

  async function cancel(reason = 'cancelled') {
    const session = active;
    if (!session) return false;
    active = null;
    voiceStore.setSession('');
    try { await session.capture.cancel(); } catch {}
    try { await api?.cancelRecognition?.(session.sessionId); } catch {}
    // Capture/finalization callers have already published the actionable
    // failure. Do not immediately hide it behind the normal cancellation or
    // ready copy; the next PTT attempt explicitly recovers from error state.
    if (reason === 'audio-error' || reason === 'finish-error' || reason === 'ptt-error') {
      return true;
    }
    voiceStore.setState('ready', reason === 'profile-changed'
      ? 'Aircraft changed; the voice command was cancelled.'
      : 'Voice command cancelled.');
    refreshReadyState();
    return true;
  }

  async function begin() {
    if (disposed || active || deviceDiscoveryPromise || voiceStore.runtime.enabled !== true) return false;
    spokenReadback.cancel?.();
    // A confirmed result stays visible until the next command. Starting that
    // command explicitly releases the hold before readiness is recomputed. A
    // global PTT press while simulator writes are still unavailable must not
    // dismiss the held result when no new command can start.
    if (
      resultHeld
      && !isDevelopmentTranscriptionOnly()
      && (
        aircraftControlsStore?.availability?.enabled !== true
        || voiceCommandCount() === 0
      )
    ) {
      return false;
    }
    resultHeld = false;
    refreshReadyState();
    if (voiceStore.status !== 'ready') return false;
    const session = {
      sessionId: '',
      // Freeze this decision for the entire utterance. A simulator/profile
      // appearing midway through an off-aircraft test must not make it send.
      transcriptionOnly: isDevelopmentTranscriptionOnly(),
      profileKey: activeCatalogue().profileKey || '',
      profileRevision: activeCatalogue().profileRevision,
      configurationId: activeCatalogue().configurationId || '',
      releaseRequested: false,
      captureReady: false,
      finishPromise: null,
      capture: null,
    };
    // Publish before the short press cue. This retains a very quick key-up
    // without opening a recognition or microphone session.
    active = session;
    // Let the press cue finish before starting microphone capture, so it is
    // never included in the PCM stream.
    await acknowledgementTone.play?.('press');
    if (disposed || active !== session || session.releaseRequested || voiceStore.runtime.enabled !== true) {
      if (active === session) {
        active = null;
        voiceStore.setSession('');
        refreshReadyState();
      }
      return false;
    }
    voiceStore.setTranscript('');
    voiceStore.setLastCommand('');
    voiceStore.setState('starting', 'Opening microphone…');
    let recognition;
    try {
      recognition = await api.startRecognition();
      session.sessionId = recognition.sessionId;
      if (active !== session) {
        try { await api.cancelRecognition(session.sessionId); } catch {}
        return false;
      }
      if (session.releaseRequested) {
        try { await api.cancelRecognition(session.sessionId); } catch {}
        active = null;
        voiceStore.setSession('');
        refreshReadyState();
        return false;
      }
      const capture = createCapture({
        deviceId: String(voiceStore.selectedInputDeviceId || ''),
        globalRef,
        onChunk({ sampleRate, samples, sequence }) {
          if (active !== session) return;
          try {
            api.sendAudio({
              sampleRate: Math.round(sampleRate),
              samples: samples.buffer,
              sequence,
              sessionId: session.sessionId,
            });
          } catch (error) {
            voiceStore.setState('error', error?.message || 'Microphone audio could not be sent.');
            void cancel('audio-error');
          }
        },
        onError(error) {
          if (active !== session) return;
          voiceStore.setState('error', error?.message || 'Microphone capture failed.');
          void cancel('audio-error');
        },
      });
      session.capture = capture;
      voiceStore.setSession(session.sessionId);
      const captureInfo = await capture.start();
      if (active !== session) return false;
      session.captureReady = true;
      voiceStore.setDeviceLabel(captureInfo.deviceLabel);
      void refreshInputDevices();
      if (session.releaseRequested) return finish();
      voiceStore.setState('listening', session.transcriptionOnly
        ? 'Listening… speak the complete phrase, then release to transcribe. Nothing will be sent.'
        : 'Listening… speak the complete command, then release to execute.');
      return true;
    } catch (error) {
      if (active !== session) return false;
      if (recognition?.sessionId) {
        try { await api.cancelRecognition(recognition.sessionId); } catch {}
      }
      active = null;
      voiceStore.setSession('');
      voiceStore.setState('error', error?.message || 'Voice control could not start.');
      return false;
    }
  }

  async function finish() {
    const session = active;
    if (!session) return false;
    session.releaseRequested = true;
    if (session.finishPromise) return session.finishPromise;

    // If key-up beats the recognition IPC response, begin() observes the
    // release and cancels without ever opening the microphone.
    if (!session.sessionId) return true;

    // A release during getUserMedia/AudioWorklet setup cancels that setup. The
    // begin() catch sees that the session was already cleared and stays quiet.
    if (!session.captureReady) {
      session.finishPromise = (async () => {
        try { await session.capture?.cancel?.(); } catch {}
        try { await api.cancelRecognition(session.sessionId); } catch {}
        if (active === session) {
          active = null;
          voiceStore.setSession('');
          refreshReadyState();
        }
        return true;
      })();
      return session.finishPromise;
    }

    session.finishPromise = (async () => {
      voiceStore.setState('finishing', session.transcriptionOnly
        ? 'Transcribing…'
        : 'Recognizing command…');
      try {
        // Keep the microphone open very briefly after key-up so samples already
        // moving through the OS and AudioWorklet are not cut off. This is a
        // fixed privacy-bounded tail, not silence synthesis or inferred speech.
        if (releaseTailMs > 0) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, releaseTailMs));
          if (active !== session) return false;
        }
        // stop() flushes the worklet. onChunk intentionally continues accepting
        // those final samples until the capture has completely stopped.
        await session.capture.stop();
        if (active !== session) return false;
        // stop() closes the capture context and stops the microphone tracks.
        // The release cue therefore cannot become microphone input.
        void acknowledgementTone.play?.('release');
        await api.finishRecognition(session.sessionId);
        return true;
      } catch (error) {
        voiceStore.setState('error', error?.message || 'Voice recognition could not finish.');
        await cancel('finish-error');
        return false;
      }
    })();
    return session.finishPromise;
  }

  async function handleRecognitionEvent(event = {}) {
    const session = active;
    if (event.type === 'ready') return;
    if (!session || event.sessionId !== session.sessionId) return;
    if (event.type === 'partial') {
      voiceStore.setTranscript(event.text || '');
      return;
    }
    if (event.type === 'error') {
      active = null;
      voiceStore.setSession('');
      try { await session.capture.cancel(); } catch {}
      voiceStore.setState('error', event.message || 'Voice recognition failed.');
      return;
    }
    if (event.type === 'cancelled') {
      active = null;
      voiceStore.setSession('');
      try { await session.capture.cancel(); } catch {}
      refreshReadyState();
      return;
    }
    if (event.type !== 'final') return;

    active = null;
    voiceStore.setSession('');
    try { await session.capture.cancel(); } catch {}
    if (!session.releaseRequested) {
      voiceStore.setState('error', 'Recognition ended before push-to-talk was released. Nothing was executed.');
      return;
    }
    const transcript = String(event.text || '').trim();
    voiceStore.setTranscript(transcript);
    const catalogue = activeCatalogue();
    if (session.transcriptionOnly) {
      const catalogueUnchanged = catalogue.profileKey === session.profileKey
        && catalogue.profileRevision === session.profileRevision
        && catalogue.configurationId === session.configurationId;
      const match = catalogueUnchanged && voiceCommandCount() > 0
        ? interpretAircraftVoiceCommand(transcript, catalogue)
        : null;
      if (match?.ok) {
        const description = formatCommand(match);
        voiceStore.setLastCommand(match.interpretedTranscript
          ? `Development only · Interpreted as “${match.interpretedTranscript}” · Would send ${description}`
          : `Development only · Would send ${description}`);
      } else if (match?.interpretedTranscript) {
        voiceStore.setLastCommand(
          `Development only · Interpreted as “${match.interpretedTranscript}” · Invalid target; no command was sent`,
        );
      } else {
        voiceStore.setLastCommand('Development only · No command was sent');
      }
      voiceStore.setState(
        'transcribed',
        match?.ok
          ? 'Development transcription complete. Nothing was sent.'
          : 'Transcribed in development mode. No active command matched; nothing was sent.',
      );
      return;
    }
    if (catalogue.profileKey !== session.profileKey
        || catalogue.profileRevision !== session.profileRevision
        || catalogue.configurationId !== session.configurationId) {
      voiceStore.setState('error', 'Aircraft changed before the command could execute.');
      return;
    }
    const match = interpretAircraftVoiceCommand(transcript, catalogue);
    if (!match.ok) {
      const retryPrompt = match.reason === 'unmatched'
        ? incompleteVoiceCommandPrompt(transcript, catalogue)
        : '';
      const message = match.reason === 'ambiguous'
        ? 'Command matched more than one action and was not executed.'
        : match.reason === 'invalid-value'
          ? `Interpreted as “${match.interpretedTranscript}”, but that target is invalid. Nothing was executed.`
          : retryPrompt
            ? `Command incomplete. ${retryPrompt} Nothing was executed.`
            : 'Command not recognized. Nothing was executed.';
      if (match.interpretedTranscript) {
        voiceStore.setLastCommand(`Interpreted as “${match.interpretedTranscript}” · Invalid target`);
      }
      voiceStore.setState('unmatched', message);
      return;
    }
    const description = formatCommand(match);
    voiceStore.setLastCommand(match.interpretedTranscript
      ? `Interpreted as “${match.interpretedTranscript}” · ${description}`
      : description);
    const command = {
      description,
      spokenResult: formatAviationReadback(match),
    };
    pendingCommand = command;
    const sent = aircraftControl.sendCommand(match.commandId, match.input, {
      pendingKey: `voice:${match.commandId}`,
      onResult: (result) => handleCommandResult(command, result),
    });
    if (!sent) {
      if (pendingCommand === command) pendingCommand = null;
      voiceStore.setState('error', 'The matched command is no longer available.');
      return;
    }
    if (pendingCommand === command) {
      voiceStore.setState('sending', `Sending ${command.description}\u2026`);
    }
  }

  async function setShortcut(value) {
    if (!api) return false;
    try {
      const info = await api.setPushToTalkShortcut(value);
      voiceStore.applyRuntimeInfo({
        available: voiceStore.runtime.available,
        development: voiceStore.runtime.development,
        enabled: voiceStore.runtime.enabled,
        engine: { modelId: voiceStore.runtime.modelId },
        pushToTalk: info,
      });
      refreshReadyState();
      return true;
    } catch (error) {
      voiceStore.setState('error', error?.message || 'Push-to-talk shortcut could not be changed.');
      return false;
    }
  }

  async function setRecognitionEnabled(value) {
    if (!api?.setRecognitionEnabled) return false;
    const nextEnabled = value === true;
    if (!nextEnabled && active) await cancel('voice-disabled');
    try {
      const info = await api.setRecognitionEnabled(nextEnabled);
      voiceStore.applyRuntimeInfo(info);
      // Enabling voice is an explicit user action, so it is also the right
      // time to briefly open the default input and reveal its real device
      // labels. No PCM capture is created and the temporary stream is closed
      // inside discoverAudioInputDevices().
      if (voiceStore.runtime.enabled === true) await refreshInputDevices({ requestAccess: true });
      else voiceStore.setInputDevices?.([]);
      refreshReadyState();
      return voiceStore.runtime.enabled === nextEnabled;
    } catch (error) {
      voiceStore.setState('error', error?.message || 'Voice control setting could not be changed.');
      return false;
    }
  }

  function handlePushToTalk(event = {}) {
    if (event.type === 'down') void begin();
    else if (event.type === 'up') void finish();
    else if (event.type === 'error') {
      const message = event.error || 'Global push-to-talk stopped.';
      voiceStore.applyRuntimeInfo({
        available: voiceStore.runtime.available,
        development: voiceStore.runtime.development,
        enabled: voiceStore.runtime.enabled,
        error: voiceStore.runtime.error,
        engine: { modelId: voiceStore.runtime.modelId },
        pushToTalk: {
          accelerator: event.accelerator || voiceStore.runtime.shortcut,
          error: message,
          registered: false,
        },
      });
      if (active) void cancel('ptt-error').finally(refreshReadyState);
      else refreshReadyState();
    }
  }

  async function initialize() {
    loadCapturePreferences();
    spokenReadback.prepare?.();
    voiceStore.bindRuntime({
      begin,
      cancel,
      finish,
      refreshInputDevices,
      setRecognitionEnabled,
      setInputDevice,
      setSpokenReadbacks,
      setShortcut,
    });
    const mediaDevices = globalRef?.navigator?.mediaDevices;
    if (typeof mediaDevices?.addEventListener === 'function') {
      const handleDeviceChange = () => { void refreshInputDevices(); };
      mediaDevices.addEventListener('devicechange', handleDeviceChange);
      unsubscribers.push(() => mediaDevices.removeEventListener?.('devicechange', handleDeviceChange));
    }
    if (!api) { refreshReadyState(); return false; }
    unsubscribers.push(api.onRecognitionEvent(handleRecognitionEvent));
    unsubscribers.push(api.onPushToTalk(handlePushToTalk));
    unsubscribers.push(api.onRuntimeState((info) => {
      voiceStore.applyRuntimeInfo(info);
      if (voiceStore.runtime.enabled !== true) voiceStore.setInputDevices?.([]);
      refreshReadyState();
    }));
    try {
      const info = await api.getRuntimeInfo();
      voiceStore.applyRuntimeInfo(info);
      if (voiceStore.runtime.enabled === true) await refreshInputDevices();
      refreshReadyState();
      return info.available === true;
    } catch (error) {
      voiceStore.setState('unavailable', error?.message || 'Voice runtime is unavailable.');
      return false;
    }
  }

  function handleAircraftContextChange({ preserveResult = false } = {}) {
    // Off-aircraft development sessions are permanently non-dispatchable and
    // remain useful even if the backend reconnects while the user is speaking.
    // The final-result path separately refuses to preview a command from a
    // changed catalogue.
    if (active?.transcriptionOnly) return;
    // Cached aircraftProfile/dataSources messages are replayed during routine
    // state refreshes. They must refresh readiness without cancelling the
    // current utterance or dropping ownership of its correlated result.
    if (preserveResult === true) {
      refreshReadyState();
      return;
    }
    pendingCommand = null;
    resultHeld = false;
    if (active) void cancel('profile-changed');
    else refreshReadyState();
  }

  function handleSimulatorStateChange(state = {}) {
    if (state?.blocked === true) {
      if (active && !active.transcriptionOnly) {
        void cancel('sim-state-blocked');
        return;
      }
      // A live-state rejection can arrive after earlier preset steps changed
      // the aircraft. Retain result ownership until that response is shown.
      if (pendingCommand || resultHeld) return;
    }
    refreshReadyState();
  }

  async function dispose() {
    disposed = true;
    pendingCommand = null;
    resultHeld = false;
    await cancel('shutdown');
    spokenReadback.cancel?.();
    void acknowledgementTone.dispose?.();
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe?.();
    voiceStore.bindRuntime(null);
  }

  return Object.freeze({
    begin,
    cancel,
    collectHints: () => collectVoiceHints(activeCatalogue()),
    dispose,
    finish,
    handleAircraftContextChange,
    handleSimulatorStateChange,
    initialize,
    refreshReadyState,
    refreshInputDevices,
    setInputDevice,
    setRecognitionEnabled,
    setSpokenReadbacks,
    setShortcut,
  });
}
