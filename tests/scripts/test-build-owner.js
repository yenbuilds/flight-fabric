'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { withBuildOwnership } = require('../../scripts/build-owner');
const ROOT = path.resolve(__dirname, '../..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ff-build-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name, text) {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text); return file;
  }
  function copy(name) { write(name, fs.readFileSync(path.join(ROOT, name))); }
  for (const name of ['scripts/build-owner.js', 'electron/runtime-owner-lock.js', 'scripts/repo-scratch.js',
    'scripts/build-backend-runtime.js', 'electron/build-electron.js', 'frontend/build.js', 'tests/run-test-suite.js']) copy(name);
  write('scripts/rust-toolchain.js', 'exports.resolveCargo = () => "unexpected-cargo";');
  write('scripts/simconnect-sdk.js', 'exports.getSdkDllPath = () => "unused.dll";');
  write('scripts/release-profile-loader.js', 'exports.resolveProfile = () => { require("fs").writeFileSync("unexpected-mutation", "profile entered"); throw new Error("Unprotected build started"); };');
  write('electron/release-output-failure-guard.js', 'exports.installElectronOutputFailureGuard = () => { throw new Error("Unexpected output cleanup"); };');
  write('scripts/whats-new-highlights.js', 'exports.buildWhatsNew = () => ({});');
  write('scripts/validate-aircraft-definitions.js', 'require("fs").writeFileSync("unexpected-mutation", "validator entered");');
  write('scripts/build-toolbar-presets.mjs', 'import fs from "node:fs"; fs.writeFileSync("unexpected-mutation", "frontend preflight entered");');
  write('frontend/package.json', '{"type":"module"}');
  const sentinel = write('dist/backend/aircraft/aircraft-definition-catalogue.js', 'Existing compiled catalogue');
  write('frontend-dist/index.html', 'Existing frontend');
  write('dist/electron/previous-installer.exe', 'Existing verified installer');
  return { root, write, sentinel };
}

function run(root, args, env = process.env) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true,
    timeout: 15000, env });
}

for (const entry of ['scripts/build-backend-runtime.js', 'frontend/build.js', 'electron/build-electron.js', 'tests/run-test-suite.js']) {
  test(`${entry} refuses another build before changing dependencies or output`, async t => {
    const { root, sentinel } = fixture(t);
    const independentEnv = { ...process.env, FF_REPO_SCRATCH_ROOT: path.join(root, 'alternate-scratch') };
    delete independentEnv.FF_CHECKOUT_BUILD_OWNER;
    await withBuildOwnership({ root, label: 'fixture installer' }, async () => {
      // This owner is blocked in spawnSync, just like the actual build while
      // compiling. Exclusion must not depend on its JS event loop responding.
      const result = run(root, [path.join(root, entry)], independentEnv);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Another FlightFabric build is using this checkout/);
      assert.match(result.stderr, /Wait for it to finish/);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Existing compiled catalogue');
      assert.equal(fs.readFileSync(path.join(root, 'frontend-dist/index.html'), 'utf8'), 'Existing frontend');
      assert.equal(fs.readFileSync(path.join(root, 'dist/electron/previous-installer.exe'), 'utf8'), 'Existing verified installer');
      assert.equal(fs.existsSync(path.join(root, 'unexpected-mutation')), false, 'even preflight mutations are behind admission');
    });
  });
}

test('sequential nested build subprocesses inherit ownership while the parent is synchronously waiting', async t => {
  const { root, write } = fixture(t);
  const worker = write('nested.cjs', `const { withBuildOwnership } = require('./scripts/build-owner');
    withBuildOwnership({root:__dirname,label:'nested compiler'},()=>require('fs').appendFileSync('nested-output','ok\\n')).catch(e=>{console.error(e);process.exitCode=1;});`);
  await withBuildOwnership({ root, label: 'fixture installer' }, async () => {
    for (let i = 0; i < 2; i++) {
      const result = run(root, [worker]);
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    }
  });
  assert.equal(fs.readFileSync(path.join(root, 'nested-output'), 'utf8'), 'ok\nok\n');
  assert.equal(fs.existsSync(path.join(root, '.tmp/build-owner.json')), false);
});

test('same-process overlap is refused; thrown failures release ownership for retry', async t => {
  const { root } = fixture(t);
  const previous = process.env.FF_CHECKOUT_BUILD_OWNER;
  await assert.rejects(withBuildOwnership({ root, label: 'first' }, async () => {
    await assert.rejects(withBuildOwnership({ root, label: 'overlap' }, () => assert.fail('overlapping callback ran')), /Another FlightFabric build/);
    throw new Error('fixture compiler failed');
  }), /fixture compiler failed/);
  assert.equal(process.env.FF_CHECKOUT_BUILD_OWNER, previous);
  let retried = false;
  await withBuildOwnership({ root, label: 'retry' }, () => { retried = true; });
  assert.equal(retried, true);
});

test('different checkouts can build independently and cannot inherit each other’s ownership', async t => {
  const { root } = fixture(t), other = fixture(t);
  await withBuildOwnership({ root, label: 'first checkout' }, async () => {
    await withBuildOwnership({ root: other.root, label: 'second checkout' }, () => {
      assert.equal(fs.existsSync(path.join(root, '.tmp/build-owner.json')), true);
      assert.equal(fs.existsSync(path.join(other.root, '.tmp/build-owner.json')), true);
    });
  });
});

test('killed owner leaves no permanent lock; stale inherited state cannot join a replacement owner', async t => {
  const { root, write } = fixture(t);
  const worker = write('hold.cjs', `const { withBuildOwnership } = require('./scripts/build-owner');
    withBuildOwnership({root:__dirname,label:'killed owner'},()=>{
      process.stdout.write(process.env.FF_CHECKOUT_BUILD_OWNER+'\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
    }).catch(e=>{console.error(e);process.exitCode=1;});`);
  const child = spawn(process.execPath, [worker], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; });
  const inherited = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Owner did not start')), 10000);
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); resolve(text.trim()); } });
    child.once('exit', () => { clearTimeout(timer); if (!text.includes('\n')) reject(new Error('Owner exited before acquiring the lock')); });
  });
  child.kill('SIGKILL'); await exit;
  const contender = write('contender.cjs', `const { withBuildOwnership } = require('./scripts/build-owner');
    withBuildOwnership({root:__dirname,label:'stale child'},()=>require('fs').writeFileSync('unexpected-mutation','stale child')).catch(e=>{console.error(e.message);process.exitCode=1;});`);
  await withBuildOwnership({ root, label: 'replacement' }, () => {
    const result = run(root, [contender], { ...process.env, FF_CHECKOUT_BUILD_OWNER: inherited });
    assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Another FlightFabric build/);
    assert.equal(fs.existsSync(path.join(root, 'unexpected-mutation')), false);
  });
});
