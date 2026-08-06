/**
 * electron-builder afterPack hook.
 *
 * electron-builder v26 strips node_modules from extraResources by default.
 * This hook copies backend-build/node_modules into the packaged output so the
 * backend can resolve its runtime dependencies.
 */

const fs = require('fs');
const path = require('path');
const rcedit = require('rcedit');

const REQUIRED_SHARED_RUNTIME_FILES = [
  'app-settings-shared.js',
  'flight-phases.js',
  'rust-sidecar-artifact.js',
  'violation-rules.js',
];

const RUNTIME_MODULE_EXCLUDED_DIRECTORIES = new Set([
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

const RUNTIME_MODULE_EXCLUDED_FILES = new Set([
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

function isRuntimeLegalNotice(name) {
  return /^(?:copyright|copying|legal|licen[cs]e|notice|third[-_ ]party)(?:$|[._ -])/i.test(name);
}

function isRuntimeTestOrSpecFile(name) {
  return /(?:^|\.)(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(name)
    || /^(?:test|spec)-/i.test(name);
}

function shouldExcludeRuntimeModuleEntry(entry) {
  const lowerName = String(entry?.name || '').toLowerCase();
  if (entry?.isDirectory() && RUNTIME_MODULE_EXCLUDED_DIRECTORIES.has(lowerName)) {
    return true;
  }
  if (!entry?.isFile()) return false;
  if (RUNTIME_MODULE_EXCLUDED_FILES.has(lowerName)) return true;
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
    || isRuntimeTestOrSpecFile(lowerName);
  if (isSourceOrTestArtifact) return true;
  if (isRuntimeLegalNotice(lowerName)) return false;
  return lowerName.endsWith('.md')
    || lowerName.endsWith('.markdown')
    || lowerName.endsWith('.mdx');
}

async function hardenElectronFuses(executablePath) {
  const {
    flipFuses,
    FuseState,
    FuseVersion,
    FuseV1Options,
    getCurrentFuseWire,
  } = await import('@electron/fuses');

  // RunAsNode is intentionally retained: the packaged backend is launched by
  // the Electron executable with ELECTRON_RUN_AS_NODE=1. File privileges are
  // also retained for the local legacy launcher loaded with BrowserWindow.loadFile.
  const fuseConfig = {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    [FuseV1Options.WasmTrapHandlers]: true,
  };

  await flipFuses(executablePath, fuseConfig);

  const actual = await getCurrentFuseWire(executablePath);
  for (const [optionIndex, enabled] of Object.entries(fuseConfig)) {
    if (!/^\d+$/.test(optionIndex)) continue;
    const expectedState = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    if (actual[optionIndex] !== expectedState) {
      throw new Error(
        `[afterPack] Electron fuse verification failed for ${FuseV1Options[optionIndex]}`
      );
    }
  }

  console.log(
    '[afterPack] Hardened Electron fuses '
    + '(Node options/inspect disabled, embedded ASAR integrity enforced, app loads only from ASAR)'
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${filePath}: ${err.message}`);
  }
}

function normalizedPathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertSafeRegularDirectory(dirPath, label) {
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`[afterPack] ${label} is not a regular directory: ${dirPath}`);
  }
  if (normalizedPathKey(dirPath) !== normalizedPathKey(fs.realpathSync(dirPath))) {
    throw new Error(`[afterPack] ${label} is a link, junction, or reparse point: ${dirPath}`);
  }
}

function assertSafeRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`[afterPack] ${label} is not a regular file: ${filePath}`);
  }
  if (normalizedPathKey(filePath) !== normalizedPathKey(fs.realpathSync(filePath))) {
    throw new Error(`[afterPack] ${label} is a link or reparse-point entry: ${filePath}`);
  }
}

function assertSafeCopyDestination(destinationDir, destinationRoot) {
  if (!destinationRoot) {
    throw new Error('[afterPack] Shared runtime destination root is required');
  }
  const resolvedRoot = path.resolve(destinationRoot);
  const resolvedDestination = path.resolve(destinationDir);
  if (!isPathInside(resolvedRoot, resolvedDestination)) {
    throw new Error(
      `[afterPack] Shared runtime destination escapes the packaged app output: ${destinationDir}`
    );
  }

  assertSafeRegularDirectory(resolvedRoot, 'Packaged app output directory');
  const parentRelative = path.relative(resolvedRoot, path.dirname(resolvedDestination));
  let currentParent = resolvedRoot;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    currentParent = path.join(currentParent, segment);
    if (!fs.existsSync(currentParent)) {
      throw new Error(`[afterPack] Shared runtime destination parent is missing: ${currentParent}`);
    }
    assertSafeRegularDirectory(currentParent, 'Shared runtime destination parent');
  }

  if (fs.existsSync(resolvedDestination)) {
    assertSafeRegularDirectory(resolvedDestination, 'Shared runtime destination');
  }
}

function copyDirSync(src, dest, sourceRoot = src) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const realSourceRoot = fs.realpathSync(sourceRoot);
  if (normalizedPathKey(resolvedSourceRoot) !== normalizedPathKey(realSourceRoot)) {
    throw new Error(`[afterPack] Backend dependency root is a link or reparse point: ${sourceRoot}`);
  }

  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldExcludeRuntimeModuleEntry(entry)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const stat = fs.lstatSync(srcPath);
    const realSourcePath = fs.realpathSync(srcPath);
    if (
      stat.isSymbolicLink()
      || normalizedPathKey(srcPath) !== normalizedPathKey(realSourcePath)
      || !isPathInside(realSourceRoot, realSourcePath)
    ) {
      throw new Error(
        `[afterPack] Backend dependency contains a link or reparse-point entry: ${srcPath}`
      );
    }
    if (stat.isDirectory()) {
      copyDirSync(srcPath, destPath, resolvedSourceRoot);
    } else if (stat.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    } else {
      throw new Error(`[afterPack] Backend dependency contains a non-regular entry: ${srcPath}`);
    }
  }
}

function packagePathParts(packageName) {
  return String(packageName || '').split('/').filter(Boolean);
}

function packageJsonPath(modulesRoot, packageName) {
  return path.join(modulesRoot, ...packagePathParts(packageName), 'package.json');
}

function moduleExists(modulesRoot, packageName) {
  return fs.existsSync(packageJsonPath(modulesRoot, packageName));
}

function getRuntimeDependencyNames(packageJsonPath, modulesRoot) {
  const packageJson = readJsonFile(packageJsonPath);
  const required = Object.keys(packageJson.dependencies || {}).sort();
  const optionalInstalled = Object.keys(packageJson.optionalDependencies || {})
    .filter((packageName) => moduleExists(modulesRoot, packageName))
    .sort();

  return { optionalInstalled, required };
}

function assertRuntimeModules({ label, modulesRoot, packageJsonPath }) {
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`[afterPack] Missing backend runtime package.json at ${packageJsonPath}`);
  }
  if (!fs.existsSync(modulesRoot)) {
    throw new Error(`[afterPack] Missing backend runtime node_modules at ${modulesRoot}`);
  }

  const { optionalInstalled, required } = getRuntimeDependencyNames(packageJsonPath, modulesRoot);
  const missingRequired = required.filter((packageName) => !moduleExists(modulesRoot, packageName));
  if (missingRequired.length > 0) {
    throw new Error(`[afterPack] ${label} missing required backend runtime dependencies: ${missingRequired.join(', ')}`);
  }

  return { optionalInstalled, required };
}

function copySharedRuntimeAssets(sourceDir, destinationDir, destinationRoot) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`[afterPack] Missing compiled shared runtime directory: ${sourceDir}`);
  }

  assertSafeRegularDirectory(sourceDir, 'Compiled shared runtime directory');
  assertSafeCopyDestination(destinationDir, destinationRoot);

  const missingSourceFiles = REQUIRED_SHARED_RUNTIME_FILES.filter((fileName) => {
    const filePath = path.join(sourceDir, fileName);
    if (!fs.existsSync(filePath)) return true;
    assertSafeRegularFile(filePath, 'Required compiled shared runtime file');
    return false;
  });
  if (missingSourceFiles.length > 0) {
    throw new Error(
      `[afterPack] Compiled shared runtime is incomplete: ${missingSourceFiles.join(', ')}`
    );
  }

  // Do this explicitly in afterPack. A source beneath the configured output
  // tree can be skipped by electron-builder's extraResources staging, which
  // previously made upgrades work only when resources/shared survived from an
  // older installation.
  fs.mkdirSync(destinationDir, { recursive: true });
  assertSafeRegularDirectory(destinationDir, 'Shared runtime destination');
  for (const fileName of REQUIRED_SHARED_RUNTIME_FILES) {
    const sourcePath = path.join(sourceDir, fileName);
    const destinationPath = path.join(destinationDir, fileName);
    if (fs.existsSync(destinationPath)) {
      assertSafeRegularFile(destinationPath, 'Existing packaged shared runtime file');
    }
    fs.copyFileSync(sourcePath, destinationPath);
  }

  const missingPackagedFiles = REQUIRED_SHARED_RUNTIME_FILES.filter((fileName) => {
    const filePath = path.join(destinationDir, fileName);
    if (!fs.existsSync(filePath)) return true;
    assertSafeRegularFile(filePath, 'Required packaged shared runtime file');
    return false;
  });
  if (missingPackagedFiles.length > 0) {
    throw new Error(
      `[afterPack] Packaged shared runtime is incomplete: ${missingPackagedFiles.join(', ')}`
    );
  }
}

async function finalizeWindowsExecutables(context) {
  if (context.electronPlatformName !== 'win32') return;

  const productFilename = context.packager?.appInfo?.productFilename;
  if (!productFilename) {
    throw new Error('[afterPack] Could not resolve the packaged Windows executable name');
  }

  const executablePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(__dirname, 'taskbar-icon.ico');
  if (!fs.existsSync(executablePath)) {
    throw new Error(`[afterPack] Packaged Windows executable is missing: ${executablePath}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`[afterPack] Windows icon is missing: ${iconPath}`);
  }

  const appInfo = context.packager?.appInfo || {};
  const productName = appInfo.productName || 'Flight Fabric';
  const version = appInfo.version || '0.0.0';
  const originalFilename = `${productFilename}.exe`;

  await rcedit(executablePath, {
    icon: iconPath,
    'file-version': version,
    'product-version': version,
    'version-string': {
      CompanyName: 'Flight Fabric',
      FileDescription: productName,
      InternalName: productFilename,
      OriginalFilename: originalFilename,
      ProductName: productName,
    },
  });
  console.log(`[afterPack] Applied app icon and Windows metadata to ${path.basename(executablePath)}`);

  await hardenElectronFuses(executablePath);

  if (typeof context.packager?.signIf !== 'function') {
    throw new Error('[afterPack] Windows packager does not expose the expected signing hook');
  }

  const rustSidecarPath = path.join(
    context.appOutDir,
    'resources',
    'backend',
    'telemetry-provider',
    'ff-rust-simconnect-sidecar.exe'
  );
  if (!fs.existsSync(rustSidecarPath)) {
    throw new Error(`[afterPack] Packaged Rust sidecar is missing: ${rustSidecarPath}`);
  }

  for (const ownedExecutable of [executablePath, rustSidecarPath]) {
    const signed = await context.packager.signIf(ownedExecutable);
    console.log(
      `[afterPack] ${signed ? 'Signed' : 'Code signing not configured for'} ${path.basename(ownedExecutable)}`
    );
  }
}

async function afterPack(context) {
  const backendPackageSrc = path.resolve(__dirname, '..', 'backend-build', 'package.json');
  const backendModulesSrc = path.resolve(__dirname, '..', 'backend-build', 'node_modules');
  const sharedRuntimeSrc = path.resolve(__dirname, '..', 'dist', 'shared');
  const backendPackageDest = path.join(context.appOutDir, 'resources', 'backend', 'package.json');
  const backendModulesDest = path.join(context.appOutDir, 'resources', 'backend', 'node_modules');
  const sharedRuntimeDest = path.join(context.appOutDir, 'resources', 'shared');

  const sourceDeps = assertRuntimeModules({
    label: 'backend-build',
    modulesRoot: backendModulesSrc,
    packageJsonPath: backendPackageSrc,
  });

  console.log(`[afterPack] Copying backend node_modules -> ${backendModulesDest}`);
  fs.rmSync(backendModulesDest, { recursive: true, force: true });
  copyDirSync(backendModulesSrc, backendModulesDest);

  const packagedDeps = assertRuntimeModules({
    label: 'packaged backend',
    modulesRoot: backendModulesDest,
    packageJsonPath: backendPackageDest,
  });

  const missingCopiedOptional = sourceDeps.optionalInstalled.filter((packageName) => !moduleExists(backendModulesDest, packageName));
  if (missingCopiedOptional.length > 0) {
    throw new Error(`[afterPack] packaged backend lost optional dependencies present in backend-build: ${missingCopiedOptional.join(', ')}`);
  }

  const count = fs.readdirSync(backendModulesDest).length;
  console.log(
    `[afterPack] Copied ${count} entries into backend/node_modules `
    + `(${packagedDeps.required.length} required, ${sourceDeps.optionalInstalled.length} optional installed)`
  );

  console.log(`[afterPack] Copying compiled shared runtime -> ${sharedRuntimeDest}`);
  copySharedRuntimeAssets(sharedRuntimeSrc, sharedRuntimeDest, context.appOutDir);
  console.log(
    `[afterPack] Copied ${REQUIRED_SHARED_RUNTIME_FILES.length} required shared runtime files`
  );

  await finalizeWindowsExecutables(context);
}

module.exports = afterPack;
module.exports.copySharedRuntimeAssets = copySharedRuntimeAssets;
module.exports.isRuntimeLegalNotice = isRuntimeLegalNotice;
module.exports.shouldExcludeRuntimeModuleEntry = shouldExcludeRuntimeModuleEntry;
