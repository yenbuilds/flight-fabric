'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { PMDG_737_ACTIONS } = require('./actions') as {
  PMDG_737_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { PMDG_737_FIELDS } = require('./fields') as {
  PMDG_737_FIELDS: AircraftIntegrationDefinition['fields'];
};

const PMDG_737_ADAPTER_ID = 'pmdg-737';
const PMDG_737_800_PROFILE_KEY = 'bundled/msfs/pmdg-737';
const PMDG_737_600_PROFILE_KEY = 'bundled/msfs/pmdg-737-600';
const PMDG_737_700_PROFILE_KEY = 'bundled/msfs/pmdg-737-700';
const PMDG_737_900_PROFILE_KEY = 'bundled/msfs/pmdg-737-900';
const PMDG_737_PROFILE_KEY = PMDG_737_800_PROFILE_KEY;

const PMDG_737_INTEGRATION = defineAircraftIntegration({
  id: PMDG_737_ADAPTER_ID,
  aircraft: {
    vendor: 'PMDG',
    family: '737',
  },
  trustedProfileKeys: [
    PMDG_737_800_PROFILE_KEY,
    PMDG_737_600_PROFILE_KEY,
    PMDG_737_700_PROFILE_KEY,
    PMDG_737_900_PROFILE_KEY,
  ],
  presentation: {
    templateId: 'pmdg-737',
  },
  fields: PMDG_737_FIELDS,
  actions: PMDG_737_ACTIONS,
});

module.exports = {
  PMDG_737_ADAPTER_ID,
  PMDG_737_INTEGRATION,
  PMDG_737_600_PROFILE_KEY,
  PMDG_737_700_PROFILE_KEY,
  PMDG_737_800_PROFILE_KEY,
  PMDG_737_900_PROFILE_KEY,
  PMDG_737_PROFILE_KEY,
};

export {};
