import type { AircraftIntegrationDefinition } from './types.js';
import { actionDefinitionSchema } from './action-definition-schema.js';
import { fieldDefinitionSchema } from './field-definition-schema.js';
import { integrationBehaviorSchema } from '../integration-behavior.js';
import { catalogueSchema } from '../integration-engine/catalogue-schema.js';
import { cockpitLightingGroupsSchema } from '../integration-engine/cockpit-lighting-schema.js';
import { adapterIdSchema, AIRCRAFT_DEFINITION_MAX_BYTES, bundledProfileKeySchema, createDocumentValidator, loadYamlDocument, logicalIdSchema, strictObject } from './definition-yaml.js';
export { AIRCRAFT_DEFINITION_MAX_BYTES } from './definition-yaml.js';

const { defineAircraftIntegration } = require('./registry') as {
  defineAircraftIntegration: (definition: AircraftIntegrationDefinition) => AircraftIntegrationDefinition;
};

const trustedProfileKey = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*(?![\\s\\S])' };
const definitionSchema = strictObject({
  id: adapterIdSchema,
  aircraft: strictObject({ vendor: { type: 'string', minLength: 1 }, family: { type: 'string', minLength: 1 } }),
  trustedProfileKeys: { type: 'array', minItems: 1, uniqueItems: true, items: trustedProfileKey },
  presentation: strictObject({ templateId: adapterIdSchema, cockpitLightingGroups: cockpitLightingGroupsSchema }, ['templateId']),
  fields: { type: 'object', maxProperties: 4096, propertyNames: logicalIdSchema, additionalProperties: fieldDefinitionSchema },
  actions: { type: 'object', maxProperties: 4096, propertyNames: logicalIdSchema, additionalProperties: actionDefinitionSchema },
  behavior: integrationBehaviorSchema,
  catalogue: catalogueSchema,
}, ['id', 'aircraft', 'trustedProfileKeys', 'presentation', 'fields', 'actions']);
const validate = createDocumentValidator<{ schemaVersion: 1; integration: AircraftIntegrationDefinition }>(strictObject({
  schemaVersion: { const: 1 }, integration: definitionSchema,
  // Profile documents are validated by their existing schema/normalizer at the
  // profile-source boundary. They do not grant integration write authority.
  profiles: { type: 'object', minProperties: 1, propertyNames: bundledProfileKeySchema, additionalProperties: { type: 'object' } },
}, ['schemaVersion', 'integration']));

/** Load explicit release-owned data, then apply the existing execution-contract checks. */
export function loadAircraftIntegrationDefinition(filePath: string, expectedId?: string): AircraftIntegrationDefinition {
  try {
    const { integration } = loadYamlDocument(filePath, validate, AIRCRAFT_DEFINITION_MAX_BYTES);
    if (expectedId !== undefined && integration.id !== expectedId) {
      throw new Error(`expected integration "${expectedId}", received "${integration.id}"`);
    }
    for (const field of Object.values(integration.fields)) {
      for (const { decode } of field.sources) {
        if (decode.type === 'boolean' && decode.trueValues.some(value => decode.falseValues.includes(value))) {
          throw new Error(`overlapping true/false decoder values for "${field.id}"`);
        }
      }
    }
    return defineAircraftIntegration(integration);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid aircraft integration "${filePath}": ${reason}`, { cause: error });
  }
}
