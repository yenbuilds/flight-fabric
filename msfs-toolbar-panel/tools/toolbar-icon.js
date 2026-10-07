'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The native toolbar forces white fills. Flatten the shared vector master into
// closed filled contours so strokes cannot turn into wedges in Coherent GT.
const SOURCE = path.resolve(__dirname, '../../readme-assets/flightfabric-logo.svg');

function bezier(points) {
  return Array.from({ length: 25 }, (_, index) => {
    const t = index / 24, u = 1 - t;
    return [0, 1].map(axis => u * u * u * points[0][axis]
      + 3 * u * u * t * points[1][axis]
      + 3 * u * t * t * points[2][axis] + t * t * t * points[3][axis]);
  });
}

function flatten(data) {
  if (/[^MCQLZ0-9.\s,-]/.test(data)) throw new Error('Unsupported logo path command.');
  const tokens = data.match(/[MCQLZ]|-?\d+(?:\.\d+)?/g);
  const points = [];
  let current = [0, 0];
  let index = 0;
  const pair = () => {
    const result = [Number(tokens[index++]), Number(tokens[index++])];
    if (!result.every(Number.isFinite)) throw new Error('Invalid logo path coordinates.');
    return result;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'Z') break;
    if (command === 'M' || command === 'L') {
      current = pair();
      points.push(current);
    } else if (command === 'C') {
      const first = pair(), second = pair(), end = pair();
      points.push(...bezier([current, first, second, end]).slice(1));
      current = end;
    } else if (command === 'Q') {
      const control = pair(), end = pair();
      const first = current.map((value, axis) => value + (control[axis] - value) * 2 / 3);
      const second = end.map((value, axis) => value + (control[axis] - value) * 2 / 3);
      points.push(...bezier([current, first, second, end]).slice(1));
      current = end;
    } else {
      throw new Error(`Unsupported logo path command: ${command}`);
    }
  }
  return points;
}

function arc(cx, cy, radius, start, sweep, steps = 16) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = start + sweep * index / steps;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

function expandStroke(points, width) {
  const radius = width / 2;
  const normals = points.map((point, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    return Math.atan2(after[1] - before[1], after[0] - before[0]) + Math.PI / 2;
  });
  const side = sign => points.map((point, index) => [
    point[0] + sign * radius * Math.cos(normals[index]),
    point[1] + sign * radius * Math.sin(normals[index]),
  ]);
  const last = points.length - 1;
  return [
    ...side(1),
    ...arc(...points[last], radius, normals[last], -Math.PI).slice(1),
    ...side(-1).reverse().slice(1),
    ...arc(...points[0], radius, normals[0] + Math.PI, -Math.PI).slice(1),
  ];
}

function contour(points) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.map(value => Number((value / 8).toFixed(2))).join(' ')}`).join('') + 'Z';
}

function renderToolbarIcon() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const paths = [];
  for (const match of source.matchAll(/<path\b([^>]+)>/g)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
    // The folded plane facet is already covered by its full white silhouette.
    if (attributes.fill === 'url(#fold)') continue;
    const points = flatten(attributes.d);
    paths.push(attributes.fill === 'none' ? expandStroke(points, Number(attributes['stroke-width'])) : points);
  }
  for (const match of source.matchAll(/<circle\b([^>]+)>/g)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
    paths.push(arc(Number(attributes.cx), Number(attributes.cy), Number(attributes.r), 0, Math.PI * 2, 32));
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">\n'
    + '  <title>ICON_TOOLBAR_FLIGHTFABRIC</title>\n'
    + paths.map(points => `  <path d="${contour(points)}" fill="#ffffff" />\n`).join('')
    + '</svg>\n';
}

module.exports = { renderToolbarIcon };
