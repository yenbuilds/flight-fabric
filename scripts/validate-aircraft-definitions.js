#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { loadTypeScriptCommonJs } = require('./typescript-source-loader');

const ROOT = path.resolve(__dirname, '..');

/** Run the production parsing/registration boundaries without starting the app. */
function validateAircraftDefinitions({ compiled = false, directory } = {}) {
  const backend = path.join(ROOT, ...(compiled ? ['dist', 'backend'] : ['backend']));
  const modules = new Map();
  const load = name => compiled
    ? require(path.join(backend, `${name}.js`))
    : loadTypeScriptCommonJs(path.join(backend, `${name}.ts`), modules);
  const { readAircraftDefinitionFiles } = load('aircraft/aircraft-definition-catalogue');
  const { loadAircraftIntegrationDefinition } = load('aircraft/integration-engine/integration-yaml');
  const { buildIntegrationCatalogue } = load('aircraft/integration-engine/catalogue-schema');
  const { createAircraftIntegrationRegistry } = load('aircraft/integration-engine/registry');
  const { listBundledProfileSources, clearBundledProfileSourceCache } = load('aircraft/aircraft-profile-sources');
  const definitionDirectory = directory || path.join(backend, 'aircraft/aircraft-integrations');
  const files = readAircraftDefinitionFiles(definitionDirectory);
  const catalogue = buildIntegrationCatalogue(files.filter(file => !file.startsWith('profile-'))
    .map(file => loadAircraftIntegrationDefinition(path.join(definitionDirectory, file), file.slice(0, -5))));
  const definitions = createAircraftIntegrationRegistry(catalogue.definitions).list();
  // Repeated checks must inspect edited files, including profile-only documents.
  clearBundledProfileSourceCache();
  try {
    const profiles = listBundledProfileSources(definitionDirectory);
    const actions = definitions.flatMap(definition => Object.values(definition.actions));
    return {
      documents: files.length,
      integrations: definitions.length,
      profiles: profiles.length,
      fields: definitions.reduce((sum, definition) => sum + Object.keys(definition.fields).length, 0),
      actions: actions.length,
      routes: actions.reduce((sum, action) => sum + action.routes.length, 0),
    };
  } finally {
    clearBundledProfileSourceCache();
  }
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--dist') options.compiled = true;
    else if (argv[index] === '--directory' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      options.directory = path.resolve(argv[++index]);
    } else throw new Error('Usage: validate-aircraft-definitions.js [--dist] [--directory PATH]');
  }
  const result = validateAircraftDefinitions(options);
  console.log(`Aircraft definitions valid (${options.compiled ? 'compiled' : 'source'}): ${JSON.stringify(result)}`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) {
    console.error(`Aircraft definition validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateAircraftDefinitions, main };
