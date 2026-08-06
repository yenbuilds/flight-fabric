'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (definition: AircraftIntegrationDefinition) => AircraftIntegrationDefinition;
};
const { MICROSOFT_737_MAX_8_ACTIONS } = require('./actions') as {
  MICROSOFT_737_MAX_8_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { MICROSOFT_737_MAX_8_FIELDS } = require('./fields') as {
  MICROSOFT_737_MAX_8_FIELDS: AircraftIntegrationDefinition['fields'];
};

const MICROSOFT_737_MAX_8_ADAPTER_ID = 'microsoft-737-max-8';
const MICROSOFT_737_MAX_8_PROFILE_KEY = 'bundled/msfs/microsoft-737-max-8';

const MICROSOFT_737_MAX_8_INTEGRATION = defineAircraftIntegration({
  id: MICROSOFT_737_MAX_8_ADAPTER_ID,
  aircraft: {
    vendor: 'Microsoft / Asobo Studio',
    family: 'Boeing 737 MAX 8',
  },
  trustedProfileKeys: [MICROSOFT_737_MAX_8_PROFILE_KEY],
  presentation: { templateId: 'microsoft-737-max-8' },
  fields: MICROSOFT_737_MAX_8_FIELDS,
  actions: MICROSOFT_737_MAX_8_ACTIONS,
});

module.exports = {
  MICROSOFT_737_MAX_8_ADAPTER_ID,
  MICROSOFT_737_MAX_8_INTEGRATION,
  MICROSOFT_737_MAX_8_PROFILE_KEY,
};

export {};
