'use strict';

import type {
  AircraftIntegrationAction,
  AircraftIntegrationActionRoute,
  AircraftIntegrationDefinition,
  AircraftIntegrationField,
  AircraftIntegrationRouteSelection,
  ResolveAircraftIntegrationActionContext,
  ResolveAircraftIntegrationContext,
  ResolveAircraftIntegrationFieldContext,
  ResolveAircraftIntegrationRouteContext,
} from './types.js';

const SAFE_ADAPTER_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_LOGICAL_ID_RE = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const SAFE_PROFILE_KEY_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const SAFE_ROUTE_ID_RE = /^[a-z0-9][A-Za-z0-9.-]{0,127}$/;
const SAFE_SEQUENCE_EVENT_RE = /^[A-Z][A-Z0-9_:.]{0,79}$/;
const SAFE_SEQUENCE_LVAR_RE = /^L:[A-Za-z0-9][A-Za-z0-9_:.]{0,126}$/;
const SAFE_SEQUENCE_SIMVAR_RE = /^[A-Z][A-Z0-9 _:.]{0,126}$/;
const SAFE_SEQUENCE_UNIT_RE = /^[A-Za-z][A-Za-z0-9 _./:+%()-]{0,47}$/;
const MAX_SEQUENCE_DELAY_MS = 10_000;
const MAX_CALCULATOR_PULSE_DELAY_MS = 1_000;
const MAX_CALCULATOR_TARGET_STEPS = 500;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const READ_ROUTE_TYPES = new Set(['input-event', 'lvar', 'sdk', 'simvar']);
const ACTION_ROUTE_TRANSPORTS = new Set([
  'input-event',
  'lvar',
  'mobiflight-calculator',
  'sdk',
  'simconnect-sequence',
]);
const DECODER_TYPES = new Set(['boolean', 'enum', 'number']);
const VERIFICATION_VALUES = new Set(['partial', 'untested', 'verified']);
const MAX_INPUT_ABS = 1_000_000;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isCalculatorCode(value: unknown): value is string {
  return typeof value === 'string' && /^[\x20-\x7e]{1,4096}$/.test(value);
}

function hasValidUnavailableNumberValues(decoder: unknown): boolean {
  if (!decoder || typeof decoder !== 'object' || Array.isArray(decoder)) return false;
  const value = decoder as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(value, 'unavailableValues')) return true;
  if (value.type !== 'number' || !Array.isArray(value.unavailableValues)) return false;
  if (value.unavailableValues.length === 0 || value.unavailableValues.length > 32) return false;
  if (value.unavailableValues.some((item) => typeof item !== 'number' || !Number.isFinite(item))) return false;
  return new Set(value.unavailableValues).size === value.unavailableValues.length;
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  if (text.includes('e-')) {
    const [coefficient, exponent] = text.split('e-');
    return Number(exponent) + (coefficient.split('.')[1]?.length || 0);
  }
  return text.split('.')[1]?.length || 0;
}

function normalizeAircraftIntegrationActionInput(
  action: AircraftIntegrationAction | null | undefined,
  rawValue: unknown,
): Readonly<{ ok: true; value?: number } | { ok: false; error: string }> {
  const input = action?.input;
  if (!input) {
    return rawValue === undefined
      ? Object.freeze({ ok: true })
      : Object.freeze({ ok: false, error: 'This aircraft action does not accept a client value.' });
  }
  if (input.type !== 'number' || typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    return Object.freeze({ ok: false, error: 'This aircraft action requires a finite numeric value.' });
  }
  if (rawValue < input.min || rawValue > input.max) {
    return Object.freeze({
      ok: false,
      error: `This aircraft action requires a value between ${input.min} and ${input.max}.`,
    });
  }
  const stepPosition = (rawValue - input.min) / input.step;
  if (Math.abs(stepPosition - Math.round(stepPosition)) > 1e-7) {
    return Object.freeze({
      ok: false,
      error: `This aircraft action requires increments of ${input.step}.`,
    });
  }
  const precision = Math.min(8, Math.max(
    decimalPlaces(input.min),
    decimalPlaces(input.max),
    decimalPlaces(input.step),
  ));
  return Object.freeze({ ok: true, value: Number(rawValue.toFixed(precision)) });
}

function immutableCopy<T>(value: T, ancestors = new Set<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError('Aircraft integration definitions must not contain cycles.');
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(objectValue);

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableCopy(entry, nextAncestors))) as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Aircraft integration definitions must contain only plain data.');
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_KEYS.has(key)) {
      throw new TypeError(`Aircraft integration definitions cannot contain reserved key "${key}".`);
    }
    result[key] = immutableCopy(entry, nextAncestors);
  }
  return Object.freeze(result) as T;
}

function assertDefinition(definition: AircraftIntegrationDefinition): void {
  const adapterId = normalizeString(definition?.id);
  if (!SAFE_ADAPTER_ID_RE.test(adapterId)) {
    throw new TypeError('Aircraft integration definitions require a safe adapter ID.');
  }
  if (!Array.isArray(definition.trustedProfileKeys) || definition.trustedProfileKeys.length === 0) {
    throw new TypeError(`Aircraft integration "${adapterId}" requires at least one trusted profile key.`);
  }
  for (const profileKeyValue of definition.trustedProfileKeys) {
    const profileKey = normalizeString(profileKeyValue);
    if (!SAFE_PROFILE_KEY_RE.test(profileKey)) {
      throw new TypeError(`Aircraft integration "${adapterId}" has an invalid trusted profile key.`);
    }
  }
  if (!definition.fields || typeof definition.fields !== 'object' || Array.isArray(definition.fields)) {
    throw new TypeError(`Aircraft integration "${adapterId}" requires a field registry.`);
  }
  for (const [fieldId, field] of Object.entries(definition.fields)) {
    if (
      !SAFE_LOGICAL_ID_RE.test(fieldId)
      || field?.id !== fieldId
      || !Array.isArray(field.sources)
      || field.sources.length === 0
    ) {
      throw new TypeError(`Aircraft integration "${adapterId}" has an invalid field definition.`);
    }
    for (const source of field.sources) {
      if (
        !source
        || typeof source !== 'object'
        || !source.route
        || typeof source.route !== 'object'
        || !READ_ROUTE_TYPES.has(normalizeString(source.route.type))
        || !source.decode
        || typeof source.decode !== 'object'
        || !DECODER_TYPES.has(normalizeString(source.decode.type))
        || !hasValidUnavailableNumberValues(source.decode)
      ) {
        throw new TypeError(`Aircraft integration "${adapterId}" has an invalid source for field "${fieldId}".`);
      }
    }
  }
  if (!definition.actions || typeof definition.actions !== 'object' || Array.isArray(definition.actions)) {
    throw new TypeError(`Aircraft integration "${adapterId}" requires an action registry.`);
  }
  for (const [actionId, action] of Object.entries(definition.actions)) {
    if (
      !SAFE_LOGICAL_ID_RE.test(actionId)
      || action?.id !== actionId
      || !Array.isArray(action.routes)
      || action.routes.length === 0
      || !action.guard
      || typeof action.guard !== 'object'
      || !SAFE_LOGICAL_ID_RE.test(normalizeString(action.guard.groupId))
      || !Number.isFinite(action.guard.cooldownMs)
      || action.guard.cooldownMs < 0
      || action.guard.cooldownMs > 60_000
      || action.guard.retry !== 'never'
      || (
        action.guard.skipIfSatisfied !== undefined
        && typeof action.guard.skipIfSatisfied !== 'boolean'
      )
      || !VERIFICATION_VALUES.has(normalizeString(action.verification))
    ) {
      throw new TypeError(`Aircraft integration "${adapterId}" has an invalid action definition.`);
    }
    if (action.input) {
      const input = action.input;
      if (
        input.type !== 'number'
        || !Number.isFinite(input.min)
        || !Number.isFinite(input.max)
        || !Number.isFinite(input.step)
        || Math.abs(input.min) > MAX_INPUT_ABS
        || Math.abs(input.max) > MAX_INPUT_ABS
        || input.min > input.max
        || input.step <= 0
        || input.step > MAX_INPUT_ABS
      ) {
        throw new TypeError(`Aircraft integration "${adapterId}" has an invalid action input.`);
      }
    }
    const routeIds = new Set<string>();
    for (const route of action.routes) {
      if (
        !SAFE_ROUTE_ID_RE.test(route?.id)
        || routeIds.has(route.id)
        || !ACTION_ROUTE_TRANSPORTS.has(normalizeString(route.transport))
      ) {
        throw new TypeError(`Aircraft integration "${adapterId}" has an invalid action route.`);
      }
      if (route.transport === 'mobiflight-calculator') {
        const calculatorRoute = route as unknown as Record<string, unknown>;
        const calculatorReadback = route.readback && typeof route.readback === 'object'
          ? route.readback
          : null;
        const mode = calculatorRoute.mode === undefined ? 'single' : calculatorRoute.mode;
        const hasSingleOnlyShape = mode === 'single'
          && isCalculatorCode(calculatorRoute.code)
          && calculatorRoute.pressCode === undefined
          && calculatorRoute.releaseCode === undefined
          && calculatorRoute.delayMs === undefined
          && calculatorRoute.decreaseCode === undefined
          && calculatorRoute.increaseCode === undefined
          && calculatorRoute.maxSteps === undefined
          && calculatorRoute.circular === undefined
          && calculatorRoute.precondition === undefined;
        const hasPulseOnlyShape = mode === 'pulse'
          && !action.input
          && calculatorReadback !== null
          && Object.prototype.hasOwnProperty.call(calculatorReadback, 'expectedValue')
          && calculatorRoute.code === undefined
          && isCalculatorCode(calculatorRoute.pressCode)
          && isCalculatorCode(calculatorRoute.releaseCode)
          && Number.isSafeInteger(calculatorRoute.delayMs)
          && Number(calculatorRoute.delayMs) >= 1
          && Number(calculatorRoute.delayMs) <= MAX_CALCULATOR_PULSE_DELAY_MS
          && calculatorRoute.decreaseCode === undefined
          && calculatorRoute.increaseCode === undefined
          && calculatorRoute.maxSteps === undefined
          && calculatorRoute.circular === undefined
          && calculatorRoute.precondition === undefined;
        const precondition = calculatorRoute.precondition as Record<string, unknown> | undefined;
        const validPrecondition = precondition === undefined || (
          precondition !== null
          && typeof precondition === 'object'
          && SAFE_LOGICAL_ID_RE.test(normalizeString(precondition.fieldId))
          && Object.prototype.hasOwnProperty.call(definition.fields, normalizeString(precondition.fieldId))
          && isPrimitive(precondition.expectedValue)
          && Object.keys(precondition).every((key) => key === 'fieldId' || key === 'expectedValue')
        );
        const hasSteppedOnlyShape = mode === 'step-to-target'
          && Boolean(action.input)
          && calculatorReadback?.expectedInput === true
          && calculatorRoute.code === undefined
          && calculatorRoute.pressCode === undefined
          && calculatorRoute.releaseCode === undefined
          && calculatorRoute.delayMs === undefined
          && isCalculatorCode(calculatorRoute.decreaseCode)
          && isCalculatorCode(calculatorRoute.increaseCode)
          && Number.isSafeInteger(calculatorRoute.maxSteps)
          && Number(calculatorRoute.maxSteps) >= 1
          && Number(calculatorRoute.maxSteps) <= MAX_CALCULATOR_TARGET_STEPS
          && (calculatorRoute.circular === undefined || calculatorRoute.circular === true)
          && validPrecondition;
        if (!hasSingleOnlyShape && !hasPulseOnlyShape && !hasSteppedOnlyShape) {
          throw new TypeError(`Aircraft integration "${adapterId}" has an invalid calculator route.`);
        }
      }
      if (
        route.transport === 'lvar'
        && (
          !SAFE_SEQUENCE_LVAR_RE.test(normalizeString(route.lvar))
          || !SAFE_SEQUENCE_UNIT_RE.test(normalizeString(route.unit))
          || (typeof route.value !== 'boolean' && typeof route.value !== 'number')
          || (typeof route.value === 'number' && (
            !Number.isFinite(route.value) || Math.abs(route.value) > MAX_INPUT_ABS
          ))
        )
      ) {
        throw new TypeError(`Aircraft integration "${adapterId}" has an invalid direct LVAR route.`);
      }
      if (
        route.transport === 'sdk'
        && (
          !SAFE_ADAPTER_ID_RE.test(normalizeString(route.adapter))
          || typeof route.command !== 'string'
          || !/^[A-Za-z0-9 _./:#+%()-]{1,160}$/.test(route.command)
          || (route.value !== undefined && !isPrimitive(route.value))
          || (route.values !== undefined && (
            !Array.isArray(route.values)
            || route.values.length === 0
            || route.values.length > 4
            || route.values.some((value) => !isPrimitive(value))
          ))
          || (route.inputValue !== undefined && (
            !action.input
            || route.inputValue.source !== 'input'
            || (route.inputValue.scale !== undefined && !Number.isFinite(route.inputValue.scale))
            || (route.inputValue.offset !== undefined && !Number.isFinite(route.inputValue.offset))
            || (route.inputValue.round !== undefined && route.inputValue.round !== 'nearest')
          ))
          || [route.value !== undefined, route.values !== undefined, route.inputValue !== undefined]
            .filter(Boolean).length !== 1
        )
      ) {
        throw new TypeError(`Aircraft integration "${adapterId}" has an invalid SDK route.`);
      }
      if (route.transport === 'simconnect-sequence') {
        if (
          (route.confirmation !== undefined
            && route.confirmation !== 'transport-acknowledged')
          || (route.confirmation === 'transport-acknowledged' && route.readback !== undefined)
          || !Array.isArray(route.operations)
          || route.operations.length === 0
          || route.operations.length > 8
          || route.operations.reduce(
            (total, operation) => total + (operation?.type === 'delay' ? Number(operation.milliseconds) : 0),
            0,
          ) > MAX_SEQUENCE_DELAY_MS
          || route.operations.some((operation) => {
            if (!operation || typeof operation !== 'object') return true;
            if (operation.type === 'event') {
              const hasFixedValue = operation.value !== undefined;
              const hasInputValue = operation.inputValue !== undefined;
              return !SAFE_SEQUENCE_EVENT_RE.test(normalizeString(operation.name).toUpperCase())
                || [hasFixedValue, hasInputValue].filter(Boolean).length !== 1
                || (operation.parameters !== undefined && (
                  !Array.isArray(operation.parameters)
                  || operation.parameters.length > 4
                  || operation.parameters.some((parameter) => (
                    typeof parameter !== 'number'
                    || !Number.isFinite(parameter)
                    || Math.abs(parameter) > 1_000_000
                  ))
                ))
                || (hasFixedValue && (
                  typeof operation.value !== 'number'
                  || !Number.isFinite(operation.value)
                  || Math.abs(operation.value) > 1_000_000
                ))
                || (hasInputValue && (
                  !action.input
                  || operation.inputValue?.source !== 'input'
                  || (operation.inputValue.scale !== undefined
                    && !Number.isFinite(operation.inputValue.scale))
                  || (operation.inputValue.offset !== undefined
                    && !Number.isFinite(operation.inputValue.offset))
                  || (operation.inputValue.round !== undefined
                    && operation.inputValue.round !== 'nearest')
                ));
            }
            if (operation.type === 'lvar') {
              return !SAFE_SEQUENCE_LVAR_RE.test(normalizeString(operation.name))
                || !SAFE_SEQUENCE_UNIT_RE.test(normalizeString(operation.unit))
                || (typeof operation.value !== 'boolean' && typeof operation.value !== 'number')
                || (typeof operation.value === 'number' && (
                  !Number.isFinite(operation.value) || Math.abs(operation.value) > 1_000_000
                ));
            }
            if (operation.type === 'delay') {
              return !Number.isSafeInteger(operation.milliseconds)
                || operation.milliseconds < 1
                || operation.milliseconds > MAX_SEQUENCE_DELAY_MS;
            }
            if (operation.type === 'simvar') {
              const simvarName = normalizeString(operation.name);
              return !SAFE_SEQUENCE_SIMVAR_RE.test(simvarName)
                || /^(?:A|L):/.test(simvarName)
                || !SAFE_SEQUENCE_UNIT_RE.test(normalizeString(operation.unit))
                || (typeof operation.value !== 'boolean' && typeof operation.value !== 'number')
                || (typeof operation.value === 'number' && (
                  !Number.isFinite(operation.value) || Math.abs(operation.value) > 1_000_000
                ));
            }
            return true;
          })
        ) {
          throw new TypeError(`Aircraft integration "${adapterId}" has an invalid SimConnect sequence route.`);
        }
      }
      if (route.readback) {
        const readback = route.readback;
        const expectationCount = [
          Object.prototype.hasOwnProperty.call(readback, 'expectedValue'),
          readback.expectedInput === true,
          readback.confirmation === 'changed',
        ].filter(Boolean).length;
        if (
          !SAFE_LOGICAL_ID_RE.test(normalizeString(readback.fieldId))
          || !Object.prototype.hasOwnProperty.call(definition.fields, readback.fieldId)
          || expectationCount !== 1
          || (Object.prototype.hasOwnProperty.call(readback, 'expectedValue')
            && !isPrimitive(readback.expectedValue))
          || (readback.expectedInput === true && !action.input)
          || !Number.isFinite(readback.timeoutMs)
          || readback.timeoutMs < 0
          || readback.timeoutMs > 30_000
        ) {
          throw new TypeError(`Aircraft integration "${adapterId}" has an invalid action readback.`);
        }
      } else if (
        route.transport === 'mobiflight-calculator'
        || route.transport === 'lvar'
        || route.transport === 'sdk'
        || (route.transport === 'simconnect-sequence'
          && route.confirmation !== 'transport-acknowledged')
      ) {
        throw new TypeError(`Aircraft integration "${adapterId}" write routes require readback.`);
      }
      routeIds.add(route.id);
    }
  }
}

function readOwn<T>(record: Readonly<Record<string, T>>, key: string): T | null {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : null;
}

function createAircraftIntegrationRegistry(
  initialDefinitions: readonly AircraftIntegrationDefinition[] = [],
) {
  const integrationsById = new Map<string, AircraftIntegrationDefinition>();
  const adapterIdByProfileKey = new Map<string, string>();

  function register(input: AircraftIntegrationDefinition): AircraftIntegrationDefinition {
    const definition = immutableCopy(input);
    assertDefinition(definition);
    const adapterId = definition.id;
    if (integrationsById.has(adapterId)) {
      throw new Error(`Aircraft integration adapter "${adapterId}" is already registered.`);
    }
    for (const profileKey of definition.trustedProfileKeys) {
      if (adapterIdByProfileKey.has(profileKey)) {
        throw new Error(`Trusted aircraft profile "${profileKey}" already has an integration adapter.`);
      }
    }
    integrationsById.set(adapterId, definition);
    for (const profileKey of definition.trustedProfileKeys) {
      adapterIdByProfileKey.set(profileKey, adapterId);
    }
    return definition;
  }

  function getById(adapterIdValue: unknown): AircraftIntegrationDefinition | null {
    const adapterId = normalizeString(adapterIdValue);
    if (!SAFE_ADAPTER_ID_RE.test(adapterId)) return null;
    return integrationsById.get(adapterId) || null;
  }

  function resolveForProfile(profileKeyValue: unknown): AircraftIntegrationDefinition | null {
    const profileKey = normalizeString(profileKeyValue);
    if (!SAFE_PROFILE_KEY_RE.test(profileKey)) return null;
    const adapterId = adapterIdByProfileKey.get(profileKey);
    return adapterId ? integrationsById.get(adapterId) || null : null;
  }

  function resolveIntegration(
    adapterIdValue: unknown,
    context: ResolveAircraftIntegrationContext = {},
  ): AircraftIntegrationDefinition | null {
    const definition = getById(adapterIdValue);
    if (!definition) return null;
    const profileKey = normalizeString(context.profileKey);
    if (!profileKey || !definition.trustedProfileKeys.includes(profileKey)) return null;
    return definition;
  }

  function resolveDefinition(
    adapterIdValue: unknown,
    profileKeyValue: unknown,
  ): AircraftIntegrationDefinition | null {
    const adapterId = normalizeString(adapterIdValue);
    return adapterId
      ? resolveIntegration(adapterId, { profileKey: profileKeyValue })
      : null;
  }

  function resolveAction(
    context: ResolveAircraftIntegrationActionContext,
  ): AircraftIntegrationAction | null {
    const definition = resolveDefinition(context?.adapterId, context?.profileKey);
    const actionId = normalizeString(context?.actionId);
    if (!definition || !SAFE_LOGICAL_ID_RE.test(actionId)) return null;
    return readOwn(definition.actions, actionId);
  }

  function resolveField(
    context: ResolveAircraftIntegrationFieldContext,
  ): AircraftIntegrationField | null {
    const definition = resolveDefinition(context?.adapterId, context?.profileKey);
    const fieldId = normalizeString(context?.fieldId);
    if (!definition || !SAFE_LOGICAL_ID_RE.test(fieldId)) return null;
    return readOwn(definition.fields, fieldId);
  }

  function resolveActionRoute(
    context: ResolveAircraftIntegrationRouteContext,
  ): AircraftIntegrationActionRoute | null {
    const action = resolveAction(context);
    if (!action || action.routes.length === 0) return null;
    const routeId = normalizeString(context?.routeId);
    if (!routeId) return action.routes[0];
    if (!SAFE_ROUTE_ID_RE.test(routeId)) return null;
    return action.routes.find((route) => route.id === routeId) || null;
  }

  function selectActionRoute(
    context: ResolveAircraftIntegrationActionContext,
    supportedTransportsValue: unknown,
  ): AircraftIntegrationRouteSelection | null {
    const definition = resolveDefinition(context?.adapterId, context?.profileKey);
    const actionId = normalizeString(context?.actionId);
    if (!definition || !SAFE_LOGICAL_ID_RE.test(actionId) || !Array.isArray(supportedTransportsValue)) {
      return null;
    }
    const action = readOwn(definition.actions, actionId);
    if (!action) return null;
    const supportedTransports = new Set(
      supportedTransportsValue
        .map(normalizeString)
        .filter(Boolean),
    );
    const route = action.routes.find((candidate) => supportedTransports.has(candidate.transport));
    if (!route) return null;
    return Object.freeze({
      adapterId: definition.id,
      actionId,
      routeId: route.id,
      transport: route.transport,
    });
  }

  function supportsAction(
    context: ResolveAircraftIntegrationActionContext,
    supportedTransportsValue: unknown,
  ): boolean {
    return selectActionRoute(context, supportedTransportsValue) !== null;
  }

  for (const definition of initialDefinitions) register(definition);

  return Object.freeze({
    getById,
    list: () => Object.freeze([...integrationsById.values()]),
    register,
    resolveAction,
    resolveActionRoute,
    resolveField,
    resolveForProfile,
    resolveIntegration,
    selectActionRoute,
    supportsAction,
  });
}

function defineAircraftIntegration(
  input: AircraftIntegrationDefinition,
): AircraftIntegrationDefinition {
  const definition = immutableCopy(input);
  assertDefinition(definition);
  return definition;
}

module.exports = {
  createAircraftIntegrationRegistry,
  defineAircraftIntegration,
  normalizeAircraftIntegrationActionInput,
};

export {};
