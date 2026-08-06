'use strict';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (definition: AircraftIntegrationDefinition) => AircraftIntegrationDefinition;
};
const { MICROSOFT_747_8_ACTIONS } = require('./actions') as {
  MICROSOFT_747_8_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { MICROSOFT_747_8_FIELDS } = require('./fields') as {
  MICROSOFT_747_8_FIELDS: AircraftIntegrationDefinition['fields'];
};

// The adapter ID follows the existing stable profile ID. Working Title supplies
// the avionics and is credited for the manuals; the stock identity remains Microsoft/Asobo.
const MICROSOFT_747_8_ADAPTER_ID = 'workingtitle-747-8';
const MICROSOFT_747_8_PROFILE_KEY = 'bundled/msfs/workingtitle-747-8';

const MICROSOFT_747_8_INTEGRATION = defineAircraftIntegration({
  id: MICROSOFT_747_8_ADAPTER_ID,
  aircraft: {
    vendor: 'Microsoft / Asobo Studio',
    family: 'Boeing 747-8i / 747-8F',
  },
  trustedProfileKeys: [MICROSOFT_747_8_PROFILE_KEY],
  presentation: { templateId: 'workingtitle-747-8' },
  fields: MICROSOFT_747_8_FIELDS,
  actions: MICROSOFT_747_8_ACTIONS,
});

module.exports = {
  MICROSOFT_747_8_ADAPTER_ID,
  MICROSOFT_747_8_INTEGRATION,
  MICROSOFT_747_8_PROFILE_KEY,
};

export {};
