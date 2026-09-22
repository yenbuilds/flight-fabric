import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGroundSkirt, groundCoverageRects } from './ground-coverage.js';

const base = { layer: 'base', minX: 0, maxX: 100, minZ: 0, maxZ: 100 };
const detail = (minX, maxX, minZ, maxZ) => ({ layer: 'detail', minX, maxX, minZ, maxZ });

test('coarse coverage follows the finer geographic footprint and north-facing texture coordinates', () => {
  assert.deepEqual(groundCoverageRects(base, [detail(20, 70, 0, 30)]), [[0.2, 0.7, 0.7, 1]]);
  assert.deepEqual(groundCoverageRects(base, [detail(-25, 25, 75, 125)]), [[0, 0, 0.25, 0.25]]);
  assert.deepEqual(groundCoverageRects(base, [detail(100, 200, 0, 100), base]), [], 'touching and same-resolution tiles cannot mask the surface');
});

test('ready adjacent tiles merge without hiding the gaps left by missing images', () => {
  const quarters = [detail(0, 50, 0, 50), detail(50, 100, 0, 50), detail(0, 50, 50, 100), detail(50, 100, 50, 100)];
  assert.deepEqual(groundCoverageRects(base, quarters), [[0, 0, 1, 1]]);
  const partial = groundCoverageRects(base, quarters.slice(0, 3));
  assert.equal(partial.length, 2);
  assert.equal(partial.some(([u0, v0, u1, v1]) => 0.75 >= u0 && 0.75 <= u1 && 0.25 >= v0 && 0.25 <= v1), false);
  assert.deepEqual(groundCoverageRects(base, []), [], 'removing finer tiles restores the coarse surface');
});

test('a ready base patch subsumes detailed masks on the horizon while leaving distant terrain intact', () => {
  const horizon = { layer: 'horizon', minX: -100, maxX: 300, minZ: -100, maxZ: 300 };
  assert.deepEqual(groundCoverageRects(horizon, [detail(10, 50, 10, 50), base]), [[0.25, 0.5, 0.5, 0.75]]);
  assert.deepEqual(groundCoverageRects(detail(0, 100, 0, 100), [horizon, base]), []);
});

test('edge joins bridge differing heights while leaving shared fine-tile edges alone', () => {
  const mesh = (bounds, height) => ({ position: { y: 0 }, userData: { ...bounds, count: 2, heights: new Float32Array(4).fill(height) } });
  const coarse = mesh({ ...base, maxX: 200 }, 30);
  const left = mesh(detail(0, 100, 0, 100), 10);
  const right = mesh(detail(100, 200, 0, 100), 10);
  const isolated = buildGroundSkirt(left, [left, coarse]);
  assert.equal(isolated.positions.length, 4 * 6 * 3, 'all four exposed edges are joined');
  assert.deepEqual(new Set(isolated.positions.filter((_value, index) => index % 3 === 1)), new Set([10, 30]));
  const adjacent = buildGroundSkirt(left, [left, right, coarse]);
  assert.equal(adjacent.positions.length, 3 * 6 * 3, 'a ready neighbour needs no interior wall');
  assert.equal(buildGroundSkirt(left, [left]), null, 'missing coarse terrain cannot invent an edge height');
});
