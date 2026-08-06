const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const profileLoader = require('../aircraft/aircraft-profile-loader.js');
const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider.js');

test('SimConnectTelemetryProvider exposes generic SDK secondary source metadata', () => {
  const originalGetActiveProfile = profileLoader.getActiveProfile;
  profileLoader.getActiveProfile = () => ({
    dataSource: {
      preferred: 'sdk',
      sdk: {
        adapter: 'clientdata-manifest',
        connector: 'community-test-clientdata',
        target: {
          channel: 'community-test-clientdata',
        },
      },
    },
  });

  try {
    const provider = new SimConnectTelemetryProvider();
    provider._connected = true;
    provider._sdkBridge = {
      getSnapshot() {
        return {
          status: 'running',
          raw: { ap: true },
          normalized: { automation: { ap: { engaged: true } } },
          categories: ['sdk', 'autopilot', 'mcp', 'lights'],
          librarySpec: 'SimConnect.dll',
          error: null,
        };
      },
    };

    const source = provider._buildSdkSecondarySource();
    assert.ok(source);
    assert.equal(source.type, 'sdk');
    assert.equal(source.adapterId, 'clientdata-manifest');
    assert.equal(source.connected, true);
    assert.equal(source.name, 'Declarative ClientData SDK Connector (community-test-clientdata)');
    assert.deepEqual(source.categories, ['sdk', 'autopilot', 'mcp', 'lights']);
  } finally {
    profileLoader.getActiveProfile = originalGetActiveProfile;
  }
});

test('SimConnectTelemetryProvider does not mark null-only SDK snapshots connected', () => {
  const originalGetActiveProfile = profileLoader.getActiveProfile;
  profileLoader.getActiveProfile = () => ({
    dataSource: {
      preferred: 'sdk',
      sdk: {
        adapter: 'clientdata-manifest',
        connector: 'community-test-clientdata',
        target: {
          channel: 'community-test-clientdata',
        },
      },
    },
  });

  try {
    const provider = new SimConnectTelemetryProvider();
    provider._connected = true;
    provider._sdkBridge = {
      getSnapshot() {
        return {
          status: 'running',
          raw: { ap: null },
          normalized: {
            automation: {
              ap: {
                engaged: null,
                modes: {
                  lnav: null,
                  vnav: null,
                },
              },
            },
          },
          categories: ['sdk', 'autopilot', 'mcp', 'lights'],
          librarySpec: 'SimConnect.dll',
          error: null,
        };
      },
    };

    const source = provider._buildSdkSecondarySource();
    assert.ok(source);
    assert.equal(source.connected, false);
    assert.match(source.description, /No SDK connector data yet|No data/);
  } finally {
    profileLoader.getActiveProfile = originalGetActiveProfile;
  }
});

test('SimConnectTelemetryProvider SDK init remains available on generic profiles', async () => {
  const originalGetActiveProfile = profileLoader.getActiveProfile;
  profileLoader.getActiveProfile = () => ({ dataSource: null });

  try {
    const provider = new SimConnectTelemetryProvider();
    await provider._initSdkBridge();
    assert.equal(provider._sdkBridge, null);
    assert.equal(typeof provider._sdkAircraftListener, 'function');
    provider.stop();
  } finally {
    profileLoader.getActiveProfile = originalGetActiveProfile;
  }
});

test('SimConnectTelemetryProvider exposes Rust SimVars as primary without duplicating it as secondary', () => {
  const script = `
const assert = require('node:assert/strict');
const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider.js');
const provider = new SimConnectTelemetryProvider();
provider._connected = true;
provider._rustSimvarBridge = {
  getSnapshot() {
    return {
      status: 'running',
      values: { ias: 142, ra: null },
      subscriptions: ['ias', 'ra'],
      error: null,
    };
  },
};
const primary = provider.getPrimaryDataSource();
const secondary = provider.getSecondaryDataSources();
assert.equal(primary.type, 'rust-simvars');
assert.equal(primary.name, 'SimVars');
assert.equal(primary.connected, true);
assert.equal(primary.liveValueCount, 1);
assert.equal(
  secondary.some((source) => source && source.type === 'rust-simvars'),
  false,
  'Rust SimVars should not be duplicated as an additional source in primary mode',
);
`;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

export {};
