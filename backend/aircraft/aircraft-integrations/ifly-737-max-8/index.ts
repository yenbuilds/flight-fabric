'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { IFLY_737_MAX_8_ACTIONS } = require('./actions') as {
  IFLY_737_MAX_8_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { IFLY_737_MAX_8_FIELDS } = require('./fields') as {
  IFLY_737_MAX_8_FIELDS: AircraftIntegrationDefinition['fields'];
};

const IFLY_737_MAX_8_ADAPTER_ID = 'ifly-737-max-8';
const IFLY_737_MAX_8_PROFILE_KEY = 'bundled/msfs/ifly-737-max-8';

const IFLY_737_MAX_8_INTEGRATION = defineAircraftIntegration({
  id: IFLY_737_MAX_8_ADAPTER_ID,
  aircraft: {
    vendor: 'iFly / Flight1',
    family: '737 MAX 8',
  },
  trustedProfileKeys: [IFLY_737_MAX_8_PROFILE_KEY],
  presentation: {
    templateId: 'ifly-737-max-8',
  },
  fields: IFLY_737_MAX_8_FIELDS,
  actions: IFLY_737_MAX_8_ACTIONS,
});

module.exports = {
  IFLY_737_MAX_8_ADAPTER_ID,
  IFLY_737_MAX_8_INTEGRATION,
  IFLY_737_MAX_8_PROFILE_KEY,
};

export {};
