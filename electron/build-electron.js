/**
 * Electron Build Script
 * 
 * 1. Loads release profile to determine included files
 * 2. Copies backend JavaScript (filtered by profile)
 * 3. Copies frontend files (filtered by profile)
 * 4. Builds dashboard executable (if requested)
 * 5. Packages with electron-builder
 * 
 * Usage: node build-electron.js [--profile=user] [--with-dashboard]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');

// Import release profile loader
const { resolveProfile, validateProfile } = require('../scripts/release-profile-loader');
const {
  getRepoScratchPath,
  resetRepoScratchDirectory,
} = require('../scripts/repo-scratch');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = __dirname;
const ROOT_PACKAGE_JSON = path.join(ROOT, 'package.json');
const ELECTRON_PACKAGE_JSON = path.join(ELECTRON_DIR, 'package.json');
const BACKEND_SOURCE = path.join(ROOT, 'backend');
const BACKEND_RUNTIME = path.join(ROOT, 'dist', 'backend');
const BACKEND_BUILD = path.join(ROOT, 'backend-build');
const FRONTEND_SRC = path.join(ROOT, 'frontend');
const FRONTEND_DIST = path.join(ROOT, 'frontend-dist');
const OURAIRPORTS_DIR = path.join(BACKEND_SOURCE, 'data-sync', 'data', 'ourairports');
const PACKAGED_OURAIRPORTS_DIR = path.join(ROOT, 'dist', 'electron', 'win-unpacked', 'resources', 'backend', 'data-sync', 'data', 'ourairports');
const REQUIRED_OURAIRPORTS_FILES = ['airports.csv', 'runways.csv'];
const OURAIRPORTS_MANIFEST_FILE = 'manifest.json';
const DEFAULT_OURAIRPORTS_DATA_MAX_AGE_DAYS = 30;
const PACKAGED_LEGAL_DIR = path.join(ROOT, 'dist', 'electron', 'win-unpacked', 'resources', 'legal');
const REQUIRED_LEGAL_FILES = [
  'SAFETY-NOTICE.md',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE.md',
  'OURAIRPORTS-DATA-LICENSE.txt',
];
const TAILWIND_CONFIG = path.join(ROOT, 'tailwind.config.js');
const TAILWIND_INPUT = path.join(FRONTEND_SRC, 'tailwind-input.css');
const TAILWIND_OUTPUT = path.join(FRONTEND_DIST, 'tailwind.css');
const TAILWIND_CLI = path.join(ELECTRON_DIR, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
const DASHBOARD_DIR = path.join(ROOT, 'tools', 'flight-dashboard');
const DASHBOARD_DIST = path.join(DASHBOARD_DIR, 'dist', 'flight-dashboard');
const BACKEND_PACKAGE_JSON = path.join(BACKEND_SOURCE, 'package.json');
const BACKEND_PACKAGE_LOCK = path.join(BACKEND_SOURCE, 'package-lock.json');
const BACKEND_NODE_MODULES = path.join(BACKEND_SOURCE, 'node_modules');
const RUST_SIDECAR_DIR = path.join(BACKEND_SOURCE, 'telemetry-provider', 'rust-simconnect-sidecar');
const RUST_SIDECAR_MANIFEST = path.join(RUST_SIDECAR_DIR, 'Cargo.toml');
const RUST_SIDECAR_BINARY_NAME = process.platform === 'win32'
  ? 'ff-rust-simconnect-sidecar.exe'
  : 'ff-rust-simconnect-sidecar';
const RUST_SIDECAR_BUILD_TARGET_NAME = 'electron-rust-sidecar-release-target';
const RUST_SIDECAR_BUILD_TARGET_DIR = getRepoScratchPath(RUST_SIDECAR_BUILD_TARGET_NAME);
const RUST_SIDECAR_BINARY_SRC = path.join(
  RUST_SIDECAR_BUILD_TARGET_DIR,
  'release',
  RUST_SIDECAR_BINARY_NAME
);
const SIMCONNECT_DLL_NAME = 'SimConnect.dll';
const SIMCONNECT_DLL_RELATIVE = path.join('telemetry-provider', 'simconnect', SIMCONNECT_DLL_NAME);
const SIMCONNECT_DEFAULT_SDK_PATHS = process.platform === 'win32'
  ? [
      'C:\\MSFS 2024 SDK\\SimConnect SDK\\lib\\SimConnect.dll',
      'C:\\MSFS SDK\\SimConnect SDK\\lib\\SimConnect.dll',
    ]
  : [];
const PACKAGED_RUST_SIDECAR_BINARY = path.join(
  ROOT,
  'dist',
  'electron',
  'win-unpacked',
  'resources',
  'backend',
  'telemetry-provider',
  RUST_SIDECAR_BINARY_NAME
);
const args = process.argv.slice(2);
const withDashboard = args.includes('--with-dashboard');
const skipNativeRebuild = args.includes('--skip-native-rebuild');
const NODE_BIN_DIR = path.dirname(process.execPath);
const NPM_CLI = process.env.npm_execpath || path.join(NODE_BIN_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const NPX_CLI = path.join(NODE_BIN_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js');
const CARGO_BIN = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const PYINSTALLER_BIN = process.platform === 'win32' ? 'pyinstaller.exe' : 'pyinstaller';

function runNpm(args, options) {
  execFileSync(process.execPath, [NPM_CLI, ...args], options);
}

function runNpx(args, options) {
  execFileSync(process.execPath, [NPX_CLI, ...args], options);
}

// Tailwind purge failures are hard to spot until the packaged UI looks unstyled.
// Guardrail: if the generated CSS is suspiciously tiny, fail the build early.
const MIN_TAILWIND_BYTES = 10 * 1024;

// Parse --profile=<name> (default: 'user')
const profileArg = args.find(a => a.startsWith('--profile='));
const profileName = profileArg ? profileArg.split('=')[1] : 'user';

// Resolved profile (loaded once, used throughout)
let resolvedProfile = null;

// Documentation files to EXCLUDE from release builds entirely
// These should NEVER ship in the Electron package
const DOCS_EXCLUDE = [
  // Documentation
  '*.md',
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.txt',
  'README*',
  'CHANGELOG*',
  'LICENSE*',
  // Development artifacts
  '*.map',           // Source maps
  '*.log',           // Log files
  '*.bak',           // Backup files
  '*.tmp',           // Temp files
  '*.orig',          // Git conflict originals
  // Config/dotfiles that shouldn't ship
  '.gitignore',
  '.gitattributes',
  '.eslintrc*',
  '.prettierrc*',
  '.editorconfig',
  '.env.example',
  '*.example',
  // Package lock files (the build uses the Electron lockfile before packaging)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  // SENSITIVE: Credentials, secrets, API keys - MUST NEVER SHIP
  '*-creds.json',
  '*-credentials.json',
  '*-secret*',
  '*-api-key*',
  '*.pem',           // SSL/TLS certificates
  '*.key',           // Private keys
  '*.crt',           // Certificates
  '*.pfx',           // PKCS#12 files
  '*.p12',           // PKCS#12 files
  '.env',            // Environment files with secrets
  '.env.local',
  '.env.production',
  '.env.development',
  '*.secrets',
  'credentials*',
  'secrets*',
];

/**
 * Check if a file is a documentation file that should be excluded from builds
 */
function isDocumentationFile(name) {
  const lowerName = name.toLowerCase();
  return DOCS_EXCLUDE.some(pattern => {
    if (pattern.startsWith('*.')) {
      return lowerName.endsWith(pattern.slice(1).toLowerCase());
    }
    if (pattern.endsWith('*')) {
      return lowerName.startsWith(pattern.slice(0, -1).toLowerCase());
    }
    return lowerName === pattern.toLowerCase();
  });
}

function isRuntimeJunkFile(name) {
  const lowerName = name.toLowerCase();
  if (lowerName === '__pycache__') return true;
  return lowerName.endsWith('.pyc') || lowerName.endsWith('.pyo');
}

function normalizeRelPath(relPath) {
  return String(relPath || '').split(path.sep).join('/');
}

function isRustSidecarSourcePath(relPath) {
  const normalized = normalizeRelPath(relPath);
  return normalized === 'telemetry-provider/rust-simconnect-sidecar'
    || normalized.startsWith('telemetry-provider/rust-simconnect-sidecar/');
}

/**
 * Small glob matcher for release profile exclude_patterns.
 */
function matchesPattern(filePath, pattern) {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = path.posix.basename(normalizedPath);

  if (!normalizedPattern.includes('/')) {
    return globToRegExp(normalizedPattern).test(basename);
  }

  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function globToRegExp(pattern) {
  let regex = '';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const prev = pattern[i - 1];
    const precededBySlash = prev === '/';

    if (char === '*' && next === '*') {
      const followedBySlash = pattern[i + 2] === '/';

      if (followedBySlash) {
        regex += '(?:.*/)?';
        i += 2;
      } else {
        regex += '.*';
        i += 1;
      }

      continue;
    }

    if (char === '*') {
      regex += '[^/]*';
      continue;
    }

    if (char === '?' && !precededBySlash) {
      regex += '[^/]';
      continue;
    }

    regex += escapeRegExp(char);
  }

  return new RegExp(`^${regex}$`);
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Rebuild native modules for Electron's Node version
 * Use @electron/rebuild after copying node_modules to backend-build
 */
function rebuildNativeModules() {
  if (skipNativeRebuild) {
    log('Skipping native module rebuild (--skip-native-rebuild)');
    return;
  }
  
  log('Rebuilding native modules for Electron...');
  
  // Get Electron version from package.json
  const electronPkg = require('./package.json');
  const electronVersion = electronPkg.devDependencies.electron.replace('^', '');

  // Path to the backend package root whose node_modules need rebuilding.
  // @electron/rebuild expects --module-dir to point at a package directory
  // containing package.json, not the node_modules directory itself.
  const targetModules = path.join(BACKEND_BUILD, 'node_modules');

  if (!fs.existsSync(targetModules)) {
    log('  No node_modules to rebuild yet');
    return;
  }

  // Use @electron/rebuild directly on the target.
  // Run from electron folder where electron is installed.
  const rebuildArgs = ['@electron/rebuild', '--module-dir', BACKEND_BUILD, '--version', electronVersion];
  log(`  Running: node ${path.basename(NPX_CLI)} ${rebuildArgs.join(' ')}`);

  try {
    runNpx(rebuildArgs, {
      cwd: ELECTRON_DIR,
      stdio: 'inherit'
    });
  } catch (err) {
    throw new Error(`Failed to rebuild native modules: ${err.message}`);
  }

  log('Native modules rebuilt successfully');
}

function buildBackendRuntime() {
  log('Building backend runtime into dist/backend...');

  try {
    runNpm(['run', 'build:backend:runtime'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    error(`Failed to build backend runtime: ${err.message}`);
    process.exit(1);
  }
}

function readRequiredJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  const value = readJsonFile(filePath);
  if (value.__readError) {
    throw new Error(`Invalid ${label} at ${filePath}: ${value.__readError}`);
  }
  return value;
}

function sortedRecord(value) {
  return Object.fromEntries(
    Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right))
  );
}

function assertDependencyMetadataMatches(left, right, leftLabel, rightLabel) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const leftValue = sortedRecord(left[field]);
    const rightValue = sortedRecord(right[field]);
    if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
      throw new Error(
        `Backend ${field} mismatch between ${leftLabel} and ${rightLabel}; `
        + 'run npm install --package-lock-only in backend and rebuild the runtime'
      );
    }
  }
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function normalizedAbsolutePathKey(filePath) {
  const absolutePath = path.resolve(filePath);
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

function resolveLockedPackageDirectory(lockPath, modulesRoot) {
  const prefix = 'node_modules/';
  const normalizedLockPath = String(lockPath || '').replace(/\\/g, '/');
  if (
    !normalizedLockPath.startsWith(prefix)
    || path.posix.normalize(normalizedLockPath) !== normalizedLockPath
  ) {
    throw new Error(`Unsafe backend package-lock path: ${lockPath}`);
  }

  const relativePackagePath = normalizedLockPath.slice(prefix.length);
  if (!relativePackagePath || relativePackagePath.startsWith('../')) {
    throw new Error(`Unsafe backend package-lock path: ${lockPath}`);
  }

  const packageDir = path.resolve(
    modulesRoot,
    ...relativePackagePath.split('/')
  );
  if (!isPathInside(path.resolve(modulesRoot), packageDir)) {
    throw new Error(`Backend package-lock path escapes node_modules: ${lockPath}`);
  }
  return { packageDir, relativePackagePath };
}

function copyLockedPackageDirectory(sourceDir, destinationDir) {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    filter(sourcePath) {
      if (sourcePath === sourceDir) return true;
      const relative = path.relative(sourceDir, sourcePath);
      return !relative.split(path.sep).includes('node_modules');
    },
  });
}

function assertSafeDependencyTree(rootDir, label) {
  const resolvedRoot = path.resolve(rootDir);
  const realRoot = fs.realpathSync(rootDir);
  if (
    normalizedAbsolutePathKey(resolvedRoot)
    !== normalizedAbsolutePathKey(realRoot)
  ) {
    throw new Error(`Backend dependency root is a link or reparse point: ${label}`);
  }

  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const entryStat = fs.lstatSync(entryPath);
      const realEntryPath = fs.realpathSync(entryPath);
      if (
        entryStat.isSymbolicLink()
        || normalizedAbsolutePathKey(entryPath) !== normalizedAbsolutePathKey(realEntryPath)
        || !isPathInside(realRoot, realEntryPath)
      ) {
        throw new Error(
          `Backend dependency contains a link or reparse-point entry: `
          + `${label}/${path.relative(resolvedRoot, entryPath)}`
        );
      }
      if (entryStat.isDirectory()) {
        pending.push(entryPath);
      } else if (!entryStat.isFile()) {
        throw new Error(
          `Backend dependency contains a non-regular entry: `
          + `${label}/${path.relative(resolvedRoot, entryPath)}`
        );
      }
    }
  }
}

/**
 * Copy the backend runtime dependencies from backend/node_modules only.
 * backend/package-lock.json is the complete inventory: every production
 * package, including transitive and nested packages, must be installed at the
 * exact locked version before release packaging starts.
 */
function copyLockedBackendNodeModules(destModules) {
  log('  Validating backend runtime dependencies against backend/package-lock.json...');
  const backendPkgSrc = path.join(BACKEND_RUNTIME, 'package.json');
  const backendPkgDest = path.join(BACKEND_BUILD, 'package.json');
  const sourcePackage = readRequiredJsonFile(BACKEND_PACKAGE_JSON, 'backend package.json');
  const runtimePackage = readRequiredJsonFile(backendPkgSrc, 'backend runtime package.json');
  const lockfile = readRequiredJsonFile(BACKEND_PACKAGE_LOCK, 'backend package-lock.json');

  if (![2, 3].includes(lockfile.lockfileVersion) || !lockfile.packages) {
    throw new Error(
      `Unsupported backend package-lock format at ${BACKEND_PACKAGE_LOCK}; `
      + 'lockfileVersion 2 or 3 with a packages inventory is required'
    );
  }
  const lockRoot = lockfile.packages[''];
  if (!lockRoot) {
    throw new Error(`Backend package-lock is missing its root package entry: ${BACKEND_PACKAGE_LOCK}`);
  }

  assertDependencyMetadataMatches(
    sourcePackage,
    runtimePackage,
    'backend/package.json',
    'dist/backend/package.json'
  );
  assertDependencyMetadataMatches(
    sourcePackage,
    lockRoot,
    'backend/package.json',
    'backend/package-lock.json'
  );

  if (!fs.existsSync(BACKEND_NODE_MODULES)) {
    throw new Error(
      `Missing locked backend dependencies at ${BACKEND_NODE_MODULES}; `
      + 'run npm ci --prefix backend before packaging'
    );
  }
  const realModulesRoot = fs.realpathSync(BACKEND_NODE_MODULES);
  if (
    normalizedAbsolutePathKey(realModulesRoot)
    !== normalizedAbsolutePathKey(BACKEND_NODE_MODULES)
  ) {
    throw new Error(
      `backend/node_modules must not be a symlink or junction: ${BACKEND_NODE_MODULES}`
    );
  }

  if (!fs.existsSync(backendPkgDest)) {
    copyPackagedBackendPackageJson(backendPkgSrc, backendPkgDest);
  }

  const rootDependencies = {
    ...(sourcePackage.dependencies || {}),
    ...(sourcePackage.optionalDependencies || {}),
  };
  for (const packageName of Object.keys(rootDependencies)) {
    const lockPath = `node_modules/${packageName}`;
    const lockedPackage = lockfile.packages[lockPath];
    if (!lockedPackage || lockedPackage.dev === true) {
      throw new Error(
        `Backend package-lock has no production entry for direct dependency ${packageName}`
      );
    }
  }

  const packagesToCopy = [];
  const productionEntries = Object.entries(lockfile.packages)
    .filter(([lockPath, lockedPackage]) => (
      lockPath.startsWith('node_modules/')
      && lockedPackage
      && lockedPackage.dev !== true
    ))
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [lockPath, lockedPackage] of productionEntries) {
    if (lockedPackage.link === true || typeof lockedPackage.version !== 'string') {
      throw new Error(`Unsupported linked or unversioned backend dependency in lockfile: ${lockPath}`);
    }

    const { packageDir, relativePackagePath } = resolveLockedPackageDirectory(
      lockPath,
      BACKEND_NODE_MODULES
    );
    if (!fs.existsSync(packageDir)) {
      if (lockedPackage.optional === true || lockedPackage.devOptional === true) {
        log(`  Optional locked dependency not installed on this platform: ${relativePackagePath}`);
        continue;
      }
      throw new Error(
        `Missing locked backend dependency ${relativePackagePath}@${lockedPackage.version}; `
        + 'run npm ci --prefix backend'
      );
    }
    const packageJsonPath = path.join(packageDir, 'package.json');
    const installedPackage = readRequiredJsonFile(
      packageJsonPath,
      `installed backend dependency ${relativePackagePath}/package.json`
    );
    if (installedPackage.version !== lockedPackage.version) {
      throw new Error(
        `Backend dependency version mismatch for ${relativePackagePath}: `
        + `installed ${installedPackage.version || '(missing)'}, `
        + `locked ${lockedPackage.version}; run npm ci --prefix backend`
      );
    }

    const realPackageDir = fs.realpathSync(packageDir);
    if (!isPathInside(realModulesRoot, realPackageDir)) {
      throw new Error(
        `Locked backend dependency resolves outside backend/node_modules: ${relativePackagePath}`
      );
    }
    assertSafeDependencyTree(packageDir, relativePackagePath);
    packagesToCopy.push({
      destinationDir: path.join(destModules, ...relativePackagePath.split('/')),
      lockedVersion: lockedPackage.version,
      relativePackagePath,
      sourceDir: packageDir,
    });
  }

  fs.rmSync(destModules, { recursive: true, force: true });
  fs.mkdirSync(destModules, { recursive: true });
  for (const packageCopy of packagesToCopy) {
    fs.mkdirSync(path.dirname(packageCopy.destinationDir), { recursive: true });
    copyLockedPackageDirectory(packageCopy.sourceDir, packageCopy.destinationDir);
    log(`  Included ${packageCopy.relativePackagePath}@${packageCopy.lockedVersion}`);
  }
  log(`  Copied ${packagesToCopy.length} locked backend runtime package(s)`);
}

function copyPackagedBackendPackageJson(sourcePath, destinationPath) {
  const packageJson = readJsonFile(sourcePath);
  if (packageJson.__readError) {
    throw new Error(`Invalid backend runtime package.json: ${packageJson.__readError}`);
  }

  // The source package is startable through scripts/start-backend-runtime.js,
  // but that repo-only wrapper is intentionally not copied into resources.
  // Keep dependency metadata without advertising missing installed commands.
  delete packageJson.main;
  delete packageJson.scripts;
  packageJson.private = true;
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

function log(msg) {
  console.log(`[build-electron] ${msg}`);
}

function error(msg) {
  console.error(`[build-electron] ERROR: ${msg}`);
}

function parseMaxAgeDays(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toLowerCase();
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { __readError: err.message };
  }
}

function getOurAirportsMaxAgeDays() {
  return parseMaxAgeDays(process.env.OURAIRPORTS_DATA_MAX_AGE_DAYS, DEFAULT_OURAIRPORTS_DATA_MAX_AGE_DAYS);
}

function getOurAirportsFreshnessIssues(dataDir, options = {}) {
  const issues = [];
  const maxAgeDays = Number.isFinite(options.maxAgeDays)
    ? options.maxAgeDays
    : getOurAirportsMaxAgeDays();
  const nowMs = options.nowMs || Date.now();

  for (const fileName of REQUIRED_OURAIRPORTS_FILES) {
    const filePath = path.join(dataDir, fileName);
    if (!fs.existsSync(filePath)) {
      issues.push(`${fileName} missing`);
      continue;
    }
    try {
      if (fs.statSync(filePath).size <= 0) {
        issues.push(`${fileName} is empty`);
      }
    } catch (err) {
      issues.push(`${fileName} cannot be read: ${err.message}`);
    }
  }

  const manifestPath = path.join(dataDir, OURAIRPORTS_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    issues.push(`${OURAIRPORTS_MANIFEST_FILE} missing`);
    return issues;
  }

  const manifest = readJsonFile(manifestPath);
  if (manifest.__readError) {
    issues.push(`${OURAIRPORTS_MANIFEST_FILE} invalid JSON: ${manifest.__readError}`);
    return issues;
  }

  const downloadedAtMs = Date.parse(manifest.downloadedAt);
  if (!Number.isFinite(downloadedAtMs)) {
    issues.push(`${OURAIRPORTS_MANIFEST_FILE} missing valid downloadedAt`);
  } else {
    const ageDays = (nowMs - downloadedAtMs) / (24 * 60 * 60 * 1000);
    if (ageDays < -1) {
      issues.push(`${OURAIRPORTS_MANIFEST_FILE} downloadedAt is in the future`);
    } else if (ageDays > maxAgeDays) {
      issues.push(`OurAirports data is ${ageDays.toFixed(1)} days old; max is ${maxAgeDays}`);
    }
  }

  for (const fileName of REQUIRED_OURAIRPORTS_FILES) {
    const filePath = path.join(dataDir, fileName);
    const fileMeta = manifest.files && manifest.files[fileName];
    if (!fileMeta || typeof fileMeta.sha256 !== 'string') {
      issues.push(`${OURAIRPORTS_MANIFEST_FILE} missing sha256 for ${fileName}`);
      continue;
    }
    if (!fs.existsSync(filePath)) continue;
    try {
      const actualHash = sha256File(filePath);
      if (actualHash !== fileMeta.sha256.toLowerCase()) {
        issues.push(`${fileName} hash does not match ${OURAIRPORTS_MANIFEST_FILE}`);
      }
    } catch (err) {
      issues.push(`${fileName} hash check failed: ${err.message}`);
    }
  }

  return issues;
}

/**
 * Ensure required OurAirports CSVs exist before backend copy starts.
 * If missing or stale, auto-fetch just the required files used by runtime
 * airport lookup so release packages contain local data and never need a
 * first-run fetch.
 */
function ensureOurAirportsData() {
  const maxAgeDays = getOurAirportsMaxAgeDays();
  const issues = getOurAirportsFreshnessIssues(OURAIRPORTS_DIR, { maxAgeDays });

  if (issues.length === 0) {
    log(`OurAirports data ready (${REQUIRED_OURAIRPORTS_FILES.join(', ')}, max age ${maxAgeDays} days)`);
    return;
  }

  log(`OurAirports data needs refresh: ${issues.join('; ')}`);
  try {
    execFileSync(process.execPath, ['scripts/sync-aviation-data.js', '--required-only'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    error(`Failed to sync required airport data: ${err.message}`);
    process.exit(1);
  }

  const remainingIssues = getOurAirportsFreshnessIssues(OURAIRPORTS_DIR, { maxAgeDays });
  if (remainingIssues.length > 0) {
    error(`Airport data still not release-ready after sync: ${remainingIssues.join('; ')}`);
    process.exit(1);
  }

  log('OurAirports data sync complete.');
}

/**
 * Verify packaged app contains required airport CSVs.
 * This checks win-unpacked resources, which are the source for both NSIS and portable artifacts.
 */
function verifyPackagedOurAirportsData() {
  const issues = getOurAirportsFreshnessIssues(PACKAGED_OURAIRPORTS_DIR);

  if (issues.length > 0) {
    error(`Packaged build has invalid or stale airport data: ${issues.join('; ')}`);
    error(`Expected location: ${PACKAGED_OURAIRPORTS_DIR}`);
    process.exit(1);
  }

  log('Verified packaged OurAirports data in win-unpacked resources.');
}

/**
 * Verify packaged app contains required legal notices.
 */
function verifyPackagedLegalNotices() {
  const missing = REQUIRED_LEGAL_FILES.filter((fileName) => {
    const filePath = path.join(PACKAGED_LEGAL_DIR, fileName);
    if (!fs.existsSync(filePath)) return true;
    try {
      return fs.statSync(filePath).size <= 0;
    } catch {
      return true;
    }
  });

  if (missing.length > 0) {
    error(`Packaged build missing legal notice files: ${missing.join(', ')}`);
    error(`Expected location: ${PACKAGED_LEGAL_DIR}`);
    process.exit(1);
  }

  log('Verified packaged legal notices in win-unpacked resources.');
}

function verifyPackagedRustSidecar() {
  if (!fs.existsSync(PACKAGED_RUST_SIDECAR_BINARY)) {
    error(`Packaged build missing Rust sidecar: ${PACKAGED_RUST_SIDECAR_BINARY}`);
    process.exit(1);
  }

  try {
    if (fs.statSync(PACKAGED_RUST_SIDECAR_BINARY).size <= 0) {
      error(`Packaged Rust sidecar is empty: ${PACKAGED_RUST_SIDECAR_BINARY}`);
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to stat packaged Rust sidecar: ${err.message}`);
    process.exit(1);
  }

  log('Verified packaged Rust sidecar in win-unpacked resources.');
}

/**
 * Step 0: Load and validate release profile
 */
function loadReleaseProfile() {
  log(`Loading release profile: ${profileName}`);
  
  try {
    resolvedProfile = resolveProfile(profileName);
    log(`  Profile: ${resolvedProfile.displayName}`);
    log(`  Backend files: ${resolvedProfile.include.backend.length}`);
    log(`  Backend dirs: ${resolvedProfile.include.backend_dirs.length}`);
    log(`  Frontend files: ${resolvedProfile.include.frontend.length}`);
    
    // Validate profile
    const validation = validateProfile(profileName);
    if (!validation.valid) {
      error('Profile validation failed! Missing files:');
      for (const f of validation.missing) {
        error(`  - ${f}`);
      }
      process.exit(1);
    }
    log('  Profile validated OK');
  } catch (err) {
    error(`Failed to load profile: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Step 1: Copy backend (filtered by profile)
 */
async function copyBackend() {
  // Clean output directory
  if (fs.existsSync(BACKEND_BUILD)) {
    fs.rmSync(BACKEND_BUILD, { recursive: true });
  }
  fs.mkdirSync(BACKEND_BUILD, { recursive: true });

  log('Copying backend...');
  copyBackendFiltered();
}

/**
 * Copy backend files without obfuscation (filtered by profile)
 */
function copyBackendFiltered() {
  log('Copying backend files (filtered by profile)...');
  let count = 0;

  // Copy individual files
  for (const file of resolvedProfile.include.backend) {
    const srcPath = path.join(BACKEND_RUNTIME, file);
    const destPath = path.join(BACKEND_BUILD, file);
    
    if (matchesExcludePattern(file)) continue;
    if (!fs.existsSync(srcPath)) continue;
    
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    count++;
  }

  // Copy directories (respecting exclude patterns)
  for (const dir of resolvedProfile.include.backend_dirs) {
    const srcDir = path.join(BACKEND_RUNTIME, dir);
    const destDir = path.join(BACKEND_BUILD, dir);
    
    if (!fs.existsSync(srcDir)) continue;
    copyDirectoryFiltered(srcDir, destDir);
    count++;
  }

  // Copy package.json
  const pkgSrc = path.join(BACKEND_RUNTIME, 'package.json');
  if (fs.existsSync(pkgSrc)) {
    copyPackagedBackendPackageJson(pkgSrc, path.join(BACKEND_BUILD, 'package.json'));
  }

  buildRustSidecar();
  copySimConnectRuntime();

  // Copy only the exact production package inventory locked for the backend.
  copyLockedBackendNodeModules(path.join(BACKEND_BUILD, 'node_modules'));

  // Rebuild native modules AFTER copying
  rebuildNativeModules();

  log(`Backend copy complete (${count} items)`);
}

/**
 * Copy directory recursively without obfuscation (respects exclude patterns)
 */
function copyDirectoryFiltered(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const relPath = path.relative(BACKEND_RUNTIME, srcPath);

    if (isRustSidecarSourcePath(relPath)) {
      continue;
    }

    // Check exclude patterns (skip test files, etc.)
    if (matchesExcludePattern(relPath)) {
      continue;
    }

    // Skip documentation files (should never ship in release)
    if (isDocumentationFile(entry.name)) {
      continue;
    }

    // Skip runtime cache artifacts
    if (isRuntimeJunkFile(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirectoryFiltered(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function buildRustSidecar() {
  if (!resolvedProfile?.include?.backend_dirs?.includes('telemetry-provider')) {
    return;
  }

  if (!fs.existsSync(RUST_SIDECAR_MANIFEST)) {
    error(`Missing Rust sidecar manifest: ${RUST_SIDECAR_MANIFEST}`);
    process.exit(1);
  }

  try {
    resetRepoScratchDirectory(RUST_SIDECAR_BUILD_TARGET_NAME);
  } catch (err) {
    error(`Failed to prepare an isolated Rust build target: ${err.message}`);
    process.exit(1);
  }

  log('Building Rust SimConnect sidecar in a fresh isolated target...');
  try {
    execFileSync(CARGO_BIN, [
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
    error(`Failed to build Rust SimConnect sidecar: ${err.message}`);
    process.exit(1);
  }

  if (!fs.existsSync(RUST_SIDECAR_BINARY_SRC)) {
    error(`Rust sidecar build completed without producing ${RUST_SIDECAR_BINARY_SRC}`);
    process.exit(1);
  }

  verifyRustSidecarGuardianCapability(RUST_SIDECAR_BINARY_SRC);

  const rustSidecarDest = path.join(BACKEND_BUILD, 'telemetry-provider', RUST_SIDECAR_BINARY_NAME);
  fs.mkdirSync(path.dirname(rustSidecarDest), { recursive: true });
  fs.copyFileSync(RUST_SIDECAR_BINARY_SRC, rustSidecarDest);
  // Runtime builds can stage a verified replacement while a development
  // process owns dist's normal executable. Release packaging has just written
  // its own current main artifact, so never carry that development handoff
  // into backend-build where it could outrank the packaged binary by mtime.
  fs.rmSync(path.join(path.dirname(rustSidecarDest), '.pending'), {
    recursive: true,
    force: true,
  });
  log(`Copied Rust sidecar binary to backend-build/telemetry-provider/${RUST_SIDECAR_BINARY_NAME}`);
}

function verifyRustSidecarGuardianCapability(binaryPath) {
  const result = spawnSync(binaryPath, ['--process-guardian'], {
    cwd: path.dirname(binaryPath),
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error) {
    error(`Rust sidecar guardian capability probe failed: ${result.error.message}`);
    process.exit(1);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 3 || !/process guardian failed:.*requires --ff-owner-pid=/i.test(output)) {
    error(
      'Rust sidecar does not expose the required process guardian contract: '
      + `${output.trim() || `exit ${result.status}`}`
    );
    process.exit(1);
  }
  log('Verified freshly built Rust sidecar process guardian capability.');
}

function normalizeSimConnectDllCandidate(candidate, rootDir = ROOT) {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  let resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(rootDir, trimmed);
  if (path.extname(resolved).toLowerCase() !== '.dll') {
    resolved = path.join(resolved, SIMCONNECT_DLL_NAME);
  }
  return resolved;
}

function getSimConnectDllCandidates({
  rootDir = ROOT,
  backendRuntimeDir = BACKEND_RUNTIME,
  backendSourceDir = BACKEND_SOURCE,
  configuredPath = process.env.FF_SIMCONNECT_DLL_PATH,
  sdkPaths = SIMCONNECT_DEFAULT_SDK_PATHS,
} = {}) {
  return [
    {
      path: path.join(backendSourceDir, SIMCONNECT_DLL_RELATIVE),
      label: 'tracked backend source',
    },
    {
      path: path.join(backendRuntimeDir, SIMCONNECT_DLL_RELATIVE),
      label: 'backend runtime fallback',
    },
    {
      path: normalizeSimConnectDllCandidate(configuredPath, rootDir),
      label: 'FF_SIMCONNECT_DLL_PATH fallback',
    },
    ...sdkPaths.map((candidate) => ({
      path: normalizeSimConnectDllCandidate(candidate, rootDir),
      label: 'installed MSFS SDK fallback',
    })),
  ].filter((candidate) => candidate.path);
}

function selectSimConnectDllSource(options = {}) {
  for (const candidate of getSimConnectDllCandidates(options)) {
    if (!fs.existsSync(candidate.path)) continue;
    const stat = fs.lstatSync(candidate.path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`SimConnect runtime candidate is not a regular file: ${candidate.path}`);
    }
    if (
      normalizedAbsolutePathKey(candidate.path)
      !== normalizedAbsolutePathKey(fs.realpathSync(candidate.path))
    ) {
      throw new Error(`SimConnect runtime candidate is linked or redirected: ${candidate.path}`);
    }
    return candidate;
  }
  return null;
}

function copySimConnectRuntime() {
  if (process.platform !== 'win32') {
    return;
  }

  if (!resolvedProfile?.include?.backend_dirs?.includes('telemetry-provider')) {
    return;
  }

  let source;
  try {
    source = selectSimConnectDllSource();
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
  const dest = path.join(BACKEND_BUILD, SIMCONNECT_DLL_RELATIVE);

  if (!source) {
    error(
      'Missing SimConnect.dll. Official Windows builds must bundle the SimConnect client runtime. '
      + 'Place it at backend/telemetry-provider/simconnect/SimConnect.dll, install the MSFS SDK in a known path, '
      + 'or set FF_SIMCONNECT_DLL_PATH to an absolute SimConnect.dll path.'
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source.path, dest);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  log(
    `Copied SimConnect runtime from ${source.label}: ${source.path} `
    + `(SHA-256 ${sha256})`
  );
}

/**
 * Process directory recursively with obfuscation (respects exclude patterns)
 */
/**
 * Check if path matches profile exclude patterns
 */
function matchesExcludePattern(relPath) {
  for (const pattern of resolvedProfile.exclude_patterns || []) {
    if (matchesPattern(relPath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Step 1b: Build the bundled frontend into frontend-dist/.
 *
 * The Vue migration means raw frontend/index.html can no longer be packaged
 * directly - the browser must load the Vite-built bundle instead.
 */
function buildFrontendBundle() {
  log('Building frontend bundle...');

  try {
    runNpm(['--prefix', 'frontend', 'run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    error('Frontend build failed: ' + err.message);
    process.exit(1);
  }

  const distIndexPath = path.join(FRONTEND_DIST, 'index.html');
  if (!fs.existsSync(distIndexPath)) {
    error(`Missing bundled frontend index: ${distIndexPath}`);
    process.exit(1);
  }

  const html = fs.readFileSync(distIndexPath, 'utf8');
  if (!html.includes('/main.js')) {
    error('Bundled frontend index.html is missing the Vite main.js entry.');
    process.exit(1);
  }
  const retiredEntryFiles = [
    'index-vue.js',
    'index-app.js',
    'index-tabs.js',
    'index-debug.js',
    'index-profiles.js',
    'index-settings.js',
    'index-live-map.js',
    'index-logbook.js',
    'index-timeline.js',
  ];
  const leakedEntryFiles = retiredEntryFiles.filter((entryFile) => html.includes(entryFile));
  if (leakedEntryFiles.length > 0) {
    error(`Bundled frontend index.html still references raw source entry files: ${leakedEntryFiles.join(', ')}`);
    process.exit(1);
  }

  log('Frontend bundle complete.');
}

/**
 * Step 1c: Build Tailwind CSS into frontend-dist/tailwind.css
 *
 * V1 strict-local requirement: the shipped UI must not pull CSS/JS from CDNs.
 */
function buildTailwindCss() {
  log('Building Tailwind CSS (strict-local)...');

  if (!fs.existsSync(TAILWIND_CONFIG)) {
    error(`Missing Tailwind config: ${TAILWIND_CONFIG}`);
    process.exit(1);
  }
  if (!fs.existsSync(TAILWIND_INPUT)) {
    error(`Missing Tailwind input: ${TAILWIND_INPUT}`);
    process.exit(1);
  }

  try {
    execFileSync(
      process.execPath,
      [TAILWIND_CLI, '-c', TAILWIND_CONFIG, '-i', TAILWIND_INPUT, '-o', TAILWIND_OUTPUT, '--minify'],
      {
        cwd: ROOT,
        stdio: 'inherit',
      }
    );
  } catch (err) {
    error('Tailwind CSS build failed: ' + err.message);
    process.exit(1);
  }

  if (!fs.existsSync(TAILWIND_OUTPUT)) {
    error(`Tailwind output missing after build: ${TAILWIND_OUTPUT}`);
    process.exit(1);
  }

  try {
    const { size } = fs.statSync(TAILWIND_OUTPUT);
    if (size < MIN_TAILWIND_BYTES) {
      error(`Tailwind output too small (${size} bytes). This usually means Tailwind content scanning missed the frontend files and purged most styles.`);
      error('Fix: ensure tailwind.config.js `content` globs point at the real frontend sources for the build working directory.');
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to stat Tailwind output: ${err.message}`);
    process.exit(1);
  }

  log('Tailwind CSS build complete.');
}

/**
 * Electron Builder expects to start from a clean output directory.
 * If a prior Flight Fabric instance is still running (or AV has a handle open),
 * electron-builder can fail to clear win-unpacked and you silently ship stale UI assets.
 *
 * Also pre-delete previous portable/installer EXEs to avoid virus-scanner file locks
 * that block electron-builder from overwriting them.
 */
function ensureCleanElectronOutput() {
  const distDir = path.join(ROOT, 'dist', 'electron');
  const unpackedDir = path.join(distDir, 'win-unpacked');
  const failedArtifactRemovals = [];

  const assertSafeOutputDirectory = (dirPath, label) => {
    if (!fs.existsSync(dirPath)) return;
    const stat = fs.lstatSync(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} is not a safe regular directory: ${dirPath}`);
    }
    if (
      normalizedAbsolutePathKey(dirPath)
      !== normalizedAbsolutePathKey(fs.realpathSync(dirPath))
    ) {
      throw new Error(`${label} is a link, junction, or reparse point: ${dirPath}`);
    }
  };

  try {
    assertSafeOutputDirectory(distDir, 'Electron output directory');
    assertSafeOutputDirectory(unpackedDir, 'Electron unpacked output directory');
  } catch (err) {
    error(err.message);
    error('Refusing to clean a redirected Electron output path.');
    process.exit(1);
  }

  // Delete previous build artifacts (installer, portable, blockmap, checksums)
  // to avoid AV file locks and stale integrity metadata surviving a rebuild.
  if (fs.existsSync(distDir)) {
    for (const file of fs.readdirSync(distDir)) {
      if (/\.(exe|blockmap|yml|yaml)$/i.test(file) || /^SHA256SUMS(?:\.txt)?$/i.test(file)) {
        const filePath = path.join(distDir, file);
        try {
          const stat = fs.lstatSync(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('not a regular file');
          }
          if (
            normalizedAbsolutePathKey(filePath)
            !== normalizedAbsolutePathKey(fs.realpathSync(filePath))
          ) {
            throw new Error('link or reparse-point entry');
          }
          fs.unlinkSync(filePath);
          log(`Removed previous artifact: ${file}`);
        } catch (err) {
          failedArtifactRemovals.push(`${file} (${err.code || err.message})`);
        }
      }
    }
  }

  if (failedArtifactRemovals.length > 0) {
    error(`Cannot remove previous Electron artifact(s): ${failedArtifactRemovals.join(', ')}`);
    error('Close any process or virus scanner holding these files and retry. Refusing to risk a stale release artifact.');
    process.exit(1);
  }

  if (!fs.existsSync(unpackedDir)) return;

  log('Cleaning previous Electron output (win-unpacked)...');
  try {
    fs.rmSync(unpackedDir, { recursive: true, force: true });
  } catch (err) {
    error(`Failed to remove ${unpackedDir}: ${err.message}`);
    error('Close any running Flight Fabric EXE and retry. If this persists, delete dist/electron/win-unpacked manually.');
    process.exit(1);
  }
}

/**
 * Step 2: Build Dashboard executable (optional)
 * 
 * Uses PyInstaller to bundle the Streamlit dashboard.
 * Requires: pip install pyinstaller streamlit pandas plotly boto3 folium streamlit-folium
 */
function buildDashboard() {
  if (!withDashboard) {
    log('Skipping dashboard build (use --with-dashboard to enable)');
    return;
  }

  const specFile = path.join(DASHBOARD_DIR, 'flight-dashboard.spec');
  const launcherFile = path.join(DASHBOARD_DIR, 'dashboard_launcher.py');
  
  if (!fs.existsSync(specFile)) {
    error('Dashboard spec file not found: ' + specFile);
    log('Continuing without dashboard...');
    return;
  }

  if (!fs.existsSync(launcherFile)) {
    error('Dashboard launcher not found: ' + launcherFile);
    log('Continuing without dashboard...');
    return;
  }

  log('Building dashboard executable with PyInstaller...');
  
  try {
    // Check PyInstaller is available
    execFileSync(PYINSTALLER_BIN, ['--version'], { stdio: 'pipe' });
  } catch {
    error('PyInstaller not installed. Run: pip install pyinstaller');
    log('Continuing without dashboard...');
    return;
  }

  try {
    execFileSync(PYINSTALLER_BIN, ['--clean', 'flight-dashboard.spec'], {
      cwd: DASHBOARD_DIR,
      stdio: 'inherit',
    });
    
    const exePath = path.join(DASHBOARD_DIST, 'flight-dashboard.exe');
    if (fs.existsSync(exePath)) {
      log('Dashboard executable built: ' + exePath);
    } else {
      error('Dashboard executable not found after build');
    }
  } catch (err) {
    error('Dashboard build failed: ' + err.message);
    log('Continuing without dashboard...');
  }
}

/**
 * Step 3: Install every owned JavaScript dependency tree exactly.
 *
 * Version checks alone cannot detect a locally modified same-version package.
 * Recreate each tree from its committed lockfile before compiling or copying
 * anything into a user release.
 */
function installDependencies() {
  const installs = [
    ['root', ROOT],
    ['backend', BACKEND_SOURCE],
    ['frontend', FRONTEND_SRC],
    ['Electron', ELECTRON_DIR],
  ];

  for (const [label, cwd] of installs) {
    log(`Installing exact ${label} dependencies from package-lock.json...`);
    try {
      runNpm(['ci'], {
        cwd,
        env: {
          ...process.env,
          HUSKY: '0',
        },
        stdio: 'inherit',
      });
    } catch (err) {
      error(`Failed to install ${label} dependencies: ${err.message}`);
      process.exit(1);
    }
  }
}

/**
 * Keep Electron app version aligned with root version.
 * The GitHub release/tag version is derived from the root package.json.
 */
function syncElectronVersion() {
  try {
    const rootPkg = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
    const electronPkg = JSON.parse(fs.readFileSync(ELECTRON_PACKAGE_JSON, 'utf8'));

    const rootVersion = rootPkg.version;
    const electronVersion = electronPkg.version;

    if (!rootVersion) {
      error('Root package.json has no version; cannot sync Electron version');
      process.exit(1);
    }

    if (electronVersion !== rootVersion) {
      electronPkg.version = rootVersion;
      fs.writeFileSync(ELECTRON_PACKAGE_JSON, JSON.stringify(electronPkg, null, 2) + '\n');
      log(`Synced Electron version: ${electronVersion || '(none)'} -> ${rootVersion}`);
    }
  } catch (err) {
    error('Failed to sync Electron version: ' + err.message);
    process.exit(1);
  }
}

/**
 * Step 4: Build with electron-builder
 */
function buildElectron() {
  log('Building Electron app...');
  
  try {
    runNpm(['run', 'build:win'], {
      cwd: ELECTRON_DIR,
      stdio: 'inherit',
    });
    log('Electron build complete!');
  } catch (err) {
    error('Electron build failed: ' + err.message);
    process.exit(1);
  }
}

/**
 * Step 5: Verify build output against release/security rules.
 */
function verifyReleaseOutput() {
  log('Private release verifier is not included in the public source mirror; skipping private release verification.');
}

function logSigningMode() {
  const hasSigningMaterial = !!(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
  if (hasSigningMaterial) {
    log('Code signing: enabled (certificate material detected in environment)');
  } else {
    log('Code signing: not configured (build will be unsigned)');
    log('  Set CSC_LINK / CSC_KEY_PASSWORD (or WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD) for signed releases.');
  }
}

/**
 * Main
 */
async function main() {
  log('=== Flight Fabric Electron Build ===');
  log(`Root: ${ROOT}`);
  log(`Profile: ${profileName}`);
  log(`Options: ${withDashboard ? '--with-dashboard' : ''}`);

  if (profileName === 'user' && skipNativeRebuild) {
    throw new Error('--skip-native-rebuild is not allowed for the user release profile');
  }
  
  loadReleaseProfile();
  // Invalidate prior canonical artifacts before any fallible build step so a
  // failed rebuild cannot leave a stale executable available for summarizing.
  ensureCleanElectronOutput();
  ensureOurAirportsData();
  syncElectronVersion();
  installDependencies();
  buildBackendRuntime();
  await copyBackend();
  buildFrontendBundle();
  buildDashboard();
  logSigningMode();
  buildTailwindCss();
  buildElectron();
  verifyPackagedOurAirportsData();
  verifyPackagedLegalNotices();
  verifyPackagedRustSidecar();
  verifyReleaseOutput();
  
  log('');
  log('=== Build Complete ===');
  log(`Output: ${path.join(ROOT, 'dist', 'electron')}`);
}

if (require.main === module) {
  main().catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = {
  getSimConnectDllCandidates,
  normalizeSimConnectDllCandidate,
  selectSimConnectDllSource,
};
