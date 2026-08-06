'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { TFDI_MD_11_ACTIONS } = require('./actions') as {
  TFDI_MD_11_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { TFDI_MD_11_FIELDS } = require('./fields') as {
  TFDI_MD_11_FIELDS: AircraftIntegrationDefinition['fields'];
};

const TFDI_MD_11_ADAPTER_ID = 'tfdi-md-11';
const TFDI_MD_11_PROFILE_KEY = 'bundled/msfs/tfdi-md-11';

const TFDI_MD_11_INTEGRATION = defineAircraftIntegration({
  id: TFDI_MD_11_ADAPTER_ID,
  aircraft: {
    vendor: 'TFDi Design',
    family: 'McDonnell Douglas MD-11',
  },
  trustedProfileKeys: [TFDI_MD_11_PROFILE_KEY],
  presentation: { templateId: 'tfdi-md-11' },
  fields: TFDI_MD_11_FIELDS,
  actions: TFDI_MD_11_ACTIONS,
});

module.exports = {
  TFDI_MD_11_ADAPTER_ID,
  TFDI_MD_11_INTEGRATION,
  TFDI_MD_11_PROFILE_KEY,
};

export {};
