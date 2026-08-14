#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WIN_UNPACKED_EXECUTABLE_NAME = 'Flight Fabric.exe';
const PUBLISHABLE_ARTIFACT_SUFFIXES = [
  '.appimage',
  '.appx',
  '.apk',
  '.bz2',
  '.deb',
  '.dmg',
  '.exe',
  '.flatpak',
  '.freebsd',
  '.msi',
  '.msix',
  '.nupkg',
  '.p5p',
  '.pacman',
  '.pkg',
  '.rar',
  '.rpm',
  '.snap',
  '.tar',
  '.tar.bz2',
  '.tar.gz',
  '.tar.lz',
  '.tar.xz',
  '.tar.zst',
  '.tgz',
  '.xz',
  '.zip',
  '.zst',
  '.7z',
];

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(date) {
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function normalizedPathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertSafeDirectory(dirPath, label) {
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

function getFileInfo(filePath) {
  const stat = assertSafeRegularFile(filePath, 'Release artifact');
  return {
    filePath,
    name: path.basename(filePath),
    sizeBytes: stat.size,
    mtime: stat.mtime,
  };
}

function findTopLevelExeArtifacts(distPath) {
  return findTopLevelPublishableArtifacts(distPath)
    .filter((artifact) => artifact.name.toLowerCase().endsWith('.exe'));
}

function isPublishableArtifactName(name) {
  const lowerName = String(name || '').toLowerCase();
  return PUBLISHABLE_ARTIFACT_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
}

function findTopLevelPublishableArtifacts(distPath) {
  if (!fs.existsSync(distPath)) return [];
  return fs.readdirSync(distPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isPublishableArtifactName(entry.name))
    .map((entry) => path.join(distPath, entry.name))
    .map(getFileInfo);
}

function findWinUnpackedExecutable(distPath) {
  const unpackedPath = path.join(distPath, 'win-unpacked');
  const executablePath = path.join(
    unpackedPath,
    WIN_UNPACKED_EXECUTABLE_NAME
  );
  if (!fs.existsSync(unpackedPath) || !fs.existsSync(executablePath)) return null;
  assertSafeDirectory(unpackedPath, 'win-unpacked');
  assertSafeRegularFile(executablePath, 'Unpacked application executable');
  return executablePath;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    try {
      assertSafeRegularFile(filePath, 'Checksum input');
    } catch (error) {
      reject(error);
      return;
    }
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function writeChecksums(artifacts, checksumPath) {
  const lines = [];
  const checksumName = (artifact) => {
    const name = typeof artifact.publishedName === 'string'
      ? artifact.publishedName
      : artifact.name;
    if (
      typeof name !== 'string'
      || name !== path.basename(name)
      || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*\.exe$/i.test(name)
    ) {
      throw new Error(`Unsafe checksum artifact name: ${String(name)}`);
    }
    return name;
  };
  for (const artifact of [...artifacts].sort(
    (a, b) => checksumName(a).localeCompare(checksumName(b)),
  )) {
    lines.push(`${await sha256File(artifact.filePath)}  ${checksumName(artifact)}`);
  }
  if (fs.existsSync(checksumPath)) {
    assertSafeRegularFile(checksumPath, 'Existing checksum output');
    fs.unlinkSync(checksumPath);
  }
  const checksumFd = fs.openSync(checksumPath, 'wx');
  try {
    fs.writeFileSync(checksumFd, `${lines.join('\n')}\n`, 'utf8');
  } finally {
    fs.closeSync(checksumFd);
  }
  return lines;
}

async function verifyChecksumFile(checksumPath, artifacts) {
  assertSafeRegularFile(checksumPath, 'Checksum output');
  const lines = fs.readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length !== artifacts.length) {
    throw new Error(
      `Checksum file has ${lines.length} entries; expected ${artifacts.length}`,
    );
  }

  const expected = new Map();
  for (const artifact of artifacts) {
    const name = typeof artifact.publishedName === 'string'
      ? artifact.publishedName
      : artifact.name;
    expected.set(name, await sha256File(artifact.filePath));
  }
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+\.exe)$/i.exec(line);
    if (!match) throw new Error(`Malformed checksum entry: ${line}`);
    const [, hash, name] = match;
    if (!expected.has(name)) throw new Error(`Unexpected checksum artifact: ${name}`);
    if (expected.get(name) !== hash.toLowerCase()) {
      throw new Error(`Checksum mismatch after writing ${name}`);
    }
    expected.delete(name);
  }
  if (expected.size > 0) {
    throw new Error(`Checksum file is missing: ${[...expected.keys()].join(', ')}`);
  }
  return lines;
}

function parseDistArgument(argv) {
  let distValue = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--dist') {
      throw new Error(`Unknown release-summary argument: ${argument}`);
    }
    if (distValue !== null) {
      throw new Error('Duplicate --dist argument');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--dist requires a directory');
    }
    distValue = value;
    index += 1;
  }
  return distValue === null
    ? path.join(ROOT, 'dist', 'electron')
    : path.resolve(ROOT, distValue);
}

async function main(argv = process.argv.slice(2)) {
  console.log('=== Electron Release Summary ===');

  const distPath = parseDistArgument(argv);
  const checksumPath = path.join(distPath, 'SHA256SUMS.txt');
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ).version;
  const expectedNames = [
    `Flight Fabric Setup ${version}.exe`,
    `Flight Fabric ${version}.exe`,
  ];
  const publishedInstallerName = `Flight.Fabric.Setup.${version}.exe`;

  if (!fs.existsSync(distPath)) {
    throw new Error(`Output directory not found: ${distPath}`);
  }
  try {
    assertSafeDirectory(distPath, 'Output path');
  } catch (error) {
    throw new Error(`Output path is not a safe directory: ${distPath} (${error.message})`);
  }

  const expectedBlockmapName = `${expectedNames[0]}.blockmap`;
  const allowedTopLevelNames = new Set([
    ...expectedNames,
    expectedBlockmapName,
    'SHA256SUMS.txt',
    'win-unpacked',
  ]);
  const topLevelEntries = fs.readdirSync(distPath, { withFileTypes: true });
  const unexpectedTopLevelEntries = topLevelEntries
    .map((entry) => entry.name)
    .filter((name) => !allowedTopLevelNames.has(name))
    .sort();
  if (unexpectedTopLevelEntries.length > 0) {
    throw new Error(
      `Unexpected top-level release output: ${unexpectedTopLevelEntries.join(', ')}`
    );
  }
  const blockmapPath = path.join(distPath, expectedBlockmapName);
  if (!fs.existsSync(blockmapPath)) {
    throw new Error(`Required installer blockmap is missing: ${expectedBlockmapName}`);
  }
  if (assertSafeRegularFile(blockmapPath, 'Installer blockmap').size <= 0) {
    throw new Error(`Required installer blockmap is empty: ${expectedBlockmapName}`);
  }

  const artifacts = findTopLevelPublishableArtifacts(distPath);
  const artifactNames = artifacts.map((artifact) => artifact.name).sort();
  const sortedExpectedNames = [...expectedNames].sort();
  if (
    artifactNames.length !== sortedExpectedNames.length
    || artifactNames.some((name, index) => name !== sortedExpectedNames[index])
  ) {
    throw new Error(
      `Expected exactly ${expectedNames.join(' and ')} as top-level publishable artifacts; found `
      + `${artifactNames.length > 0 ? artifactNames.join(', ') : 'no publishable artifacts'}`,
    );
  }
  for (const artifact of artifacts) {
    if (artifact.sizeBytes <= 0) {
      throw new Error(`Release artifact is empty: ${artifact.name}`);
    }
  }

  const installer = artifacts.find((artifact) => artifact.name === expectedNames[0]);
  const portable = artifacts.find((artifact) => artifact.name === expectedNames[1]);
  if (!installer || !portable) {
    throw new Error('Could not classify the version-matching installer and portable EXE');
  }

  const winUnpackedExe = findWinUnpackedExecutable(distPath);
  if (!winUnpackedExe) {
    throw new Error(
      `Required unpacked executable is missing: win-unpacked/${WIN_UNPACKED_EXECUTABLE_NAME}`
    );
  }
  const unpackedInfo = getFileInfo(winUnpackedExe);
  if (unpackedInfo.sizeBytes <= 0) {
    throw new Error(
      `Required unpacked executable is empty: win-unpacked/${WIN_UNPACKED_EXECUTABLE_NAME}`
    );
  }

  // The portable executable is retained as a local build/test artifact. Only
  // the installer is published, so the upload checksum file must not list it.
  const publishedInstaller = {
    ...installer,
    publishedName: publishedInstallerName,
  };
  const checksumLines = await writeChecksums([publishedInstaller], checksumPath);
  await verifyChecksumFile(checksumPath, [publishedInstaller]);

  console.log(`Artifacts directory: ${distPath}`);
  console.log('');
  console.log('Verified build artifacts:');
  for (const artifact of artifacts) {
    console.log(`- ${artifact.name} | ${formatMb(artifact.sizeBytes)} | ${formatTime(artifact.mtime)}`);
  }

  console.log(`win-unpacked exe: ${formatMb(unpackedInfo.sizeBytes)} | ${formatTime(unpackedInfo.mtime)}`);

  console.log('');
  console.log(`Checksums verified: ${checksumPath}`);
  for (const line of checksumLines) console.log(`- ${line}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Electron release summary failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  findTopLevelExeArtifacts,
  findTopLevelPublishableArtifacts,
  findWinUnpackedExecutable,
  isPublishableArtifactName,
  parseDistArgument,
  sha256File,
  verifyChecksumFile,
  writeChecksums,
};
