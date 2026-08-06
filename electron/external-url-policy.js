'use strict';

const MAX_EXTERNAL_URL_LENGTH = 2048;
const RELEASE_HOSTNAME = 'github.com';
const RELEASE_PATH_PREFIX = '/yenbuilds/flight-fabric/releases';

const FIXED_EXTERNAL_URLS = new Set([
  'https://carto.com/',
  'https://docs.mobiflight.com/guides/wasm-module/enable-in-msfs2024/',
  'https://docs.mobiflight.com/guides/wasm-module/wasm-reinstall/',
  'https://leafletjs.com/',
  'https://www.openstreetmap.org/copyright',
]);

function isReleasePath(pathname) {
  const normalizedPath = pathname.toLowerCase();
  return normalizedPath === RELEASE_PATH_PREFIX
    || normalizedPath.startsWith(`${RELEASE_PATH_PREFIX}/`);
}

function resolveAllowedExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string'
      || !rawUrl
      || rawUrl !== rawUrl.trim()
      || rawUrl.length > MAX_EXTERNAL_URL_LENGTH) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    if (parsed.search || parsed.hash) return null;

    if (FIXED_EXTERNAL_URLS.has(parsed.href)) return parsed.href;
    if (parsed.hostname === RELEASE_HOSTNAME && isReleasePath(parsed.pathname)) {
      return parsed.href;
    }
  } catch {
    // Invalid URLs fail closed.
  }

  return null;
}

module.exports = {
  resolveAllowedExternalUrl,
};
