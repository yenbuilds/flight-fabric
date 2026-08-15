'use strict';

import type {
  AircraftIntegrationAction,
  AircraftIntegrationReadback,
} from './types.js';

const DEFAULT_COOLDOWN_MS = 750;
const DEFAULT_READBACK_TIMEOUT_MS = 3000;
const AXIS_MIDPOINT_SCALE = 8192;

const FBW_FORWARD_THROTTLE_DETENTS = Object.freeze([
  Object.freeze({ suffix: 'idle', mappingName: 'IDLE', expectedTla: 0 }),
  Object.freeze({ suffix: 'climb', mappingName: 'CLIMB', expectedTla: 25 }),
  Object.freeze({ suffix: 'flexMct', mappingName: 'FLEXMCT', expectedTla: 35 }),
  Object.freeze({ suffix: 'toga', mappingName: 'TOGA', expectedTla: 45 }),
]);

function mappingLvar(mappingName: string, bound: 'LOW' | 'HIGH', index: number): string {
  return `A32NX_THROTTLE_MAPPING_${mappingName}_${bound}:${index}`;
}

function registerIndexes(index: number): Readonly<{ high: number; low: number }> {
  const low = (index - 1) * 2;
  return Object.freeze({ low, high: low + 1 });
}

function loadAndValidateWindowCode(mappingName: string, index: number): string {
  const low = mappingLvar(mappingName, 'LOW', index);
  const high = mappingLvar(mappingName, 'HIGH', index);
  const registers = registerIndexes(index);
  return [
    `(L:${low},Number) sp${registers.low}`,
    `(L:${high},Number) sp${registers.high}`,
    `l${registers.low} -1 >=`,
    `l${registers.high} 1 <=`,
    'and',
    `l${registers.low} l${registers.high} <`,
    'and',
  ].join(' ');
}

function cachedAxisWriteCode(index: number): string {
  const registers = registerIndexes(index);
  return [
    `l${registers.low}`,
    `l${registers.high}`,
    '+',
    `${AXIS_MIDPOINT_SCALE} *`,
    `(>K:THROTTLE${index}_AXIS_SET_EX1)`,
  ].join(' ');
}

function calibratedDetentCode(mappingName: string, leverCount: number): string {
  const indexes = Array.from({ length: leverCount }, (_, offset) => offset + 1);
  // `spN`/`lN` are documented MSFS calculator-code registers. Loading each
  // bound once keeps the fail-closed four-lever expression inside MobiFlight's
  // fixed Command ClientData envelope without splitting it into partial writes.
  const windowConditions = indexes.map((index) => loadAndValidateWindowCode(mappingName, index));
  const combinedConditions = [
    ...windowConditions,
    ...Array.from({ length: Math.max(0, windowConditions.length - 1) }, () => 'and'),
  ].join(' ');
  const writes = indexes.map((index) => cachedAxisWriteCode(index)).join(' ');
  return `${combinedConditions} if{ ${writes} }`;
}

function addFbwCalibratedThrottleDetentActions(params: {
  actions: Record<string, AircraftIntegrationAction>;
  adapterPrefix: 'fbwA32nx' | 'fbwA380x';
  leverCount: 2 | 4;
}): void {
  for (const detent of FBW_FORWARD_THROTTLE_DETENTS) {
    const actionId = `propulsion.throttle.${detent.suffix}`;
    const readbacks: AircraftIntegrationReadback[] = Array.from(
      { length: params.leverCount },
      (_, offset) => ({
        fieldId: `propulsion.throttleLever${offset + 1}Angle`,
        expectedValue: detent.expectedTla,
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      }),
    );
    params.actions[actionId] = {
      id: actionId,
      guard: {
        cooldownMs: DEFAULT_COOLDOWN_MS,
        groupId: `${params.adapterPrefix}.propulsion.throttle`,
        retry: 'never',
      },
      routes: [{
        id: `${params.adapterPrefix}.${actionId}.calibratedCalculator`,
        transport: 'mobiflight-calculator',
        mode: 'single',
        code: calibratedDetentCode(detent.mappingName, params.leverCount),
        readbacks,
      }],
      verification: 'untested',
    };
  }
}

module.exports = {
  FBW_FORWARD_THROTTLE_DETENTS,
  addFbwCalibratedThrottleDetentActions,
  calibratedDetentCode,
};

export {};
