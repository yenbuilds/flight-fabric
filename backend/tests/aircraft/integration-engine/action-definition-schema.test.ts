
// Source-relative fixtures and runtime paths retain their original base after relocation.
const ORIGINAL_SOURCE_DIR = require('node:path').resolve(__dirname, '../../../aircraft/integration-engine');
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import Ajv from 'ajv';
import { actionDefinitionSchema } from '../../../aircraft/integration-engine/action-definition-schema.js';
import { MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH } from '../../../utils/mobiflight-protocol.js';
import type { AircraftIntegrationAction, AircraftIntegrationActionRoute, AircraftIntegrationDefinition } from '../../../aircraft/integration-engine/types.js';

const { defaultAircraftIntegrationRegistry } = require('../../../aircraft/integration-engine/index.js') as {
  defaultAircraftIntegrationRegistry: { list(): readonly AircraftIntegrationDefinition[] };
};
const ajv = new Ajv({ strict: true, allErrors: true });
const validate = ajv.compile(actionDefinitionSchema);
const definitions = defaultAircraftIntegrationRegistry.list();
const allActions = definitions.flatMap(definition => Object.values(definition.actions));

test('runtime action validation keeps transport alternatives out of one oversized generated function', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { createDocumentValidator } = require(${JSON.stringify(join(ORIGINAL_SOURCE_DIR, 'definition-yaml.js'))});
    const { actionDefinitionSchema } = require(${JSON.stringify(join(ORIGINAL_SOURCE_DIR, 'action-definition-schema.js'))});
    const validate = createDocumentValidator(actionDefinitionSchema);
    assert(validate.toString().length < 100_000, 'transport validators must remain referenced, not expanded inline');
  `], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

function actionWithRoute(predicate: (route: AircraftIntegrationActionRoute) => boolean): any {
  for (const action of allActions) {
    const route = action.routes.find(predicate);
    if (route) return structuredClone({ ...action, routes: [route] });
  }
  throw new Error('Expected an existing production route for this structural regression');
}

function accepts(action: AircraftIntegrationAction) {
  assert.equal(validate(action), true, ajv.errorsText(validate.errors));
}

function rejects(action: unknown) {
  assert.equal(validate(action), false, 'malformed action must fail at the structural loading boundary');
}

test('full action schema accepts every existing integration recipe without mutating it', () => {
  assert.equal(definitions.length, 18, 'all currently bundled integrations are covered');
  for (const definition of definitions) {
    for (const action of Object.values(definition.actions)) {
      const before = JSON.stringify(action);
      assert.equal(validate(action), true, `${definition.id}/${action.id}: ${ajv.errorsText(validate.errors)}`);
      assert.equal(JSON.stringify(action), before, 'schema validation must not coerce, strip or default mapping data');
    }
  }
});

test('full action schema closes every object and rejects mixed transport or confirmation shapes', () => {
  const simple = actionWithRoute(route => route.transport === 'lvar');
  const sdk = actionWithRoute(route => route.transport === 'sdk' && route.value !== undefined);
  const pulse = actionWithRoute(route => route.transport === 'mobiflight-calculator'
    && route.mode === 'pulse' && 'pressCode' in route);
  const sequence = actionWithRoute(route => route.transport === 'simconnect-sequence');
  const readback = simple.routes[0].readback;
  for (const mutate of [
    action => { action.unknown = true; },
    action => { action.guard.retry = 'always'; },
    action => { action.guard.unknown = true; },
    action => { action.routes[0].transport = 'custom-script'; },
    action => { action.routes[0].unknown = true; },
    action => { action.routes[0].readback.unknown = true; },
    action => { action.routes[0].readback.expectedInput = true; },
    action => { action.routes[0].readback.confirmation = 'changed'; },
    action => { action.routes[0].confirmation = 'transport-acknowledged'; },
    action => { action.routes[0].readbacks = [readback, readback]; },
    action => { delete action.routes[0].readback; },
    action => { action.routes[0].value = '1'; },
  ]) {
    const changed = structuredClone(simple);
    mutate(changed);
    rejects(changed);
  }
  accepts(sdk);
  sdk.routes[0].inputValue = { source: 'input' };
  rejects(sdk);
  accepts(pulse);
  pulse.routes[0].pulses = [{ when: [{ fieldId: readback.fieldId, expectedValue: true, freshness: 'field' }],
    pressCode: pulse.routes[0].pressCode, releaseCode: pulse.routes[0].releaseCode }];
  rejects(pulse);
  accepts(sequence);
  sequence.routes[0].operations[0].unknown = true;
  rejects(sequence);
});

test('full action schema bounds calculator expressions, pulse timing and complete target-step shapes', () => {
  const single = actionWithRoute(route => route.transport === 'mobiflight-calculator'
    && (route.mode === undefined || route.mode === 'single'));
  const pulse = actionWithRoute(route => route.transport === 'mobiflight-calculator' && route.mode === 'pulse');
  const step = actionWithRoute(route => route.transport === 'mobiflight-calculator' && route.mode === 'step-to-target');
  for (const code of ['', '1\n2', '1\0', 'é', 'X'.repeat(MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH + 1)]) {
    const changed = structuredClone(single);
    changed.routes[0].code = code;
    rejects(changed);
  }
  const wireLimit = structuredClone(single);
  wireLimit.routes[0].code = 'X'.repeat(MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH);
  accepts(wireLimit); // Wire envelope only; the registry still owns recipe validation.
  for (const delayMs of [0, 1001, 1.5]) {
    const changed = structuredClone(pulse);
    changed.routes[0].delayMs = delayMs;
    rejects(changed);
  }
  for (const mutate of [
    action => { action.routes[0].maxSteps = 501; },
    action => { action.routes[0].circular = false; },
    action => { action.routes[0].batchIncreaseCode = '{steps}'; delete action.routes[0].batchDecreaseCode; },
    action => { action.routes[0].prepareCode = '1'; delete action.routes[0].precondition; },
    action => { action.routes[0].readback = { ...single.routes[0].readback }; },
    action => { action.input.step = 0; },
    action => { action.input.max = Infinity; },
  ]) {
    const changed = structuredClone(step);
    mutate(changed);
    rejects(changed);
  }
});

test('full action schema preserves independently dated input events and exclusive sequence payloads', () => {
  const native = actionWithRoute(route => route.transport === 'input-event' && route.readback !== undefined);
  accepts(native);
  delete native.routes[0].readback.freshness;
  rejects(native);
  const paired = actionWithRoute(route => route.transport === 'input-event' && route.events !== undefined);
  accepts(paired);
  paired.routes[0].inputEvent = 'EXTRA_INPUT';
  paired.routes[0].value = 1;
  rejects(paired);
  const encoded = actionWithRoute(route => route.transport === 'simconnect-sequence'
    && route.operations.some(operation => operation.type === 'event' && operation.inputValue?.encoding !== undefined));
  accepts(encoded);
  const operation = encoded.routes[0].operations.find(item => item.inputValue?.encoding);
  operation.inputValue.scale = 1;
  rejects(encoded);
  delete operation.inputValue.scale;
  operation.value = 0;
  rejects(encoded);
});
