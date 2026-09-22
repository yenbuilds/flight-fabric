import { loadThree } from '../../frontend/src/maps/three-d/load-three.js';
import { createFlightScene } from '../../frontend/src/maps/three-d/scene.js';

const three = await loadThree();
let scene;
let renderer;
let camera;
let frames;
let loads;
let scale;
const colors = { horizon: [20, 20, 240], base: [240, 20, 20], detail: [20, 240, 20] };
const tiles = [
  { key: 'horizon', url: 'horizon', layer: 'horizon', z: 1, x: 0, y: 0, minX: -20000, maxX: 20000, minZ: -20000, maxZ: 20000 },
  { key: 'base', url: 'base', layer: 'base', z: 3, x: 0, y: 0, minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 },
  { key: 'detail', url: 'detail', layer: 'detail', z: 5, x: 0, y: 0, minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 },
];
const elevations = new Map([['1/0/0', 300], ['3/0/0', 200], ['5/0/0', 100]]
  .map(([key, height]) => [key, new Float32Array(256 * 256).fill(height)]));
const provider = { retainTiles() {}, peekElevations: key => elevations.get(key) };

function renderFrames(count = 4) {
  for (let frame = 0; frame < count; frame += 1) {
    for (const callback of [...frames]) { frames.delete(callback); callback(); }
  }
}

class Renderer extends three.THREE.WebGLRenderer {
  constructor(options) {
    super({ ...options, preserveDrawingBuffer: true });
    renderer = this;
    const draw = this.render.bind(this);
    this.render = (world, view) => { camera = view; draw(world, view); };
  }
}
class TextureLoader {
  setCrossOrigin() {}
  load(url, onLoad) {
    loads.set(url, () => {
      const texture = new three.THREE.DataTexture(new Uint8Array([...colors[url], 255]), 1, 1);
      onLoad(texture);
    });
  }
}

function setTiles(includeDetail = true) {
  scene.setGroundTiles(tiles.filter(tile => includeDetail || tile.layer !== 'detail'), {
    terrain: { provider, unitsPerMeter: scale, floorMeters: 0 },
  });
  renderFrames();
}

window.terrainTest = {
  setup(verticalScale) {
    scene?.dispose();
    scale = verticalScale;
    frames = new Set();
    loads = new Map();
    scene = createFlightScene({
      containerEl: document.getElementById('map'),
      quality: innerWidth < 760 ? 'compact' : 'high',
      three: { ...three, THREE: { ...three.THREE, WebGLRenderer: Renderer, TextureLoader } },
      // A deterministic frame clock avoids native hidden-window throttling.
      windowRef: { devicePixelRatio: 1, requestAnimationFrame(callback) { frames.add(callback); return callback; },
        cancelAnimationFrame(callback) { frames.delete(callback); }, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) },
    });
    scene.start();
    scene.fitToBounds({ minX: -3000, maxX: 3000, minY: 0, maxY: 300 * scale, minZ: -3000, maxZ: 3000 });
    scene.setFollowMode('top');
    setTiles();
  },
  finish(layer) { loads.get(layer)(); renderFrames(); },
  setTiles,
  resize() { scene.resize(); renderFrames(); },
  sample(x = 0, z = 0, height = null) {
    const ground = scene.groundHeightAt(x, z);
    const point = new three.THREE.Vector3(x, height ?? ground ?? 0, z).project(camera);
    const gl = renderer.getContext();
    const pixel = new Uint8Array(4);
    gl.readPixels(Math.floor((point.x + 1) * gl.drawingBufferWidth / 2), Math.floor((point.y + 1) * gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return { pixel: [...pixel], ground };
  },
};
