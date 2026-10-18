'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const ts = require('typescript');

// Tooling evaluates current TypeScript sources in memory without changing dist
// or compiling the native runtime. Relative runtime .js imports must resolve
// to TypeScript sources; a compiled file cannot silently fill a missing source.
function loadTypeScriptCommonJs(filePath, modules = new Map()) {
  filePath = path.resolve(filePath);
  if (modules.has(filePath)) return modules.get(filePath).exports;
  const source = fs.readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const sourceModule = { exports: {} };
  const sourceRequire = createRequire(filePath);
  modules.set(filePath, sourceModule);
  try {
    const requireDependency = (specifier) => {
      if (specifier.startsWith('.') && (specifier.endsWith('.js') || path.extname(specifier) === '')) {
        const sourcePath = path.resolve(path.dirname(filePath), specifier.replace(/\.js$/, ''));
        const sourceFile = `${sourcePath}.ts`;
        return loadTypeScriptCommonJs(fs.existsSync(sourceFile) ? sourceFile : path.join(sourcePath, 'index.ts'), modules);
      }
      return sourceRequire(specifier);
    };
    compileFunction(output, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: filePath })(
      sourceModule.exports, requireDependency, sourceModule, filePath, path.dirname(filePath),
    );
    return sourceModule.exports;
  } catch (error) {
    modules.delete(filePath);
    throw error;
  }
}

module.exports = { loadTypeScriptCommonJs };
