import type { PhaseMap, PhaseValue } from '../../shared/flight-phases';

'use strict';

type PhaseRegistry = {
  PHASES: Readonly<PhaseMap>;
  PUBLISHED_PHASES: readonly PhaseValue[];
  ALL_PHASES: readonly PhaseValue[];
};

const {
  PHASES,
  PUBLISHED_PHASES,
  ALL_PHASES,
} = require('../../shared/flight-phases') as PhaseRegistry;

const GROUND_PHASES = new Set<PhaseValue>([
  PHASES.PARKED,
  PHASES.TAXI,
  PHASES.TAXI_IN,
  PHASES.LANDING,
]);

const APPROACH_PHASES = new Set<PhaseValue>([
  PHASES.APPROACH,
  PHASES.LANDING,
  PHASES.GO_AROUND,
]);

const phasesApi = {
  PHASES,
  PUBLISHED_PHASES,
  ALL_PHASES,
  GROUND_PHASES,
  APPROACH_PHASES,
};

module.exports = phasesApi;

export {};
