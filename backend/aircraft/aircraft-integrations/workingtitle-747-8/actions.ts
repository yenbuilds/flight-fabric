'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// Microsoft/Asobo/Working Title do not publish an external 747-8 control
// contract. Keep this page monitoring-only until exact interactions and
// independent system-effect readbacks are verified in-sim.
const MICROSOFT_747_8_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  MICROSOFT_747_8_ACTIONS,
};

export {};
