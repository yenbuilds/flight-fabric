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
import { createLocalReadback, formatAviationReadback, formatComRadioReadback, formatBaroReadback } from './local-readback.js';
import { baroResultText } from '../aircraft/baro.js';
import { comRadioResultText } from '../aircraft/com-radio.js';
import { flapResultText } from '../aircraft/flap-controls.js';
import { gearResultText } from '../aircraft/gear-controls.js';
import { createPushToTalkTone } from './push-to-talk-tone.js';
import { answerAircraftStateQuery, canQueryAircraftState, stateQueryExamples } from './state-queries.js';
import { answerFlightPlanQuery, flightPlanQueryExamples } from './flight-plan-queries.js';
import { formatSquawk } from '../aircraft/transponder.js';
import { createVoiceSetupTest } from './voice-setup-test.js';
import { createContext, validateIntent, sameContext, feedback, cloudSelectionKey } from './cloud-intent.js';

const VOICE_CAPTURE_PREFERENCES_KEY = 'flight-fabric.voice-capture-preferences.v1';
const VOICE_RELEASE_TAIL_MS = 250;

function formatCommand(match) {
  const value = Object.prototype.hasOwnProperty.call(match.input || {}, 'value')
    ? `: ${match.commandId === 'surveillance.squawk.set' ? formatSquawk(match.input.value) : String(match.input.value)}`
    : '';
  return `${match.label}${value}`;
}

export function createVoiceControlController({
  api = globalThis?.electronAPI?.voice,
  aircraftControl,
  aircraftControlsStore,
  aircraftSpecificStore,
  simbriefStore = null,
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
  let captureGeneration = 0;
  let pendingCommand = null;
  let resultHeld = false;
  let disposed = false;
  let capturePreferencesLoaded = false;
  let deviceDiscovery = null;
  let deviceRefreshRevision = 0;
  let controllerActionRevision = 0;
  let pushToTalkRetry = null;
  let shortcutRecording = null;
  const spokenReadback = readback || createLocalReadback({ globalRef });
  const acknowledgementTone = pushToTalkTone || createPushToTalkTone({ globalRef });
  const unsubscribers = [];
  const voiceTest = createVoiceSetupTest({ api, voiceStore, globalRef, createCapture,
    cancelReadback: () => { spokenReadback.cancel?.(); acknowledgementTone.cancel?.(); },
    canStart: () => !disposed && !active && !voiceStore.controllerSetup?.active && !shortcutRecording
      && !voiceStore.shortcutRecording?.active && !deviceDiscovery && !pendingCommand,
  });

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

  async function releaseDiscoverySession(discovery) {
    const sessionId = discovery.sessionId;
    discovery.sessionId = '';
    if (sessionId) {
      try { await api?.cancelRecognition?.(sessionId); } catch {}
    }
  }

  function cancelDeviceDiscovery() {
    deviceRefreshRevision++;
    const discovery = deviceDiscovery;
    deviceDiscovery = null;
    if (!discovery) return;
    discovery.abort.abort();
    // Browser device/permission requests cannot be cancelled themselves. Let
    // Settings finish its action while late replies retain their own cleanup.
    discovery.resolveCancellation([]);
    void releaseDiscoverySession(discovery);
  }

  async function refreshInputDevices({ requestAccess = false } = {}) {
    if (disposed) return [];
    if (voiceStore.runtime.enabled !== true) {
      voiceStore.setInputDevices?.([]);
      voiceStore.setInputDevicesError?.('');
      return [];
    }
    if (requestAccess && !active && !voiceTest.busy && !voiceStore.controllerSetup?.active
        && !shortcutRecording && !voiceStore.shortcutRecording?.active && !deviceDiscovery) {
      deviceRefreshRevision++;
      voiceStore.setInputDevicesError?.('');
      const discovery = { abort: new AbortController(), sessionId: '', promise: null };
      deviceDiscovery = discovery;
      const cancelled = new Promise(resolve => { discovery.resolveCancellation = resolve; });
      const isCurrent = () => !disposed && deviceDiscovery === discovery && voiceStore.runtime.enabled === true;
      const work = (async () => {
        try {
          const recognition = await api?.startRecognition?.();
          discovery.sessionId = typeof recognition?.sessionId === 'string' ? recognition.sessionId : '';
          if (!isCurrent()) return [];
          if (!discovery.sessionId) throw new Error('Microphone discovery session could not start.');
          const devices = await discoverAudioInputDevices(globalRef, { signal: discovery.abort.signal });
          if (!isCurrent()) return [];
          voiceStore.setInputDevices?.(devices);
          refreshReadyState();
          return devices;
        } catch (error) {
          if (isCurrent()) {
            const message = error?.message || 'Microphones could not be detected. Check Windows microphone access and try again.';
            // Setup errors need their own lifetime: simulator readiness and
            // held command results must not erase microphone-access feedback.
            voiceStore.setInputDevicesError?.(message);
            if (!pendingCommand && !resultHeld) voiceStore.setState('error', message);
          }
          return Array.isArray(voiceStore.inputDevices) ? voiceStore.inputDevices : [];
        } finally {
          await releaseDiscoverySession(discovery);
        }
      })();
      discovery.promise = Promise.race([work, cancelled])
        .finally(() => { if (deviceDiscovery === discovery) deviceDiscovery = null; });
      return discovery.promise;
    }
    if (deviceDiscovery) return deviceDiscovery.promise;
    const request = ++deviceRefreshRevision;
    try {
      const devices = await enumerateAudioInputDevices(globalRef);
      if (disposed || voiceStore.runtime.enabled !== true || request !== deviceRefreshRevision) return [];
      voiceStore.setInputDevices?.(devices);
      return devices;
    } catch {
      return Array.isArray(voiceStore.inputDevices) ? voiceStore.inputDevices : [];
    }
  }

  function setInputDevice(value = '') {
    if (voiceTest.busy) return false;
    void voiceTest.cancel();
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
    const catalogue = aircraftControlsStore?.aircraftCommandCatalogue || {};
    return canQueryAircraftState(aircraftSpecificStore) && !catalogue.profileKey
      ? { ...catalogue, profileKey: aircraftSpecificStore.activeProfileKey, profileRevision: aircraftSpecificStore.activeProfileRevision } : catalogue;
  }

  function voiceCommandCount() {
    if (voiceStore.runtime.mode === 'cloud') {
      try { return cloudContext().commands.length; } catch { return 0; }
    }
    return Object.values(activeCatalogue().commands || {})
      .filter((command) => Array.isArray(command?.speech?.patterns) && command.speech.patterns.length > 0)
      .length;
  }

  function cloudContext() {
    return createContext(activeCatalogue(), [
      ...flightPlanQueryExamples(),
      ...(canQueryAircraftState(aircraftSpecificStore) ? stateQueryExamples(aircraftSpecificStore) : []),
    ]);
  }

  function isDevelopmentTranscriptionOnly() {
    return voiceStore.runtime.development === true
      && !canQueryAircraftState(aircraftSpecificStore)
      && (aircraftControlsStore?.availability?.enabled !== true || voiceCommandCount() === 0);
  }

  function readyStatusText({ transcriptionOnly = false } = {}) {
    const controller = voiceStore.runtime.controllerEnabled ? voiceStore.runtime.controller : null;
    if (controller?.binding) {
      const fallback = voiceStore.runtime.shortcut && voiceStore.runtime.shortcutRegistered
        ? 'keyboard or on-screen push-to-talk' : 'on-screen push-to-talk';
      if (['waiting', 'release-required'].includes(controller.state)) {
        return `Release controller Button ${controller.binding.button}, then press it again to talk. You can also use ${fallback}.`;
      }
      if (['disconnected', 'error', 'paused', 'inactive'].includes(controller.state)) {
        return `Controller button unavailable. Check Voice settings, or use ${fallback}.`;
      }
      if (controller.state === 'ready') {
        return `Hold Button ${controller.binding.button} on ${controller.binding.label}${voiceStore.runtime.shortcut ? ', your shortcut,' : ''} or the on-screen button to ${transcriptionOnly ? 'transcribe' : 'talk'}.`;
      }
    }
    if (voiceStore.runtime.shortcutRegistered === true) {
      if (transcriptionOnly) return 'Ready.';
      const holds = voiceStore.runtime.shortcut;
      return holds
        ? `Hold ${holds} or the button, speak the complete command, then release.`
        : `Hold the button, speak the complete command, then release.`;
    }
    const shortcutError = typeof voiceStore.runtime.shortcutError === 'string'
      ? voiceStore.runtime.shortcutError.trim().replace(/[.\s]+$/u, '')
      : '';
    if (!voiceStore.runtime.shortcut && !shortcutError) {
      const choices = voiceStore.runtime.controllerEnabled ? 'a keyboard shortcut or controller button' : 'a push-to-talk shortcut';
      return `Choose ${choices} in Voice settings, or use the on-screen button to ${transcriptionOnly ? 'transcribe' : 'speak'}.`;
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
      voiceStore.setState('disabled', 'Voice control is off. Enable it in Voice settings.');
      return;
    }
    if (voiceStore.controllerSetup?.active) {
      // Setup gates input separately. Keep command/result feedback visible
      // throughout setup, including unconfirmed aircraft changes.
      if (!pendingCommand && !resultHeld) voiceStore.setState('blocked', 'Voice input is paused while choosing a controller button.');
      return;
    }
    if (shortcutRecording || voiceStore.shortcutRecording?.active) {
      if (!pendingCommand && !resultHeld) voiceStore.setState('blocked', 'Voice input is paused while choosing a keyboard shortcut.');
      return;
    }
    if (!voiceStore.runtime.available) {
      resultHeld = false;
      voiceStore.setState('unavailable', voiceStore.runtime.error || 'Voice recognition is unavailable.');
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
    if (aircraftControlsStore?.availability?.enabled !== true && !canQueryAircraftState(aircraftSpecificStore)) {
      resultHeld = false;
      voiceStore.setState('blocked', aircraftControlsStore?.availability?.reason || 'Aircraft control is unavailable.');
      return;
    }
    if (voiceCommandCount() === 0 && !canQueryAircraftState(aircraftSpecificStore)) {
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
    const gear = gearResultText(result, command);
    if (gear) {
      const detail = typeof result.error === 'string' && result.error.trim() ? ` ${result.error.trim()}` : '';
      voiceStore.setState(gear.outcome === 'unconfirmed' ? 'error'
        : gear.outcome === 'failed' ? 'failed' : 'sent', `${gear.text}${detail}`);
      speakReadback(gear.text);
      return;
    }
    const flap = flapResultText(result, command);
    if (flap) {
      const detail = typeof result.error === 'string' && result.error.trim() ? ` ${result.error.trim()}` : '';
      voiceStore.setState(flap.outcome === 'unconfirmed' ? 'error'
        : flap.outcome === 'failed' ? 'failed' : 'sent', `${flap.text}${detail}`);
      speakReadback(flap.text);
      return;
    }
    if (/^baro\.(captain|firstOfficer|both)\./.test(command.commandId || '')) {
      const status = baroResultText(result);
      voiceStore.setState(status.confirmed ? 'sent' : 'error', status.text);
      speakReadback(formatBaroReadback(result));
      return;
    }
    if (result.ok === true) {
      if (/^radios\.com[12]\./.test(command.commandId || '')) {
        voiceStore.setState('sent', comRadioResultText(result) || 'Radio response unconfirmed. Check the aircraft radio.');
        speakReadback(formatComRadioReadback(result));
        return;
      }
      if (command.commandId === 'configuration.apu.start' && result.code === 'already_satisfied') {
        voiceStore.setState('sent', 'APU already starting or running. No additional START was sent.');
        speakReadback('A P U already starting or running.');
        return;
      }
      if (result.transportAcknowledged === true && result.code !== 'sent_unconfirmed') {
        const text = command.commandId === 'configuration.apu.start'
          ? 'APU start requested.' : command.commandId === 'surveillance.ident.activate'
            ? 'IDENT requested.' : `Requested ${command.description}.`;
        voiceStore.setState('sent', `${text} Aircraft outcome is not yet confirmed.`);
        speakReadback(command.commandId === 'configuration.apu.start'
          ? 'A P U start requested.' : command.commandId === 'surveillance.ident.activate'
            ? 'IDENT requested.' : 'Command requested. Aircraft outcome is not yet confirmed.');
        return;
      }
      if (result.code === 'sent_unconfirmed') {
        voiceStore.setState('sent', `Sent ${command.description}. Aircraft response unconfirmed; check the simulator.`);
        speakReadback('Command sent. Aircraft response unconfirmed. Check the simulator.');
        return;
      }
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

  function retireGlobalAttempt(session) {
    if (session.source !== 'global' || !session.pttAttemptId || session.pttRetired) return;
    session.pttRetired = true;
    // Input participation must end before browser cleanup can stall. Main
    // correlates this token to the exact input and recognition owner.
    try { Promise.resolve(api?.retirePushToTalkAttempt?.(session.pttAttemptId)).catch(() => {}); } catch {}
  }

  async function cancel(reason = 'cancelled') {
    const session = active;
    if (!session) return false;
    active = null;
    session.abort.abort();
    voiceStore.setSession('');
    retireGlobalAttempt(session);
    try { await session.capture?.cancel(); } catch {}
    if (session.sessionId) {
      try { await api?.cancelRecognition?.(session.sessionId); } catch {}
    }
    // Disconnect recovery can start another capture while this one's audio
    // resources are still closing. Old cleanup no longer owns its UI state.
    if (disposed || session.generation !== captureGeneration) return true;
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

  async function begin(source = 'local', pttAttemptId = '') {
    const input = { source, pttAttemptId: source === 'global' && typeof pttAttemptId === 'string' ? pttAttemptId : '' };
    const refuse = () => { retireGlobalAttempt(input); return false; };
    if (source === 'global' && !input.pttAttemptId) return false;
    if (!disposed && source === 'global' && active?.source === 'global' && active.pttAttemptId === input.pttAttemptId) return true;
    if (disposed || active || voiceStore.controllerSetup?.active || shortcutRecording || voiceStore.shortcutRecording?.active
        || voiceTest.busy || deviceDiscovery || voiceStore.runtime.enabled !== true) return refuse();
    spokenReadback.cancel?.();
    // A confirmed result stays visible until the next command. Starting that
    // command explicitly releases the hold before readiness is recomputed. A
    // global PTT press while simulator writes are still unavailable must not
    // dismiss the held result when no new command can start.
    if (
      resultHeld
      && !canQueryAircraftState(aircraftSpecificStore)
      && !isDevelopmentTranscriptionOnly()
      && (
        aircraftControlsStore?.availability?.enabled !== true
        || voiceCommandCount() === 0
      )
    ) {
      return refuse();
    }
    resultHeld = false;
    refreshReadyState();
    if (voiceStore.status !== 'ready') return refuse();
    // Retire completed test audio/readback ownership before ordinary PTT.
    // busy was excluded above, so this clears idle test state synchronously.
    void voiceTest.cancel();
    const session = {
      generation: ++captureGeneration,
      source,
      pttAttemptId: input.pttAttemptId,
      sessionId: '',
      mode: voiceStore.runtime.mode === 'cloud' ? 'cloud' : 'offline',
      cloudSelection: cloudSelectionKey(voiceStore.runtime.cloud),
      // Freeze this decision for the entire utterance. A simulator/profile
      // appearing midway through an off-aircraft test must not make it send.
      transcriptionOnly: isDevelopmentTranscriptionOnly(),
      profileKey: activeCatalogue().profileKey || '',
      profileRevision: activeCatalogue().profileRevision,
      configurationId: activeCatalogue().configurationId || '',
      releaseRequested: false,
      abort: new AbortController(),
      pressCuePending: true,
      captureReady: false,
      finishPromise: null,
      capture: null,
    };
    if (session.mode === 'cloud' && !session.transcriptionOnly) {
      try { session.cloudContext = cloudContext(); } catch {
        voiceStore.setState('error', 'The aircraft voice catalogue is unavailable. Nothing was executed.');
        return refuse();
      }
    }
    // Publish before the short press cue. This retains a very quick key-up
    // without opening a recognition or microphone session.
    active = session;
    voiceStore.setTranscript('');
    voiceStore.setLastCommand('');
    voiceStore.setCloudUsage?.(null);
    voiceStore.setState('starting', 'Opening microphone…');
    let recognition;
    try {
      // Let the press cue finish before starting microphone capture, so it is
      // never included in the PCM stream.
      try { await acknowledgementTone.play?.('press', { signal: session.abort.signal }); }
      finally { session.pressCuePending = false; }
      if (disposed || active !== session || session.releaseRequested || voiceStore.runtime.enabled !== true) {
        if (active === session) {
          active = null;
          session.abort.abort();
          voiceStore.setSession('');
          retireGlobalAttempt(session);
          refreshReadyState();
        }
        return false;
      }
      const options = {
        ...(session.cloudContext ? { context: session.cloudContext } : {}),
        ...(session.pttAttemptId ? { pttAttemptId: session.pttAttemptId } : {}),
      };
      recognition = await api.startRecognition(Object.keys(options).length ? options : undefined);
      session.sessionId = recognition.sessionId;
      if (active !== session) {
        try { await api.cancelRecognition(session.sessionId); } catch {}
        return false;
      }
      if (session.releaseRequested) {
        active = null;
        session.abort.abort();
        voiceStore.setSession('');
        retireGlobalAttempt(session);
        refreshReadyState();
        try { await api.cancelRecognition(session.sessionId); } catch {}
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
      voiceStore.setInputDevicesError?.('');
      void refreshInputDevices();
      if (session.releaseRequested) return finish();
      voiceStore.setState('listening', session.transcriptionOnly
        ? 'Listening… speak the complete phrase, then release to transcribe. Nothing will be sent.'
        : 'Listening… speak the complete command, then release to execute.');
      return true;
    } catch (error) {
      if (active !== session) return false;
      active = null;
      session.abort.abort();
      voiceStore.setSession('');
      retireGlobalAttempt(session);
      if (recognition?.sessionId) {
        try { await api.cancelRecognition(recognition.sessionId); } catch {}
      }
      if (disposed || session.generation !== captureGeneration) return false;
      if (session.releaseRequested) refreshReadyState();
      else voiceStore.setState('error', error?.message || 'Voice control could not start.');
      return false;
    }
  }

  async function finish() {
    const session = active;
    if (!session) return false;
    session.releaseRequested = true;
    if (session.finishPromise) return session.finishPromise;
    // A browser resume/ended callback may never arrive. Retire the cue owner
    // now; a late browser reply cannot start capture or retain this attempt.
    if (session.pressCuePending) return cancel('released-before-capture');

    // Key-up before recognition or browser capture is ready retires ownership
    // immediately. Late speech-start replies remain responsible for cancelling
    // their own session; they cannot open a microphone or disturb a new hold.
    if (!session.captureReady) return cancel('released-before-capture');

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
        // stop() detaches capture input and stops the microphone tracks.
        // The release cue therefore cannot become microphone input.
        void acknowledgementTone.play?.('release', { signal: session.abort.signal });
        await api.finishRecognition(session.sessionId);
        return true;
      } catch (error) {
        if (active !== session) return false;
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
    const fatalError = event.type === 'error' && event.fatal === true;
    // A worker crash affects the current microphone even when the engine
    // cannot attach a session ID. Keep ignoring stale session-scoped events.
    if (!session || (event.sessionId !== session.sessionId && !(fatalError && !event.sessionId))) return;
    if (event.type === 'partial') {
      voiceStore.setTranscript(event.text || '');
      return;
    }
    if (event.type === 'error') {
      active = null;
      session.abort.abort();
      voiceStore.setSession('');
      voiceStore.setState(fatalError ? 'unavailable' : 'error', event.message || 'Voice recognition failed.');
      retireGlobalAttempt(session);
      try { await session.capture?.cancel?.(); } catch {}
      return;
    }
    if (event.type === 'cancelled') {
      active = null;
      session.abort.abort();
      voiceStore.setSession('');
      retireGlobalAttempt(session);
      try { await session.capture.cancel(); } catch {}
      if (!disposed && session.generation === captureGeneration) refreshReadyState();
      return;
    }
    if (event.type !== 'final') return;

    if (session.finalReceived) return;
    session.finalReceived = true;
    const releasedBeforeFinal = session.releaseRequested;
    if (!releasedBeforeFinal) {
      active = null;
      session.abort.abort();
      voiceStore.setSession('');
      voiceStore.setState('error', 'Recognition ended before push-to-talk was released. Nothing was executed.');
      retireGlobalAttempt(session);
      try { await session.capture?.cancel?.(); } catch {}
      return;
    }
    try { await session.capture.cancel(); } catch {}
    // Retain ownership until cleanup finishes so cancellation/disablement can
    // still retire this result before any aircraft command or readback.
    if (active !== session || disposed || voiceStore.runtime.enabled !== true) return;
    active = null;
    voiceStore.setSession('');
    const transcript = String(event.text || '').trim();
    voiceStore.setTranscript(transcript);
    if (session.mode === 'cloud') voiceStore.setCloudUsage?.(event.usage);
    const catalogue = activeCatalogue();
    if ((event.mode || 'offline') !== session.mode || (voiceStore.runtime.mode || 'offline') !== session.mode) {
      voiceStore.setState('error', 'Voice mode changed before the request could execute.');
      return;
    }
    if (session.mode === 'cloud' && (cloudSelectionKey(voiceStore.runtime.cloud) !== session.cloudSelection
        || cloudSelectionKey(event.selection) !== session.cloudSelection)) {
      voiceStore.setState('error', 'Cloud voice settings changed before the request could execute. Nothing was executed.');
      return;
    }
    if (session.transcriptionOnly) {
      if (session.mode === 'cloud') {
        voiceStore.setLastCommand('Development only · No command was sent');
        voiceStore.setState('transcribed', 'Cloud interpretation complete. Use the Voice settings test to check heading recognition. Nothing was sent.');
        return;
      }
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
    let cloudIntent = null;
    if (session.mode === 'cloud') {
      try {
        if (!sameContext(session.cloudContext, cloudContext())) throw new Error();
        cloudIntent = validateIntent(event.intent, session.cloudContext);
      } catch {
        voiceStore.setState('error', 'The cloud result is invalid or aircraft controls changed. Nothing was executed.');
        return;
      }
      if (['clarify', 'no-action'].includes(cloudIntent.decision)) {
        voiceStore.setState('unmatched', feedback(cloudIntent));
        return;
      }
    }
    const queryText = cloudIntent ? (cloudIntent.decision === 'query' ? cloudIntent.query : '') : transcript;
    const planQuery = answerFlightPlanQuery(queryText, simbriefStore?.plan);
    if (planQuery) {
      resultHeld = true;
      voiceStore.setLastCommand(`Read flight plan: ${planQuery.id}`);
      voiceStore.setState(planQuery.ok ? 'sent' : 'error', planQuery.text);
      speakReadback(planQuery.spoken);
      return;
    }
    const query = answerAircraftStateQuery(queryText, aircraftSpecificStore, session);
    if (query) {
      resultHeld = true;
      voiceStore.setLastCommand(`Read aircraft state: ${query.id}`);
      voiceStore.setState(query.ok ? 'sent' : 'error', query.text);
      speakReadback(query.text);
      return;
    }
    if (cloudIntent?.decision === 'query') {
      voiceStore.setState('unmatched', 'That answer is currently unavailable. Nothing was executed.');
      return;
    }
    const match = cloudIntent ? {
      ok: true, commandId: cloudIntent.commandId, input: cloudIntent.input,
      label: session.cloudContext.commands.find(command => command.id === cloudIntent.commandId).label,
    } : interpretAircraftVoiceCommand(transcript, catalogue);
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
      commandId: match.commandId,
      description,
      spokenResult: formatAviationReadback(match),
      input: match.input,
    };
    pendingCommand = command;
    const sent = aircraftControl.sendCommand(match.commandId, match.input, {
      pendingKey: `aircraft-command:${match.commandId}`,
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

  function invalidatePushToTalkRetry() {
    controllerActionRevision++;
    const retry = pushToTalkRetry;
    pushToTalkRetry = null;
    if (retry) {
      voiceStore.runtime.pttRetrying = false;
      retry.resolve(false);
    }
    return controllerActionRevision;
  }

  function retryPushToTalk() {
    if (pushToTalkRetry) return pushToTalkRetry.promise;
    if (disposed || !api?.retryPushToTalk || voiceStore.runtime.enabled !== true
        || voiceStore.controllerSetup?.active || shortcutRecording || voiceStore.shortcutRecording?.active
        || voiceStore.runtime.pttRetryable !== true) return Promise.resolve(false);
    const retry = { revision: ++controllerActionRevision, resolve: null, promise: null };
    retry.promise = new Promise(resolve => { retry.resolve = resolve; });
    pushToTalkRetry = retry;
    voiceStore.runtime.pttRetrying = true;
    const isCurrent = () => !disposed && pushToTalkRetry === retry
      && retry.revision === controllerActionRevision && voiceStore.runtime.enabled === true
      && !voiceStore.controllerSetup?.active;
    // Retire the interrupted attempt before recovery; nothing is replayed.
    cancelDeviceDiscovery();
    const cancellation = active ? cancel('ptt-retry') : Promise.resolve();
    void (async () => {
      try {
        await Promise.all([cancellation, voiceTest.cancel()]);
        if (!isCurrent()) return false;
        const info = await api.retryPushToTalk();
        if (!isCurrent()) return false;
        // Retry owns only the helper. A newer recognizer failure or readback
        // update may already have arrived while its IPC reply was in flight.
        applyPushToTalkInfo(info.pushToTalk);
        return info.pushToTalk?.helperState === 'ready';
      } catch {
        if (isCurrent()) {
          voiceStore.runtime.shortcutError = 'Push-to-talk could not restart. Try again.';
          refreshReadyState();
        }
        return false;
      } finally {
        if (pushToTalkRetry === retry) {
          pushToTalkRetry = null;
          voiceStore.runtime.pttRetrying = false;
        }
      }
    })().then(retry.resolve);
    return retry.promise;
  }

  async function controllerAction(method) {
    if (disposed || !api?.[method] || !voiceStore.runtime.controllerEnabled) return false;
    void endShortcutRecording();
    const request = invalidatePushToTalkRetry();
    if (method === 'startControllerSetup') {
      cancelDeviceDiscovery();
      await voiceTest.cancel();
      if (disposed || request !== controllerActionRevision || voiceStore.runtime.enabled !== true) return false;
      if (active) await cancel('button-setup');
      if (disposed || request !== controllerActionRevision || voiceStore.runtime.enabled !== true) return false;
    }
    const info = await api[method]();
    if (disposed || request !== controllerActionRevision) return false;
    voiceStore.applyRuntimeInfo(info);
    refreshReadyState();
    return true;
  }

  async function setShortcut(value) {
    if (disposed || !api) return false;
    const request = invalidatePushToTalkRetry();
    try {
      const info = await api.setPushToTalkShortcut(value);
      if (disposed || request !== controllerActionRevision) return false;
      applyPushToTalkInfo(info);
      return true;
    } catch (error) {
      if (disposed || request !== controllerActionRevision) return false;
      voiceStore.setState('error', error?.message || 'Push-to-talk shortcut could not be changed.');
      return false;
    }
  }

  function applyShortcutRecordingInfo(info) {
    voiceStore.shortcutRecording = { active: info.shortcutRecording?.active === true };
    // Setup owns input availability only, never a newer recognizer/readback result.
    applyPushToTalkInfo(info.pushToTalk);
  }

  function beginShortcutRecording() {
    if (shortcutRecording) return shortcutRecording.promise;
    if (disposed || !api?.beginShortcutRecording || voiceStore.runtime.enabled !== true
        || voiceStore.controllerSetup?.active || pendingCommand) return Promise.resolve(false);
    const recording = { revision: invalidatePushToTalkRetry(), recordingId: '', resolve: null, promise: null };
    recording.promise = new Promise(resolve => { recording.resolve = resolve; });
    shortcutRecording = recording;
    const current = () => !disposed && shortcutRecording === recording
      && recording.revision === controllerActionRevision && voiceStore.runtime.enabled === true;
    cancelDeviceDiscovery();
    const cancellation = active ? cancel('shortcut-setup') : Promise.resolve();
    refreshReadyState();
    void (async () => {
      try {
        await Promise.all([cancellation, voiceTest.cancel()]);
        if (!current()) return false;
        const result = await api.beginShortcutRecording();
        recording.recordingId = typeof result?.recordingId === 'string' ? result.recordingId : '';
        if (!current()) {
          if (recording.recordingId) void Promise.resolve(api.endShortcutRecording(recording.recordingId)).catch(() => {});
          return false;
        }
        if (!recording.recordingId || result.runtimeInfo?.shortcutRecording?.active !== true) {
          if (recording.recordingId) void Promise.resolve(api.endShortcutRecording(recording.recordingId)).catch(() => {});
          shortcutRecording = null;
          refreshReadyState();
          return false;
        }
        applyShortcutRecordingInfo(result.runtimeInfo);
        return true;
      } catch {
        if (shortcutRecording === recording) {
          shortcutRecording = null;
          refreshReadyState();
        }
        return false;
      }
    })().then(recording.resolve);
    return recording.promise;
  }

  async function endShortcutRecording() {
    const recording = shortcutRecording;
    shortcutRecording = null;
    if (!recording) return true;
    recording.resolve(false);
    const revision = controllerActionRevision;
    const generation = captureGeneration;
    if (!recording.recordingId) { refreshReadyState(); return true; }
    try {
      const info = await api.endShortcutRecording(recording.recordingId);
      if (!disposed && !shortcutRecording && revision === controllerActionRevision && generation === captureGeneration) applyShortcutRecordingInfo(info);
      return true;
    } catch {
      return false;
    }
  }

  async function changeCloudSetting(method, ...args) {
    if (disposed || !api?.[method] || pendingCommand) return false;
    void endShortcutRecording();
    invalidatePushToTalkRetry();
    cancelDeviceDiscovery();
    await voiceTest.cancel();
    if (active) await cancel('voice-settings');
    if (disposed) return false;
    try {
      const info = await api[method](...args);
      if (disposed) return false;
      voiceStore.applyRuntimeInfo(info);
      refreshReadyState();
      return true;
    } catch {
      voiceStore.setState('error', 'Voice settings could not be saved. Check the key format and protected storage availability.');
      return false;
    }
  }

  function applyPushToTalkInfo(info) {
    voiceStore.applyRuntimeInfo({
      mode: voiceStore.runtime.mode,
      cloud: voiceStore.runtime.cloud,
      available: voiceStore.runtime.available,
      development: voiceStore.runtime.development,
      enabled: voiceStore.runtime.enabled,
      error: voiceStore.runtime.error,
      engine: { modelId: voiceStore.runtime.modelId, state: voiceStore.runtime.engineState },
      modelBundled: voiceStore.runtime.modelBundled,
      controllerSetup: voiceStore.controllerSetup,
      shortcutRecording: voiceStore.shortcutRecording,
      pushToTalk: info,
      readback: { lastError: voiceStore.runtime.readbackError },
    });
    refreshReadyState();
  }

  async function setRecognitionEnabled(value) {
    if (disposed || !api?.setRecognitionEnabled) return false;
    const nextEnabled = value === true;
    if (!nextEnabled) void endShortcutRecording();
    invalidatePushToTalkRetry();
    if (!nextEnabled) cancelDeviceDiscovery();
    if (!nextEnabled) await voiceTest.cancel();
    if (!nextEnabled && active) await cancel('voice-disabled');
    try {
      const info = await api.setRecognitionEnabled(nextEnabled);
      voiceStore.applyRuntimeInfo(info);
      // Enabling voice is an explicit user action, so it is also the right
      // time to briefly open the default input and reveal its real device
      // labels. No PCM capture is created and the temporary stream is closed
      // inside discoverAudioInputDevices().
      if (voiceStore.runtime.enabled === true) await refreshInputDevices({ requestAccess: true });
      else {
        voiceStore.setInputDevices?.([]);
        voiceStore.setInputDevicesError?.('');
      }
      refreshReadyState();
      return voiceStore.runtime.enabled === nextEnabled;
    } catch (error) {
      voiceStore.setState('error', error?.message || 'Voice control setting could not be changed.');
      return false;
    }
  }

  function handlePushToTalk(event = {}) {
    const matchesAttempt = active?.source === 'global' && active.pttAttemptId === event.pttAttemptId;
    if (event.type === 'down') void begin('global', event.pttAttemptId);
    else if (event.type === 'up') {
      if (event.pttAttemptId && matchesAttempt) void finish();
    }
    else if (event.type === 'cancel') {
      if (event.pttAttemptId && !matchesAttempt) return;
      // Scoped device cancellation owns only its global utterance. Runtime-wide
      // cancellation (disable, setup, helper failure) still retires all capture.
      if (event.pttAttemptId) {
        void cancel(event.reason || 'ptt-cancel');
        return;
      }
      void voiceTest.cancel();
      if (active) void cancel(event.reason || 'ptt-cancel');
      else refreshReadyState();
    }
    else if (event.type === 'error') {
      const message = event.error || 'Global push-to-talk stopped.';
      applyPushToTalkInfo({
        controllerEnabled: voiceStore.runtime.controllerEnabled,
        controller: voiceStore.runtime.controller,
        accelerator: event.accelerator || voiceStore.runtime.shortcut,
        error: message,
        registered: false,
        helperState: voiceStore.runtime.pttHelperState,
        retryable: voiceStore.runtime.pttRetryable,
        failureReason: voiceStore.runtime.pttFailureReason,
        retrying: voiceStore.runtime.pttRetrying,
      });
      if (active) {
        const generation = captureGeneration;
        void cancel('ptt-error').finally(() => { if (generation === captureGeneration) refreshReadyState(); });
      }
      else refreshReadyState();
    }
  }

  async function initialize() {
    loadCapturePreferences();
    spokenReadback.prepare?.();
    voiceStore.bindRuntime({
      // A hold belongs to the input that started it. A tap/late pointer event
      // from another input cannot finish or cancel that utterance.
      begin: () => begin('local'),
      cancel: () => active?.source === 'local' ? cancel('user') : false,
      finish: () => active?.source === 'local' ? finish() : false,
      refreshInputDevices,
      retryPushToTalk,
      setRecognitionEnabled,
      setMode: value => changeCloudSetting('setMode', value),
      setCloudProvider: value => changeCloudSetting('setCloudProvider', value),
      saveCloudKey: (providerId, value) => changeCloudSetting('saveCloudKey', providerId, value),
      removeCloudKey: providerId => changeCloudSetting('removeCloudKey', providerId),
      setInputDevice,
      setSpokenReadbacks,
      setShortcut,
      beginShortcutRecording,
      endShortcutRecording,
      startControllerSetup: () => controllerAction('startControllerSetup'),
      cancelControllerSetup: () => controllerAction('cancelControllerSetup'),
      saveControllerButton: () => controllerAction('saveControllerButton'),
      clearControllerButton: () => controllerAction('clearControllerButton'),
      startVoiceTest: voiceTest.start,
      finishVoiceTest: voiceTest.finish,
      cancelVoiceTest: voiceTest.cancel,
      playVoiceTest: voiceTest.playRecording,
      testSpokenFeedback: voiceTest.testSpokenFeedback,
    });
    voiceStore.setBridgeAvailable?.(Boolean(api));
    const mediaDevices = globalRef?.navigator?.mediaDevices;
    if (typeof mediaDevices?.addEventListener === 'function') {
      const handleDeviceChange = () => { void refreshInputDevices(); };
      mediaDevices.addEventListener('devicechange', handleDeviceChange);
      unsubscribers.push(() => mediaDevices.removeEventListener?.('devicechange', handleDeviceChange));
    }
    if (!api) { refreshReadyState(); return false; }
    unsubscribers.push(api.onRecognitionEvent((event) => {
      // Offline capture expiry finalizes an empty worker session; cloud expiry
      // emits an error. Either terminal event must retire discovery's stream.
      if (deviceDiscovery && ['final', 'error', 'cancelled'].includes(event.type)
          && (event.sessionId === deviceDiscovery.sessionId || (event.fatal === true && !event.sessionId))) {
        cancelDeviceDiscovery();
      }
      void voiceTest.handleRecognitionEvent(event);
      return handleRecognitionEvent(event);
    }));
    unsubscribers.push(api.onPushToTalk(handlePushToTalk));
    unsubscribers.push(api.onRuntimeState((info) => {
      const wasEnabled = voiceStore.runtime.enabled;
      const wasMode = voiceStore.runtime.mode;
      const wasCloudSelection = cloudSelectionKey(voiceStore.runtime.cloud);
      voiceStore.applyRuntimeInfo(info);
      if (shortcutRecording && (voiceStore.runtime.enabled !== true || voiceStore.controllerSetup?.active
          || wasMode !== voiceStore.runtime.mode || wasCloudSelection !== cloudSelectionKey(voiceStore.runtime.cloud)
          || (shortcutRecording.recordingId && !voiceStore.shortcutRecording?.active))) {
        void endShortcutRecording();
      }
      if (voiceStore.runtime.enabled !== true || voiceStore.controllerSetup?.active
          || wasMode !== voiceStore.runtime.mode || wasCloudSelection !== cloudSelectionKey(voiceStore.runtime.cloud)) {
        invalidatePushToTalkRetry();
      }
      if (wasMode !== voiceStore.runtime.mode || wasCloudSelection !== cloudSelectionKey(voiceStore.runtime.cloud)) {
        cancelDeviceDiscovery();
        voiceStore.setCloudUsage?.(null);
        void voiceTest.cancel();
        if (active) void cancel('voice-mode-changed');
      }
      if (voiceStore.controllerSetup?.active || voiceStore.shortcutRecording?.active) {
        cancelDeviceDiscovery();
        void voiceTest.cancel();
        if (active) void cancel('button-setup');
      }
      if ((wasEnabled && voiceStore.runtime.enabled !== true)
          || (voiceTest.busy && voiceStore.runtime.available !== true)) {
        void voiceTest.cancel(voiceTest.busy ? 'Voice recognition stopped. Try the test again when it is available.' : '');
      }
      if (voiceStore.runtime.enabled !== true || voiceStore.runtime.available !== true) cancelDeviceDiscovery();
      if (voiceStore.runtime.enabled !== true) voiceStore.setInputDevices?.([]);
      // Also retire startup attempts whose recognition IPC reply has not yet
      // arrived; a session-scoped failure cannot be correlated there yet.
      if (voiceStore.runtime.available !== true && active) void cancel('runtime-unavailable');
      else refreshReadyState();
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
    void endShortcutRecording();
    cancelDeviceDiscovery();
    invalidatePushToTalkRetry();
    pendingCommand = null;
    resultHeld = false;
    await voiceTest.dispose();
    await cancel('shutdown');
    spokenReadback.cancel?.();
    void acknowledgementTone.dispose?.();
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe?.();
    voiceStore.bindRuntime(null);
  }

  return Object.freeze({
    begin,
    cancel,
    collectHints: () => [...collectVoiceHints(activeCatalogue()),
      ...(canQueryAircraftState(aircraftSpecificStore) ? stateQueryExamples(aircraftSpecificStore).map((text) => text.toUpperCase()) : []),
      ...flightPlanQueryExamples().map((text) => text.toUpperCase())],
    dispose,
    finish,
    handleAircraftContextChange,
    handleSimulatorStateChange,
    initialize,
    refreshReadyState,
    refreshInputDevices,
    retryPushToTalk,
    setInputDevice,
    setRecognitionEnabled,
    setSpokenReadbacks,
    setShortcut,
    beginShortcutRecording,
    endShortcutRecording,
  });
}
