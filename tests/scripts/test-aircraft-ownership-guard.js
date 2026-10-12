'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { inspectSource, listRuntimeFiles, checkOwnership } = require('./aircraft-ownership-guard');
const { ROOT } = require('./backend-source-paths');
const { getRepoScratchPath } = require('../../scripts/repo-scratch');

function fixture(t) {
  const scratch = path.resolve(getRepoScratchPath());
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'aircraft-ownership-'));
  t.after(() => {
    assert.equal(path.dirname(root), scratch);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, text) => {
    const dest = path.join(root, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  };
  return { root, write };
}
const rules = (file, source) => inspectSource(file, source).map(hit => hit.rule);
const accepted = (file, source) => ({ reason: 'Reviewed legacy fixture',
  accepted: inspectSource(file, source).map(hit => `${hit.rule}:${hit.fingerprint}`) });

test('neutral code and comments do not become aircraft ownership violations', () => {
  assert.deepEqual(rules('backend/autotaxi/controller.ts', `
    // PMDG/Fenix/A32NX must stay behind integration boundaries.
    /* L:S_FCU_EFIS -- explanatory comment only */
    const headwind_component = 12;
    export const mode = frame.capabilities.taxi ? 'ready' : 'unavailable';
  `), []);
});

test('aircraft-specific file and folder names fail even without aircraft literals', () => {
  for (const file of ['backend/autotaxi/fenix-control.ts', 'backend/telemetry-provider/a32nx/helper.js',
    'frontend/src/voice/PMDG737.ts', 'backend/autotaxi/pmdg-737.json']) {
    assert.ok(rules(file, 'export const available = true;').includes('aircraft-file-placement'), file);
  }
});

test('generic filenames still expose profile branches, vendor identifiers and escaped strings', () => {
  for (const source of [
    `if (profile === 'bundled/msfs/fbw-a32nx') send(1);`,
    `const isFenix = frame.state.ready;`,
    `const profiles = { 'tfdi-md-11': { limit: 2 } };`,
    String.raw`const family = 'f\u0065nix-a32x';`,
    'const name = `A32NX_${field}`;',
    'if (/fenix/i.test(title)) send(1);',
  ]) assert.ok(rules('backend/autotaxi/adapters.ts', source).includes('aircraft-source-placement'), source);
});

test('raw aircraft variables are caught without a vendor name', () => {
  for (const source of [`write('L:S_FCU_EFIS', 1);`, `const key = 'S_FCU_EFIS_BARO';`,
    'write(`L:A_FC_THROTTLE_${side}_INPUT`, value);']) {
    assert.ok(rules('backend/core/helper.ts', source).includes('aircraft-raw-variable-placement'));
  }
});

test('direct dependencies are caught for static, dynamic, require and re-export syntax', () => {
  for (const source of [
    `import { execute } from '../aircraft/aircraft-integrations/new-family/control.js';`,
    `const module = await import('../aircraft/aircraft-integrations/new-family/control.js');`,
    `const module = require('../aircraft/aircraft-integrations/new-family/control.js');`,
    `export * from '../aircraft/aircraft-integrations/new-family/control.js';`,
  ]) assert.ok(rules('backend/autotaxi/adapters.ts', source).includes('aircraft-concrete-dependency'));
  assert.deepEqual(rules('backend/core/consumer.ts', `import { registry } from '../aircraft/aircraft-integrations/index.js';`), []);
});

test('existing mapping, protocol and presentation owners remain usable with distinct responsibilities', () => {
  for (const file of ['backend/aircraft/aircraft-integrations/fenix-a32x/actions.ts',
    'backend/aircraft/profiles/fbw-a32nx.ts', 'backend/telemetry-provider/cdu/fbw-a32nx.ts',
    'backend/telemetry-provider/sdk-adapters/pmdg.ts']) {
    assert.deepEqual(rules(file, `const fenix = 'L:S_FCU_EFIS';`), [], file);
  }
  const panel = 'frontend/src/vue/components/aircraft-specific/templates/FenixPanel.vue';
  assert.deepEqual(rules(panel, `<script setup>const title = 'Fenix A320';</script>`), []);
  assert.ok(rules(panel, `<script setup>send('L:S_FCU_EFIS', 1);</script>`).includes('aircraft-raw-variable-placement'));
  const dependency = `import { execute } from './aircraft-integrations/fbw-a32nx/control.js';`;
  assert.deepEqual(rules('backend/aircraft/barometer-execution.ts', dependency), []);
  assert.ok(rules('backend/aircraft/new-adapters.ts', dependency).includes('aircraft-concrete-dependency'));
  assert.ok(rules('backend/aircraft/barometer-execution.ts', `send('L:S_FCU_EFIS', 1);`).includes('aircraft-raw-variable-placement'));
  assert.ok(rules(panel, `<script>${dependency}</script>`).includes('aircraft-concrete-dependency'));
});

test('Vue script and script-setup are checked while display-only template text is ignored', () => {
  const source = `<template><p>Fenix A320</p></template>\n<script>const family = 'fenix-a32x';</script>\n<script setup lang="ts">send('L:S_FCU_EFIS', 1);</script>`;
  const hits = inspectSource('frontend/src/vue/components/GenericPanel.vue', source);
  assert.deepEqual(hits.map(hit => hit.line), [2, 3]);
  assert.deepEqual(rules('frontend/src/vue/components/GenericPanel.vue', '<template>PMDG 737</template>'), []);
});

test('exact exceptions allow formatting, comments, removals and unrelated neutral changes', t => {
  const { root, write } = fixture(t);
  const file = 'backend/autotaxi/adapters.ts';
  const original = `export function route(family) { if (family === 'fenix-a32x') send(1); }`;
  const baseline = { [file]: accepted(file, original) };
  for (const source of [original, `// documentation\n${original}`, original.replace('send(1)', 'send( 1 )'),
    `${original}\nexport const neutral = true;`, 'export const neutral = true;']) {
    write(file, source);
    assert.deepEqual(checkOwnership(root, baseline), []);
  }
});

test('fingerprints ignore multiline layout and internal comments but retain literal semantics', () => {
  const file = 'backend/autotaxi/adapters.ts';
  const original = `const adapters = { 'fenix-a32x': { pattern: /a b/, label: 'Fenix A320' } };`;
  const formatted = `/* table */ const adapters = {\n 'fenix-a32x': {\n /* explanatory comment */ pattern: /a b/,\n label: 'Fenix A320'\n }\n };`;
  const fingerprint = source => inspectSource(file, source)[0].fingerprint;
  assert.equal(fingerprint(original), fingerprint(formatted));
  assert.notEqual(fingerprint(original), fingerprint(original.replace('/a b/', '/ab/')));
  assert.notEqual(fingerprint(original), fingerprint(original.replace('Fenix A320', 'FenixA320')));
  assert.equal(fingerprint(original), fingerprint('/** Aircraft definition. */\n' + original));
  assert.notEqual(fingerprint(`function fenix() { return 1; }`), fingerprint(`function fenix() { return\n 1; }`));
});

test('exact exceptions reject growth, changed bodies, copies, duplicates and missing rationale', t => {
  const { root, write } = fixture(t);
  const file = 'backend/autotaxi/adapters.ts';
  const original = `export function route(family) { if (family === 'fenix-a32x') send(1); }`;
  const baseline = { [file]: accepted(file, original) };
  for (const source of [original.replace('send(1)', 'send(2)'),
    `${original}\nconst nextFamily = 'pmdg-777';`, `${original}\n${original}`,
    original.replace('send(1);', '{ send(1); newProcedure(); }')]) {
    write(file, source);
    assert.ok(checkOwnership(root, baseline).length > 0, source);
  }
  write(file, original);
  assert.ok(checkOwnership(root, { [file]: { ...baseline[file], reason: '' } }).length > 0);
  write('backend/autotaxi/new-adapters.ts', original);
  assert.ok(checkOwnership(root, baseline).some(hit => hit.file.endsWith('new-adapters.ts')));
});

test('real Autotaxi exceptions pass unchanged and reject added mappings and changed Fenix limits', t => {
  const { root, write } = fixture(t);
  const baseline = require('./aircraft-ownership-baseline.json');
  for (const file of ['backend/autotaxi/adapters.ts', 'backend/autotaxi/axes.ts']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    write(file, source);
    assert.deepEqual(checkOwnership(root, baseline), []);
    const changed = file.endsWith('/axes.ts') ? source.replace('config.maxThrottle > 0.25', 'config.maxThrottle > 0.3')
      : source.replace('const profileFamilies =', `const anotherFamily = 'tfdi-md-11';\nconst profileFamilies =`);
    assert.notEqual(changed, source);
    write(file, changed);
    assert.ok(checkOwnership(root, baseline).some(hit => hit.file === file));
    write(file, source);
  }
});

test('filesystem scan includes new sources and excludes tests, dependencies and build outputs', t => {
  const { root, write } = fixture(t);
  const included = ['backend/new.cjs', 'backend/new.cts', 'shared/new.mts', 'frontend/src/new.vue', 'shared/new.mjs',
    'electron/new.js', 'packages/client/src/new.ts', 'backend/new-fenix.json'];
  const excluded = ['backend/core/fenix.test.ts', 'frontend/src/__tests__/pmdg.js',
    'backend/fixtures/pmdg.js', 'electron/test-pmdg.js', 'backend/types/generated/pmdg.d.ts',
    'backend/node_modules/pmdg/index.js', 'packages/client/dist/pmdg.js'];
  for (const file of [...included, ...excluded]) write(file, '');
  assert.deepEqual(listRuntimeFiles(root), included.sort());
  write('backend/new.ts', 'const family = "fenix-a32x";');
  write('backend/new.js', 'const generated = "fenix-a32x";');
  assert.ok(!listRuntimeFiles(root).includes('backend/new.js'));
  assert.ok(checkOwnership(root, {}).some(hit => hit.file === 'backend/new.ts'));
});
