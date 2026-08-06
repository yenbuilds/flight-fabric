'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (definition: AircraftIntegrationDefinition) => AircraftIntegrationDefinition;
};
const { MICROSOFT_ATR_72_600_ACTIONS } = require('./actions') as {
  MICROSOFT_ATR_72_600_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { MICROSOFT_ATR_72_600_FIELDS } = require('./fields') as {
  MICROSOFT_ATR_72_600_FIELDS: AircraftIntegrationDefinition['fields'];
};

const MICROSOFT_ATR_72_600_ADAPTER_ID = 'microsoft-atr-72-600';
const MICROSOFT_ATR_72_600_PROFILE_KEY = 'bundled/msfs/microsoft-atr-72-600';

const MICROSOFT_ATR_72_600_INTEGRATION = defineAircraftIntegration({
  id: MICROSOFT_ATR_72_600_ADAPTER_ID,
  aircraft: {
    vendor: 'Microsoft / S&H Software',
    family: 'ATR 72-600',
  },
  trustedProfileKeys: [MICROSOFT_ATR_72_600_PROFILE_KEY],
  presentation: { templateId: 'microsoft-atr-72-600' },
  fields: MICROSOFT_ATR_72_600_FIELDS,
  actions: MICROSOFT_ATR_72_600_ACTIONS,
});

module.exports = {
  MICROSOFT_ATR_72_600_ADAPTER_ID,
  MICROSOFT_ATR_72_600_INTEGRATION,
  MICROSOFT_ATR_72_600_PROFILE_KEY,
};

export {};
