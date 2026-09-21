/** Aircraft-specific ground handling. Values describe the installed control
 * adapter, not a promise that an aircraft has passed live acceptance. */
export type TaxiHandling = Readonly<{
    id: string;
    label: string;
    wheelbaseM: number;
    /** Effective nose-wheel angle at a full steering-axis command. */
    maxSteeringDeg: number;
    /** Controller steering limit, at or below the effective full-axis angle. */
    steeringLimitDeg: number;
    /** Minimum authored scenery-link width; scenery is not a clearance survey. */
    minPathWidthM: number;
    /** Distance from reference point to the hold line, including nose clearance. */
    holdShortOffsetM: number;
    cruiseKts: number;
    turnKts: number;
    maxStartKts: number;
    maxSpeedKts: number;
    maxThrottle: number;
}>;
/** Legacy controller defaults retained for standalone callers and fixtures.
 * Production sessions provide a resolved aircraft configuration explicitly. */
export declare const DEFAULT_TAXI_HANDLING: TaxiHandling;
/** Validate and copy so caller mutation cannot change a plan already in use. */
export declare function validateTaxiHandling(value: TaxiHandling): TaxiHandling;
/** The identity includes every tuning value; changing limits invalidates learnt
 * steering direction and any plan created before that change. */
export declare function taxiHandlingKey(value: TaxiHandling): string;
