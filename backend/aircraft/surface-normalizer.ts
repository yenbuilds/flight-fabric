// Surface broadcast normalizer. The compiled runtime module is imported as
// surface-normalizer.js; this source keeps the legacy HUD contract in one place:
// every telemetry tick must broadcast a surface object, even when providers omit it.

'use strict';

const { decodeSurfaceType } = require('../utils/helpers.js') as {
  decodeSurfaceType: (raw: number, wow: boolean, onAnyRunway?: boolean) => Record<string, any>;
};

/**
 * Normalize a surface payload for WS broadcast.
 *
 * Some providers/frames may omit `surface`. The legacy HUD expects a
 * `{ type: 'surface', value: <object> }` message; if it isn't emitted, SURFACE
 * and ON GROUND can get stuck at '--'.
 *
 * @param {any} surface
 * @param {boolean} wow
 * @returns {{ raw:number|null, name:string|null, class:string, runwayLike:boolean, onGround:boolean, valid:boolean }}
 */
function normalizeSurface(surface: unknown, wow: boolean): Record<string, any> {
  if (surface && typeof surface === 'object') return surface as Record<string, any>;
  // Use the canonical helper fallback shape.
  return decodeSurfaceType(Number.NaN, !!wow);
}

const surfaceNormalizerApi = { normalizeSurface };

module.exports = surfaceNormalizerApi;

export {};
