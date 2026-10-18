import { createDocumentValidator, strictObject } from './integration-engine/definition-yaml.js';

type Cell = Readonly<{ row: number; column: number }>;
export type GuardedDisplayEntryRecipe = Readonly<{
  channel: 'left' | 'right';
  input: Readonly<{ min: number; max: number; step: 1 }>;
  page: Readonly<{
    titlePrefix: string;
    rowCount: number;
    labels: readonly Readonly<Cell & { equals: string }>[];
    fields: Readonly<Record<string, Readonly<Cell & { equals?: string }>>>;
  }>;
  valueField: string;
  clearFieldIds: readonly string[];
  availableWhen?: Readonly<{ fieldId: string; expectedValue: string | boolean }>;
  confirmKey: string;
  timing: Readonly<{
    timeoutMs: number; stepTimeoutMs: number; freshnessMs: number;
    settleMs: number; pollMs: number; handshakeTimeoutMs: number; maxPayload: number;
  }>;
  messages: Readonly<Record<'invalidValue' | 'stale' | 'timeout' | 'unavailable' | 'disconnected'
    | 'interference' | 'invalidPage' | 'connectTimeout' | 'pageRequired' | 'scratchpadOccupied'
    | 'fieldUnavailable' | 'entryChanged' | 'digitUnconfirmed' | 'commitChanged' | 'unconfirmed' | 'failed', string>>;
}>;

const identifier = { type: 'string', maxLength: 64, pattern: '^[a-z][A-Za-z0-9]*(?![\\s\\S])' };
const text = { type: 'string', minLength: 1, maxLength: 300 };
const cell = { row: { type: 'integer', minimum: 0, maximum: 23 }, column: { type: 'integer', minimum: 0, maximum: 3 } };
const duration = (max: number) => ({ type: 'integer', minimum: 1, maximum: max });
export const guardedDisplayEntrySchema = strictObject({
  channel: { enum: ['left', 'right'] },
  input: strictObject({ min: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    max: { type: 'integer', minimum: 0, maximum: 1_000_000 }, step: { const: 1 } }),
  page: strictObject({
    titlePrefix: { type: 'string', minLength: 1, maxLength: 64 },
    rowCount: { type: 'integer', minimum: 1, maximum: 24 },
    labels: { type: 'array', minItems: 1, maxItems: 16, items: strictObject({ ...cell, equals: text }) },
    fields: { type: 'object', minProperties: 1, maxProperties: 16, propertyNames: identifier,
      additionalProperties: strictObject({ ...cell, equals: text }, ['row', 'column']) },
  }),
  valueField: identifier,
  clearFieldIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: identifier },
  availableWhen: strictObject({ fieldId: identifier, expectedValue: { anyOf: [{ type: 'string' }, { type: 'boolean' }] } }),
  confirmKey: { type: 'string', pattern: '^[LR][1-6](?![\\s\\S])' },
  timing: strictObject({ timeoutMs: duration(30_000), stepTimeoutMs: duration(5_000),
    freshnessMs: duration(5_000), settleMs: duration(1_000), pollMs: duration(100),
    handshakeTimeoutMs: duration(5_000), maxPayload: { type: 'integer', minimum: 1, maximum: 65_536 } }),
  messages: strictObject(Object.fromEntries([
    'invalidValue', 'stale', 'timeout', 'unavailable', 'disconnected', 'interference', 'invalidPage',
    'connectTimeout', 'pageRequired', 'scratchpadOccupied', 'fieldUnavailable', 'entryChanged',
    'digitUnconfirmed', 'commitChanged', 'unconfirmed', 'failed',
  ].map(key => [key, text]))),
}, ['channel', 'input', 'page', 'valueField', 'clearFieldIds', 'confirmKey', 'timing', 'messages']);

const validate = createDocumentValidator<GuardedDisplayEntryRecipe>(guardedDisplayEntrySchema);

/** The same bounded recipe contract applies to YAML and programmatic registration. */
export function hasValidGuardedDisplayEntryRecipe(recipe: unknown, actionInput: unknown): recipe is GuardedDisplayEntryRecipe {
  if (!validate(recipe)) return false;
  const input = actionInput as { type?: unknown; min?: unknown; max?: unknown; step?: unknown } | null;
  if (!input || input.type !== 'number' || input.min !== recipe.input.min || input.max !== recipe.input.max
    || input.step !== recipe.input.step || recipe.input.min > recipe.input.max) return false;
  const { fields, labels, rowCount, titlePrefix } = recipe.page;
  if (titlePrefix.trim() !== titlePrefix || /[\r\n]/.test(titlePrefix)
    || [...Object.values(fields), ...labels].some(cell => cell.row >= rowCount)
    || !Object.hasOwn(fields, recipe.valueField) || fields[recipe.valueField].equals !== undefined
    || recipe.clearFieldIds.includes(recipe.valueField)
    || recipe.clearFieldIds.some(id => !Object.hasOwn(fields, id) || fields[id].equals !== undefined)) return false;
  if (recipe.availableWhen) {
    const field = fields[recipe.availableWhen.fieldId];
    if (!Object.hasOwn(fields, recipe.availableWhen.fieldId)
      || typeof recipe.availableWhen.expectedValue !== (field.equals === undefined ? 'string' : 'boolean')) return false;
  }
  const timing = recipe.timing;
  return timing.stepTimeoutMs <= timing.timeoutMs && timing.settleMs <= timing.stepTimeoutMs
    && timing.settleMs <= timing.freshnessMs && timing.pollMs <= timing.stepTimeoutMs;
}
