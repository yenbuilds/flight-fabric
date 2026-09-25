'use strict';

// Monochrome adaptation of frontend/icons/icon-512.svg: broken outer orbit,
// inner orbit, curved flight trail and northeast-pointing aircraft.
// The native toolbar can override SVG fills. Expand every ring into a solid,
// closed contour so forced fills cannot turn open stroked arcs into wedges.
// Absolute M/L/Z geometry avoids stroke, transforms, masks and hole fill rules.

// Inset the artwork within the native 64px button to match nearby toolbar icons.
const ARTWORK_SCALE = 0.75;

function arcPoints(cx, cy, radius, start, end) {
  const steps = Math.max(1, Math.ceil(Math.abs(end - start) / 5));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (start + (end - start) * index / steps) * Math.PI / 180;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

function orbit(radius, start, end, width) {
  const half = width / 2;
  const endCenter = arcPoints(32, 32, radius, end, end)[0];
  const startCenter = arcPoints(32, 32, radius, start, start)[0];
  return [
    ...arcPoints(32, 32, radius + half, start, end),
    ...arcPoints(...endCenter, half, end, end + 180).slice(1),
    ...arcPoints(32, 32, radius - half, end, start).slice(1),
    ...arcPoints(...startCenter, half, start + 180, start + 360).slice(1),
  ];
}

function bezier(points) {
  return Array.from({ length: 21 }, (_, index) => {
    const t = index / 20, u = 1 - t;
    return [0, 1].map(axis => u * u * u * points[0][axis]
      + 3 * u * u * t * points[1][axis]
      + 3 * u * t * t * points[2][axis] + t * t * t * points[3][axis]);
  });
}

function contour(points) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.map(value => Number((32 + (value - 32) * ARTWORK_SCALE).toFixed(2))).join(' ')}`).join('') + 'Z';
}

function renderToolbarIcon() {
  const paths = [
    orbit(22.5, 145, 309, 4),
    orbit(22.5, -12, 76, 4),
    orbit(13.5, 145, 309, 3.6),
    [
      ...bezier([[8, 53], [18, 51.5], [28, 44.5], [36, 35]]),
      ...bezier([[37, 36.1], [29.5, 47.5], [19.5, 54.5], [9.5, 57]]),
    ],
    [[49, 18.9], [42.1, 40.2], [37.9, 33.4], [30.8, 29.8]],
  ];
  return '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">\n'
    + '  <title>ICON_TOOLBAR_FLIGHTFABRIC</title>\n'
    + paths.map(points => `  <path d="${contour(points)}" fill="#ffffff" />\n`).join('')
    + '</svg>\n';
}

module.exports = { renderToolbarIcon };
