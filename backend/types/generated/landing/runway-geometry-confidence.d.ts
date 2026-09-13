/** Position precision alone cannot establish that a database runway matches
 * the runway installed in the simulator. Unknown/portable geometry is useful
 * context, but cannot establish a runway-edge violation. */
export declare function isRunwayGeometryScorable(source: unknown, suspect?: unknown): boolean;
/** Explicit runway contact followed by sustained, high-speed off-runway
 * unpaved/water telemetry. Paved taxiway exits and unknown surfaces are not
 * evidence of an excursion. */
export declare class RunwayExcursionFilter {
    private hadRunwayContact;
    private sinceMs;
    private lastMs;
    get pending(): boolean;
    update(surface: Record<string, any> | null | undefined, gsKts: number, taxiMaxKts: number, nowMs: number): boolean;
}
