'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (definition: AircraftIntegrationDefinition) => AircraftIntegrationDefinition;
};
const { MICROSOFT_787_10_ACTIONS } = require('./actions') as {
  MICROSOFT_787_10_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { MICROSOFT_787_10_FIELDS } = require('./fields') as {
  MICROSOFT_787_10_FIELDS: AircraftIntegrationDefinition['fields'];
};

// The adapter ID follows the existing stable profile ID. Working Title supplies
// the avionics and is credited for the manual; the stock identity remains Microsoft/Asobo.
const MICROSOFT_787_10_ADAPTER_ID = 'asobo-787';
const MICROSOFT_787_10_PROFILE_KEY = 'bundled/msfs/asobo-787';

const MICROSOFT_787_10_INTEGRATION = defineAircraftIntegration({
  id: MICROSOFT_787_10_ADAPTER_ID,
  aircraft: {
    vendor: 'Microsoft / Asobo Studio',
    family: 'Boeing 787-10 Dreamliner',
  },
  trustedProfileKeys: [MICROSOFT_787_10_PROFILE_KEY],
  presentation: { templateId: 'asobo-787' },
  fields: MICROSOFT_787_10_FIELDS,
  actions: MICROSOFT_787_10_ACTIONS,
});

module.exports = {
  MICROSOFT_787_10_ADAPTER_ID,
  MICROSOFT_787_10_INTEGRATION,
  MICROSOFT_787_10_PROFILE_KEY,
};

export {};
