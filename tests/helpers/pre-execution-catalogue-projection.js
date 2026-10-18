'use strict';

// The frozen catalogue predates these reviewed execution and metadata additions.
// Assert them independently before projecting only the declared additions and
// mode rename. Preserve all original values/order and every unreviewed extra.
// The isolated packaging probe embeds this function and passes expectedData.
function projectPreExecutionCatalogue(definition, expectedData = module.exports.executionBaseline) {
  const assert = require('node:assert/strict');
  const expected = {
    'baro.captain.std': { freshnessMs: 2000, targets: [
      { id: 'captain', operationIndex: 0, prerequisiteFieldIds: ['baro.captain.active'], readbackFieldId: 'baro.captain.std' },
    ] },
    'baro.firstOfficer.std': { freshnessMs: 2000, targets: [
      { id: 'firstOfficer', operationIndex: 0, prerequisiteFieldIds: ['baro.firstOfficer.active'], readbackFieldId: 'baro.firstOfficer.std' },
    ] },
    'baro.both.std': { freshnessMs: 2000, targets: [
      { id: 'captain', operationIndex: 0, prerequisiteFieldIds: ['baro.captain.active'], readbackFieldId: 'baro.captain.std' },
      { id: 'firstOfficer', operationIndex: 1, prerequisiteFieldIds: ['baro.firstOfficer.active'], readbackFieldId: 'baro.firstOfficer.std' },
    ] },
  };
  const projected = structuredClone(definition);
  // Each addition has its own independently captured/transcribed oracle. Do not
  // erase unreviewed metadata or regenerate the original catalogue fingerprint.
  const assertAndRemove = (object, key, expected, label) => {
    assert.deepStrictEqual(object[key], expected, label);
    delete object[key];
  };
  assertAndRemove(projected, 'catalogue', expectedData.catalogue[definition.id], 'reviewed catalogue metadata');
  assertAndRemove(projected, 'behavior', expectedData.behavior[definition.id], 'reviewed execution behavior');
  assertAndRemove(projected.presentation, 'cockpitLightingGroups', expectedData.lighting[definition.id], 'reviewed lighting groups');
  const additions = expectedData.requestedControls[definition.id];
  if (additions) {
    for (const section of ['fields', 'actions']) {
      for (const [key, value] of Object.entries(additions[section])) {
        assertAndRemove(projected[section], key, value, `${definition.id}/${key}: reviewed control addition`);
      }
    }
  }
  for (const action of Object.values(projected.actions)) {
    for (const route of action.routes) {
      const staged = expectedData.staged[route.id];
      if (staged) {
        assertAndRemove(route, 'stagedControl', staged, `${route.id}: reviewed staged control`);
        if (definition.id === 'fenix-a32x') {
          assert.equal(route.mode, 'staged-control');
          route.mode = 'fenix-baro';
        }
      }
      const displayEntry = expectedData.displayEntry[route.id];
      if (displayEntry) assertAndRemove(route, 'displayEntry', displayEntry, `${route.id}: reviewed display entry`);
    }
  }
  for (const [actionId, descriptor] of Object.entries(definition.id === 'fbw-a380x' ? expected : {})) {
    const action = projected.actions[actionId];
    assert.equal(action.routes.length, 1, `${actionId}: one reviewed route`);
    const route = action.routes[0];
    assert.equal(route.id, `fbwA380x.${actionId}`);
    assert.deepStrictEqual(route.conditionalWrites, descriptor, `${actionId}: reviewed conditional-write descriptor`);
    delete route.conditionalWrites;
  }
  // 2026-10-17 -300ER live correction. Assert only the reviewed changes before
  // comparing everything else with the frozen pre-migration catalogue.
  if (definition.id === 'pmdg-777') {
    for (const suffix of ['up', 'one', 'five', 'fifteen', 'twenty', 'twentyFive', 'thirty']) {
      const readback = projected.actions[`controls.flaps.${suffix}`].routes[0].readback;
      assert.equal(readback.timeoutMs, 5000, 'reviewed 777 flap selection window');
      readback.timeoutMs = 2500;
    }
    const half = projected.actions['controls.speedbrake.half'].routes[0].readback;
    assert.equal(half.expectedValue, 75, 'reviewed 777 HALF lever readback');
    half.expectedValue = 50;
  }
  return projected;
}

function projectPreSurfaceCorrectionProfile(profile, requestedControls = require('../fixtures/requested-aircraft-controls-20261017.json')) {
  const projected = structuredClone(profile);
  for (const addition of Object.values(requestedControls)) {
    const index = projected.provenance?.sources?.findIndex(source => source.name === addition.provenance.name) ?? -1;
    if (index >= 0) {
      require('node:assert/strict').deepEqual(projected.provenance.sources[index], addition.provenance, 'reviewed control provenance');
      projected.provenance.sources.splice(index, 1);
    }
  }
  if (!['pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f'].includes(profile.id)) return projected;
  const source = projected.provenance?.sources?.find(item => item.name === 'PMDG 777 MSFS SDK manual and installed sample');
  if (!source) return projected; // Raw variants inherit this provenance.
  const before = '0/100/50. Existing arming, flap and autobrake detents are preserved. See '
    + 'docs/APPROACH-CONTROLS-AIRCRAFT-COVERAGE.md; live validation is pending. Brightness correction';
  const after = '0/100/75. The HALF readback was corrected on 2026-10-17 using independent live SDK '
    + 'observation on the 777-300ER 2.4.146; the event name does not define the SDK lever scale. '
    + 'Flap selection still observes FCTL_Flaps_Lever, with a bounded 5000 ms window for the '
    + 'measured 2.8-3.5-second response, ahead of physical flap travel. Other variants remain '
    + 'untested live. See docs/APPROACH-CONTROLS-AIRCRAFT-COVERAGE.md. Brightness correction';
  require('node:assert/strict').equal(source.notes.split(after).length, 2, 'reviewed 777 surface provenance correction');
  source.notes = source.notes.replace(after, before);
  return projected;
}

const executionBaseline = {
  requestedControls: require('../fixtures/requested-aircraft-controls-20261017.json'),
  catalogue: require('../fixtures/aircraft-catalogue-exports-baseline.json').catalogues,
  behavior: require('../fixtures/aircraft-execution-behavior-baseline.json'),
  lighting: require('../fixtures/cockpit-lighting-groups-baseline.json'),
  staged: require('../fixtures/staged-control-recipes-baseline.json').recipes,
  displayEntry: require('../fixtures/guarded-display-entry-recipes-baseline.json').recipes,
};
module.exports = { projectPreExecutionCatalogue, projectPreSurfaceCorrectionProfile, executionBaseline };
