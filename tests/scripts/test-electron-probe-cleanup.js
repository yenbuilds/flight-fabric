'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProbeDirectory, finishProbeDirectory } = require('./electron-probe-cleanup');

test('successful probe cleanup removes its isolated directory', () => {
  const directory = createProbeDirectory('ff-electron-cleanup-test-');
  fs.writeFileSync(path.join(directory, 'result.json'), '{"ok":true}');
  finishProbeDirectory(directory, null);
  assert.equal(fs.existsSync(directory), false);
});

test('a Windows cleanup lock cannot replace the original probe failure or its diagnostics', () => {
  const directory = createProbeDirectory('ff-electron-cleanup-test-');
  const original = new Error('Backend did not reach readiness');
  const locked = Object.assign(new Error('Windows directory is still locked'), { code: 'EPERM' });
  const reports = [];
  try {
    assert.throws(() => finishProbeDirectory(directory, original, { stdout: 'last stage', readyElapsedMs: null }, {
      remove() { throw locked; }, report: record => reports.push(record),
    }), error => error === original);
    assert.equal(reports.length, 1);
    assert.match(reports[0].error, /Backend did not reach readiness/);
    assert.match(reports[0].cleanupError, /Windows directory is still locked/);
    assert.equal(reports[0].stdout, 'last stage');
    assert.equal(fs.existsSync(directory), true);
  } finally {
    finishProbeDirectory(directory, null);
  }
});

test('cleanup failure still fails an otherwise successful probe', () => {
  const directory = createProbeDirectory('ff-electron-cleanup-test-');
  const locked = new Error('Cleanup denied');
  try {
    assert.throws(() => finishProbeDirectory(directory, null, { result: '{"ok":true}' }, {
      remove() { throw locked; }, report() {},
    }), error => error === locked);
  } finally {
    finishProbeDirectory(directory, null);
  }
});

test('cleanup refuses the temporary root and any unrelated directory', () => {
  let removed = false;
  for (const directory of [fs.realpathSync(os.tmpdir()), path.resolve(__dirname)]) {
    assert.throws(() => finishProbeDirectory(directory, null, {}, {
      remove() { removed = true; }, report() {},
    }), /Refusing Electron probe cleanup outside its temporary root/);
  }
  assert.equal(removed, false);
  assert.throws(() => createProbeDirectory('../escape-'), /Invalid Electron probe prefix/);
});

test('an ordinary assertion failure is preserved after successful resource cleanup', () => {
  const directory = createProbeDirectory('ff-electron-cleanup-test-');
  const original = new Error('IPC sender assertion failed');
  const reports = [];
  assert.throws(() => finishProbeDirectory(directory, original, { stderr: 'renderer diagnostic' }, {
    report: record => reports.push(record),
  }), error => error === original);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(reports[0].cleanupError, null);
  assert.equal(reports[0].stderr, 'renderer diagnostic');
});
