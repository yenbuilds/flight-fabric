#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'tsconfig.backend.declarations.json');
const result = spawnSync(process.execPath, [
  require.resolve('typescript/bin/tsc'), '-b', configPath, '--force',
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

// tsc emits declarations but leaves files from renamed/deleted modules behind.
// Prune only compiler-owned .d.ts files, and only after a successful build.
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  },
});
if (!config || config.errors.length) throw new Error('Cannot determine declaration source ownership');
const outputRoot = path.resolve(root, 'backend/types/generated');
if (path.resolve(config.options.outDir) !== outputRoot) throw new Error('Unexpected declaration output directory');
const expected = new Set(config.fileNames.filter(file => !file.endsWith('.d.ts')).map(file =>
  path.resolve(outputRoot, path.relative(config.options.rootDir, file).replace(/\.ts$/, '.d.ts'))));
let removed = 0;
function prune(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) prune(file);
    else if (entry.isFile() && entry.name.endsWith('.d.ts') && !expected.has(file)) {
      fs.unlinkSync(file);
      removed += 1;
    }
  }
}
prune(outputRoot);
console.log(`Backend declarations match current source ownership; removed ${removed} obsolete files.`);
