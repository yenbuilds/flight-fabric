import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  clearBundledProfileSourceCache, getBundledProfileSource,
  listBundledProfileSources, readBundledProfile,
} from './aircraft-profile-sources.js';

function withDefinitions(documents: Record<string, unknown>, run: (directory: string, root: string) => void): void {
  const scratch = path.resolve('.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'profile-sources-'));
  const directory = path.join(root, 'aircraft-integrations');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, 'aircraft-definition-files.json'), JSON.stringify(Object.keys(documents)));
  for (const [name, document] of Object.entries(documents)) {
    fs.writeFileSync(path.join(directory, name), typeof document === 'string' ? document : JSON.stringify(document));
  }
  try { run(directory, root); } finally {
    clearBundledProfileSourceCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const documentFor = (key: string, profile: Record<string, unknown>) => ({ schemaVersion: 1, profiles: { [key]: profile } });

test('bundled YAML profiles retain logical identity, discovery order, raw exports and isolated reads', () => {
  withDefinitions({
    'family.yaml': { schemaVersion: 1, integration: { id: 'family' }, profiles: {
      'bundled/xplane/generic': { id: 'generic', simulator: 'xplane', name: 'X-Plane generic' },
      'bundled/msfs/family': { id: 'family', simulator: 'msfs' },
      'bundled/msfs/family-variant': { id: 'family-variant', simulator: 'msfs' },
      'bundled/msfs/variant': { id: 'variant', simulator: 'msfs', extends: 'bundled/msfs/base', aircraft: { flaps: { notches: [] } } },
      'bundled/msfs/with_underscore': { id: 'with_underscore', simulator: 'msfs' },
    } },
    'base.yaml': documentFor('bundled/msfs/base', { id: 'base', namespace: 'bundled', simulator: 'msfs', abstract: true }),
  }, directory => {
    assert.deepEqual(listBundledProfileSources(directory).map(entry => entry.profileKey), [
      'bundled/msfs/base', 'bundled/msfs/family-variant', 'bundled/msfs/family',
      'bundled/msfs/variant', 'bundled/msfs/with_underscore', 'bundled/xplane/generic',
    ]);
    const source = getBundledProfileSource('bundled/msfs/variant', directory)!;
    assert.equal(source.filePath, path.join(directory, 'family.yaml'));
    assert.equal(source.rawProfile.extends, 'bundled/msfs/base');
    assert.equal(Object.isFrozen(source.rawProfile.aircraft.flaps.notches), true);
    const first = readBundledProfile(source.profileKey, directory)!;
    first.aircraft.flaps.notches.push({ value: 1 });
    assert.deepEqual(readBundledProfile(source.profileKey, directory)!.aircraft.flaps.notches, []);
    assert.equal(readBundledProfile('local/msfs/variant', directory), null);
    assert.equal(readBundledProfile('bundled/msfs/missing', directory), null);
  });
});

test('bundled YAML profiles reject duplicate keys and mismatched document identity', () => {
  withDefinitions({
    'first.yaml': documentFor('bundled/msfs/example', { id: 'example' }),
    'second.yaml': documentFor('bundled/msfs/example', { id: 'example' }),
  }, directory => assert.throws(() => listBundledProfileSources(directory), /Duplicate bundled aircraft profile/));
  for (const profile of [
    { id: 'other' }, { id: 'example', namespace: 'local' }, { id: 'example', simulator: 'xplane' },
  ]) {
    withDefinitions({ 'example.yaml': documentFor('bundled/msfs/example', profile) }, directory => {
      assert.throws(() => listBundledProfileSources(directory), /identity does not match/);
    });
  }
  withDefinitions({ 'example.yaml': documentFor('local/msfs/example', { id: 'example' }) }, directory => {
    assert.throws(() => listBundledProfileSources(directory), /Invalid aircraft definition/);
  });
});

test('bundled YAML profile file manifest rejects missing, unlisted and unsafe paths', () => {
  for (const scenario of ['missing', 'unlisted', 'traversal', 'duplicate']) {
    withDefinitions({ 'example.yaml': documentFor('bundled/msfs/example', { id: 'example' }) }, (directory, root) => {
      if (scenario === 'missing') fs.unlinkSync(path.join(directory, 'example.yaml'));
      if (scenario === 'unlisted') fs.writeFileSync(path.join(directory, 'unlisted.yaml'), '{}');
      if (scenario === 'traversal') fs.writeFileSync(path.join(root, 'aircraft-definition-files.json'), '["../example.yaml"]');
      if (scenario === 'duplicate') fs.writeFileSync(path.join(root, 'aircraft-definition-files.json'), '["example.yaml","example.yaml"]');
      assert.throws(() => listBundledProfileSources(directory), /Missing aircraft definition|Unlisted aircraft definition|Invalid aircraft definition file manifest/);
    });
  }
});

for (const failure of ['malformed', 'missing'] as const) {
  test(`a later ${failure} profile source cannot publish a partial cache and recovers after repair`, t => {
    withDefinitions({
      'first.yaml': documentFor('bundled/msfs/first', { id: 'first', name: 'Before failed load' }),
      'second.yaml': documentFor('bundled/msfs/second', { id: 'second', name: 'Second' }),
    }, directory => {
      const firstPath = path.join(directory, 'first.yaml');
      const secondPath = path.join(directory, 'second.yaml');
      if (failure === 'malformed') fs.writeFileSync(secondPath, '{broken');
      else fs.unlinkSync(secondPath);
      assert.throws(() => listBundledProfileSources(directory), /Invalid aircraft definition|Missing aircraft definition/);

      // Updating the earlier valid entry proves a retry does not retain data
      // parsed before the later failure. Repair needs no explicit cache clear.
      fs.writeFileSync(firstPath, JSON.stringify(documentFor('bundled/msfs/first', { id: 'first', name: 'After repair' })));
      fs.writeFileSync(secondPath, JSON.stringify(documentFor('bundled/msfs/second', { id: 'second', name: 'Repaired' })));
      const scans = t.mock.method(fs, 'readdirSync');
      const opens = t.mock.method(fs, 'openSync');
      assert.deepEqual(listBundledProfileSources(directory).map(source => [source.id, source.rawProfile.name]), [
        ['first', 'After repair'], ['second', 'Repaired'],
      ]);
      assert.equal(scans.mock.callCount(), 1);
      assert.equal(opens.mock.callCount(), 3, 'one manifest and two definition reads rebuild the complete index');

      listBundledProfileSources(directory);
      assert.equal(getBundledProfileSource('bundled/msfs/first', directory)!.rawProfile.name, 'After repair');
      assert.equal(readBundledProfile('bundled/msfs/second', directory)!.name, 'Repaired');
      assert.equal(scans.mock.callCount(), 1, 'successful source snapshots avoid repeated directory scans');
      assert.equal(opens.mock.callCount(), 3, 'successful source snapshots avoid repeated file reads');
    });
  });
}

test('oversized definition manifest is rejected before its content is opened or allocated', t => {
  withDefinitions({ 'example.yaml': documentFor('bundled/msfs/example', { id: 'example' }) }, (directory, root) => {
    fs.writeFileSync(path.join(root, 'aircraft-definition-files.json'), ' '.repeat(32 * 1024 + 1));
    const open = t.mock.method(fs, 'openSync');
    const allocate = t.mock.method(Buffer, 'alloc');
    assert.throws(() => listBundledProfileSources(directory), /aircraft-definition-files\.json.*exceeds 32768 bytes/);
    assert.equal(open.mock.callCount(), 0);
    assert.equal(allocate.mock.callCount(), 0);
  });
});

test('bundled YAML profile reads reject non-finite authoring values instead of silently copying them as null', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'backend/aircraft/aircraft-integrations/profile-msfs-ga-base.yaml'), 'utf8');
  const threshold = 'hardMinFpm: -500';
  assert.ok(source.includes(threshold), 'the real GA profile supplies the finite threshold used by this regression');

  withDefinitions({ 'ga.yaml': source }, directory => {
    const raw = getBundledProfileSource('bundled/msfs/ga-base', directory)!.rawProfile;
    const copied = readBundledProfile('bundled/msfs/ga-base', directory)!;
    assert.equal(copied.aircraft.landing.grades.hardMinFpm, -500);
    assert.deepEqual(copied, raw, 'finite profile data survives the JSON-copy boundary unchanged');
  });

  // Deliberately malformed authoring fixtures, not actual aircraft telemetry or
  // shipped thresholds. All parse as non-finite JavaScript numbers, which JSON
  // copying would replace with null.
  for (const scalar of ['.inf', '-.inf', '.nan', '1e309']) {
    withDefinitions({ 'ga.yaml': source.replace(threshold, `hardMinFpm: ${scalar}`) }, directory => {
      assert.throws(() => readBundledProfile('bundled/msfs/ga-base', directory), /numeric values must be finite/);
    });
  }
});

test('bundled YAML source cache refreshes only when explicitly cleared', () => {
  withDefinitions({ 'example.yaml': documentFor('bundled/msfs/example', { id: 'example', name: 'Original' }) }, directory => {
    assert.equal(readBundledProfile('bundled/msfs/example', directory)!.name, 'Original');
    fs.writeFileSync(path.join(directory, 'example.yaml'), JSON.stringify(documentFor('bundled/msfs/example', { id: 'example', name: 'Updated' })));
    assert.equal(readBundledProfile('bundled/msfs/example', directory)!.name, 'Original');
    clearBundledProfileSourceCache();
    assert.equal(readBundledProfile('bundled/msfs/example', directory)!.name, 'Updated');
  });
});
