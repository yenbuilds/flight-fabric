export const OPENFREEMAP_DARK_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

export const OPENFREEMAP_ATTRIBUTION = [
  '<a href="https://openfreemap.org/">OpenFreeMap</a>',
  '&copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
].join(' ');

export function createOpenFreeMapDarkLayer(leaflet) {
  if (typeof leaflet?.maplibreGL !== 'function') {
    throw new Error('The bundled MapLibre Leaflet bridge is unavailable.');
  }

  return leaflet.maplibreGL({
    style: OPENFREEMAP_DARK_STYLE_URL,
    attributionControl: {
      customAttribution: OPENFREEMAP_ATTRIBUTION,
    },
    interactive: false,
  });
}
