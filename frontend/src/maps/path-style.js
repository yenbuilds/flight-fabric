export const FLIGHT_TRACK_STYLE = Object.freeze({
  color: '#00d4ff',
  weight: 3.5,
  opacity: 1,
  className: 'flight-track-line',
  interactive: false,
});

// A separate stroke works with both Leaflet's SVG and canvas renderers.
// Keep geometry, dash spacing and renderer identical to the foreground path.
export function createMapPathOutline(leaflet, latLngs, options) {
  return leaflet.polyline(latLngs, {
    ...options,
    color: '#152536',
    weight: options.weight + 2,
    opacity: 1,
    className: 'flight-path-outline',
    interactive: false,
  });
}
