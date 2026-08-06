'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { FBW_A32NX_ACTIONS } = require('./actions') as {
  FBW_A32NX_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { FBW_A32NX_FIELDS } = require('./fields') as {
  FBW_A32NX_FIELDS: AircraftIntegrationDefinition['fields'];
};

const FBW_A32NX_ADAPTER_ID = 'fbw-a32nx';
const FBW_A32NX_PROFILE_KEY = 'bundled/msfs/fbw-a32nx';

const FBW_A32NX_INTEGRATION = defineAircraftIntegration({
  id: FBW_A32NX_ADAPTER_ID,
  aircraft: {
    vendor: 'FlyByWire Simulations',
    family: 'A32NX',
  },
  trustedProfileKeys: [FBW_A32NX_PROFILE_KEY],
  presentation: {
    templateId: 'fbw-a32nx',
  },
  fields: FBW_A32NX_FIELDS,
  actions: FBW_A32NX_ACTIONS,
});

module.exports = {
  FBW_A32NX_ADAPTER_ID,
  FBW_A32NX_INTEGRATION,
  FBW_A32NX_PROFILE_KEY,
};

export {};
