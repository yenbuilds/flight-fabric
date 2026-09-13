'use strict';

// Release hold pending a further safety review. Deliberately not configurable
// through settings, environment variables, URLs, or command-line flags.
const AIRCRAFT_SUPPORT_ENABLED = false;
const AIRCRAFT_SUPPORT_DISABLED_MESSAGE = 'Aircraft support workbench is disabled in this release pending further review.';

module.exports = { AIRCRAFT_SUPPORT_ENABLED, AIRCRAFT_SUPPORT_DISABLED_MESSAGE };
