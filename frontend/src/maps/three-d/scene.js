// The three.js scene behind both 3D flight views. It owns the renderer,
// camera, orbit controls, ground tiles, track meshes, aircraft model and
// markers, and exposes a small imperative API so the live-map and timeline
// controllers never touch three.js objects directly. Everything that can be
// computed without WebGL (projection, tile choice, track vertices) lives in
// sibling modules so it can be unit tested; this file is browser-only.

import { buildAircraftModel, disposeAircraftModel } from './aircraft-model.js';
import { createLabelCanvas } from './marker-sprites.js';
import { daylightLighting, directionFromSky, moonDirectionForSun } from './sun-position.js';
import { buildTileElevationGrid, terrainTileForMapTile } from './terrain-tiles.js';
import { buildGroundSkirt, createGroundCoverageMask, groundCoverageRects, GROUND_LAYER_PRIORITY, sampleGroundTileHeight } from './ground-coverage.js';

export const WEBGL_CONTEXT_LOST_STATUS = '3D graphics were interrupted. Switch to 2D while graphics recover.';

const CAMERA_FOV_DEG = 55;
const CAMERA_NEAR = 2;
const CAMERA_FAR = 6e7;
const MAX_POLAR_ANGLE = (Math.PI / 2) - 0.03;
const TRACK_OUTLINE_COLOR = 0x152536;
const ROUTE_COLOR = 0x3b82f6;
const AIRCRAFT_COLOR = 0x31dc7e;
const PLACEHOLDER_TILE_COLOR = 0xd6dbe1;
// Quality profiles: phones and small screens get fewer terrain vertices, a
// capped pixel ratio and a smaller texture cache; the picture is the same.
const QUALITY_PROFILES = Object.freeze({
  high: Object.freeze({ textureCacheLimit: 192, maxPixelRatio: 2, terrainSegments: Object.freeze({ detail: 48, base: 32, horizon: 16 }) }),
  compact: Object.freeze({ textureCacheLimit: 96, maxPixelRatio: 1.5, terrainSegments: Object.freeze({ detail: 24, base: 16, horizon: 8 }) }),
});
const TILE_LOAD_CONCURRENCY = 6;
const TILE_LOAD_MAX_ATTEMPTS = 3;
const TILE_RETRY_DELAY_MS = 1000;
const HORIZON_TILE_Y = -4;
const BASE_TILE_Y = -2;
const DETAIL_TILE_Y = 0;
// Distance fog blends the far ground into the CSS sky so the edge of the
// tiled area never shows as a hard line. Ranges scale with the camera and
// the colour follows the lighting rig.
const FOG_NEAR_FACTOR = 2.5;
const FOG_FAR_FACTOR = 11;
// Lighting changes ease over a few frames so a replay scrubbed through
// sunset does not snap.
const LIGHTING_SMOOTHING = 0.12;
// Default chase distance grows with height above the ground plane so a
// taxiing aircraft is framed closely and a cruising one shows its track.
const CHASE_DISTANCE_MIN = 900;
const CHASE_DISTANCE_MAX = 60000;
const CHASE_DISTANCE_PER_ALTITUDE_UNIT = 3.5;
const SHADOW_Y = 1;
const ROUTE_Y = 2;
const MARKER_CLICK_MAX_DISTANCE_PX = 6;
const MARKER_CLICK_MAX_DURATION_MS = 450;
// Screen-space size floor for the aircraft so it stays legible when the
// whole flight is in view, expressed as scene units per unit of camera distance.
const AIRCRAFT_MIN_SCALE_PER_DISTANCE = 1 / 300;
const GROUND_RING_SCALE_PER_DISTANCE = 1 / 60;
const PIN_SCALE_PER_DISTANCE = 1 / 150;
const FOLLOW_HEADING_SMOOTHING = 0.12;
const FOLLOW_POSITION_SMOOTHING = 0.35;
// Keep the camera this far above displaced terrain so a mountainside never
// swallows the view; OrbitControls re-reads the camera position each frame,
// so the correction sticks.
const CAMERA_TERRAIN_CLEARANCE = 60;
// Mesh resolution per tile layer when terrain displaces the ground.
// The altitude ruler under the aircraft: a tick every 1,000 ft, longer every 5,000 ft.
const RULER_TICK_FT = 1000;
const RULER_MAJOR_TICK_FT = 5000;
const RULER_TICK_SCALE_PER_DISTANCE = 1 / 110;

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toLinearColorArray(source) {
  const out = new Float32Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    out[index] = srgbToLinear(source[index]);
  }
  return out;
}

function disposeObject(object) {
  if (!object) return;
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    const material = child.material;
    if (Array.isArray(material)) material.forEach((entry) => entry?.dispose?.());
    else material?.dispose?.();
  });
}

export function createFlightScene({
  containerEl,
  three,
  windowRef = window,
  documentRef = document,
  consoleRef = console,
  onUserPan = () => {},
  onViewSettled = () => {},
  onMarkerClick = () => {},
  onTerrainUpdated = () => {},
  onContextLost = () => {},
  onContextRestored = () => {},
  quality = 'high',
} = {}) {
  if (!containerEl) throw new Error('A container element is required for the 3D scene.');
  const { THREE, OrbitControls, LineSegments2, LineSegmentsGeometry, LineMaterial } = three;
  const profile = QUALITY_PROFILES[quality] || QUALITY_PROFILES.high;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });
  } catch (error) {
    throw new Error(`WebGL is unavailable: ${error?.message || error}`);
  }
  renderer.setPixelRatio(Math.min(profile.maxPixelRatio, windowRef.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.classList.add('flight-scene-canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  containerEl.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x3b4553, 1e5, 1e6);
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(0, 20000, 30000);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = false;
  controls.minDistance = 40;
  controls.maxDistance = 2.5e7;
  controls.maxPolarAngle = MAX_POLAR_ANGLE;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 1.1;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  // Lighting rig: sky dome, sun and the fixed night light. The rig follows
  // the sun position the controller supplies; tiles use a lit material with
  // real normals so relief changes with the time of day.
  const hemisphere = new THREE.HemisphereLight(0xe3ecff, 0x2b2f36, 0.5);
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(0.35, 0.85, 0.4);
  const moon = new THREE.DirectionalLight(0x9db2d6, 0);
  moon.position.set(-0.35, 0.8, -0.4);
  scene.add(hemisphere, sun, moon);
  const lightingCurrent = {
    sunIntensity: 0.85,
    sunColor: new THREE.Color(0xffffff),
    moonIntensity: 0,
    moonColor: new THREE.Color(0x9db2d6),
    hemisphereSky: new THREE.Color(0xe3ecff),
    hemisphereGround: new THREE.Color(0x2b2f36),
    hemisphereIntensity: 0.5,
    fogColor: new THREE.Color(0x3b4553),
    skyColor: new THREE.Color(0x242a33),
    horizonColor: new THREE.Color(0x4b5665),
    aircraftEmissive: 0.18,
    sunDirection: new THREE.Vector3(0.35, 0.85, 0.4).normalize(),
    moonDirection: new THREE.Vector3(-0.35, 0.8, -0.4).normalize(),
  };
  const lightingTarget = {
    ...lightingCurrent,
    sunColor: lightingCurrent.sunColor.clone(),
    moonColor: lightingCurrent.moonColor.clone(),
    hemisphereSky: lightingCurrent.hemisphereSky.clone(),
    hemisphereGround: lightingCurrent.hemisphereGround.clone(),
    fogColor: lightingCurrent.fogColor.clone(),
    skyColor: lightingCurrent.skyColor.clone(),
    horizonColor: lightingCurrent.horizonColor.clone(),
    sunDirection: lightingCurrent.sunDirection.clone(),
    moonDirection: lightingCurrent.moonDirection.clone(),
  };
  let lightingSettling = true;

  const groundGroup = new THREE.Group();
  const trackGroup = new THREE.Group();
  const markerGroup = new THREE.Group();
  const pinGroup = new THREE.Group();
  const routeGroup = new THREE.Group();
  scene.add(groundGroup, trackGroup, markerGroup, pinGroup, routeGroup);

  const lineResolution = new THREE.Vector2(1, 1);
  const lineMaterials = new Set();

  function createLineMaterial(options) {
    const material = new LineMaterial({ resolution: lineResolution.clone(), fog: true, ...options });
    lineMaterials.add(material);
    return material;
  }

  const trackOutlineMaterial = createLineMaterial({ color: TRACK_OUTLINE_COLOR, linewidth: 5.5 });
  const trackPathMaterial = createLineMaterial({ vertexColors: true, linewidth: 3.5 });
  const trackShadowMaterial = createLineMaterial({
    color: TRACK_OUTLINE_COLOR,
    linewidth: 1.5,
    transparent: true,
    opacity: 0.55,
  });
  const curtainMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const routeMaterial = createLineMaterial({
    color: ROUTE_COLOR,
    linewidth: 2,
    transparent: true,
    opacity: 0.85,
  });
  const targetLineMaterial = createLineMaterial({ color: ROUTE_COLOR, linewidth: 2.5 });
  const pinLineMaterial = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.6 });
  const stemMaterial = new THREE.LineBasicMaterial({ color: AIRCRAFT_COLOR, transparent: true, opacity: 0.75 });
  const placeholderTileMaterial = new THREE.MeshBasicMaterial({ color: PLACEHOLDER_TILE_COLOR });

  let trackOutline = null;
  let trackPath = null;
  let trackShadow = null;
  let curtain = null;
  let routeLine = null;
  let targetLine = null;
  let showCurtain = true;

  // Aircraft: model, a stem to the ground and a ring on the ground so the
  // altitude reads even when the camera is nearly overhead.
  const aircraft = new THREE.Group();
  const aircraftModel = buildAircraftModel(THREE, { color: AIRCRAFT_COLOR });
  aircraft.add(aircraftModel);
  aircraft.visible = false;
  scene.add(aircraft);
  // The altitude ruler: a wide stem from the aircraft to the ground with a
  // tick every thousand feet, a disc on the ground and a label on the
  // aircraft, so height reads at a glance from any camera angle.
  const stemLineMaterial = createLineMaterial({ color: AIRCRAFT_COLOR, linewidth: 2.5, transparent: true, opacity: 0.9 });
  let stem = null;
  const rulerTicks = new THREE.LineSegments(new THREE.BufferGeometry(), stemMaterial);
  rulerTicks.visible = false;
  rulerTicks.frustumCulled = false;
  scene.add(rulerTicks);
  const groundDisc = new THREE.Group();
  groundDisc.add(new THREE.Mesh(
    new THREE.CircleGeometry(1, 40),
    new THREE.MeshBasicMaterial({ color: AIRCRAFT_COLOR, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }),
  ));
  groundDisc.add(new THREE.Mesh(
    new THREE.RingGeometry(0.86, 1, 40),
    new THREE.MeshBasicMaterial({ color: AIRCRAFT_COLOR, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
  ));
  groundDisc.rotation.x = -Math.PI / 2;
  groundDisc.visible = false;
  groundDisc.renderOrder = 6;
  scene.add(groundDisc);
  let altitudeLabel = null;
  let altitudeLabelText = '';
  const aircraftState = {
    x: 0,
    y: 0,
    z: 0,
    headingDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    altitudeFt: null,
    altitudeUnitsPerFoot: null,
    floorFt: 0,
    label: '',
  };
  let rulerKey = '';

  const tileMeshes = new Map();
  let groundCoverageDirty = false;
  const tileTextures = new Map();
  const tileLoadsPending = new Set();
  const tileLoadAttempts = new Map();
  const tileRetryTimers = new Map();
  // Terrain: `{ provider, unitsPerMeter, floorMeters }` while elevation
  // displacement is on, null for the flat ground plane.
  let terrain = null;
  let terrainGeneration = 0;
  let terrainSuspended = false;
  const tileLoadQueue = new Map();
  let tileLoadsInFlight = 0;
  let tileLoadsSuspended = false;
  const textureLoader = new THREE.TextureLoader();
  textureLoader.setCrossOrigin('anonymous');
  const maxAnisotropy = renderer.capabilities?.getMaxAnisotropy?.() || 1;
  let groundGrid = null;

  const sprites = [];
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  let pointerDown = null;

  let width = 1;
  let height = 1;
  let needsRender = true;
  let active = false;
  let rafId = null;
  let disposed = false;
  let contextLost = false;
  let previousCameraView = null;
  let cameraViewPending = false;

  let followMode = 'none';
  let followTarget = null;
  let followHeadingDeg = 0;
  let smoothedHeadingDeg = null;
  let followOffset = new THREE.Vector3(0, 6000, 12000);
  let pendingTargetMove = null;
  let suppressUserEvents = false;
  const lastAppliedTarget = new THREE.Vector3();
  const scratchVector = new THREE.Vector3();

  function requestRender() {
    needsRender = true;
  }

  function resize() {
    if (disposed || contextLost) return false;
    const nextWidth = Math.max(1, Math.floor(containerEl.clientWidth || 0));
    const nextHeight = Math.max(1, Math.floor(containerEl.clientHeight || 0));
    if ((containerEl.clientWidth || 0) <= 0 || (containerEl.clientHeight || 0) <= 0) return false;
    if (nextWidth === width && nextHeight === height) return true;
    width = nextWidth;
    height = nextHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    lineResolution.set(width, height);
    for (const material of lineMaterials) material.resolution.set(width, height);
    requestRender();
    if (active) onViewSettled(getViewInfo());
    return true;
  }

  // ---------------------------------------------------------------------------
  // Ground tiles
  // ---------------------------------------------------------------------------

  function desaturateImage(image) {
    try {
      const tileCanvas = documentRef.createElement('canvas');
      tileCanvas.width = image.width || 256;
      tileCanvas.height = image.height || 256;
      const ctx = tileCanvas.getContext('2d');
      if (!ctx || typeof ctx.filter !== 'string') return null;
      // Match the 2D basemap's muted look so the track stays the focus.
      ctx.filter = 'saturate(0.65)';
      ctx.drawImage(image, 0, 0);
      return tileCanvas;
    } catch {
      return null;
    }
  }

  function prepareTexture(texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAnisotropy;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  function touchTexture(key) {
    const entry = tileTextures.get(key);
    if (!entry) return null;
    tileTextures.delete(key);
    tileTextures.set(key, entry);
    return entry;
  }

  function trimTextureCache() {
    for (const [key, entry] of tileTextures) {
      if (tileTextures.size <= profile.textureCacheLimit) break;
      // Visible tiles can exceed the compact cache budget. Keep those, but
      // continue looking for unused entries instead of letting them accumulate
      // behind a persistent base/horizon tile at the front of the cache.
      if (entry.inUse) continue;
      tileTextures.delete(key);
      entry?.texture?.dispose?.();
    }
  }

  function applyTextureToTile(key, texture) {
    const mesh = tileMeshes.get(key);
    if (!mesh) return;
    if (mesh.material !== placeholderTileMaterial) mesh.material.dispose?.();
    // A tile stays invisible until its imagery arrives so the coarser layer
    // beneath shows through instead of a blank slab.
    mesh.visible = true;
    mesh.material = new THREE.MeshLambertMaterial({
      map: texture,
      polygonOffset: mesh.userData.layer !== 'detail',
      polygonOffsetFactor: mesh.userData.layer === 'horizon' ? 2 : 1,
      polygonOffsetUnits: 1,
      side: THREE.DoubleSide,
    });
    mesh.userData.setCoverage = mesh.userData.layer === 'detail' ? null : createGroundCoverageMask(mesh.material);
    groundCoverageDirty = true;
    const entry = tileTextures.get(key);
    if (entry) entry.inUse = true;
    requestRender();
    if (terrain) scheduleTerrainNotification();
  }

  function createTileGeometry(tile) {
    const tileWidth = tile.maxX - tile.minX;
    const tileDepth = tile.maxZ - tile.minZ;
    const segments = terrain ? (profile.terrainSegments[tile.layer] || profile.terrainSegments.base) : 1;
    const geometry = new THREE.PlaneGeometry(tileWidth, tileDepth, segments, segments);
    geometry.userData.segments = segments;
    return geometry;
  }

  // Displace a tile by its elevation grid (metres) and recompute its normals
  // so the light rig shades the relief. Heights are kept in scene units for
  // sampling.
  function applyTerrainToTile(mesh, elevations, window) {
    if (!terrain || !mesh.geometry) return;
    const geometry = mesh.geometry;
    const segments = geometry.userData.segments;
    const grid = buildTileElevationGrid(elevations, window, segments);
    const positions = geometry.attributes.position.array;
    const count = segments + 1;
    const heights = new Float32Array(grid.length);
    for (let index = 0; index < grid.length; index += 1) {
      heights[index] = Math.max(0, (grid[index] - terrain.floorMeters) * terrain.unitsPerMeter);
      positions[(index * 3) + 2] = heights[index];
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    mesh.userData.heights = heights;
    mesh.userData.count = count;
    groundCoverageDirty = true;
    requestRender();
    scheduleTerrainNotification();
  }

  let terrainNotificationFrame = null;

  // Batch per-tile arrivals into one notification per frame so callers can
  // re-read ground heights (aircraft label, HUD) without a flood of updates.
  function scheduleTerrainNotification() {
    if (terrainNotificationFrame != null || disposed || !active || contextLost) return;
    terrainNotificationFrame = windowRef.requestAnimationFrame(() => {
      terrainNotificationFrame = null;
      if (!disposed && active && !contextLost) onTerrainUpdated();
    });
  }

  function requestTerrainForTile(mesh, tile) {
    if (!terrain || terrainSuspended || !Number.isFinite(tile.z) || mesh.userData.terrainRequest || mesh.userData.heights) return;
    const window = terrainTileForMapTile(tile);
    const generation = terrainGeneration;
    const cached = terrain.provider.peekElevations(window.key);
    if (cached) {
      applyTerrainToTile(mesh, cached, window);
      return;
    }
    const request = terrain.provider.getElevations(window);
    mesh.userData.terrainRequest = request;
    request
      .then((elevations) => {
        if (disposed || generation !== terrainGeneration || tileMeshes.get(tile.key) !== mesh) return;
        applyTerrainToTile(mesh, elevations, window);
      })
      .catch(() => {})
      .finally(() => { if (mesh.userData.terrainRequest === request) mesh.userData.terrainRequest = null; });
  }

  /**
   * Ground height in scene units under (x, z) from the finest visible tile,
   * or null where no displaced tile covers the point yet.
   */
  function groundHeightAt(x, z) {
    if (!terrain) return null;
    let best = null;
    for (const mesh of tileMeshes.values()) {
      const data = mesh.userData;
      if (!mesh.visible || !data.heights) continue;
      if (x < data.minX || x > data.maxX || z < data.minZ || z > data.maxZ) continue;
      if (!best || GROUND_LAYER_PRIORITY[data.layer] > GROUND_LAYER_PRIORITY[best.userData.layer]) best = mesh;
    }
    if (!best) return null;
    return sampleGroundTileHeight(best, x, z);
  }

  const TILE_LOAD_PRIORITY = { detail: 0, base: 1, horizon: 2 };

  function cancelTileRetry(key) {
    if (!tileRetryTimers.has(key)) return;
    windowRef.clearTimeout(tileRetryTimers.get(key));
    tileRetryTimers.delete(key);
  }

  function queueTileImage(tile) {
    if (!tile.url || tileTextures.has(tile.key) || tileLoadsPending.has(tile.key)
      || tileRetryTimers.has(tile.key) || (tileLoadAttempts.get(tile.key) || 0) >= TILE_LOAD_MAX_ATTEMPTS) return;
    tileLoadQueue.set(tile.key, { key: tile.key, url: tile.url, layer: tile.layer });
  }

  function pumpTileQueue() {
    if (disposed || tileLoadsSuspended || contextLost) return;
    // Detail tiles under the camera first, then the base, then the horizon.
    const jobs = [...tileLoadQueue.values()].sort((a, b) => (TILE_LOAD_PRIORITY[a.layer] ?? 1) - (TILE_LOAD_PRIORITY[b.layer] ?? 1));
    while (tileLoadsInFlight < TILE_LOAD_CONCURRENCY && jobs.length > 0) {
      const job = jobs.shift();
      tileLoadQueue.delete(job.key);
      if (!tileMeshes.has(job.key) || tileLoadsPending.has(job.key)) continue;
      tileLoadsInFlight += 1;
      tileLoadsPending.add(job.key);
      const attempt = (tileLoadAttempts.get(job.key) || 0) + 1;
      tileLoadAttempts.set(job.key, attempt);
      textureLoader.load(
        job.url,
        (texture) => {
          tileLoadsInFlight -= 1;
          tileLoadsPending.delete(job.key);
          tileLoadAttempts.delete(job.key);
          if (disposed) {
            texture.dispose();
            return;
          }
          // A tile re-added while its first load was in flight already has
          // a texture by now; keep that one and drop the duplicate.
          const existing = tileTextures.get(job.key);
          if (existing) {
            texture.dispose();
            applyTextureToTile(job.key, existing.texture);
            pumpTileQueue();
            return;
          }
          const desaturated = desaturateImage(texture.image);
          let finalTexture = texture;
          if (desaturated) {
            texture.dispose();
            finalTexture = new THREE.CanvasTexture(desaturated);
          }
          prepareTexture(finalTexture);
          tileTextures.set(job.key, { texture: finalTexture, inUse: false });
          applyTextureToTile(job.key, finalTexture);
          trimTextureCache();
          pumpTileQueue();
        },
        undefined,
        (error) => {
          tileLoadsInFlight -= 1;
          tileLoadsPending.delete(job.key);
          consoleRef.warn?.('[FlightScene] Ground tile could not load', job.url, error?.message || error);
          if (!disposed && !tileLoadsSuspended && !contextLost && tileMeshes.has(job.key) && attempt < TILE_LOAD_MAX_ATTEMPTS) {
            const timer = windowRef.setTimeout(() => {
              tileRetryTimers.delete(job.key);
              if (disposed || tileLoadsSuspended || contextLost || !tileMeshes.has(job.key)) return;
              queueTileImage(job);
              pumpTileQueue();
            }, TILE_RETRY_DELAY_MS * (2 ** (attempt - 1)));
            tileRetryTimers.set(job.key, timer);
          }
          pumpTileQueue();
        },
      );
    }
  }

  /**
   * Show exactly this set of tiles. Each tile: `{ key, url, layer, minX,
   * maxX, minZ, maxZ }` in scene units. Meshes that are no longer listed are
   * removed; textures stay cached for a while so panning back is instant.
   */
  function removeTileMesh(key, mesh) {
    groundCoverageDirty = true;
    removeGroundSkirt(mesh);
    cancelTileRetry(key);
    tileLoadAttempts.delete(key);
    groundGroup.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material !== placeholderTileMaterial) mesh.material.dispose?.();
    const entry = tileTextures.get(key);
    if (entry) entry.inUse = false;
    tileMeshes.delete(key);
  }

  function terrainKey(options) {
    if (!options) return 'flat';
    return `${options.unitsPerMeter}|${options.floorMeters}`;
  }

  /**
   * Show exactly this set of tiles. `terrainOptions` is
   * `{ provider, unitsPerMeter, floorMeters }` to displace them by
   * elevation, or null for a flat ground plane. Changing the terrain scale
   * rebuilds every tile, because their vertices move.
   */
  function setGroundTiles(tiles, { terrain: terrainOptions = null } = {}) {
    if (disposed) return;
    if (terrainKey(terrainOptions) !== terrainKey(terrain) || terrainOptions?.provider !== terrain?.provider) {
      terrain?.provider.retainTiles([]);
      terrain = terrainOptions ? { ...terrainOptions } : null;
      terrainGeneration += 1;
      for (const [key, mesh] of [...tileMeshes]) removeTileMesh(key, mesh);
      if (trackShadow) trackShadow.visible = !terrain;
    }

    const wanted = new Map();
    for (const tile of Array.isArray(tiles) ? tiles : []) {
      if (tile?.key) wanted.set(tile.key, tile);
    }
    // A slow connection must retain only the current viewport's queued work,
    // including when panning away and back while all load slots are occupied.
    for (const key of tileLoadQueue.keys()) if (!wanted.has(key)) tileLoadQueue.delete(key);
    terrain?.provider.retainTiles([...wanted.values()].filter(tile => Number.isFinite(tile.z)).map(tile => terrainTileForMapTile(tile).key));

    for (const [key, mesh] of [...tileMeshes]) {
      if (!wanted.has(key)) removeTileMesh(key, mesh);
    }

    for (const [key, tile] of wanted) {
      if (tileMeshes.has(key)) {
        requestTerrainForTile(tileMeshes.get(key), tile);
        queueTileImage(tile);
        continue;
      }
      const tileWidth = tile.maxX - tile.minX;
      const tileDepth = tile.maxZ - tile.minZ;
      if (!(tileWidth > 0) || !(tileDepth > 0)) continue;
      const mesh = new THREE.Mesh(createTileGeometry(tile), placeholderTileMaterial);
      mesh.visible = false;
      mesh.rotation.x = -Math.PI / 2;
      const layerY = tile.layer === 'detail' ? DETAIL_TILE_Y : (tile.layer === 'horizon' ? HORIZON_TILE_Y : BASE_TILE_Y);
      mesh.position.set((tile.minX + tile.maxX) / 2, layerY, (tile.minZ + tile.maxZ) / 2);
      mesh.renderOrder = tile.layer === 'detail' ? 1 : (tile.layer === 'horizon' ? -1 : 0);
      mesh.userData = {
        layer: tile.layer,
        minX: tile.minX,
        maxX: tile.maxX,
        minZ: tile.minZ,
        maxZ: tile.maxZ,
        width: tileWidth,
        depth: tileDepth,
        heights: null,
        count: 0,
      };
      groundGroup.add(mesh);
      tileMeshes.set(key, mesh);

      const cached = touchTexture(key);
      if (cached) {
        applyTextureToTile(key, cached.texture);
      } else queueTileImage(tile);
      requestTerrainForTile(mesh, tile);
    }

    trimTextureCache();
    pumpTileQueue();
    requestRender();
    if (terrain) scheduleTerrainNotification();
  }

  function updateGroundCoverage() {
    if (!groundCoverageDirty) return;
    groundCoverageDirty = false;
    const readyMeshes = [...tileMeshes.values()].filter(mesh => mesh.visible && (!terrain || mesh.userData.heights));
    const ready = readyMeshes.map(mesh => mesh.userData);
    for (const mesh of tileMeshes.values()) {
      mesh.userData.setCoverage?.(groundCoverageRects(mesh.userData, ready));
      removeGroundSkirt(mesh);
      const skirt = mesh.visible && terrain ? buildGroundSkirt(mesh, readyMeshes) : null;
      if (!skirt) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(skirt.positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(skirt.uvs, 2));
      geometry.computeVertexNormals();
      const edge = new THREE.Mesh(geometry, mesh.material);
      edge.renderOrder = mesh.renderOrder;
      groundGroup.add(edge);
      mesh.userData.skirt = edge;
    }
  }

  function removeGroundSkirt(mesh) {
    const skirt = mesh.userData.skirt;
    if (!skirt) return;
    groundGroup.remove(skirt);
    skirt.geometry.dispose();
    // The parent tile owns the shared material and texture.
    mesh.userData.skirt = null;
  }

  /** Fallback ground when online tiles are disabled: a muted plane and grid. */
  function setGroundGrid({ size = 400000, centerX = 0, centerZ = 0 } = {}) {
    if (groundGrid) {
      scene.remove(groundGrid);
      disposeObject(groundGrid);
      groundGrid = null;
    }
    const group = new THREE.Group();
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: 0x1b2230 }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(centerX, BASE_TILE_Y - 1, centerZ);
    group.add(plane);
    const grid = new THREE.GridHelper(size, 40, 0x3b4a5e, 0x2a3442);
    grid.position.set(centerX, BASE_TILE_Y, centerZ);
    group.add(grid);
    groundGrid = group;
    scene.add(groundGrid);
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // Track
  // ---------------------------------------------------------------------------

  function replaceTrackObject(current, next) {
    if (current) {
      trackGroup.remove(current);
      current.geometry?.dispose?.();
    }
    if (next) trackGroup.add(next);
    return next;
  }

  function buildLineSegments(positions, material, { colors = null, renderOrder = 0 } = {}) {
    if (!positions || positions.length < 6) return null;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    if (colors) geometry.setColors(toLinearColorArray(colors));
    const line = new LineSegments2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = renderOrder;
    line.frustumCulled = false;
    return line;
  }

  function setTrack(geometry) {
    if (disposed) return;
    const data = geometry || {};
    trackShadow = replaceTrackObject(trackShadow, buildLineSegments(data.shadowPositions, trackShadowMaterial, { renderOrder: 2 }));
    trackOutline = replaceTrackObject(trackOutline, buildLineSegments(data.pathPositions, trackOutlineMaterial, { renderOrder: 3 }));
    trackPath = replaceTrackObject(trackPath, buildLineSegments(data.pathPositions, trackPathMaterial, {
      colors: data.pathColors,
      renderOrder: 4,
    }));

    let nextCurtain = null;
    if (data.curtainPositions && data.curtainPositions.length >= 9) {
      const curtainGeometry = new THREE.BufferGeometry();
      curtainGeometry.setAttribute('position', new THREE.BufferAttribute(data.curtainPositions, 3));
      curtainGeometry.setAttribute('color', new THREE.BufferAttribute(toLinearColorArray(data.curtainColors), 3));
      nextCurtain = new THREE.Mesh(curtainGeometry, curtainMaterial);
      nextCurtain.renderOrder = 1;
      nextCurtain.frustumCulled = false;
      nextCurtain.visible = showCurtain;
    }
    curtain = replaceTrackObject(curtain, nextCurtain);
    if (trackShadow) {
      trackShadow.position.y = SHADOW_Y;
      // On displaced terrain the curtain meets the ground; a flat shadow
      // would sit below the surface.
      trackShadow.visible = !terrain;
    }
    requestRender();
  }

  function setCurtainVisible(visible) {
    showCurtain = visible !== false;
    if (curtain) curtain.visible = showCurtain;
    requestRender();
  }

  function setRouteLine(positions) {
    if (routeLine) {
      routeGroup.remove(routeLine);
      routeLine.geometry.dispose();
      routeLine = null;
    }
    routeLine = buildLineSegments(positions, routeMaterial, { renderOrder: 2 });
    if (routeLine) {
      routeLine.position.y = ROUTE_Y;
      routeGroup.add(routeLine);
    }
    requestRender();
  }

  function setTargetLine(positions) {
    if (targetLine) {
      routeGroup.remove(targetLine);
      targetLine.geometry.dispose();
      targetLine = null;
    }
    targetLine = buildLineSegments(positions, targetLineMaterial, { renderOrder: 2 });
    if (targetLine) routeGroup.add(targetLine);
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // Aircraft
  // ---------------------------------------------------------------------------

  function setAltitudeLabel(text) {
    const nextText = String(text || '');
    if (nextText === altitudeLabelText && altitudeLabel) return;
    altitudeLabelText = nextText;
    if (altitudeLabel) {
      scene.remove(altitudeLabel);
      const index = sprites.indexOf(altitudeLabel);
      if (index >= 0) sprites.splice(index, 1);
      altitudeLabel.material.map?.dispose?.();
      altitudeLabel.material.dispose?.();
      altitudeLabel = null;
    }
    if (!nextText) return;
    const badge = createLabelCanvas(documentRef, nextText, { color: '#f2f5f7', background: '#152536' });
    if (!badge) return;
    altitudeLabel = createSprite(badge, { pixelHeight: 22, center: { x: -0.12, y: 1.25 } });
    altitudeLabel.renderOrder = 21;
    scene.add(altitudeLabel);
    sprites.push(altitudeLabel);
    refreshSpriteScales();
  }

  function groundLevelUnder(x, z) {
    return groundHeightAt(x, z) ?? SHADOW_Y;
  }

  function rebuildAltitudeRuler(groundY, tickHalfLength) {
    const { x, y, z, altitudeFt, altitudeUnitsPerFoot, floorFt } = aircraftState;
    const key = `${x.toFixed(1)}|${y.toFixed(1)}|${z.toFixed(1)}|${groundY.toFixed(1)}|${tickHalfLength.toFixed(2)}`;
    if (key === rulerKey) return;
    rulerKey = key;

    const stemPositions = new Float32Array([x, y, z, x, groundY, z]);
    const nextStem = buildLineSegments(stemPositions, stemLineMaterial, { renderOrder: 5 });
    if (stem) {
      scene.remove(stem);
      stem.geometry.dispose();
    }
    stem = nextStem;
    if (stem) scene.add(stem);

    const ticks = [];
    if (Number.isFinite(altitudeFt) && Number.isFinite(altitudeUnitsPerFoot) && altitudeUnitsPerFoot > 0) {
      const groundFt = floorFt + ((groundY - SHADOW_Y) / altitudeUnitsPerFoot);
      const firstTick = Math.ceil(groundFt / RULER_TICK_FT) * RULER_TICK_FT;
      for (let level = firstTick; level < altitudeFt && ticks.length < 600; level += RULER_TICK_FT) {
        const tickY = (level - floorFt) * altitudeUnitsPerFoot;
        if (tickY <= groundY) continue;
        const length = (level % RULER_MAJOR_TICK_FT === 0 ? 2 : 1) * tickHalfLength;
        ticks.push(x - length, tickY, z, x + length, tickY, z, x, tickY, z - length, x, tickY, z + length);
      }
    }
    rulerTicks.geometry.dispose();
    rulerTicks.geometry = new THREE.BufferGeometry();
    rulerTicks.geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(ticks), 3));
    rulerTicks.visible = ticks.length > 0;
  }

  function setAircraft({
    x,
    y,
    z,
    headingDeg = 0,
    pitchDeg = 0,
    rollDeg = 0,
    visible = true,
    altitudeFt = null,
    altitudeUnitsPerFoot = null,
    floorFt = 0,
    label = '',
  } = {}) {
    if (disposed) return;
    if (!visible || ![x, y, z].every(Number.isFinite)) {
      aircraft.visible = false;
      if (stem) stem.visible = false;
      rulerTicks.visible = false;
      groundDisc.visible = false;
      setAltitudeLabel('');
      requestRender();
      return;
    }
    Object.assign(aircraftState, {
      x,
      y,
      z,
      headingDeg: Number.isFinite(headingDeg) ? headingDeg : 0,
      pitchDeg: Number.isFinite(pitchDeg) ? pitchDeg : 0,
      rollDeg: Number.isFinite(rollDeg) ? rollDeg : 0,
      altitudeFt: Number.isFinite(altitudeFt) ? altitudeFt : null,
      altitudeUnitsPerFoot: Number.isFinite(altitudeUnitsPerFoot) ? altitudeUnitsPerFoot : null,
      floorFt: Number.isFinite(floorFt) ? floorFt : 0,
      label: String(label || ''),
    });
    aircraft.position.set(x, y, z);
    // Yaw about y, then pitch about the wing axis, then roll about the nose.
    // Heading is clockwise from north (-z) so it becomes a negative y rotation;
    // positive roll is right wing down, a negative rotation about +z.
    aircraft.rotation.set(
      THREE.MathUtils.degToRad(aircraftState.pitchDeg),
      -THREE.MathUtils.degToRad(aircraftState.headingDeg),
      -THREE.MathUtils.degToRad(aircraftState.rollDeg),
      'YXZ',
    );
    aircraft.visible = true;
    if (stem) stem.visible = true;
    groundDisc.visible = true;
    setAltitudeLabel(aircraftState.label);
    if (altitudeLabel) altitudeLabel.position.set(x, y, z);
    rulerKey = '';
    followTarget = { x, y, z };
    followHeadingDeg = aircraftState.headingDeg;
    requestRender();
  }

  function updateDistanceScaledObjects() {
    if (aircraft.visible) {
      const distance = camera.position.distanceTo(aircraft.position);
      const scale = Math.max(1, distance * AIRCRAFT_MIN_SCALE_PER_DISTANCE);
      aircraft.scale.setScalar(scale);
      const groundY = groundLevelUnder(aircraftState.x, aircraftState.z);
      groundDisc.position.set(aircraftState.x, groundY + 0.5, aircraftState.z);
      const discDistance = camera.position.distanceTo(groundDisc.position);
      groundDisc.scale.setScalar(Math.max(4, discDistance * GROUND_RING_SCALE_PER_DISTANCE));
      rebuildAltitudeRuler(groundY, Math.max(2, distance * RULER_TICK_SCALE_PER_DISTANCE));
    }
    for (const pin of pinGroup.children) {
      const marker = pin.userData.marker;
      if (!marker) continue;
      pin.position.y = groundLevelUnder(pin.position.x, pin.position.z);
      const distance = camera.position.distanceTo(pin.position);
      marker.scale.setScalar(Math.max(2, distance * PIN_SCALE_PER_DISTANCE));
    }
  }

  // ---------------------------------------------------------------------------
  // Markers and pins
  // ---------------------------------------------------------------------------

  function spriteScaleForPixels(px) {
    return (px / height) * 2 * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2));
  }

  function createSprite(badge, { pixelHeight = 26, center = null } = {}) {
    const texture = new THREE.CanvasTexture(badge.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.SpriteMaterial({
      map: texture,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    const sprite = new THREE.Sprite(material);
    const ratio = badge.width / badge.height;
    sprite.userData.pixelHeight = pixelHeight;
    sprite.userData.aspect = ratio;
    if (center) sprite.center.set(center.x, center.y);
    sprite.renderOrder = 20;
    return sprite;
  }

  function refreshSpriteScales() {
    for (const sprite of sprites) {
      const scaleY = spriteScaleForPixels(sprite.userData.pixelHeight);
      sprite.scale.set(scaleY * sprite.userData.aspect, scaleY, 1);
    }
  }

  function clearMarkers() {
    for (const child of [...markerGroup.children]) {
      markerGroup.remove(child);
      disposeObject(child);
      child.material?.map?.dispose?.();
    }
    sprites.length = 0;
  }

  /** Event markers: `{ id, x, y, z, badge }` where badge is a drawn canvas. */
  function setMarkers(markers) {
    if (disposed) return;
    clearMarkers();
    const pinPositions = [];
    for (const marker of Array.isArray(markers) ? markers : []) {
      if (!marker?.badge || ![marker.x, marker.y, marker.z].every(Number.isFinite)) continue;
      const sprite = createSprite(marker.badge, { pixelHeight: 24 });
      sprite.position.set(marker.x, marker.y, marker.z);
      sprite.userData.markerId = marker.id;
      markerGroup.add(sprite);
      sprites.push(sprite);
      if (marker.y > 5) pinPositions.push(marker.x, marker.y, marker.z, marker.x, SHADOW_Y, marker.z);
    }
    if (pinPositions.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pinPositions), 3));
      const lines = new THREE.LineSegments(geometry, pinLineMaterial);
      lines.renderOrder = 5;
      markerGroup.add(lines);
    }
    refreshSpriteScales();
    requestRender();
  }

  /** Airport pins: `{ id, x, z, color, label }` with label as a drawn canvas. */
  function setPins(pins) {
    if (disposed) return;
    for (const child of [...pinGroup.children]) {
      pinGroup.remove(child);
      disposeObject(child);
      const labelSprite = child.userData.label;
      if (labelSprite) {
        const index = sprites.indexOf(labelSprite);
        if (index >= 0) sprites.splice(index, 1);
        labelSprite.material?.map?.dispose?.();
      }
    }
    for (const pin of Array.isArray(pins) ? pins : []) {
      if (![pin?.x, pin?.z].every(Number.isFinite)) continue;
      const group = new THREE.Group();
      group.position.set(pin.x, SHADOW_Y, pin.z);
      const marker = new THREE.Mesh(
        new THREE.ConeGeometry(1, 3, 16),
        new THREE.MeshStandardMaterial({ color: pin.color || 0x3b82f6, emissive: pin.color || 0x3b82f6, emissiveIntensity: 0.25 }),
      );
      marker.position.y = 1.5;
      group.add(marker);
      group.userData.marker = marker;
      if (pin.label) {
        const label = createSprite(pin.label, { pixelHeight: 22, center: { x: 0.5, y: -0.6 } });
        group.add(label);
        group.userData.label = label;
        sprites.push(label);
      }
      pinGroup.add(group);
    }
    refreshSpriteScales();
    updateDistanceScaledObjects();
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  function applyControlLimits(mode) {
    if (mode === 'top') {
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = 0;
      controls.minAzimuthAngle = 0;
      controls.maxAzimuthAngle = 0;
    } else {
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = MAX_POLAR_ANGLE;
      controls.minAzimuthAngle = -Infinity;
      controls.maxAzimuthAngle = Infinity;
    }
  }

  function worldOffsetFromHeadingFrame(offset, headingDeg) {
    const heading = THREE.MathUtils.degToRad(headingDeg);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    // Heading frame: +x right wing, +z behind the aircraft.
    return new THREE.Vector3(
      (offset.x * cos) - (offset.z * sin),
      offset.y,
      (offset.x * sin) + (offset.z * cos),
    );
  }

  function headingFrameFromWorldOffset(offset, headingDeg) {
    const heading = THREE.MathUtils.degToRad(headingDeg);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    return new THREE.Vector3(
      (offset.x * cos) + (offset.z * sin),
      offset.y,
      (-offset.x * sin) + (offset.z * cos),
    );
  }

  function captureFollowOffset() {
    const worldOffset = scratchVector.copy(camera.position).sub(controls.target);
    if (followMode === 'chase') {
      followOffset = headingFrameFromWorldOffset(worldOffset, smoothedHeadingDeg ?? followHeadingDeg);
    } else {
      followOffset = worldOffset.clone();
    }
  }

  function setFollowMode(mode) {
    followMode = ['chase', 'orbit', 'top'].includes(mode) ? mode : 'none';
    applyControlLimits(followMode);
    if (followMode === 'chase') {
      smoothedHeadingDeg = followHeadingDeg;
      const altitudeUnits = Math.max(0, followTarget?.y ?? 0);
      const distance = Math.max(
        CHASE_DISTANCE_MIN,
        Math.min(CHASE_DISTANCE_MAX, CHASE_DISTANCE_MIN + (altitudeUnits * CHASE_DISTANCE_PER_ALTITUDE_UNIT)),
      );
      followOffset = new THREE.Vector3(0, distance * 0.45, distance * 0.9);
    } else if (followMode === 'orbit') {
      captureFollowOffset();
    } else if (followMode === 'top') {
      const distance = Math.max(controls.minDistance * 2, camera.position.distanceTo(controls.target));
      followOffset = new THREE.Vector3(0, distance, 0.001);
    }
    if (followMode !== 'none' && followTarget) snapToFollowTarget();
    requestRender();
  }

  function moveTargetTo(x, y, z, { animate = false } = {}) {
    if (![x, y, z].every(Number.isFinite)) return;
    scratchVector.set(x, y, z).sub(controls.target);
    if (!animate) {
      camera.position.add(scratchVector);
      controls.target.set(x, y, z);
      lastAppliedTarget.copy(controls.target);
      requestRender();
      return;
    }
    pendingTargetMove = new THREE.Vector3(x, y, z);
  }

  function snapToFollowTarget() {
    if (!followTarget) return;
    smoothedHeadingDeg = followHeadingDeg;
    const worldOffset = followMode === 'chase'
      ? worldOffsetFromHeadingFrame(followOffset, smoothedHeadingDeg)
      : followOffset;
    controls.target.set(followTarget.x, followTarget.y, followTarget.z);
    camera.position.copy(controls.target).add(worldOffset);
    lastAppliedTarget.copy(controls.target);
    suppressUserEvents = true;
    controls.update();
    suppressUserEvents = false;
    requestRender();
  }

  function stepFollow() {
    if (followMode === 'none' || !followTarget) return false;
    let moved = false;
    if (followMode === 'chase') {
      const delta = ((followHeadingDeg - (smoothedHeadingDeg ?? followHeadingDeg) + 540) % 360) - 180;
      if (Math.abs(delta) > 0.05) {
        smoothedHeadingDeg = ((smoothedHeadingDeg ?? followHeadingDeg) + (delta * FOLLOW_HEADING_SMOOTHING) + 360) % 360;
        moved = true;
      } else {
        smoothedHeadingDeg = followHeadingDeg;
      }
    }
    scratchVector.set(followTarget.x, followTarget.y, followTarget.z);
    const targetDistance = scratchVector.distanceTo(controls.target);
    if (targetDistance > 0.01) {
      controls.target.lerp(scratchVector, targetDistance > 50000 ? 1 : FOLLOW_POSITION_SMOOTHING);
      moved = true;
    }
    const worldOffset = followMode === 'chase'
      ? worldOffsetFromHeadingFrame(followOffset, smoothedHeadingDeg)
      : followOffset;
    scratchVector.copy(controls.target).add(worldOffset);
    if (scratchVector.distanceTo(camera.position) > 0.01) {
      camera.position.copy(scratchVector);
      moved = true;
    }
    lastAppliedTarget.copy(controls.target);
    return moved;
  }

  function keepCameraAboveTerrain() {
    if (!terrain) return false;
    const groundY = groundHeightAt(camera.position.x, camera.position.z);
    if (groundY === null) return false;
    const minY = groundY + CAMERA_TERRAIN_CLEARANCE;
    if (camera.position.y >= minY) return false;
    camera.position.y = minY;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Lighting
  // ---------------------------------------------------------------------------

  /**
   * Point the rig at a lighting state from `lightingForSunElevation`, with
   * the sun's sky position. Omit the sun to keep the current direction.
   */
  function setLighting(rig, { sunAzimuthDeg = null, sunElevationDeg = null, immediate = false } = {}) {
    if (disposed || !rig) return;
    lightingTarget.sunIntensity = rig.sunIntensity;
    lightingTarget.sunColor.setHex(rig.sunColor);
    lightingTarget.moonIntensity = rig.moonIntensity;
    lightingTarget.moonColor.setHex(rig.moonColor);
    lightingTarget.hemisphereSky.setHex(rig.hemisphereSky);
    lightingTarget.hemisphereGround.setHex(rig.hemisphereGround);
    lightingTarget.hemisphereIntensity = rig.hemisphereIntensity;
    lightingTarget.fogColor.setHex(rig.fogColor);
    lightingTarget.skyColor.setHex(rig.skyColor);
    lightingTarget.horizonColor.setHex(rig.horizonColor);
    lightingTarget.aircraftEmissive = rig.aircraftEmissive;
    if (Number.isFinite(sunAzimuthDeg) && Number.isFinite(sunElevationDeg)) {
      // Keep the sun a little above the horizon for shading even when it has
      // just set; its intensity is what fades it out.
      const direction = directionFromSky(Math.max(4, sunElevationDeg), sunAzimuthDeg);
      lightingTarget.sunDirection.set(direction.x, direction.y, direction.z).normalize();
      const moonDirection = moonDirectionForSun(sunAzimuthDeg);
      lightingTarget.moonDirection.set(moonDirection.x, moonDirection.y, moonDirection.z).normalize();
    }
    lightingSettling = true;
    if (immediate) stepLighting(1);
    requestRender();
  }

  function stepLighting(factor = LIGHTING_SMOOTHING) {
    if (!lightingSettling) return false;
    const current = lightingCurrent;
    const target = lightingTarget;
    let remaining = 0;
    const lerpNumber = (key) => {
      const delta = target[key] - current[key];
      remaining = Math.max(remaining, Math.abs(delta));
      current[key] += delta * factor;
    };
    const lerpColor = (key) => {
      remaining = Math.max(remaining, Math.abs(target[key].r - current[key].r), Math.abs(target[key].g - current[key].g), Math.abs(target[key].b - current[key].b));
      current[key].lerp(target[key], factor);
    };
    const lerpVector = (key) => {
      remaining = Math.max(remaining, current[key].distanceTo(target[key]));
      current[key].lerp(target[key], factor).normalize();
    };
    lerpNumber('sunIntensity');
    lerpNumber('moonIntensity');
    lerpNumber('hemisphereIntensity');
    lerpNumber('aircraftEmissive');
    lerpColor('sunColor');
    lerpColor('moonColor');
    lerpColor('hemisphereSky');
    lerpColor('hemisphereGround');
    lerpColor('fogColor');
    lerpColor('skyColor');
    lerpColor('horizonColor');
    lerpVector('sunDirection');
    lerpVector('moonDirection');

    sun.intensity = current.sunIntensity;
    sun.color.copy(current.sunColor);
    sun.position.copy(current.sunDirection);
    moon.intensity = current.moonIntensity;
    moon.color.copy(current.moonColor);
    moon.position.copy(current.moonDirection);
    hemisphere.color.copy(current.hemisphereSky);
    hemisphere.groundColor.copy(current.hemisphereGround);
    hemisphere.intensity = current.hemisphereIntensity;
    scene.fog.color.copy(current.fogColor);
    for (const material of aircraftModel.userData.materials || []) {
      material.emissiveIntensity = material.userData.isAccent ? current.aircraftEmissive : current.aircraftEmissive * 0.45;
    }
    // The CSS sky behind the transparent canvas follows the rig.
    containerEl.style?.setProperty?.('--flight-sky-top', `#${current.skyColor.getHexString()}`);
    containerEl.style?.setProperty?.('--flight-sky-horizon', `#${current.horizonColor.getHexString()}`);

    if (remaining < 0.002 || factor >= 1) {
      lightingSettling = false;
      return factor < 1;
    }
    return true;
  }

  function fitToBounds(bounds, { paddingFactor = 1.25 } = {}) {
    if (!bounds || ![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, bounds.minZ, bounds.maxZ].every(Number.isFinite)) return;
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const extentX = Math.max(1, bounds.maxX - bounds.minX);
    const extentY = Math.max(1, bounds.maxY - bounds.minY);
    const extentZ = Math.max(1, bounds.maxZ - bounds.minZ);

    // Look across the long axis of the flight so its profile shows: from the
    // south for an east-west track, from the east for a north-south one,
    // offset a little so depth still reads.
    const azimuthOffset = 0.35;
    const azimuth = extentX >= extentZ ? azimuthOffset : (Math.PI / 2) + azimuthOffset;
    const elevation = followMode === 'top' ? (Math.PI / 2) - 0.001 : 0.72;
    const longAxis = Math.max(extentX, extentZ, 3000);
    const shortAxis = Math.min(extentX, extentZ);
    const verticalFov = THREE.MathUtils.degToRad(CAMERA_FOV_DEG);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const visibleWidth = (longAxis * Math.cos(azimuthOffset)) + (shortAxis * Math.sin(azimuthOffset));
    const visibleHeight = (shortAxis * Math.sin(elevation)) + (longAxis * Math.sin(azimuthOffset) * Math.sin(elevation))
      + (extentY * Math.cos(elevation));
    const distance = Math.min(controls.maxDistance, Math.max(
      controls.minDistance * 4,
      (visibleWidth / 2) / Math.tan(horizontalFov / 2),
      (visibleHeight / 2) / Math.tan(verticalFov / 2),
    ) * paddingFactor);

    controls.target.set(centerX, centerY, centerZ);
    camera.position.set(
      centerX + (distance * Math.sin(azimuth) * Math.cos(elevation)),
      centerY + (distance * Math.sin(elevation)),
      centerZ + (distance * Math.cos(azimuth) * Math.cos(elevation)),
    );
    lastAppliedTarget.copy(controls.target);
    suppressUserEvents = true;
    controls.update();
    suppressUserEvents = false;
    if (followMode !== 'none') captureFollowOffset();
    requestRender();
  }

  function getViewInfo() {
    const distance = camera.position.distanceTo(controls.target);
    const sceneUnitsPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2))) / height;
    return {
      targetX: controls.target.x,
      targetZ: controls.target.z,
      cameraX: camera.position.x,
      cameraY: camera.position.y,
      cameraZ: camera.position.z,
      distance,
      sceneUnitsPerPixel,
      width,
      height,
    };
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  // After any user-driven camera change, decide whether the follow camera
  // keeps its tether (rotate or zoom: remember the new offset) or the user
  // has panned away from the aircraft (hand the camera back to them).
  function reconcileFollowAfterUserChange() {
    if (followMode === 'none') return;
    if (controls.target.distanceTo(lastAppliedTarget) > 0.5) {
      onUserPan();
      return;
    }
    captureFollowOffset();
  }

  function handleControlsChange() {
    requestRender();
    if (suppressUserEvents) return;
    reconcileFollowAfterUserChange();
  }

  function handleControlsEnd() {
    if (suppressUserEvents) return;
    onViewSettled(getViewInfo());
  }

  // Orbit damping, animated moves and following can keep moving the camera
  // after a pointer's end event or the controller's initial tile request.
  // Re-plan once the rendered view settles, including terrain clearance.
  function refreshSettledCameraView() {
    const view = getViewInfo();
    const moved = previousCameraView && ['cameraX', 'cameraY', 'cameraZ', 'targetX', 'targetZ', 'distance']
      .some(key => Math.abs(view[key] - previousCameraView[key]) > 0.01);
    if (!previousCameraView || moved) {
      previousCameraView = view;
      if (moved) cameraViewPending = true;
    } else if (cameraViewPending) {
      cameraViewPending = false;
      onViewSettled(view);
    }
  }

  controls.addEventListener('change', handleControlsChange);
  controls.addEventListener('end', handleControlsEnd);

  function handlePointerDown(event) {
    pointerDown = { x: event.clientX, y: event.clientY, at: Date.now() };
  }

  function handlePointerUp(event) {
    const start = pointerDown;
    pointerDown = null;
    if (!start || sprites.length === 0) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MARKER_CLICK_MAX_DISTANCE_PX) return;
    if (Date.now() - start.at > MARKER_CLICK_MAX_DURATION_MS) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObjects(sprites.filter((sprite) => sprite.userData.markerId != null), false);
    const hit = hits.find((entry) => entry.object?.userData?.markerId != null);
    if (hit) onMarkerClick(hit.object.userData.markerId);
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointerup', handlePointerUp);

  function handleContextLost(event) {
    event.preventDefault?.();
    if (disposed || contextLost) return;
    contextLost = true;
    controls.enabled = false;
    stop();
    consoleRef.warn?.('[FlightScene] WebGL context lost');
    onContextLost();
  }

  function handleContextRestored() {
    if (disposed || !contextLost) return;
    // Three.js registered its restoration listener before ours and rebuilds
    // the renderer. The owning controller decides if this view is still visible.
    contextLost = false;
    controls.enabled = true;
    requestRender();
    onContextRestored();
  }

  canvas.addEventListener('webglcontextlost', handleContextLost);
  canvas.addEventListener('webglcontextrestored', handleContextRestored);

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  function frame() {
    rafId = null;
    if (!active || disposed || contextLost) return;
    rafId = windowRef.requestAnimationFrame(frame);

    if (pendingTargetMove) {
      scratchVector.copy(pendingTargetMove).sub(controls.target);
      const remaining = scratchVector.length();
      if (remaining < 1) {
        moveTargetTo(pendingTargetMove.x, pendingTargetMove.y, pendingTargetMove.z);
        pendingTargetMove = null;
      } else {
        scratchVector.multiplyScalar(0.25);
        camera.position.add(scratchVector);
        controls.target.add(scratchVector);
        lastAppliedTarget.copy(controls.target);
      }
      needsRender = true;
    }

    if (stepFollow()) needsRender = true;
    if (stepLighting()) needsRender = true;

    suppressUserEvents = true;
    const controlsChanged = controls.update();
    suppressUserEvents = false;
    if (controlsChanged) {
      // Damping continues a user gesture after the pointer is released, so
      // it is reconciled the same way as the gesture itself.
      needsRender = true;
      reconcileFollowAfterUserChange();
    }
    if (keepCameraAboveTerrain()) needsRender = true;
    refreshSettledCameraView();
    updateGroundCoverage();

    if (!needsRender) return;
    needsRender = false;
    updateDistanceScaledObjects();
    const viewDistance = Math.max(controls.minDistance, camera.position.distanceTo(controls.target));
    scene.fog.near = viewDistance * FOG_NEAR_FACTOR;
    scene.fog.far = viewDistance * FOG_FAR_FACTOR;
    renderer.render(scene, camera);
  }

  function start() {
    if (disposed || contextLost) return;
    active = true;
    terrainSuspended = false;
    tileLoadsSuspended = false;
    resize();
    requestRender();
    if (rafId == null) rafId = windowRef.requestAnimationFrame(frame);
  }

  function stop() {
    active = false;
    previousCameraView = null;
    cameraViewPending = false;
    terrainSuspended = true;
    tileLoadsSuspended = true;
    for (const key of tileRetryTimers.keys()) cancelTileRetry(key);
    terrainGeneration += 1;
    terrain?.provider.retainTiles([]);
    for (const mesh of tileMeshes.values()) mesh.userData.terrainRequest = null;
    if (terrainNotificationFrame != null) {
      windowRef.cancelAnimationFrame?.(terrainNotificationFrame);
      terrainNotificationFrame = null;
    }
    if (rafId != null) {
      windowRef.cancelAnimationFrame?.(rafId);
      rafId = null;
    }
  }

  function dispose() {
    if (disposed) return;
    stop();
    controls.removeEventListener('change', handleControlsChange);
    controls.removeEventListener('end', handleControlsEnd);
    controls.dispose();
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('webglcontextlost', handleContextLost);
    canvas.removeEventListener('webglcontextrestored', handleContextRestored);
    // Release scene objects before the disposed flag makes the setters no-ops.
    clearMarkers();
    setPins([]);
    setGroundTiles([]);
    setTrack(null);
    setRouteLine(null);
    setTargetLine(null);
    setAltitudeLabel('');
    disposed = true;
    for (const entry of tileTextures.values()) entry.texture?.dispose?.();
    tileTextures.clear();
    tileLoadQueue.clear();
    tileLoadsPending.clear();
    if (groundGrid) {
      scene.remove(groundGrid);
      disposeObject(groundGrid);
      groundGrid = null;
    }
    for (const material of lineMaterials) material.dispose();
    lineMaterials.clear();
    curtainMaterial.dispose();
    pinLineMaterial.dispose();
    stemMaterial.dispose();
    placeholderTileMaterial.dispose();
    if (stem) {
      scene.remove(stem);
      stem.geometry.dispose();
      stem = null;
    }
    rulerTicks.geometry.dispose();
    disposeObject(groundDisc);
    terrain = null;
    disposeAircraftModel(aircraftModel);
    renderer.dispose();
    try {
      renderer.forceContextLoss?.();
    } catch {}
    if (canvas.parentNode === containerEl) containerEl.removeChild(canvas);
  }

  resize();
  setLighting(daylightLighting(), { immediate: true });

  return {
    dispose,
    fitToBounds,
    getViewInfo,
    groundHeightAt,
    hasTerrain: () => Boolean(terrain),
    isActive: () => active,
    moveTargetTo,
    requestRender,
    resize,
    setAircraft,
    setCurtainVisible,
    setFollowMode,
    setGroundGrid,
    setLighting,
    setGroundTiles,
    setMarkers,
    setPins,
    setRouteLine,
    setTargetLine,
    setTrack,
    snapToFollowTarget,
    start,
    stop,
  };
}
