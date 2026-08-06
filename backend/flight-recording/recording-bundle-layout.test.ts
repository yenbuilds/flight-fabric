'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const test = require('node:test') as typeof import('node:test');
const layout = require('./recording-bundle-layout.js');

test('bundle layout uses an immutable start clock plus recording UUID', () => {
  const name = layout.buildBundleName(
    '2026-07-22T10:42:00.123Z',
    '6f2a8c1e-1234-4abc-8def-0123456789ab',
  );
  assert.equal(name, '2026-07-22_10-42-00Z--6f2a8c1e');
});

test('bundle discovery lists only safe canonical telemetry files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-layout-'));
  try {
    const paths = layout.getBundlePaths(root, '2026-07-22_10-42-00Z--6f2a8c1e');
    fs.mkdirSync(paths.dir);
    fs.writeFileSync(paths.csv, 'record_type,timestamp_utc\n');
    fs.writeFileSync(path.join(root, 'personal.csv'), 'personal,data\n');
    fs.mkdirSync(path.join(root, 'unrelated-folder'));
    fs.writeFileSync(path.join(root, 'unrelated-folder', 'other.csv'), 'other,data\n');

    assert.deepEqual(layout.listBundleCsvPaths(root), [paths.csv]);
    assert.equal(layout.getBundleFromCsvPath(paths.csv)?.bundleName, path.basename(paths.dir));
    assert.equal(layout.getArtifactPathForCsv(paths.csv, 'summary'), paths.summary);
    assert.equal(layout.getBundleFromCsvPath(path.join(root, 'personal.csv')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundle discovery refuses a symlink at the authoritative telemetry path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-layout-link-'));
  try {
    const outside = path.join(root, 'outside.csv');
    fs.writeFileSync(outside, 'record_type,timestamp_utc\n');
    const paths = layout.getBundlePaths(root, 'linked-bundle');
    fs.mkdirSync(paths.dir);
    try {
      fs.symlinkSync(outside, paths.csv, 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.skip('host cannot create file symlinks');
        return;
      }
      throw error;
    }
    assert.throws(() => layout.listBundleCsvPaths(root), /not a safe regular file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export {};
