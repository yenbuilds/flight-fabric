const assert = require('node:assert/strict');
const test = require('node:test');
const { createProvider, getDataSourceInfo } = require('../../telemetry-provider/index');
const { MockProvider } = require('../../telemetry-provider/mock-provider');

test('mock selection starts the actual provider and preserves frame position and connected state', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23, 0, 0, 0) });
  const provider = createProvider({ isMock: true });
  assert.ok(provider instanceof MockProvider);
  assert.equal(provider.capabilities.isMock, true);
  await provider.start();

  const first = await provider.nextFrame();
  assert.equal(first.gpsSource, 'mock');
  assert.equal(first.simconnect.connected, true);
  assert.equal(first.simconnect.simRunning, true);
  assert.equal(first.simconnect.inFlightContext, true);
  assert.equal(first.simconnect.aircraftLoadedName, 'MOCK');
  assert.equal(first.simconnect.lastEventAt, new Date().toISOString());
  assert.equal(first.simconnect.inFlightContextAt, first.simconnect.lastEventAt);
  assert.equal(first.simconnect.lat, null);
  assert.equal(first.simconnect.lon, null);
  assert.ok(first.lat > 40 && first.lat < 41);
  assert.ok(first.lon > -74 && first.lon < -73);
  assert.equal(first.display.iasKts, first.ias);
  assert.equal(first.display.gsKts, first.gs);
  // The shared conversion uses a rounded metres-to-feet factor.
  assert.ok(Math.abs(first.display.raFt * 0.3048 - first.ra) < 0.001);
  assert.equal(getDataSourceInfo().primary.type, 'mock');

  t.mock.timers.tick(1000);
  const next = await provider.nextFrame();
  assert.notEqual(next.simconnect.lastEventAt, first.simconnect.lastEventAt);
  assert.notEqual(next.lat, first.lat);
  assert.equal(next.simconnect.connected, true);

  provider._runner = { getFlapsOverrideNotch: () => 12 };
  assert.equal((await provider.nextFrame()).flaps, 12);
  provider._runner = null;
  assert.ok([0, 100].includes((await provider.nextFrame()).flaps));
});

test('mock frames retain throttle and engine telemetry through a simulated throttle cycle', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const provider = new MockProvider();
  await provider.start();
  for (const [elapsed, expectedPercent] of [[0, 0], [2000, 50], [2000, 100], [2000, 50], [2000, 0]]) {
    t.mock.timers.tick(elapsed);
    const frame = await provider.nextFrame();
    assert.equal(frame.throttle.avgPct, expectedPercent);
    assert.equal(frame.engines.count, 2);
    assert.equal(frame.engines.eng1, expectedPercent);
    assert.equal(frame.engines.eng2, expectedPercent);
    assert.equal(frame.engines.eng3, null);
    assert.equal(frame.engines.eng4, null);
    assert.equal(frame.engines.eng1Text, `${expectedPercent}%`);
    assert.equal(frame.spoilers.state, 'STOWED');
  }
});

export {};
