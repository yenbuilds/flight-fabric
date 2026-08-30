import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// The existing map controllers intentionally consume Leaflet through the
// browser global. Populate that global from the bundled npm dependency so the
// desktop and LAN-browser builds use the same audited implementation.
window.L = L;
