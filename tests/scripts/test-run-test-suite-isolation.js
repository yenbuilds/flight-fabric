'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { getRepoScratchPath } = require('../../scripts/repo-scratch');
const {
  createIsolatedTestEnvironment,
  isPathWithin,
} = require('../run-test-suite');

test('full test suite isolates home and cloud-backed document paths', () => {
  const fixtureHome = path.win32.join('C:\\Users', 'username');
  const env = createIsolatedTestEnvironment({
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
    OneDrive: path.win32.join(fixtureHome, 'OneDrive'),
    ONEDRIVE: path.win32.join(fixtureHome, 'OneDrive'),
    OneDriveConsumer: path.win32.join(fixtureHome, 'OneDrive'),
    OneDriveCommercial: path.win32.join(fixtureHome, 'OneDrive - Work'),
  });
  const scratchRoot = getRepoScratchPath();

  for (const name of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'OneDrive',
    'ONEDRIVE',
    'OneDriveConsumer',
    'OneDriveCommercial',
  ]) {
    assert.equal(isPathWithin(scratchRoot, env[name]), true, `${name} must stay in scratch storage`);
  }

  assert.equal(fs.existsSync(path.join(env.USERPROFILE, 'Documents')), true);
  assert.equal(env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS, '1');
  assert.equal(env.CARGO_HOME, path.join(fixtureHome, '.cargo'));
  assert.equal(env.RUSTUP_HOME, path.join(fixtureHome, '.rustup'));
});

test('scratch containment rejects sibling directories with a shared prefix', () => {
  const scratchRoot = getRepoScratchPath();
  assert.equal(isPathWithin(scratchRoot, `${scratchRoot}-outside`), false);
});
