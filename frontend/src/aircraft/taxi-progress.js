// Split the route at the aircraft's projection so the travelled part dims.
export function splitRoute(points, a) {
  if (!a) return { done: [], ahead: points, distanceM: null };
  let best = { d: Infinity, i: 0, p: points[0] };
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];
    const l2 = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    const t = l2 ? Math.max(0, Math.min(1, ((a.x - p.x) * (q.x - p.x) + (a.z - p.z) * (q.z - p.z)) / l2)) : 0;
    const point = { x: p.x + t * (q.x - p.x), z: p.z + t * (q.z - p.z) };
    const d = Math.hypot(a.x - point.x, a.z - point.z);
    if (d < best.d) best = { d, i, p: point };
  }
  if (best.d > 25) return { done: [], ahead: points, distanceM: best.d };
  return { done: [...points.slice(0, best.i + 1), best.p], ahead: [best.p, ...points.slice(best.i + 1)], distanceM: best.d };
}
