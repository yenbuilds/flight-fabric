'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// Microsoft/iniBuilds do not publish an external write contract for the
// included A310-300. Keep the trusted page monitoring-only until every cockpit
// interaction can be paired with an independent, live-verified readback.
const INIBUILDS_A310_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  INIBUILDS_A310_ACTIONS,
};

export {};
