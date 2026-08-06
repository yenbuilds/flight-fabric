// @ts-nocheck
'use strict';

(function initFlightPhases(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = exports;
  }
  if (root && typeof root === 'object') {
    root.FlightPhases = exports;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this),
  function createFlightPhases() {
    const PHASES = Object.freeze({
      UNKNOWN: 'UNKNOWN',
      PARKED: 'PARKED',
      TAXI: 'TAXI',
      TAKEOFF: 'TAKEOFF',
      CLIMB: 'CLIMB',
      CRUISE: 'CRUISE',
      DESCENT: 'DESCENT',
      APPROACH: 'APPROACH',
      LANDING: 'LANDING',
      TAXI_IN: 'TAXI-IN',
      GO_AROUND: 'GO_AROUND',
    });

    const PUBLISHED_PHASES = Object.freeze([
      PHASES.PARKED,
      PHASES.TAXI,
      PHASES.TAKEOFF,
      PHASES.CLIMB,
      PHASES.CRUISE,
      PHASES.DESCENT,
      PHASES.APPROACH,
      PHASES.LANDING,
      PHASES.TAXI_IN,
      PHASES.GO_AROUND,
    ]);

    const ALL_PHASES = Object.freeze([
      PHASES.UNKNOWN,
      ...PUBLISHED_PHASES,
    ]);

    return {
      PHASES,
      PUBLISHED_PHASES,
      ALL_PHASES,
    };
  }
);
