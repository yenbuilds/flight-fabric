type AnyRecord = Record<string, any>;
export type RolloutAnalysisSample = {
    timestampMs: number;
    onGround: boolean;
    paused?: boolean;
    phase?: string | null;
    gsKts: number | null;
    bankDeg: number | null;
    rollRateDegS?: number | null;
    headingTrueDeg: number | null;
    lat: number | null;
    lon: number | null;
};
export type RolloutAnalysisContext = {
    taxiInMaxKts?: unknown;
    runwayHeadingTrueDeg?: unknown;
    runwayThreshold?: {
        lat?: unknown;
        lon?: unknown;
    } | null;
    runwayWidthFt?: unknown;
    runwayExcursion?: unknown;
    coordinatePrecisionDigits?: unknown;
    source?: unknown;
};
export declare function analyzeRollout(rawSamples: AnyRecord[] | null | undefined, context?: RolloutAnalysisContext): AnyRecord | null;
export declare function inferCoordinatePrecisionDigits(samples: AnyRecord[]): number | null;
export declare const ROLLOUT_ANALYSIS_LIMITS: Readonly<{
    minGroundSpeedKts: 30;
    maxWindowMs: 60000;
    maxSamples: 2000;
}>;
export {};
