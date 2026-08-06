'use strict';

import type { AircraftIntegrationAction } from '../types.js';

// TFDi documents an event-driven CEVENT contract and warns that direct writes
// to aircraft state/control LVARs bypass internal integrity checks. Keep this
// adapter monitoring-only until CEVENT actions have independent, reproducible
// readbacks for every supported passenger/freighter variant.
const TFDI_MD_11_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze({});

module.exports = {
  TFDI_MD_11_ACTIONS,
};

export {};
