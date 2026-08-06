const assert = require('node:assert/strict');
const test = require('node:test');

const sdkRegistry = require('./sdk-registry.js');

test('sdk registry resolves generic SDK profile config', () => {
  const resolved = sdkRegistry.resolveProfileSdkConfig({
    preferred: 'sdk',
    sdk: {
      adapter: 'clientdata-manifest',
      target: {
        channel: 'community-test-clientdata',
      },
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.adapter.id, 'clientdata-manifest');
  assert.deepEqual(resolved.profileSdk.target, { channel: 'community-test-clientdata' });
});

test('sdk registry resolves declarative ClientData connector profile config', () => {
  const resolved = sdkRegistry.resolveProfileSdkConfig({
    preferred: 'sdk',
    sdk: {
      connector: 'community-test-clientdata',
      target: {
        channel: 'community-test-clientdata',
      },
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.adapter.id, 'clientdata-manifest');
  assert.deepEqual(resolved.profileSdk.target, {
    channel: 'community-test-clientdata',
    connector: 'community-test-clientdata',
  });
});

test('sdk registry does not apply retired vendor SDK compatibility aliases', () => {
  const resolved = sdkRegistry.resolveProfileSdkConfig({
    preferred: 'vendor-sdk',
    sdk: {
      channel: '777',
    },
  });

  assert.equal(resolved, null);
});

test('declarative ClientData connector profile does not inherit retired vendor defaults', () => {
  const resolved = sdkRegistry.resolveProfileSdkConfig({
    preferred: 'sdk',
    sdk: {
      adapter: 'clientdata-manifest',
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.adapter.id, 'clientdata-manifest');
  assert.deepEqual(resolved.profileSdk.target, {});
});

test('sdk registry treats only the canonical sdk id as the SDK source type', () => {
  assert.equal(sdkRegistry.isSdkSourceType('sdk'), true);
  assert.equal(sdkRegistry.isSdkSourceType('vendor-sdk'), false);
  assert.equal(sdkRegistry.isSdkSourceType('lvar-sidecar'), false);
});

export {};
