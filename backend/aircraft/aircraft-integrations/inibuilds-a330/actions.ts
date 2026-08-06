'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// Microsoft and iniBuilds do not currently publish an exact A330 external
// control contract. Keep this adapter monitoring-only until a documented
// control route and an independent effect readback are available.
const INIBUILDS_A330_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  INIBUILDS_A330_ACTIONS,
};

export {};
