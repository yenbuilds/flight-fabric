#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./backend-runtime-paths');

function normalizeRepoRelative(filePath) {
  return filePath.split(path.sep).join('/');
}

function resolveRepoSourcePath(relativePath) {
  const resolvedPath = path.join(ROOT, relativePath);
  if (resolvedPath.endsWith('.js')) {
    const tsSibling = resolvedPath.slice(0, -3) + '.ts';
    if (fs.existsSync(tsSibling)) return tsSibling;
  }
  return resolvedPath;
}

function readRepoSource(relativePath, encoding = 'utf8') {
  return fs.readFileSync(resolveRepoSourcePath(relativePath), encoding);
}

function listRepoSourceFiles(relativeDir, options = {}) {
  const extensions = new Set(options.extensions || ['.js', '.ts']);
  const shouldExclude = typeof options.exclude === 'function'
    ? options.exclude
    : () => false;
  const results = [];
  const rootDir = path.join(ROOT, relativeDir);

  function visit(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relPath = normalizeRepoRelative(path.relative(ROOT, fullPath));
      if (shouldExclude(relPath, fullPath, entry)) continue;

      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (fullPath.endsWith('.ts')) {
        if (extensions.has('.ts')) results.push(fullPath);
        continue;
      }

      if (fullPath.endsWith('.js')) {
        const tsSibling = fullPath.slice(0, -3) + '.ts';
        if (fs.existsSync(tsSibling)) continue;
        if (extensions.has('.js')) results.push(fullPath);
      }
    }
  }

  if (fs.existsSync(rootDir)) {
    visit(rootDir);
  }

  return results;
}

module.exports = {
  ROOT,
  listRepoSourceFiles,
  normalizeRepoRelative,
  readRepoSource,
  resolveRepoSourcePath,
};
