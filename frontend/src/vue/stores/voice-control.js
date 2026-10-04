import { defineStore } from 'pinia';
import { readStorageValue, writeStorageValue } from '../../app/browser-environment.js';
import { initialVoiceTestState } from '../../voice/voice-setup-test.js';

const SETUP_DISMISSED_KEY = 'ff_voice_setup_dismissed_v1';

const DEFAULT_RUNTIME = Object.freeze({
  available: false,
  development: false,
  enabled: false,
  error: '',
  modelId: '',
  readbackError: '',
  shortcut: '',
  shortcutError: '',
  shortcutRegistered: false,
  controllerEnabled: false,
  controller: { binding: null, state: 'unbound', error: '' },
});

export const useVoiceControlStore = defineStore('voiceControl', {
  state: () => ({
    runtime: { ...DEFAULT_RUNTIME },
    controllerSetup: { active: false, phase: 'idle', held: false, selection: null, message: '' },
    // True only in the desktop app, where the Electron voice bridge exists.
    // Recognition can still be off or failing; this says voice is possible.
    bridgeAvailable: false,
    panelOpen: false,
    settingsReturnToAircraft: false,
    setupDismissed: readStorageValue(SETUP_DISMISSED_KEY, { fallback: '' }) === 'yes',
    status: 'initializing',
    statusText: 'Starting offline voice control…',
    transcript: '',
    lastCommand: '',
    deviceLabel: '',
    inputDevices: [],
    inputDevicesError: '',
    selectedInputDeviceId: '',
    spokenReadbacks: true,
    voiceTest: initialVoiceTestState(),
    activeSessionId: '',
    _runtimeActions: null,
  }),
  getters: {
    // Setup is local to the desktop runtime, not simulator connectivity. The
    // system-default microphone is valid; viewing settings does not complete
    // setup. Only runtime registration confirms a working push-to-talk binding.
    setupTask: (state) => {
      if (!state.bridgeAvailable || state.status === 'initializing') return null;
      const hasBinding = Boolean(state.runtime.shortcut
        || (state.runtime.controllerEnabled && state.runtime.controller.binding));
      if (!state.runtime.enabled) {
        // A previously configured user can deliberately turn voice off.
        return hasBinding ? null : { action: 'Set up voice control', detail: 'Choose your microphone and how to talk.', optional: true };
      }
      if (!state.runtime.available) return { action: 'Check voice setup', detail: 'Voice could not start. Open settings for details.' };
      if (state.inputDevicesError) return { action: 'Check voice setup', detail: 'Microphone access needs attention.' };
      if (!state.runtime.shortcutRegistered) return {
        action: hasBinding ? 'Check voice setup' : 'Set up voice control',
        detail: hasBinding ? 'Push-to-talk needs attention.'
          : state.runtime.controllerEnabled ? 'Choose a keyboard shortcut or controller button.' : 'Choose a push-to-talk shortcut.',
        optional: !hasBinding,
      };
      return null;
    },
    setupReminder() {
      return this.setupTask && (!this.setupTask.optional || !this.setupDismissed) ? this.setupTask : null;
    },
    listening: (state) => ['starting', 'listening'].includes(state.status),
    finishing: (state) => state.status === 'finishing',
    voiceTestBusy: (state) => ['starting', 'listening', 'recognizing', 'stopping', 'playing'].includes(state.voiceTest.phase),
    // A backend command result remains visible until the next PTT, while the
    // button stays available so success/failure acknowledgement never traps
    // the user in a terminal UI state.
    // Recognition/capture failures and unmatched speech are terminal for only
    // the current attempt. Keep the button usable so begin() can re-check the
    // live runtime/aircraft gates and start an immediate retry.
    ready() { return !this.controllerSetup.active && !this.voiceTestBusy && ['ready', 'sent', 'failed', 'error', 'unmatched', 'transcribed'].includes(this.status); },
  },
  actions: {
    dismissSetup() {
      if (!this.setupTask?.optional) return;
      this.setupDismissed = true;
      writeStorageValue(SETUP_DISMISSED_KEY, 'yes');
    },
    bindRuntime(actions = null) {
      this._runtimeActions = actions && typeof actions === 'object' ? actions : null;
    },
    setBridgeAvailable(value = false) { this.bridgeAvailable = value === true; },
    applyRuntimeInfo(info = {}) {
      if (info.enabled !== true) this.inputDevicesError = '';
      const engine = info?.engine || {};
      const ptt = info?.pushToTalk || {};
      const controllerEnabled = ptt.controllerEnabled === true;
      this.controllerSetup = controllerEnabled && info.controllerSetup ? {
        active: info.controllerSetup.active === true, phase: info.controllerSetup.phase || 'idle',
        held: info.controllerSetup.held === true, selection: info.controllerSetup.selection || null,
        message: typeof info.controllerSetup.message === 'string' ? info.controllerSetup.message : '',
      } : { active: false, phase: 'idle', held: false, selection: null, message: '' };
      this.runtime = {
        available: info.available === true,
        development: info.development === true,
        enabled: info.enabled === true,
        error: typeof info.error === 'string' ? info.error : '',
        modelId: typeof engine.modelId === 'string' ? engine.modelId : '',
        readbackError: typeof info.readback?.lastError === 'string' ? info.readback.lastError : '',
        shortcut: typeof ptt.accelerator === 'string'
          ? ptt.accelerator
          : DEFAULT_RUNTIME.shortcut,
        shortcutError: typeof ptt.error === 'string' ? ptt.error : '',
        shortcutRegistered: ptt.registered === true,
        controllerEnabled,
        controller: controllerEnabled && ptt.controller ? ptt.controller : DEFAULT_RUNTIME.controller,
      };
    },
    setState(status, text = '') {
      this.status = status;
      if (typeof text === 'string' && text) this.statusText = text;
    },
    setSession(sessionId = '') { this.activeSessionId = String(sessionId || ''); },
    setTranscript(value = '') { this.transcript = String(value || '').slice(0, 4096); },
    setLastCommand(value = '') { this.lastCommand = String(value || '').slice(0, 240); },
    setDeviceLabel(value = '') { this.deviceLabel = String(value || '').slice(0, 160); },
    setInputDevicesError(value = '') {
      this.inputDevicesError = typeof value === 'string' ? value.slice(0, 240) : '';
    },
    setInputDevices(devices = []) {
      const seen = new Set();
      this.inputDevices = (Array.isArray(devices) ? devices : [])
        .map((device) => ({
          deviceId: String(device?.deviceId || '').trim().slice(0, 512),
          label: String(device?.label || '').trim().slice(0, 160),
        }))
        .filter((device) => {
          if (!device.deviceId || seen.has(device.deviceId)) return false;
          seen.add(device.deviceId);
          return true;
        });
    },
    setSelectedInputDevice(value = '') {
      this.selectedInputDeviceId = String(value || '').trim().slice(0, 512);
    },
    setSpokenReadbacks(value = true) { this.spokenReadbacks = value === true; },
    setVoiceTestState(patch) { this.voiceTest = { ...this.voiceTest, ...patch }; },
    pressToTalk() { return this._runtimeActions?.begin?.() || false; },
    releaseToTalk() { return this._runtimeActions?.finish?.() || false; },
    cancel() { return this._runtimeActions?.cancel?.('user') || false; },
    setRecognitionEnabled(value) { return this._runtimeActions?.setRecognitionEnabled?.(value) || false; },
    startControllerSetup() { return this._runtimeActions?.startControllerSetup?.() || false; },
    cancelControllerSetup() { return this._runtimeActions?.cancelControllerSetup?.() || false; },
    saveControllerButton() { return this._runtimeActions?.saveControllerButton?.() || false; },
    clearControllerButton() { return this._runtimeActions?.clearControllerButton?.() || false; },
    setShortcut(value) { return this._runtimeActions?.setShortcut?.(value) || false; },
    refreshInputDevices(options) { return this._runtimeActions?.refreshInputDevices?.(options) || []; },
    selectInputDevice(value) { return this._runtimeActions?.setInputDevice?.(value) || false; },
    toggleSpokenReadbacks(value) { return this._runtimeActions?.setSpokenReadbacks?.(value) || false; },
    startVoiceTest() { return this._runtimeActions?.startVoiceTest?.() || false; },
    finishVoiceTest() { return this._runtimeActions?.finishVoiceTest?.() || false; },
    cancelVoiceTest() { return this._runtimeActions?.cancelVoiceTest?.() || false; },
    playVoiceTest() { return this._runtimeActions?.playVoiceTest?.() || false; },
    testSpokenFeedback() { return this._runtimeActions?.testSpokenFeedback?.() || false; },
  },
});
