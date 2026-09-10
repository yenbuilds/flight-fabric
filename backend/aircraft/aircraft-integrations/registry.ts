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
import { isSafeMobiFlightCalculatorCode } from '../../utils/mobiflight-protocol.js';
import { COM_RADIO_INPUT, COM_RADIO_PROPERTIES, comRadioOperations } from './com-radio.js';
import { baroActions } from './fbw-a32nx/baro.js';
import { a380BaroActions } from './fbw-a380x/baro.js';
import { fenixBaroActions } from './fenix-a32x/baro.js';
import { MINIMUMS_INPUTS } from './fbw-a32nx/minimums.js';

const SAFE_ADAPTER_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_LOGICAL_ID_RE = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const SAFE_PROFILE_KEY_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const SAFE_ROUTE_ID_RE = /^[a-z0-9][A-Za-z0-9.-]{0,127}$/;
const SAFE_SEQUENCE_EVENT_RE = /^(?:[A-Z][A-Z0-9_:.]{0,79}|#[0-9]{5})$/;
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
  'simbridge-mcdu',
]);
const DECODER_TYPES = new Set(['boolean', 'enum', 'number', 'squawk-bco16']);
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
    if (action.guard.skipWhen !== undefined && (
      !Array.isArray(action.guard.skipWhen)
      || action.guard.skipWhen.length < 1
      || action.guard.skipWhen.length > 4
      || action.guard.skipWhen.some((condition) => (
        !condition || !Object.prototype.hasOwnProperty.call(definition.fields, condition.fieldId)
        || !isPrimitive(condition.expectedValue)
        || Object.keys(condition).some((key) => key !== 'fieldId' && key !== 'expectedValue')
      ))
    )) {
      throw new TypeError(`Aircraft integration "${adapterId}" has an invalid dispatch guard.`);
    }
    const routeIds = new Set<string>();
    for (const route of action.routes) {
      const routeRecord = route as unknown as Record<string, unknown>;
      const routeReadbacks = Array.isArray(routeRecord.readbacks)
        ? routeRecord.readbacks as Array<Record<string, unknown>>
        : [];
      const supportsCalculatorReadbacks = route.transport === 'mobiflight-calculator'
        && (routeRecord.mode === undefined || ['single', 'pulse', 'fenix-baro'].includes(String(routeRecord.mode)));
      if (routeRecord.baro !== undefined) {
        const expected = adapterId === 'fbw-a32nx' ? baroActions()[action.id]
          : adapterId === 'fbw-a380x' ? a380BaroActions()[action.id]
          : adapterId === 'fenix-a32x' ? fenixBaroActions()[action.id] : null;
        if (!expected || JSON.stringify(action) !== JSON.stringify(expected)
          || !expected.routes.flatMap((r) => 'readbacks' in r ? r.readbacks || [] : []).every((r) => definition.fields[r.fieldId])) {
          throw new TypeError(`Aircraft integration "${adapterId}" has an invalid barometer contract.`);
        }
      }
      if (routeRecord.comRadio !== undefined) {
        const radio = routeRecord.comRadio as { index: 1 | 2; operation: string };
        const readback = route.readback as Record<string, unknown> | undefined;
        const inputMatches = Object.keys(COM_RADIO_INPUT).every((key) => action.input?.[key] === COM_RADIO_INPUT[key]);
        if (route.transport !== 'simconnect-sequence' || !radio || ![1, 2].includes(radio.index)
          || !['setStandby', 'swap', 'switchTo'].includes(radio.operation)
          || Object.keys(radio).some((key) => !['index', 'operation'].includes(key))
          || !COM_RADIO_PROPERTIES.every((property) => definition.fields[`radios.com${radio.index}.${property}`])
          || (radio.operation === 'swap' ? action.input !== undefined : !inputMatches)
          || JSON.stringify(route.operations) !== JSON.stringify(comRadioOperations(radio.index, radio.operation))
          || route.confirmation !== undefined || route.precondition !== undefined || routeRecord.readbacks !== undefined
          || readback?.fieldId !== `radios.com${radio.index}.${radio.operation === 'setStandby' ? 'standbyMhz' : 'activeMhz'}`
          || readback?.timeoutMs !== 2500
          || (radio.operation === 'swap' ? readback?.confirmation !== 'changed' : readback?.expectedInput !== true)
          || action.guard.retry !== 'never' || !action.guard.groupId.endsWith(`.radios.com${radio.index}`)) {
          throw new TypeError(`Aircraft integration "${adapterId}" has an invalid COM radio contract.`);
        }
      }
      const acknowledgesRequest = routeRecord.confirmation === 'transport-acknowledged';
      if (routeRecord.confirmation !== undefined && (
        !acknowledgesRequest
        || !(
          route.transport === 'simconnect-sequence'
          || route.transport === 'sdk'
          || (route.transport === 'mobiflight-calculator' && routeRecord.mode === 'pulse')
        )
        || action.input !== undefined
        || route.readback !== undefined
        || routeRecord.readbacks !== undefined
      )) {
        throw new TypeError(`Aircraft integration "${adapterId}" has an invalid acknowledgement contract.`);
      }
      if (
        !SAFE_ROUTE_ID_RE.test(route?.id)
        || routeIds.has(route.id)
        || !ACTION_ROUTE_TRANSPORTS.has(normalizeString(route.transport))
        || (routeRecord.readbacks !== undefined && route.transport !== 'simconnect-sequence' && (
          !supportsCalculatorReadbacks
          || !Array.isArray(routeRecord.readbacks)
          || routeReadbacks.length < 2
          || routeReadbacks.length > (routeRecord.mode === 'fenix-baro' ? 7 : 4)
          || route.readback !== undefined
          || new Set(routeReadbacks.map((readback) => readback?.fieldId)).size !== routeReadbacks.length
        ))
      ) {
        throw new TypeError(`Aircraft integration "${adapterId}" has an invalid action route.`);
      }
      if (route.transport === 'mobiflight-calculator' && routeRecord.mode !== 'fenix-baro') {
        const calculatorRoute = route as unknown as Record<string, unknown>;
        const calculatorReadback = route.readback && typeof route.readback === 'object'
          ? route.readback
          : null;
        const mode = calculatorRoute.mode === undefined ? 'single' : calculatorRoute.mode;
        const hasSingleOnlyShape = mode === 'single'
          && isSafeMobiFlightCalculatorCode(calculatorRoute.code)
          && calculatorRoute.pressCode === undefined
          && calculatorRoute.releaseCode === undefined
          && calculatorRoute.delayMs === undefined
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
          && (precondition.freshness === undefined || precondition.freshness === 'field')
          && Object.keys(precondition).every((key) => key === 'fieldId' || key === 'expectedValue' || key === 'freshness')
        );
        const pulses = calculatorRoute.pulses as Array<Record<string, any>> | undefined;
        const pulseReadbacks = calculatorReadback ? [calculatorReadback] : routeReadbacks;
        const validPulseCodes = pulses === undefined
          ? isSafeMobiFlightCalculatorCode(calculatorRoute.pressCode)
            && isSafeMobiFlightCalculatorCode(calculatorRoute.releaseCode)
          : !acknowledgesRequest && calculatorRoute.pressCode === undefined && calculatorRoute.releaseCode === undefined
            && Array.isArray(pulses) && pulses.length > 0 && pulses.length <= 8
            && pulses.every((pulse) => pulse && typeof pulse === 'object'
              && Object.keys(pulse).every((key) => ['when', 'pressCode', 'releaseCode'].includes(key))
              && isSafeMobiFlightCalculatorCode(pulse.pressCode) && isSafeMobiFlightCalculatorCode(pulse.releaseCode)
              && Array.isArray(pulse.when) && pulse.when.length > 0 && pulse.when.length <= 8
              && new Set(pulse.when.map((condition) => condition?.fieldId)).size === pulse.when.length
              && pulse.when.every((condition) => condition && typeof condition === 'object'
                && condition.freshness === 'field' && isPrimitive(condition.expectedValue)
                && pulseReadbacks.some((readback) => readback.fieldId === condition.fieldId && readback.freshness === 'field')
                && Object.keys(condition).every((key) => ['fieldId', 'expectedValue', 'freshness'].includes(key))));
        const hasPulseOnlyShape = mode === 'pulse'
          && !action.input
          && (acknowledgesRequest || (pulseReadbacks.length > 0
            && pulseReadbacks.every((readback) => Object.prototype.hasOwnProperty.call(readback, 'expectedValue'))))
          && calculatorRoute.code === undefined
          && validPulseCodes
          && Number.isSafeInteger(calculatorRoute.delayMs)
          && Number(calculatorRoute.delayMs) >= 1
          && Number(calculatorRoute.delayMs) <= MAX_CALCULATOR_PULSE_DELAY_MS
          && calculatorRoute.decreaseCode === undefined
          && calculatorRoute.increaseCode === undefined
          && calculatorRoute.maxSteps === undefined
          && calculatorRoute.circular === undefined
          && validPrecondition;
        const hasSteppedOnlyShape = mode === 'step-to-target'
          && Boolean(action.input)
          && calculatorReadback?.expectedInput === true
          && calculatorRoute.code === undefined
          && calculatorRoute.pressCode === undefined
          && calculatorRoute.releaseCode === undefined
          && calculatorRoute.delayMs === undefined
          && isSafeMobiFlightCalculatorCode(calculatorRoute.decreaseCode)
          && (calculatorRoute.prepareCode === undefined || (
            isSafeMobiFlightCalculatorCode(calculatorRoute.prepareCode) && calculatorRoute.precondition
          ))
          && isSafeMobiFlightCalculatorCode(calculatorRoute.increaseCode)
          && Number.isSafeInteger(calculatorRoute.maxSteps)
          && Number(calculatorRoute.maxSteps) >= 1
          && Number(calculatorRoute.maxSteps) <= MAX_CALCULATOR_TARGET_STEPS
          && (calculatorRoute.circular === undefined || calculatorRoute.circular === true)
          && validPrecondition;
        if ((!hasSingleOnlyShape && !hasPulseOnlyShape && !hasSteppedOnlyShape)
          || (mode !== 'pulse' && pulses !== undefined)
          || (mode !== 'step-to-target' && calculatorRoute.prepareCode !== undefined)) {
          throw new TypeError(`Aircraft integration "${adapterId}" has an invalid calculator route.`);
        }
      }
      if (routeRecord.mode === 'fenix-baro' && (route.transport !== 'mobiflight-calculator' || routeRecord.baro === undefined)) {
        throw new TypeError('Invalid Fenix barometer contract.');
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
        const sequencePrecondition = route.precondition as Record<string, unknown> | undefined;
        const validSequencePrecondition = sequencePrecondition === undefined || (
          sequencePrecondition !== null
          && typeof sequencePrecondition === 'object'
          && SAFE_LOGICAL_ID_RE.test(normalizeString(sequencePrecondition.fieldId))
          && Object.prototype.hasOwnProperty.call(
            definition.fields,
            normalizeString(sequencePrecondition.fieldId),
          )
          && isPrimitive(sequencePrecondition.expectedValue)
          && (sequencePrecondition.freshness === undefined || sequencePrecondition.freshness === 'field')
          && Object.keys(sequencePrecondition).every(
            (key) => key === 'fieldId' || key === 'expectedValue' || key === 'freshness',
          )
        );
        if (
          !validSequencePrecondition
          || (route.requiredSdkAdapter !== undefined
            && !SAFE_ADAPTER_ID_RE.test(normalizeString(route.requiredSdkAdapter)))
          || (route.confirmation !== undefined
            && route.confirmation !== 'transport-acknowledged')
          || (route.confirmation === 'transport-acknowledged'
            && (route.readback !== undefined || routeRecord.readbacks !== undefined))
          || (routeRecord.readbacks !== undefined && (
            !Array.isArray(routeRecord.readbacks)
            || routeReadbacks.length < 2
            || routeReadbacks.length > (route.baro ? 9 : 4)
            || route.readback !== undefined
            || new Set(routeReadbacks.map((readback) => readback?.fieldId)).size !== routeReadbacks.length
          ))
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
                  || operation.parameters.some((parameter) => typeof parameter === 'number'
                    ? !Number.isFinite(parameter) || Math.abs(parameter) > 1_000_000
                    : !parameter || typeof parameter !== 'object' || !action.input
                      || parameter.source !== 'input' || parameter.encoding !== undefined
                      || Object.keys(parameter).some((key) => !['source', 'scale', 'offset', 'round'].includes(key))
                      || (parameter.scale !== undefined && !Number.isFinite(parameter.scale))
                      || (parameter.offset !== undefined && !Number.isFinite(parameter.offset))
                      || (parameter.round !== undefined && parameter.round !== 'nearest'))
                ))
                || (hasFixedValue && (
                  typeof operation.value !== 'number'
                  || !Number.isFinite(operation.value)
                  || Math.abs(operation.value) > 1_000_000
                ))
                || (hasInputValue && (
                  !action.input
                  || operation.inputValue?.source !== 'input'
                  || (operation.inputValue.encoding !== undefined
                    && !['frequency-bcd16', 'squawk-bco16'].includes(operation.inputValue.encoding))
                  || (operation.inputValue.encoding !== undefined && (
                    operation.inputValue.scale !== undefined
                    || operation.inputValue.offset !== undefined
                    || operation.inputValue.round !== undefined
                  ))
                  || (operation.inputValue.scale !== undefined
                    && !Number.isFinite(operation.inputValue.scale))
                  || (operation.inputValue.offset !== undefined
                    && !Number.isFinite(operation.inputValue.offset))
                  || (operation.inputValue.round !== undefined
                    && operation.inputValue.round !== 'nearest')
                ));
            }
            if (operation.type === 'lvar') {
              const hasFixedValue = operation.value !== undefined;
              const hasInputValue = operation.inputValue !== undefined;
              return !SAFE_SEQUENCE_LVAR_RE.test(normalizeString(operation.name))
                || !SAFE_SEQUENCE_UNIT_RE.test(normalizeString(operation.unit))
                || [hasFixedValue, hasInputValue].filter(Boolean).length !== 1
                || (hasFixedValue
                  && typeof operation.value !== 'boolean'
                  && typeof operation.value !== 'number')
                || (hasFixedValue && typeof operation.value === 'number' && (
                  !Number.isFinite(operation.value) || Math.abs(operation.value) > 1_000_000
                ))
                || (hasInputValue && (
                  !action.input
                  || operation.inputValue?.source !== 'input'
                  || operation.inputValue.encoding !== undefined
                  || (operation.inputValue.scale !== undefined
                    && !Number.isFinite(operation.inputValue.scale))
                  || (operation.inputValue.offset !== undefined
                    && !Number.isFinite(operation.inputValue.offset))
                  || (operation.inputValue.round !== undefined
                    && operation.inputValue.round !== 'nearest')
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
      if (route.transport === 'simbridge-mcdu') {
        const targetInput = MINIMUMS_INPUTS[route.target];
        if (adapterId !== 'fbw-a32nx' || !targetInput || action.id !== `approach.minimums.${route.target}`
          || action.guard.groupId !== 'fbwA32nx.approach.minimums'
          || Object.keys(route).some((key) => !['id', 'transport', 'target'].includes(key))
          || !Object.keys(targetInput).every((key) => action.input?.[key] === targetInput[key])) {
          throw new TypeError('Invalid A32NX MCDU minimums contract.');
        }
      }
      const readbacks = routeReadbacks.length > 0
        ? routeReadbacks
        : (route.readback ? [route.readback] : []);
      for (const readback of readbacks) {
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
          || (readback.freshness !== undefined && readback.freshness !== 'field')
        ) {
          throw new TypeError(`Aircraft integration "${adapterId}" has an invalid action readback.`);
        }
      }
      if (readbacks.length === 0 && !acknowledgesRequest && (
        route.transport === 'mobiflight-calculator'
        || route.transport === 'lvar'
        || route.transport === 'sdk'
        || (route.transport === 'simconnect-sequence'
          && route.confirmation !== 'transport-acknowledged')
      )) {
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
    const route = action.routes.find((candidate) => supportedTransports.has(candidate.transport)
      && (candidate.transport !== 'simconnect-sequence'
        || !candidate.requiredSdkAdapter || supportedTransports.has('sdk')));
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
