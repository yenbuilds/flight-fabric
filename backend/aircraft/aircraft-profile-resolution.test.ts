'use strict';

const assert = require('node:assert/strict');

const {
  resolveLoadedProfile,
} = require('./aircraft-profile-resolution.js') as {
  resolveLoadedProfile: (params: Record<string, any>) => { resolved: Record<string, any>; finalized: Record<string, any> } | null;
};

let passed = 0;

function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('resolveLoadedProfile runs the resolution pipeline and returns resolved plus finalized data', () => {
  const calls: string[] = [];
  const result = resolveLoadedProfile({
    locatorValue: 'bundled/msfs/test-aircraft',
    visited: new Set(['existing']),
    ensureBundledProfilesAvailable() {
      calls.push('available');
    },
    resolveProfilePath(locatorValue: unknown) {
      calls.push(`resolve:${locatorValue}`);
      return {
        filePath: '/tmp/test-aircraft.json',
        profileKey: 'bundled/msfs/test-aircraft',
        namespace: 'bundled',
        simulator: 'msfs',
      };
    },
    readProfileFile(filePath: string) {
      calls.push(`read:${filePath}`);
      return { id: 'test-aircraft', name: 'Test Aircraft' };
    },
    isProfileDefinition(profile: Record<string, any>) {
      calls.push(`validate:${profile.id}`);
      return true;
    },
    buildCanonicalProfile(resolved: Record<string, any>, rawProfile: Record<string, any>) {
      calls.push(`canonical:${resolved.profileKey}`);
      return { ...rawProfile, namespace: resolved.namespace, simulator: resolved.simulator };
    },
    resolveInheritance(profile: Record<string, any>, visited: Set<string>) {
      calls.push(`inherit:${visited.has('bundled/msfs/test-aircraft')}`);
      return { ...profile, inherited: true };
    },
    finalizeLoadedProfile(profile: Record<string, any>) {
      calls.push(`finalize:${profile._qualifiedId}`);
      return { ...profile, finalized: true };
    },
    log() {
      throw new Error('did not expect log call');
    },
  });

  assert.deepEqual(calls, [
    'available',
    'resolve:bundled/msfs/test-aircraft',
    'read:/tmp/test-aircraft.json',
    'validate:test-aircraft',
    'canonical:bundled/msfs/test-aircraft',
    'inherit:true',
    'finalize:bundled/msfs/test-aircraft',
  ]);
  assert.equal(result?.resolved.profileKey, 'bundled/msfs/test-aircraft');
  assert.equal(result?.finalized._source, '/tmp/test-aircraft.json');
  assert.equal(result?.finalized._qualifiedId, 'bundled/msfs/test-aircraft');
  assert.equal(result?.finalized.finalized, true);
});

test('resolveLoadedProfile logs and fails closed on invalid profile documents', () => {
  const logs: string[] = [];
  const result = resolveLoadedProfile({
    locatorValue: 'bundled/msfs/bad-aircraft',
    ensureBundledProfilesAvailable() {},
    resolveProfilePath() {
      return {
        filePath: '/tmp/bad-aircraft.json',
        profileKey: 'bundled/msfs/bad-aircraft',
      };
    },
    readProfileFile() {
      return { id: '' };
    },
    isProfileDefinition() {
      return false;
    },
    buildCanonicalProfile() {
      throw new Error('should not build canonical profile for invalid document');
    },
    resolveInheritance() {
      throw new Error('should not resolve inheritance for invalid document');
    },
    finalizeLoadedProfile() {
      throw new Error('should not finalize invalid document');
    },
    log(message: string) {
      logs.push(message);
    },
  });

  assert.equal(result, null);
  assert.deepEqual(logs, ['Skipping invalid profile JSON: /tmp/bad-aircraft.json']);
});

console.log(`PASS aircraft-profile-resolution ${passed}`);

export {};
