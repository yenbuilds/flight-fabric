'use strict';

function usesInt32SimConnectData(unit: string): boolean {
  return unit === 'bool' || unit === 'enum' || unit === 'mask';
}

function simConnectUnitString(unit: string): string {
  if (unit === 'bool') return 'Bool';
  if (unit === 'enum') return 'Enum';
  if (unit === 'mask') return 'Mask';
  return unit;
}

module.exports = {
  simConnectUnitString,
  usesInt32SimConnectData,
};

export {};
