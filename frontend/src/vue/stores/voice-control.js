import { defineStore } from 'pinia';
import { joystickBindingFromRuntime } from '../../voice/joystick-binding.js';

const DEFAULT_RUNTIME = Object.freeze({
  available: false,
  development: false,
  enabled: false,
  error: '',
  joystick: null,
  joystickAvailable: false,
  joystickConnected: false,
  modelId: '',
  readbackError: '',
  shortcut: '',
  shortcutError: '',
  shortcutRegistered: false,
});

// While the user binds a joystick button: the sticks the desktop runtime can
// read, the first button pressed, and why detection stopped if it failed.
const DEFAULT_JOYSTICK_LEARN = Object.freeze({
  active: false,
  devices: [],
  captured: null,
  error: '',
});
const MAX_LEARN_DEVICES = 16;

export const useVoiceControlStore = defineStore('voiceControl', {
  state: () => ({
    runtime: { ...DEFAULT_RUNTIME },
    // True only in the desktop app, where the Electron voice bridge exists.
    // Recognition can still be off or failing; this says voice is possible.
    bridgeAvailable: false,
    status: 'initializing',
    statusText: 'Starting offline voice control…',
    transcript: '',
    lastCommand: '',
    deviceLabel: '',
    inputDevices: [],
    selectedInputDeviceId: '',
    spokenReadbacks: true,
    activeSessionId: '',
    joystickLearn: { ...DEFAULT_JOYSTICK_LEARN },
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
    setBridgeAvailable(value = false) { this.bridgeAvailable = value === true; },
    applyRuntimeInfo(info = {}) {
      const engine = info?.engine || {};
      const ptt = info?.pushToTalk || {};
      this.runtime = {
        available: info.available === true,
        development: info.development === true,
        enabled: info.enabled === true,
        error: typeof info.error === 'string' ? info.error : '',
        joystickAvailable: ptt.joystickAvailable === true,
        joystick: ptt.joystickAvailable === true ? joystickBindingFromRuntime(ptt.joystick) : null,
        joystickConnected: ptt.joystickAvailable === true && ptt.joystickConnected === true,
        modelId: typeof engine.modelId === 'string' ? engine.modelId : '',
        readbackError: typeof info.readback?.lastError === 'string' ? info.readback.lastError : '',
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
    setJoystickLearn({ active = false, error = '' } = {}) {
      this.joystickLearn = {
        ...DEFAULT_JOYSTICK_LEARN,
        active: active === true,
        error: typeof error === 'string' ? error.slice(0, 240) : '',
      };
    },
    // Events from the desktop runtime's detection session. A device event
    // adds or removes a stick, the first button press is what gets bound,
    // and a stopped event ends the session whatever its reason.
    applyJoystickLearnEvent(event = {}) {
      if (!this.joystickLearn.active) return;
      if (event?.type === 'device') {
        const device = joystickBindingFromRuntime({ ...event, button: 1 });
        if (!device) return;
        const devices = this.joystickLearn.devices.filter((known) => known.path !== device.path);
        if (event.connected === true && devices.length < MAX_LEARN_DEVICES) {
          devices.push({ vendorId: device.vendorId, productId: device.productId, name: device.name, path: device.path });
        }
        this.joystickLearn = { ...this.joystickLearn, devices };
        return;
      }
      if (event?.type === 'button') {
        if (event.down !== true || this.joystickLearn.captured) return;
        const captured = joystickBindingFromRuntime(event);
        if (captured) this.joystickLearn = { ...this.joystickLearn, captured };
        return;
      }
      if (event?.type === 'stopped') {
        this.joystickLearn = {
          ...this.joystickLearn,
          active: false,
          error: event.reason === 'error'
            ? String(event.error || 'Joystick detection stopped.').slice(0, 240)
            : this.joystickLearn.error,
        };
      }
    },
    pressToTalk() { return this._runtimeActions?.begin?.() || false; },
    releaseToTalk() { return this._runtimeActions?.finish?.() || false; },
    cancel() { return this._runtimeActions?.cancel?.('user') || false; },
    setRecognitionEnabled(value) { return this._runtimeActions?.setRecognitionEnabled?.(value) || false; },
    setShortcut(value) { return this._runtimeActions?.setShortcut?.(value) || false; },
    setJoystick(value) { return this._runtimeActions?.setJoystick?.(value) || false; },
    startJoystickLearn() { return this._runtimeActions?.startJoystickLearn?.() || false; },
    stopJoystickLearn() { return this._runtimeActions?.stopJoystickLearn?.() || false; },
    refreshInputDevices(options) { return this._runtimeActions?.refreshInputDevices?.(options) || []; },
    selectInputDevice(value) { return this._runtimeActions?.setInputDevice?.(value) || false; },
    toggleSpokenReadbacks(value) { return this._runtimeActions?.setSpokenReadbacks?.(value) || false; },
  },
});
