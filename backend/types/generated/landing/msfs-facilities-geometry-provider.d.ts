/**
 * MSFS Facilities Geometry Provider
 *
 * Keeps the domain-facing airport geometry API synchronous while refreshing
 * MSFS Facilities airport data through the Rust SimConnect sidecar in the
 * background. If the cache is cold or a request fails, airport-geometry-service
 * continues to fall back to OurAirports.
 */
export {};
