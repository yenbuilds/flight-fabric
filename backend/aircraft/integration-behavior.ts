import type { AircraftIntegrationDefinition } from './integration-engine/types.js';
import { createDocumentValidator, logicalIdSchema, strictObject } from './integration-engine/definition-yaml.js';

export type FlightGuidanceRecipe = {
  id: string; version: number; eventType: string; lane: string; source: string;
  profileLeaves: string[]; modeSettleMs: number; targetSettleMs: number;
  maxEvents: number; maxCoverageIntervals: number; dedupeWindowMs: number;
  lateralModes: string[]; verticalModes: string[]; automationModeAliases: Record<string, string>;
  fields: Record<string, string>; booleanModes: { fieldId: string; label: string }[];
  targetLabelPrefix: string;
};
type OverlayInput = { key: string; allowed: number[] } | { key: string; min: number; max: number; coerceNumber?: boolean };
export type LightingOverlayRecipe = {
  snapshotStatus: string; freshnessMs: number; futureToleranceMs: number;
  inputs: Record<string, OverlayInput>;
  outputs: Record<string, { any: { input: string; equals: number }[] }>;
};
export type IntegrationBehavior = {
  keyEventPolicy?: { eventGroups: Record<string, string>; cooldownMs: number; inFlightError: string; cooldownError: string };
  readbackFailureHints?: { actionPrefix: string; text: string }[];
  lightingOverlay?: LightingOverlayRecipe;
  flightGuidanceProjection?: FlightGuidanceRecipe;
};

const text = { type: 'string', minLength: 1, maxLength: 1024 };
const name = { type: 'string', pattern: '^[a-z][A-Za-z0-9]*(?![\\s\\S])' };
const strings = { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: text };
const milliseconds = { type: 'number', minimum: 0, maximum: 60_000 };
const count = { type: 'integer', minimum: 1, maximum: 100_000 };
const number = { type: 'number', minimum: -1_000_000, maximum: 1_000_000 };
const fields = ['apEngaged', 'athrArmed', 'lnav', 'vnav', 'flch', 'headingHold', 'verticalSpeed', 'altitudeHold',
  'localizer', 'approach', 'speedKts', 'mach', 'headingDeg', 'altitudeFt', 'vsFpm', 'fpaDeg', 'headingMode', 'verticalMode'];
const flightGuidanceProjection = strictObject({
  id: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?(?![\\s\\S])' },
  version: { type: 'integer', minimum: 1 }, eventType: text, lane: text,
  source: { enum: ['sdk', 'lvar', 'simvar', 'input-event'] }, profileLeaves: strings,
  modeSettleMs: milliseconds, targetSettleMs: milliseconds, maxEvents: count, maxCoverageIntervals: count,
  dedupeWindowMs: milliseconds, lateralModes: strings, verticalModes: strings,
  automationModeAliases: { type: 'object', minProperties: 1, maxProperties: 64, additionalProperties: text },
  fields: strictObject(Object.fromEntries(fields.map(field => [field, logicalIdSchema]))),
  booleanModes: { type: 'array', minItems: 1, maxItems: 32, items: strictObject({ fieldId: logicalIdSchema, label: text }) },
  targetLabelPrefix: text,
});
const lightingOverlay = strictObject({
  snapshotStatus: { enum: ['running', 'connected'] }, freshnessMs: milliseconds, futureToleranceMs: milliseconds,
  inputs: { type: 'object', minProperties: 1, maxProperties: 64, propertyNames: name, additionalProperties: {
    oneOf: [strictObject({ key: text, allowed: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: number } }),
      strictObject({ key: text, min: number, max: number, coerceNumber: { type: 'boolean' } }, ['key', 'min', 'max'])],
  } },
  outputs: { type: 'object', minProperties: 1, maxProperties: 16,
    propertyNames: { enum: ['nav', 'beacon', 'strobe', 'logo', 'landing', 'taxi', 'turnoff'] },
    additionalProperties: strictObject({ any: { type: 'array', minItems: 1, maxItems: 16,
      items: strictObject({ input: name, equals: number }) } }),
  },
});
export const integrationBehaviorSchema = strictObject({
  keyEventPolicy: strictObject({
    eventGroups: { type: 'object', minProperties: 1, maxProperties: 128,
      propertyNames: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*(?![\\s\\S])' }, additionalProperties: name },
    cooldownMs: milliseconds, inFlightError: text, cooldownError: text,
  }),
  readbackFailureHints: { type: 'array', minItems: 1, maxItems: 32, items: strictObject({ actionPrefix: text, text }) },
  lightingOverlay, flightGuidanceProjection,
}, []);
const validate = createDocumentValidator<IntegrationBehavior>(integrationBehaviorSchema);

/** Shared metadata validation also covers definitions registered without the YAML loader. */
export function assertIntegrationBehavior(definition: AircraftIntegrationDefinition) {
  const behavior = definition.behavior;
  if (behavior === undefined) return;
  if (!validate(behavior)) throw new TypeError(`Invalid integration behavior for "${definition.id}".`);
  const overlay = behavior.lightingOverlay;
  if (overlay && (Object.values(overlay.inputs).some(input => 'min' in input && input.min > input.max)
    || Object.values(overlay.outputs).some(output => output.any.some(condition => !Object.hasOwn(overlay.inputs, condition.input))))) {
    throw new TypeError(`Invalid lighting overlay references for "${definition.id}".`);
  }
  const projection = behavior.flightGuidanceProjection;
  const projectedFields = new Set(projection ? Object.values(projection.fields) : []);
  const trustedLeaves = new Set(definition.trustedProfileKeys.map(key => key.split('/').at(-1)));
  if (projection && ([...Object.values(projection.fields), ...projection.booleanModes.map(mode => mode.fieldId)]
    .some(fieldId => !Object.hasOwn(definition.fields, fieldId))
    || new Set(projection.booleanModes.map(mode => mode.fieldId)).size !== projection.booleanModes.length
    || projection.booleanModes.some(mode => !projectedFields.has(mode.fieldId))
    || projection.profileLeaves.some(leaf => !trustedLeaves.has(leaf)))) {
    throw new TypeError(`Invalid flight guidance references for "${definition.id}".`);
  }
}
