'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { INIBUILDS_A330_ACTIONS } = require('./actions') as {
  INIBUILDS_A330_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { INIBUILDS_A330_FIELDS } = require('./fields') as {
  INIBUILDS_A330_FIELDS: AircraftIntegrationDefinition['fields'];
};

const INIBUILDS_A330_ADAPTER_ID = 'inibuilds-a330';
const INIBUILDS_A330_PROFILE_KEY = 'bundled/msfs/inibuilds-a330';

const INIBUILDS_A330_INTEGRATION = defineAircraftIntegration({
  id: INIBUILDS_A330_ADAPTER_ID,
  aircraft: {
    vendor: 'iniBuilds / Microsoft',
    family: 'A330',
  },
  trustedProfileKeys: [INIBUILDS_A330_PROFILE_KEY],
  presentation: {
    templateId: 'inibuilds-a330',
  },
  fields: INIBUILDS_A330_FIELDS,
  actions: INIBUILDS_A330_ACTIONS,
});

module.exports = {
  INIBUILDS_A330_ADAPTER_ID,
  INIBUILDS_A330_INTEGRATION,
  INIBUILDS_A330_PROFILE_KEY,
};

export {};
