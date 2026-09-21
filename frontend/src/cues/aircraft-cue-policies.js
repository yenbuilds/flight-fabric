// Reviewed reminder choices, selected by the backend's command configuration ID.
// These narrow examples only: the catalogue still owns command availability,
// accepted inputs and execution. Never infer Airbus semantics from a MAX enum
// alone: MAX remains a valid landing choice on other aircraft, including 737s.
const afterLandingFlaps = {
  value: 'up', placeholder: null,
  detail: 'Once clear of the runway, retract the flaps when your aircraft’s after-landing procedure calls for it. Check the indication.',
};

const airbusA32x = {
  TAXI: {
    'surfaces.flaps.set': { includeValues: ['1', '2', '3'] },
    'surfaces.autobrake.set': {
      value: 'max',
      detail: 'Before the takeoff roll, select MAX when required by your departure procedure and verify the indication. MAX is this aircraft’s rejected-takeoff setting.',
    },
  },
  CLIMB: {
    'surfaces.flaps.set': { includeValues: ['up', '1', '2', '3'] },
  },
  APPROACH: {
    'surfaces.flaps.set': { includeValues: ['1', '2', '3', 'full'] },
    'surfaces.autobrake.set': {
      includeValues: ['off', 'low', 'medium'],
      detail: 'Use LOW or MED if your landing plan calls for autobrake, then verify the indication. OFF leaves braking to you; MAX is not a landing setting on this aircraft.',
    },
  },
  'TAXI-IN': {
    'surfaces.flaps.set': afterLandingFlaps,
  },
};

function boeing(takeoffDetents, retractionDetents) {
  return {
    TAXI: { 'surfaces.flaps.set': { includeValues: takeoffDetents } },
    CLIMB: { 'surfaces.flaps.set': { includeValues: retractionDetents } },
    APPROACH: { 'surfaces.flaps.set': { excludeValues: ['up'] } },
    'TAXI-IN': { 'surfaces.flaps.set': afterLandingFlaps },
  };
}

// A380X deliberately does not inherit A32x flap/autobrake semantics. Its
// catalogue currently advertises one-detent flap changes, not named detents.
const policies = {
  'fenix-a32x': airbusA32x,
  'fbw-a32nx': airbusA32x,
  'pmdg-737': boeing(['1', '5', '10', '15', '25'], ['up', '1', '2', '5', '10', '15', '25']),
  'pmdg-777': boeing(['5', '15', '20'], ['up', '1', '5', '15', '20']),
};

export function aircraftFlightCue(configurationId, phase, cue) {
  return { ...cue, ...policies[configurationId]?.[phase]?.[cue.id] };
}
