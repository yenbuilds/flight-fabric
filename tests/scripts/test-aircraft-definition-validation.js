'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateAircraftDefinitions } = require('../../scripts/validate-aircraft-definitions');

const ROOT = path.resolve(__dirname, '../..');
const validator = path.join(ROOT, 'scripts/validate-aircraft-definitions.js');
const sourceDirectory = path.join(ROOT, 'backend/aircraft/aircraft-integrations');

test('built aircraft assets are canonical JSON-compatible YAML with unchanged authored data', () => {
  const files = require('../../backend/aircraft/aircraft-definition-files.json');
  const { parse } = require('yaml');
  for (const file of files) {
    const authored = parse(fs.readFileSync(path.join(sourceDirectory, file), 'utf8'));
    const runtime = fs.readFileSync(path.join(ROOT, 'dist/backend/aircraft/aircraft-integrations', file), 'utf8');
    assert.equal(runtime, JSON.stringify(authored), file);
  }
});

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'ff-yaml-validation-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'aircraft-integrations');
  fs.mkdirSync(directory);
  fs.copyFileSync(path.join(sourceDirectory, 'pmdg-737.yaml'), path.join(directory, 'pmdg-737.yaml'));
  fs.writeFileSync(path.join(root, 'aircraft-definition-files.json'), JSON.stringify(['pmdg-737.yaml', 'profile-test.yaml']));
  const profileFile = path.join(directory, 'profile-test.yaml');
  const profile = 'schemaVersion: 1\nprofiles:\n  bundled/msfs/test-aircraft:\n    id: test-aircraft\n';
  fs.writeFileSync(profileFile, profile);
  return { root, directory, profileFile, profile };
}

test('source and compiled preflight validate the complete catalogue without historical snapshot files', () => {
  const source = validateAircraftDefinitions();
  const compiled = validateAircraftDefinitions({ compiled: true });
  assert.deepEqual(compiled, source);
  const baseline = require('../fixtures/aircraft-yaml-catalogue-baseline.json');
  // Preserve the frozen migration baseline and count the separately reviewed
  // additions, whose exact definitions the integration parity tests also check.
  const expected = { ...baseline.totals };
  for (const addition of Object.values(require('../fixtures/requested-aircraft-controls-20261017.json'))) {
    for (const key of ['fields', 'actions']) expected[key] += Object.keys(addition[key]).length;
  }
  for (const key of ['integrations', 'profiles', 'fields', 'actions']) assert.equal(source[key], expected[key], key);
  assert.equal(source.documents, require('../../backend/aircraft/aircraft-definition-files.json').length);
  assert.ok(source.routes >= source.actions);
});

test('build normalization preserves YAML values that JSON cannot represent losslessly', context => {
  const { root, directory, profileFile } = fixture(context);
  const source = 'schemaVersion: 1\nprofiles:\n  bundled/msfs/test-aircraft:\n    id: test-aircraft\n    threshold: -0\n';
  fs.writeFileSync(profileFile, source);
  const destination = path.join(root, 'copied-definitions');
  fs.cpSync(directory, destination, { recursive: true });
  require('../../scripts/build-backend-runtime').normalizeAircraftDefinitionAssets(directory, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'profile-test.yaml'), 'utf8'), source);
  const { loadYamlDocument } = require('../../dist/backend/aircraft/integration-engine/definition-yaml');
  const loaded = loadYamlDocument(path.join(destination, 'profile-test.yaml'), () => true);
  assert(Object.is(loaded.profiles['bundled/msfs/test-aircraft'].threshold, -0));
  const integration = fs.readFileSync(path.join(destination, 'pmdg-737.yaml'), 'utf8');
  assert.equal(integration, JSON.stringify(JSON.parse(integration)));
});

test('preflight re-reads profile-only YAML after a successful check and recovers after correction', t => {
  const { directory, profileFile, profile } = fixture(t);
  for (const compiled of [false, true]) {
    const expected = validateAircraftDefinitions({ directory, compiled });
    fs.writeFileSync(profileFile, 'schemaVersion: 1\nprofiles: [');
    assert.throws(() => validateAircraftDefinitions({ directory, compiled }), /Invalid aircraft definition.*profile-test\.yaml/);
    fs.writeFileSync(profileFile, profile);
    assert.deepEqual(validateAircraftDefinitions({ directory, compiled }), expected);
  }
});

test('validation CLI rejects malformed profile-only assets with a nonzero exit and file diagnostic', t => {
  const { directory, profileFile } = fixture(t);
  fs.writeFileSync(profileFile, 'schemaVersion: 1\nprofiles: [');
  const result = spawnSync(process.execPath, [validator, '--directory', directory], { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Aircraft definition validation failed:.*profile-test\.yaml/);
  assert.doesNotMatch(result.stdout, /Aircraft definitions valid/);
});

test('backend build rejects invalid YAML before deleting an existing runtime', t => {
  const { root, directory, profileFile } = fixture(t);
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  fs.copyFileSync(path.join(ROOT, 'scripts/build-backend-runtime.js'), path.join(scripts, 'build-backend-runtime.js'));
  // Only toolchain/scratch location lookup is stubbed. The build invokes the
  // real validator with the real parser and malformed fixture; no Cargo/tsc runs.
  fs.writeFileSync(path.join(scripts, 'rust-toolchain.js'), 'exports.resolveCargo = () => { throw new Error("Unexpected Cargo invocation"); };\n');
  fs.writeFileSync(path.join(scripts, 'repo-scratch.js'),
    'const path = require("node:path"); exports.getRepoScratchPath = (...parts) => path.join(__dirname, "../.tmp", ...parts);\n'
    + 'exports.resetRepoScratchDirectory = () => { throw new Error("Unexpected scratch reset"); };\n');
  fs.writeFileSync(path.join(scripts, 'validate-aircraft-definitions.js'),
    `require(${JSON.stringify(validator)}).main(['--directory', ${JSON.stringify(directory)}]);\n`);
  const existingRuntime = path.join(root, 'dist/backend');
  fs.mkdirSync(existingRuntime, { recursive: true });
  const sentinel = path.join(existingRuntime, 'existing-runtime.txt');
  fs.writeFileSync(sentinel, 'Existing usable runtime');
  fs.writeFileSync(profileFile, 'schemaVersion: 1\nprofiles: [');
  const result = spawnSync(process.execPath, [path.join(scripts, 'build-backend-runtime.js')],
    { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /profile-test\.yaml/);
  assert.doesNotMatch(result.stderr, /Unexpected Cargo|Unexpected scratch/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Existing usable runtime');
  assert.doesNotMatch(result.stdout, /Backend runtime build complete/);
});
