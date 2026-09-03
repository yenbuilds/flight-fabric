type UnknownRecord = Record<string, unknown>;
type SignalReliabilityMap = Record<string, string>;
type FdmFieldValue = number | boolean | string | null | undefined;
type FdmLike = Record<string, FdmFieldValue>;
type ProfileLike = {
    id?: string | null;
    signalReliability?: SignalReliabilityMap | null;
    aircraft?: {
        engines?: {
            count?: unknown;
        } | null;
    } | null;
    engines?: {
        count?: unknown;
    } | null;
} | null | undefined;
type AutopilotReliability = {
    apReliable?: boolean | null;
    athrReliable?: boolean | null;
    reason?: string | null;
} | null | undefined;
type SimconnectLike = {
    fdm?: FdmLike | null;
    hdgTrueDeg?: number | null;
    hdgMagDeg?: number | null;
    magvarDeg?: number | null;
    simVersion?: string | null;
} | null | undefined;
type FrameLike = UnknownRecord & {
    wow?: unknown;
    paused?: unknown;
    inMenu?: unknown;
    engines?: UnknownRecord | null;
    throttle?: UnknownRecord | null;
    fdm?: FdmLike | null;
    yoke?: {
        x?: number | null;
        y?: number | null;
    } | null;
    simconnect?: SimconnectLike;
    lat?: number | null;
    lon?: number | null;
    gforce?: number | null;
    brake?: number | null;
    assists?: unknown;
    surface?: {
        raw?: unknown;
        name?: unknown;
        class?: unknown;
        runwayLike?: unknown;
        onRunway?: unknown;
        onGround?: unknown;
        valid?: unknown;
    } | null;
    simTime?: {
        zuluSec?: unknown;
        localSec?: unknown;
        zuluHms?: unknown;
        localHms?: unknown;
        zuluDate?: unknown;
        localDate?: unknown;
        zuluIso?: unknown;
        localIso?: unknown;
        zuluYear?: unknown;
        zuluMonth?: unknown;
        zuluDay?: unknown;
        zuluDayOfYear?: unknown;
        zuluDayOfWeek?: unknown;
        localYear?: unknown;
        localMonth?: unknown;
        localDay?: unknown;
        localDayOfYear?: unknown;
        localDayOfWeek?: unknown;
        timezoneOffsetSec?: unknown;
        absoluteSec?: unknown;
        timeOfDay?: unknown;
        zuluSunriseSec?: unknown;
        zuluSunsetSec?: unknown;
        source?: unknown;
        valid?: unknown;
    } | null;
    ilsGsDeviation?: unknown;
    ilsLocDeviation?: unknown;
    ias?: unknown;
    vs?: unknown;
    ra?: unknown;
    gs?: unknown;
    heading?: unknown;
    alt_msl?: unknown;
    pitch?: unknown;
    bank?: unknown;
    gearDownLocked?: unknown;
    windSpeed?: unknown;
    windDir?: unknown;
};
type HeadingData = {
    hdgTrueDeg: number | null;
    hdgMagDeg: number | null;
    magvarDeg: number | null;
};
type RunwayContext = {
    icao: string | null;
    runway: string | null;
    approachType: string | null;
};
type GeometryLookupContext = {
    simulator?: string | null;
    dataSource?: string | null;
    offline?: boolean | null;
} | null | undefined;
type AircraftSpecificConfigLike = {
    templateId?: unknown;
} | null | undefined;
type AircraftSpecificProfileLike = {
    integration?: {
        presentation?: {
            aircraftSpecific?: {
                template?: unknown;
            } | null;
        } | null;
    } | null;
} | null | undefined;
type RunwayContextDetectorParams = {
    approachPhases: Set<string>;
    groundPhases: Set<string>;
    landingPhase: string;
    findRunwayByPosition: (_lat: number, _lon: number, _radiusNm: number, _headingDeg?: number | null, _context?: GeometryLookupContext) => UnknownRecord | null;
    findNearbyAirport: (_lat: number, _lon: number, _radiusNm: number, _context?: GeometryLookupContext) => UnknownRecord | null;
    lookupThresholdDeg?: number;
    approachDistanceNm?: number;
    airportLookupDistanceNm?: number;
};
type BuildVreEnrichedFrameParams = {
    frame: FrameLike;
    userId?: string | null;
    sessionId?: string | null;
    nowEpochMs: number;
    timestampIso: string;
    flightId?: string | null;
    flightStartIso?: string | null;
    flightStartEpochMs?: number | null;
    sampleRateHz?: number | null;
    escalationReason?: string | null;
    phase?: string | null;
    stability?: string | null;
    iasKnots?: number | null;
    gs?: number | null;
    vsFeetPerMin?: number | null;
    altMslFt?: number | null;
    raFeet?: number | null;
    xwind?: number | null;
    trend?: number | null;
    headingData: HeadingData;
    pitchDeg?: number | null;
    bankDeg?: number | null;
    maxPitchBankDeg?: number;
    windSpeed?: number | null;
    windDir?: number | null;
    gearDownLocked?: boolean | null;
    flapsNotch?: string | number | null;
    flaps?: UnknownRecord | null;
    flapsSource?: string | null;
    spoilerPct?: number | null;
    spoilerState?: string | null;
    spoilerSource?: string | null;
    spoilerAvailable?: boolean | null;
    brakePct?: number | null;
    thr1Pct?: number | null;
    thr2Pct?: number | null;
    thr3Pct?: number | null;
    thr4Pct?: number | null;
    profileId?: string | null;
    signalReliability?: unknown;
    dataSource?: string | null;
    aircraftName?: string | null;
    fdm?: FdmLike | null;
    autopilotReliability?: AutopilotReliability;
    elapsedMs?: number | null;
};
export declare function resolveLandingGeometryScoringInputs(payload: UnknownRecord | null | undefined): {
    thresholdElevFt: number;
    runwayReferenceElevationSource: string;
    runwayReferenceElevationKind: string;
    runwayHdg: number;
    runwayWidthFt: number;
    runwayLengthFt: number;
    runwayThreshold: {
        lat: number;
        lon: number;
    };
    runwayId: string;
    airportIcao: string;
};
export declare function createRunwayContextDetector({ approachPhases, groundPhases, landingPhase, findRunwayByPosition, findNearbyAirport, lookupThresholdDeg, approachDistanceNm, airportLookupDistanceNm, }: RunwayContextDetectorParams): (lat: number | null, lon: number | null, hdgDeg: number | null, phase: string, context?: GeometryLookupContext) => RunwayContext;
export declare function resolveAircraftSpecificTemplateId(aircraftSpecificConfig: AircraftSpecificConfigLike, profile?: AircraftSpecificProfileLike): string | null;
export declare function buildSignalReliabilityPayload(profile: ProfileLike): {
    type: string;
    signals: SignalReliabilityMap;
    profileId: string;
    source: 'profile';
};
export declare function computeSimStateMenuFlag({ simconnectConnected, providerInMenu, lifecycleInMenu, simSystemInMenu, dialogInMenu, isGlobeView, }: {
    simconnectConnected: boolean;
    providerInMenu?: unknown;
    lifecycleInMenu?: unknown;
    simSystemInMenu?: unknown;
    dialogInMenu?: unknown;
    isGlobeView?: unknown;
}): boolean;
export declare function shouldCollectCurrentApproachSample({ phase, raFt, vsFpm, onGround, rolloutActive, collectionCeilingFt, warmup, }: {
    phase?: string | null;
    raFt?: number | null;
    vsFpm?: number | null;
    onGround?: boolean | null;
    rolloutActive?: boolean | null;
    collectionCeilingFt?: number | null;
    warmup?: boolean | null;
}): boolean;
export declare function shouldStartCurrentApproachScorer({ flightActive, eligible, scorerPresent, hasScored, }: {
    flightActive?: boolean | null;
    eligible?: boolean | null;
    scorerPresent?: boolean | null;
    hasScored?: boolean | null;
}): boolean;
export declare function shouldResetCurrentApproachScorerForParked({ phase, scorerPresent, hasScored, sampleCount, }: {
    phase?: string | null;
    scorerPresent?: boolean | null;
    hasScored?: boolean | null;
    sampleCount?: number | null;
}): boolean;
/**
 * Reset every scoring component that is scoped to a single landing attempt.
 *
 * Keep this fan-out shared by the live core and replay regressions: adding a
 * new attempt-scoped component in one path but not the other would allow a
 * go-around to leak first-attempt state into the eventual landing score.
 */
export declare function resetGoAroundScoringState<T>({ resetStability, landingRunner, createCurrentApproachScorer, }: {
    resetStability: () => void;
    landingRunner: {
        reset: () => void;
    };
    createCurrentApproachScorer: () => T;
}): T;
export declare function computeHeadingAndMagvar({ sc, fallbackTrueHeadingDeg, fallbackMagvarDeg, }: {
    sc?: SimconnectLike;
    fallbackTrueHeadingDeg?: number | null;
    fallbackMagvarDeg?: number | null;
}): HeadingData;
export declare function computeElapsedMs(nowEpochMs: number, startEpochMs: number | null | undefined): number | null;
export declare function formatElapsedHms(totalSeconds: unknown): string;
export declare function mergeFdmData(frameFdm: FdmLike | null | undefined, sc: SimconnectLike): FdmLike;
export declare function getEngineLevels(frame: FrameLike | null | undefined, maxEngines?: number): number[];
export declare function getProfileEngineCount(profile: ProfileLike): number | null;
export declare function buildEnginesBroadcastData(frame: FrameLike | null | undefined, options?: {
    profile?: ProfileLike;
    maxEngines?: unknown;
}): UnknownRecord | null;
export declare function computeGearBroadcastState({ gear, gearHandleDown, previousGearState, previousParkingBrake, }: {
    gear: UnknownRecord;
    gearHandleDown?: unknown;
    previousGearState?: unknown;
    previousParkingBrake?: unknown;
}): {
    payload: UnknownRecord;
    nextGearState: string;
    nextParkingBrake: unknown;
};
export declare function deriveApproachConfigurationState({ gearDownLocked, gearConfigurationAvailable, flaps, flapsConfigurationAvailable, }: {
    gearDownLocked?: unknown;
    gearConfigurationAvailable?: boolean | null;
    flaps?: UnknownRecord | null;
    flapsConfigurationAvailable?: boolean | null;
}): boolean | null;
export declare function advanceDebouncedChangeState({ value, lastValue, pendingValue, pendingTicks, requiredTicks, }: {
    value: unknown;
    lastValue: unknown;
    pendingValue?: unknown;
    pendingTicks?: number;
    requiredTicks: number;
}): {
    changed: boolean;
    nextLastValue: unknown;
    nextPendingValue: unknown;
    nextPendingTicks: number;
};
export declare function buildVreEvaluationFrame({ frame, vsFeetPerMin, raFeet, pitchRateDeg, bankRateDeg, gs, gearDownLocked, flapsNotch, spoilerState, wow, pitch, bank, phase, }: {
    frame: FrameLike;
    vsFeetPerMin?: number | null;
    raFeet?: number | null;
    pitchRateDeg?: number | null;
    bankRateDeg?: number | null;
    gs?: number | null;
    gearDownLocked?: boolean | null;
    flapsNotch?: string | number | null;
    spoilerState?: string | null;
    wow?: boolean | null;
    pitch?: number | null;
    bank?: number | null;
    phase?: string | null;
}): UnknownRecord;
/** Absolute CSV sample-rate ceiling, independent of evaluator or poll settings. */
export declare const MAX_VRE_CSV_SAMPLE_RATE_HZ = 10;
/**
 * Resolve the cadence the VRE logger can actually achieve from the evaluator's
 * target, the telemetry loop cadence, and the absolute CSV safety ceiling. VRE
 * can skip ticks, but it cannot manufacture fresh telemetry samples between
 * ticks or exceed the hard logger cap.
 */
export declare function resolveVreSamplingRate(targetRateHz: unknown, pollRateMs: unknown): {
    targetRateHz: number;
    effectiveRateHz: number;
    intervalMs: number;
};
/**
 * Independent runtime admission gate for CSV sample write attempts. This keeps
 * the hard ceiling effective even if evaluator cadence regresses in the future.
 */
export declare function isVreCsvSampleDue(nowEpochMs: unknown, lastWriteAttemptTs: unknown, intervalMs: unknown): boolean;
export declare function deriveOverallSignalReliability(profileReliability: SignalReliabilityMap | null | undefined, keySignals?: string[]): string;
export declare function normalizePitchBankDegrees({ pitch, bank, }: {
    pitch?: number | null;
    bank?: number | null;
}): {
    pitchDeg: number;
    bankDeg: number;
};
export declare function extractThrottlePercents(throttleSnapshot: UnknownRecord | null | undefined): {
    thr1Pct: number | null;
    thr2Pct: number | null;
    thr3Pct: number | null;
    thr4Pct: number | null;
};
export declare function computeBrakePct(frame: FrameLike | null | undefined): number | null;
export declare function extractActivityFields(frame: FrameLike | null | undefined): UnknownRecord | null;
export declare function countActiveTelemetryFields(currentFrame: UnknownRecord | null | undefined, previousFrame: UnknownRecord | null | undefined, { defaultThreshold, gpsChangeThreshold, altitudeChangeThresholdFt, headingChangeThresholdDeg, }?: {
    defaultThreshold?: number;
    gpsChangeThreshold?: number;
    altitudeChangeThresholdFt?: number;
    headingChangeThresholdDeg?: number;
}): number;
export declare function buildVreEnrichedFrame({ frame, userId, sessionId, nowEpochMs, timestampIso, flightId, flightStartIso, flightStartEpochMs, sampleRateHz, escalationReason, phase, stability, iasKnots, gs, vsFeetPerMin, altMslFt, raFeet, xwind, trend, headingData, pitchDeg, bankDeg, maxPitchBankDeg, windSpeed, windDir, gearDownLocked, flapsNotch, flaps, flapsSource, spoilerPct, spoilerState, spoilerSource, spoilerAvailable, brakePct, thr1Pct, thr2Pct, thr3Pct, thr4Pct, profileId, signalReliability, dataSource, aircraftName, fdm, autopilotReliability, elapsedMs, }: BuildVreEnrichedFrameParams): UnknownRecord;
export {};
