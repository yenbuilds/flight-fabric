/** Position precision alone cannot establish that a database runway matches
 * the runway installed in the simulator. Unknown/portable geometry is useful
 * context, but cannot establish a runway-edge violation. */
export function isRunwayGeometryScorable(source: unknown, suspect: unknown = false): boolean {
  if (suspect === true || suspect === 1 || suspect === '1' || suspect === 'true') return false;
  return source === 'msfs-facilities' || source === 'xplane-airports';
}

/** Explicit runway contact followed by sustained, high-speed off-runway
 * unpaved/water telemetry. Paved taxiway exits and unknown surfaces are not
 * evidence of an excursion. */
export class RunwayExcursionFilter {
  private hadRunwayContact = false;
  private sinceMs: number | null = null;
  private lastMs: number | null = null;

  get pending(): boolean { return this.sinceMs !== null; }

  update(surface: Record<string, any> | null | undefined, gsKts: number, taxiMaxKts: number, nowMs: number): boolean {
    const gap = this.lastMs == null ? 0 : nowMs - this.lastMs;
    this.lastMs = nowMs;
    if (surface?.valid !== true || surface?.onGround !== true || typeof surface.onRunway !== 'boolean'
        || !Number.isFinite(nowMs) || gap < 0 || gap > 1000) {
      this.hadRunwayContact = false;
      this.sinceMs = null;
      return false;
    }
    if (surface.onRunway) {
      this.hadRunwayContact = true;
      this.sinceMs = null;
      return false;
    }
    const offPavement = ['UNPAVED', 'WATER'].includes(String(surface.class ?? surface.surfaceClass).toUpperCase());
    if (!offPavement || !this.hadRunwayContact || !(gsKts > Math.max(30, taxiMaxKts))) {
      this.sinceMs = null;
      this.hadRunwayContact = false;
      return false;
    }
    if (this.sinceMs == null) this.sinceMs = nowMs;
    return nowMs - this.sinceMs >= 1000;
  }
}
