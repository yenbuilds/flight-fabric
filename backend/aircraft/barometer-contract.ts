/** Existing supported barometer command domains, shared by the opted-in adapters. */
export type BaroTarget = 'captain' | 'firstOfficer' | 'both';
export type BaroOperation = 'qnhHpa' | 'qnhInHg' | 'std';
const BARO_SIDES = ['captain', 'firstOfficer'] as const;
export const baroSides = (target: BaroTarget) => target === 'both' ? [...BARO_SIDES] : [target];
export const BARO_INPUTS = {
  qnhHpa: { type: 'number', min: 948, max: 1084, step: 1 },
  qnhInHg: { type: 'number', min: 27.99, max: 32.01, step: 0.01 },
} as const;
