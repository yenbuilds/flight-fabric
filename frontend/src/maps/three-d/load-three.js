// three.js is only needed once a 3D view is opened, so it stays out of the
// main bundle and loads as its own chunk on first use. A failed load is not
// cached so a later switch can retry after a transient problem.

let threePromise = null;

export function loadThree() {
  if (!threePromise) {
    threePromise = Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
      import('three/addons/lines/LineSegments2.js'),
      import('three/addons/lines/LineSegmentsGeometry.js'),
      import('three/addons/lines/LineMaterial.js'),
    ]).then(([THREE, orbit, lineSegments, lineSegmentsGeometry, lineMaterial]) => ({
      THREE,
      OrbitControls: orbit.OrbitControls,
      LineSegments2: lineSegments.LineSegments2,
      LineSegmentsGeometry: lineSegmentsGeometry.LineSegmentsGeometry,
      LineMaterial: lineMaterial.LineMaterial,
    })).catch((error) => {
      threePromise = null;
      throw error;
    });
  }
  return threePromise;
}
