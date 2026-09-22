// Coarse and fine elevation meshes need not agree on height. Hide the coarse
// surface inside the geographic footprint of ready, finer tiles; render order
// and polygon offsets cannot resolve surfaces separated by metres.
export const GROUND_LAYER_PRIORITY = Object.freeze({ detail: 3, base: 2, horizon: 1 });
// The planner allows 48 base + 64 detail tiles above the horizon layer.
const MAX_COVERAGE_RECTS = 112;
const EPSILON = 1e-9;

const contains = (a, b) => a[0] <= b[0] + EPSILON && a[1] <= b[1] + EPSILON
  && a[2] >= b[2] - EPSILON && a[3] >= b[3] - EPSILON;
const same = (a, b) => Math.abs(a - b) < EPSILON;

export function groundCoverageRects(tile, readyTiles) {
  const width = tile.maxX - tile.minX;
  const depth = tile.maxZ - tile.minZ;
  if (!(width > 0 && depth > 0)) return [];
  const rects = [];
  for (const finer of readyTiles) {
    if (!(GROUND_LAYER_PRIORITY[finer.layer] > GROUND_LAYER_PRIORITY[tile.layer])) continue;
    const minX = Math.max(tile.minX, finer.minX);
    const maxX = Math.min(tile.maxX, finer.maxX);
    const minZ = Math.max(tile.minZ, finer.minZ);
    const maxZ = Math.min(tile.maxZ, finer.maxZ);
    if (!(minX < maxX && minZ < maxZ)) continue;
    // PlaneGeometry's texture v=1 is the north edge (the smallest scene z).
    const rect = [(minX - tile.minX) / width, 1 - ((maxZ - tile.minZ) / depth),
      (maxX - tile.minX) / width, 1 - ((minZ - tile.minZ) / depth)];
    if (rects.some(other => contains(other, rect))) continue;
    for (let index = rects.length - 1; index >= 0; index -= 1) {
      if (contains(rect, rects[index])) rects.splice(index, 1);
    }
    rects.push(rect);
  }
  // Completed rectangular tile patches normally become one shader check.
  // Merge only complete rows/columns, preserving gaps while images load.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const left = rects[a];
        const right = rects[b];
        const row = same(left[1], right[1]) && same(left[3], right[3]) && left[0] <= right[2] + EPSILON && right[0] <= left[2] + EPSILON;
        const column = same(left[0], right[0]) && same(left[2], right[2]) && left[1] <= right[3] + EPSILON && right[1] <= left[3] + EPSILON;
        if (!row && !column) continue;
        rects[a] = [Math.min(left[0], right[0]), Math.min(left[1], right[1]), Math.max(left[2], right[2]), Math.max(left[3], right[3])];
        rects.splice(b, 1);
        merged = true;
        break outer;
      }
    }
  }
  return rects;
}

export function createGroundCoverageMask(material) {
  const uniforms = {
    ffGroundCoverageCount: { value: 0 },
    ffGroundCoverage: { value: new Float32Array(MAX_COVERAGE_RECTS * 4) },
  };
  // Fixed capacity keeps one shader program as tiles arrive and leave.
  material.customProgramCacheKey = () => 'flightfabric-ground-coverage-v1';
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `varying vec2 ffGroundUv;\n${shader.vertexShader}`
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nffGroundUv = uv;');
    shader.fragmentShader = `varying vec2 ffGroundUv;
uniform int ffGroundCoverageCount;
uniform vec4 ffGroundCoverage[${MAX_COVERAGE_RECTS}];
${shader.fragmentShader}`.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
for (int i = 0; i < ${MAX_COVERAGE_RECTS}; i++) {
  if (i >= ffGroundCoverageCount) break;
  vec4 area = ffGroundCoverage[i];
  if (all(greaterThanEqual(ffGroundUv, area.xy)) && all(lessThanEqual(ffGroundUv, area.zw))) discard;
}`);
  };
  return rects => {
    if (rects.length > MAX_COVERAGE_RECTS) throw new Error('Ground coverage exceeds the tile planning limit');
    uniforms.ffGroundCoverageCount.value = rects.length;
    rects.forEach((rect, index) => uniforms.ffGroundCoverage.value.set(rect, index * 4));
  };
}

export function sampleGroundTileHeight(mesh, x, z) {
  const data = mesh.userData;
  const segments = data.count - 1;
  const u = ((x - data.minX) / (data.maxX - data.minX)) * segments;
  const v = ((z - data.minZ) / (data.maxZ - data.minZ)) * segments;
  const column = Math.max(0, Math.min(segments - 1, Math.floor(u)));
  const row = Math.max(0, Math.min(segments - 1, Math.floor(v)));
  const fx = Math.max(0, Math.min(1, u - column));
  const fz = Math.max(0, Math.min(1, v - row));
  const top = (data.heights[(row * data.count) + column] * (1 - fx)) + (data.heights[(row * data.count) + column + 1] * fx);
  const bottom = (data.heights[((row + 1) * data.count) + column] * (1 - fx)) + (data.heights[((row + 1) * data.count) + column + 1] * fx);
  return mesh.position.y + (top * (1 - fz)) + (bottom * fz);
}

// Join exposed fine-tile edges to the underlying coarse surface. Without
// these side faces, height disagreement would leave cracks at the cutout.
export function buildGroundSkirt(mesh, readyMeshes) {
  const data = mesh.userData;
  if (!data.heights || data.layer === 'horizon') return null;
  const positions = [];
  const uvs = [];
  const segments = data.count - 1;
  const width = data.maxX - data.minX;
  const depth = data.maxZ - data.minZ;
  const epsilon = Math.min(width, depth) * 1e-7;
  const covers = (other, x, z) => x >= other.minX && x <= other.maxX && z >= other.minZ && z <= other.maxZ;
  // Keep per-edge sampling local; most of the viewport cannot touch this tile.
  const nearby = readyMeshes.filter(other => other !== mesh && other.userData.heights
    && other.userData.minX <= data.maxX + epsilon && other.userData.maxX >= data.minX - epsilon
    && other.userData.minZ <= data.maxZ + epsilon && other.userData.maxZ >= data.minZ - epsilon);
  const neighbours = nearby.filter(other => other.userData.layer === data.layer);
  const parents = nearby.filter(other => GROUND_LAYER_PRIORITY[other.userData.layer] < GROUND_LAYER_PRIORITY[data.layer]);
  const edges = [
    { point: t => [data.minX + (t * width), data.minZ], dx: 0, dz: -epsilon },
    { point: t => [data.minX + (t * width), data.maxZ], dx: 0, dz: epsilon },
    { point: t => [data.minX, data.minZ + (t * depth)], dx: -epsilon, dz: 0 },
    { point: t => [data.maxX, data.minZ + (t * depth)], dx: epsilon, dz: 0 },
  ];
  for (const edge of edges) {
    for (let index = 0; index < segments; index += 1) {
      const a = edge.point(index / segments);
      const b = edge.point((index + 1) / segments);
      const x = (a[0] + b[0]) / 2;
      const z = (a[1] + b[1]) / 2;
      if (neighbours.some(other => covers(other.userData, x + edge.dx, z + edge.dz))) continue;
      let parent = null;
      for (const other of parents) {
        if (!covers(other.userData, x, z)) continue;
        if (!parent || GROUND_LAYER_PRIORITY[other.userData.layer] > GROUND_LAYER_PRIORITY[parent.userData.layer]) parent = other;
      }
      if (!parent) continue;
      const aTop = sampleGroundTileHeight(mesh, ...a);
      const bTop = sampleGroundTileHeight(mesh, ...b);
      const aBase = sampleGroundTileHeight(parent, ...a);
      const bBase = sampleGroundTileHeight(parent, ...b);
      if (Math.abs(aTop - aBase) < 0.001 && Math.abs(bTop - bBase) < 0.001) continue;
      const corners = [[...a, aTop], [...a, aBase], [...b, bBase], [...a, aTop], [...b, bBase], [...b, bTop]];
      for (const [px, pz, py] of corners) {
        positions.push(px, py, pz);
        uvs.push((px - data.minX) / width, 1 - ((pz - data.minZ) / depth));
      }
    }
  }
  return positions.length ? { positions, uvs } : null;
}
