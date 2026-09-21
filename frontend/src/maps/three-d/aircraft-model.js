// A low-polygon airliner silhouette for the 3D views. Built from primitives
// so it needs no model asset or loader; about 40 m long at scale 1 with the
// nose toward -z, wings along x and the fin up +y, matching the scene axes.

function buildPlanform(THREE, { rootLeading, rootTrailing, tipLeading, tipTrailing, halfSpan }) {
  // Shape coordinates are (span, forward-positive-z) and the extrusion is the
  // thickness; rotating about x afterwards maps the shape's y onto scene z.
  const shape = new THREE.Shape();
  shape.moveTo(0, rootLeading);
  shape.lineTo(halfSpan, tipLeading);
  shape.lineTo(halfSpan, tipTrailing);
  shape.lineTo(0, rootTrailing);
  shape.lineTo(-halfSpan, tipTrailing);
  shape.lineTo(-halfSpan, tipLeading);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.6, bevelEnabled: false });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0.3, 0);
  return geometry;
}

function buildFin(THREE) {
  // Shape coordinates are (forward-positive-z, up); the extrusion becomes the
  // fin thickness along x after rotating about y.
  const shape = new THREE.Shape();
  shape.moveTo(11, 0);
  shape.lineTo(17, 0);
  shape.lineTo(17, 5.5);
  shape.lineTo(14.5, 5.5);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(0.25, 0, 0);
  return geometry;
}

export function buildAircraftModel(THREE, { color = 0x31dc7e, trim = 0xf2f5f7 } = {}) {
  const group = new THREE.Group();
  // Both materials carry an emissive term so the scene can lift the model
  // out of the dark at night without changing its daytime look.
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: trim,
    metalness: 0.15,
    roughness: 0.55,
    emissive: trim,
    emissiveIntensity: 0.08,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.5,
    emissive: color,
    emissiveIntensity: 0.18,
  });
  accentMaterial.userData.isAccent = true;

  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 30, 14), bodyMaterial);
  fuselage.rotation.x = Math.PI / 2;
  fuselage.position.z = 1;
  group.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.7, 6, 14), bodyMaterial);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -17;
  group.add(nose);

  const tail = new THREE.Mesh(new THREE.ConeGeometry(1.7, 8, 14), bodyMaterial);
  tail.rotation.x = Math.PI / 2;
  tail.position.z = 20;
  group.add(tail);

  const wings = new THREE.Mesh(buildPlanform(THREE, {
    rootLeading: -2,
    rootTrailing: 6,
    tipLeading: 3.5,
    tipTrailing: 6,
    halfSpan: 17,
  }), accentMaterial);
  wings.position.y = -0.9;
  group.add(wings);

  const stabilizer = new THREE.Mesh(buildPlanform(THREE, {
    rootLeading: 13,
    rootTrailing: 17,
    tipLeading: 15.5,
    tipTrailing: 17,
    halfSpan: 6.5,
  }), accentMaterial);
  stabilizer.position.y = 0.4;
  group.add(stabilizer);

  const fin = new THREE.Mesh(buildFin(THREE), accentMaterial);
  group.add(fin);

  const engineGeometry = new THREE.CylinderGeometry(1.15, 1.15, 5, 12);
  for (const side of [-1, 1]) {
    const engine = new THREE.Mesh(engineGeometry, bodyMaterial);
    engine.rotation.x = Math.PI / 2;
    engine.position.set(side * 6.5, -2.2, 1.5);
    group.add(engine);
  }

  group.userData.materials = [bodyMaterial, accentMaterial];
  return group;
}

export function disposeAircraftModel(model) {
  if (!model) return;
  model.traverse((child) => {
    child.geometry?.dispose?.();
  });
  for (const material of model.userData?.materials || []) {
    material.dispose?.();
  }
}
