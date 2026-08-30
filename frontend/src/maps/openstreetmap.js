export const OPENSTREETMAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const OPENSTREETMAP_ATTRIBUTION = [
  '&copy;',
  '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  'contributors',
].join(' ');

export function createOpenStreetMapLayer(leaflet) {
  if (typeof leaflet?.tileLayer !== 'function') {
    throw new Error('The bundled Leaflet tile layer is unavailable.');
  }

  return leaflet.tileLayer(OPENSTREETMAP_TILE_URL, {
    attribution: OPENSTREETMAP_ATTRIBUTION,
    maxNativeZoom: 19,
    maxZoom: 19,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 1,
  });
}
