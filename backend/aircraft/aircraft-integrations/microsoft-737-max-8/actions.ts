'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// Microsoft/Asobo do not publish an external control contract for the included
// 737 MAX 8. Keep this page monitoring-only until exact interactions and
// independent system-effect readbacks are verified in-sim.
const MICROSOFT_737_MAX_8_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  MICROSOFT_737_MAX_8_ACTIONS,
};

export {};
