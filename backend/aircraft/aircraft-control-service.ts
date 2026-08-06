'use strict';

const profileLoader = require('./aircraft-profile-loader.js') as {
  getActiveProfile: () => Record<string, any> | null;
  getActiveProfileRevision?: () => number;
};
const {
  defaultAircraftIntegrationRegistry,
  normalizeAircraftIntegrationActionInput,
} = require('./aircraft-integrations') as {
  defaultAircraftIntegrationRegistry: AircraftIntegrationRegistry;
  normalizeAircraftIntegrationActionInput: (
    action: AircraftIntegrationAction | null | undefined,
    value: unknown,
  ) => Readonly<{ ok: true; value?: number } | { ok: false; error: string }>;
};

type GenericRecord = Record<string, any>;
type NormalizedControlRequest = {
  actionId?: string;
  control: string;
  operation: string;
  profileKey: string | null;
  profileRevision: number | null;
  requestId: string | null;
  target: string;
  value: unknown;
};
type ProviderControlCapabilities = {
  actionTypes?: unknown;
  integrationTransports?: unknown;
  mobiflight?: unknown;
  simulator?: string | null;
};
type AircraftIntegrationAction = Readonly<{
  id: string;
  input?: Readonly<{ max: number; min: number; step: number; type: 'number' }>;
  routes?: readonly Readonly<{ transport?: string }>[];
  verification: 'untested' | 'partial' | 'verified';
}>;
type AircraftIntegrationDefinition = Readonly<{
  actions: Readonly<Record<string, AircraftIntegrationAction>>;
  id: string;
}>;
type AircraftIntegrationRegistry = {
  resolveAction: (context: {
    actionId?: unknown;
    adapterId?: unknown;
    profileKey?: unknown;
  }) => AircraftIntegrationAction | null;
  resolveIntegration: (
    adapterId: unknown,
    context?: { profileKey?: unknown },
  ) => AircraftIntegrationDefinition | null;
  selectActionRoute: (
    context: {
      actionId?: unknown;
      adapterId?: unknown;
      profileKey?: unknown;
    },
    supportedTransports: unknown,
  ) => Record<string, unknown> | null;
};
type ResolveOptions = {
  capabilities?: unknown;
  profile?: GenericRecord | null;
  profileRevision?: unknown;
  requireProfileToken?: boolean;
  requireStableSimState?: boolean;
  simState?: unknown;
};
type AircraftControlProvider = {
  aircraftControlCapabilities?: unknown;
  controlCapabilities?: unknown;
  executeAircraftControlAction?: (action: GenericRecord, options: GenericRecord) => Promise<unknown>;
  getAircraftControlCapabilities?: () => unknown;
};

const GENERIC_MSFS_ACTIONS: Record<string, any> = Object.freeze({
  gear: Object.freeze({
    up: { type: 'key-event', name: 'GEAR_UP' },
    down: { type: 'key-event', name: 'GEAR_DOWN' },
    toggle: { type: 'key-event', name: 'GEAR_TOGGLE' },
  }),
  flaps: Object.freeze({
    increment: { type: 'key-event', name: 'FLAPS_INCR' },
    decrement: { type: 'key-event', name: 'FLAPS_DECR' },
  }),
  spoilers: Object.freeze({
    arm: { type: 'key-event', name: 'SPOILERS_ARM_ON' },
    disarm: { type: 'key-event', name: 'SPOILERS_ARM_OFF' },
  }),
  autobrake: Object.freeze({
    increment: { type: 'key-event', name: 'INCREASE_AUTOBRAKE_CONTROL' },
    decrement: { type: 'key-event', name: 'DECREASE_AUTOBRAKE_CONTROL' },
    set: { type: 'key-event', name: 'SET_AUTOBRAKE_CONTROL' },
  }),
  autopilotActions: Object.freeze({
    masterOn: { type: 'key-event', name: 'AUTOPILOT_ON' },
    masterOff: { type: 'key-event', name: 'AUTOPILOT_OFF' },
    masterToggle: { type: 'key-event', name: 'AP_MASTER' },
    autothrottleToggle: { type: 'key-event', name: 'AUTO_THROTTLE_ARM' },
    flightDirectorToggle: { type: 'key-event', name: 'TOGGLE_FLIGHT_DIRECTOR' },
    speedHoldToggle: { type: 'key-event', name: 'AP_AIRSPEED_HOLD' },
    speedHoldOn: { type: 'key-event', name: 'AP_AIRSPEED_ON' },
    speedHoldOff: { type: 'key-event', name: 'AP_AIRSPEED_OFF' },
    headingHoldToggle: { type: 'key-event', name: 'AP_HDG_HOLD' },
    headingHoldOn: { type: 'key-event', name: 'AP_HDG_HOLD_ON' },
    headingHoldOff: { type: 'key-event', name: 'AP_HDG_HOLD_OFF' },
    altitudeHoldToggle: { type: 'key-event', name: 'AP_ALT_HOLD' },
    altitudeHoldOn: { type: 'key-event', name: 'AP_ALT_HOLD_ON' },
    altitudeHoldOff: { type: 'key-event', name: 'AP_ALT_HOLD_OFF' },
    verticalSpeedHoldToggle: { type: 'key-event', name: 'AP_VS_HOLD' },
    verticalSpeedHoldOn: { type: 'key-event', name: 'AP_VS_ON' },
    verticalSpeedHoldOff: { type: 'key-event', name: 'AP_VS_OFF' },
    locToggle: { type: 'key-event', name: 'AP_LOC_HOLD' },
    locOn: { type: 'key-event', name: 'AP_LOC_HOLD_ON' },
    locOff: { type: 'key-event', name: 'AP_LOC_HOLD_OFF' },
    appToggle: { type: 'key-event', name: 'AP_APR_HOLD' },
    appOn: { type: 'key-event', name: 'AP_APR_HOLD_ON' },
    appOff: { type: 'key-event', name: 'AP_APR_HOLD_OFF' },
    machHoldToggle: { type: 'key-event', name: 'AP_MACH_HOLD' },
    nav1Toggle: { type: 'key-event', name: 'AP_NAV1_HOLD' },
    backcourseToggle: { type: 'key-event', name: 'AP_BC_HOLD' },
    flightLevelChangeOn: { type: 'key-event', name: 'FLIGHT_LEVEL_CHANGE_ON' },
    flightLevelChangeOff: { type: 'key-event', name: 'FLIGHT_LEVEL_CHANGE_OFF' },
  }),
  autopilotSelectors: Object.freeze({
    speedSet: { type: 'key-event', name: 'AP_SPD_VAR_SET' },
    headingSet: { type: 'key-event', name: 'HEADING_BUG_SET' },
    altitudeSet: { type: 'key-event', name: 'AP_ALT_VAR_SET_ENGLISH' },
    verticalSpeedSet: { type: 'key-event', name: 'AP_VS_VAR_SET_ENGLISH' },
  }),
});

const AUTOPILOT_ACTION_KEYS: Record<string, { setFalse?: string; setTrue?: string; toggle?: string }> = Object.freeze({
  master: Object.freeze({
    setTrue: 'masterOn',
    setFalse: 'masterOff',
    toggle: 'masterToggle',
  }),
  autothrottle: Object.freeze({
    toggle: 'autothrottleToggle',
  }),
  flightDirector: Object.freeze({
    toggle: 'flightDirectorToggle',
  }),
  speedHold: Object.freeze({
    toggle: 'speedHoldToggle',
    setTrue: 'speedHoldOn',
    setFalse: 'speedHoldOff',
  }),
  headingHold: Object.freeze({
    toggle: 'headingHoldToggle',
    setTrue: 'headingHoldOn',
    setFalse: 'headingHoldOff',
  }),
  altitudeHold: Object.freeze({
    toggle: 'altitudeHoldToggle',
    setTrue: 'altitudeHoldOn',
    setFalse: 'altitudeHoldOff',
  }),
  verticalSpeedHold: Object.freeze({
    toggle: 'verticalSpeedHoldToggle',
    setTrue: 'verticalSpeedHoldOn',
    setFalse: 'verticalSpeedHoldOff',
  }),
  loc: Object.freeze({
    toggle: 'locToggle',
    setTrue: 'locOn',
    setFalse: 'locOff',
  }),
  app: Object.freeze({
    toggle: 'appToggle',
    setTrue: 'appOn',
    setFalse: 'appOff',
  }),
  machHold: Object.freeze({
    toggle: 'machHoldToggle',
  }),
  nav1: Object.freeze({
    toggle: 'nav1Toggle',
  }),
  backcourse: Object.freeze({
    toggle: 'backcourseToggle',
  }),
  yawDamper: Object.freeze({
    toggle: 'yawDamperToggle',
  }),
  flightLevelChange: Object.freeze({
    setTrue: 'flightLevelChangeOn',
    setFalse: 'flightLevelChangeOff',
  }),
});

const AUTOPILOT_SELECTOR_KEYS: Record<string, string> = Object.freeze({
  speed: 'speedSet',
  heading: 'headingSet',
  altitude: 'altitudeSet',
  verticalSpeed: 'verticalSpeedSet',
});

const AUTOPILOT_SELECTOR_RANGES: Record<string, { max: number; min: number }> = Object.freeze({
  speed: Object.freeze({ min: 0, max: 999 }),
  heading: Object.freeze({ min: 0, max: 360 }),
  altitude: Object.freeze({ min: 0, max: 60000 }),
  verticalSpeed: Object.freeze({ min: -9900, max: 9900 }),
});

const UI_AUTOPILOT_CAPABILITY_REQUESTS: Record<string, GenericRecord | readonly GenericRecord[]> = Object.freeze({
  master: Object.freeze({ control: 'autopilot', target: 'master', operation: 'toggle' }),
  autothrottle: Object.freeze({ control: 'autopilot', target: 'autothrottle', operation: 'toggle' }),
  flightDirector: Object.freeze({ control: 'autopilot', target: 'flightDirector', operation: 'toggle' }),
  speedHold: Object.freeze([
    Object.freeze({ control: 'autopilot', target: 'speedHold', operation: 'set', value: true }),
    Object.freeze({ control: 'autopilot', target: 'speedHold', operation: 'set', value: false }),
  ]),
  speed: Object.freeze({ control: 'autopilot', target: 'speed', operation: 'set', value: 250 }),
  headingHold: Object.freeze([
    Object.freeze({ control: 'autopilot', target: 'headingHold', operation: 'set', value: true }),
    Object.freeze({ control: 'autopilot', target: 'headingHold', operation: 'set', value: false }),
  ]),
  heading: Object.freeze({ control: 'autopilot', target: 'heading', operation: 'set', value: 180 }),
  altitudeHold: Object.freeze([
    Object.freeze({ control: 'autopilot', target: 'altitudeHold', operation: 'set', value: true }),
    Object.freeze({ control: 'autopilot', target: 'altitudeHold', operation: 'set', value: false }),
  ]),
  altitude: Object.freeze({ control: 'autopilot', target: 'altitude', operation: 'set', value: 10000 }),
  verticalSpeedHold: Object.freeze([
    Object.freeze({ control: 'autopilot', target: 'verticalSpeedHold', operation: 'set', value: true }),
    Object.freeze({ control: 'autopilot', target: 'verticalSpeedHold', operation: 'set', value: false }),
  ]),
  verticalSpeed: Object.freeze({ control: 'autopilot', target: 'verticalSpeed', operation: 'set', value: 0 }),
  flightLevelChange: Object.freeze([
    Object.freeze({ control: 'autopilot', target: 'flightLevelChange', operation: 'set', value: true }),
    Object.freeze({ control: 'autopilot', target: 'flightLevelChange', operation: 'set', value: false }),
  ]),
  loc: Object.freeze([
    Object.freeze({ control: 'autopilot', target: 'loc', operation: 'set', value: true }),
    Object.freeze({ control: 'autopilot', target: 'loc', operation: 'set', value: false }),
  ]),
  app: Object.freeze([
    Object.freeze({ control: 'autopilot', target: 'app', operation: 'set', value: true }),
    Object.freeze({ control: 'autopilot', target: 'app', operation: 'set', value: false }),
  ]),
});

const UI_SURFACE_CAPABILITY_REQUESTS: Record<string, GenericRecord | readonly GenericRecord[]> = Object.freeze({
  gearUp: Object.freeze({ control: 'gear', operation: 'up' }),
  gearDown: Object.freeze({ control: 'gear', operation: 'down' }),
  flapsDecrease: Object.freeze({ control: 'flaps', operation: 'decrement' }),
  flapsIncrease: Object.freeze({ control: 'flaps', operation: 'increment' }),
});

const STANDARD_MSFS_SURFACE_FALLBACKS: Record<string, Set<string>> = Object.freeze({
  gear: new Set(['up', 'down', 'toggle']),
  flaps: new Set(['increment', 'decrement']),
});

const ALLOWED_ACTION_TYPES = new Set<string>([
  'key-event',
  'input-event',
  'html-event',
  'lvar',
  'simvar',
  'aircraft-integration',
  'command',
  'dataref',
]);

const ALLOWED_ACTION_FIELDS = new Set<string>([
  'type',
  'name',
  'unit',
  'value',
  'parameters',
  'valueType',
  'verification',
]);
const ALLOWED_VERIFICATION_VALUES = new Set<string>(['untested', 'partial', 'verified']);
const ALLOWED_XPLANE_VALUE_TYPES = new Set<string>([
  'float',
  'double',
  'int',
  'int_array',
  'float_array',
  'data',
]);
const MAX_ACTION_NAME_LENGTH = 160;
const MAX_ACTION_UNIT_LENGTH = 48;
const MAX_ACTION_PARAMETERS = 8;
const MAX_STRING_ARGUMENT_LENGTH = 120;
const MAX_NUMERIC_ARGUMENT_ABS = 1_000_000;
const MAX_PROFILE_KEY_LENGTH = 180;
const MAX_AIRCRAFT_SPECIFIC_ACTION_ID_LENGTH = 96;
const SAFE_ACTION_NAME_RE = /^[A-Za-z0-9 _./:#+%()-]+$/;
const SAFE_AIRCRAFT_SPECIFIC_ACTION_ID_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const SAFE_UNIT_RE = /^[A-Za-z0-9 _./:+%()-]+$/;
const SAFE_STRING_ARGUMENT_RE = /^[A-Za-z0-9 _./:+%()-]+$/;
const SAFE_PROFILE_KEY_RE = /^[A-Za-z0-9 _./:#+%()-]+$/;

function cloneAction(action: unknown): GenericRecord | null {
  return action && typeof action === 'object' ? { ...(action as GenericRecord) } : null;
}

function cloneActionCandidates(actionOrActions: unknown): GenericRecord[] {
  if (Array.isArray(actionOrActions)) {
    return actionOrActions
      .map((action) => cloneAction(action))
      .filter((action): action is GenericRecord => !!action);
  }

  const action = cloneAction(actionOrActions);
  return action ? [action] : [];
}

function isFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && Number.isFinite(Number(trimmed));
  }
  return false;
}

function isSafeTokenString(value: string, maxLength: number, pattern: RegExp): boolean {
  return value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
}

function normalizeSafeControlArgument(value: unknown): { ok: boolean; value?: boolean | number | string } {
  if (typeof value === 'boolean') {
    return { ok: true, value };
  }

  if (typeof value === 'number') {
    return {
      ok: Number.isFinite(value) && Math.abs(value) <= MAX_NUMERIC_ARGUMENT_ABS,
      value,
    };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return {
      ok: isSafeTokenString(trimmed, MAX_STRING_ARGUMENT_LENGTH, SAFE_STRING_ARGUMENT_RE),
      value: trimmed,
    };
  }

  return { ok: false };
}

function pruneActionFields(action: GenericRecord): void {
  for (const key of Object.keys(action)) {
    if (!ALLOWED_ACTION_FIELDS.has(key)) {
      delete action[key];
    }
  }
}

function normalizeBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return null;
}

function normalizeProfileKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!isSafeTokenString(trimmed, MAX_PROFILE_KEY_LENGTH, SAFE_PROFILE_KEY_RE)) return null;
  return trimmed;
}

function normalizeProfileRevision(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numericValue = Number(value);
  if (!Number.isSafeInteger(numericValue) || numericValue < 0) return null;
  return numericValue;
}

function normalizeControlRequest(rawRequest: unknown): NormalizedControlRequest | null {
  if (!rawRequest || typeof rawRequest !== 'object') return null;

  const request = rawRequest as GenericRecord;
  const control = typeof request.control === 'string' ? request.control.trim() : '';
  const operation = typeof request.operation === 'string' ? request.operation.trim() : '';
  const target = typeof request.target === 'string' ? request.target.trim() : '';
  if (!control || !operation) return null;

  const explicitActionId = typeof request.actionId === 'string' ? request.actionId.trim() : '';
  if (explicitActionId && target && explicitActionId !== target) return null;
  const actionId = explicitActionId || (control === 'aircraft-specific' ? target : '');
  if (control === 'aircraft-specific') {
    if (operation !== 'execute') return null;
    if (!isSafeTokenString(
      actionId,
      MAX_AIRCRAFT_SPECIFIC_ACTION_ID_LENGTH,
      SAFE_AIRCRAFT_SPECIFIC_ACTION_ID_RE,
    )) return null;
    if (
      request.value !== undefined
      && (
        (typeof request.value !== 'number' || !Number.isFinite(request.value))
        && typeof request.value !== 'string'
        && typeof request.value !== 'boolean'
      )
    ) return null;
  }

  return {
    ...(control === 'aircraft-specific' ? { actionId } : {}),
    control,
    operation,
    profileKey: normalizeProfileKey(
      request.profileKey !== undefined ? request.profileKey : request.expectedProfileKey,
    ),
    profileRevision: normalizeProfileRevision(
      request.profileRevision !== undefined ? request.profileRevision : request.expectedProfileRevision,
    ),
    target: control === 'aircraft-specific' ? actionId : target,
    value: request.value,
    requestId: request.requestId || null,
  };
}

function resolveCurrentProfileRevision(options: ResolveOptions): number | null {
  const optionRevision = normalizeProfileRevision(options.profileRevision);
  if (optionRevision != null) return optionRevision;
  if (typeof profileLoader.getActiveProfileRevision === 'function') {
    return normalizeProfileRevision(profileLoader.getActiveProfileRevision());
  }
  return null;
}

function validateProfileToken(
  request: NormalizedControlRequest,
  profileKey: string,
  profileRevision: number | null,
  requireProfileToken: boolean,
): { code: string; error: string } | null {
  const hasAnyToken = request.profileKey != null || request.profileRevision != null;
  if (!requireProfileToken && !hasAnyToken) return null;

  if (!request.profileKey || request.profileRevision == null) {
    return {
      code: 'profile_token_required',
      error: 'Aircraft control writes require the current aircraft profile token.',
    };
  }

  if (request.profileKey !== profileKey) {
    return {
      code: 'stale_profile',
      error: 'Aircraft profile changed before this control request could be executed.',
    };
  }

  if (profileRevision != null && request.profileRevision !== profileRevision) {
    return {
      code: 'stale_profile',
      error: 'Aircraft profile changed before this control request could be executed.',
    };
  }

  return null;
}

function validateSimState(options: ResolveOptions): { code: string; error: string } | null {
  if (options.requireStableSimState !== true && !options.simState) return null;

  const state = options.simState && typeof options.simState === 'object'
    ? options.simState as GenericRecord
    : null;
  if (!state) {
    return {
      code: 'sim_state_unavailable',
      error: 'Simulator state is not ready for aircraft control writes.',
    };
  }

  if (state.simconnectConnected !== true) {
    return {
      code: 'sim_disconnected',
      error: 'Simulator telemetry is disconnected; aircraft control writes are blocked.',
    };
  }

  if (state.inMenu === true) {
    return {
      code: 'sim_state_blocked',
      error: 'Simulator is in a menu or loading state; aircraft control writes are blocked.',
    };
  }

  const lifecycleState = typeof state.lifecycleState === 'string'
    ? state.lifecycleState.trim().toLowerCase()
    : '';
  if (['crashed', 'loading', 'shutting_down', 'shutting-down'].includes(lifecycleState)) {
    return {
      code: 'sim_state_blocked',
      error: 'Simulator lifecycle state is not safe for aircraft control writes.',
    };
  }

  return null;
}

function applyActionValue(baseAction: unknown, nextValue: unknown): GenericRecord | null {
  const action = cloneAction(baseAction);
  if (!action) return null;
  if (nextValue !== undefined) {
    action.value = nextValue;
  }
  return action;
}

function applyActionValueCandidates(actionOrActions: unknown, nextValue: unknown): GenericRecord[] {
  return cloneActionCandidates(actionOrActions)
    .map((action) => applyActionValue(action, nextValue))
    .filter((action): action is GenericRecord => !!action);
}

function resolveMappedNumericValue(rawMapping: unknown, requestedValue: unknown): unknown {
  if (!rawMapping || typeof rawMapping !== 'object') return requestedValue;
  const exactKey = String(requestedValue);
  if (Object.prototype.hasOwnProperty.call(rawMapping, exactKey)) {
    return (rawMapping as GenericRecord)[exactKey];
  }
  return requestedValue;
}

function normalizeSupportedActionTypes(rawCapabilities: unknown): Set<string> | null {
  if (!rawCapabilities) return null;

  let rawActionTypes: unknown = rawCapabilities;
  if (!Array.isArray(rawCapabilities) && !(rawCapabilities instanceof Set)) {
    if (typeof rawCapabilities !== 'object') return null;
    const capabilities = rawCapabilities as ProviderControlCapabilities & GenericRecord;
    rawActionTypes = capabilities.actionTypes || capabilities.supportedActionTypes || capabilities.actions;
  }

  if (rawActionTypes instanceof Set) {
    rawActionTypes = Array.from(rawActionTypes);
  }
  if (!Array.isArray(rawActionTypes)) return null;

  const supportedActionTypes = new Set<string>();
  for (const actionType of rawActionTypes) {
    if (typeof actionType === 'string' && actionType.trim()) {
      supportedActionTypes.add(actionType.trim());
    }
  }
  return supportedActionTypes;
}

function normalizeSupportedIntegrationTransports(rawCapabilities: unknown): string[] {
  if (!rawCapabilities || typeof rawCapabilities !== 'object' || Array.isArray(rawCapabilities)) {
    return [];
  }

  let rawTransports = (rawCapabilities as ProviderControlCapabilities & GenericRecord).integrationTransports;
  if (rawTransports instanceof Set) {
    rawTransports = Array.from(rawTransports);
  }
  if (Array.isArray(rawTransports)) {
    return rawTransports
      .filter((transport): transport is string => typeof transport === 'string')
      .map((transport) => transport.trim())
      .filter(Boolean);
  }
  if (rawTransports && typeof rawTransports === 'object') {
    return Object.entries(rawTransports as GenericRecord)
      .filter(([, supported]) => supported === true)
      .map(([transport]) => transport.trim())
      .filter(Boolean);
  }
  return [];
}

function getProviderAircraftControlCapabilities(provider: AircraftControlProvider | null | undefined): unknown {
  if (!provider || typeof provider !== 'object') return null;
  if (typeof provider.getAircraftControlCapabilities === 'function') {
    return provider.getAircraftControlCapabilities();
  }
  return provider.aircraftControlCapabilities || provider.controlCapabilities || null;
}

function resolveProfileSurfaceActions(profileControls: unknown, request: NormalizedControlRequest): GenericRecord[] {
  if (!profileControls || typeof profileControls !== 'object') return [];

  const controls = profileControls as GenericRecord;
  switch (request.control) {
    case 'gear': {
      const gear = controls.gear;
      if (!gear || typeof gear !== 'object') return [];
      if (request.operation === 'up') return cloneActionCandidates(gear.upAction);
      if (request.operation === 'down') return cloneActionCandidates(gear.downAction);
      if (request.operation === 'toggle') return cloneActionCandidates(gear.toggleAction);
      return [];
    }
    case 'flaps': {
      const flaps = controls.flaps;
      if (!flaps || typeof flaps !== 'object') return [];
      if (request.operation === 'increment') return cloneActionCandidates(flaps.incrementAction);
      if (request.operation === 'decrement') return cloneActionCandidates(flaps.decrementAction);
      if (request.operation === 'set') {
        const mappedValue = resolveMappedNumericValue(flaps.notchMapping, request.value);
        return applyActionValueCandidates(flaps.setAction, mappedValue);
      }
      return [];
    }
    case 'spoilers': {
      const spoilers = controls.spoilers;
      if (!spoilers || typeof spoilers !== 'object') return [];
      if (request.operation === 'arm') return cloneActionCandidates(spoilers.armAction);
      if (request.operation === 'disarm') return cloneActionCandidates(spoilers.disarmAction);
      if (request.operation === 'set') return applyActionValueCandidates(spoilers.setAction, request.value);
      return [];
    }
    case 'autobrake': {
      const autobrake = controls.autobrake;
      if (!autobrake || typeof autobrake !== 'object') return [];
      if (request.operation === 'increment') return cloneActionCandidates(autobrake.incrementAction);
      if (request.operation === 'decrement') return cloneActionCandidates(autobrake.decrementAction);
      if (request.operation === 'set') {
        const mappedValue = resolveMappedNumericValue(autobrake.modeMapping, request.value);
        return applyActionValueCandidates(autobrake.setAction, mappedValue);
      }
      return [];
    }
    default:
      return [];
  }
}

function resolveProfileAutopilotActions(profileControls: unknown, request: NormalizedControlRequest): GenericRecord[] {
  const autopilot = profileControls && (profileControls as GenericRecord).autopilot;
  if (!autopilot || typeof autopilot !== 'object') return [];

  const actions = autopilot.actions && typeof autopilot.actions === 'object'
    ? autopilot.actions
    : {};
  const selectorActions = autopilot.selectorActions && typeof autopilot.selectorActions === 'object'
    ? autopilot.selectorActions
    : {};

  const selectorKey = AUTOPILOT_SELECTOR_KEYS[request.target];
  if (request.operation === 'set' && selectorKey) {
    return applyActionValueCandidates(selectorActions[selectorKey], request.value);
  }

  const targetMap = AUTOPILOT_ACTION_KEYS[request.target];
  if (!targetMap) return [];

  if (request.operation === 'toggle' && targetMap.toggle) {
    return cloneActionCandidates(actions[targetMap.toggle]);
  }

  if (request.operation === 'set') {
    const normalizedValue = normalizeBoolean(request.value);
    if (normalizedValue === true && targetMap.setTrue) {
      return cloneActionCandidates(actions[targetMap.setTrue]);
    }
    if (normalizedValue === false && targetMap.setFalse) {
      return cloneActionCandidates(actions[targetMap.setFalse]);
    }
  }

  return [];
}

function getProfileKey(profile: unknown): string {
  const profileRecord = profile && typeof profile === 'object'
    ? profile as GenericRecord
    : null;
  const rawProfileKey = profileRecord?._profileKey
    || profileRecord?._qualifiedId
    || profileRecord?.id
    || 'generic';
  return String(rawProfileKey);
}

function getDeclaredAircraftIntegrationAdapterId(profile: unknown): string | null {
  const aircraftSpecific = profile
    && (profile as GenericRecord).integration
    && (profile as GenericRecord).integration.aircraftSpecific;
  if (!aircraftSpecific || typeof aircraftSpecific !== 'object' || Array.isArray(aircraftSpecific)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(aircraftSpecific, 'adapter')) return null;
  return typeof aircraftSpecific.adapter === 'string'
    ? aircraftSpecific.adapter.trim()
    : '';
}

function resolveDeclaredAircraftIntegration(
  profile: unknown,
  profileKey: string = getProfileKey(profile),
): AircraftIntegrationDefinition | null {
  const adapterId = getDeclaredAircraftIntegrationAdapterId(profile);
  if (adapterId === null) return null;
  return defaultAircraftIntegrationRegistry.resolveIntegration(adapterId, { profileKey });
}

function getAircraftSpecificActionMap(profile: unknown): GenericRecord | null {
  const declaredAdapterId = getDeclaredAircraftIntegrationAdapterId(profile);
  if (declaredAdapterId !== null) {
    const integration = resolveDeclaredAircraftIntegration(profile);
    return integration ? integration.actions as GenericRecord : null;
  }

  const controls = profile
    && (profile as GenericRecord).integration
    && (profile as GenericRecord).integration.controls;
  const actions = controls?.aircraftSpecific?.actions;
  return actions && typeof actions === 'object' && !Array.isArray(actions)
    ? actions as GenericRecord
    : null;
}

function resolveProfileAircraftSpecificActions(
  profile: unknown,
  request: NormalizedControlRequest,
  profileKey: string,
): GenericRecord[] {
  const adapterId = getDeclaredAircraftIntegrationAdapterId(profile);
  if (adapterId !== null) {
    const actionId = request.actionId || request.target;
    const action = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId,
      profileKey,
      actionId,
    });
    if (!action) return [];
    return [{
      type: 'aircraft-integration',
      name: adapterId,
      verification: action.verification,
    }];
  }

  const profileControls = profile
    && (profile as GenericRecord).integration
    && (profile as GenericRecord).integration.controls;
  const actions = profileControls
    && typeof profileControls === 'object'
    && (profileControls as GenericRecord).aircraftSpecific?.actions;
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return [];
  const actionId = request.actionId || request.target;
  if (!Object.prototype.hasOwnProperty.call(actions, actionId)) return [];
  return cloneActionCandidates(actions[actionId]);
}

function resolveProfileActions(
  profile: unknown,
  request: NormalizedControlRequest,
  profileKey: string,
): GenericRecord[] {
  const profileControls = profile && (profile as GenericRecord).integration && (profile as GenericRecord).integration.controls;

  if (request.control === 'autopilot') {
    if (!profileControls || typeof profileControls !== 'object') return [];
    return resolveProfileAutopilotActions(profileControls, request);
  }

  if (request.control === 'aircraft-specific') {
    return resolveProfileAircraftSpecificActions(profile, request, profileKey);
  }

  if (!profileControls || typeof profileControls !== 'object') return [];
  return resolveProfileSurfaceActions(profileControls, request);
}

function isStandardMsfsSurfaceFallback(request: NormalizedControlRequest): boolean {
  return STANDARD_MSFS_SURFACE_FALLBACKS[request.control]?.has(request.operation) === true;
}

function isGenericMsfsFallbackAllowed(profile: unknown, request: NormalizedControlRequest): boolean {
  const controls = profile && (profile as GenericRecord).integration && (profile as GenericRecord).integration.controls;

  if (controls && controls.genericFallback === true) {
    return true;
  }

  if (controls && controls.genericFallback === false) {
    return controls.standardSurfaceFallback === true && isStandardMsfsSurfaceFallback(request);
  }

  return isStandardMsfsSurfaceFallback(request);
}

function resolveGenericMsfsActions(request: NormalizedControlRequest): GenericRecord[] {
  if (request.control === 'gear') {
    return cloneActionCandidates(GENERIC_MSFS_ACTIONS.gear[request.operation]);
  }

  if (request.control === 'flaps') {
    return cloneActionCandidates(GENERIC_MSFS_ACTIONS.flaps[request.operation]);
  }

  if (request.control === 'spoilers') {
    const action = cloneAction(GENERIC_MSFS_ACTIONS.spoilers[request.operation]);
    if (action) return [action];
    return request.operation === 'set'
      ? applyActionValueCandidates({ type: 'key-event', name: 'SPOILERS_SET' }, request.value)
      : [];
  }

  if (request.control === 'autobrake') {
    const action = cloneAction(GENERIC_MSFS_ACTIONS.autobrake[request.operation]);
    if (!action) return [];
    if (request.operation === 'set') {
      return applyActionValueCandidates(action, request.value);
    }
    return [action];
  }

  if (request.control === 'autopilot') {
    const selectorKey = AUTOPILOT_SELECTOR_KEYS[request.target];
    if (request.operation === 'set' && selectorKey) {
      return applyActionValueCandidates(GENERIC_MSFS_ACTIONS.autopilotSelectors[selectorKey], request.value);
    }

    const targetMap = AUTOPILOT_ACTION_KEYS[request.target];
    if (!targetMap) return [];

    if (request.operation === 'toggle' && targetMap.toggle) {
      return cloneActionCandidates(GENERIC_MSFS_ACTIONS.autopilotActions[targetMap.toggle]);
    }

    if (request.operation === 'set') {
      const normalizedValue = normalizeBoolean(request.value);
      if (normalizedValue === true && targetMap.setTrue) {
        return cloneActionCandidates(GENERIC_MSFS_ACTIONS.autopilotActions[targetMap.setTrue]);
      }
      if (normalizedValue === false && targetMap.setFalse) {
        return cloneActionCandidates(GENERIC_MSFS_ACTIONS.autopilotActions[targetMap.setFalse]);
      }
    }
  }

  return [];
}

function validateResolvedAction(
  request: NormalizedControlRequest,
  action: GenericRecord | null,
): { code: string; error: string } | null {
  if (!action || typeof action !== 'object') {
    return {
      code: 'unmapped_control',
      error: 'No mapped action is available for this control.',
    };
  }

  pruneActionFields(action);

  const actionType = typeof action.type === 'string' ? action.type.trim() : '';
  if (!ALLOWED_ACTION_TYPES.has(actionType)) {
    return {
      code: 'invalid_action',
      error: `Unsupported aircraft control action type: ${action.type || 'unknown'}.`,
    };
  }
  action.type = actionType;

  if (actionType === 'aircraft-integration' && request.control !== 'aircraft-specific') {
    return {
      code: 'invalid_action',
      error: 'Aircraft integration actions are available only through logical aircraft-specific actions.',
    };
  }

  const actionName = typeof action.name === 'string' ? action.name.trim() : '';
  if (!actionName) {
    return {
      code: 'invalid_action',
      error: 'Aircraft control action is missing a target name.',
    };
  }
  if (!isSafeTokenString(actionName, MAX_ACTION_NAME_LENGTH, SAFE_ACTION_NAME_RE)) {
    return {
      code: 'invalid_action',
      error: 'Aircraft control action target contains unsupported characters or is too long.',
    };
  }
  action.name = actionName;

  if (Object.prototype.hasOwnProperty.call(action, 'unit')) {
    const unit = typeof action.unit === 'string' ? action.unit.trim() : '';
    if (!unit) {
      delete action.unit;
    } else if (!isSafeTokenString(unit, MAX_ACTION_UNIT_LENGTH, SAFE_UNIT_RE)) {
      return {
        code: 'invalid_action',
        error: 'Aircraft control action unit contains unsupported characters or is too long.',
      };
    } else {
      action.unit = unit;
    }
  }

  if (Object.prototype.hasOwnProperty.call(action, 'valueType')) {
    const valueType = typeof action.valueType === 'string' ? action.valueType.trim() : '';
    if (!ALLOWED_XPLANE_VALUE_TYPES.has(valueType)) {
      return {
        code: 'invalid_action',
        error: 'Aircraft control action valueType is not supported.',
      };
    }
    action.valueType = valueType;
  }

  if (Object.prototype.hasOwnProperty.call(action, 'verification')) {
    const verification = typeof action.verification === 'string' ? action.verification.trim() : '';
    if (!ALLOWED_VERIFICATION_VALUES.has(verification)) {
      return {
        code: 'invalid_action',
        error: 'Aircraft control action verification status is not supported.',
      };
    }
    action.verification = verification;
  }

  if (request.control === 'autopilot' && request.operation === 'set' && AUTOPILOT_SELECTOR_KEYS[request.target]) {
    if (!isFiniteNumber(request.value)) {
      return {
        code: 'invalid_value',
        error: 'A numeric value is required for this autopilot selector.',
      };
    }
    const range = AUTOPILOT_SELECTOR_RANGES[request.target];
    const numericValue = Number(request.value);
    if (range && (numericValue < range.min || numericValue > range.max)) {
      return {
        code: 'invalid_value',
        error: `A numeric value between ${range.min} and ${range.max} is required for this autopilot selector.`,
      };
    }
  }

  if (Object.prototype.hasOwnProperty.call(action, 'value')) {
    const normalizedValue = normalizeSafeControlArgument(action.value);
    if (!normalizedValue.ok) {
      return {
        code: 'invalid_action',
        error: 'Aircraft control action value is outside the safe control payload format.',
      };
    }
    action.value = normalizedValue.value;
  }

  if (Object.prototype.hasOwnProperty.call(action, 'parameters')) {
    if (!Array.isArray(action.parameters) || action.parameters.length > MAX_ACTION_PARAMETERS) {
      return {
        code: 'invalid_action',
        error: 'Aircraft control action parameters are outside the safe control payload format.',
      };
    }

    const normalizedParameters: Array<boolean | number | string> = [];
    for (const parameter of action.parameters) {
      const normalizedParameter = normalizeSafeControlArgument(parameter);
      if (!normalizedParameter.ok) {
        return {
          code: 'invalid_action',
          error: 'Aircraft control action parameters are outside the safe control payload format.',
        };
      }
      normalizedParameters.push(normalizedParameter.value as boolean | number | string);
    }
    action.parameters = normalizedParameters;
  }

  if (request.control === 'autobrake' && request.operation === 'set' && !isFiniteNumber(action.value)) {
    return {
      code: 'invalid_value',
      error: 'A numeric autobrake value is required.',
    };
  }
  if (request.control === 'spoilers' && request.operation === 'set' && !isFiniteNumber(action.value)) {
    return {
      code: 'invalid_value',
      error: 'A numeric spoiler value is required.',
    };
  }
  return null;
}

function selectSupportedActionCandidate(
  request: NormalizedControlRequest,
  candidates: GenericRecord[],
  supportedActionTypes: Set<string> | null,
): { action: GenericRecord | null; error: { code: string; error: string } | null } {
  let firstValidationError: { code: string; error: string } | null = null;
  let validCandidateCount = 0;
  const unsupportedTypes = new Set<string>();

  for (const candidate of candidates) {
    const validationError = validateResolvedAction(request, candidate);
    if (validationError) {
      if (validationError.code === 'invalid_action' || validationError.code === 'invalid_value') {
        return { action: null, error: validationError };
      }
      if (!firstValidationError) firstValidationError = validationError;
      continue;
    }

    validCandidateCount += 1;
    const candidateType = typeof candidate.type === 'string' ? candidate.type : '';
    if (supportedActionTypes && !supportedActionTypes.has(candidateType)) {
      if (candidateType) unsupportedTypes.add(candidateType);
      continue;
    }

    return { action: candidate, error: null };
  }

  if (validCandidateCount > 0 && supportedActionTypes) {
    const suffix = unsupportedTypes.size > 0
      ? ` Candidate action type(s): ${Array.from(unsupportedTypes).join(', ')}.`
      : '';
    return {
      action: null,
      error: {
        code: 'unsupported_action',
        error: `No mapped action is supported by the active simulator provider.${suffix}`,
      },
    };
  }

  if (firstValidationError) {
    return { action: null, error: firstValidationError };
  }

  return { action: null, error: null };
}

function resolveAircraftControl(rawRequest: unknown, options: ResolveOptions = {}): GenericRecord {
  const request = normalizeControlRequest(rawRequest);
  if (!request) {
    return { ok: false, error: 'Invalid aircraft control request.', code: 'invalid_request' };
  }

  const profile = options.profile || profileLoader.getActiveProfile();
  const simulator = profile && profile.simulator ? profile.simulator : 'msfs';
  const profileKey = getProfileKey(profile);
  const profileRevision = resolveCurrentProfileRevision(options);

  const profileTokenError = validateProfileToken(
    request,
    String(profileKey),
    profileRevision,
    options.requireProfileToken === true,
  );
  if (profileTokenError) {
    return {
      ok: false,
      code: profileTokenError.code,
      error: profileTokenError.error,
      request,
      simulator,
      profileKey,
      profileRevision,
      resolvedBy: 'profile',
    };
  }

  const simStateError = validateSimState(options);
  if (simStateError) {
    return {
      ok: false,
      code: simStateError.code,
      error: simStateError.error,
      request,
      simulator,
      profileKey,
      profileRevision,
      resolvedBy: 'profile',
    };
  }

  const declaredAdapterId = request.control === 'aircraft-specific'
    ? getDeclaredAircraftIntegrationAdapterId(profile)
    : null;
  if (
    request.control === 'aircraft-specific'
    && declaredAdapterId === null
    && request.value !== undefined
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      error: 'Client values are accepted only by a trusted aircraft integration input contract.',
      request,
      simulator,
      profileKey,
      profileRevision,
      resolvedBy: 'profile',
    };
  }
  if (
    request.control === 'aircraft-specific'
    && declaredAdapterId !== null
    && !resolveDeclaredAircraftIntegration(profile, profileKey)
  ) {
    return {
      ok: false,
      code: 'untrusted_aircraft_integration',
      error: 'The declared aircraft integration is not trusted for the active aircraft profile.',
      request,
      simulator,
      profileKey,
      profileRevision,
      resolvedBy: 'profile',
    };
  }

  let actionCandidates = resolveProfileActions(profile, request, profileKey);
  let resolvedBy = 'profile';

  if (actionCandidates.length === 0) {
    if (
      request.control !== 'aircraft-specific'
      && simulator === 'msfs'
      && isGenericMsfsFallbackAllowed(profile, request)
    ) {
      actionCandidates = resolveGenericMsfsActions(request);
      resolvedBy = 'generic';
    }
  }

  const supportedActionTypes = normalizeSupportedActionTypes(options.capabilities);
  const selected = selectSupportedActionCandidate(request, actionCandidates, supportedActionTypes);
  let selectionError = selected.error || validateResolvedAction(request, selected.action);
  if (!selectionError && selected.action?.type === 'aircraft-integration') {
    const actionId = request.actionId || request.target;
    const adapterId = selected.action.name;
    const trustedAction = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId,
      profileKey,
      actionId,
    });
    if (!trustedAction || adapterId !== declaredAdapterId) {
      selectionError = {
        code: 'untrusted_aircraft_integration',
        error: 'The aircraft integration action is not trusted for the active aircraft profile and logical action.',
      };
    } else {
      const inputResult = normalizeAircraftIntegrationActionInput(trustedAction, request.value);
      if (inputResult.ok === false) {
        selectionError = {
          code: 'invalid_value',
          error: inputResult.error,
        };
      } else if (Object.prototype.hasOwnProperty.call(inputResult, 'value')) {
        request.value = inputResult.value;
      }
    }
    if (!selectionError && !defaultAircraftIntegrationRegistry.selectActionRoute({
      adapterId,
      profileKey,
      actionId,
    }, normalizeSupportedIntegrationTransports(options.capabilities))) {
      selectionError = {
        code: 'unsupported_action',
        error: 'No route for this aircraft integration action is supported by the active simulator provider.',
      };
    }
  }
  if (selectionError) {
    return {
      ok: false,
      code: selectionError.code,
      error: selectionError.error,
      request,
      simulator,
      profileKey,
      profileRevision,
      resolvedBy,
    };
  }

  return {
    ok: true,
    request,
    action: selected.action,
    simulator,
    profileKey,
    profileRevision,
    resolvedBy,
  };
}

function buildControlCapabilityGroup(
  requestMap: Record<string, GenericRecord | readonly GenericRecord[]>,
  profile: unknown,
  options: ResolveOptions = {},
): GenericRecord {
  const group: GenericRecord = {};
  for (const [key, requestOrRequests] of Object.entries(requestMap)) {
    const requests = Array.isArray(requestOrRequests) ? requestOrRequests : [requestOrRequests];
    group[key] = requests.every((request) => resolveAircraftControl(request, {
      ...options,
      profile: (profile as GenericRecord | null | undefined) || options.profile || null,
    }).ok === true);
  }
  return group;
}

const MOBIFLIGHT_DEPENDENCY_STATES = new Set([
  'connected',
  'connecting',
  'disabled',
  'disconnected',
  'error',
  'missing',
  'unavailable',
]);

function buildAircraftSpecificDependencies(profile: unknown, options: ResolveOptions = {}): GenericRecord {
  const integration = resolveDeclaredAircraftIntegration(profile);
  if (!integration) return {};

  const supportedTransports = new Set(normalizeSupportedIntegrationTransports(options.capabilities));
  const actions = Object.values(integration.actions || {});
  const mobiflightActions = actions.filter((action) => (
    Array.isArray(action.routes)
    && action.routes.some((route) => route?.transport === 'mobiflight-calculator')
  ));
  if (mobiflightActions.length === 0) return {};

  const mobiflightDependentActions = mobiflightActions.filter((action) => {
    const routes = Array.isArray(action.routes) ? action.routes : [];
    return !routes.some((route) => (
      typeof route?.transport === 'string'
      && route.transport !== 'mobiflight-calculator'
      && supportedTransports.has(route.transport)
    ));
  });
  const fallbackActions = mobiflightActions.filter((action) => {
    const selectedRoute = action.routes?.find((route) => (
      typeof route?.transport === 'string' && supportedTransports.has(route.transport)
    ));
    return selectedRoute?.transport === 'lvar';
  });

  const rawCapabilities = options.capabilities
    && typeof options.capabilities === 'object'
    && !Array.isArray(options.capabilities)
    ? options.capabilities as ProviderControlCapabilities & GenericRecord
    : {};
  const rawHealth = rawCapabilities.mobiflight
    && typeof rawCapabilities.mobiflight === 'object'
    && !Array.isArray(rawCapabilities.mobiflight)
    ? rawCapabilities.mobiflight as GenericRecord
    : {};
  const connected = supportedTransports.has('mobiflight-calculator')
    && rawHealth.connected !== false;
  const rawState = typeof rawHealth.state === 'string'
    ? rawHealth.state.trim().toLowerCase()
    : '';
  const status = connected
    ? 'connected'
    : (MOBIFLIGHT_DEPENDENCY_STATES.has(rawState) ? rawState : 'unavailable');
  const required = mobiflightDependentActions.length > 0;
  const fallbackActive = !connected && fallbackActions.length > 0;
  if (!required && !fallbackActive) return {};

  return {
    mobiflightEventModule: {
      required,
      fallbackActive,
      connected,
      status,
      scope: (required ? mobiflightDependentActions.length : fallbackActions.length) === actions.length
        ? 'all-controls'
        : 'some-controls',
    },
  };
}

function buildAircraftControlCapabilities(profile: unknown, options: ResolveOptions = {}): GenericRecord {
  const aircraftSpecific: GenericRecord = {};
  const actions = getAircraftSpecificActionMap(profile);
  for (const [actionId, action] of Object.entries(actions || {})) {
    if (!isSafeTokenString(
      actionId,
      MAX_AIRCRAFT_SPECIFIC_ACTION_ID_LENGTH,
      SAFE_AIRCRAFT_SPECIFIC_ACTION_ID_RE,
    )) continue;
    aircraftSpecific[actionId] = resolveAircraftControl({
      control: 'aircraft-specific',
      operation: 'execute',
      actionId,
      ...(action?.input?.type === 'number' ? { value: action.input.min } : {}),
    }, {
      ...options,
      profile: (profile as GenericRecord | null | undefined) || options.profile || null,
    }).ok === true;
  }

  return {
    surface: buildControlCapabilityGroup(UI_SURFACE_CAPABILITY_REQUESTS, profile, options),
    autopilot: buildControlCapabilityGroup(UI_AUTOPILOT_CAPABILITY_REQUESTS, profile, options),
    aircraftSpecific,
    aircraftSpecificDependencies: buildAircraftSpecificDependencies(profile, options),
  };
}

function buildResolvedResultBase(resolved: GenericRecord): GenericRecord {
  return {
    request: resolved.request,
    simulator: resolved.simulator,
    profileKey: resolved.profileKey,
    profileRevision: resolved.profileRevision,
    resolvedBy: resolved.resolvedBy,
    action: resolved.action,
  };
}

function normalizeProviderExecutionResult(providerResult: unknown, resolved: GenericRecord): GenericRecord {
  const base = buildResolvedResultBase(resolved);
  if (!providerResult || typeof providerResult !== 'object') {
    return {
      ok: false,
      code: 'provider_empty_result',
      error: 'The simulator provider did not return an aircraft control result.',
      ...base,
    };
  }

  const providerFields = { ...(providerResult as GenericRecord) };
  delete providerFields.request;
  delete providerFields.simulator;
  delete providerFields.profileKey;
  delete providerFields.profileRevision;
  delete providerFields.resolvedBy;
  delete providerFields.action;

  const ok = providerFields.ok === true;
  const code = typeof providerFields.code === 'string' && providerFields.code.trim()
    ? providerFields.code.trim()
    : (ok ? 'executed' : 'provider_failed');
  const error = ok
    ? (typeof providerFields.error === 'string' ? providerFields.error : '')
    : (typeof providerFields.error === 'string' && providerFields.error.trim()
        ? providerFields.error.trim()
        : 'The simulator provider failed to execute the aircraft control action.');

  return {
    ...providerFields,
    ok,
    code,
    error,
    ...base,
  };
}

async function executeAircraftControl(
  provider: AircraftControlProvider | null | undefined,
  rawRequest: unknown,
  options: ResolveOptions = {},
): Promise<GenericRecord> {
  const providerCapabilities = getProviderAircraftControlCapabilities(provider);
  const resolved = resolveAircraftControl(rawRequest, {
    ...options,
    capabilities: options.capabilities || providerCapabilities,
  });
  if (!resolved.ok) return resolved;

  if (!provider || typeof provider.executeAircraftControlAction !== 'function') {
    return {
      ok: false,
      code: 'provider_unsupported',
      error: 'The active simulator provider does not support aircraft control actions.',
      request: resolved.request,
      simulator: resolved.simulator,
      profileKey: resolved.profileKey,
      profileRevision: resolved.profileRevision,
      resolvedBy: resolved.resolvedBy,
      action: resolved.action,
    };
  }

  let result: unknown;
  try {
    result = await provider.executeAircraftControlAction(resolved.action, {
      request: resolved.request,
      profileKey: resolved.profileKey,
      profileRevision: resolved.profileRevision,
      resolvedBy: resolved.resolvedBy,
    });
  } catch (error) {
    const err = error as Error;
    return {
      ok: false,
      code: 'provider_error',
      error: err && err.message ? err.message : String(err),
      ...buildResolvedResultBase(resolved),
    };
  }

  return normalizeProviderExecutionResult(result, resolved);
}

const aircraftControlServiceApi = {
  AUTOPILOT_ACTION_KEYS,
  AUTOPILOT_SELECTOR_KEYS,
  GENERIC_MSFS_ACTIONS,
  buildAircraftControlCapabilities,
  executeAircraftControl,
  resolveAircraftControl,
};

module.exports = aircraftControlServiceApi;

export {};
