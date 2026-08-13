'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { INIBUILDS_TRISTAR_ACTIONS } = require('./actions') as {
  INIBUILDS_TRISTAR_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { INIBUILDS_TRISTAR_FIELDS } = require('./fields') as {
  INIBUILDS_TRISTAR_FIELDS: AircraftIntegrationDefinition['fields'];
};

const INIBUILDS_TRISTAR_ADAPTER_ID = 'inibuilds-tristar';
const INIBUILDS_TRISTAR_PROFILE_KEY = 'bundled/msfs/inibuilds-tristar';

const INIBUILDS_TRISTAR_INTEGRATION = defineAircraftIntegration({
  id: INIBUILDS_TRISTAR_ADAPTER_ID,
  aircraft: {
    vendor: 'iniBuilds',
    family: 'L-1011-500 TriStar',
  },
  trustedProfileKeys: [INIBUILDS_TRISTAR_PROFILE_KEY],
  presentation: {
    templateId: 'inibuilds-tristar',
  },
  fields: INIBUILDS_TRISTAR_FIELDS,
  actions: INIBUILDS_TRISTAR_ACTIONS,
});

module.exports = {
  INIBUILDS_TRISTAR_ADAPTER_ID,
  INIBUILDS_TRISTAR_INTEGRATION,
  INIBUILDS_TRISTAR_PROFILE_KEY,
};

export {};
