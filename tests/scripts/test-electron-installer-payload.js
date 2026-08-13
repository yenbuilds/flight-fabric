#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_PACKAGED_BACKEND_STARTUP_FILES,
} = require('./electron-packaged-startup-files');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist', 'electron');
const WIN_UNPACKED = path.join(DIST, 'win-unpacked');
const { getRepoScratchPath, resetRepoScratchDirectory } = require('../../scripts/repo-scratch');
const EXTRACT_ROOT = getRepoScratchPath('electron-installer-payload');
const REQUIRED_PAYLOAD_FILES = [
  'Flight Fabric.exe',
  path.join('resources', 'app.asar'),
  ...REQUIRED_PACKAGED_BACKEND_STARTUP_FILES.map((relativePath) => (
    path.join('resources', 'backend', ...relativePath.split('/'))
  )),
  path.join('resources', 'frontend', 'index.html'),
  path.join('resources', 'shared', 'app-settings-shared.js'),
  path.join('resources', 'shared', 'flight-phases.js'),
  path.join('resources', 'shared', 'rust-sidecar-artifact.js'),
  path.join('resources', 'shared', 'violation-rules.js'),
];

function normalizedPathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertSafeRegularDirectory(dirPath, label) {
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory: ${dirPath}`);
  }
  if (normalizedPathKey(dirPath) !== normalizedPathKey(fs.realpathSync(dirPath))) {
    throw new Error(`${label} is a link, junction, or reparse point: ${dirPath}`);
  }
}

function assertSafeRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  if (normalizedPathKey(filePath) !== normalizedPathKey(fs.realpathSync(filePath))) {
    throw new Error(`${label} is a link or reparse-point entry: ${filePath}`);
  }
  return stat;
}

function findInstaller() {
  assertSafeRegularDirectory(DIST, 'Electron output directory');
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const installerPath = path.join(DIST, `Flight Fabric Setup ${version}.exe`);
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Expected NSIS installer does not exist: ${installerPath}`);
  }
  assertSafeRegularFile(installerPath, 'NSIS installer');
  return installerPath;
}

async function extractInstallerPayload(installerPath) {
  const { getPath7za } = require('../../electron/node_modules/app-builder-lib/out/toolsets/7zip');
  const sevenZipPath = await getPath7za();

  resetRepoScratchDirectory('electron-installer-payload');
  const result = childProcess.spawnSync(sevenZipPath, [
    'x',
    '-bd',
    '-y',
    `-o${EXTRACT_ROOT}`,
    installerPath,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Could not extract ${path.basename(installerPath)} (exit ${result.status})\n`
      + `${result.stdout || ''}\n${result.stderr || ''}`
    );
  }
}

function collectSafeFileInventory(rootDir, label) {
  assertSafeRegularDirectory(rootDir, label);
  const inventory = new Map();
  const pending = [rootDir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    const realCurrentDir = fs.realpathSync(currentDir);
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const stat = fs.lstatSync(entryPath);
      const expectedRealPath = path.resolve(realCurrentDir, entry.name);
      const actualRealPath = fs.realpathSync(entryPath);
      if (
        stat.isSymbolicLink()
        || normalizedPathKey(expectedRealPath) !== normalizedPathKey(actualRealPath)
      ) {
        throw new Error(`${label} contains a link, junction, or reparse point: ${entryPath}`);
      }
      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (stat.isFile()) {
        inventory.set(path.relative(rootDir, entryPath).replace(/\\/g, '/'), stat.size);
      } else {
        throw new Error(`${label} contains a non-regular entry: ${entryPath}`);
      }
    }
  }
  return inventory;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyRequiredPayload() {
  const missing = REQUIRED_PAYLOAD_FILES.filter((relativePath) => {
    const extractedPath = path.join(EXTRACT_ROOT, relativePath);
    const unpackedPath = path.join(WIN_UNPACKED, relativePath);
    return !fs.existsSync(extractedPath) || !fs.existsSync(unpackedPath);
  });
  if (missing.length > 0) {
    throw new Error(`Virgin installer payload is missing: ${missing.join(', ')}`);
  }

  const unpackedInventory = collectSafeFileInventory(WIN_UNPACKED, 'win-unpacked');
  const extractedInventory = collectSafeFileInventory(EXTRACT_ROOT, 'Extracted installer payload');
  if (
    unpackedInventory.size !== extractedInventory.size
    || [...unpackedInventory].some(([fileName, size]) => extractedInventory.get(fileName) !== size)
  ) {
    throw new Error('Extracted installer payload does not match the clean win-unpacked file inventory');
  }

  for (const relativePath of REQUIRED_PAYLOAD_FILES) {
    const extractedPath = path.join(EXTRACT_ROOT, relativePath);
    const unpackedPath = path.join(WIN_UNPACKED, relativePath);
    assertSafeRegularFile(extractedPath, 'Required extracted payload file');
    assertSafeRegularFile(unpackedPath, 'Required win-unpacked file');
    if (await sha256File(extractedPath) !== await sha256File(unpackedPath)) {
      throw new Error(`Installer payload differs from win-unpacked: ${relativePath}`);
    }
  }
}

function launchExtractedBackend() {
  const executablePath = path.join(EXTRACT_ROOT, 'Flight Fabric.exe');
  const probePath = path.join(ROOT, 'tests', 'scripts', 'test-electron-packaged-backend-launch.js');
  const result = childProcess.spawnSync(process.execPath, [
    probePath,
    '--exe',
    executablePath,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Extracted virgin payload did not start (exit ${result.status})\n`
      + `${result.stdout || ''}\n${result.stderr || ''}`
    );
  }
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Virgin NSIS installer payload probe skipped (Windows only)');
    return;
  }

  const installerPath = findInstaller();
  try {
    await extractInstallerPayload(installerPath);
    await verifyRequiredPayload();
    launchExtractedBackend();
    console.log(`Virgin installer payload probe passed: ${path.basename(installerPath)}`);
  } finally {
    if (fs.existsSync(EXTRACT_ROOT)) {
      const resetPath = resetRepoScratchDirectory('electron-installer-payload');
      fs.rmdirSync(resetPath);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
