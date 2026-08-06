'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// Microsoft/iniBuilds do not publish an external write contract for the
// included A320neo V2 or A321LR. Keep both exact-profile pages monitoring-only
// until each interaction has an independent, live-verified system readback.
const MICROSOFT_INIBUILDS_A32X_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  MICROSOFT_INIBUILDS_A32X_ACTIONS,
};

export {};
