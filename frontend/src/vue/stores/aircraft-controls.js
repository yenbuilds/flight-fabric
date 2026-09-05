import { defineStore } from 'pinia';
import { copyNavRadioReadback } from '../../aircraft/nav-radio.js';
import { toFiniteNumber } from '../../utils/number.js';
import {
  getAircraftControlCanonicalCommandId,
  getAircraftControlCommandPendingKey,
} from '../../aircraft/control-ui.js';

const DEFAULT_FEEDBACK = Object.freeze({
  actionText: 'No command sent yet.',
  routeText: 'Waiting for first write.',
  profileText: 'Active profile unknown.',
  status: 'idle',
  commandKey: '',
});

const DEFAULT_AVAILABILITY = Object.freeze({
  enabled: false,
  reason: 'Waiting for backend connection.',
});

const DEFAULT_CONTROL_CAPABILITIES = Object.freeze({
  surface: Object.freeze({
    gearUp: true,
    gearDown: true,
    flapsDecrease: true,
    flapsIncrease: true,
    parkingBrake: false,
    spoilersPosition: false,
    spoilersArm: false,
  }),
  lights: Object.freeze({
    nav: false,
    beacon: false,
    strobe: false,
    landing: false,
    taxi: false,
  }),
  autopilot: Object.freeze({
    master: true,
    autothrottle: true,
    flightDirector: true,
    speedHold: true,
    speed: true,
    headingHold: true,
    heading: true,
    altitudeHold: true,
    altitude: true,
    verticalSpeedHold: true,
    verticalSpeed: true,
    flightLevelChange: true,
    loc: true,
    app: true,
  }),
  autopilotPulse: Object.freeze({
    autothrottle: false,
    verticalSpeedHold: false,
    altitudeHold: false,
    machHold: false,
    headingHold: false,
    flightDirector: false,
    apMaster: false,
    apDisconnect: false,
    app: false,
    loc: false,
    nav1: false,
    ins: false,
    backcourse: false,
  }),
});

const DEFAULT_AIRCRAFT_COMMAND_CATALOGUE = Object.freeze({
  configurationId: '',
  profileKey: '',
  profileRevision: null,
  commands: Object.freeze({}),
  inventory: Object.freeze([]),
});

const DEFAULT_AIRCRAFT_INTEGRATION = Object.freeze({
  id: '',
  family: '',
  vendor: '',
  templateId: '',
  fields: Object.freeze([]),
  actions: Object.freeze([]),
});

const SAFE_COMMAND_ID_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

function copyAircraftCommandCatalogue(rawCatalogue) {
  if (!rawCatalogue || typeof rawCatalogue !== 'object' || Array.isArray(rawCatalogue)) {
    return cloneDefaults(DEFAULT_AIRCRAFT_COMMAND_CATALOGUE);
  }
  const commands = {};
  for (const descriptor of Array.isArray(rawCatalogue.commands) ? rawCatalogue.commands : []) {
    const id = typeof descriptor?.id === 'string' ? descriptor.id.trim() : '';
    if (!id || id.length > 120 || !SAFE_COMMAND_ID_RE.test(id)) continue;
    commands[id] = Object.freeze({
      id,
      label: typeof descriptor.label === 'string' ? descriptor.label.slice(0, 100) : id,
      group: typeof descriptor.group === 'string' ? descriptor.group.slice(0, 64) : '',
      kind: descriptor.kind === 'preset' ? 'preset' : 'action',
      description: typeof descriptor.description === 'string'
        ? descriptor.description.slice(0, 320)
        : '',
      input: descriptor.input && typeof descriptor.input === 'object'
        ? Object.freeze({ ...descriptor.input })
        : Object.freeze({ kind: 'none' }),
      ...(descriptor.speech && typeof descriptor.speech === 'object'
        ? { speech: Object.freeze({ ...descriptor.speech }) }
        : {}),
    });
  }
  const inventory = [];
  for (const descriptor of Array.isArray(rawCatalogue.inventory) ? rawCatalogue.inventory : []) {
    const id = typeof descriptor?.id === 'string' ? descriptor.id.trim() : '';
    if (!id || id.length > 120 || !SAFE_COMMAND_ID_RE.test(id)) continue;
    inventory.push(Object.freeze({
      id,
      label: typeof descriptor.label === 'string' ? descriptor.label.slice(0, 100) : id,
      group: typeof descriptor.group === 'string' ? descriptor.group.slice(0, 64) : '',
      kind: descriptor.kind === 'preset' ? 'preset' : 'action',
      description: typeof descriptor.description === 'string'
        ? descriptor.description.slice(0, 320)
        : '',
      input: descriptor.input && typeof descriptor.input === 'object'
        ? Object.freeze({ ...descriptor.input })
        : Object.freeze({ kind: 'none' }),
      supported: descriptor.supported === true,
      actionIds: Object.freeze((Array.isArray(descriptor.actionIds) ? descriptor.actionIds : [])
        .filter((actionId) => (
          typeof actionId === 'string'
          && actionId.length <= 120
          && SAFE_COMMAND_ID_RE.test(actionId)
        ))
        .slice(0, 128)),
      ...(descriptor.speech && typeof descriptor.speech === 'object'
        ? { speech: Object.freeze({ ...descriptor.speech }) }
        : {}),
    }));
  }
  return {
    configurationId: typeof rawCatalogue.configurationId === 'string'
      ? rawCatalogue.configurationId.slice(0, 64)
      : '',
    profileKey: typeof rawCatalogue.profileKey === 'string'
      ? rawCatalogue.profileKey.slice(0, 180)
      : '',
    profileRevision: Number.isSafeInteger(rawCatalogue.profileRevision)
      ? rawCatalogue.profileRevision
      : null,
    commands,
    inventory,
  };
}

function copyAircraftIntegration(rawIntegration) {
  if (!rawIntegration || typeof rawIntegration !== 'object' || Array.isArray(rawIntegration)) {
    return cloneDefaults(DEFAULT_AIRCRAFT_INTEGRATION);
  }
  const copyId = (value, maxLength = 120) => (
    typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
  );
  const fields = (Array.isArray(rawIntegration.fields) ? rawIntegration.fields : [])
    .map((field) => {
      const id = copyId(field?.id);
      return id && SAFE_COMMAND_ID_RE.test(id) ? Object.freeze({ id }) : null;
    })
    .filter(Boolean)
    .slice(0, 512);
  const actions = (Array.isArray(rawIntegration.actions) ? rawIntegration.actions : [])
    .map((action) => {
      const id = copyId(action?.id);
      if (!id || !SAFE_COMMAND_ID_RE.test(id)) return null;
      return Object.freeze({
        id,
        supported: action.supported === true,
        verification: ['verified', 'partial', 'untested'].includes(action.verification)
          ? action.verification
          : 'untested',
        ...(action.input && typeof action.input === 'object'
          ? { input: Object.freeze({ ...action.input }) }
          : {}),
      });
    })
    .filter(Boolean)
    .slice(0, 512);
  return {
    id: copyId(rawIntegration.id, 64),
    family: copyId(rawIntegration.family, 120),
    vendor: copyId(rawIntegration.vendor, 120),
    templateId: copyId(rawIntegration.templateId, 120),
    fields,
    actions,
  };
}

const DEFAULT_AUTOPILOT = Object.freeze({
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
  spdDisplay: '---',
  hdgDisplay: '---',
  altDisplay: '-----',
  vsDisplay: '----',
});

const DEFAULT_AUTOPILOT_READBACK = Object.freeze({
  apReliable: null,
  athrReliable: null,
});

const CONTROL_CAPABILITY_TARGETS = Object.freeze({
  gearUp: Object.freeze({ group: 'surface', key: 'gearUp' }),
  gearDown: Object.freeze({ group: 'surface', key: 'gearDown' }),
  flapsDecrease: Object.freeze({ group: 'surface', key: 'flapsDecrease' }),
  flapsIncrease: Object.freeze({ group: 'surface', key: 'flapsIncrease' }),
  parkingBrakeRelease: Object.freeze({ group: 'surface', key: 'parkingBrake' }),
  parkingBrakeSet: Object.freeze({ group: 'surface', key: 'parkingBrake' }),
  spoilersRetract: Object.freeze({ group: 'surface', key: 'spoilersPosition' }),
  spoilersExtend: Object.freeze({ group: 'surface', key: 'spoilersPosition' }),
  spoilersDisarm: Object.freeze({ group: 'surface', key: 'spoilersArm' }),
  spoilersArm: Object.freeze({ group: 'surface', key: 'spoilersArm' }),
  autopilotMasterToggle: Object.freeze({ group: 'autopilot', key: 'master' }),
  autothrottleToggle: Object.freeze({ group: 'autopilot', key: 'autothrottle' }),
  flightDirectorToggle: Object.freeze({ group: 'autopilot', key: 'flightDirector' }),
  flcToggle: Object.freeze({ group: 'autopilot', key: 'flightLevelChange' }),
  locToggle: Object.freeze({ group: 'autopilot', key: 'loc' }),
  appToggle: Object.freeze({ group: 'autopilot', key: 'app' }),
});

const SELECTOR_HOLD_CAPABILITY_KEYS = Object.freeze({
  spd: 'speedHold',
  hdg: 'headingHold',
  alt: 'altitudeHold',
  vs: 'verticalSpeedHold',
});

const SELECTOR_ADJUST_CAPABILITY_KEYS = Object.freeze({
  spd: 'speed',
  hdg: 'heading',
  alt: 'altitude',
  vs: 'verticalSpeed',
});

const AUTOPILOT_PULSE_CAPABILITY_KEYS = Object.freeze({
  autothrottle: 'autothrottle',
  verticalSpeedHold: 'verticalSpeedHold',
  altitudeHold: 'altitudeHold',
  machHold: 'machHold',
  headingHold: 'headingHold',
  flightDirector: 'flightDirector',
  apMaster: 'apMaster',
  apDisconnect: 'apDisconnect',
  app: 'app',
  loc: 'loc',
  nav1: 'nav1',
  ins: 'ins',
  backcourse: 'backcourse',
});

function cloneDefaults(defaults) {
  return JSON.parse(JSON.stringify(defaults));
}

function getDefaultControlCapabilities() {
  return cloneDefaults(DEFAULT_CONTROL_CAPABILITIES);
}

function getDisabledControlCapabilities() {
  const disabled = getDefaultControlCapabilities();
  for (const group of Object.keys(disabled)) {
    for (const key of Object.keys(disabled[group] || {})) {
      disabled[group][key] = false;
    }
  }
  return disabled;
}

function mergeBooleanCapabilities(defaults, incoming) {
  const next = { ...defaults };
  if (!incoming || typeof incoming !== 'object') return next;
  for (const key of Object.keys(defaults)) {
    if (typeof incoming[key] === 'boolean') {
      next[key] = incoming[key];
    }
  }
  return next;
}

function getCommandCapabilityTarget(commandOrKey) {
  if (!commandOrKey) return null;

  if (typeof commandOrKey === 'string') {
    if (commandOrKey.startsWith('control:')) {
      return CONTROL_CAPABILITY_TARGETS[commandOrKey.slice('control:'.length)] || null;
    }
    if (commandOrKey.startsWith('selector-hold:')) {
      const key = SELECTOR_HOLD_CAPABILITY_KEYS[commandOrKey.slice('selector-hold:'.length)];
      return key ? { group: 'autopilot', key } : null;
    }
    if (commandOrKey.startsWith('selector-adjust:')) {
      const [, mode] = commandOrKey.split(':');
      const key = SELECTOR_ADJUST_CAPABILITY_KEYS[mode];
      return key ? { group: 'autopilot', key } : null;
    }
    if (commandOrKey.startsWith('selector-set:')) {
      const key = SELECTOR_ADJUST_CAPABILITY_KEYS[commandOrKey.slice('selector-set:'.length)];
      return key ? { group: 'autopilot', key } : null;
    }
    if (commandOrKey.startsWith('autopilot-pulse:')) {
      const key = AUTOPILOT_PULSE_CAPABILITY_KEYS[commandOrKey.slice('autopilot-pulse:'.length)];
      return key ? { group: 'autopilotPulse', key } : null;
    }
    if (commandOrKey.startsWith('light-set:')) {
      const key = commandOrKey.slice('light-set:'.length);
      return Object.prototype.hasOwnProperty.call(DEFAULT_CONTROL_CAPABILITIES.lights, key)
        ? { group: 'lights', key }
        : null;
    }
    return null;
  }

  if (commandOrKey.type === 'control') {
    return CONTROL_CAPABILITY_TARGETS[commandOrKey.id] || null;
  }
  if (commandOrKey.type === 'selector-hold') {
    const key = SELECTOR_HOLD_CAPABILITY_KEYS[commandOrKey.mode];
    return key ? { group: 'autopilot', key } : null;
  }
  if (commandOrKey.type === 'selector-adjust') {
    const key = SELECTOR_ADJUST_CAPABILITY_KEYS[commandOrKey.mode];
    return key ? { group: 'autopilot', key } : null;
  }
  if (commandOrKey.type === 'selector-set') {
    const key = SELECTOR_ADJUST_CAPABILITY_KEYS[commandOrKey.mode];
    return key ? { group: 'autopilot', key } : null;
  }
  if (commandOrKey.type === 'autopilot-pulse') {
    const key = AUTOPILOT_PULSE_CAPABILITY_KEYS[commandOrKey.id];
    return key ? { group: 'autopilotPulse', key } : null;
  }
  if (commandOrKey.type === 'light-set') {
    const key = typeof commandOrKey.light === 'string' ? commandOrKey.light.trim() : '';
    return Object.prototype.hasOwnProperty.call(DEFAULT_CONTROL_CAPABILITIES.lights, key)
      ? { group: 'lights', key }
      : null;
  }
  return null;
}

function formatHeadingValue(value) {
  const numericValue = toFiniteNumber(value);
  return numericValue == null ? '---' : String(Math.round(numericValue)).padStart(3, '0');
}

function formatAltitudeValue(value) {
  const numericValue = toFiniteNumber(value);
  return numericValue == null ? '-----' : Math.round(numericValue).toLocaleString();
}

function formatVerticalSpeedValue(value) {
  if (value == null) return '----';
  const numericValue = toFiniteNumber(value);
  if (numericValue == null) return '----';
  const rounded = Math.round(numericValue);
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

function formatSpeedValue(value) {
  const numericValue = toFiniteNumber(value);
  return numericValue == null ? '---' : String(Math.round(numericValue));
}

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

export const useAircraftControlsStore = defineStore('aircraftControls', {
  state: () => ({
    availability: cloneDefaults(DEFAULT_AVAILABILITY),
    feedback: cloneDefaults(DEFAULT_FEEDBACK),
    controlCapabilities: getDefaultControlCapabilities(),
    aircraftCommandCatalogue: cloneDefaults(DEFAULT_AIRCRAFT_COMMAND_CATALOGUE),
    aircraftIntegration: cloneDefaults(DEFAULT_AIRCRAFT_INTEGRATION),
    autopilot: cloneDefaults(DEFAULT_AUTOPILOT),
    autopilotReadback: cloneDefaults(DEFAULT_AUTOPILOT_READBACK),
    navRadios: copyNavRadioReadback(null),
    navRadiosReceivedAt: null,
    pendingCommands: {},
    _onControlCommand: null,
    commandActionBound: false,
  }),

  actions: {
    setAvailability({ enabled = false, reason = DEFAULT_AVAILABILITY.reason } = {}) {
      this.availability.enabled = enabled === true;
      this.availability.reason = typeof reason === 'string' && reason.trim()
        ? reason.trim()
        : DEFAULT_AVAILABILITY.reason;
    },

    setFeedback({ actionText, routeText, profileText, status, commandKey } = {}) {
      if (typeof actionText === 'string') this.feedback.actionText = actionText;
      if (typeof routeText === 'string') this.feedback.routeText = routeText;
      if (typeof profileText === 'string') this.feedback.profileText = profileText;
      if (['idle', 'sending', 'sent', 'failed'].includes(status)) this.feedback.status = status;
      if (typeof commandKey === 'string') this.feedback.commandKey = commandKey.trim();
    },

    resetFeedback() {
      this.feedback = cloneDefaults(DEFAULT_FEEDBACK);
    },

    applyControlCapabilities(capabilities = {}) {
      const defaults = getDefaultControlCapabilities();
      const incomingSurface = capabilities?.surface;
      const incomingLights = capabilities?.lights;
      const incomingAutopilot = capabilities?.autopilot;
      const incomingAutopilotPulse = capabilities?.autopilotPulse;
      this.controlCapabilities = {
        ...defaults,
        surface: mergeBooleanCapabilities(defaults.surface, incomingSurface),
        lights: mergeBooleanCapabilities(defaults.lights, incomingLights),
        autopilot: mergeBooleanCapabilities(defaults.autopilot, incomingAutopilot),
        autopilotPulse: mergeBooleanCapabilities(defaults.autopilotPulse, incomingAutopilotPulse),
      };
      const catalogue = copyAircraftCommandCatalogue(capabilities?.aircraftCommands);
      if (catalogue.profileKey !== this.aircraftCommandCatalogue.profileKey
        || catalogue.profileRevision !== this.aircraftCommandCatalogue.profileRevision) this.resetNavRadios();
      this.aircraftCommandCatalogue = catalogue;
      this.aircraftIntegration = copyAircraftIntegration(capabilities?.aircraftIntegration);
    },

    resetControlCapabilities() {
      this.resetNavRadios();
      this.controlCapabilities = getDefaultControlCapabilities();
      this.aircraftCommandCatalogue = cloneDefaults(DEFAULT_AIRCRAFT_COMMAND_CATALOGUE);
      this.aircraftIntegration = cloneDefaults(DEFAULT_AIRCRAFT_INTEGRATION);
    },

    prepareForAircraftChange(reason = 'Aircraft changed. Waiting for profile capabilities.') {
      this.resetNavRadios();
      this.resetFeedback();
      this.resetPendingCommands();
      this.controlCapabilities = getDisabledControlCapabilities();
      this.aircraftCommandCatalogue = cloneDefaults(DEFAULT_AIRCRAFT_COMMAND_CATALOGUE);
      this.aircraftIntegration = cloneDefaults(DEFAULT_AIRCRAFT_INTEGRATION);
      this.feedback.routeText = typeof reason === 'string' && reason.trim()
        ? reason.trim()
        : 'Aircraft changed. Waiting for profile capabilities.';
      this.feedback.profileText = 'Detecting active profile...';
    },

    resolvePendingKey(commandOrKey) {
      if (typeof commandOrKey === 'string' && commandOrKey.trim()) {
        return commandOrKey.trim();
      }
      return getAircraftControlCommandPendingKey(commandOrKey);
    },

    setCommandPending(commandOrKey) {
      const pendingKey = this.resolvePendingKey(commandOrKey);
      if (!pendingKey || this.pendingCommands[pendingKey] === true) return false;
      this.pendingCommands = {
        ...this.pendingCommands,
        [pendingKey]: true,
      };
      return true;
    },

    clearCommandPending(commandOrKey) {
      const pendingKey = this.resolvePendingKey(commandOrKey);
      if (!pendingKey || this.pendingCommands[pendingKey] !== true) return false;
      const nextPendingCommands = { ...this.pendingCommands };
      delete nextPendingCommands[pendingKey];
      this.pendingCommands = nextPendingCommands;
      return true;
    },

    resetPendingCommands() {
      this.pendingCommands = {};
    },

    isCommandPending(commandOrKey) {
      const pendingKey = this.resolvePendingKey(commandOrKey);
      return pendingKey ? this.pendingCommands[pendingKey] === true : false;
    },

    isCommandSupported(commandOrKey) {
      const canonicalCommandId = getAircraftControlCanonicalCommandId(commandOrKey);
      if (this.aircraftCommandCatalogue.configurationId && canonicalCommandId) {
        return this.isAircraftCommandSupported(canonicalCommandId);
      }
      const capability = getCommandCapabilityTarget(commandOrKey);
      if (!capability) return true;
      return this.controlCapabilities?.[capability.group]?.[capability.key] !== false;
    },

    isCommandDisabled(commandOrKey) {
      return this.availability.enabled !== true
        || this.isCommandSupported(commandOrKey) !== true
        || this.isCommandPending(commandOrKey);
    },

    bindCommandAction(action = null) {
      this._onControlCommand = typeof action === 'function' ? action : null;
      this.commandActionBound = this._onControlCommand !== null;
    },

    async requestControlCommand(command, options = {}) {
      if (typeof this._onControlCommand !== 'function') return false;
      const result = await this._onControlCommand(command, options);
      return result !== false;
    },

    updateAutopilot(message = {}, currentState = {}) {
      const autopilot = this.autopilot;
      const apReliable = message.apReliable === false ? false : true;
      const athrReliable = message.athrReliable === false ? false : true;
      this.autopilotReadback.apReliable = apReliable;
      this.autopilotReadback.athrReliable = athrReliable;

      if (apReliable) {
        autopilot.master = toNullableBoolean(message.master);
      } else {
        autopilot.master = null;
      }

      autopilot.athrArmed = athrReliable ? toNullableBoolean(message.athrArmed) : null;
      autopilot.athrActive = athrReliable ? toNullableBoolean(message.athrActive) : null;
      autopilot.fdActive = apReliable ? toNullableBoolean(message.fdActive) : null;
      autopilot.spdHold = apReliable ? toNullableBoolean(message.spdHold) : null;
      autopilot.hdgHold = apReliable ? toNullableBoolean(message.hdgHold) : null;
      autopilot.altHold = apReliable ? toNullableBoolean(message.altHold) : null;
      autopilot.vsHold = apReliable ? toNullableBoolean(message.vsHold) : null;
      autopilot.locHold = apReliable ? anyKnownBooleanTrue(message.locHold, message.navHold) : null;
      autopilot.appHold = apReliable ? toNullableBoolean(message.apprHold) : null;
      autopilot.flcHold = apReliable ? toNullableBoolean(message.lvlChgHold) : null;
      autopilot.spdTarget = toFiniteNumber(message.spdTarget);
      autopilot.hdgTarget = toFiniteNumber(message.hdgTarget);
      autopilot.altTarget = toFiniteNumber(message.altTarget);
      autopilot.vsTarget = toFiniteNumber(message.vsTarget);

      autopilot.spdDisplay = formatSpeedValue(autopilot.spdTarget ?? currentState.ias);
      autopilot.hdgDisplay = formatHeadingValue(autopilot.hdgTarget ?? currentState.hdg);
      autopilot.altDisplay = formatAltitudeValue(autopilot.altTarget ?? currentState.alt);
      autopilot.vsDisplay = formatVerticalSpeedValue(autopilot.vsTarget);
    },

    getAircraftCommand(commandId) {
      return typeof commandId === 'string'
        ? this.aircraftCommandCatalogue.commands[commandId] || null
        : null;
    },

    isAircraftCommandSupported(commandId) {
      return this.getAircraftCommand(commandId) !== null;
    },

    resetAutopilot() {
      this.resetNavRadios();
      this.autopilot = cloneDefaults(DEFAULT_AUTOPILOT);
      this.autopilotReadback = cloneDefaults(DEFAULT_AUTOPILOT_READBACK);
    },

    applyNavRadios(data = {}, receivedAt = Date.now()) {
      const catalogue = this.aircraftCommandCatalogue;
      if (!data || !catalogue.profileKey || data.profileKey !== catalogue.profileKey
        || data.profileRevision !== catalogue.profileRevision) return false;
      this.navRadios = copyNavRadioReadback(data.radios);
      this.navRadiosReceivedAt = receivedAt;
      return true;
    },

    resetNavRadios() {
      this.navRadios = copyNavRadioReadback(null);
      this.navRadiosReceivedAt = null;
    },
  },
});
