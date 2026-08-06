'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (definition: AircraftIntegrationDefinition) => AircraftIntegrationDefinition;
};
const { MICROSOFT_INIBUILDS_A32X_ACTIONS } = require('./actions') as {
  MICROSOFT_INIBUILDS_A32X_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { MICROSOFT_INIBUILDS_A32X_FIELDS } = require('./fields') as {
  MICROSOFT_INIBUILDS_A32X_FIELDS: AircraftIntegrationDefinition['fields'];
};

const MICROSOFT_INIBUILDS_A32X_ADAPTER_ID = 'microsoft-inibuilds-a32x';
const INIBUILDS_A320NEO_V2_PROFILE_KEY = 'bundled/msfs/inibuilds-a320neo-v2';
const INIBUILDS_A321LR_PROFILE_KEY = 'bundled/msfs/inibuilds-a321lr';

const MICROSOFT_INIBUILDS_A32X_INTEGRATION = defineAircraftIntegration({
  id: MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
  aircraft: {
    vendor: 'Microsoft / iniBuilds',
    family: 'Airbus A320neo V2 / A321LR',
  },
  trustedProfileKeys: [
    INIBUILDS_A320NEO_V2_PROFILE_KEY,
    INIBUILDS_A321LR_PROFILE_KEY,
  ],
  presentation: { templateId: 'microsoft-inibuilds-a32x' },
  fields: MICROSOFT_INIBUILDS_A32X_FIELDS,
  actions: MICROSOFT_INIBUILDS_A32X_ACTIONS,
});

module.exports = {
  INIBUILDS_A320NEO_V2_PROFILE_KEY,
  INIBUILDS_A321LR_PROFILE_KEY,
  MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
  MICROSOFT_INIBUILDS_A32X_INTEGRATION,
};

export {};
