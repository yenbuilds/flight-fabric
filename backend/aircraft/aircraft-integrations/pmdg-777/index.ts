'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { PMDG_777_ACTIONS } = require('./actions') as {
  PMDG_777_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { PMDG_777_FIELDS } = require('./fields') as {
  PMDG_777_FIELDS: AircraftIntegrationDefinition['fields'];
};

const PMDG_777_ADAPTER_ID = 'pmdg-777';
const PMDG_777_300ER_PROFILE_KEY = 'bundled/msfs/pmdg-777';
const PMDG_777_200ER_PROFILE_KEY = 'bundled/msfs/pmdg-777-200er';
const PMDG_777_200LR_PROFILE_KEY = 'bundled/msfs/pmdg-777-200lr';
const PMDG_777F_PROFILE_KEY = 'bundled/msfs/pmdg-777f';

const PMDG_777_INTEGRATION = defineAircraftIntegration({
  id: PMDG_777_ADAPTER_ID,
  aircraft: {
    vendor: 'PMDG',
    family: '777',
  },
  trustedProfileKeys: [
    PMDG_777_300ER_PROFILE_KEY,
    PMDG_777_200ER_PROFILE_KEY,
    PMDG_777_200LR_PROFILE_KEY,
    PMDG_777F_PROFILE_KEY,
  ],
  presentation: {
    templateId: 'pmdg-777',
  },
  fields: PMDG_777_FIELDS,
  actions: PMDG_777_ACTIONS,
});

module.exports = {
  PMDG_777_ADAPTER_ID,
  PMDG_777_INTEGRATION,
  PMDG_777_300ER_PROFILE_KEY,
  PMDG_777_200ER_PROFILE_KEY,
  PMDG_777_200LR_PROFILE_KEY,
  PMDG_777F_PROFILE_KEY,
};

export {};
