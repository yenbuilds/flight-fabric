'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// The included A330 exposes no vendor-documented external write contract.
// Live testing showed that standard simulator events do not control its
// custom cockpit selectors, so retain readback-only support until an exact
// iniBuilds Input Event or LVAR mapping is documented and verified in-sim.
const INIBUILDS_A330_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  INIBUILDS_A330_ACTIONS,
};

export {};
