import test from 'node:test';
import assert from 'node:assert/strict';
import { answerAircraftStateQuery as answer, stateQueryExamples } from './state-queries.js';

const profiles = ['fbw-a32nx', 'fenix-a319', 'fenix-a320', 'fenix-a321'];
const sides = ['captain', 'firstOfficer'];
function fixture(profile = 'fenix-a320') {
  const now = Date.now(), fenix = profile.startsWith('fenix');
  const state = { activeProfileKey: `bundled/msfs/${profile}`, activeProfileRevision: 8, sourceStatus: 'connected',
    values: {}, unavailable: [], valueUpdatedAt: {}, receivedAt: now, updatedAt: new Date(now).toISOString() };
  const set = (id, value) => { state.values[id] = value; state.valueUpdatedAt[id] = new Date(now - 10).toISOString(); };
  const altimeter = (side, mode = 'qnh', value = 1016, unit = 'hPa') => {
    const inHg = unit === 'inHg';
    set(`flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`, fenix ? inHg ? 'inhg' : 'hpa' : inHg);
    if (fenix) { set(`baro.${side}.qnh`, mode === 'qnh'); set(`baro.${side}.${inHg ? 'inhg' : 'hpa'}`, value); }
    else {
      set(`baro.${side}.mode`, { std: 0, qnh: 1, qfe: 2 }[mode]);
      set(`baro.${side}.valueMode`, mode === 'std' ? 0 : inHg ? 2 : 1); set(`baro.${side}.value`, value);
    }
  };
  set('baro.healthy', true);
  for (const side of sides) altimeter(side);
  const context = { profileKey: state.activeProfileKey, profileRevision: state.activeProfileRevision };
  return { state, now, fenix, set, altimeter, context, ask: text => answer(text, state, context, now) };
}

test('all four profiles answer captain, FO and both pressures with aviation digits and actual units', () => {
  for (const profile of profiles) {
    const h = fixture(profile);
    for (const text of ['what is captain qnh', "what's the captain's q n h", 'what is captain altimeter setting',
      'what is captain cue en aitch', 'what is captain Q.N.H.',
    ]) {
      assert.deepEqual(h.ask(text), { ok: true, id: 'baro.captain.setting', text: 'Captain Q N H one zero one six hectopascals.' });
    }
    assert.equal(h.ask('what are both altimeter settings').text, 'Both altimeters Q N H one zero one six hectopascals.');
    h.altimeter('firstOfficer', 'qnh', 29.90, 'inHg');
    assert.equal(h.ask("what's the first officer's qnh").text, 'First officer Q N H two nine decimal nine zero inches of mercury.');
    assert.equal(h.ask('what is qnh').text, 'Captain Q N H one zero one six hectopascals. First officer Q N H two nine decimal nine zero inches of mercury.');
    h.altimeter('firstOfficer', 'qnh', 1018);
    assert.match(h.ask('what are both altimeters set to').text, /Captain .*one six.*First officer .*one eight/);
  }
});

test('state queries share full acronym pronunciation handling and reject missing letters', () => {
  const h = fixture('fbw-a32nx');
  h.set('navigation.lsCaptain', true);
  assert.equal(h.ask('what is captain ell ess').text, 'captain L S on.');
  assert.equal(h.ask('what is captain l s').text, 'captain L S on.');
  assert.equal(h.ask('what is captain cue en'), null);
  assert.equal(h.ask('what is captain ell'), null);
});

test('standard questions distinguish actual STD from QNH 29.92, and do not need hidden pressure digits', () => {
  for (const profile of profiles) {
    const h = fixture(profile);
    h.altimeter('captain', 'qnh', 29.92, 'inHg');
    assert.equal(h.ask('is captain on s t d').text, 'No. Captain Q N H.');
    for (const side of sides) {
      h.altimeter(side, 'std');
      for (const field of [h.fenix ? `baro.${side}.hpa` : `baro.${side}.value`,
        `flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`]) delete h.state.valueUpdatedAt[field];
    }
    assert.equal(h.ask('are both altimeters on STD').text, 'Yes. Both altimeters standard pressure.');
    assert.equal(h.ask('what is captain qnh').text, 'Captain standard pressure.');
    h.altimeter('captain', 'qnh');
    assert.equal(h.ask('are both on standard pressure').text, 'No. Captain Q N H. First officer standard pressure.');
    if (!h.fenix) {
      h.altimeter('captain', 'qfe', 1009);
      assert.equal(h.ask('what is captain qnh').text, 'Captain Q F E one zero zero nine hectopascals.');
      assert.equal(h.ask('is captain altimeter on standard').text, 'No. Captain Q F E.');
      h.set('baro.captain.valueMode', 0);
      assert.equal(h.ask('is captain on standard').ok, false, 'inconsistent mode/display fields cannot answer');
    }
  }
});

test('both reports one unavailable side explicitly and never borrows the other altimeter', () => {
  for (const profile of profiles) {
    const h = fixture(profile);
    h.altimeter('captain', 'std');
    delete h.state.valueUpdatedAt[h.fenix ? 'baro.firstOfficer.qnh' : 'baro.firstOfficer.mode'];
    for (const phrase of ['are both altimeters on standard pressure', 'what are both altimeter settings']) {
      assert.deepEqual(h.ask(phrase), { ok: false, id: `baro.both.${phrase.startsWith('are') ? 'std' : 'setting'}`,
        text: 'Captain standard pressure. First officer altimeter data unavailable.' });
    }
    assert.equal(h.ask('is captain on standard').ok, true);
    assert.equal(h.ask('what is first officer qnh').ok, false);
  }
});

test('each required barometer observation must be current, valid and powered', () => {
  for (const profile of profiles) {
    const baseline = fixture(profile);
    const fields = ['baro.healthy', 'flightGuidance.baroUnitCaptain', ...(baseline.fenix
      ? ['baro.captain.qnh', 'baro.captain.hpa'] : ['baro.captain.mode', 'baro.captain.valueMode', 'baro.captain.value'])];
    for (const field of fields) for (const invalid of ['missing', 'stale', 'future', 'null', 'unavailable']) {
      const h = fixture(profile);
      if (invalid === 'missing') delete h.state.valueUpdatedAt[field];
      if (invalid === 'stale') h.state.valueUpdatedAt[field] = new Date(h.now - 2001).toISOString();
      if (invalid === 'future') h.state.valueUpdatedAt[field] = new Date(h.now + 5000).toISOString();
      if (invalid === 'null') h.state.values[field] = null;
      if (invalid === 'unavailable') h.state.unavailable.push(field);
      assert.equal(h.ask('what is captain qnh').ok, false, `${profile} ${field} ${invalid}`);
    }
    const h = fixture(profile);
    h.set('baro.healthy', false);
    assert.equal(h.ask('are both altimeters on std').ok, false);
    h.set('baro.healthy', true);
    for (const invalid of [0, 947, 1085, NaN, Infinity, 1016.5, '1016']) {
      h.set(h.fenix ? 'baro.captain.hpa' : 'baro.captain.value', invalid);
      assert.equal(h.ask('what is captain qnh').ok, false, `${profile} invalid pressure ${invalid}`);
    }
  }
});

test('barometer queries reject changed aircraft, disconnects and stale message replays', () => {
  for (const profile of profiles) {
    const h = fixture(profile), phrase = 'what is captain qnh';
    assert.equal(answer(phrase, h.state, { ...h.context, profileRevision: 9 }, h.now).ok, false);
    assert.equal(answer(phrase, h.state, h.context, h.now + 2001).ok, false);
    assert.equal(answer(phrase, { ...h.state, receivedAt: h.now + 5000 }, h.context, h.now + 5000).ok, false);
    h.state.sourceStatus = 'disconnected'; assert.equal(h.ask(phrase).ok, false);
  }
});

test('Fenix spoiler replies respect zero=ARM, retract, intermediate and full lever positions', () => {
  for (const profile of profiles.slice(1)) {
    const h = fixture(profile);
    for (const position of [0, 1, 1.2, 2, 2.8, 3]) {
      h.set('controls.speedbrakePosition', position);
      assert.equal(h.ask('are spoilers armed').text, `Ground spoilers ${position === 0 ? 'armed' : 'disarmed'}.`);
    }
    for (const position of [-1, .5, 3.1, '0', false, null, NaN, Infinity]) {
      h.set('controls.speedbrakePosition', position); assert.equal(h.ask('are spoilers armed').ok, false);
    }
    h.set('controls.speedbrakePosition', 0); h.set('baro.healthy', false);
    assert.equal(h.ask('are spoilers armed').ok, false);
    h.set('baro.healthy', true); delete h.state.valueUpdatedAt['controls.speedbrakePosition'];
    assert.equal(h.ask('are spoilers armed').ok, false);
  }
});

test('Fenix autobrake replies validate all three lamps and cannot infer OFF from unpowered or missing data', () => {
  for (const profile of profiles.slice(1)) {
    const h = fixture(profile), fields = ['low', 'medium', 'max'].map(m => `controls.autobrake.${m}`);
    for (const mode of ['off', 'low', 'medium', 'max']) {
      for (const field of fields) h.set(field, field.endsWith(`.${mode}`));
      assert.equal(h.ask('what is the autobrake setting').text, `Autobrake ${mode}.`);
    }
    for (const field of fields) for (const invalid of ['missing', 'stale', 'type']) {
      for (const f of fields) h.set(f, false);
      if (invalid === 'missing') delete h.state.valueUpdatedAt[field];
      if (invalid === 'stale') h.state.valueUpdatedAt[field] = new Date(h.now - 2001).toISOString();
      if (invalid === 'type') h.set(field, 0);
      assert.equal(h.ask('what is autobrake').ok, false);
    }
    for (const field of fields) h.set(field, true);
    assert.equal(h.ask('what is autobrake').ok, false);
    for (const field of fields) h.set(field, false);
    h.set('baro.healthy', false); assert.equal(h.ask('what is autobrake').ok, false);
  }
});

test('only reviewed profiles advertise the new questions; action, negative and compound phrases remain separate', () => {
  for (const profile of profiles) {
    const h = fixture(profile), examples = stateQueryExamples(h.state);
    assert.ok(examples.includes('what is captain qnh'));
    assert.ok(examples.includes('are both altimeters on std'));
    for (const text of ['set both qnh 1016', 'both standard pressure', 'captain QNH 1016', 'do not ask what is captain qnh',
      'what is captain qnh and set first officer qnh 1016', 'what is captain qnh then both standard pressure']) assert.equal(h.ask(text), null, text);
  }
  for (const profile of ['pmdg-737', 'pmdg-777', 'inibuilds-a350-900', 'inibuilds-a350-1000']) {
    const h = fixture(profile);
    assert.equal(h.ask('what is captain qnh').ok, false);
    assert.equal(stateQueryExamples(h.state).some(s => /qnh|standard pressure|on std/.test(s)), false);
  }
  const h = fixture(); h.state.activeProfileKey = 'local/msfs/fenix-a320';
  assert.deepEqual(stateQueryExamples(h.state), []);
});
