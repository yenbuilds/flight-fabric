export const OPENFREEMAP_DARK_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

export const OPENFREEMAP_RASTER_FALLBACK_TILE_URL = 'https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png';

export const OPENFREEMAP_ATTRIBUTION = [
  '<a href="https://openfreemap.org/">OpenFreeMap</a>',
  '&copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
].join(' ');

export const OPENFREEMAP_RASTER_FALLBACK_ATTRIBUTION = [
  '<a href="https://openfreemap.org/">OpenFreeMap</a>',
  '<a href="https://www.naturalearthdata.com/">Natural Earth</a>',
].join(' ');

export function createOpenFreeMapDarkLayer(leaflet) {
  if (typeof leaflet?.maplibreGL !== 'function') {
    throw new Error('The bundled MapLibre Leaflet bridge is unavailable.');
  }

  const layer = leaflet.maplibreGL({
    style: OPENFREEMAP_DARK_STYLE_URL,
    attributionControl: {
      customAttribution: OPENFREEMAP_ATTRIBUTION,
    },
    interactive: false,
  });

  // The upstream bridge can leave a resize/zoom callback queued while Leaflet
  // removes a failed layer. Guard its private lifecycle hooks so that callback
  // cannot dereference a cleared `_map`/`_glMap` during fallback or teardown.
  for (const methodName of ['_pinchZoom', '_animateZoom', '_zoomEnd']) {
    const originalMethod = layer?.[methodName];
    if (typeof originalMethod !== 'function') continue;
    layer[methodName] = function guardedMapLibreLeafletCallback(...args) {
      if (!this._map || !this._glMap) return undefined;
      return originalMethod.apply(this, args);
    };
  }

  if (typeof layer?._transitionEnd === 'function'
      && typeof leaflet?.Util?.requestAnimFrame === 'function') {
    layer._transitionEnd = function guardedMapLibreLeafletTransitionEnd() {
      const layerRef = this;
      leaflet.Util.requestAnimFrame(() => {
        const map = layerRef._map;
        const glMap = layerRef._glMap;
        if (!map || !glMap) return;

        const zoom = map.getZoom();
        const center = map.getCenter();
        const offset = map.latLngToContainerPoint(map.getBounds().getNorthWest());
        layerRef._resizeContainer();
        leaflet.DomUtil.setTransform(glMap._actualCanvas, offset, 1);
        glMap.once('moveend', () => {
          if (layerRef._map === map && layerRef._glMap === glMap) layerRef._zoomEnd();
        });
        glMap.jumpTo({ center, zoom: zoom - 1 });
      }, layerRef);
    };
  }

  return layer;
}

export function createOpenFreeMapRasterFallbackLayer(leaflet) {
  if (typeof leaflet?.tileLayer !== 'function') {
    throw new Error('The bundled Leaflet raster tile layer is unavailable.');
  }

  return leaflet.tileLayer(OPENFREEMAP_RASTER_FALLBACK_TILE_URL, {
    maxNativeZoom: 6,
    maxZoom: 20,
    attribution: OPENFREEMAP_RASTER_FALLBACK_ATTRIBUTION,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 1,
  });
}
