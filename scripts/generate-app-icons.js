#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'readme-assets/flightfabric-logo.svg';
const ICO_SIZES = [16, 20, 24, 28, 32, 40, 48, 56, 64, 128, 256];
const TRAY_BADGE = { cx: 444, cy: 68, outer: 66, ring: 60, fill: 48 };
const STATES = { recording: '#ef4444', finalizing: '#f59e0b' };

// The full logo's tile and fine strokes work at illustration sizes, but leave
// the actual mark only eight pixels wide in a 16px tray slot. Derive the small
// mark from the same paths: enlarge it, strengthen the ring, and omit the fold
// and dark trail fade that cannot survive a handful of pixels.
function compactLogo(svg) {
  const geometry = svg.match(/<\/defs>([\s\S]*?)<\/svg>/)?.[1];
  if (!geometry) throw new Error('Logo master is missing its vector geometry.');
  const mark = geometry
    .replace(/\s*<rect\b[^>]*\/>/g, '')
    .replace(/\s*<path\b[^>]*fill="url\(#fold\)"[^>]*\/>/g, '')
    .replaceAll('stroke-width="15.8"', 'stroke-width="26"')
    .replace('fill="#fefefe"', 'fill="#fefefe" stroke="#031027" stroke-width="8" stroke-linejoin="round"')
    .replace(/(<path\b[^>]*fill="#fefefe"[^>]*\/>)/,
      '<g transform="translate(278 235) scale(1.12) translate(-278 -235)">$1</g>');
  return svg
    .replace(/<desc[^>]*>[\s\S]*?<\/desc>/, '<desc id="desc">FlightFabric small-size mark: a white paper plane and blue-to-magenta orbit.</desc>')
    .replace(/(<linearGradient id="trail"[^>]*>)[\s\S]*?(<\/linearGradient>)/,
      '$1<stop offset="0" stop-color="#2091f6"/><stop offset="0.5" stop-color="#6240c4"/><stop offset="1" stop-color="#c32cc1"/>$2')
    .replace(/<\/defs>[\s\S]*?<\/svg>/,
      `</defs>\n  <g transform="translate(256 256) scale(1.72) translate(-256 -251)">${mark}  </g>\n</svg>`);
}

function renderPng(svg, size, background) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    ...(background ? { background } : {}),
  }).render().asPng();
}

function withBadge(svg, colour) {
  const { cx, cy, outer, ring, fill } = TRAY_BADGE;
  return svg.replace('</svg>', [
    `<circle cx="${cx}" cy="${cy}" r="${outer}" fill="#031027"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${ring}" fill="#f8fbff"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${fill}" fill="${colour}"/>`,
    '</svg>',
  ].join('\n'));
}

function overlaySvg(colour) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="15" fill="#031027"/>
    <circle cx="16" cy="16" r="13" fill="#f8fbff"/>
    <circle cx="16" cy="16" r="10" fill="${colour}"/>
  </svg>`;
}

function renderIco(svg) {
  // Render each frame directly from the vector master, including 16/20/24px.
  const frames = ICO_SIZES.map(size => ({ size, png: renderPng(svg, size) }));
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(frame => frame.png)]);
}

function buildAssets(root = ROOT) {
  const svg = fs.readFileSync(path.join(root, SOURCE), 'utf8');
  if (!svg.includes('viewBox="0 0 512 512"') || /<(?:image|script)\b|\bhref=/i.test(svg)) {
    throw new Error('The logo master must be a standalone 512-unit vector SVG.');
  }
  const compact = compactLogo(svg);
  const assets = new Map();
  const pngCache = new Map();
  const png = (size, background) => {
    const key = `${size}:${background || ''}`;
    if (!pngCache.has(key)) pngCache.set(key, renderPng(svg, size, background));
    return pngCache.get(key);
  };
  for (const file of ['readme-assets/flight-fabric-icon.png', 'ff-logo2.png', 'frontend/assets/app-icon.png']) {
    assets.set(file, png(512));
  }
  assets.set('electron/icon.png', png(1024));
  assets.set('frontend/assets/app-mark.svg', Buffer.from(compact));
  assets.set('electron/launcher/icon.svg', Buffer.from(compact));
  assets.set('electron/launcher/icon.png', renderPng(compact, 256));
  assets.set('electron/taskbar-icon.png', renderPng(compact, 256));
  assets.set('electron/taskbar-icon.svg', Buffer.from(compact));
  const ico = renderIco(compact);
  assets.set('electron/icon.ico', ico);
  assets.set('electron/taskbar-icon.ico', ico);
  for (const size of [192, 512]) {
    assets.set(`frontend/icons/icon-${size}.svg`, Buffer.from(
      compact.replace('width="512" height="512"', `width="${size}" height="${size}"`),
    ));
  }
  for (const [state, colour] of Object.entries(STATES)) {
    assets.set(`electron/taskbar-${state}-icon.png`, renderPng(withBadge(compact, colour), 256));
    assets.set(`electron/taskbar-${state}-icon.ico`, renderIco(withBadge(compact, colour)));
    assets.set(`electron/${state}-overlay.png`, renderPng(overlaySvg(colour), 32));
  }
  // These private-repository surfaces are absent from the public desktop export.
  if (fs.existsSync(path.join(root, 'site/flightfabric'))) {
    assets.set('site/flightfabric/assets/flight-fabric-icon.png', png(512));
    assets.set('site/flightfabric/assets/flight-fabric-icon-96.png', png(96));
  }
  if (fs.existsSync(path.join(root, 'apps/mobile'))) {
    assets.set('apps/mobile/assets/icon.png', png(1024, '#020d27'));
    assets.set('apps/mobile/assets/splash-icon.png', png(200));
    assets.set('apps/mobile/assets/favicon.png', png(32));
  }
  return assets;
}

function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: node scripts/generate-app-icons.js [--check]');
  const check = args.includes('--check');
  const assets = buildAssets();
  const changed = [];
  for (const [file, data] of assets) {
    const target = path.join(ROOT, file);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(data)) continue;
    changed.push(file);
    if (!check) fs.writeFileSync(target, data);
  }
  if (check && changed.length) {
    console.error(`Logo assets need regeneration:\n${changed.join('\n')}`);
    return 1;
  }
  console.log(`${check ? 'Verified' : 'Generated'} ${assets.size} FlightFabric logo assets from ${SOURCE}; ${changed.length} ${check ? 'stale' : 'updated'}.`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildAssets, compactLogo, renderPng, renderIco, withBadge, overlaySvg, ICO_SIZES, TRAY_BADGE };
