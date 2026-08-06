#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  getRepoScratchPath,
  resetRepoScratchDirectory,
} = require('./repo-scratch');

const ROOT = path.resolve(__dirname, '..');
const DIST_ROOT = path.join(ROOT, 'dist');
const BACKEND_SRC = path.join(ROOT, 'backend');
const BACKEND_DIST = path.join(DIST_ROOT, 'backend');
const TESTS_DIST = path.join(DIST_ROOT, 'tests');
const SHARED_SRC = path.join(ROOT, 'shared');
const SHARED_DIST = path.join(DIST_ROOT, 'shared');
const FRONTEND_SRC = path.join(ROOT, 'frontend');
const FRONTEND_DIST = path.join(DIST_ROOT, 'frontend');
const ROOT_PACKAGE_JSON = path.join(ROOT, 'package.json');
const DIST_PACKAGE_JSON = path.join(DIST_ROOT, 'package.json');
const TSC_BIN = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TS_RUNTIME_CONFIG = path.join(ROOT, 'tsconfig.backend.runtime.json');
const RUST_SIDECAR_BINARY_NAME = process.platform === 'win32'
  ? 'ff-rust-simconnect-sidecar.exe'
  : 'ff-rust-simconnect-sidecar';
const RUST_SIDECAR_PROJECT_DIR = path.join(BACKEND_SRC, 'telemetry-provider', 'rust-simconnect-sidecar');
const RUST_SIDECAR_MANIFEST = path.join(RUST_SIDECAR_PROJECT_DIR, 'Cargo.toml');
// Never build into the crate's default target/release directory. A standalone
// development backend may be running that exact binary, which makes Cargo fail
// before the runtime build gets a chance to preserve the locked dist copy.
const RUST_SIDECAR_BUILD_TARGET_DIR = getRepoScratchPath('rust-sidecar-release-target');
const RUST_SIDECAR_RELEASE_BINARY = path.join(
  RUST_SIDECAR_BUILD_TARGET_DIR,
  'release',
  RUST_SIDECAR_BINARY_NAME,
);
const RUST_SIDECAR_DIST_DIR = path.join(BACKEND_DIST, 'telemetry-provider');
const RUST_SIDECAR_DIST_BINARY = path.join(RUST_SIDECAR_DIST_DIR, RUST_SIDECAR_BINARY_NAME);
const RUST_SIDECAR_PENDING_DIR = path.join(RUST_SIDECAR_DIST_DIR, '.pending');
const RUST_SIDECAR_PENDING_BINARY = path.join(
  RUST_SIDECAR_PENDING_DIR,
  RUST_SIDECAR_BINARY_NAME,
);

function log(message) {
  console.log(`[build-backend-runtime] ${message}`);
}

function candidateCargoPaths() {
  const names = process.platform === 'win32' ? ['cargo.exe', 'cargo.cmd', 'cargo'] : ['cargo'];
  const dirs = [];
  if (process.env.CARGO_HOME) dirs.push(path.join(process.env.CARGO_HOME, 'bin'));
  if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, '.cargo', 'bin'));
  if (process.env.HOME) dirs.push(path.join(process.env.HOME, '.cargo', 'bin'));
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) dirs.push(dir);
  }

  const seen = new Set();
  const paths = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      const key = candidate.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(candidate);
      }
    }
  }
  return paths;
}

function resolveCargo() {
  for (const candidate of candidateCargoPaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'cargo.exe' : 'cargo';
}

function isFileBusyError(err) {
  return err && (err.code === 'EPERM' || err.code === 'EBUSY');
}

function isRustSidecarDistPath(targetPath) {
  return path.basename(targetPath) === RUST_SIDECAR_BINARY_NAME
    && normalizeRelative(path.relative(BACKEND_DIST, targetPath)) === `telemetry-provider/${RUST_SIDECAR_BINARY_NAME}`;
}

function isBackendRuntimePath(targetPath) {
  const rel = normalizeRelative(path.relative(BACKEND_DIST, targetPath));
  return rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel);
}

function removeTarget(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const options = {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  };
  try {
    fs.rmSync(targetPath, options);
    return;
  } catch (err) {
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw err;
    }
    log(`Could not remove ${path.relative(ROOT, targetPath)} directly; cleaning its contents instead (${err.code || err.message})`);
  }

  cleanDirectoryContents(targetPath, options);
  try {
    fs.rmdirSync(targetPath);
  } catch {}
}

function cleanDirectoryContents(targetPath, options) {
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name);
    if (!entry.isDirectory()) {
      try {
        fs.rmSync(entryPath, options);
      } catch (err) {
        if (isFileBusyError(err) && isBackendRuntimePath(entryPath)) {
          const label = isRustSidecarDistPath(entryPath) ? 'Rust sidecar binary' : 'runtime file';
          log(`Preserving locked ${label} at ${path.relative(ROOT, entryPath)}`);
          continue;
        }
        throw err;
      }
      continue;
    }

    cleanDirectoryContents(entryPath, options);
    try {
      fs.rmdirSync(entryPath);
    } catch {}
  }
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyFile(srcPath, destPath) {
  ensureDir(path.dirname(destPath));
  try {
    fs.copyFileSync(srcPath, destPath);
    return 'copied';
  } catch (err) {
    if (isFileBusyError(err) && fs.existsSync(destPath) && isBackendRuntimePath(destPath)) {
      log(`Preserving locked runtime file at ${path.relative(ROOT, destPath)}`);
      return 'preserved';
    }
    throw err;
  }
}

function filesHaveSameContents(leftPath, rightPath) {
  try {
    const leftStat = fs.statSync(leftPath);
    const rightStat = fs.statSync(rightPath);
    if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) {
      return false;
    }
    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
  } catch {
    return false;
  }
}

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join('/');
}

function isDocOrJunkFile(name) {
  const lower = String(name || '').toLowerCase();
  return lower === 'package-lock.json'
    || lower === '.ds_store'
    || lower === 'thumbs.db'
    || lower.endsWith('.map')
    || lower.endsWith('.log')
    || lower.endsWith('.bak')
    || lower.endsWith('.tmp')
    || lower.endsWith('.orig')
    || lower.endsWith('.pyc')
    || lower.endsWith('.pyo')
    || lower.endsWith('.ts')
    || lower.endsWith('.md')
    || lower.endsWith('.pdf')
    || lower.endsWith('.doc')
    || lower.endsWith('.docx');
}

function shouldSkipBackendDir(relativeDir) {
  const rel = normalizeRelative(relativeDir);
  return rel === 'node_modules'
    || rel === 'test-support'
    || rel === 'types'
    || rel === '__pycache__'
    || rel === 'telemetry-provider/rust-simconnect-sidecar'
    || rel.startsWith('telemetry-provider/rust-simconnect-sidecar/');
}

function shouldSkipBackendFile(srcPath, relativeFile) {
  const rel = normalizeRelative(relativeFile);
  const base = path.basename(rel);
  if (isDocOrJunkFile(base)) return true;
  if (base.endsWith('.test.js')) return true;
  if (base.endsWith('.ts') || base.endsWith('.d.ts')) return true;
  if (/^_(?:quickstart|template).*\.json$/i.test(base)) return true;
  if (rel === 'package-lock.json') return true;
  if (rel.startsWith('types/') || rel.startsWith('test-support/')) return true;
  if (rel.startsWith('test/')) return true;
  if (rel.startsWith('__pycache__/')) return true;
  if (rel.startsWith('telemetry-provider/rust-simconnect-sidecar/')) return true;
  if (base.endsWith('.js')) {
    const tsSibling = srcPath.slice(0, -3) + '.ts';
    if (fs.existsSync(tsSibling)) return true;
  }
  return false;
}

function shouldSkipGenericDir(name) {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === '__pycache__';
}

function shouldSkipGenericFile(name) {
  return isDocOrJunkFile(name);
}

function copyTree(srcRoot, destRoot, options = {}) {
  if (!fs.existsSync(srcRoot)) return 0;

  const {
    shouldSkipDir = () => false,
    shouldSkipFile = () => false,
  } = options;

  let copied = 0;

  function visit(currentSrc, currentDest, relativeDir) {
    ensureDir(currentDest);
    const entries = fs.readdirSync(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      const entrySrc = path.join(currentSrc, entry.name);
      const entryDest = path.join(currentDest, entry.name);
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipDir(relativePath, entry.name)) {
          continue;
        }
        visit(entrySrc, entryDest, relativePath);
        continue;
      }
      if (shouldSkipFile(entrySrc, relativePath, entry.name)) {
        continue;
      }
      copyFile(entrySrc, entryDest);
      copied += 1;
    }
  }

  visit(srcRoot, destRoot, '');
  return copied;
}

function buildTypeScriptRuntime() {
  log('Compiling TypeScript runtime modules to dist/backend...');
  execFileSync(process.execPath, [TSC_BIN, '-p', TS_RUNTIME_CONFIG], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function copyBackendRuntimeFiles() {
  log('Copying backend JavaScript/assets without TS source files...');
  const copied = copyTree(BACKEND_SRC, BACKEND_DIST, {
    shouldSkipDir: (relativeDir) => shouldSkipBackendDir(relativeDir),
    shouldSkipFile: (srcPath, relativePath) => shouldSkipBackendFile(srcPath, relativePath),
  });
  log(`Copied ${copied} backend source/runtime asset files`);
}

function copyTopLevelRuntimeTree(label, srcRoot, destRoot) {
  if (!fs.existsSync(srcRoot)) {
    log(`Skipping ${label}; source not found`);
    return;
  }
  const copied = copyTree(srcRoot, destRoot, {
    shouldSkipDir: (_relativePath, dirName) => shouldSkipGenericDir(dirName),
    shouldSkipFile: (_srcPath, _relativePath, fileName) => shouldSkipGenericFile(fileName),
  });
  log(`Copied ${copied} files for ${label}`);
}

function copyDistPackageJson() {
  if (!fs.existsSync(ROOT_PACKAGE_JSON)) return;
  const rootPkg = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
  const runtimePkg = {
    name: rootPkg.name,
    version: rootPkg.version,
    description: rootPkg.description,
    license: rootPkg.license,
    type: rootPkg.type || 'commonjs',
    dependencies: rootPkg.dependencies || {},
    optionalDependencies: rootPkg.optionalDependencies || {},
  };
  ensureDir(path.dirname(DIST_PACKAGE_JSON));
  fs.writeFileSync(DIST_PACKAGE_JSON, JSON.stringify(runtimePkg, null, 2) + '\n');
  log('Wrote minimal runtime package.json to dist/package.json');
}

function buildRustSidecarBinary() {
  if (!fs.existsSync(RUST_SIDECAR_MANIFEST)) {
    throw new Error(`Rust sidecar manifest is required but missing: ${RUST_SIDECAR_MANIFEST}`);
  }

  const cargo = resolveCargo();
  // Always recreate the exact target before Cargo runs. Cargo's normal
  // freshness checks cannot prove that a persistent ignored executable was
  // produced from the current source.
  resetRepoScratchDirectory('rust-sidecar-release-target');
  log('Building current release Rust sidecar from source...');
  try {
    execFileSync(cargo, [
      'build',
      '--locked',
      '--release',
      '--manifest-path',
      RUST_SIDECAR_MANIFEST,
      '--target-dir',
      RUST_SIDECAR_BUILD_TARGET_DIR,
    ], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(
        `Cargo was not found, so ${RUST_SIDECAR_BINARY_NAME} could not be built. `
        + 'Install Rust/Cargo or provide a prebuilt sidecar binary before running build:backend:runtime.',
      );
    }
    throw err;
  }

  if (!fs.existsSync(RUST_SIDECAR_RELEASE_BINARY)) {
    throw new Error(
      `Cargo completed without producing ${path.relative(ROOT, RUST_SIDECAR_RELEASE_BINARY)}`,
    );
  }
}

function verifyRustSidecarGuardianCapability(binaryPath) {
  const result = spawnSync(binaryPath, ['--process-guardian'], {
    cwd: path.dirname(binaryPath),
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Rust sidecar guardian capability probe failed: ${result.error.message}`);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 3 || !/process guardian failed:.*requires --ff-owner-pid=/i.test(output)) {
    throw new Error(
      `Rust sidecar does not expose the required process guardian contract: ${output.trim() || `exit ${result.status}`}`,
    );
  }
  log('Verified Rust sidecar process guardian capability');
}

function copyRustSidecarBinary() {
  buildRustSidecarBinary();
  const sourcePath = RUST_SIDECAR_RELEASE_BINARY;
  verifyRustSidecarGuardianCapability(sourcePath);
  const mainCopyOutcome = copyFile(sourcePath, RUST_SIDECAR_DIST_BINARY);

  if (mainCopyOutcome === 'preserved') {
    const pendingCopyOutcome = copyFile(sourcePath, RUST_SIDECAR_PENDING_BINARY);
    if (
      pendingCopyOutcome === 'preserved'
      && !filesHaveSameContents(sourcePath, RUST_SIDECAR_PENDING_BINARY)
    ) {
      throw new Error(
        'Both managed Rust sidecar binaries are locked and the staged copy is stale. '
        + 'Stop the process using the pending sidecar and retry the runtime build.',
      );
    }
    log(
      `Staged current Rust sidecar at ${path.relative(ROOT, RUST_SIDECAR_PENDING_BINARY)} `
      + `because ${path.relative(ROOT, RUST_SIDECAR_DIST_BINARY)} is locked`,
    );
    return;
  }

  // A later live build can run from the staged executable while the normal
  // dist path is free. Refresh the normal path, then remove the older staged
  // copy when Windows permits it. If it is still locked, runtime resolvers use
  // mtime to select this newer main artifact for the next process generation.
  removeTarget(RUST_SIDECAR_PENDING_DIR);
  if (fs.existsSync(RUST_SIDECAR_PENDING_BINARY)) {
    log(
      `Retained locked staged Rust sidecar at ${path.relative(ROOT, RUST_SIDECAR_PENDING_BINARY)}; `
      + 'runtime resolution will select the newer managed artifact',
    );
  }
  log(
    `Copied Rust sidecar binary from ${path.relative(ROOT, sourcePath)} `
    + `to ${path.relative(ROOT, RUST_SIDECAR_DIST_BINARY)}`,
  );
}

function main() {
  ensureDir(DIST_ROOT);

  removeTarget(BACKEND_DIST);
  removeTarget(TESTS_DIST);
  removeTarget(SHARED_DIST);
  removeTarget(FRONTEND_DIST);
  removeTarget(path.join(DIST_ROOT, 'live-sharing'));
  removeTarget(DIST_PACKAGE_JSON);

  buildTypeScriptRuntime();
  copyBackendRuntimeFiles();
  copyRustSidecarBinary();
  copyTopLevelRuntimeTree('shared runtime assets', SHARED_SRC, SHARED_DIST);
  copyTopLevelRuntimeTree('frontend runtime assets', FRONTEND_SRC, FRONTEND_DIST);
  copyDistPackageJson();

  log('Backend runtime build complete');
}

main();
