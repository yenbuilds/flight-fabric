'use strict';

import { createFlightGuidanceProjection } from './flight-guidance-projection.js';

const {
  createAircraftTimelineProjectionRegistry,
} = require('./aircraft-timeline-projection-registry') as {
  createAircraftTimelineProjectionRegistry: (_definitions?: readonly Record<string, any>[]) => Record<string, any>;
};
const { defaultAircraftIntegrationRegistry } = require('./integration-engine');

const defaultAircraftTimelineProjectionRegistry = createAircraftTimelineProjectionRegistry(
  defaultAircraftIntegrationRegistry.list().filter(definition => definition.behavior?.flightGuidanceProjection)
    .map(definition => createFlightGuidanceProjection(definition.id, definition.behavior.flightGuidanceProjection)),
);

module.exports = {
  createAircraftTimelineProjectionRegistry,
  defaultAircraftTimelineProjectionRegistry,
};

export {};
