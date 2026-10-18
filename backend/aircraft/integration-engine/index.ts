'use strict';

import { join } from 'node:path';
import { readAircraftDefinitionFiles } from '../aircraft-definition-catalogue.js';
import { buildIntegrationCatalogue } from '../integration-engine/catalogue-schema.js';
import { loadAircraftIntegrationDefinition } from './integration-yaml.js';

const {
  createAircraftIntegrationRegistry,
  defineAircraftIntegration,
  normalizeAircraftIntegrationActionInput,
} = require('./registry');

const definitionDirectory = join(__dirname, '..', 'aircraft-integrations');
const catalogue = buildIntegrationCatalogue(readAircraftDefinitionFiles(definitionDirectory)
  .filter(file => !file.startsWith('profile-'))
  .map(file => loadAircraftIntegrationDefinition(join(definitionDirectory, file), file.slice(0, -5))));
const defaultAircraftIntegrationRegistry = createAircraftIntegrationRegistry(catalogue.definitions);

module.exports = Object.fromEntries([
  ...catalogue.legacyExports,
  ['createAircraftIntegrationRegistry', createAircraftIntegrationRegistry],
  ['defaultAircraftIntegrationRegistry', defaultAircraftIntegrationRegistry],
  ['defineAircraftIntegration', defineAircraftIntegration],
  ['normalizeAircraftIntegrationActionInput', normalizeAircraftIntegrationActionInput],
]);

export {};
