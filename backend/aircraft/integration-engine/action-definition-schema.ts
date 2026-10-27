import type { AnySchema } from 'ajv';
import { guardedDisplayEntrySchema } from '../guarded-display-entry-contract.js';
import { stagedControlSchema } from '../staged-control-contract.js';
import { MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH } from '../../utils/mobiflight-protocol.js';
import { adapterIdSchema, logicalIdSchema, strictObject } from './definition-yaml.js';

// Structural validation for the existing execution contract. Cross-field and
// aircraft-specific rules remain in defineAircraftIntegration; this schema
// cannot authorize a new recipe or relax the registry's execution bounds.
const number = { type: 'number' };
const boundedNumber = { type: 'number', minimum: -1_000_000, maximum: 1_000_000 };
const booleanOrNumber = { anyOf: [{ type: 'boolean' }, boundedNumber] };
const primitive = { anyOf: [{ type: 'string' }, number, { type: 'boolean' }] };
const routeId = { type: 'string', pattern: '^[a-z0-9][A-Za-z0-9.-]{0,127}(?![\\s\\S])' };
const unit = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9 _./:+%()-]{0,47}(?![\\s\\S])' };
const lvar = { type: 'string', pattern: '^L:[A-Za-z0-9][A-Za-z0-9_:.]{0,126}(?![\\s\\S])' };
const event = { type: 'string', pattern: '^(?:[A-Z][A-Z0-9_:.]{0,79}|#[0-9]{5})(?![\\s\\S])' };
const calculatorCode = {
  type: 'string', minLength: 1, maxLength: MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH,
  pattern: '^[\\x20-\\x7e]+(?![\\s\\S])',
};
const inputValue = strictObject({
  source: { const: 'input' }, scale: number, offset: number, round: { const: 'nearest' },
}, ['source']);
const encodedInputValue = strictObject({
  source: { const: 'input' }, encoding: { enum: ['frequency-bcd16', 'squawk-bco16'] },
});
const numberInput = strictObject({
  type: { const: 'number' }, min: boundedNumber, max: boundedNumber,
  step: { type: 'number', exclusiveMinimum: 0, maximum: 1_000_000 },
});
const readbackBase = {
  fieldId: logicalIdSchema, timeoutMs: { type: 'number', minimum: 0, maximum: 30_000 },
  freshness: { const: 'field' },
  readyWhen: strictObject({ fieldId: logicalIdSchema, expectedValue: primitive, freshness: { const: 'field' } }),
};
const readbackRequired = ['fieldId', 'timeoutMs'];
const fixedReadback = strictObject({ ...readbackBase, expectedValue: primitive },
  [...readbackRequired, 'expectedValue']);
const targetReadback = strictObject({ ...readbackBase, expectedInput: { const: true } },
  [...readbackRequired, 'expectedInput']);
const readback = { oneOf: [
  fixedReadback, targetReadback,
  strictObject({ ...readbackBase, confirmation: { const: 'changed' } }, [...readbackRequired, 'confirmation']),
] };
const actionSchemaId = 'urn:flightfabric:action-definition';
const reference = (name: string) => ({ $ref: `${actionSchemaId}#/definitions/${name}` });
const precondition = strictObject({
  fieldId: logicalIdSchema, expectedValue: primitive, freshness: { const: 'field' },
}, ['fieldId', 'expectedValue']);
const freshPrecondition = strictObject({
  fieldId: logicalIdSchema, expectedValue: primitive, freshness: { const: 'field' },
});
const failureHint = { type: 'string', minLength: 1, maxLength: 240, pattern: '^[\\x20-\\x7e]+(?![\\s\\S])' };
const condition = { oneOf: [strictObject({
  ...freshPrecondition.properties, failureHint,
}, freshPrecondition.required), strictObject({
  fieldId: logicalIdSchema, freshness: { const: 'field' }, min: number, max: number, failureHint,
}, ['fieldId', 'freshness', 'min', 'max'])] };
const baro = strictObject({
  target: { enum: ['captain', 'firstOfficer', 'both'] }, operation: { enum: ['qnhHpa', 'qnhInHg', 'std'] },
});
const arrayOf = (items: AnySchema, minItems: number, maxItems: number) => ({
  type: 'array', minItems, maxItems, items,
});
type Properties = Record<string, AnySchema>;
function observedRoutes(properties: Properties, required: string[], maxReadbacks = 4, sample: AnySchema = reference('readback')) {
  return [
    strictObject({ ...properties, readback: sample }, [...required, 'readback']),
    strictObject({ ...properties, readbacks: arrayOf(sample, 2, maxReadbacks) }, [...required, 'readbacks']),
  ];
}
function acknowledgedRoute(properties: Properties, required: string[]) {
  return strictObject({ ...properties, confirmation: { const: 'transport-acknowledged' } },
    [...required, 'confirmation']);
}

const operation = { oneOf: [
  ...[strictObject({ value: boundedNumber }), strictObject({ inputValue: { oneOf: [inputValue, encodedInputValue] } })]
    .map(payload => strictObject({
      type: { const: 'event' }, name: event,
      parameters: arrayOf({ oneOf: [boundedNumber, inputValue] }, 0, 4), ...payload.properties,
    }, ['type', 'name', ...payload.required])),
  ...[strictObject({ value: booleanOrNumber }), strictObject({ inputValue })]
    .map(payload => strictObject({ type: { const: 'lvar' }, name: lvar, unit, ...payload.properties })),
  strictObject({ type: { const: 'delay' }, milliseconds: { type: 'integer', minimum: 1, maximum: 10_000 } }),
  strictObject({
    type: { const: 'simvar' }, unit, value: booleanOrNumber,
    name: { type: 'string', pattern: '^(?![AL]:)[A-Z][A-Z0-9 _:.]{0,126}(?![\\s\\S])' },
  }),
] };

const sequence = {
  id: routeId, transport: { const: 'simconnect-sequence' },
  operations: arrayOf(reference('operation'), 1, 8), requiredSdkAdapter: adapterIdSchema,
  precondition, prepareEvent: strictObject({ name: event, value: boundedNumber }),
};
const sequenceRequired = ['id', 'transport', 'operations'];
const conditionalWrites = strictObject({
  freshnessMs: { type: 'number', minimum: 1, maximum: 30_000 },
  targets: arrayOf(strictObject({
    id: { type: 'string', maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9]*(?![\\s\\S])' },
    operationIndex: { type: 'integer', minimum: 0, maximum: 7 },
    prerequisiteFieldIds: { ...arrayOf(logicalIdSchema, 1, 8), uniqueItems: true },
    readbackFieldId: logicalIdSchema,
  }), 1, 8),
});
const calculatorBase = { id: routeId, transport: { const: 'mobiflight-calculator' } };
const single = { ...calculatorBase, code: calculatorCode, mode: { const: 'single' } };
const pulseBase = {
  ...calculatorBase, mode: { const: 'pulse' }, precondition,
  delayMs: { type: 'integer', minimum: 1, maximum: 1_000 },
};
const directPulse = { ...pulseBase, pressCode: calculatorCode, releaseCode: calculatorCode };
const pulseRequired = ['id', 'transport', 'mode', 'delayMs'];
const directPulseRequired = [...pulseRequired, 'pressCode', 'releaseCode'];
const step = strictObject({
  ...calculatorBase, mode: { const: 'step-to-target' },
  decreaseCode: calculatorCode, increaseCode: calculatorCode,
  maxSteps: { type: 'integer', minimum: 1, maximum: 500 }, circular: { const: true },
  prepareCode: calculatorCode, precondition, primeCode: calculatorCode,
  // The wire receives a substituted integer; the registry checks the exact
  // placeholder and resulting calculator expression before execution.
  batchDecreaseCode: { ...calculatorCode, maxLength: MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH + 6 },
  batchIncreaseCode: { ...calculatorCode, maxLength: MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH + 6 },
  maxBatchSteps: { type: 'integer', minimum: 2, maximum: 500 }, readback: targetReadback,
}, ['id', 'transport', 'mode', 'decreaseCode', 'increaseCode', 'maxSteps', 'readback']);
const sdkBase = {
  id: routeId, transport: { const: 'sdk' }, adapter: adapterIdSchema,
  command: { type: 'string', pattern: '^[A-Za-z0-9 _./:#+%()-]{1,160}(?![\\s\\S])' },
};
const sdkRequired = ['id', 'transport', 'adapter', 'command'];
const sdkPayloads: Properties[] = [
  { value: primitive }, { values: arrayOf(primitive, 1, 4) }, { inputValue },
];
const inputEvent = { type: 'string', pattern: '^[A-Za-z0-9_:.]{1,63}(?![\\s\\S])' };
const inputEventBase = { id: routeId, transport: { const: 'input-event' }, precondition: freshPrecondition };
const freshReadback = { oneOf: readback.oneOf.map(shape => ({
  ...shape, required: [...shape.required, 'freshness'],
})) };

const routeSchemas = [
  ...observedRoutes(single, ['id', 'transport', 'code']),
  ...observedRoutes(directPulse, directPulseRequired, 4, reference('fixedReadback')),
  acknowledgedRoute(directPulse, directPulseRequired),
  ...observedRoutes({ ...pulseBase, pulses: arrayOf(strictObject({
    when: arrayOf(freshPrecondition, 1, 8), pressCode: calculatorCode, releaseCode: calculatorCode,
  }), 1, 8) }, [...pulseRequired, 'pulses'], 4, reference('fixedReadback')),
  { ...step, dependencies: {
    prepareCode: ['precondition'],
    batchDecreaseCode: ['batchIncreaseCode', 'maxBatchSteps'],
    batchIncreaseCode: ['batchDecreaseCode', 'maxBatchSteps'],
    maxBatchSteps: ['batchDecreaseCode', 'batchIncreaseCode'],
  } },
  strictObject({ ...calculatorBase, mode: { const: 'staged-control' }, stagedControl: reference('stagedControl'), baro,
    codes: arrayOf(calculatorCode, 1, 8), readbacks: arrayOf(reference('readback'), 2, 7) }),
  strictObject({ id: routeId, transport: { const: 'lvar' }, lvar, unit,
    value: booleanOrNumber, readback: reference('readback') }),
  ...sdkPayloads.flatMap(payload => {
    const properties = { ...sdkBase, ...payload };
    const required = [...sdkRequired, ...Object.keys(payload)];
    return [strictObject({ ...properties, readback: reference('readback') }, [...required, 'readback']),
      acknowledgedRoute(properties, required)];
  }),
  ...observedRoutes(sequence, sequenceRequired),
  acknowledgedRoute(sequence, sequenceRequired),
  strictObject({ ...sequence, baro, conditionalWrites, stagedControl: reference('stagedControl'), readbacks: arrayOf(reference('readback'), 2, 9) },
    [...sequenceRequired, 'baro', 'readbacks']),
  strictObject({ ...sequence, comRadio: strictObject({
    index: { enum: [1, 2] }, operation: { enum: ['setStandby', 'swap', 'switchTo'] },
  }), readback: reference('readback') }, [...sequenceRequired, 'comRadio', 'readback']),
  ...observedRoutes({ ...inputEventBase, inputEvent, value: number },
    ['id', 'transport', 'inputEvent', 'value'], 4, freshReadback),
  strictObject({ ...inputEventBase, events: arrayOf(strictObject({ inputEvent, value: number }), 2, 4),
    readbacks: arrayOf(freshReadback, 2, 4) }, ['id', 'transport', 'events', 'readbacks']),
  strictObject({ id: routeId, transport: { const: 'simbridge-mcdu' }, target: { enum: ['baro', 'radio'] }, displayEntry: guardedDisplayEntrySchema }),
];
export const actionDefinitionSchema: AnySchema = {
  $id: actionSchemaId,
  definitions: { readback, fixedReadback, operation, stagedControl: stagedControlSchema,
    ...Object.fromEntries(routeSchemas.map((schema, index) => [`route${index}`, schema])),
  },
  ...strictObject({
    id: logicalIdSchema,
    guard: strictObject({
      cooldownMs: { type: 'number', minimum: 0, maximum: 60_000 },
      groupId: logicalIdSchema, retry: { const: 'never' }, skipIfSatisfied: { type: 'boolean' },
      skipWhen: arrayOf(strictObject({ fieldId: logicalIdSchema, expectedValue: primitive }), 1, 4),
      requires: arrayOf(condition, 1, 8),
    }, ['cooldownMs', 'groupId', 'retry']),
    input: numberInput,
    routes: { type: 'array', minItems: 1, items: { oneOf: routeSchemas.map((schema, index) => reference(`route${index}`)) } },
    verification: { enum: ['untested', 'partial', 'verified'] },
  }, ['id', 'guard', 'routes', 'verification']),
};
