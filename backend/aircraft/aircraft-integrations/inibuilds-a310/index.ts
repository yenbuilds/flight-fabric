'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (definition: AircraftIntegrationDefinition) => AircraftIntegrationDefinition;
};
const { INIBUILDS_A310_ACTIONS } = require('./actions') as {
  INIBUILDS_A310_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { INIBUILDS_A310_FIELDS } = require('./fields') as {
  INIBUILDS_A310_FIELDS: AircraftIntegrationDefinition['fields'];
};

const INIBUILDS_A310_ADAPTER_ID = 'inibuilds-a310';
const INIBUILDS_A310_PROFILE_KEY = 'bundled/msfs/inibuilds-a310';

const INIBUILDS_A310_INTEGRATION = defineAircraftIntegration({
  id: INIBUILDS_A310_ADAPTER_ID,
  aircraft: {
    vendor: 'Microsoft / iniBuilds',
    family: 'Airbus A310-300',
  },
  trustedProfileKeys: [INIBUILDS_A310_PROFILE_KEY],
  presentation: { templateId: 'inibuilds-a310' },
  fields: INIBUILDS_A310_FIELDS,
  actions: INIBUILDS_A310_ACTIONS,
});

module.exports = {
  INIBUILDS_A310_ADAPTER_ID,
  INIBUILDS_A310_INTEGRATION,
  INIBUILDS_A310_PROFILE_KEY,
};

export {};
