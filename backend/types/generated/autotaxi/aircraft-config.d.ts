export type TaxiAircraftConfigResult = Readonly<{
    ok: true;
    identity: string;
    sourceFiles: readonly string[];
    fingerprint: string;
    wheelbaseM: number;
    maxSteeringDeg: number;
    /** Lateral span of the outermost main-wheel contact points. */
    wheelTrackM: number;
    lengthM: number;
    /** CONTACT_POINTS max_speed_full_steering, converted from feet/second. */
    fullSteeringSpeedKts?: number;
    /** Nose-wheel longitudinal position relative to the configuration datum. */
    noseOffsetM: number;
}> | Readonly<{
    ok: false;
    reason: string;
}>;
export type TaxiAircraftConfigOptions = {
    /** Package containers (Community, Official/OneStore, etc.) or individual packages. */
    packageRoots?: readonly string[];
    userCfgPaths?: readonly string[];
};
export declare function clearTaxiAircraftConfigCache(): void;
/** Results are cached for one second (at most 32 selected aircraft). All selected
 * source paths and their contents participate in the next resolved fingerprint. */
export declare function resolveTaxiAircraftConfig(aircraftCfgPath: string, options?: TaxiAircraftConfigOptions): TaxiAircraftConfigResult;
