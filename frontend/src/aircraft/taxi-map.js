// A fixed, north-up route diagram for the simulator toolbar. Its geometry uses
// open strokes only; live position changes move one retained aircraft marker.
const NS = 'http://www.w3.org/2000/svg';
const views = new WeakMap();
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const samePoint = (a, b) => a.x === b.x && a.z === b.z;
const rounded = n => Math.round(n * 1000) / 1000;

function set(node, name, value) {
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}
function clear(root) {
  while (root.firstChild) root.removeChild(root.firstChild);
  views.delete(root);
}
function geometry(route) {
  if (!Array.isArray(route?.points) || !route.points.every(finitePoint)) return null;
  const points = route.points.filter((p, i, all) => !i || !samePoint(p, all[i - 1]));
  if (points.length < 2) return null;
  const stand = route.kind === 'stand';
  // The route ends at the aircraft reference's safe stopping point. The actual
  // holding line can be farther ahead to leave clearance for the aircraft nose.
  const destination = points[points.length - 1];
  let minX = destination.x, maxX = destination.x, minZ = destination.z, maxZ = destination.z;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const width = maxX - minX, height = maxZ - minZ;
  if (![width, height].every(Number.isFinite)) return null;
  const scale = Math.min(304 / Math.max(50, width), 244 / Math.max(50, height));
  // Offset before scaling: the aircraft never changes this route-based extent.
  const xy = p => ({ x: rounded(28 + (304 - width * scale) / 2 + (p.x - minX) * scale),
    y: rounded(28 + (244 - height * scale) / 2 + (maxZ - p.z) * scale) });
  const projected = points.map(xy).filter((p, i, all) => !i || p.x !== all[i - 1].x || p.y !== all[i - 1].y);
  if (projected.length < 2) return null;
  const key = JSON.stringify([stand, points.map(p => [p.x, p.z])]);
  return { key, stand, projected, destination: xy(destination), xy };
}
function build(root, shape) {
  clear(root);
  function node(tag, attributes, parent = root) {
    const result = root.ownerDocument.createElementNS(NS, tag);
    for (const name of Object.keys(attributes)) result.setAttribute(name, String(attributes[name]));
    parent.appendChild(result); return result;
  }
  function line(a, b, className, extra = {}, parent = root) {
    if (a.x === b.x && a.y === b.y) return null;
    return node('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: className,
      fill: 'none', 'stroke-linecap': 'butt', ...extra }, parent);
  }
  const route = node('polyline', { points: shape.projected.map(p => p.x + ',' + p.y).join(' '),
    class: 'taxi-simple-route', fill: 'none', 'stroke-linejoin': 'bevel', 'stroke-linecap': 'butt', 'data-taxi-route': '' });
  const end = shape.destination;
  if (shape.stand) {
    line({ x: end.x - 5, y: end.y }, { x: end.x + 5, y: end.y }, 'taxi-simple-destination');
    line({ x: end.x, y: end.y - 5 }, { x: end.x, y: end.y + 5 }, 'taxi-simple-destination');
  } else {
    const before = shape.projected[shape.projected.length - 2];
    const length = Math.hypot(end.x - before.x, end.y - before.y);
    const nx = -(end.y - before.y) / length * 7, ny = (end.x - before.x) / length * 7;
    line({ x: rounded(end.x + nx), y: rounded(end.y + ny) }, { x: rounded(end.x - nx), y: rounded(end.y - ny) },
      'taxi-simple-hold', { 'data-taxi-hold': '' });
  }
  const north = node('text', { x: 340, y: 19, 'text-anchor': 'end', class: 'taxi-simple-label', 'aria-hidden': 'true' });
  north.textContent = 'N';
  const marker = node('g', { class: 'taxi-simple-aircraft', fill: 'none', display: 'none', 'data-taxi-aircraft': '' });
  line({ x: 0, y: -9 }, { x: 0, y: 7 }, '', {}, marker);
  line({ x: -6, y: 1 }, { x: 6, y: 1 }, '', {}, marker);
  line({ x: -3, y: 6 }, { x: 3, y: 6 }, '', {}, marker);
  const view = { key: shape.key, route, marker, xy: shape.xy };
  views.set(root, view); return view;
}

/** Aircraft must be null when its position is stale. The caller owns caption/ARIA text. */
export function renderTaxiMap(root, route, aircraft) {
  set(root, 'viewBox', '0 0 360 300');
  set(root, 'data-taxi-map', '2d');
  const shape = geometry(route);
  if (!shape) { clear(root); return false; }
  let view = views.get(root);
  if (!view || view.key !== shape.key || !root.contains(view.route) || !root.contains(view.marker)) view = build(root, shape);
  const pose = finitePoint(aircraft) && Number.isFinite(aircraft.headingDeg) ? view.xy(aircraft) : null;
  // Do not clamp an aircraft onto the diagram edge and imply a false position.
  const visible = pose && Number.isFinite(pose.x) && Number.isFinite(pose.y)
    && pose.x >= 10 && pose.x <= 350 && pose.y >= 10 && pose.y <= 290;
  set(view.marker, 'display', visible ? 'inline' : 'none');
  if (visible) set(view.marker, 'transform', 'translate(' + pose.x + ',' + pose.y + ') rotate('
    + rounded(((aircraft.headingDeg % 360) + 360) % 360) + ')');
  return true;
}
