
// Source-relative fixtures and runtime paths retain their original base after relocation.
const ORIGINAL_SOURCE_DIR = require('node:path').resolve(__dirname, '../../../aircraft/integration-engine');
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AIRCRAFT_DEFINITION_MAX_BYTES, loadAircraftIntegrationDefinition } from '../../../aircraft/integration-engine/integration-yaml.js';
import { clearBundledProfileSourceCache, listBundledProfileSources, readBundledProfile } from '../../../aircraft/aircraft-profile-sources.js';
import { loadYamlDocument, readBundledDefinitionBytes } from '../../../aircraft/integration-engine/definition-yaml.js';

const { defaultAircraftIntegrationRegistry, createAircraftIntegrationRegistry } = require('../../../aircraft/integration-engine/index');
const pmdgPath = join(ORIGINAL_SOURCE_DIR, '../aircraft-integrations', 'pmdg-737.yaml');
const pmdg = () => ({ schemaVersion: 1, integration: structuredClone(defaultAircraftIntegrationRegistry.getById('pmdg-737')) });

function withFile(contents: string, run: (filePath: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'ff-integration-yaml-'));
  try {
    const filePath = join(directory, 'aircraft.yaml');
    writeFileSync(filePath, contents);
    run(filePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function rejects(contents: string, reason: RegExp) {
  withFile(contents, filePath => assert.throws(() => loadAircraftIntegrationDefinition(filePath), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(filePath), 'diagnostic identifies the faulty aircraft file');
    assert.match(error.message, reason);
    return true;
  }));
}

test('all migrated integrations retain the independent pre-conversion catalogue fingerprints', () => {
  const baseline = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/aircraft-yaml-catalogue-baseline.json'), 'utf8'));
  const { projectPreExecutionCatalogue } = require(join(process.cwd(), 'tests/helpers/pre-execution-catalogue-projection.js'));
  const definitions = defaultAircraftIntegrationRegistry.list();
  assert.equal(definitions.length, 18);
  for (const definition of definitions) {
    const expected = baseline.integrations[definition.id];
    assert.ok(expected, definition.id);
    assert.equal(createHash('sha256').update(JSON.stringify(projectPreExecutionCatalogue(definition))).digest('hex'), expected.sha256,
      `${definition.id}: complete ordered fields, actions, authority and presentation must match the pre-conversion baseline`);
    assert.equal(Object.keys(projectPreExecutionCatalogue(definition).fields).length, expected.fields);
    assert.equal(Object.keys(projectPreExecutionCatalogue(definition).actions).length, expected.actions);
    for (const profileKey of definition.trustedProfileKeys) {
      assert.equal(defaultAircraftIntegrationRegistry.resolveForProfile(profileKey).id, definition.id);
      assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(definition.id, {
        profileKey: profileKey.replace(/^bundled\//, 'local/'),
      }), null, 'matching local identity cannot grant trusted write authority');
    }
  }
});

test('execution-stage baseline projection asserts exact new descriptors and preserves unrelated changes', () => {
  const { projectPreExecutionCatalogue } = require(join(process.cwd(), 'tests/helpers/pre-execution-catalogue-projection.js'));
  const definition = defaultAircraftIntegrationRegistry.getById('fbw-a380x');
  const changedDescriptor = structuredClone(definition);
  changedDescriptor.actions['baro.both.std'].routes[0].conditionalWrites.freshnessMs = 2001;
  assert.throws(() => projectPreExecutionCatalogue(changedDescriptor), /reviewed conditional-write descriptor/);
  const changedOriginal = structuredClone(definition);
  changedOriginal.actions['baro.both.std'].routes[0].operations[0].name = 'A32NX.FCU_EFIS_L_BARO_PULL';
  assert.notDeepEqual(projectPreExecutionCatalogue(changedOriginal), projectPreExecutionCatalogue(definition));
  const unrelated = structuredClone(defaultAircraftIntegrationRegistry.getById('fenix-a32x'));
  unrelated.actions['lights.wing.on'].routes[0].conditionalWrites = { unexpected: true };
  assert.deepEqual(projectPreExecutionCatalogue(unrelated).actions['lights.wing.on'].routes[0].conditionalWrites, { unexpected: true }, 'no unreviewed descriptor is erased');
  assert.equal(Object.hasOwn(definition.actions['baro.both.std'].routes[0], 'conditionalWrites'), true,
    'projection must not mutate the registered definition');
});

test('777 surface baseline projection preserves unrelated mappings and rejects unreviewed corrections', () => {
  const { projectPreExecutionCatalogue, projectPreSurfaceCorrectionProfile } = require(join(process.cwd(), 'tests/helpers/pre-execution-catalogue-projection.js'));
  const definition = defaultAircraftIntegrationRegistry.getById('pmdg-777');
  for (const mutate of [
    value => { value.actions['controls.flaps.five'].routes[0].readback.timeoutMs = 6000; },
    value => { value.actions['controls.speedbrake.half'].routes[0].readback.expectedValue = 50; },
  ]) {
    const changed = structuredClone(definition); mutate(changed);
    assert.throws(() => projectPreExecutionCatalogue(changed), /reviewed 777/);
  }
  const unrelated = structuredClone(definition);
  unrelated.actions['controls.flaps.five'].routes[0].readback.expectedValue = '15';
  assert.notDeepEqual(projectPreExecutionCatalogue(unrelated), projectPreExecutionCatalogue(definition));
  const profile = readBundledProfile('bundled/msfs/pmdg-777');
  const projected = projectPreSurfaceCorrectionProfile(profile);
  assert.notDeepEqual(projected, profile);
  const changed = structuredClone(profile);
  changed.name = 'Changed name';
  assert.equal(projectPreSurfaceCorrectionProfile(changed).name, 'Changed name');
  changed.provenance.sources.find(source => source.name === 'PMDG 777 MSFS SDK manual and installed sample').notes += ' Unreviewed extra.';
  assert.notDeepEqual(projectPreSurfaceCorrectionProfile(changed), projected, 'unrelated prose remains fingerprinted');
  assert.equal(definition.actions['controls.speedbrake.half'].routes[0].readback.expectedValue, 75, 'projection never mutates production definitions');
});

test('full YAML definitions preserve immutable ordered routes and reject duplicate registrations', () => {
  const definition = loadAircraftIntegrationDefinition(join(ORIGINAL_SOURCE_DIR, '../aircraft-integrations', 'fenix-a32x.yaml'), 'fenix-a32x');
  const action = definition.actions['lights.wing.on'];
  assert.deepEqual(action.routes.map(route => route.transport), ['mobiflight-calculator', 'lvar']);
  assert.equal(Object.hasOwn(action, 'input'), false);
  assert.equal(Object.hasOwn(action.routes[0], 'mode'), false);
  assert.equal(Reflect.set(action.routes[0].readback, 'expectedValue', false), false);
  assert.equal(Reflect.set(action.routes, '0', action.routes[1]), false);
  assert.throws(() => createAircraftIntegrationRegistry([definition, definition]), /already|duplicate/i);
  assert.throws(() => loadAircraftIntegrationDefinition(pmdgPath, 'fenix-a32x'), /expected integration/);
});

test('reviewed aircraft additions cannot hide unrelated migration changes', () => {
  const { projectPreExecutionCatalogue } = require(join(process.cwd(), 'tests/helpers/pre-execution-catalogue-projection.js'));
  for (const id of ['inibuilds-a350', 'inibuilds-a380', 'tfdi-md-11']) {
    const original = defaultAircraftIntegrationRegistry.getById(id);
    const changed = structuredClone(original);
    const actionId = id === 'inibuilds-a350' ? 'controls.flaps.set'
      : id === 'inibuilds-a380' ? 'controls.gear.up' : 'flightGuidance.autoflight.request';
    changed.actions[actionId].guard.retry = 'automatic';
    assert.throws(() => projectPreExecutionCatalogue(changed), /reviewed control addition/);
    const unrelated = structuredClone(original);
    unrelated.fields['unreviewed.field'] = { id: 'unreviewed.field' };
    assert.ok(projectPreExecutionCatalogue(unrelated).fields['unreviewed.field']);
    assert.ok(original.actions[actionId], 'projection does not mutate the active catalogue');
  }
});

test('selector readiness YAML requires a complete independent fresh-field condition', () => {
  const candidate = () => ({ schemaVersion: 1,
    integration: structuredClone(defaultAircraftIntegrationRegistry.getById('tfdi-md-11')) });
  withFile(JSON.stringify(candidate()), filePath => {
    assert.doesNotThrow(() => loadAircraftIntegrationDefinition(filePath));
  });
  for (const mutate of [
    readback => { delete readback.readyWhen.fieldId; },
    readback => { delete readback.readyWhen.expectedValue; },
    readback => { readback.readyWhen.freshness = 'snapshot'; },
    readback => { readback.readyWhen.expectedValue = {}; },
    readback => { readback.readyWhen.unknown = true; },
    readback => { readback.readyWhen.fieldId = 'controls.flapsHandle'; },
    readback => { delete readback.freshness; },
  ]) {
    const document = candidate();
    mutate(document.integration.actions['controls.flaps.set'].routes[0].readback);
    rejects(JSON.stringify(document), /definition|invalid|readback/i);
  }
});

test('full definition loader rejects ambiguous YAML and unsafe object keys', () => {
  const valid = JSON.stringify(pmdg());
  for (const [contents, reason] of [
    [`${valid}\n---\n${valid}`, /multiple documents/i],
    [`%YAML 1.1\n---\n${valid}`, /requires YAML 1.2/],
    ['schemaVersion: 1\nschemaVersion: 1\nintegration: {}', /unique|duplicate/i],
    ['schemaVersion: 1\nintegration: &shared {}', /anchors/],
    ['schemaVersion: 1\nintegration: *shared', /aliases/],
    ['schemaVersion: 1\nintegration: !!map {}', /tags/],
    ['schemaVersion: 1\nintegration: !custom {}', /tag/i],
    ['schemaVersion: 1\n__proto__: {}', /unsupported key/],
    ['schemaVersion: 1\nintegration:\n  constructor: {}', /unsupported key/],
    ['schemaVersion: 1\n<<: {}', /unsupported key/],
    ['schemaVersion: 1\nintegration: [', /flow sequence|end|comma/i],
    ['null', /must be object/],
  ] as const) rejects(contents, reason);
});

test('canonical runtime definitions load without the YAML parser and retain validation and immutability', () => {
  withFile(JSON.stringify(pmdg()), filePath => {
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const originalLoad = Module._load;
      Module._load = function(name, ...args) {
        if (name === 'yaml') throw new Error('Canonical runtime definitions must not load the YAML parser');
        return originalLoad.call(this, name, ...args);
      };
      const { loadAircraftIntegrationDefinition } = require(${JSON.stringify(join(ORIGINAL_SOURCE_DIR, 'integration-yaml.js'))});
      const definition = loadAircraftIntegrationDefinition(${JSON.stringify(filePath)}, 'pmdg-737');
      assert(Object.isFrozen(definition.actions['mcp.ias.set'].routes));
      assert.throws(() => loadAircraftIntegrationDefinition(${JSON.stringify(filePath)}, 'wrong-aircraft'), /expected integration/);
    `], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('canonical fast parsing cannot hide duplicate keys, unsafe keys or non-finite values', () => {
  for (const contents of [
    '{"schemaVersion":2,"schemaVersion":1}',
    '{"profiles":{"nested":{"id":"first","id":"last"}}}',
    '{"profiles":{"nested":{"__proto__":{}}}}',
    '{"profiles":{"nested":{"constructor":{}}}}',
    '{"profiles":{"nested":{"prototype":{}}}}',
    '{"profiles":{"nested":{"<<":{}}}}',
    '{"profiles":{"nested":{"value":1e999}}}',
  ]) {
    withFile(contents, filePath => assert.throws(() => loadYamlDocument(filePath, (() => true) as any),
      /unique|duplicate|unsupported key|finite/i));
  }
  const value = { schemaVersion: 1, profiles: { nested: { id: 'nested', values: ['&anchor', '!tag', '*alias', '<<'], zero: -0 } } };
  withFile(JSON.stringify(value, null, 2), filePath => {
    const parsed = loadYamlDocument(filePath, (() => true) as any);
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(value)));
    assert(Object.isFrozen((parsed as typeof value).profiles.nested.values));
  });
});

test('full definitions reject unsupported fields, coercion and invalid independent confirmation before registration', () => {
  for (const mutate of [
    value => { value.schemaVersion = 2; },
    value => { value.schemaVersion = '1'; },
    value => { value.module = './unreviewed.js'; },
    value => { value.integration.typo = true; },
    value => { value.integration.id += '\n'; },
    value => { value.integration.fields['invalid.field\n'] = { id: 'invalid.field\n', sources: value.integration.fields['mcp.speed'].sources }; },
    value => { value.integration.fields['mcp.speed'].id = 'mcp.other'; },
    value => { value.integration.fields['mcp.speed'].sources = []; },
    value => { value.integration.fields['mcp.speed'].sources[0].decode.precision = '2'; },
    value => { value.integration.fields['mcp.speed'].sources[0].decode.typo = 1; },
    value => { value.integration.fields['mcp.speed'].sources[0].route.path = 'automation.constructor.speed'; },
    value => { value.integration.fields['mcp.speed'].sources[0].route.path = 'automation.speed\n'; },
    value => { value.integration.fields['mcp.speed'].sources[0].route.type = 'arbitrary'; },
    value => { value.integration.actions['mcp.ias.set'].guard.retry = 'always'; },
    value => { value.integration.actions['mcp.ias.set'].input.max = 1; },
    value => { value.integration.actions['mcp.ias.set'].routes[0].readback.fieldId = 'unknown.field'; },
    value => { value.integration.actions['mcp.ias.set'].routes[0].confirmation = 'transport-acknowledged'; },
    value => { value.integration.actions['mcp.ias.set'].routes.push(value.integration.actions['mcp.ias.set'].routes[0]); },
    value => { delete value.integration.actions['mcp.ias.set'].routes[0].readback; },
    value => { value.integration.trustedProfileKeys.push(value.integration.trustedProfileKeys[0]); },
  ]) {
    const document = pmdg();
    mutate(document);
    rejects(JSON.stringify(document), /definition|invalid|readback|route|input/i);
  }
  const booleanDocument = { schemaVersion: 1, integration: structuredClone(defaultAircraftIntegrationRegistry.getById('fenix-a32x')) };
  booleanDocument.integration.fields['lights.wing'].sources[0].decode.falseValues.push(1);
  rejects(JSON.stringify(booleanDocument), /overlapping true\/false/);
});

test('missing and oversized complete definitions cannot fall back to legacy code', () => {
  withFile('', filePath => {
    rmSync(filePath);
    assert.throws(() => loadAircraftIntegrationDefinition(filePath), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(filePath));
      assert.match(error.message, /ENOENT/);
      return true;
    });
  });
  rejects(`#${' '.repeat(AIRCRAFT_DEFINITION_MAX_BYTES)}`, /exceeds 2097152 bytes/);
});

test('conditional write descriptors reject malformed shapes and metadata the executor cannot consume', () => {
  for (const mutate of [
    route => { route.conditionalWrites.freshnessMs = '2000'; },
    route => { route.conditionalWrites.freshnessMs = 0; },
    route => { route.conditionalWrites.freshnessMs = 30001; },
    route => { route.conditionalWrites.retry = true; },
    route => { route.conditionalWrites.targets = []; },
    route => { route.conditionalWrites.targets[0].operationIndex = 0.5; },
    route => { route.conditionalWrites.targets[0].operationIndex = -1; },
    route => { route.conditionalWrites.targets[0].optional = true; },
    route => { route.conditionalWrites.targets[0].readbackFieldId = 'missing.field'; },
    route => { route.conditionalWrites.targets[0].prerequisiteFieldIds = []; },
    route => { route.conditionalWrites.targets[0].prerequisiteFieldIds.push('baro.captain.active'); },
    route => { route.conditionalWrites.targets[0].id = 'captain\n'; },
    route => { route.precondition = { fieldId: 'baro.captain.active', expectedValue: true }; },
    route => { route.confirmation = 'transport-acknowledged'; },
    route => { route.requiredSdkAdapter = 'pmdg-737'; },
  ]) {
    const document = { schemaVersion: 1, integration: structuredClone(defaultAircraftIntegrationRegistry.getById('fbw-a380x')) };
    mutate(document.integration.actions['baro.both.std'].routes[0]);
    rejects(JSON.stringify(document), /definition|conditional|barometer/i);
  }
});

test('bundled byte limits and regular-file checks happen before opening or allocating content', t => {
  withFile('12345', filePath => {
    const open = t.mock.method(fs, 'openSync');
    const allocate = t.mock.method(Buffer, 'alloc');
    assert.throws(() => readBundledDefinitionBytes(filePath, 4), /exceeds 4 bytes/);
    assert.throws(() => readBundledDefinitionBytes(join(filePath, '..'), 4), /not a regular file/);
    assert.equal(open.mock.callCount(), 0);
    assert.equal(allocate.mock.callCount(), 0);
  });
});

test('bounded definition reads finish partial reads and close the descriptor', t => {
  withFile('\uFEFFvalue: café\n', filePath => {
    const expected = readFileSync(filePath);
    const originalRead = fs.readSync;
    const reads = t.mock.method(fs, 'readSync', ((fd, bytes, offset, length, position) =>
      originalRead(fd, bytes, offset, Math.min(length, 3), position)) as typeof fs.readSync);
    const close = t.mock.method(fs, 'closeSync');
    assert.deepEqual(readBundledDefinitionBytes(filePath, expected.length), expected);
    assert.ok(reads.mock.callCount() > 1, 'partial reads are completed rather than treated as truncated content');
    assert.equal(close.mock.callCount(), 1);
    const descriptor = close.mock.calls[0].arguments[0];
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  });
});

for (const scenario of ['grow', 'shrink', 'read-error'] as const) {
  test(`bounded definition ${scenario} failure rejects content and closes the descriptor`, t => {
    withFile('12345678', filePath => {
      const originalRead = fs.readSync;
      let totalRead = 0;
      let changed = false;
      t.mock.method(fs, 'readSync', ((fd, bytes, offset, length, position) => {
        if (scenario === 'read-error') throw new Error('Injected read failure');
        const count = originalRead(fd, bytes, offset, Math.min(length, 3), position);
        totalRead += count;
        if (!changed) {
          changed = true;
          if (scenario === 'grow') fs.appendFileSync(filePath, 'additional data');
          else fs.truncateSync(filePath, 2);
        }
        return count;
      }) as typeof fs.readSync);
      const close = t.mock.method(fs, 'closeSync');
      assert.throws(() => readBundledDefinitionBytes(filePath, 8), /changed while reading|Injected read failure/);
      assert.ok(totalRead <= 8, 'a growing file cannot increase the read budget');
      // Fixture writes can close their own descriptors; the final close belongs
      // to the reader even when its last read throws or reaches premature EOF.
      const descriptor = close.mock.calls.at(-1)!.arguments[0];
      assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    });
  });
}

test('a definition changing size during open is rejected before allocation and its handle is closed', t => {
  withFile('1234', filePath => {
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    t.mock.method(fs, 'openSync', ((...args) => {
      const descriptor = Reflect.apply(originalOpen, fs, args);
      const writer = originalOpen(filePath, 'r+');
      try { fs.ftruncateSync(writer, 5); } finally { originalClose(writer); }
      return descriptor;
    }) as typeof fs.openSync);
    const allocate = t.mock.method(Buffer, 'alloc');
    const close = t.mock.method(fs, 'closeSync');
    assert.throws(() => readBundledDefinitionBytes(filePath, 8), /changed while opening/);
    assert.equal(allocate.mock.callCount(), 0);
    assert.equal(close.mock.callCount(), 1);
    assert.throws(() => fs.fstatSync(close.mock.calls[0].arguments[0]), { code: 'EBADF' });
  });
});

test('numeric decoder precision stays within the production decoder support', () => {
  const { decodeAircraftSpecificValue } = require('../../../aircraft/aircraft-specific-state');
  const document = pmdg();
  document.integration.fields['mcp.speed'].sources[0].decode = { type: 'number', precision: 6 };
  withFile(JSON.stringify(document), filePath => {
    const definition = loadAircraftIntegrationDefinition(filePath);
    const decoder = definition.fields['mcp.speed'].sources[0].decode;
    assert.equal(decodeAircraftSpecificValue(250.123456789, decoder), 250.123457);
  });
  for (const precision of [7, 8]) {
    document.integration.fields['mcp.speed'].sources[0].decode.precision = precision;
    rejects(JSON.stringify(document), /precision must be <= 6/);
  }
});

test('co-located underscore profile IDs load consistently without granting integration trust', () => {
  const root = mkdtempSync(join(tmpdir(), 'ff-integration-profile-'));
  const directory = join(root, 'aircraft-integrations');
  const profileKey = 'bundled/msfs/pmdg_737_untrusted';
  const document = { ...pmdg(), profiles: {
    [profileKey]: { ...readBundledProfile('bundled/msfs/pmdg-737'), id: 'pmdg_737_untrusted' },
  } };
  try {
    mkdirSync(directory);
    writeFileSync(join(root, 'aircraft-definition-files.json'), JSON.stringify(['pmdg-737.yaml']));
    const filePath = join(directory, 'pmdg-737.yaml');
    writeFileSync(filePath, JSON.stringify(document));
    const definition = loadAircraftIntegrationDefinition(filePath, 'pmdg-737');
    assert.deepEqual(listBundledProfileSources(directory).map(source => source.profileKey), [profileKey]);
    const registry = createAircraftIntegrationRegistry([definition]);
    assert.equal(registry.resolveForProfile(profileKey), null);
    assert.equal(registry.resolveIntegration('pmdg-737', { profileKey }), null);
    assert.equal(registry.resolveAction({ adapterId: 'pmdg-737', profileKey, actionId: 'mcp.ias.set' }), null);
    assert.equal(registry.resolveForProfile('bundled/msfs/pmdg-737').id, 'pmdg-737');
    document.integration.trustedProfileKeys.push(profileKey);
    rejects(JSON.stringify(document), /trustedProfileKeys/);
  } finally {
    clearBundledProfileSourceCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical barometer and COM contracts accept mapping-key reordering without changing ordered data', () => {
  function reorderMappingKeys(value: any): any {
    if (Array.isArray(value)) return value.map(reorderMappingKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorderMappingKeys(child)]));
  }
  for (const id of ['fbw-a32nx', 'fbw-a380x', 'fenix-a32x']) {
    const original = loadAircraftIntegrationDefinition(join(ORIGINAL_SOURCE_DIR, '../aircraft-integrations', `${id}.yaml`), id);
    const document = { schemaVersion: 1, integration: reorderMappingKeys(original) };
    const baroAction = Object.values(original.actions).find(action => action.routes.some(route => 'baro' in route));
    assert.ok(baroAction, 'the real integration has a canonical barometer action');
    assert.notDeepEqual(Object.keys(document.integration.actions[baroAction.id]),
      Object.keys(baroAction), 'the fixture actually changes mapping order');
    withFile(JSON.stringify(document), filePath => {
      const loaded = loadAircraftIntegrationDefinition(filePath, id);
      assert.deepEqual(loaded, original, 'all values, route order and operation order remain identical');
    });
  }
});

test('recipe semantics reject invalid metadata while independent fingerprints detect mapping drift', () => {
  const original = loadAircraftIntegrationDefinition(join(ORIGINAL_SOURCE_DIR, '../aircraft-integrations', 'fbw-a32nx.yaml'), 'fbw-a32nx');
  for (const mutate of [
    action => { action.guard.cooldownMs = -1; },
    action => { action.guard.skipIfSatisfied = true; },
    action => { delete action.input.step; },
    action => { action.routes[0].stagedControl.targets[0].writes.setValue = 999; },
    action => { action.routes.push(structuredClone(action.routes[0])); },
  ]) {
    const document = { schemaVersion: 1, integration: structuredClone(original) };
    mutate(document.integration.actions['baro.captain.qnhHpa']);
    rejects(JSON.stringify(document), /invalid .*contract|invalid action|must have required property|must be >=/);
  }
  // Valid aircraft parameters are authored in YAML, not duplicated in a second
  // controller. The frozen catalogue catches accidental changes to their values/order.
  const { projectPreExecutionCatalogue } = require(join(process.cwd(), 'tests/helpers/pre-execution-catalogue-projection.js'));
  const fingerprint = value => createHash('sha256').update(JSON.stringify(projectPreExecutionCatalogue(value))).digest('hex');
  for (const mutate of [
    action => { action.guard.cooldownMs += 1; },
    action => { action.routes[0].operations.reverse(); },
    action => { action.routes[0].readbacks.reverse(); },
  ]) {
    const changed = structuredClone(original);
    mutate(changed.actions['baro.captain.qnhHpa']);
    assert.notEqual(fingerprint(changed), fingerprint(original));
  }
  // Distinct route IDs are valid ordered alternatives. The catalogue fingerprint
  // must retain an unexpected extra route even when route selection is unchanged.
  const action = original.actions['baro.captain.qnhHpa'];
  const withAlternative = {
    ...original,
    actions: {
      ...original.actions,
      [action.id]: {
        ...action,
        routes: [...action.routes, { ...action.routes[0], id: 'unexpected.baro.route' }],
      },
    },
  };
  withFile(JSON.stringify({ schemaVersion: 1, integration: withAlternative }), filePath => {
    const loaded = loadAircraftIntegrationDefinition(filePath, 'fbw-a32nx');
    const registry = createAircraftIntegrationRegistry([loaded]);
    assert.equal(registry.selectActionRoute({
      adapterId: 'fbw-a32nx', profileKey: 'bundled/msfs/fbw-a32nx', actionId: action.id,
    }, ['simconnect-sequence']).routeId, original.actions[action.id].routes[0].id);
    assert.equal(projectPreExecutionCatalogue(loaded).actions[action.id].routes.length, 2);
    assert.notEqual(fingerprint(loaded), fingerprint(original));
  });
  for (const mutate of [
    operations => { operations[0].inputValue.scale += 1; },
    operations => { operations[0].parameters = []; },
    operations => { delete operations[0].inputValue.round; },
    operations => { operations.reverse(); },
  ]) {
    const document = { schemaVersion: 1, integration: structuredClone(original) };
    const route = document.integration.actions['radios.com1.switchTo'].routes[0];
    if (route.transport !== 'simconnect-sequence') throw new Error('Expected the existing COM sequence');
    mutate(route.operations);
    rejects(JSON.stringify(document), /invalid COM radio contract/);
  }
});
