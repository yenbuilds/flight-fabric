const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const eventBus = require('../core/event-bus');
const { XPlaneTelemetryProvider } = require('./xplane-telemetry-provider');
const { createProvider, getDataSourceInfo } = require('./index');

test('XPlaneTelemetryProvider uses the official magnetic variation dataref name', () => {
  const source = fs.readFileSync(path.join(__dirname, 'xplane-telemetry-provider.js'), 'utf8');

  assert.match(source, /sim\/flightmodel\/position\/magnetic_variation['"]/);
  assert.doesNotMatch(source, /sim\/flightmodel\/position\/magnetic_variation_deg['"]/);
});

test('XPlaneTelemetryProvider emits disconnected fallback frame without fake wind/position data', async () => {
  const provider = new XPlaneTelemetryProvider();
  const frame = await provider.nextFrame();

  assert.equal(provider.isConnected(), false);
  assert.equal(frame.simconnect.connected, false);
  assert.equal(frame.simconnect.inFlightContext, false);
  assert.equal(frame.lat, null);
  assert.equal(frame.lon, null);
  assert.equal(frame.windSpeed, null);
  assert.equal(frame.windDir, null);
  assert.equal(frame.gforce, null);
  assert.equal(frame.fdm?.gForce, null);
  assert.equal(frame.surface?.onGround, false);
  assert.equal(frame.spoilers?.state, 'STOWED');
});

test('XPlaneTelemetryProvider maps core telemetry into existing frame contract', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._available = true;
  provider._connected = true;
  provider._capabilitiesInfo = { xplaneVersion: '12.4.0' };
  provider._data = {
    iasKts: 140,
    verticalVelocityMs: -3.6576,
    indicatedVsFpm: -300,
    raFt: 850,
    wow: 1,
    gsMs: 72,
    latDeg: 37.6188056,
    lonDeg: -122.3754167,
    flapsRatio: 0.5,
    flapsSystemRatio: 0.45,
    flapsAngleDeg: [0, 15, 15, 0],
    gearHandleDown: 1,
    gearDeploy: [1, 1, 1],
    spoilersRatio: 0.2,
    lightNav: 1,
    lightBeacon: 1,
    lightLanding: 0,
    lightTaxi: 1,
    lightStrobe: 0,
    parkingBrakeRatio: 1,
    pitchDeg: 3.5,
    bankDeg: -4.25,
    headingTrueDeg: 281,
    headingMagDeg: 267,
    magvarDeg: 14,
    windSpeedMs: 10,
    windDirTrueDeg: 250,
    engineN1: [81, 80, null, null],
    oatC: 12,
    runwayFriction: 5,
    fuelTotalKg: 5000,
    altMslM: 300,
    gForce: 1.22,
    paused: 0,
  };

  const frame = await provider.nextFrame();

  assert.equal(frame.display.iasKts, 140);
  assert.ok(Math.abs(frame.display.vsFpm - (-720)) < 0.001);
  assert.equal(frame.display.raFt, 850);
  assert.ok(Math.abs(frame.display.gsKts - 72 * 1.94384) < 0.001);
  assert.equal(frame.lat, 37.6188056);
  assert.equal(frame.lon, -122.3754167);
  assert.equal(frame.simconnect.lat, 37.6188056);
  assert.equal(frame.simconnect.lon, -122.3754167);
  assert.equal(frame.windDir, 250);
  assert.ok(Math.abs(frame.windSpeed - (10 * 1.94384)) < 0.001);
  assert.equal(frame.surface?.onGround, true);
  assert.equal(frame.gearHandle, 1);
  assert.equal(frame.flaps, 50);
  assert.equal(frame.flapsAngleDeg, 15);
  assert.equal(frame.spoilers?.percent, 20);
  assert.equal(frame.spoilers?.state, 'EXTENDED');
  assert.equal(frame.lights?.available, true);
  assert.equal(frame.lights?.nav, true);
  assert.equal(frame.lights?.beacon, true);
  assert.equal(frame.lights?.landing, false);
  assert.equal(frame.lights?.taxi, true);
  assert.equal(frame.lights?.strobe, false);
  assert.equal(frame.lights?.logo, null);
  assert.equal(frame.lights?.wing, null);
  assert.equal(frame.brake, 1);
  assert.equal(frame.gforce, 1.22);
  assert.equal(frame.fdm.gForce, 1.22);
  assert.equal(frame.fdm.fuelTotalGal, null);
  assert.ok(Math.abs(frame.fdm.fuelTotalWeightLbs - (5000 * 2.2046226218)) < 0.001);
  assert.equal(frame.fdm.xplaneRunwayFriction, 5);
  assert.equal(frame.simconnect.hdgTrueDeg, 281);
  assert.equal(frame.simconnect.hdgMagDeg, 267);
  assert.equal(frame.magvar, -14);
  assert.equal(frame.simconnect.magvarDeg, -14);
  assert.equal(frame.simconnect.simVersion, '12.4.0');
});

test('XPlaneTelemetryProvider uses physical vertical velocity instead of lagging VVI', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._data = {
    verticalVelocityMs: -2.54,
    indicatedVsFpm: -120,
  };

  const frame = await provider.nextFrame();

  assert.ok(Math.abs(frame.display.vsFpm - (-500)) < 0.001);
  assert.ok(Math.abs(frame.vs - (-2.54)) < 0.000001);
});

test('XPlaneTelemetryProvider declares documented legacy wind aliases as optional fallbacks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'xplane-telemetry-provider.js'), 'utf8');

  assert.match(source, /sim\/weather\/wind_speed_kt/);
  assert.match(source, /sim\/weather\/wind_direction_degt/);
  assert.match(source, /fallbackPaths/);
  assert.match(source, /HTTP 404/);
});

test('XPlaneTelemetryProvider falls back to Web API v1 when capabilities are unavailable', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_code: 'not_found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const provider = new XPlaneTelemetryProvider({ host: '127.0.0.1', port: address.port });
  await provider._fetchCapabilities();

  assert.equal(provider._apiVersion, 'v1');
  assert.match(provider._restBaseUrl, /\/api\/v1$/);
  assert.match(provider._wsUrl, /\/api\/v1$/);
});

test('XPlaneTelemetryProvider selects the highest API version advertised by X-Plane', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ api: { versions: ['v1', 'v2'] }, 'x-plane': { version: '12.1.4' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const provider = new XPlaneTelemetryProvider({ host: '127.0.0.1', port: address.port });
  await provider._fetchCapabilities();

  assert.equal(provider._apiVersion, 'v2');
  assert.match(provider._restBaseUrl, /\/api\/v2$/);
  assert.match(provider._wsUrl, /\/api\/v2$/);
  assert.equal(provider._capabilitiesInfo?.xplaneVersion, '12.1.4');
});

test('XPlaneTelemetryProvider converts the misleading legacy _kt wind dataref from documented metres per second', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._resolvedSpecs = [{
    key: 'windSpeedMs',
    path: 'sim/weather/wind_speed_kt',
    fallbackPaths: [],
    required: false,
    id: 1,
  }];
  provider._data = { windSpeedMs: 10 };

  const frame = await provider.nextFrame();

  assert.ok(Math.abs(frame.windSpeed - 19.4384) < 0.0001);
});

test('XPlaneTelemetryProvider resolves legacy wind aliases when optional current datarefs return 404', async (t) => {
  let nextId = 1;
  const ids = new Map();
  const unavailable = new Set([
    'sim/flightmodel/forces/g_nrml',
    'sim/weather/aircraft/wind_now_speed_msc',
    'sim/weather/aircraft/wind_now_direction_degt',
  ]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const names = url.searchParams.getAll('filter[name]');

    // Exercise the provider's documented fallback path for a batch containing
    // an unavailable name, then resolve each candidate exactly as X-Plane does.
    if (names.length !== 1 || unavailable.has(names[0])) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error_code: 'invalid_dataref_name' }));
      return;
    }

    const name = names[0];
    if (!ids.has(name)) ids.set(name, nextId++);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: ids.get(name), name }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const provider = new XPlaneTelemetryProvider({ host: '127.0.0.1', port: address.port });
  const resolved = await provider._resolveDatarefs();

  assert.equal(resolved.some((spec) => spec.key === 'gForce'), false);
  assert.equal(
    resolved.find((spec) => spec.key === 'windSpeedMs')?.path,
    'sim/weather/wind_speed_kt',
  );
  assert.equal(
    resolved.find((spec) => spec.key === 'windDirTrueDeg')?.path,
    'sim/weather/wind_direction_degt',
  );
});

test('XPlaneTelemetryProvider maps light datarefs and keeps arrays truthy when any light is on', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._data = {
    lightNav: 0,
    lightBeacon: 1,
    lightLanding: [0, 1, 0],
    lightTaxi: 0,
    lightStrobe: 1,
  };

  const frame = await provider.nextFrame();

  assert.equal(frame.lights?.available, true);
  assert.equal(frame.lights?.nav, false);
  assert.equal(frame.lights?.beacon, true);
  assert.equal(frame.lights?.landing, true);
  assert.equal(frame.lights?.taxi, false);
  assert.equal(frame.lights?.strobe, true);
  assert.equal(frame.lights?._source, 'xplane');
});

test('XPlaneTelemetryProvider falls back to system flap ratio only when handle ratio is unavailable', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._data = {
    flapsSystemRatio: 0.45,
  };

  const frame = await provider.nextFrame();

  assert.equal(frame.flaps, 45);
});

test('XPlaneTelemetryProvider emits X-Plane aircraft identity changes for profile detection', async () => {
  const provider = new XPlaneTelemetryProvider();
  const events = [];
  const off = eventBus.on('simconnect:aircraftChanged', (payload) => {
    events.push(payload);
  });

  try {
    provider._data = {
      aircraftAcfRelativePath: 'Aircraft/Laminar Research/Boeing 737-800/b738.acf',
      aircraftDescription: 'Boeing 737-800',
      aircraftIcao: 'B738',
    };

    const firstFrame = await provider.nextFrame();

    assert.equal(firstFrame.simconnect.aircraftLoadedName, 'Boeing 737-800');
    assert.deepEqual(firstFrame.simconnect.xplane, {
      acfPath: 'Aircraft/Laminar Research/Boeing 737-800/b738.acf',
      acfFileName: 'b738.acf',
      id: 'b738',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].displayName, 'Boeing 737-800');
    assert.equal(events[0].aircraftConfigPath, 'Aircraft/Laminar Research/Boeing 737-800/b738.acf');
    assert.deepEqual(events[0].xplane, {
      acfPath: 'Aircraft/Laminar Research/Boeing 737-800/b738.acf',
      acfFileName: 'b738.acf',
      id: 'b738',
    });

    await provider.nextFrame();
    assert.equal(events.length, 1);

    provider._data = {
      aircraftAcfRelativePath: 'Aircraft/B737-800X/b738.acf',
      aircraftDescription: 'Zibo Boeing 737-800X',
    };

    await provider.nextFrame();

    assert.equal(events.length, 2);
    assert.equal(events[1].previousAircraftConfigPath, 'Aircraft/Laminar Research/Boeing 737-800/b738.acf');
    assert.equal(events[1].aircraftConfigPath, 'Aircraft/B737-800X/b738.acf');
    assert.deepEqual(events[1].previousXplane, {
      acfPath: 'Aircraft/Laminar Research/Boeing 737-800/b738.acf',
      acfFileName: 'b738.acf',
      id: 'b738',
    });
  } finally {
    off();
  }
});

test('XPlaneTelemetryProvider decodes base64 string datarefs for X-Plane aircraft identity', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._resolvedSpecs = [
    {
      key: 'aircraftAcfRelativePath',
      path: 'sim/aircraft/view/acf_relative_path',
      id: 101,
      stringData: true,
    },
    {
      key: 'aircraftDescription',
      path: 'sim/aircraft/view/acf_descrip',
      id: 102,
      stringData: true,
    },
    {
      key: 'aircraftIcao',
      path: 'sim/aircraft/view/acf_ICAO',
      id: 103,
      stringData: true,
    },
  ];

  provider._applyUpdate({
    101: Buffer.from('Aircraft/Laminar Research/Boeing 737-800/b738.acf\0', 'utf8').toString('base64'),
    102: Buffer.from('Boeing 737-800', 'utf8').toString('base64'),
    103: Buffer.from('B738', 'utf8').toString('base64'),
  });

  const frame = await provider.nextFrame();

  assert.equal(frame.simconnect.aircraftLoadedName, 'Boeing 737-800');
  assert.deepEqual(frame.simconnect.xplane, {
    acfPath: 'Aircraft/Laminar Research/Boeing 737-800/b738.acf',
    acfFileName: 'b738.acf',
    id: 'b738',
  });
});

test('XPlaneTelemetryProvider does not derive stable X-Plane identity ids from friendly names', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._data = {
    aircraftDescription: 'Boeing 737-800',
    aircraftIcao: 'B738',
  };

  const frame = await provider.nextFrame();

  assert.equal(frame.simconnect.aircraftLoadedName, 'Boeing 737-800');
  assert.deepEqual(frame.simconnect.xplane, {
    acfPath: null,
    acfFileName: null,
    id: null,
  });
});

test('XPlaneTelemetryProvider preserves ARMED spoilers from negative speedbrake ratio', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._data = { spoilersRatio: -0.5 };

  const frame = await provider.nextFrame();

  assert.equal(frame.spoilers?.state, 'ARMED');
  assert.equal(frame.spoilers?.percent, 0);
  assert.equal(frame.spoilers?.fraction, 0);
});

test('XPlaneTelemetryProvider keeps gear handle independent from gear locked state', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._data = {
    gearHandleDown: 1,
    gearDeploy: [0.5, 0.5, 0.5],
  };

  const frame = await provider.nextFrame();

  assert.equal(frame.gearHandle, 1);
  assert.equal(frame.gearDownLocked, 0);
});

test('XPlaneTelemetryProvider parses numeric string booleans without treating "0" as true', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._connected = true;
  provider._data = {
    paused: '0',
    wow: '0',
    gearHandleDown: '0',
  };

  const frame = await provider.nextFrame();

  assert.equal(frame.paused, false);
  assert.equal(frame.inMenu, false);
  assert.equal(frame.wow, false);
  assert.equal(frame.surface?.onGround, false);
  assert.equal(frame.gearHandle, 0);
  assert.equal(frame.simconnect.inFlightContext, true);
});

test('XPlaneTelemetryProvider falls back to gear deploy state when gear handle dataref is unavailable', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._data = {
    gearDeploy: [1, 1, 1],
  };

  const frame = await provider.nextFrame();

  assert.equal(frame.gearDownLocked, 1);
  assert.equal(frame.gearHandle, 1);
});

test('XPlaneTelemetryProvider treats tiny spoiler ratios as stowed', async () => {
  const provider = new XPlaneTelemetryProvider();
  provider._data = { spoilersRatio: 0.03 };

  const frame = await provider.nextFrame();

  assert.equal(frame.spoilers?.state, 'STOWED');
  assert.equal(frame.spoilers?.percent, 0);
  assert.equal(frame.spoilers?.fraction, 0);
});

test('provider factory selects xplane mode and updates data source info', () => {
  const provider = createProvider({ isXPlane: true });

  assert.equal(provider.constructor.name, 'XPlaneTelemetryProvider');
  assert.deepEqual(getDataSourceInfo().primary, {
    type: 'xplane',
    name: 'X-Plane Web API',
    connected: false,
  });

  provider.stop();
});

test('provider factory selects xplane mode from simulator protocol setting', () => {
  const provider = createProvider({ simulatorProtocol: 'XPLANE_WEB' });

  assert.equal(provider.constructor.name, 'XPlaneTelemetryProvider');
  assert.deepEqual(getDataSourceInfo().primary, {
    type: 'xplane',
    name: 'X-Plane Web API',
    connected: false,
  });

  provider.stop();
});

export {};
