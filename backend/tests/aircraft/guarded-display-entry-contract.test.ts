import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasValidGuardedDisplayEntryRecipe } from '../../aircraft/guarded-display-entry-contract.js';
import { readDisplayEntryPage } from '../../aircraft/guarded-display-entry.js';
const { defaultAircraftIntegrationRegistry } = require('../../aircraft/integration-engine');
const action = () => defaultAircraftIntegrationRegistry.getById('fbw-a32nx').actions['approach.minimums.radio'];

test('authored display-entry input, layout and timing are validated together', () => {
  const original = action();
  assert.equal(hasValidGuardedDisplayEntryRecipe(original.routes[0].displayEntry, original.input), true);
  for (const mutate of [
    recipe => { recipe.input.max = 5001; },
    recipe => { recipe.input.step = 0.5; },
    recipe => { recipe.valueField = 'unknown'; },
    recipe => { recipe.valueField = 'radioAvailable'; },
    recipe => { recipe.clearFieldIds = ['radio']; },
    recipe => { recipe.clearFieldIds = ['baro', 'baro']; },
    recipe => { recipe.availableWhen.fieldId = 'unknown'; },
    recipe => { recipe.availableWhen.expectedValue = 'true'; },
    recipe => { recipe.page.fields.baro.row = 12; },
    recipe => { recipe.confirmKey = 'CLR'; },
    recipe => { recipe.channel = 'other'; },
    recipe => { recipe.url = 'ws://example.com'; },
    recipe => { recipe.timing.maxPayload = 65537; },
    recipe => { recipe.timing.stepTimeoutMs = 100; recipe.timing.settleMs = 200; },
    recipe => { recipe.messages.interference = ''; },
  ]) {
    const recipe = structuredClone(original.routes[0].displayEntry);
    mutate(recipe);
    assert.equal(hasValidGuardedDisplayEntryRecipe(recipe, original.input), false);
  }
});

test('display page parsing follows authored cells and labels rather than aircraft row constants', () => {
  const original = action();
  const recipe = structuredClone(original.routes[0].displayEntry);
  recipe.page.titlePrefix = 'APPROACH';
  recipe.page.labels = [{ row: 6, column: 0, equals: 'DECISION' }];
  recipe.page.fields = { selected: { row: 7, column: 0 }, alternate: { row: 8, column: 0 },
    enabled: { row: 9, column: 0, equals: 'AVAILABLE' } };
  recipe.valueField = 'selected'; recipe.clearFieldIds = ['alternate'];
  recipe.availableWhen = { fieldId: 'enabled', expectedValue: true };
  assert.equal(hasValidGuardedDisplayEntryRecipe(recipe, original.input), true);
  const lines = Array.from({ length: 12 }, () => ['', '']);
  lines[6][0] = '{white}DECISION{end}'; lines[7][0] = '200'; lines[8][0] = '[ ]'; lines[9][0] = 'AVAILABLE';
  assert.deepEqual(readDisplayEntryPage({ title: 'APPROACH ILS27', scratchpad: '', lines }, recipe), {
    title: 'APPROACH ILS27', scratchpad: '', fields: { selected: '200', alternate: '[ ]', enabled: true },
  });
  assert.equal(readDisplayEntryPage({ title: 'APPR ILS27', scratchpad: '', lines }, recipe), null);
  delete lines[7][0];
  assert.equal(readDisplayEntryPage({ title: 'APPROACH ILS27', scratchpad: '', lines }, recipe), null);
});
