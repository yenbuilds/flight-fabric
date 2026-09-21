const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TOUCHDOWN_SHAKE_DISABLED,
  MIN_TOUCHDOWN_SHAKE_VS_FPM,
  ZERO_SHAKE_SAMPLE,
  buildTouchdownShakeProfile,
  normalizeTouchdownShakeIntensity,
  normalizeTouchdownShakeMethod,
  runTouchdownShake,
  touchdownShakeSeverity,
} = require('./touchdown-shake.js') as typeof import('./touchdown-shake.js');

type Sample = { pitch: number; bank: number; heading: number; dx: number; dy: number; dz: number };

function maxAbs(samples: Sample[], key: keyof Sample): number {
  return samples.reduce((acc, sample) => Math.max(acc, Math.abs(sample[key])), 0);
}

function sampleEvery(profile: ReturnType<typeof buildTouchdownShakeProfile>, stepMs: number): Sample[] {
  const samples: Sample[] = [];
  for (let ms = 0; ms <= profile.durationMs + stepMs; ms += stepMs) {
    samples.push(profile.sample(ms / 1000));
  }
  return samples;
}

test('normalizeTouchdownShakeMethod accepts the known transports and falls back otherwise', () => {
  assert.equal(normalizeTouchdownShakeMethod('eyepoint'), 'eyepoint');
  assert.equal(normalizeTouchdownShakeMethod(' Camera6DOF '), 'camera6dof');
  assert.equal(normalizeTouchdownShakeMethod('wasm'), 'eyepoint');
  assert.equal(normalizeTouchdownShakeMethod(undefined, 'camera6dof'), 'camera6dof');
  assert.equal(normalizeTouchdownShakeMethod(42 as unknown), 'eyepoint');
});

test('normalizeTouchdownShakeIntensity clamps and rejects garbage', () => {
  assert.equal(normalizeTouchdownShakeIntensity(undefined), 1);
  assert.equal(normalizeTouchdownShakeIntensity('0.5'), 0.5);
  assert.equal(normalizeTouchdownShakeIntensity(0), 0.1);
  assert.equal(normalizeTouchdownShakeIntensity(99), 3);
  assert.equal(normalizeTouchdownShakeIntensity('abc', 0.7), 0.7);
  assert.equal(normalizeTouchdownShakeIntensity(Number.NaN), 1);
});

test('severity grows with descent rate and saturates for hard landings', () => {
  const soft = touchdownShakeSeverity(-100);
  const normal = touchdownShakeSeverity(-400);
  const firm = touchdownShakeSeverity(-700);
  const hard = touchdownShakeSeverity(-1000);
  assert.ok(soft > 0.1 && soft < 0.25, `greaser severity ${soft}`);
  assert.ok(normal > soft && normal < firm && firm < hard, 'severity should be monotonic in |V/S|');
  assert.equal(hard, 1);
  assert.equal(touchdownShakeSeverity(-2500), 1, 'severity saturates');
  assert.equal(touchdownShakeSeverity(Number.NaN), 0);
  assert.ok(MIN_TOUCHDOWN_SHAKE_VS_FPM > 0);
});

test('profile starts and ends at zero, stays bounded, and scales with V/S', () => {
  const soft = buildTouchdownShakeProfile(-150, { seed: 7 });
  const hard = buildTouchdownShakeProfile(-1000, { seed: 7 });

  for (const profile of [soft, hard]) {
    assert.deepEqual(profile.sample(0), ZERO_SHAKE_SAMPLE, 'first frame must be neutral (no snap)');
    assert.deepEqual(profile.sample(-1), ZERO_SHAKE_SAMPLE);
    assert.deepEqual(profile.sample(profile.durationMs / 1000), ZERO_SHAKE_SAMPLE, 'last frame must be neutral');
    assert.deepEqual(profile.sample(Number.NaN), ZERO_SHAKE_SAMPLE);

    const samples = sampleEvery(profile, 4);
    for (const key of ['pitch', 'bank', 'heading'] as const) {
      assert.ok(maxAbs(samples, key) <= 6, `${key} stays inside the angle ceiling`);
    }
    for (const key of ['dx', 'dy', 'dz'] as const) {
      assert.ok(maxAbs(samples, key) <= 0.25, `${key} stays inside the offset ceiling`);
    }
    // The last 40 ms are a fade to nothing.
    const tail = samples.slice(-10);
    assert.ok(maxAbs(tail, 'dy') < 0.002 && maxAbs(tail, 'pitch') < 0.15, 'fade-out should leave only a whisper');
  }

  assert.ok(hard.durationMs > soft.durationMs, 'hard landings ring for longer');
  assert.ok(hard.durationMs >= 1700 && hard.durationMs <= 1900, `hard duration ${hard.durationMs}`);
  assert.ok(soft.durationMs >= 1050 && soft.durationMs <= 1200, `soft duration ${soft.durationMs}`);
  assert.ok(hard.peakDropMeters > soft.peakDropMeters * 2, 'hard landings drop the head much further');
  assert.ok(hard.peakDropMeters <= 0.08, 'even a hard landing keeps the drop under 8 cm');

  const softSamples = sampleEvery(soft, 4);
  const hardSamples = sampleEvery(hard, 4);
  assert.ok(maxAbs(hardSamples, 'dy') > maxAbs(softSamples, 'dy'));
  assert.ok(maxAbs(hardSamples, 'pitch') > maxAbs(softSamples, 'pitch'));
  assert.ok(maxAbs(hardSamples, 'bank') > maxAbs(softSamples, 'bank'));
});

test('the first movement is a downward drop followed by a rebound', () => {
  const profile = buildTouchdownShakeProfile(-500, { seed: 3 });
  const samples = sampleEvery(profile, 4);
  const stepSec = 0.004;

  let minIndex = 0;
  samples.forEach((sample, index) => {
    if (sample.dy < samples[minIndex].dy) minIndex = index;
  });
  const dropAt = minIndex * stepSec;
  assert.ok(dropAt > 0.04 && dropAt < 0.12, `drop peaks early (${dropAt.toFixed(3)} s)`);
  assert.ok(samples[minIndex].dy < -0.02, 'normal landing drops at least 2 cm');
  assert.ok(samples[minIndex].pitch > 0.5, 'the head nods down with the drop');

  const rebound = samples.slice(minIndex).find((sample) => sample.dy > 0.004);
  assert.ok(rebound, 'a rebound above neutral follows the drop');

  const hasHighFrequencyContent = samples
    .slice(Math.round(0.25 / stepSec), Math.round(0.45 / stepSec))
    .some((sample, index, window) => index > 0 && Math.sign(sample.bank - window[index - 1].bank) !== Math.sign(window[index - 1].bank - (window[index - 2]?.bank ?? window[index - 1].bank)));
  assert.ok(hasHighFrequencyContent, 'bank carries rumble, not a single slow sine');
});

test('intensity scales the whole profile and a seed makes it reproducible', () => {
  const base = buildTouchdownShakeProfile(-600, { seed: 11 });
  const loud = buildTouchdownShakeProfile(-600, { seed: 11, intensity: 2 });
  const same = buildTouchdownShakeProfile(-600, { seed: 11 });
  const other = buildTouchdownShakeProfile(-600, { seed: 12 });

  assert.equal(loud.durationMs, base.durationMs, 'intensity changes amplitude, not timing');
  assert.ok(Math.abs(loud.peakDropMeters - base.peakDropMeters * 2) < 1e-9);
  assert.deepEqual(same.sample(0.21), base.sample(0.21));
  assert.notDeepEqual(other.sample(0.21), base.sample(0.21), 'a different seed changes the rumble phases');
  assert.equal(base.intensity, 1);
  assert.equal(loud.intensity, 2);
  assert.equal(base.seed, 11);
});

test('the touchdown shake stays disabled until its transport is proven in the sim', () => {
  assert.equal(TOUCHDOWN_SHAKE_DISABLED, true,
    'flip this only together with the debug-modal button, the settings comment and docs/INTERNAL-CHANGELOG.md');
});

test('runTouchdownShake drives the transport on wall-clock time and always ends at zero', () => {
  const profile = buildTouchdownShakeProfile(-400, { seed: 5 });
  const sent: Sample[] = [];
  let clock = 1000;
  let intervalFn: (() => void) | null = null;
  let intervalMs = 0;
  let cleared = 0;
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  let completion: string | null = null;

  const runner = runTouchdownShake(profile, { send: (sample) => sent.push({ ...sample }) }, {
    now: () => clock,
    setIntervalFn: (fn, ms) => { intervalFn = fn; intervalMs = ms; return 1; },
    clearIntervalFn: () => { cleared += 1; },
    setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return 2; },
    clearTimeoutFn: () => {},
    onComplete: (reason) => { completion = reason; },
  });

  assert.equal(intervalMs, 16, 'defaults to ~60 Hz updates');
  assert.deepEqual(sent[0], ZERO_SHAKE_SAMPLE, 'the overlay is established at zero first');
  assert.equal(runner.active, true);

  clock += 70;
  intervalFn!();
  assert.ok(sent[sent.length - 1].dy < -0.01, 'a frame near the drop peak moves the camera down');

  // Jump straight past the end: the runner must not send a stale mid-curve frame.
  clock += profile.durationMs;
  intervalFn!();
  assert.equal(runner.active, false);
  assert.equal(cleared, 1);
  assert.deepEqual(sent[sent.length - 1], ZERO_SHAKE_SAMPLE, 'finishing sends an explicit zero');
  assert.equal(timeouts.length, 1, 'a settle zero is scheduled');
  assert.equal(timeouts[0].ms, 60);
  assert.equal(runner.settling, true, 'the runner still owns its settle write');
  assert.equal(completion, null, 'completion waits for the settle write so the runner stays reachable');
  const before = sent.length;
  timeouts[0].fn();
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent[sent.length - 1], ZERO_SHAKE_SAMPLE, 'the settle write is a zero');
  assert.equal(completion, 'finished');
  assert.equal(runner.settling, false);

  // Further ticks after completion are ignored.
  intervalFn!();
  assert.equal(sent.length, before + 1);
  runner.cancel();
  assert.equal(sent.length, before + 1, 'cancel after completion is a no-op');
});

test('runTouchdownShake cancel during the settle window drops the trailing zero exactly once', () => {
  const profile = buildTouchdownShakeProfile(-300, { seed: 9 });
  const sent: Sample[] = [];
  let clock = 0;
  let intervalFn: (() => void) | null = null;
  let clearedTimeouts = 0;
  const completions: string[] = [];
  const runner = runTouchdownShake(profile, { send: (sample) => sent.push({ ...sample }) }, {
    now: () => clock,
    setIntervalFn: (fn) => { intervalFn = fn; return 1; },
    clearIntervalFn: () => {},
    setTimeoutFn: () => 2,
    clearTimeoutFn: () => { clearedTimeouts += 1; },
    onComplete: (reason) => { completions.push(reason); },
  });
  clock += profile.durationMs + 1;
  intervalFn!();
  assert.equal(runner.active, false);
  assert.equal(runner.settling, true);
  const before = sent.length;
  // A bounce inside 60 ms: the next shake cancels this one before it settles.
  runner.cancel();
  assert.equal(clearedTimeouts, 1, 'the pending settle write is dropped');
  assert.equal(sent.length, before, 'cancelling a finished shake sends nothing more');
  assert.deepEqual(completions, ['finished'], 'the shake did finish, and completion fires exactly once');
  assert.equal(runner.settling, false);
  runner.cancel();
  assert.deepEqual(completions, ['finished'], 'a further cancel is a no-op');
});

test('runTouchdownShake cancel sends a zero and stops the timers', () => {
  const profile = buildTouchdownShakeProfile(-800, { seed: 9 });
  const sent: Sample[] = [];
  let clock = 0;
  let intervalFn: (() => void) | null = null;
  let cleared = 0;
  let completion: string | null = null;
  let transportCalls = 0;

  const runner = runTouchdownShake(profile, {
    send: (sample) => {
      transportCalls += 1;
      if (transportCalls === 2) throw new Error('sidecar hiccup');
      sent.push({ ...sample });
    },
  }, {
    now: () => clock,
    setIntervalFn: (fn) => { intervalFn = fn; return 1; },
    clearIntervalFn: () => { cleared += 1; },
    setTimeoutFn: () => 2,
    clearTimeoutFn: () => {},
    onComplete: (reason) => { completion = reason; },
  });

  clock = 60;
  intervalFn!();
  clock = 120;
  intervalFn!();
  assert.ok(sent.length >= 2, 'a throwing transport does not kill the shake');
  assert.notDeepEqual(sent[sent.length - 1], ZERO_SHAKE_SAMPLE);

  runner.cancel();
  assert.equal(runner.active, false);
  assert.equal(cleared, 1);
  assert.equal(completion, 'cancelled');
  assert.deepEqual(sent[sent.length - 1], ZERO_SHAKE_SAMPLE, 'cancel leaves the camera neutral');
});
