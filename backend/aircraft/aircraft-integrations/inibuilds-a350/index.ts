'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { INIBUILDS_A350_ACTIONS } = require('./actions') as {
  INIBUILDS_A350_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { INIBUILDS_A350_FIELDS } = require('./fields') as {
  INIBUILDS_A350_FIELDS: AircraftIntegrationDefinition['fields'];
};

const INIBUILDS_A350_ADAPTER_ID = 'inibuilds-a350';
const INIBUILDS_A350_900_PROFILE_KEY = 'bundled/msfs/inibuilds-a350-900';
const INIBUILDS_A350_1000_PROFILE_KEY = 'bundled/msfs/inibuilds-a350-1000';

const INIBUILDS_A350_INTEGRATION = defineAircraftIntegration({
  id: INIBUILDS_A350_ADAPTER_ID,
  aircraft: {
    vendor: 'iniBuilds',
    family: 'A350',
  },
  trustedProfileKeys: [
    INIBUILDS_A350_900_PROFILE_KEY,
    INIBUILDS_A350_1000_PROFILE_KEY,
  ],
  presentation: {
    templateId: 'inibuilds-a350',
  },
  fields: INIBUILDS_A350_FIELDS,
  actions: INIBUILDS_A350_ACTIONS,
});

module.exports = {
  INIBUILDS_A350_1000_PROFILE_KEY,
  INIBUILDS_A350_900_PROFILE_KEY,
  INIBUILDS_A350_ADAPTER_ID,
  INIBUILDS_A350_INTEGRATION,
};

export {};
