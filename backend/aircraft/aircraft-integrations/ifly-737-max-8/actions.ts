'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// This adapter exposes no aircraft-specific writes. Keep the dedicated page
// monitoring-only until a documented control route and independent effect
// readback have both been validated in-sim.
const IFLY_737_MAX_8_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  IFLY_737_MAX_8_ACTIONS,
};

export {};
