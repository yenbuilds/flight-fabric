import { adapterIdSchema, logicalIdSchema, strictObject } from './definition-yaml.js';

const primitive = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] };
const unit = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9 _./:+%()-]{0,47}(?![\\s\\S])' };
const primitiveValues = { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: primitive };

/** Existing read contracts; source selection and decoding stay in the shared runtime. */
export const fieldDefinitionSchema = strictObject({
  id: logicalIdSchema,
  sources: {
    type: 'array', minItems: 1, maxItems: 16,
    items: strictObject({
      route: { oneOf: [
        strictObject({
          type: { const: 'sdk' }, adapter: adapterIdSchema,
          path: { type: 'string', maxLength: 512,
            pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}(\\.[A-Za-z][A-Za-z0-9_-]{0,63})*(?![\\s\\S])',
            not: { pattern: '(^|\\.)(__proto__|prototype|constructor)(\\.|$)' } },
        }),
        strictObject({
          type: { const: 'lvar' },
          name: { type: 'string', maxLength: 256,
            pattern: '^(L:[A-Za-z0-9_][A-Za-z0-9_:.]*|A:[A-Z][A-Z0-9 _:.]*)(?![\\s\\S])' },
          unit,
        }),
        strictObject({
          type: { const: 'simvar' },
          name: { type: 'string', pattern: '^[A-Z][A-Z0-9 _:.]{0,126}(?![\\s\\S])' }, unit,
        }),
        strictObject({ type: { const: 'input-event' },
          name: { type: 'string', pattern: '^[A-Za-z0-9_:.]{1,63}(?![\\s\\S])' } }),
      ] },
      decode: { oneOf: [
        strictObject({ type: { const: 'squawk-bco16' } }),
        strictObject({ type: { const: 'number' },
          precision: { type: 'integer', minimum: 0, maximum: 6 },
          offset: { type: 'number' }, scale: { type: 'number' },
          unavailableValues: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'number' } },
        }, ['type']),
        strictObject({ type: { const: 'boolean' }, trueValues: primitiveValues, falseValues: primitiveValues }),
        strictObject({ type: { const: 'enum' }, numberRanges: {
          type: 'array', minItems: 1, maxItems: 16,
          items: strictObject({ min: { type: 'number' }, max: { type: 'number' }, value: primitive }),
        }, values: {
          type: 'object', minProperties: 1, maxProperties: 1024,
          propertyNames: { type: 'string', minLength: 1, maxLength: 128 }, additionalProperties: primitive,
        } }, ['type', 'values']),
      ] },
    }),
  },
});
