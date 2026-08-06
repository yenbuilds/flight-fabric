'use strict';

type GlidepathAngleOverride = {
  default?: number;
  runways?: Record<string, number>;
  note?: string;
};

// Verified, deliberately small set of well-known non-standard approach profiles.
// Keep this list conservative: add entries only when the published/procedural
// descent angle is well known enough that a 3-degree proxy would be misleading.
const GLIDEPATH_ANGLE_OVERRIDES: Record<string, GlidepathAngleOverride> = Object.freeze({
  EGLC: Object.freeze({
    runways: Object.freeze({
      '09': 5.5,
      '27': 5.5,
    }),
    note: 'London City steep approach.',
  }),
  LSZA: Object.freeze({
    runways: Object.freeze({
      '01': 6.65,
    }),
    note: 'Lugano steep instrument approach profile.',
  }),
  LOWI: Object.freeze({
    runways: Object.freeze({
      '26': 3.77,
    }),
    note: 'Innsbruck LOC/DME East profile to runway 26.',
  }),
});

module.exports = {
  GLIDEPATH_ANGLE_OVERRIDES,
};

export {};
