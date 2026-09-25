'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
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

test('Git fixtures cannot inherit the committing worktree repository or index', (t) => {
  const root = fs.mkdtempSync(path.join(getRepoScratchPath(), 'git-environment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inherited = {
    GIT_DIR: path.join(root, 'wrong-repository'),
    GIT_COMMON_DIR: path.join(root, 'wrong-common-directory'),
    GIT_WORK_TREE: path.join(root, 'wrong-worktree'),
    GIT_INDEX_FILE: path.join(root, 'wrong-index'),
    GIT_OBJECT_DIRECTORY: path.join(root, 'wrong-objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(root, 'wrong-alternate-objects'),
    GIT_PREFIX: 'unrelated/',
    GIT_CONFIG_PARAMETERS: "'core.bare=true'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
  };
  const env = createIsolatedTestEnvironment({ ...process.env, ...inherited });
  for (const name of Object.keys(inherited)) assert.equal(env[name], undefined, name);
  const fixture = path.join(root, 'fixture');
  execFileSync('git', ['init', '-q', fixture], { env, windowsHide: true });
  const actual = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: fixture, env, windowsHide: true, encoding: 'utf8',
  }).trim();
  assert.equal(fs.realpathSync(actual), fs.realpathSync(fixture));
  for (const name of ['wrong-repository', 'wrong-common-directory', 'wrong-index', 'wrong-objects']) {
    assert.equal(fs.existsSync(path.join(root, name)), false, name);
  }
});
