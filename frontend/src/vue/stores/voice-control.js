import { defineStore } from 'pinia';

const DEFAULT_RUNTIME = Object.freeze({
  available: false,
  development: false,
  enabled: false,
  error: '',
  modelId: '',
  shortcut: '',
  shortcutError: '',
  shortcutRegistered: false,
});

export const useVoiceControlStore = defineStore('voiceControl', {
  state: () => ({
    runtime: { ...DEFAULT_RUNTIME },
    status: 'initializing',
    statusText: 'Starting offline voice control…',
    transcript: '',
    lastCommand: '',
    deviceLabel: '',
    inputDevices: [],
    selectedInputDeviceId: '',
    spokenReadbacks: true,
    activeSessionId: '',
    _runtimeActions: null,
  }),
  getters: {
    listening: (state) => ['starting', 'listening'].includes(state.status),
    finishing: (state) => state.status === 'finishing',
    // A backend command result remains visible until the next PTT, while the
    // button stays available so success/failure acknowledgement never traps
    // the user in a terminal UI state.
    // Recognition/capture failures and unmatched speech are terminal for only
    // the current attempt. Keep the button usable so begin() can re-check the
    // live runtime/aircraft gates and start an immediate retry.
    ready: (state) => ['ready', 'sent', 'failed', 'error', 'unmatched', 'transcribed'].includes(state.status),
  },
  actions: {
    bindRuntime(actions = null) {
      this._runtimeActions = actions && typeof actions === 'object' ? actions : null;
    },
    applyRuntimeInfo(info = {}) {
      const engine = info?.engine || {};
      const ptt = info?.pushToTalk || {};
      this.runtime = {
        available: info.available === true,
        development: info.development === true,
        enabled: info.enabled === true,
        error: typeof info.error === 'string' ? info.error : '',
        modelId: typeof engine.modelId === 'string' ? engine.modelId : '',
        shortcut: typeof ptt.accelerator === 'string'
          ? ptt.accelerator
          : DEFAULT_RUNTIME.shortcut,
        shortcutError: typeof ptt.error === 'string' ? ptt.error : '',
        shortcutRegistered: ptt.registered === true,
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
    pressToTalk() { return this._runtimeActions?.begin?.() || false; },
    releaseToTalk() { return this._runtimeActions?.finish?.() || false; },
    cancel() { return this._runtimeActions?.cancel?.('user') || false; },
    setRecognitionEnabled(value) { return this._runtimeActions?.setRecognitionEnabled?.(value) || false; },
    setShortcut(value) { return this._runtimeActions?.setShortcut?.(value) || false; },
    refreshInputDevices(options) { return this._runtimeActions?.refreshInputDevices?.(options) || []; },
    selectInputDevice(value) { return this._runtimeActions?.setInputDevice?.(value) || false; },
    toggleSpokenReadbacks(value) { return this._runtimeActions?.setSpokenReadbacks?.(value) || false; },
  },
});
