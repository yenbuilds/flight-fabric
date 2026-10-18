import type { AnySchema } from 'ajv';
import { createDocumentValidator, logicalIdSchema, strictObject } from './integration-engine/definition-yaml.js';

type Scalar = string | number | boolean;
export type ControlObservation = {
  fieldId: string;
  type: 'boolean' | 'boolean01' | 'enum' | 'number';
  values?: Scalar[];
  optional?: true;
  rounding?: { property: string; equals: Scalar; scale: number; otherwise: number };
};
export type ControlCondition = { property: string; equals?: Scalar; input?: true; scale?: number };
type StageBase = { phase: string; property: string; conditions: ControlCondition[]; invalidate?: string };
type Freeze = { conditions: ControlCondition[]; message: string };
export type ControlStage =
  | StageBase & { kind: 'ensure'; write: string; confirmation: 'written' | 'affected'; freeze?: Freeze }
  | StageBase & { kind: 'transition'; write: string; maxTransitions: number; completion: ControlCondition[]; freeze: Freeze }
  | StageBase & { kind: 'step'; decrease: string; increase: string; scale: number; min: number; max: number; maxSteps: number };
export type StagedControlRecipe = {
  sampling: 'raw' | 'decoded'; freshnessMs: number;
  prerequisites: (ControlObservation & { equals: Scalar })[];
  targets: { id: string; observations: Record<string, ControlObservation>; writes: Record<string, number> }[];
  input?: { min: number; max: number; step: number; validation: 'offset-step' | 'scaled-integer'; scale: number };
  stages: ControlStage[]; final: ControlCondition[];
  timing: { readbackTimeoutMs: number; pollMs: number; totalTimeoutMs?: number };
  errors: { staleContext: string; failed: string; unavailable: string; transportRejected: string; writeRejected: string; invalidInput: string;
    timeout: string; timeLimit: string; finalChanged: string; outOfRange: string; missingValue: string;
    unexpectedStep: string; valueChanged: string };
};

const scalar = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] };
const key = { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9]{0,63}(?![\\s\\S])' };
const message = { type: 'string', minLength: 1, maxLength: 256 };
const number = { type: 'number', minimum: -1_000_000, maximum: 1_000_000 };
const positive = { type: 'number', exclusiveMinimum: 0, maximum: 1_000_000 };
const array = (items: AnySchema, maxItems = 8) => ({ type: 'array', minItems: 1, maxItems, items });
const observationProperties = {
  fieldId: logicalIdSchema, type: { enum: ['boolean', 'boolean01', 'enum', 'number'] },
  values: { ...array(scalar, 16), uniqueItems: true }, optional: { const: true },
  rounding: strictObject({ property: key, equals: scalar, scale: positive, otherwise: positive }),
};
const observation = strictObject(observationProperties, ['fieldId', 'type']);
const condition = { oneOf: [
  strictObject({ property: key, equals: scalar }),
  strictObject({ property: key, input: { const: true }, scale: positive }, ['property', 'input']),
] };
const conditions = array(condition);
const freeze = strictObject({ conditions, message });
const stage = { phase: message, property: key, conditions, invalidate: key };
const stageRequired = ['kind', 'phase', 'property', 'conditions'];
const dictionary = (values: AnySchema) => ({ type: 'object', minProperties: 1, maxProperties: 8,
  propertyNames: key, additionalProperties: values });
export const stagedControlSchema: AnySchema = strictObject({
  sampling: { enum: ['raw', 'decoded'] }, freshnessMs: { type: 'integer', minimum: 1, maximum: 30_000 },
  prerequisites: array(strictObject({ ...observationProperties, equals: scalar }, ['fieldId', 'type', 'equals'])),
  targets: array(strictObject({ id: key, observations: dictionary(observation),
    writes: dictionary({ type: 'integer', minimum: 0, maximum: 15 }) }), 8),
  input: strictObject({ min: number, max: number, step: positive,
    validation: { enum: ['offset-step', 'scaled-integer'] }, scale: positive }),
  stages: array({ oneOf: [
    strictObject({ ...stage, kind: { const: 'ensure' }, write: key,
      confirmation: { enum: ['written', 'affected'] }, freeze }, [...stageRequired, 'write', 'confirmation']),
    strictObject({ ...stage, kind: { const: 'transition' }, write: key,
      maxTransitions: { type: 'integer', minimum: 1, maximum: 8 }, completion: conditions, freeze },
    [...stageRequired, 'write', 'maxTransitions', 'completion', 'freeze']),
    strictObject({ phase: message, property: key, conditions, kind: { const: 'step' }, decrease: key, increase: key, scale: positive,
      min: number, max: number, maxSteps: { type: 'integer', minimum: 1, maximum: 1000 } },
    [...stageRequired, 'decrease', 'increase', 'scale', 'min', 'max', 'maxSteps']),
  ] }), final: conditions,
  timing: strictObject({ readbackTimeoutMs: { type: 'integer', minimum: 1, maximum: 30_000 },
    pollMs: { type: 'integer', minimum: 1, maximum: 1000 },
    totalTimeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 } }, ['readbackTimeoutMs', 'pollMs']),
  errors: strictObject(Object.fromEntries(['staleContext', 'failed', 'unavailable', 'transportRejected', 'writeRejected', 'invalidInput',
    'timeout', 'timeLimit', 'finalChanged', 'outOfRange', 'missingValue', 'unexpectedStep', 'valueChanged'].map(k => [k, message]))),
}, ['sampling', 'freshnessMs', 'prerequisites', 'targets', 'stages', 'final', 'timing', 'errors']);

const validShape = createDocumentValidator<StagedControlRecipe>(stagedControlSchema);

/** Validate references and consumed operations, not aircraft names or duplicate write recipes. */
export function hasValidStagedControl(definition: any, action: any, route: any): boolean {
  const recipe: StagedControlRecipe = route.stagedControl;
  if (!validShape(recipe) || action.guard?.retry !== 'never') return false;
  if (recipe.timing.pollMs > recipe.timing.readbackTimeoutMs
    || (recipe.timing.totalTimeoutMs !== undefined && recipe.timing.totalTimeoutMs < recipe.timing.readbackTimeoutMs)) return false;
  if (new Set(recipe.targets.map(t => t.id)).size !== recipe.targets.length) return false;
  if (recipe.input ? (!action.input || action.input.type !== 'number' || recipe.input.min > recipe.input.max
    || ['min', 'max', 'step'].some(k => recipe.input[k] !== action.input[k])) : action.input !== undefined) return false;
  const writes = route.transport === 'simconnect-sequence' ? route.operations
    : route.transport === 'mobiflight-calculator' && route.mode === 'staged-control' ? route.codes : null;
  if (!Array.isArray(writes)) return false;
  if (route.transport === 'simconnect-sequence' && writes.some(w => !['event', 'lvar'].includes(w.type)
    || w.parameters !== undefined || (w.inputValue && (w.inputValue.encoding !== undefined || !recipe.input)))) return false;
  const observationValid = (o: ControlObservation) => Object.hasOwn(definition.fields, o.fieldId)
    && (o.type === 'enum' ? !!o.values : o.values === undefined)
    && (o.rounding === undefined || o.type === 'number')
    && (recipe.sampling !== 'decoded' || o.type !== 'boolean01');
  const valueFits = (o: ControlObservation, value: unknown) => o.type === 'enum' ? o.values.includes(value as Scalar)
    : o.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === 'boolean';
  if (recipe.prerequisites.some(o => !observationValid(o) || o.optional || o.rounding || !valueFits(o, o.equals))) return false;
  const observedFields = recipe.targets.flatMap(t => Object.values(t.observations).map(o => o.fieldId));
  if (new Set(observedFields).size !== observedFields.length) return false;
  const usedIndices: number[] = [];
  for (const target of recipe.targets) {
    const observations = target.observations;
    if (Object.values(observations).some(o => !observationValid(o)
      || (o.rounding && (!Object.hasOwn(observations, o.rounding.property)
        || !valueFits(observations[o.rounding.property], o.rounding.equals))))) return false;
    const check = (cs: ControlCondition[]) => cs.every(c => Object.hasOwn(observations, c.property)
      && (c.input ? !!recipe.input && observations[c.property].type === 'number' : valueFits(observations[c.property], c.equals)));
    if (!check(recipe.final)) return false;
    const usedKeys = new Set<string>();
    for (const s of recipe.stages) {
      if (!Object.hasOwn(observations, s.property) || !check(s.conditions)
        || (s.invalidate && !Object.hasOwn(observations, s.invalidate))) return false;
      if (s.kind === 'step') {
        if (!recipe.input || s.invalidate !== undefined || s.min !== recipe.input.min || s.max !== recipe.input.max || s.scale !== recipe.input.scale
          || observations[s.property].type !== 'number' || s.conditions.length !== 1
          || s.conditions[0].property !== s.property || !s.conditions[0].input || s.conditions[0].scale !== s.scale) return false;
        usedKeys.add(s.decrease); usedKeys.add(s.increase);
      } else {
        usedKeys.add(s.write);
        if (s.freeze && !check(s.freeze.conditions)) return false;
        if (s.kind === 'transition' && !check(s.completion)) return false;
      }
    }
    if (usedKeys.size !== Object.keys(target.writes).length) return false;
    for (const write of usedKeys) {
      const index = target.writes[write];
      if (!Number.isSafeInteger(index) || index < 0 || index >= writes.length) return false;
      usedIndices.push(index);
    }
    // Every declared confirmation is represented by the final conditions or a prerequisite.
    for (const c of recipe.final) {
      const fieldId = observations[c.property].fieldId;
      if (!route.readbacks?.some(r => r.fieldId === fieldId && (c.input ? r.expectedInput === true : r.expectedValue === c.equals))) return false;
    }
  }
  if (new Set(usedIndices).size !== writes.length || usedIndices.length !== writes.length) return false;
  return recipe.prerequisites.every(p => route.readbacks?.some(r => r.fieldId === p.fieldId && r.expectedValue === p.equals))
    && route.readbacks.every(r => r.timeoutMs === recipe.timing.readbackTimeoutMs
      && (recipe.prerequisites.some(p => p.fieldId === r.fieldId)
        || recipe.targets.some(t => recipe.final.some(c => t.observations[c.property].fieldId === r.fieldId))));
}
