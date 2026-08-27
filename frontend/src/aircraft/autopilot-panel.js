import { toFiniteNumber } from '../utils/number.js';
import { getAircraftControlCommandPendingKey } from './control-ui.js';
import { validateAutopilotTargetValue } from './autopilot-targets.js';

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

const AUTOPILOT_SELECTOR_COMMAND_IDS = Object.freeze({
  spd: 'flightGuidance.speed.set',
  hdg: 'flightGuidance.heading.set',
  alt: 'flightGuidance.altitude.set',
  vs: 'flightGuidance.verticalSpeed.set',
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

const CONTROL_COMMANDS = Object.freeze({
  gearUp: {
    commandId: 'surfaces.gear.set', input: { value: 'up' },
    legacyRequest: { control: 'gear', operation: 'up' },
    busyLabel: 'Sending\u2026',
  },
  gearDown: {
    commandId: 'surfaces.gear.set', input: { value: 'down' },
    legacyRequest: { control: 'gear', operation: 'down' },
    busyLabel: 'Sending\u2026',
  },
  flapsDecrease: {
    commandId: 'surfaces.flaps.adjust', input: { value: 'decrease' },
    legacyRequest: { control: 'flaps', operation: 'decrement' },
    busyLabel: 'Sending\u2026',
  },
  flapsIncrease: {
    commandId: 'surfaces.flaps.adjust', input: { value: 'increase' },
    legacyRequest: { control: 'flaps', operation: 'increment' },
    busyLabel: 'Sending\u2026',
  },
  parkingBrakeRelease: {
    commandId: 'surfaces.parkingBrake.set', input: { value: false },
    legacyRequest: { control: 'parkingBrake', operation: 'set', value: false },
    busyLabel: 'Releasing\u2026',
    minimumPendingMs: 350,
  },
  parkingBrakeSet: {
    commandId: 'surfaces.parkingBrake.set', input: { value: true },
    legacyRequest: { control: 'parkingBrake', operation: 'set', value: true },
    busyLabel: 'Setting\u2026',
    minimumPendingMs: 350,
  },
  spoilersRetract: {
    commandId: 'surfaces.spoilers.set', input: { value: 'retracted' },
    legacyRequest: { control: 'spoilers', operation: 'set', value: 0 },
    busyLabel: 'Retracting\u2026',
    minimumPendingMs: 350,
  },
  spoilersExtend: {
    commandId: 'surfaces.spoilers.set', input: { value: 'full' },
    legacyRequest: { control: 'spoilers', operation: 'set', value: 16383 },
    busyLabel: 'Extending\u2026',
    minimumPendingMs: 350,
  },
  spoilersDisarm: {
    commandId: 'surfaces.spoilersArmed.set', input: { value: false },
    legacyRequest: { control: 'spoilers', operation: 'disarm' },
    busyLabel: 'Disarming\u2026',
    minimumPendingMs: 350,
  },
  spoilersArm: {
    commandId: 'surfaces.spoilersArmed.set', input: { value: true },
    legacyRequest: { control: 'spoilers', operation: 'arm' },
    busyLabel: 'Arming\u2026',
    minimumPendingMs: 350,
  },
  autopilotMasterToggle: {
    commandId: 'flightGuidance.autopilot.toggle', input: {},
    legacyRequest: { control: 'autopilot', target: 'master', operation: 'toggle' },
    busyLabel: 'Toggling\u2026',
  },
  autothrottleToggle: {
    commandId: 'flightGuidance.autothrottle.toggle', input: {},
    legacyRequest: { control: 'autopilot', target: 'autothrottle', operation: 'toggle' },
    busyLabel: 'Toggling\u2026',
  },
  flightDirectorToggle: {
    commandId: 'flightGuidance.flightDirector.toggle', input: {},
    legacyRequest: { control: 'autopilot', target: 'flightDirector', operation: 'toggle' },
    busyLabel: 'Toggling\u2026',
  },
});

const CONTROL_MODE_TOGGLE_TARGETS = Object.freeze({
  flcToggle: Object.freeze({ target: 'flightLevelChange', commandId: 'flightGuidance.flightLevelChange.set' }),
  locToggle: Object.freeze({ target: 'loc', commandId: 'flightGuidance.localizer.set' }),
  appToggle: Object.freeze({ target: 'app', commandId: 'flightGuidance.approach.set' }),
});

const AUTOPILOT_SELECTOR_HOLD_COMMAND_IDS = Object.freeze({
  spd: 'flightGuidance.speedHold.set',
  hdg: 'flightGuidance.headingHold.set',
  alt: 'flightGuidance.altitudeHold.set',
  vs: 'flightGuidance.verticalSpeedHold.set',
});

const GENERIC_LIGHT_TARGETS = Object.freeze({
  nav: true,
  beacon: true,
  strobe: true,
  landing: true,
  taxi: true,
});

const AUTOPILOT_PULSE_COMMANDS = Object.freeze({
  autothrottle: Object.freeze({
    commandId: 'flightGuidance.autothrottle.toggle', input: Object.freeze({}),
    busyLabel: 'Toggling\u2026',
  }),
  verticalSpeedHold: Object.freeze({
    commandId: 'flightGuidance.verticalSpeedHold.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
  altitudeHold: Object.freeze({
    commandId: 'flightGuidance.altitudeHold.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
  machHold: Object.freeze({
    commandId: 'flightGuidance.machHold.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
  headingHold: Object.freeze({
    commandId: 'flightGuidance.headingHold.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
  flightDirector: Object.freeze({
    commandId: 'flightGuidance.flightDirector.toggle', input: Object.freeze({}),
    busyLabel: 'Toggling\u2026',
  }),
  apMaster: Object.freeze({
    commandId: 'flightGuidance.autopilot.toggle', input: Object.freeze({}),
    busyLabel: 'Toggling\u2026',
  }),
  apDisconnect: Object.freeze({
    commandId: 'flightGuidance.autopilot.set', input: Object.freeze({ value: false }),
    busyLabel: 'Disconnecting\u2026',
  }),
  app: Object.freeze({
    commandId: 'flightGuidance.approach.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
  loc: Object.freeze({
    commandId: 'flightGuidance.localizer.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
  nav1: Object.freeze({
    commandId: 'flightGuidance.nav1.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
  ins: Object.freeze({
    commandId: 'flightGuidance.ins.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
  backcourse: Object.freeze({
    commandId: 'flightGuidance.backcourse.toggle', input: Object.freeze({}),
    busyLabel: 'Sending\u2026',
  }),
});
const AUTOPILOT_PULSE_COOLDOWN_MS = 600;

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
  now = () => Date.now(),
} = {}) {
  if (!aircraftControlsStore) {
    throw new Error('Aircraft controls store is required before autopilot panel');
  }
  const controlsStore = aircraftControlsStore;
  const getNow = typeof now === 'function' ? now : () => Date.now();
  let lastAutopilotState = { ...DEFAULT_AUTOPILOT_STATE };
  const autopilotPulseLastSentAt = new Map();

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
    autopilotPulseLastSentAt.clear();
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

  function sendSharedCommand(commandId, input, legacyRequest, options) {
    // Capability snapshots from pre-command-API backends have no catalogue.
    // Keep that narrow upgrade path; a present catalogue is authoritative and
    // never falls through when a command is unsupported for this aircraft.
    if (controlsStore?.aircraftCommandCatalogue?.configurationId) {
      return aircraftControl.sendCommand(commandId, input, options);
    }
    return legacyRequest ? aircraftControl.send(legacyRequest, options) : false;
  }

  function sendControlCommand(commandId, button = null) {
    const control = CONTROL_COMMANDS[commandId];
    if (control) {
      const command = { type: 'control', id: commandId };
      return sendSharedCommand(control.commandId, control.input, control.legacyRequest, {
        ...getSendOptions(command, button, control.busyLabel),
        minimumPendingMs: control.minimumPendingMs || 0,
      });
    }

    const modeBinding = CONTROL_MODE_TOGGLE_TARGETS[commandId];
    if (!modeBinding) return false;

    const nextValue = !getAutopilotModeActive(modeBinding.target);
    const command = { type: 'control', id: commandId };
    return sendSharedCommand(
      modeBinding.commandId,
      { value: nextValue },
      { control: 'autopilot', target: modeBinding.target, operation: 'set', value: nextValue },
      getSendOptions(command, button, nextValue ? 'Engaging\u2026' : 'Disengaging\u2026'),
    );
  }

  function sendSelectorHoldCommand(mode, button = null) {
    const target = AUTOPILOT_SELECTOR_HOLD_TARGETS[mode];
    const commandId = AUTOPILOT_SELECTOR_HOLD_COMMAND_IDS[mode];
    if (!target || !commandId) return false;

    const nextValue = !getAutopilotModeActive(target);
    const command = { type: 'selector-hold', mode };
    return sendSharedCommand(
      commandId,
      { value: nextValue },
      { control: 'autopilot', target, operation: 'set', value: nextValue },
      getSendOptions(command, button, nextValue ? 'Engaging\u2026' : 'Disengaging\u2026'),
    );
  }

  function sendSelectorAdjustCommand(mode, action, button = null) {
    const target = AUTOPILOT_SELECTOR_TARGETS[mode];
    const commandId = AUTOPILOT_SELECTOR_COMMAND_IDS[mode];
    if (!target || !commandId || !action) return false;

    const value = computeNextAutopilotSelectorValue(mode, action);
    const command = { type: 'selector-adjust', mode, action };
    return sendSharedCommand(
      commandId,
      { value },
      { control: 'autopilot', target, operation: 'set', value },
      getSendOptions(command, button, 'Setting\u2026'),
    );
  }

  function sendSelectorSetCommand(mode, rawValue, button = null) {
    const target = AUTOPILOT_SELECTOR_TARGETS[mode];
    const commandId = AUTOPILOT_SELECTOR_COMMAND_IDS[mode];
    const validated = validateAutopilotTargetValue(mode, rawValue);
    if (!target || !commandId || !validated.ok) return false;

    const command = { type: 'selector-set', mode, value: validated.value };
    return sendSharedCommand(
      commandId,
      { value: validated.value },
      { control: 'autopilot', target, operation: 'set', value: validated.value },
      getSendOptions(command, button, 'Setting\u2026'),
    );
  }

  function sendAutopilotPulseCommand(commandId, button = null) {
    const pulse = Object.prototype.hasOwnProperty.call(AUTOPILOT_PULSE_COMMANDS, commandId)
      ? AUTOPILOT_PULSE_COMMANDS[commandId]
      : null;
    if (!pulse) return false;

    const command = { type: 'autopilot-pulse', id: commandId };
    const pendingKey = getAircraftControlCommandPendingKey(command);
    const lastSentAt = Number(autopilotPulseLastSentAt.get(pendingKey) || 0);
    const nowMs = Number(getNow());
    if (controlsStore?.isCommandPending?.(pendingKey) === true) return false;
    if (lastSentAt > 0 && Number.isFinite(nowMs) && nowMs - lastSentAt < AUTOPILOT_PULSE_COOLDOWN_MS) return false;

    const legacyTarget = commandId === 'apMaster' || commandId === 'apDisconnect'
      ? 'master'
      : commandId;
    const sent = sendSharedCommand(
      pulse.commandId,
      pulse.input,
      {
        control: 'autopilot',
        target: legacyTarget,
        operation: commandId === 'apDisconnect' ? 'set' : 'toggle',
        ...(commandId === 'apDisconnect' ? { value: false } : {}),
      },
      {
        ...getSendOptions(command, button, pulse.busyLabel),
        pendingKey,
        minimumPendingMs: AUTOPILOT_PULSE_COOLDOWN_MS,
      },
    );
    if (sent !== false && Number.isFinite(nowMs)) autopilotPulseLastSentAt.set(pendingKey, nowMs);
    return sent;
  }

  function sendLightSetCommand(light, value, button = null) {
    const target = typeof light === 'string' ? light.trim() : '';
    if (!Object.prototype.hasOwnProperty.call(GENERIC_LIGHT_TARGETS, target)) return false;
    if (value !== true && value !== false) return false;

    const command = { type: 'light-set', light: target, value };
    return sendSharedCommand(
      `lights.${target}.set`,
      { value },
      { control: 'lights', target, operation: 'set', value },
      {
        ...getSendOptions(command, button, value ? 'Turning on\u2026' : 'Turning off\u2026'),
        minimumPendingMs: 350,
      },
    );
  }

  function sendCanonicalCommand(command, button = null) {
    const commandId = typeof command?.commandId === 'string' ? command.commandId.trim() : '';
    if (!commandId || controlsStore?.isAircraftCommandSupported?.(commandId) !== true) return false;
    const input = command.input && typeof command.input === 'object' && !Array.isArray(command.input)
      ? command.input
      : {};
    return aircraftControl.sendCommand(commandId, input, {
      ...getSendOptions(command, button, 'Applying…'),
      minimumPendingMs: 350,
    });
  }

  function executeControlCommand(command = {}, { button = null } = {}) {
    if (!command || typeof command !== 'object') return false;

    if (command.type === 'canonical') {
      return sendCanonicalCommand(command, button);
    }

    if (command.type === 'control') {
      return sendControlCommand(command.id, button);
    }

    if (command.type === 'selector-hold') {
      return sendSelectorHoldCommand(command.mode, button);
    }

    if (command.type === 'selector-adjust') {
      return sendSelectorAdjustCommand(command.mode, command.action, button);
    }

    if (command.type === 'selector-set') {
      return sendSelectorSetCommand(command.mode, command.value, button);
    }

    if (command.type === 'autopilot-pulse') {
      return sendAutopilotPulseCommand(command.id, button);
    }

    if (command.type === 'light-set') {
      return sendLightSetCommand(command.light, command.value, button);
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
