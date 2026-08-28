import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalReadback,
  formatAviationReadback,
} from './local-readback.js';

test('aviation readbacks speak flight guidance values unambiguously', () => {
  assert.equal(formatAviationReadback({
    commandId: 'flightGuidance.heading.set', label: 'Selected heading', input: { value: 5 },
  }), 'Heading zero zero five set.');
  assert.equal(formatAviationReadback({
    commandId: 'flightGuidance.course.setBoth', label: 'Captain + FO course windows', input: { value: 270 },
  }), 'Both courses two seven zero set.');
  assert.equal(formatAviationReadback({
    commandId: 'flightGuidance.altitude.set', label: 'Selected altitude', input: { value: 12400 },
  }), 'Altitude one two thousand four hundred set.');
  assert.equal(formatAviationReadback({
    commandId: 'flightGuidance.speed.set', label: 'Selected speed', input: { value: 250 },
  }), 'Speed two five zero set.');
  assert.equal(formatAviationReadback({
    commandId: 'flightGuidance.mach.set', label: 'Selected Mach', input: { value: 0.78 },
  }), 'Mach decimal seven eight set.');
  assert.equal(formatAviationReadback({
    commandId: 'flightGuidance.verticalSpeed.set', label: 'Selected vertical speed', input: { value: -1500 },
  }), 'Vertical speed descend one thousand five hundred set.');
  assert.equal(formatAviationReadback({
    commandId: 'flightGuidance.flightPathAngle.set', label: 'Selected flight path angle', input: { value: -2.5 },
  }), 'Flight path angle minus two decimal five set.');
  assert.equal(formatAviationReadback({
    commandId: 'radios.nav.setBothActive', label: 'NAV radios', input: { value: 113.9 },
  }), 'Nav radios one one three decimal nine zero set.');
});

test('aviation readbacks use natural state confirmations', () => {
  assert.equal(formatAviationReadback({
    commandId: 'surfaces.parkingBrake.set', label: 'Parking brake', input: { value: false },
  }), 'Parking brake released.');
  assert.equal(formatAviationReadback({
    commandId: 'surfaces.spoilersArmed.set', label: 'Ground spoilers', input: { value: true },
  }), 'Ground spoilers armed.');
  assert.equal(formatAviationReadback({
    commandId: 'surfaces.flaps.adjust', label: 'Flaps one detent', input: { value: 'increase' },
  }), 'Flaps increased one detent.');
  assert.equal(formatAviationReadback({
    commandId: 'surfaces.autobrake.set', label: 'Autobrake', input: { value: 'rto' },
  }), 'Autobrake R T O set.');
  assert.equal(formatAviationReadback({
    commandId: 'configuration.lights.takeoff', label: 'Takeoff lights', input: {},
  }), 'Takeoff lights set.');
});

test('local readback sends bounded text only to the trusted local Electron API', async () => {
  const spoken = [];
  let cancellations = 0;
  const readback = createLocalReadback({
    globalRef: {
      electronAPI: { voice: {
        cancelReadback: async () => { cancellations += 1; },
        getReadbackInfo: async () => ({ available: true, engine: 'windows-sapi', local: true }),
        speakReadback: async (text) => { spoken.push(text); return { started: true }; },
      } },
    },
  });

  assert.equal(await readback.prepare(), true);
  assert.equal(readback.speak(`  ${'x'.repeat(300)}  `), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(spoken, ['x'.repeat(240)]);
  assert.equal(readback.cancel(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellations, 1);
});

test('local readback stays silent when the native local engine is unavailable', async () => {
  const spoken = [];
  const readback = createLocalReadback({
    globalRef: {
      electronAPI: { voice: {
        cancelReadback: async () => {},
        getReadbackInfo: async () => ({ available: false, engine: '', local: true }),
        speakReadback: async (text) => { spoken.push(text); },
      },
      },
    },
  });

  assert.equal(await readback.prepare(), false);
  assert.equal(readback.speak('This must remain local.'), false);
  assert.deepEqual(spoken, []);
});
