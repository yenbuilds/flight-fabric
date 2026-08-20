#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_ROOT = path.join(ROOT, 'backend');
const RUST_ROOT = path.join(BACKEND_ROOT, 'telemetry-provider', 'rust-simconnect-sidecar', 'src');

// This is deliberately a closed-world inventory, not a list of banned APIs. Every
// production filesystem call must be attributed to a reviewed storage boundary.
// A new file, primitive, or call site fails until this manifest is consciously
// reviewed and updated alongside its boundary tests.
const EXPECTED_FS_BOUNDARIES = [
  ['backend/aircraft/aircraft-profile-loader.ts', 'release-owned-content', 'existsSync=5,lstatSync=1,readFileSync=2,readdirSync=3,statSync=1'],
  ['backend/aircraft/aircraft-profile-registry.ts', 'release-owned-content', 'existsSync=1,readFileSync=4,readdirSync=1'],
  ['backend/core/destination-target-store.ts', 'guarded-settings', 'existsSync=1,readFileSync=1'],
  ['backend/core/http-server.ts', 'validated-static-assets', 'close=2,createReadStream=1,existsSync=2,fstat=1,lstatSync=2,open=1,readFile=1,realpathSync=2'],
  ['backend/core/user-settings.ts', 'guarded-settings', 'existsSync=2,readFileSync=1'],
  ['backend/events/timeline-csv-helpers.ts', 'recording-storage', 'promises.lstat=1'],
  ['backend/events/timeline-events.ts', 'recording-storage', 'existsSync=1,mkdirSync=1'],
  ['backend/events/timeline-generator.ts', 'recording-storage', 'closeSync=7,existsSync=8,fstatSync=1,lstatSync=9,openSync=3,readFileSync=3,readSync=4,readdirSync=3,renameSync=1,rmdirSync=1,statSync=1'],
  ['backend/flight-recording/aircraft-specific-jsonl-reader.ts', 'recording-storage', 'promises.lstat=1,promises.open=1'],
  ['backend/flight-recording/aircraft-specific-jsonl-recorder.ts', 'recording-storage', 'closeSync=1,createWriteStream=1,existsSync=3,fdatasync=1,fdatasyncSync=1,fstatSync=2,lstatSync=1,openSync=1,rmdirSync=1,statSync=2,unlinkSync=1,writeFileSync=1'],
  ['backend/flight-recording/automation-jsonl-reader.ts', 'recording-storage', 'promises.lstat=1,promises.open=1'],
  ['backend/flight-recording/automation-jsonl-recorder.ts', 'recording-storage', 'closeSync=1,createWriteStream=1,existsSync=1,fdatasync=1,fdatasyncSync=1,fstatSync=1,lstatSync=1,openSync=1,rmdirSync=1,statSync=1,unlinkSync=1,writeFileSync=1'],
  ['backend/flight-recording/csv-line-writer-worker.ts', 'recording-storage', 'closeSync=1,createWriteStream=1,existsSync=1,fdatasync=2,fdatasyncSync=2,fstatSync=1,openSync=1,statSync=1,writeSync=1'],
  ['backend/flight-recording/flat-flight-log-migration.ts', 'recording-storage', 'closeSync=2,copyFileSync=1,existsSync=11,fstatSync=1,lstatSync=5,mkdirSync=1,openSync=2,readFileSync=2,readSync=2,readdirSync=2,renameSync=1,rmdirSync=1,statSync=1,unlinkSync=2'],
  ['backend/flight-recording/flight-csv-writer.ts', 'recording-storage', 'closeSync=2,createWriteStream=1,existsSync=4,fdatasync=1,fdatasyncSync=1,fstatSync=2,lstatSync=3,openSync=2,readFileSync=1,rmdirSync=1,statSync=4,unlinkSync=2,writeSync=1'],
  ['backend/flight-recording/flight-analysis-rescore-sidecar.ts', 'recording-storage', 'closeSync=1,fstatSync=2,lstatSync=5,openSync=1,readSync=1'],
  ['backend/flight-recording/read-flight-summary.ts', 'recording-storage', 'readFileSync=1,statSync=1'],
  ['backend/flight-recording/recording-bundle-layout.ts', 'recording-storage', 'existsSync=2,lstatSync=2,readdirSync=1'],
  ['backend/flight-recording/recording-bundle-lease.ts', 'recording-storage', 'closeSync=3,existsSync=1,fdatasyncSync=1,fstatSync=2,futimesSync=1,linkSync=1,lstatSync=2,mkdirSync=1,openSync=2,readSync=1,readdirSync=1,unlinkSync=2,writeSync=1'],
  ['backend/flight-recording/recording-bundle-lifecycle.ts', 'recording-storage', 'existsSync=5,linkSync=2,lstatSync=3,readdirSync=2,rmdirSync=1,unlinkSync=5'],
  ['backend/flight-recording/recording-bundle-status.ts', 'recording-storage', 'closeSync=6,existsSync=2,fstatSync=6,fsyncSync=2,linkSync=1,lstatSync=10,openSync=5,promises.lstat=2,promises.open=2,readSync=3,unlinkSync=1,writeSync=1'],
  ['backend/flight-recording/recording-disk-guard.ts', 'recording-storage', 'statfs=1,statfsSync=1'],
  ['backend/flight-recording/recording-path-guard.ts', 'recording-storage', 'closeSync=1,createWriteStream=2,existsSync=1,linkSync=1,lstatSync=1,openSync=1,unlinkSync=2'],
  ['backend/flight-recording/recording-stream-durability.ts', 'recording-storage', 'fdatasync=1'],
  ['backend/history-index/history-index-coordinator.ts', 'recording-storage', 'lstatSync=1'],
  ['backend/history-index/history-summary-sidecar.ts', 'recording-storage', 'closeSync=1,fstatSync=1,lstatSync=3,openSync=1,readFileSync=1,readSync=1'],
  ['backend/history-index/sqlite-runtime.ts', 'recording-storage', 'existsSync=6,renameSync=2'],
  ['backend/landing/flight-logbook.ts', 'recording-storage', 'existsSync=1,lstatSync=3,promises.open=1,promises.readFile=1,readFileSync=1'],
  ['backend/landing/ourairports-csv-cache.ts', 'release-owned-content', 'existsSync=1,readFileSync=1'],
  ['backend/stability/stability-debug-logger.ts', 'guarded-diagnostics', 'createWriteStream=2,existsSync=1,mkdirSync=1,renameSync=1,statSync=1'],
  ['backend/telemetry-provider/lvar-sidecar-bridge.ts', 'release-owned-runtime', 'existsSync=1,readFileSync=1'],
  ['backend/telemetry-provider/rust-simvar-bridge.ts', 'release-owned-runtime', 'existsSync=1,readFileSync=1'],
  ['backend/telemetry-provider/sdk-adapters/rust-clientdata-launch.ts', 'release-owned-runtime', 'existsSync=1'],
  ['backend/telemetry-provider/sdk-bridge.ts', 'validated-connectors', 'readFileSync=1'],
  ['backend/telemetry-provider/sdk-connector-store.ts', 'validated-connectors', 'existsSync=2,readFileSync=1,readdirSync=1,statSync=1'],
  ['backend/telemetry-provider/sidecar-process-ownership.ts', 'release-owned-runtime', 'existsSync=1,readFileSync=3,readdirSync=1,unlinkSync=1,writeFileSync=1'],
  ['backend/utils/bounded-utf8-record-reader.ts', 'recording-storage', 'promises.open=1'],
  ['backend/utils/flight-logs-dir.ts', 'recording-storage', 'existsSync=1,lstatSync=1'],
  ['backend/utils/helpers.ts', 'recording-storage', 'statSync=1,statfs=1'],
  ['backend/utils/managed-install-state.ts', 'guarded-settings', 'existsSync=2,readFileSync=2'],
  ['backend/utils/safe-fs.ts', 'safety-primitive', 'closeSync=2,copyFileSync=1,existsSync=6,fsyncSync=1,lstatSync=5,openSync=1,realpathSync=1,renameSync=1,unlinkSync=1,writeFileSync=2'],
  ['backend/utils/storage-paths.ts', 'guarded-settings', 'existsSync=1,mkdirSync=1,readdirSync=1,statSync=2'],
  ['backend/utils/user-identity.ts', 'guarded-settings', 'existsSync=1,readFileSync=1'],
  ['electron/main.js', 'desktop-runtime', 'appendFileSync=2,close=3,closeSync=1,createReadStream=1,existsSync=23,fstat=1,lstatSync=2,mkdirSync=2,open=1,openSync=1,readFile=1,readSync=1,realpathSync=2,statSync=3,writeFileSync=2'],
  ['electron/settings-store.js', 'guarded-settings', 'existsSync=3,readFileSync=1'],
];

const EXPECTED_NATIVE_WRITES = {
  'backend/telemetry-provider/rust-simconnect-sidecar/src/main.rs': {
    camera_set_relative_6dof: 1,
    set_client_data: 1,
    set_data_on_sim_object: 4,
    // The normal single-parameter path and the reviewed EX1-unavailable
    // fallback are separate native call sites.
    transmit_client_event: 2,
  },
};

function walkFiles(root, predicate) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(absolute, predicate));
    } else if (entry.isFile() && predicate(absolute)) {
      result.push(absolute);
    }
  }
  return result;
}

function repoPath(absolute) {
  return path.relative(ROOT, absolute).replaceAll(path.sep, '/');
}

function parseCounts(spec) {
  const counts = {};
  for (const item of spec.split(',')) {
    const [method, countText] = item.split('=');
    counts[method] = Number(countText);
  }
  return counts;
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function fsModuleNameFromCall(node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return null;
  const argument = node.arguments[0];
  if (!ts.isStringLiteral(argument)) return null;
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    return /^(?:node:)?fs(?:\/promises)?$/.test(argument.text) ? argument.text : null;
  }
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return /^(?:node:)?fs(?:\/promises)?$/.test(argument.text) ? argument.text : null;
  }
  return null;
}

function getFsPropertyPath(node) {
  const properties = [];
  let current = unwrapExpression(node);
  while (ts.isPropertyAccessExpression(current)) {
    properties.unshift(current.name.text);
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) && current.text === 'fs' ? properties : null;
}

function isWrappedCallCallee(node) {
  let current = node;
  let parent = current.parent;
  while (
    parent
    && (
      ts.isAsExpression(parent)
      || ts.isParenthesizedExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent)
    )
  ) {
    current = parent;
    parent = current.parent;
  }
  return Boolean(parent && ts.isCallExpression(parent) && parent.expression === current);
}

function isAllowedNonCallFsAccess(node, propertyPath) {
  const parent = node.parent;
  if (propertyPath.length === 1 && ['constants', 'promises'].includes(propertyPath[0])) {
    return ts.isPropertyAccessExpression(parent) && parent.expression === node;
  }
  if (propertyPath[0] === 'constants') return true;
  if (parent && ts.isTypeOfExpression(parent)) return true;
  if (propertyPath.length === 1 && propertyPath[0] === 'realpathSync') {
    let wrapped = node;
    let wrapperParent = wrapped.parent;
    while (
      wrapperParent
      && (
        ts.isAsExpression(wrapperParent)
        || ts.isParenthesizedExpression(wrapperParent)
        || ts.isNonNullExpression(wrapperParent)
        || ts.isSatisfiesExpression(wrapperParent)
      )
    ) {
      wrapped = wrapperParent;
      wrapperParent = wrapped.parent;
    }
    if (
      wrapperParent
      && ts.isPropertyAccessExpression(wrapperParent)
      && wrapperParent.expression === wrapped
      && wrapperParent.name.text === 'native'
    ) {
      return true;
    }
  }
  if (propertyPath.length === 2 && propertyPath[1] === 'native') return true;
  return false;
}

function collectFilesystemInventory() {
  const sourceFiles = walkFiles(BACKEND_ROOT, (file) => {
    const normalized = repoPath(file);
    return /\.(?:ts|js)$/.test(file)
      && !/\.(?:test|spec)\.(?:ts|js)$/.test(file)
      && !normalized.includes('/node_modules/')
      && !normalized.includes('/dist/');
  });
  sourceFiles.push(path.join(ROOT, 'electron', 'main.js'));
  sourceFiles.push(path.join(ROOT, 'electron', 'settings-store.js'));

  const inventory = {};
  for (const file of sourceFiles.sort()) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const moduleLoads = [];
    let canonicalBindings = 0;
    const calls = {};
    const unsupportedAccesses = [];

    function visit(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (/^(?:node:)?fs(?:\/promises)?$/.test(node.moduleSpecifier.text)) {
          moduleLoads.push(node.moduleSpecifier.text);
        }
      }
      if (
        ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression
        && ts.isStringLiteral(node.moduleReference.expression)
        && /^(?:node:)?fs(?:\/promises)?$/.test(node.moduleReference.expression.text)
      ) {
        moduleLoads.push(node.moduleReference.expression.text);
      }
      if (ts.isCallExpression(node)) {
        const moduleName = fsModuleNameFromCall(node);
        if (moduleName) moduleLoads.push(moduleName);

        const propertyPath = getFsPropertyPath(node.expression);
        if (propertyPath) {
          if (propertyPath.length === 1) {
            increment(calls, propertyPath[0]);
          } else if (propertyPath.length === 2 && propertyPath[0] === 'promises') {
            increment(calls, `promises.${propertyPath[1]}`);
          } else {
            unsupportedAccesses.push(node.expression.getText(sourceFile));
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'fs' && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (fsModuleNameFromCall(initializer) && !fsModuleNameFromCall(initializer).endsWith('/promises')) {
          canonicalBindings += 1;
        }
      }
      if (ts.isElementAccessExpression(node)) {
        const expressionPath = getFsPropertyPath(node.expression);
        if (
          (ts.isIdentifier(unwrapExpression(node.expression)) && unwrapExpression(node.expression).text === 'fs')
          || expressionPath
        ) {
          unsupportedAccesses.push(node.getText(sourceFile));
        }
      }
      if (ts.isPropertyAccessExpression(node)) {
        const propertyPath = getFsPropertyPath(node);
        if (
          propertyPath
          && !isWrappedCallCallee(node)
          && !isAllowedNonCallFsAccess(node, propertyPath)
        ) {
          unsupportedAccesses.push(node.getText(sourceFile));
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    if (moduleLoads.length === 0) continue;

    assert.deepStrictEqual(
      moduleLoads,
      [moduleLoads[0]],
      `${repoPath(file)} must have exactly one auditable filesystem module load`,
    );
    assert.ok(
      moduleLoads[0] === 'fs' || moduleLoads[0] === 'node:fs',
      `${repoPath(file)} must not bypass the inventory through fs/promises`,
    );
    assert.equal(
      canonicalBindings,
      1,
      `${repoPath(file)} must bind the filesystem module once to the audited fs identifier`,
    );
    assert.deepStrictEqual(
      unsupportedAccesses,
      [],
      `${repoPath(file)} must call inventoried fs methods directly instead of aliasing or computing them`,
    );
    assert.ok(Object.keys(calls).length > 0, `${repoPath(file)} loads fs but has no inventoried calls`);
    inventory[repoPath(file)] = calls;
  }
  return inventory;
}

function collectNativeWriteInventory() {
  const inventory = {};
  for (const file of walkFiles(RUST_ROOT, (candidate) => candidate.endsWith('.rs'))) {
    const source = fs.readFileSync(file, 'utf8');
    const calls = {};
    for (const match of source.matchAll(/\b(?:self\.)?api\.((?:set|transmit|camera_set)_[A-Za-z0-9_]+)\s*\)?\s*\(/g)) {
      increment(calls, match[1]);
    }
    if (Object.keys(calls).length > 0) inventory[repoPath(file)] = calls;
  }
  return inventory;
}

function main() {
  const expectedFs = Object.fromEntries(
    EXPECTED_FS_BOUNDARIES.map(([file, boundary, counts]) => {
      assert.ok(boundary, `${file} must name its reviewed storage boundary`);
      return [file, parseCounts(counts)];
    }),
  );

  assert.deepStrictEqual(
    collectFilesystemInventory(),
    expectedFs,
    'production filesystem boundary inventory drifted; review the call site and its guards before updating the manifest',
  );
  assert.deepStrictEqual(
    collectNativeWriteInventory(),
    EXPECTED_NATIVE_WRITES,
    'native simulator write inventory drifted; route and validate the new write before updating the manifest',
  );

  const loaderSource = fs.readFileSync(
    path.join(BACKEND_ROOT, 'aircraft', 'aircraft-profile-loader.ts'),
    'utf8',
  );
  for (const retiredOperation of ['importProfile', 'copyProfileToLocal', 'deleteUserProfile']) {
    assert.equal(
      loaderSource.includes(retiredOperation),
      false,
      `release-owned aircraft loader must not expose ${retiredOperation}`,
    );
  }

  console.log(
    `I/O boundary inventory verified: ${Object.keys(expectedFs).length} filesystem consumers; `
      + `${Object.values(EXPECTED_NATIVE_WRITES).reduce((sum, calls) => sum + Object.values(calls).reduce((a, b) => a + b, 0), 0)} native write sites.`,
  );
}

main();
