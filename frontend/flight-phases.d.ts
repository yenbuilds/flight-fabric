export const PHASES: {
  readonly UNKNOWN: 'UNKNOWN';
  readonly PARKED: 'PARKED';
  readonly TAXI: 'TAXI';
  readonly TAKEOFF: 'TAKEOFF';
  readonly CLIMB: 'CLIMB';
  readonly CRUISE: 'CRUISE';
  readonly DESCENT: 'DESCENT';
  readonly APPROACH: 'APPROACH';
  readonly LANDING: 'LANDING';
  readonly TAXI_IN: 'TAXI-IN';
  readonly GO_AROUND: 'GO_AROUND';
};

export type PhaseMap = typeof PHASES;
export type PhaseValue = PhaseMap[keyof PhaseMap];

export const PUBLISHED_PHASES: readonly [
  'PARKED',
  'TAXI',
  'TAKEOFF',
  'CLIMB',
  'CRUISE',
  'DESCENT',
  'APPROACH',
  'LANDING',
  'TAXI-IN',
  'GO_AROUND',
];

export const ALL_PHASES: readonly [
  'UNKNOWN',
  'PARKED',
  'TAXI',
  'TAKEOFF',
  'CLIMB',
  'CRUISE',
  'DESCENT',
  'APPROACH',
  'LANDING',
  'TAXI-IN',
  'GO_AROUND',
];

declare const phaseRegistry: {
  readonly PHASES: typeof PHASES;
  readonly PUBLISHED_PHASES: typeof PUBLISHED_PHASES;
  readonly ALL_PHASES: typeof ALL_PHASES;
};

export default phaseRegistry;
