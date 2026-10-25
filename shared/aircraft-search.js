/* Aircraft search text normalization shared by the app and MSFS Coherent. ES2017. */
(function (root) {
  'use strict';
  function normalizeAircraftSearchText(value) {
    return String(value || '').normalize('NFKD')
      .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
      .replace(/\brwy\b/g, 'runway').replace(/\bhdg\b/g, 'heading')
      .replace(/\btrk\b/g, 'track').replace(/\bspd\b/g, 'speed')
      .replace(/\bv\s*\/\s*s\b/g, 'vertical speed').replace(/\balt\b/g, 'altitude')
      .replace(/\beng\b/g, 'engine').replace(/\ba\s*\/\s*t\b/g, 'autothrottle')
      .replace(/\bturnoff\b/g, 'turn off').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  var api = Object.freeze({ normalizeAircraftSearchText: normalizeAircraftSearchText });
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FlightFabricAircraftSearch = api;
// @ts-expect-error Legacy Coherent has window; the Node typecheck has no DOM globals.
})(typeof globalThis !== 'undefined' ? globalThis : window);
