'use strict';
import { cockpitLightingIntegration } from '../cockpit-lighting.js';
import { indexedExteriorLights } from '../indexed-exterior-lights.js';

import type { AircraftIntegrationDefinition } from '../types.js';

const { defineAircraftIntegration } = require('../registry') as {
  defineAircraftIntegration: (
    _definition: AircraftIntegrationDefinition,
  ) => AircraftIntegrationDefinition;
};
const { FBW_A380X_ACTIONS } = require('./actions') as {
  FBW_A380X_ACTIONS: AircraftIntegrationDefinition['actions'];
};
const { FBW_A380X_FIELDS } = require('./fields') as {
  FBW_A380X_FIELDS: AircraftIntegrationDefinition['fields'];
};

const FBW_A380X_ADAPTER_ID = 'fbw-a380x';
const FBW_A380X_PROFILE_KEY = 'bundled/msfs/fbw-a380x';

const FBW_A380X_INTEGRATION = defineAircraftIntegration({
  id: FBW_A380X_ADAPTER_ID,
  aircraft: {
    vendor: 'FlyByWire Simulations',
    family: 'A380',
  },
  trustedProfileKeys: [FBW_A380X_PROFILE_KEY],
  presentation: {
    templateId: 'fbw-a380x',
  },
  fields: { ...FBW_A380X_FIELDS, ...cockpitLightingIntegration('fbw-a380x').fields, ...indexedExteriorLights('fbw-a380x').fields },
  actions: { ...FBW_A380X_ACTIONS, ...cockpitLightingIntegration('fbw-a380x').actions, ...indexedExteriorLights('fbw-a380x').actions },
});

module.exports = {
  FBW_A380X_ADAPTER_ID,
  FBW_A380X_INTEGRATION,
  FBW_A380X_PROFILE_KEY,
};

export {};
