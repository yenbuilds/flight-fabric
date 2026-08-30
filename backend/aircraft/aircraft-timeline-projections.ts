'use strict';

const {
  createAircraftTimelineProjectionRegistry,
} = require('./aircraft-timeline-projection-registry') as {
  createAircraftTimelineProjectionRegistry: (_definitions?: readonly Record<string, any>[]) => Record<string, any>;
};
const {
  PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION,
} = require('./aircraft-integrations/pmdg-777/flight-guidance-timeline') as {
  PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION: Record<string, any>;
};

const defaultAircraftTimelineProjectionRegistry = createAircraftTimelineProjectionRegistry([
  PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION,
]);

module.exports = {
  createAircraftTimelineProjectionRegistry,
  defaultAircraftTimelineProjectionRegistry,
};

export {};
