#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist', 'electron');
const WIN_UNPACKED = path.join(DIST, 'win-unpacked');
const PACKAGED_BACKEND = path.join(WIN_UNPACKED, 'resources', 'backend');
const RUST_SIDECAR_BINARY = path.join(
  PACKAGED_BACKEND,
  'telemetry-provider',
  'ff-rust-simconnect-sidecar.exe'
);
const PACKAGED_BACKEND_PACKAGE_JSON = path.join(PACKAGED_BACKEND, 'package.json');
const PACKAGED_BACKEND_NODE_MODULES = path.join(PACKAGED_BACKEND, 'node_modules');
const BACKEND_PACKAGE_LOCK = path.join(ROOT, 'backend', 'package-lock.json');
const PACKAGED_STANDARD_CABIN_AUDIO = path.join(
  WIN_UNPACKED,
  'resources',
  'frontend',
  'audio',
  'cabin',
  'standard'
);
const REQUIRED_STANDARD_CABIN_AUDIO_FILES = [
  'approach.wav',
  'climb.wav',
  'cruise.wav',
  'descent-start.wav',
  'pushback-start.wav',
  'shortly-after-landing-rollout.wav',
  'transition-to-above-10k-feet.wav',
  'transition-to-below-10k-feet.wav',
];
const FORBIDDEN_BACKEND_PATHS = [
  ['telemetry-provider', 'mock-provider.js'],
  ['telemetry-provider', 'rust-simconnect-sidecar'],
];
const INTENTIONALLY_OMITTED_RELATIVE_IMPORTS = new Set([
  // Packaged startup rejects --mock before provider creation. The source keeps
  // this lazy development-only branch, while the user profile omits its module.
  'telemetry-provider/index.js -> ./mock-provider.js',
]);
const FORBIDDEN_PACKAGED_DEPENDENCY_DIRECTORIES = new Set([
  '.github',
  '.husky',
  '.nyc_output',
  '.vscode',
  '__tests__',
  'benchmark',
  'benchmarks',
  'coverage',
  'doc',
  'docs',
  'example',
  'examples',
  'sample',
  'samples',
  'spec',
  'specs',
  'test',
  'tests',
]);
const FORBIDDEN_PACKAGED_DEPENDENCY_FILES = new Set([
  '.editorconfig',
  '.eslintignore',
  '.gitattributes',
  '.gitignore',
  '.npmignore',
  '.npmrc',
  '.prettierignore',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

function isPackagedRuntimeLegalNotice(name) {
  return /^(?:copyright|copying|legal|licen[cs]e|notice|third[-_ ]party)(?:$|[._ -])/i.test(name);
}

function isForbiddenPackagedDependencyFile(name) {
  const lowerName = String(name || '').toLowerCase();
  if (FORBIDDEN_PACKAGED_DEPENDENCY_FILES.has(lowerName)) return true;
  const isSourceOrTestArtifact = lowerName.endsWith('.d.ts')
    || lowerName.endsWith('.js.map')
    || lowerName.endsWith('.log')
    || lowerName === '_template.json'
    || lowerName.endsWith('.ts')
    || lowerName.endsWith('.tsx')
    || lowerName.endsWith('.mts')
    || lowerName.endsWith('.cts')
    || lowerName.endsWith('.tsbuildinfo')
    || lowerName.startsWith('.eslintrc')
    || lowerName.startsWith('.prettierrc')
    || lowerName.startsWith('.nycrc')
    || lowerName.startsWith('tsconfig')
    || lowerName.startsWith('jsconfig')
    || /(?:^|\.)(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(lowerName)
    || /^(?:test|spec)-/i.test(lowerName);
  if (isSourceOrTestArtifact) return true;
  if (isPackagedRuntimeLegalNotice(lowerName)) return false;
  return lowerName.endsWith('.md')
    || lowerName.endsWith('.markdown')
    || lowerName.endsWith('.mdx');
}

let failed = 0;

function ok(message) {
  console.log(`✓ ${message}`);
}

function fail(message) {
  console.log(`✗ ${message}`);
  failed += 1;
}

function exists(filePath, label) {
  if (fs.existsSync(filePath)) {
    ok(label);
    return true;
  }
  fail(label);
  return false;
}

function absent(filePath, label) {
  if (!fs.existsSync(filePath)) {
    ok(label);
    return true;
  }
  fail(label);
  return false;
}

function findFileBy(patternFn) {
  if (!fs.existsSync(DIST)) return null;
  const files = fs.readdirSync(DIST);
  return files.find(patternFn) || null;
}

function findWinUnpackedExe() {
  if (!fs.existsSync(WIN_UNPACKED)) return null;
  return fs.readdirSync(WIN_UNPACKED).find((name) => (
    name.toLowerCase().endsWith('.exe') && !/uninstall/i.test(name)
  )) || null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    fail(`${path.relative(ROOT, filePath)} is valid JSON (${err.message})`);
    return null;
  }
}

function packagePathParts(packageName) {
  return String(packageName || '').split('/').filter(Boolean);
}

function packagedModulePackageJson(packageName) {
  return path.join(PACKAGED_BACKEND_NODE_MODULES, ...packagePathParts(packageName), 'package.json');
}

function collectPackagedPackageRoots(modulesRoot, relativeModulesPrefix = '') {
  const packages = new Set();
  const invalidEntries = [];

  const inspectPackageDirectory = (packageDir, relativePackagePath) => {
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      invalidEntries.push(`${relativePackagePath} (missing package.json)`);
      return;
    }
    packages.add(relativePackagePath.replace(/\\/g, '/'));
    const nestedModules = path.join(packageDir, 'node_modules');
    if (fs.existsSync(nestedModules)) {
      inspectModulesDirectory(
        nestedModules,
        `${relativePackagePath.replace(/\\/g, '/')}/node_modules`,
      );
    }
  };

  const inspectModulesDirectory = (currentModulesRoot, currentPrefix) => {
    for (const entry of fs.readdirSync(currentModulesRoot, { withFileTypes: true })) {
      const entryPath = path.join(currentModulesRoot, entry.name);
      if (!entry.isDirectory()) {
        invalidEntries.push(
          `${currentPrefix ? `${currentPrefix}/` : ''}${entry.name} (non-directory entry)`,
        );
        continue;
      }
      if (entry.name.startsWith('@')) {
        for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
          const scopedRelative = (
            `${currentPrefix ? `${currentPrefix}/` : ''}${entry.name}/${scopedEntry.name}`
          );
          if (!scopedEntry.isDirectory()) {
            invalidEntries.push(`${scopedRelative} (non-directory scoped package)`);
            continue;
          }
          inspectPackageDirectory(path.join(entryPath, scopedEntry.name), scopedRelative);
        }
        continue;
      }
      inspectPackageDirectory(
        entryPath,
        `${currentPrefix ? `${currentPrefix}/` : ''}${entry.name}`,
      );
    }
  };

  inspectModulesDirectory(modulesRoot, relativeModulesPrefix);
  return { invalidEntries, packages };
}

function validatePackagedBackendDependencyLock() {
  const lockfile = readJson(BACKEND_PACKAGE_LOCK);
  if (!lockfile) return;
  if (![2, 3].includes(lockfile.lockfileVersion) || !lockfile.packages) {
    fail('backend package-lock has a supported production package inventory');
    return;
  }

  let validated = 0;
  const expectedInstalledPackages = new Set();
  for (const [lockPath, lockedPackage] of Object.entries(lockfile.packages).sort()) {
    if (
      !lockPath.startsWith('node_modules/')
      || !lockedPackage
      || lockedPackage.dev === true
    ) {
      continue;
    }

    if (lockedPackage.link === true || typeof lockedPackage.version !== 'string') {
      fail(`backend package-lock dependency has an exact version: ${lockPath}`);
      continue;
    }
    const normalizedLockPath = lockPath.replace(/\\/g, '/');
    if (path.posix.normalize(normalizedLockPath) !== normalizedLockPath) {
      fail(`backend package-lock dependency path is safe: ${lockPath}`);
      continue;
    }
    const relativePackagePath = normalizedLockPath.slice('node_modules/'.length);
    const packageJsonPath = path.join(
      PACKAGED_BACKEND_NODE_MODULES,
      ...relativePackagePath.split('/'),
      'package.json'
    );
    if (!fs.existsSync(packageJsonPath)) {
      if (lockedPackage.optional === true || lockedPackage.devOptional === true) {
        ok(`locked optional backend dependency absent on this platform: ${relativePackagePath}`);
      } else {
        fail(
          `locked backend dependency bundled: ${relativePackagePath}@${lockedPackage.version}`
        );
      }
      continue;
    }
    expectedInstalledPackages.add(relativePackagePath);

    const packagedPackage = readJson(packageJsonPath);
    if (!packagedPackage) continue;
    if (packagedPackage.version !== lockedPackage.version) {
      fail(
        `locked backend dependency version: ${relativePackagePath} `
        + `(packaged ${packagedPackage.version || '(missing)'}, locked ${lockedPackage.version})`
      );
      continue;
    }
    validated += 1;
  }

  if (validated > 0) {
    ok(`${validated} packaged backend dependencies match exact locked versions`);
  } else {
    fail('packaged backend dependency lock validation found production packages');
  }

  const actualInventory = collectPackagedPackageRoots(PACKAGED_BACKEND_NODE_MODULES);
  for (const invalidEntry of actualInventory.invalidEntries) {
    fail(`unexpected packaged backend dependency entry: ${invalidEntry}`);
  }
  for (const packagePath of [...actualInventory.packages].sort()) {
    if (!expectedInstalledPackages.has(packagePath)) {
      fail(`unexpected packaged backend dependency: ${packagePath}`);
    }
  }
  for (const packagePath of [...expectedInstalledPackages].sort()) {
    if (!actualInventory.packages.has(packagePath)) {
      fail(`missing packaged backend dependency: ${packagePath}`);
    }
  }
  if (
    actualInventory.invalidEntries.length === 0
    && actualInventory.packages.size === expectedInstalledPackages.size
    && [...actualInventory.packages].every((packagePath) => (
      expectedInstalledPackages.has(packagePath)
    ))
  ) {
    ok('packaged backend dependency roots exactly match the production lock inventory');
  }
}

function validatePackagedBackendDependencies() {
  if (!exists(PACKAGED_BACKEND_PACKAGE_JSON, 'backend runtime package.json bundled')) return;
  if (!exists(PACKAGED_BACKEND_NODE_MODULES, 'backend runtime node_modules bundled')) return;

  const packageJson = readJson(PACKAGED_BACKEND_PACKAGE_JSON);
  if (!packageJson) return;

  if (!Object.prototype.hasOwnProperty.call(packageJson, 'main')) {
    ok('packaged backend metadata does not advertise a missing repo wrapper entry point');
  } else {
    fail(`packaged backend metadata omits main (found ${JSON.stringify(packageJson.main)})`);
  }
  if (!Object.prototype.hasOwnProperty.call(packageJson, 'scripts')) {
    ok('packaged backend metadata does not advertise unavailable npm wrapper commands');
  } else {
    fail('packaged backend metadata omits repo-only npm scripts');
  }

  const requiredDependencies = Object.keys(packageJson.dependencies || {}).sort();
  if (requiredDependencies.length === 0) {
    fail('backend runtime package.json declares required dependencies');
  } else {
    ok(`backend runtime declares required dependencies: ${requiredDependencies.join(', ')}`);
  }

  for (const dependencyName of requiredDependencies) {
    exists(
      packagedModulePackageJson(dependencyName),
      `backend runtime dependency bundled: ${dependencyName}`
    );
  }

  for (const optionalName of Object.keys(packageJson.optionalDependencies || {}).sort()) {
    const optionalPath = packagedModulePackageJson(optionalName);
    if (fs.existsSync(optionalPath)) {
      ok(`backend optional dependency bundled when installed: ${optionalName}`);
    } else {
      ok(`backend optional dependency absent by install choice: ${optionalName}`);
    }
  }

  validatePackagedBackendDependencyLock();

  const unwanted = [];
  const pending = [PACKAGED_BACKEND_NODE_MODULES];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (FORBIDDEN_PACKAGED_DEPENDENCY_DIRECTORIES.has(lowerName)) {
          unwanted.push(path.relative(PACKAGED_BACKEND_NODE_MODULES, entryPath));
        } else {
          pending.push(entryPath);
        }
        continue;
      }
      if (
        entry.isFile()
        && isForbiddenPackagedDependencyFile(lowerName)
      ) {
        unwanted.push(path.relative(PACKAGED_BACKEND_NODE_MODULES, entryPath));
      }
    }
  }

  if (unwanted.length === 0) {
    ok('backend runtime dependencies omit tests, docs, repository metadata, TypeScript sources, and source maps');
  } else {
    for (const relativePath of unwanted.slice(0, 20)) {
      fail(`backend runtime dependency development artifact absent: ${relativePath}`);
    }
    if (unwanted.length > 20) {
      fail(`backend runtime dependencies contain ${unwanted.length - 20} additional development artifacts`);
    }
  }
}

function walkJavaScriptFiles(rootDir) {
  const files = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function resolvesPackagedRelativeModule(fromFile, request) {
  const basePath = path.resolve(path.dirname(fromFile), request);
  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.json`,
    `${basePath}.node`,
    path.join(basePath, 'index.js'),
    path.join(basePath, 'index.json'),
    path.join(basePath, 'index.node'),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function validatePackagedRelativeRequires() {
  if (!fs.existsSync(PACKAGED_BACKEND)) return;

  const unresolved = [];
  const requirePattern = /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const filePath of walkJavaScriptFiles(PACKAGED_BACKEND)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(requirePattern)) {
      const importKey = `${path.relative(PACKAGED_BACKEND, filePath).replace(/\\/g, '/')} -> ${match[1]}`;
      if (INTENTIONALLY_OMITTED_RELATIVE_IMPORTS.has(importKey)) continue;
      if (!resolvesPackagedRelativeModule(filePath, match[1])) {
        unresolved.push(`${path.relative(PACKAGED_BACKEND, filePath)} -> ${match[1]}`);
      }
    }
  }

  if (unresolved.length === 0) {
    ok('packaged backend hard relative imports resolve inside the artifact');
    return;
  }

  for (const missing of unresolved.slice(0, 20)) {
    fail(`packaged backend hard relative import resolves: ${missing}`);
  }
  if (unresolved.length > 20) {
    fail(`packaged backend has ${unresolved.length - 20} additional unresolved hard relative imports`);
  }
}

console.log('=== Electron Packaged Smoke Test ===');

if (!exists(DIST, 'dist/electron exists')) {
  process.exit(1);
}

const nsisArtifact = findFileBy((name) => (/setup/i.test(name) || /installer/i.test(name)) && name.toLowerCase().endsWith('.exe'));
const portableArtifact = findFileBy((name) => (
  name.toLowerCase().endsWith('.exe') &&
  !/setup|installer|uninstall/i.test(name) &&
  name !== nsisArtifact
));

if (portableArtifact) {
  ok(`portable artifact present: ${portableArtifact}`);
} else {
  fail('portable artifact present');
}

if (nsisArtifact) {
  ok(`NSIS artifact present: ${nsisArtifact}`);
} else {
  fail('NSIS artifact present');
}

if (exists(WIN_UNPACKED, 'win-unpacked exists')) {
  const unpackedExe = findWinUnpackedExe();
  if (unpackedExe) {
    ok(`win-unpacked executable exists: ${unpackedExe}`);
  } else {
    fail('win-unpacked executable exists');
  }
  exists(path.join(WIN_UNPACKED, 'resources', 'backend', 'core', 'simbridge.js'), 'backend script bundled');
  exists(path.join(WIN_UNPACKED, 'resources', 'backend', 'history-index', 'history-index-store.js'), 'history index runtime bundled');
  exists(RUST_SIDECAR_BINARY, 'Rust sidecar executable bundled');
  exists(path.join(WIN_UNPACKED, 'resources', 'frontend', 'index.html'), 'frontend index bundled');
  for (const audioFile of REQUIRED_STANDARD_CABIN_AUDIO_FILES) {
    exists(
      path.join(PACKAGED_STANDARD_CABIN_AUDIO, audioFile),
      `standard cabin audio bundled: ${audioFile}`
    );
  }
  exists(path.join(WIN_UNPACKED, 'resources', 'shared', 'app-settings-shared.js'), 'shared runtime bundled');
  exists(path.join(WIN_UNPACKED, 'resources', 'backend', 'data-sync', 'data', 'ourairports', 'airports.csv'), 'airports.csv bundled');
  exists(path.join(WIN_UNPACKED, 'resources', 'backend', 'data-sync', 'data', 'ourairports', 'runways.csv'), 'runways.csv bundled');
  exists(path.join(WIN_UNPACKED, 'resources', 'backend', 'data-sync', 'data', 'ourairports', 'manifest.json'), 'OurAirports freshness manifest bundled');
  validatePackagedBackendDependencies();
  validatePackagedRelativeRequires();
  for (const relativeParts of FORBIDDEN_BACKEND_PATHS) {
    absent(
      path.join(PACKAGED_BACKEND, ...relativeParts),
      `legacy/generated backend path absent: ${relativeParts.join('/')}`
    );
  }
}

console.log('------------------------------------');
if (failed > 0) {
  console.log(`Smoke test failed: ${failed} check(s)`);
  process.exit(1);
}

console.log('Smoke test passed');
