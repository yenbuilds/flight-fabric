import L from 'leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// The existing map controllers intentionally consume Leaflet through the
// browser global. Populate that global from the bundled npm dependency so the
// desktop and LAN-browser builds use the same audited implementation.
if (typeof L.maplibreGL !== 'function') {
  L.maplibreGL = maplibreGL;
}

window.L = L;
