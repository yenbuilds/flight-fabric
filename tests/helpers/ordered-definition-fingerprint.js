'use strict';

const { createHash } = require('node:crypto');

// Migration fixtures include explicit undefined properties in resolved profiles.
// Tag values and retain every own key (including array length) so the hash cannot
// confuse omitted properties, undefined, null, reordered keys or negative zero.
function orderedDefinitionValue(value) {
  if (value === null) return ['null'];
  const type = typeof value;
  if (type === 'undefined') return ['undefined'];
  if (type === 'string' || type === 'boolean') return [type, value];
  if (type === 'number') {
    return ['number', Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value)];
  }
  if (type !== 'object') throw new TypeError(`Unsupported definition value: ${type}`);
  const entries = Reflect.ownKeys(value).map(key => {
    if (typeof key !== 'string') throw new TypeError('Definition symbols are unsupported');
    return [key, orderedDefinitionValue(value[key])];
  });
  return [Array.isArray(value) ? 'array' : 'object', entries];
}

function orderedDefinitionFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(orderedDefinitionValue(value))).digest('hex');
}

module.exports = { orderedDefinitionFingerprint, orderedDefinitionValue };
