#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  installElectronOutputFailureGuard,
  invalidateElectronOutputArtifacts,
} = require('../../electron/release-output-failure-guard');

const ROOT = path.resolve(__dirname, '..', '..');

function makeOutputFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ff-electron-output-guard-'));
}

test('an armed failed-build exit removes every clickable or publishable artifact', () => {
  const outputDir = makeOutputFixture();
  try {
    fs.mkdirSync(path.join(outputDir, 'win-unpacked'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'win-unpacked', 'Flight Fabric.exe'), 'partial');
    fs.writeFileSync(path.join(outputDir, 'Flight Fabric Setup 0.3.0.exe'), 'partial');
    fs.writeFileSync(path.join(outputDir, 'Flight Fabric 0.3.0.exe'), 'partial');
    fs.writeFileSync(path.join(outputDir, 'latest.yml'), 'partial');
    fs.writeFileSync(path.join(outputDir, 'SHA256SUMS.txt'), 'partial');
    fs.writeFileSync(path.join(outputDir, 'failure.log'), 'diagnostic');

    const processRef = new EventEmitter();
    installElectronOutputFailureGuard(outputDir, { processRef });
    processRef.emit('exit', 1);

    assert.deepEqual(fs.readdirSync(outputDir), ['failure.log']);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('a verified build disarms cleanup and preserves canonical artifacts', () => {
  const outputDir = makeOutputFixture();
  try {
    const executable = path.join(outputDir, 'Flight Fabric 0.3.0.exe');
    fs.writeFileSync(executable, 'verified');
    const processRef = new EventEmitter();
    const guard = installElectronOutputFailureGuard(outputDir, { processRef });

    guard.disarm();
    processRef.emit('exit', 0);

    assert.equal(fs.readFileSync(executable, 'utf8'), 'verified');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('invalidation refuses a redirected unpacked artifact', () => {
  const outputDir = makeOutputFixture();
  try {
    fs.writeFileSync(path.join(outputDir, 'win-unpacked'), 'not a directory');
    assert.throws(
      () => invalidateElectronOutputArtifacts(outputDir),
      /Electron unpacked output directory is not a safe regular directory/,
    );
    assert.equal(fs.readFileSync(path.join(outputDir, 'win-unpacked'), 'utf8'), 'not a directory');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('the build arms cleanup before canonical output is touched and disarms only after verification', () => {
  const buildSource = fs.readFileSync(path.join(ROOT, 'electron', 'build-electron.js'), 'utf8');
  const loadProfileIndex = buildSource.lastIndexOf('loadReleaseProfile();');
  const armIndex = buildSource.lastIndexOf('installElectronOutputFailureGuard(');
  const cleanIndex = buildSource.lastIndexOf('ensureCleanElectronOutput();');
  const finalVerificationIndex = buildSource.lastIndexOf('verifyVirginInstallerPayload();');
  const disarmIndex = buildSource.lastIndexOf('outputFailureGuard.disarm();');

  assert.ok(loadProfileIndex >= 0 && loadProfileIndex < armIndex);
  assert.ok(armIndex < cleanIndex);
  assert.ok(cleanIndex < finalVerificationIndex);
  assert.ok(finalVerificationIndex < disarmIndex);
});
