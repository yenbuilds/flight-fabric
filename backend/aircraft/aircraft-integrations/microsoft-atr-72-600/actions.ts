'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// ATR-specific control variables lack a Microsoft/S&H contract and verified
// system-effect readbacks. No aircraft-specific write is exposed.
const MICROSOFT_ATR_72_600_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  MICROSOFT_ATR_72_600_ACTIONS,
};

export {};
