'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { FENIX_A32X_ACTIONS } = require('./actions') as {
  FENIX_A32X_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { FENIX_A32X_FIELDS } = require('./fields') as {
  FENIX_A32X_FIELDS: AircraftIntegrationDefinition['fields'];
};

const FENIX_A32X_ADAPTER_ID = 'fenix-a32x';
const FENIX_A319_PROFILE_KEY = 'bundled/msfs/fenix-a319';
const FENIX_A320_PROFILE_KEY = 'bundled/msfs/fenix-a320';
const FENIX_A321_PROFILE_KEY = 'bundled/msfs/fenix-a321';

const FENIX_A32X_INTEGRATION = defineAircraftIntegration({
  id: FENIX_A32X_ADAPTER_ID,
  aircraft: {
    vendor: 'Fenix Simulations',
    family: 'A32x',
  },
  trustedProfileKeys: [
    FENIX_A319_PROFILE_KEY,
    FENIX_A320_PROFILE_KEY,
    FENIX_A321_PROFILE_KEY,
  ],
  presentation: {
    templateId: 'fenix-a32x',
  },
  fields: FENIX_A32X_FIELDS,
  actions: FENIX_A32X_ACTIONS,
});

module.exports = {
  FENIX_A32X_ADAPTER_ID,
  FENIX_A32X_INTEGRATION,
  FENIX_A319_PROFILE_KEY,
  FENIX_A320_PROFILE_KEY,
  FENIX_A321_PROFILE_KEY,
};

export {};
