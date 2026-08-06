#!/usr/bin/env node
/**
 * test-surface-normalizer.js
 * Regression test: ensure the backend always has a surface object to broadcast
 * (even when providers/frames omit `surface`).
 */

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { normalizeSurface } = require(resolveBackendRuntimeFile('aircraft', 'surface-normalizer.js'));

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertSurfaceShape(surface, { onGround }) {
  assert(surface && typeof surface === 'object', 'surface must be an object');
  assert(Object.prototype.hasOwnProperty.call(surface, 'raw'), 'surface.raw missing');
  assert(Object.prototype.hasOwnProperty.call(surface, 'name'), 'surface.name missing');
  assert(typeof surface.class === 'string', 'surface.class must be string');
  assert(typeof surface.runwayLike === 'boolean', 'surface.runwayLike must be boolean');
  assert(typeof surface.onGround === 'boolean', 'surface.onGround must be boolean');
  assert(typeof surface.valid === 'boolean', 'surface.valid must be boolean');
  assert(surface.onGround === onGround, `surface.onGround expected ${onGround}`);
}

function main() {
  console.log('=== Surface Normalizer Regression Test ===');

  const sAir = normalizeSurface(undefined, false);
  assertSurfaceShape(sAir, { onGround: false });

  const sGnd = normalizeSurface(undefined, true);
  assertSurfaceShape(sGnd, { onGround: true });

  const existing = {
    raw: 18,
    name: 'TARMAC',
    class: 'PAVED',
    runwayLike: true,
    onGround: true,
    valid: true,
  };
  const sExisting = normalizeSurface(existing, false);
  assert(sExisting === existing, 'normalizeSurface should return the original object when provided');

  console.log('✅ PASS');
}

main();
