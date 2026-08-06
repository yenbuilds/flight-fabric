#!/usr/bin/env node

'use strict';

const path = require('path');
const { isPathInside, resolveWithinRoot } = require('./path-guard');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\nPath Guard');

test('isPathInside accepts descendants and rejects sibling prefixes', () => {
  const root = path.resolve('C:/example/root');
  assert(isPathInside(root, path.join(root, 'child', 'file.txt')), 'expected child path to be inside root');
  assert(!isPathInside(root, path.resolve('C:/example/root-sibling/file.txt')), 'sibling prefix must not count as inside root');
});

test('isPathInside can allow exact root equality only when requested', () => {
  const root = path.resolve('C:/example/root');
  assert(!isPathInside(root, root), 'root equality should be rejected by default');
  assert(isPathInside(root, root, { allowEqual: true }), 'root equality should be accepted when allowEqual is true');
});

test('isPathInside handles Windows case variants', () => {
  const root = path.resolve('C:/Example/Root');
  const child = path.join(root, 'Child', 'file.txt');
  if (process.platform === 'win32') {
    assert(isPathInside(root.toUpperCase(), child.toLowerCase()), 'Windows containment must be case-insensitive');
  } else {
    assert(!isPathInside(root.toUpperCase(), child.toLowerCase()), 'non-Windows containment should remain case-sensitive');
  }
});

test('resolveWithinRoot normalizes safe relative paths and blocks traversal', () => {
  const root = path.resolve('C:/example/root');
  const resolved = resolveWithinRoot(root, 'nested/file.txt');
  assert(resolved === path.join(root, 'nested', 'file.txt'), `unexpected resolved path: ${resolved}`);
  assert(resolveWithinRoot(root, '../outside.txt') === null, 'traversal outside root must be rejected');
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);

export {};
