'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// The source-backed profile-level AFCS key events remain available through the
// existing generic control resolver. They are not promoted into trusted
// aircraft-specific actions because no independent, reliable AFCS readback is
// available to confirm their effects.
const INIBUILDS_TRISTAR_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  INIBUILDS_TRISTAR_ACTIONS,
};

export {};
