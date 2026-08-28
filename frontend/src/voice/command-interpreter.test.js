import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAviationNumber } from './aviation-number-parser.js';
import { collectVoiceHints, interpretAircraftVoiceCommand } from './command-interpreter.js';

const catalogue = Object.freeze({
  configurationId: 'test-aircraft',
  commands: Object.freeze({
    heading: Object.freeze({
      id: 'flightGuidance.heading.set', label: 'Selected heading',
      input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
      speech: { patterns: ['set heading {value}', 'heading {value}'], hints: ['HEADING'] },
    }),
    courses: Object.freeze({
      id: 'flightGuidance.course.setBoth', label: 'Captain + FO course windows',
      input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
      speech: {
        patterns: [
          'set course {value}',
          'set courses {value}',
          'set both course {value}',
          'set both courses {value}',
          'set course windows {value}',
          'set both course windows {value}',
        ],
        hints: ['SET COURSE', 'SET COURSES', 'COURSE WINDOWS'],
      },
    }),
    altitude: Object.freeze({
      id: 'flightGuidance.altitude.set', label: 'Selected altitude',
      input: { kind: 'number', min: 0, max: 60000, step: 100, units: 'feet' },
      speech: {
        patterns: ['set altitude {value}', 'altitude {value}', 'set flight level {value}', 'flight level {value}'],
        hints: ['ALTITUDE', 'FLIGHT LEVEL'],
      },
    }),
    speed: Object.freeze({
      id: 'flightGuidance.speed.set', label: 'Selected speed',
      input: { kind: 'number', min: 0, max: 999, step: 1, units: 'knots' },
      speech: { patterns: ['set speed {value}', 'speed {value}'], hints: ['SPEED'] },
    }),
    mach: Object.freeze({
      id: 'flightGuidance.mach.set', label: 'Selected Mach',
      input: { kind: 'number', min: 0.4, max: 0.99, step: 0.01, units: 'mach' },
      speech: { patterns: ['set mach {value}', 'mach {value}'], hints: ['MACH'] },
    }),
    parkingBrake: Object.freeze({
      id: 'surfaces.parkingBrake.set', label: 'Parking brake',
      input: { kind: 'boolean' },
      speech: {
        patterns: ['parking brake {value}', '{value} parking brake'],
        hints: ['PARKING BRAKE'],
      },
    }),
    spoilersArmed: Object.freeze({
      id: 'surfaces.spoilersArmed.set', label: 'Ground spoilers',
      input: { kind: 'boolean' },
      speech: {
        patterns: [
          'ground spoilers {value}',
          '{value} ground spoilers',
          '{value} spoilers',
          'speed brake {value}',
          '{value} speed brake',
        ],
        hints: ['GROUND SPOILERS', 'SPOILERS', 'SPEED BRAKE'],
      },
    }),
    navRadios: Object.freeze({
      id: 'radios.nav.setBothActive', label: 'NAV 1 + NAV 2 active frequency',
      input: { kind: 'number', min: 108, max: 117.95, step: 0.05, units: 'megahertz' },
      speech: {
        patterns: ['set nav radios {value}', 'set both nav radios {value}', 'tune nav radios {value}'],
        hints: ['SET NAV RADIOS', 'NAV RADIOS'],
      },
    }),
    cockpitLighting: Object.freeze({
      id: 'configuration.lighting.cockpit', label: 'Cockpit lighting',
      input: { kind: 'number', min: 0, max: 100, step: 1, units: 'percent' },
      speech: {
        patterns: [
          'set cockpit lighting {value}',
          'set cockpit lights {value}',
          'set all cockpit lights {value}',
        ],
        hints: ['SET COCKPIT LIGHTING', 'COCKPIT LIGHTS'],
      },
    }),
    flaps: Object.freeze({
      id: 'surfaces.flaps.set', label: 'Flaps',
      input: { kind: 'enum', values: ['up', '1', '5', '25', '30'] },
      speech: { patterns: ['flaps {value}'], hints: ['FLAPS'] },
    }),
    takeoffLights: Object.freeze({
      id: 'configuration.lights.takeoff', label: 'Takeoff lights',
      input: { kind: 'none' },
      speech: {
        patterns: [
          'set lights for takeoff', 'set lights for take off',
          'set lights for a takeoff', 'set lights for a take off',
          'takeoff lights', 'take off lights',
        ],
        hints: ['TAKEOFF LIGHTS', 'LIGHTS FOR TAKEOFF'],
      },
    }),
  }),
});

const fenixCatalogue = Object.freeze({
  configurationId: 'fenix-a32x',
  commands: Object.freeze([
    {
      id: 'flightGuidance.autopilot1.set', label: 'Autopilot 1', input: { kind: 'boolean' },
      speech: { patterns: ['autopilot one {value}', '{value} autopilot one'] },
    },
    {
      id: 'flightGuidance.speedMode.set', label: 'Speed guidance mode',
      input: { kind: 'enum', values: ['selected', 'managed'] },
      speech: { patterns: ['set speed mode {value}', 'speed mode {value}'] },
    },
    {
      id: 'flightGuidance.altitudeHundred.set', label: 'Selected altitude (100-foot mode)',
      input: { kind: 'number', min: 0, max: 49000, step: 100, units: 'feet' },
      speech: {
        patterns: [
          'set altitude {value} in hundreds',
          'altitude {value} in hundreds',
          'set flight level {value} in hundreds',
          'flight level {value} in hundreds',
        ],
      },
    },
    {
      id: 'flightGuidance.altitudeThousand.set', label: 'Selected altitude (1,000-foot mode)',
      input: { kind: 'number', min: 0, max: 49000, step: 1000, units: 'feet' },
      speech: {
        patterns: [
          'set altitude {value} in thousands',
          'altitude {value} in thousands',
          'set flight level {value} in thousands',
          'flight level {value} in thousands',
        ],
      },
    },
    {
      id: 'propulsion.throttleDetent.set', label: 'Throttle detent',
      input: { kind: 'enum', values: ['idle', 'climb', 'flex', 'toga'] },
      speech: { patterns: ['set throttles {value}', 'throttles {value}', 'set throttle detent {value}'] },
    },
    {
      id: 'lights.noseMode.set', label: 'Nose light',
      input: { kind: 'enum', values: ['off', 'taxi', 'takeoff'] },
      speech: { patterns: ['nose light {value}', 'nose lights {value}'] },
    },
  ]),
});

const pmdg777Catalogue = Object.freeze({
  configurationId: 'pmdg-777',
  commands: Object.freeze([
    {
      id: 'flightGuidance.flightPathAngle.set', label: 'Selected flight path angle',
      input: { kind: 'number', min: -9.9, max: 9.9, step: 0.1, units: 'degrees' },
      speech: {
        patterns: [
          'set flight path angle {value}', 'flight path angle {value}',
          'set fpa {value}', 'fpa {value}', 'set f p a {value}', 'f p a {value}',
        ],
      },
    },
    {
      id: 'flightGuidance.autopilot1.engage', label: 'Autopilot 1', input: { kind: 'none' },
      speech: {
        patterns: [
          'engage autopilot one', 'engage auto pilot one',
          'engage autopilot left', 'engage auto pilot left',
          'engage left autopilot', 'engage left auto pilot', 'command a',
        ],
      },
    },
    {
      id: 'flightGuidance.autopilot2.engage', label: 'Autopilot 2', input: { kind: 'none' },
      speech: {
        patterns: [
          'engage autopilot two', 'engage auto pilot two',
          'engage autopilot right', 'engage auto pilot right',
          'engage right autopilot', 'engage right auto pilot',
        ],
      },
    },
    {
      id: 'flightGuidance.flightDirectorCaptain.set', label: 'Captain flight director', input: { kind: 'boolean' },
      speech: {
        patterns: [
          'captain flight director {value}', '{value} captain flight director',
          'left flight director {value}', '{value} left flight director', 'flight director left {value}',
        ],
      },
    },
    {
      id: 'flightGuidance.autothrottleArmLeft.set', label: 'Left autothrottle arm', input: { kind: 'boolean' },
      speech: {
        patterns: [
          'left autothrottle arm {value}', '{value} left autothrottle arm',
          'left auto throttle arm {value}', '{value} left auto throttle arm',
        ],
      },
    },
    {
      id: 'flightGuidance.lnav.engage', label: 'LNAV', input: { kind: 'none' },
      speech: { patterns: ['engage lnav', 'lnav', 'engage l nav', 'l nav', 'engage l n a b', 'l n a b'] },
    },
    {
      id: 'flightGuidance.vnav.engage', label: 'VNAV', input: { kind: 'none' },
      speech: { patterns: ['engage vnav', 'vnav', 'engage v nav', 'v nav'] },
    },
    {
      id: 'flightGuidance.flightLevelChange.engage', label: 'Level change', input: { kind: 'none' },
      speech: { patterns: ['engage level change', 'engage flch', 'flch', 'engage f l c h', 'f l c h'] },
    },
    {
      id: 'flightGuidance.localizer.engage', label: 'VOR/LOC', input: { kind: 'none' },
      speech: { patterns: ['engage vor loc', 'engage localizer', 'engage loc', 'loc'] },
    },
    {
      id: 'flightGuidance.approach.engage', label: 'Approach mode', input: { kind: 'none' },
      speech: { patterns: ['engage approach mode', 'engage approach', 'approach', 'engage app', 'app'] },
    },
    {
      id: 'flightGuidance.headingReference.set', label: 'Heading reference',
      input: { kind: 'enum', values: ['hdg', 'trk'] },
      speech: { patterns: ['set heading reference {value}', 'heading reference {value}'] },
    },
    {
      id: 'flightGuidance.verticalReference.set', label: 'Vertical reference',
      input: { kind: 'enum', values: ['vs', 'fpa'] },
      speech: { patterns: ['set vertical reference {value}', 'vertical reference {value}'] },
    },
    {
      id: 'surfaces.flaps.set', label: 'Flap detent',
      input: { kind: 'enum', values: ['up', '1', '5', '15', '20', '25', '30'] },
      speech: { patterns: ['set flaps {value}', 'flaps {value}'] },
    },
    {
      id: 'surfaces.autobrake.set', label: 'Autobrake',
      input: { kind: 'enum', values: ['rto', 'off', 'disarm', '1', '2', 'max'] },
      speech: {
        patterns: [
          'set autobrake {value}', 'autobrake {value}',
          'set auto brake {value}', 'auto brake {value}',
          'set otto brake {value}', 'otto brake {value}',
        ],
      },
    },
  ]),
});

test('aviation number parser accepts digit sequences, cardinal values, flight levels, and decimals', () => {
  assert.equal(parseAviationNumber('two seven zero'), 270);
  assert.equal(parseAviationNumber('zero niner zero'), 90);
  assert.equal(parseAviationNumber('tree fife zero'), 350);
  assert.equal(parseAviationNumber('one twenty'), 120);
  assert.equal(parseAviationNumber('one twenty five'), 125);
  assert.equal(parseAviationNumber('two fifty'), 250);
  assert.equal(parseAviationNumber('two seventy'), 270);
  assert.equal(parseAviationNumber('1 20'), 120);
  assert.equal(parseAviationNumber('2 50'), 250);
  assert.equal(parseAviationNumber('1 2 5'), 125);
  assert.equal(parseAviationNumber('one hundred twenty'), 120);
  assert.equal(parseAviationNumber('ten thousand five hundred'), 10500);
  assert.equal(parseAviationNumber('one two thousand'), 12000);
  assert.equal(parseAviationNumber('flight level two five zero'), 25000);
  assert.equal(parseAviationNumber('minus one thousand'), -1000);
  assert.equal(parseAviationNumber('point seven eight', { units: 'mach' }), 0.78);
  assert.equal(parseAviationNumber('one twenty degrees', { units: 'degrees' }), 120);
  assert.equal(parseAviationNumber('two fifty knots', { units: 'knots' }), 250);
  assert.equal(parseAviationNumber('one one zero decimal three megahertz', { units: 'megahertz' }), 110.3);
  assert.equal(parseAviationNumber('five thousand feet', { units: 'feet' }), 5000);
  assert.equal(parseAviationNumber('minus five hundred feet per minute', { units: 'feet-per-minute' }), -500);
  assert.equal(parseAviationNumber('fifty percent', { units: 'percent' }), 50);
  assert.equal(parseAviationNumber('seventy five per cent', { units: 'percent' }), 75);
  assert.equal(parseAviationNumber('one twenty feet', { units: 'degrees' }), null);
});

test('interpreter resolves only exact active-catalogue patterns', () => {
  assert.deepEqual(interpretAircraftVoiceCommand('Set heading two seven zero', catalogue), {
    ok: true, transcript: 'set heading two seven zero', commandId: 'flightGuidance.heading.set',
    input: { value: 270 }, label: 'Selected heading',
  });
  assert.equal(interpretAircraftVoiceCommand('could you set heading two seven zero please', catalogue).ok, false);
  assert.equal(interpretAircraftVoiceCommand('turn on a random thing', catalogue).reason, 'unmatched');
  assert.deepEqual(interpretAircraftVoiceCommand('heading one twenty', catalogue).input, { value: 120 });
  assert.deepEqual(interpretAircraftVoiceCommand('heading 1 20', catalogue).input, { value: 120 });
  assert.deepEqual(interpretAircraftVoiceCommand('heading one twenty degrees', catalogue).input, { value: 120 });
  assert.deepEqual(interpretAircraftVoiceCommand('set courses two seven zero', catalogue), {
    ok: true,
    transcript: 'set courses two seven zero',
    commandId: 'flightGuidance.course.setBoth',
    input: { value: 270 },
    label: 'Captain + FO course windows',
  });
  assert.deepEqual(interpretAircraftVoiceCommand('set course one two zero', catalogue), {
    ok: true,
    transcript: 'set course one two zero',
    commandId: 'flightGuidance.course.setBoth',
    input: { value: 120 },
    label: 'Captain + FO course windows',
  });
  assert.deepEqual(
    interpretAircraftVoiceCommand('set both course windows three five niner degrees', catalogue).input,
    { value: 359 },
  );
  assert.equal(interpretAircraftVoiceCommand('set courses three six zero', catalogue).ok, false);
  assert.equal(interpretAircraftVoiceCommand('set courses two seven zero point five', catalogue).ok, false);
  assert.deepEqual(interpretAircraftVoiceCommand('set nav radios one one zero decimal three', catalogue), {
    ok: true,
    transcript: 'set nav radios one one zero decimal three',
    commandId: 'radios.nav.setBothActive',
    input: { value: 110.3 },
    label: 'NAV 1 + NAV 2 active frequency',
  });
  assert.deepEqual(
    interpretAircraftVoiceCommand('tune nav radios one seventeen decimal niner five megahertz', catalogue).input,
    { value: 117.95 },
  );
  assert.equal(interpretAircraftVoiceCommand('set nav radios one zero seven decimal niner five', catalogue).ok, false);
  assert.equal(interpretAircraftVoiceCommand('set nav radios one one zero decimal three two', catalogue).ok, false);
  assert.deepEqual(interpretAircraftVoiceCommand('set cockpit lighting fifty percent', catalogue), {
    ok: true,
    transcript: 'set cockpit lighting fifty percent',
    commandId: 'configuration.lighting.cockpit',
    input: { value: 50 },
    label: 'Cockpit lighting',
  });
  assert.deepEqual(
    interpretAircraftVoiceCommand('set all cockpit lights to seventy five percent', catalogue).input,
    { value: 75 },
  );
  assert.equal(interpretAircraftVoiceCommand('set cockpit lights one hundred one percent', catalogue).ok, false);
  assert.equal(interpretAircraftVoiceCommand('set cockpit lights forty point five percent', catalogue).ok, false);
});

test('interpreter applies only bounded command-word corrections after exact matching fails', () => {
  assert.deepEqual(interpretAircraftVoiceCommand('seth mak zero point eight five', catalogue), {
    ok: true,
    transcript: 'seth mak zero point eight five',
    interpretedTranscript: 'set mach zero point eight five',
    commandId: 'flightGuidance.mach.set',
    input: { value: 0.85 },
    label: 'Selected Mach',
  });
  assert.deepEqual(interpretAircraftVoiceCommand('said heading two seven zero', catalogue), {
    ok: true,
    transcript: 'said heading two seven zero',
    interpretedTranscript: 'set heading two seven zero',
    commandId: 'flightGuidance.heading.set',
    input: { value: 270 },
    label: 'Selected heading',
  });
  assert.deepEqual(interpretAircraftVoiceCommand('said course one two zero', catalogue), {
    ok: true,
    transcript: 'said course one two zero',
    interpretedTranscript: 'set course one two zero',
    commandId: 'flightGuidance.course.setBoth',
    input: { value: 120 },
    label: 'Captain + FO course windows',
  });
  assert.deepEqual(interpretAircraftVoiceCommand('o set heading to one eight zero', catalogue), {
    ok: true,
    transcript: 'o set heading to one eight zero',
    interpretedTranscript: 'set heading one eight zero',
    commandId: 'flightGuidance.heading.set',
    input: { value: 180 },
    label: 'Selected heading',
  });
  assert.deepEqual(interpretAircraftVoiceCommand("SET SPEED TWO ONE'S NEARER", catalogue), {
    ok: true,
    transcript: 'set speed two ones nearer',
    interpretedTranscript: 'set speed two one zero',
    commandId: 'flightGuidance.speed.set',
    input: { value: 210 },
    label: 'Selected speed',
  });
  assert.deepEqual(interpretAircraftVoiceCommand("SET ALTITUDE TWO ONE'S NEARER", catalogue), {
    ok: false,
    reason: 'invalid-value',
    transcript: 'set altitude two ones nearer',
    interpretedTranscript: 'set altitude two one zero',
  });
  assert.equal(interpretAircraftVoiceCommand('random set heading two seven zero', catalogue).reason, 'unmatched');
  assert.equal(interpretAircraftVoiceCommand('seth random zero point eight five', catalogue).reason, 'unmatched');
});

test('interpreter rejects incomplete or invalid corrected values without guessing digits', () => {
  assert.equal(interpretAircraftVoiceCommand('set heading two seven', catalogue).reason, 'unmatched');
  assert.deepEqual(interpretAircraftVoiceCommand('set heading twenty seven', catalogue).input, { value: 27 });
  assert.deepEqual(interpretAircraftVoiceCommand('set heading 27', catalogue).input, { value: 27 });
  assert.equal(interpretAircraftVoiceCommand('seth mak zero point', catalogue).reason, 'invalid-value');
  assert.equal(interpretAircraftVoiceCommand('seth mak zero point nine nine nine', catalogue).reason, 'invalid-value');
  assert.equal(interpretAircraftVoiceCommand('set altitude nearer', catalogue).reason, 'unmatched');
  assert.equal(interpretAircraftVoiceCommand('set altitude two nearer', catalogue).reason, 'unmatched');
  assert.equal(interpretAircraftVoiceCommand('set altitude two nearer one', catalogue).reason, 'unmatched');
  assert.equal(interpretAircraftVoiceCommand('set altitude two hundred nearer', catalogue).reason, 'unmatched');
});

test('interpreter validates typed boolean, enum, altitude, and Mach inputs', () => {
  assert.deepEqual(interpretAircraftVoiceCommand('parking brake set', catalogue).input, { value: true });
  assert.deepEqual(interpretAircraftVoiceCommand('parking brake released', catalogue).input, { value: false });
  assert.deepEqual(interpretAircraftVoiceCommand('set parking brake', catalogue).input, { value: true });
  assert.deepEqual(interpretAircraftVoiceCommand('release parking brake', catalogue).input, { value: false });
  assert.deepEqual(interpretAircraftVoiceCommand('arm spoilers', catalogue).input, { value: true });
  assert.deepEqual(interpretAircraftVoiceCommand('disarm spoilers', catalogue).input, { value: false });
  assert.deepEqual(interpretAircraftVoiceCommand('speed brake armed', catalogue).input, { value: true });
  assert.deepEqual(interpretAircraftVoiceCommand('flaps twenty five', catalogue).input, { value: '25' });
  assert.deepEqual(interpretAircraftVoiceCommand('altitude flight level two five zero', catalogue).input, { value: 25000 });
  assert.deepEqual(interpretAircraftVoiceCommand('flight level three five zero', catalogue).input, { value: 35000 });
  assert.deepEqual(interpretAircraftVoiceCommand('set flight level two fifty', catalogue).input, { value: 25000 });
  assert.deepEqual(interpretAircraftVoiceCommand('mach point seven eight', catalogue).input, { value: 0.78 });
  assert.equal(interpretAircraftVoiceCommand('heading three six zero', catalogue).ok, false);
  assert.equal(interpretAircraftVoiceCommand('altitude one thousand fifty', catalogue).ok, false);
});

test('interpreter routes a no-input aircraft preset through its canonical command', () => {
  assert.deepEqual(interpretAircraftVoiceCommand('set lights for takeoff', catalogue), {
    ok: true,
    transcript: 'set lights for takeoff',
    commandId: 'configuration.lights.takeoff',
    input: {},
    label: 'Takeoff lights',
  });
  assert.equal(interpretAircraftVoiceCommand('takeoff lights', catalogue).commandId, 'configuration.lights.takeoff');
  assert.equal(
    interpretAircraftVoiceCommand('set lights for a take off', catalogue).commandId,
    'configuration.lights.takeoff',
  );
});

test('interpreter resolves Fenix FCU, managed-mode, throttle, and selector-aware altitude phrases', () => {
  assert.deepEqual(interpretAircraftVoiceCommand('engage autopilot one', fenixCatalogue).input, { value: true });
  assert.deepEqual(interpretAircraftVoiceCommand('disengage autopilot one', fenixCatalogue).input, { value: false });
  assert.deepEqual(interpretAircraftVoiceCommand('set speed mode managed', fenixCatalogue).input, { value: 'managed' });
  assert.deepEqual(
    interpretAircraftVoiceCommand('set altitude one two thousand five hundred in hundreds', fenixCatalogue),
    {
      ok: true,
      transcript: 'set altitude one two thousand five hundred in hundreds',
      commandId: 'flightGuidance.altitudeHundred.set',
      input: { value: 12500 },
      label: 'Selected altitude (100-foot mode)',
    },
  );
  assert.equal(
    interpretAircraftVoiceCommand('set altitude one two thousand five hundred in thousands', fenixCatalogue).ok,
    false,
    'the thousand-foot command must reject an off-step target',
  );
  assert.deepEqual(
    interpretAircraftVoiceCommand('flight level two five zero in thousands', fenixCatalogue).input,
    { value: 25000 },
  );
  assert.deepEqual(interpretAircraftVoiceCommand('set throttles flex mct', fenixCatalogue).input, { value: 'flex' });
  assert.deepEqual(interpretAircraftVoiceCommand('throttles clb', fenixCatalogue).input, { value: 'climb' });
  assert.deepEqual(interpretAircraftVoiceCommand('nose light take off', fenixCatalogue).input, { value: 'takeoff' });
  assert.equal(
    interpretAircraftVoiceCommand('set altitude one two thousand five hundred', fenixCatalogue).reason,
    'unmatched',
    'Fenix altitude voice must name the live hundred/thousand selector mode',
  );
});

test('interpreter resolves PMDG 777 MCP, AFDS, selector, and configuration phrases', () => {
  assert.equal(
    interpretAircraftVoiceCommand('engage autopilot left', pmdg777Catalogue).commandId,
    'flightGuidance.autopilot1.engage',
  );
  assert.equal(
    interpretAircraftVoiceCommand('engage auto pilot left', pmdg777Catalogue).commandId,
    'flightGuidance.autopilot1.engage',
  );
  assert.equal(
    interpretAircraftVoiceCommand('engage right autopilot', pmdg777Catalogue).commandId,
    'flightGuidance.autopilot2.engage',
  );
  assert.deepEqual(
    interpretAircraftVoiceCommand('captain flight director on', pmdg777Catalogue).input,
    { value: true },
  );
  assert.deepEqual(
    interpretAircraftVoiceCommand('left flight director on', pmdg777Catalogue).input,
    { value: true },
  );
  assert.deepEqual(
    interpretAircraftVoiceCommand('disarm left autothrottle arm', pmdg777Catalogue).input,
    { value: false },
  );
  assert.equal(interpretAircraftVoiceCommand('lnav', pmdg777Catalogue).commandId, 'flightGuidance.lnav.engage');
  assert.equal(interpretAircraftVoiceCommand('l nav', pmdg777Catalogue).commandId, 'flightGuidance.lnav.engage');
  assert.equal(interpretAircraftVoiceCommand('l n a b', pmdg777Catalogue).commandId, 'flightGuidance.lnav.engage');
  assert.equal(interpretAircraftVoiceCommand('engage vnav', pmdg777Catalogue).commandId, 'flightGuidance.vnav.engage');
  assert.equal(interpretAircraftVoiceCommand('f l c h', pmdg777Catalogue).commandId, 'flightGuidance.flightLevelChange.engage');
  assert.equal(interpretAircraftVoiceCommand('loc', pmdg777Catalogue).commandId, 'flightGuidance.localizer.engage');
  assert.equal(interpretAircraftVoiceCommand('app', pmdg777Catalogue).commandId, 'flightGuidance.approach.engage');
  assert.deepEqual(
    interpretAircraftVoiceCommand('set heading reference trk', pmdg777Catalogue).input,
    { value: 'trk' },
  );
  assert.deepEqual(
    interpretAircraftVoiceCommand('set heading reference t r k', pmdg777Catalogue).input,
    { value: 'trk' },
  );
  assert.deepEqual(
    interpretAircraftVoiceCommand('vertical reference fpa', pmdg777Catalogue).input,
    { value: 'fpa' },
  );
  assert.deepEqual(
    interpretAircraftVoiceCommand('set fpa minus two point five', pmdg777Catalogue).input,
    { value: -2.5 },
  );
  assert.deepEqual(
    interpretAircraftVoiceCommand('set f p a minus two point five', pmdg777Catalogue).input,
    { value: -2.5 },
  );
  assert.deepEqual(interpretAircraftVoiceCommand('flaps twenty', pmdg777Catalogue).input, { value: '20' });
  assert.deepEqual(interpretAircraftVoiceCommand('autobrake one', pmdg777Catalogue).input, { value: '1' });
  assert.deepEqual(interpretAircraftVoiceCommand('set autobrake rto', pmdg777Catalogue).input, { value: 'rto' });
  assert.deepEqual(interpretAircraftVoiceCommand('set autobrake r t o', pmdg777Catalogue).input, { value: 'rto' });
  assert.deepEqual(
    interpretAircraftVoiceCommand('said otto brake our ta', pmdg777Catalogue),
    {
      ok: true,
      transcript: 'said otto brake our ta',
      interpretedTranscript: 'set otto brake our ta',
      commandId: 'surfaces.autobrake.set',
      input: { value: 'rto' },
      label: 'Autobrake',
    },
  );
  assert.equal(interpretAircraftVoiceCommand('flaps ten', pmdg777Catalogue).ok, false);
  assert.equal(interpretAircraftVoiceCommand('fpa minus ten', pmdg777Catalogue).ok, false);
});

test('interpreter fails closed when multiple commands expose the same phrase', () => {
  const ambiguous = {
    commands: [
      ...Object.values(catalogue.commands),
      {
        id: 'other.heading.set',
        label: 'Other heading',
        input: catalogue.commands.heading.input,
        speech: { patterns: ['set heading {value}', 'heading {value}'] },
      },
    ],
  };
  assert.equal(interpretAircraftVoiceCommand('heading two seven zero', ambiguous).reason, 'ambiguous');
  assert.equal(interpretAircraftVoiceCommand('said heading two seven zero', ambiguous).reason, 'ambiguous');
});

test('voice hints are deduplicated from the active catalogue', () => {
  assert.deepEqual(collectVoiceHints(catalogue), [
    'HEADING',
    'SET COURSE',
    'SET COURSES',
    'COURSE WINDOWS',
    'ALTITUDE',
    'FLIGHT LEVEL',
    'SPEED',
    'MACH',
    'PARKING BRAKE',
    'GROUND SPOILERS',
    'SPOILERS',
    'SPEED BRAKE',
    'SET NAV RADIOS',
    'NAV RADIOS',
    'SET COCKPIT LIGHTING',
    'COCKPIT LIGHTS',
    'FLAPS',
    'TAKEOFF LIGHTS',
    'LIGHTS FOR TAKEOFF',
  ]);
});
