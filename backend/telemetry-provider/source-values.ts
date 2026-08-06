'use strict';

type AnyRecord = Record<string, any>;

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasMeaningfulSourceValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulSourceValue(item));
  if (isRecord(value)) return Object.values(value).some((item) => hasMeaningfulSourceValue(item));
  return false;
}

module.exports = {
  hasMeaningfulSourceValue,
  isRecord,
};

export {};
