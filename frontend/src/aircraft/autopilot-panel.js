import { toFiniteNumber } from '../utils/number.js';
import { getAircraftControlCommandPendingKey } from './control-ui.js';

const DEFAULT_AUTOPILOT_STATE = Object.freeze({
  master: null,
  athrArmed: null,
  athrActive: null,
  fdActive: null,
  spdHold: null,
  hdgHold: null,
  altHold: null,
  vsHold: null,
  locHold: null,
  appHold: null,
  flcHold: null,
  spdTarget: null,
  hdgTarget: null,
  altTarget: null,
  vsTarget: null,
});

const AUTOPILOT_SELECTOR_TARGETS = Object.freeze({
  spd: 'speed',
  hdg: 'heading',
  alt: 'altitude',
  vs: 'verticalSpeed',
});

const AUTOPILOT_SELECTOR_HOLD_TARGETS = Object.freeze({
  spd: 'speedHold',
  hdg: 'headingHold',
  alt: 'altitudeHold',
  vs: 'verticalSpeedHold',
});

const AUTOPILOT_MODE_STATE_KEYS = Object.freeze({
  speedHold: 'spdHold',
  headingHold: 'hdgHold',
  altitudeHold: 'altHold',
  verticalSpeedHold: 'vsHold',
  loc: 'locHold',
  app: 'appHold',
  flightLevelChange: 'flcHold',
});

const PRESET_CONTROL_COMMANDS = Object.freeze({
  gearUp: {
    request: { control: 'gear', operation: 'up' },
    busyLabel: 'Sending\u2026',
  },
  gearDown: {
    request: { control: 'gear', operation: 'down' },
    busyLabel: 'Sending\u2026',
  },
  flapsDecrease: {
    request: { control: 'flaps', operation: 'decrement' },
    busyLabel: 'Sending\u2026',
  },
  flapsIncrease: {
    request: { control: 'flaps', operation: 'increment' },
    busyLabel: 'Sending\u2026',
  },
  autopilotMasterToggle: {
    request: { control: 'autopilot', target: 'master', operation: 'toggle' },
    busyLabel: 'Toggling\u2026',
  },
  autothrottleToggle: {
    request: { control: 'autopilot', target: 'autothrottle', operation: 'toggle' },
    busyLabel: 'Toggling\u2026',
  },
  flightDirectorToggle: {
    request: { control: 'autopilot', target: 'flightDirector', operation: 'toggle' },
    busyLabel: 'Toggling\u2026',
  },
});

const PRESET_MODE_TOGGLE_TARGETS = Object.freeze({
  flcToggle: 'flightLevelChange',
  locToggle: 'loc',
  appToggle: 'app',
});

function toNullableBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function anyKnownBooleanTrue(...values) {
  let sawFalse = false;
  for (const value of values) {
    const normalized = toNullableBoolean(value);
    if (normalized === true) return true;
    if (normalized === false) sawFalse = true;
  }
  return sawFalse ? false : null;
}

export function createAutopilotPanel({
  aircraftControl,
  getCurrentState = () => ({}),
  aircraftControlsStore = null,
} = {}) {
  if (!aircraftControlsStore) {
    throw new Error('Aircraft controls store is required before autopilot panel');
  }
  const controlsStore = aircraftControlsStore;
  let lastAutopilotState = { ...DEFAULT_AUTOPILOT_STATE };

  function update(msg) {
    const currentState = getCurrentState() || {};
    lastAutopilotState = {
      master: toNullableBoolean(msg.master),
      athrArmed: toNullableBoolean(msg.athrArmed),
      athrActive: toNullableBoolean(msg.athrActive),
      fdActive: toNullableBoolean(msg.fdActive),
      spdHold: toNullableBoolean(msg.spdHold),
      hdgHold: toNullableBoolean(msg.hdgHold),
      altHold: toNullableBoolean(msg.altHold),
      vsHold: toNullableBoolean(msg.vsHold),
      locHold: anyKnownBooleanTrue(msg.locHold, msg.navHold),
      appHold: toNullableBoolean(msg.apprHold),
      flcHold: toNullableBoolean(msg.lvlChgHold),
      spdTarget: toFiniteNumber(msg.spdTarget),
      hdgTarget: toFiniteNumber(msg.hdgTarget),
      altTarget: toFiniteNumber(msg.altTarget),
      vsTarget: toFiniteNumber(msg.vsTarget),
    };
    controlsStore?.updateAutopilot?.(msg, currentState);
  }

  function resetState() {
    lastAutopilotState = { ...DEFAULT_AUTOPILOT_STATE };
    controlsStore?.resetAutopilot?.();
  }

  function getAutopilotSelectorBase(mode) {
    const currentState = getCurrentState() || {};
    switch (mode) {
      case 'spd':
        return lastAutopilotState.spdTarget ?? currentState.ias ?? 250;
      case 'hdg':
        return lastAutopilotState.hdgTarget ?? currentState.hdg ?? 0;
      case 'alt':
        return lastAutopilotState.altTarget ?? currentState.alt ?? 10000;
      case 'vs':
        return lastAutopilotState.vsTarget ?? 0;
      default:
        return 0;
    }
  }

  function computeNextAutopilotSelectorValue(mode, action) {
    const base = getAutopilotSelectorBase(mode);

    if (mode === 'spd') {
      const deltas = { dec10: -10, dec: -1, inc: 1, inc10: 10 };
      return Math.max(0, Math.round(base) + (deltas[action] || 0));
    }

    if (mode === 'hdg') {
      const deltas = { dec10: -10, dec: -1, inc: 1, inc10: 10 };
      const normalized = Math.round(base) + (deltas[action] || 0);
      return ((normalized % 360) + 360) % 360;
    }

    if (mode === 'alt') {
      const deltas = { dec1000: -1000, dec100: -100, inc100: 100, inc1000: 1000 };
      const rounded = Math.round(base / 100) * 100;
      return Math.max(0, rounded + (deltas[action] || 0));
    }

    if (mode === 'vs') {
      const deltas = { dec500: -500, dec100: -100, inc100: 100, inc500: 500 };
      const rounded = Math.round(base / 100) * 100;
      return Math.max(-6000, Math.min(6000, rounded + (deltas[action] || 0)));
    }

    return 0;
  }

  function getAutopilotModeActive(target) {
    const stateKey = AUTOPILOT_MODE_STATE_KEYS[target];
    return stateKey ? lastAutopilotState[stateKey] === true : false;
  }

  function getSendOptions(command, button = null, busyLabel = 'Sending\u2026') {
    return {
      button,
      busyLabel,
      pendingKey: getAircraftControlCommandPendingKey(command),
    };
  }

  function sendPresetCommand(commandId, button = null) {
    const preset = PRESET_CONTROL_COMMANDS[commandId];
    if (preset) {
      const command = { type: 'preset', id: commandId };
      return aircraftControl.send(preset.request, {
        ...getSendOptions(command, button, preset.busyLabel),
      });
    }

    const modeTarget = PRESET_MODE_TOGGLE_TARGETS[commandId];
    if (!modeTarget) return false;

    const nextValue = !getAutopilotModeActive(modeTarget);
    const command = { type: 'preset', id: commandId };
    return aircraftControl.send(
      { control: 'autopilot', target: modeTarget, operation: 'set', value: nextValue },
      getSendOptions(command, button, nextValue ? 'Engaging\u2026' : 'Disengaging\u2026'),
    );
  }

  function sendSelectorHoldCommand(mode, button = null) {
    const target = AUTOPILOT_SELECTOR_HOLD_TARGETS[mode];
    if (!target) return false;

    const nextValue = !getAutopilotModeActive(target);
    const command = { type: 'selector-hold', mode };
    return aircraftControl.send(
      { control: 'autopilot', target, operation: 'set', value: nextValue },
      getSendOptions(command, button, nextValue ? 'Engaging\u2026' : 'Disengaging\u2026'),
    );
  }

  function sendSelectorAdjustCommand(mode, action, button = null) {
    const target = AUTOPILOT_SELECTOR_TARGETS[mode];
    if (!target || !action) return false;

    const value = computeNextAutopilotSelectorValue(mode, action);
    const command = { type: 'selector-adjust', mode, action };
    return aircraftControl.send(
      { control: 'autopilot', target, operation: 'set', value },
      getSendOptions(command, button, 'Setting\u2026'),
    );
  }

  function executeControlCommand(command = {}, { button = null } = {}) {
    if (!command || typeof command !== 'object') return false;

    if (command.type === 'preset') {
      return sendPresetCommand(command.id, button);
    }

    if (command.type === 'selector-hold') {
      return sendSelectorHoldCommand(command.mode, button);
    }

    if (command.type === 'selector-adjust') {
      return sendSelectorAdjustCommand(command.mode, command.action, button);
    }

    return false;
  }

  function bindControls() {
    if (typeof controlsStore?.bindCommandAction === 'function') {
      controlsStore.bindCommandAction((command, options = {}) => executeControlCommand(command, options));
    }
    aircraftControl.updateAvailability();
  }

  return {
    bindControls,
    resetState,
    update,
  };
}
