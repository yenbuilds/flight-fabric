import { splitRoute } from './taxi-progress.js';

const plane = 'M0,-12L3,-4L11,2L11,5L3,2L3,8L6,10L6,12L0,10L-6,12L-6,10L-3,8L-3,2L-11,5L-11,2L-3,-4Z';
const point = p => p && [p.x, p.z].every(Number.isFinite);
const views = new WeakMap();
const amber = 'var(--taxi-pushback, #e8b35c)', green = 'var(--taxi-success, #34d399)';
export function pushbackCaption(data, fresh = true) {
  const p = data?.pushbackPreview;
  if (!p) return '';
  const heading = String(Math.round(p.headingDeg) % 360).padStart(3, '0') + '°';
  const stage = p.phase === 'complete' ? 'Pushback complete' : p.phase === 'connecting' ? 'Connecting tug' : p.phase === 'stopping' ? 'Stopping pushback' : p.phase === 'pushing' ? 'Pushback in progress' : 'Pushback preview';
  const remaining = Math.round(Number.isFinite(p.remainingM) ? p.remainingM : p.lengthM);
  const detail = p.phase === 'complete' ? ' · Taxi to runway ' + p.runway + '.'
    : ' · ' + remaining + (p.phase === 'preview' ? ' m reverse' : ' m remaining') + ' · Finish facing ' + heading + ' · Then taxi to runway ' + p.runway + '.';
  return (!fresh ? 'Reference only · Live position unavailable. ' : '') + stage + detail;
}

/** The same north-up departure diagram in Vue and Coherent. It fits the whole
 * reversing path, with a short onward taxi leg, rather than shrinking the
 * pushback to a dot inside an airport-wide view. This SVG has no input handlers. */
export function renderPushbackMap(root, data, fresh = true) {
  root.setAttribute('viewBox', '0 0 360 300'); root.setAttribute('role', 'img'); root.setAttribute('focusable', 'false');
  root.setAttribute('aria-label', pushbackCaption(data, fresh));
  root.setAttribute('data-pushback-map', '');
  const preview = data?.pushbackPreview, points = preview?.points;
  if (!Array.isArray(points) || points.length < 2 || !points.every(point) || !Number.isFinite(preview.headingDeg)) {
    while (root.firstChild) root.removeChild(root.firstChild);
    views.delete(root); return;
  }
  // A preview ID owns immutable geometry. Keep its SVG nodes between telemetry
  // samples so the live marker can interpolate without rebuilding the map.
  let view = views.get(root);
  if (!view || view.id !== preview.id || view.sceneKey !== data.scene?.key || !root.contains(view.background)) {
    while (root.firstChild) root.removeChild(root.firstChild);
    view = buildMap(root, data); views.set(root, view);
  }
  const completed = preview.phase === 'complete', color = completed ? green : amber;
  const aircraft = fresh && point(data.aircraft) && Number.isFinite(data.aircraft.headingDeg) ? data.aircraft : null;
  const progress = splitRoute(points, aircraft);
  view.ahead.setAttribute('points', view.coordinates(completed ? [] : progress.ahead));
  view.finish.setAttribute('stroke', color);
  view.title.setAttribute('fill', fresh ? color : 'var(--taxi-aircraft, #e8eef5)');
  view.title.textContent = !fresh ? 'Reference only' : completed ? 'Pushback complete' : preview.phase === 'connecting' ? 'Connecting tug' : preview.phase === 'pushing' ? 'Pushing back'
    : preview.phase === 'stopping' ? 'Stopping…' : 'Pushback preview';
  const remaining = Number.isFinite(preview.remainingM) ? preview.remainingM : preview.lengthM;
  view.distance.textContent = !fresh ? '' : completed ? 'Ready to taxi' : Math.round(remaining) + (preview.phase === 'preview' ? ' m reverse' : ' m left');
  view.distance.setAttribute('fill', completed ? green : 'var(--taxi-aircraft, #e8eef5)');
  const measured = fresh && Number.isFinite(remaining) && preview.lengthM > 0 && ['pushing', 'stopping', 'complete'].includes(preview.phase);
  const fraction = measured ? completed ? 1 : Math.max(0, Math.min(1, 1 - remaining / preview.lengthM)) : 0;
  view.track.setAttribute('opacity', measured ? 0.2 : 0);
  view.meter.setAttribute('opacity', measured ? 1 : 0);
  view.meter.setAttribute('stroke', color);
  view.meter.setAttribute('data-pushback-progress', measured ? Math.round(fraction * 100) : '');
  view.meter.setAttribute('style', 'transition:stroke-dashoffset var(--taxi-motion-duration, 250ms) linear;stroke-dashoffset:' + 328 * (1 - fraction));
  if (aircraft) {
    const a = view.xy(aircraft), continuing = Boolean(view.aircraft);
    if (!continuing) view.aircraft = view.svg('path', { d: plane, fill: 'var(--taxi-aircraft, #e8eef5)',
      stroke: 'var(--taxi-ground, #141d28)', 'stroke-width': 1, 'data-pushback-aircraft': '' });
    // Heading can wrap through north. Interpolate the shortest turn, not 359°.
    view.heading = continuing ? view.heading + ((aircraft.headingDeg - view.heading + 540) % 360 + 360) % 360 - 180 : aircraft.headingDeg;
    view.aircraft.setAttribute('transform', 'translate(' + a.join(',') + ') rotate(' + view.heading + ')');
    view.aircraft.setAttribute('style', 'transition:transform ' + (continuing ? 'var(--taxi-motion-duration, 250ms)' : '0ms')
      + ' linear;transform:translate(' + a[0] + 'px,' + a[1] + 'px) rotate(' + view.heading + 'deg)');
  } else if (view.aircraft) {
    // Loss of freshness removes the marker immediately, including any motion
    // still interpolating. Recovery starts at the new observed position.
    root.removeChild(view.aircraft); view.aircraft = null;
  }
}

function buildMap(root, data) {
  const preview = data.pushbackPreview, points = preview.points;
  const finish = points[points.length - 1], taxi = (data.route?.points || []).filter(point);
  const onward = taxi.length ? [taxi[0]] : [];
  let length = 0;
  for (let i = 1; i < taxi.length && length < 55; i++) {
    const a = taxi[i - 1], b = taxi[i], segment = Math.hypot(b.x - a.x, b.z - a.z);
    const f = Math.min(1, (55 - length) / (segment || 1));
    onward.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f }); length += segment;
  }
  const all = points.concat(onward), xs = all.map(p => p.x), zs = all.map(p => p.z);
  const minX = Math.min(...xs) - 16, maxX = Math.max(...xs) + 16, minZ = Math.min(...zs) - 16, maxZ = Math.max(...zs) + 16;
  const scale = Math.min(312 / Math.max(60, maxX - minX), 232 / Math.max(60, maxZ - minZ));
  const xy = p => [180 + (p.x - (minX + maxX) / 2) * scale, 150 - (p.z - (minZ + maxZ) / 2) * scale];
  const svg = (tag, attrs, text) => {
    const node = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs).forEach(key => node.setAttribute(key, String(attrs[key])));
    if (text !== undefined) node.textContent = text;
    root.appendChild(node); return node;
  };
  const coordinates = ps => ps.map(p => xy(p).join(',')).join(' ');
  const line = (ps, attrs) => svg('polyline', { points: coordinates(ps), fill: 'none',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs });
  const background = svg('rect', { width: 360, height: 300, fill: 'var(--taxi-ground, #141d28)' });
  for (const l of data.scene?.links || []) {
    if (!point(l.a) || !point(l.b) || !Number.isFinite(l.widthM)) continue;
    if (Math.max(l.a.x, l.b.x) < minX || Math.min(l.a.x, l.b.x) > maxX || Math.max(l.a.z, l.b.z) < minZ || Math.min(l.a.z, l.b.z) > maxZ) continue;
    line([l.a, l.b], { stroke: 'var(--taxi-pavement, #293748)', 'stroke-width': Math.max(2, Math.min(80, l.widthM) * scale) });
  }
  line(onward, { stroke: 'var(--taxi-route, #5aa2ff)', 'stroke-width': 4, 'stroke-dasharray': '5 5', 'data-taxi-onward': '' });
  line(points, { stroke: amber, 'stroke-width': 4, opacity: 0.35 });
  const ahead = line(points, { stroke: amber, 'stroke-width': 4, 'data-pushback-path': '' });
  const end = xy(finish);
  const finishMarker = svg('path', { d: plane, transform: 'translate(' + end.join(',') + ') rotate(' + preview.headingDeg + ')',
    fill: 'var(--taxi-ground, #141d28)', stroke: 'var(--taxi-pushback, #e8b35c)', 'stroke-width': 1.5, 'data-pushback-final-heading': preview.headingDeg });
  const title = svg('text', { x: 16, y: 23, 'font-size': 14 });
  svg('text', { x: 16, y: 283, fill: 'var(--taxi-route, #5aa2ff)', 'font-size': 12 }, 'Then taxi → Runway ' + preview.runway);
  const distance = svg('text', { x: 344, y: 283, 'text-anchor': 'end', 'font-size': 12 });
  svg('text', { x: 341, y: 23, fill: 'var(--taxi-aircraft, #e8eef5)', 'text-anchor': 'end', 'font-size': 11 }, 'N ↑');
  const rail = { x1: 16, x2: 344, y1: 35, y2: 35, stroke: amber, 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': true };
  const track = svg('line', rail), meter = svg('line', { ...rail, 'stroke-dasharray': 328 });
  return { id: preview.id, sceneKey: data.scene?.key, background, ahead, finish: finishMarker, title, distance, track, meter,
    xy, coordinates, svg, aircraft: null, heading: 0 };
}
