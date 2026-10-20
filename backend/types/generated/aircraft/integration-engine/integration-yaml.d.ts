import type { AircraftIntegrationDefinition } from './types.js';
export { AIRCRAFT_DEFINITION_MAX_BYTES } from './definition-yaml.js';
/** Load explicit release-owned data, then apply the existing execution-contract checks. */
export declare function loadAircraftIntegrationDefinition(filePath: string, expectedId?: string): AircraftIntegrationDefinition;
