type AnyRecord = Record<string, any>;
export type TakeoffRollSample = {
    timestampMs: number;
    simTimeSec?: number | null;
    onGround: boolean;
    onRunway: boolean | null;
    runwayLike: boolean | null;
    paused?: boolean;
    gsKts: number | null;
    iasKts: number | null;
    headingTrueDeg: number | null;
    pitchDeg: number | null;
    bankDeg: number | null;
    lat: number | null;
    lon: number | null;
};
export type TakeoffPoint = {
    timestampMs: number;
    simTimeSec?: number | null;
    lat: number | null;
    lon: number | null;
    gsKts?: number | null;
    iasKts?: number | null;
    pitchDeg?: number | null;
    bankDeg?: number | null;
    headingTrueDeg?: number | null;
    aglFt?: number | null;
    aglSource?: 'radio' | 'plane' | 'baro' | null;
};
export type TakeoffAnalysisContext = {
    runwayData?: AnyRecord | null;
    screenHeightFt?: number | null;
    screenHeightBasis?: string | null;
    runwayExcursion?: boolean;
    hopCount?: number;
    /**
     * A roll start established at an earlier liftoff of the same takeoff. After
     * a settle-back the ground samples have an airborne gap, so the roll is
     * taken from this point instead of being rediscovered behind the gap.
     */
    rollStart?: {
        timestampMs: number;
        simTimeSec?: number | null;
        lat?: number | null;
        lon?: number | null;
        gsKts?: number | null;
        source?: string | null;
    } | null;
    climb?: {
        maxPitchDeg?: number | null;
        maxBankDeg?: number | null;
    } | null;
    priorRotationMaxRateDegS?: number | null;
    /** First observed ground contact after the most recent airborne segment. */
    rotationGroundStartMs?: number | null;
    groundContactUncertain?: boolean;
    lightAircraft?: boolean;
    source?: string;
    finalizeReason?: string;
};
export type RunwayUseScore = {
    score: number | null;
    grade: string;
    zone: string;
    remainingFt: number | null;
    usedPct: number | null;
    screenRemainingFt: number | null;
    liftoffBeyondEnd: boolean;
    screenBeyondEnd: boolean;
    positionUncertain: boolean;
};
export declare function resolveScreenHeightFt(lightAircraft: boolean): {
    heightFt: number;
    basis: string;
};
/**
 * Measure runway use, retaining the legacy score fields for saved-record compatibility.
 *
 * @param liftoffDistanceFt   distance from the runway's physical threshold to the liftoff point
 * @param screenHeightDistanceFt distance from the same origin to the screen-height crossing, if observed
 * @param confirmedGroundDistanceFt conservative distance supported by recent ground observations
 * @param runwayLengthFt      physical runway length from that origin, not a declared distance
 */
export declare function scoreTakeoffRunwayUse(input: {
    liftoffDistanceFt: number | null | undefined;
    confirmedGroundDistanceFt?: number | null;
    screenHeightDistanceFt?: number | null | undefined;
    runwayLengthFt: number | null | undefined;
}): RunwayUseScore;
/**
 * Locate the roll start behind a liftoff without scoring anything. The runner
 * records it at the first liftoff so a settle-back cannot lose it.
 */
export declare function findTakeoffRollStart(rawSamples: AnyRecord[] | null | undefined, liftoffTimestampMs: number, referenceHeadingDeg: number | null): {
    timestampMs: number;
    simTimeSec: number | null;
    lat: number | null;
    lon: number | null;
    gsKts: number | null;
    source: string;
} | null;
export declare function analyzeTakeoffRoll(rawSamples: AnyRecord[] | null | undefined, liftoff: TakeoffPoint | null | undefined, screen: TakeoffPoint | null | undefined, context?: TakeoffAnalysisContext): AnyRecord | null;
export {};
