export declare const LifecycleState: Readonly<{
    readonly IDLE: "IDLE";
    readonly CONNECTED: "CONNECTED";
    readonly IN_MENU: "IN_MENU";
    readonly WARMUP: "WARMUP";
    readonly READY: "READY";
    readonly ACTIVE: "ACTIVE";
    readonly COOLDOWN: "COOLDOWN";
}>;
export type LifecycleStateValue = (typeof LifecycleState)[keyof typeof LifecycleState];
export type InFlightContextResult = {
    inFlightContext: boolean;
    reason: string;
};
export type ComputeInFlightContextParams = {
    simconnectConnected: boolean;
    simRunning?: boolean | null;
    userInputEnabled?: boolean | null;
    aircraftLoadedName?: string | null;
    paused?: boolean;
};
export type EligibilityResult = {
    eligible: boolean;
    state: LifecycleStateValue;
    blockers: string[];
    checks: Record<string, unknown>;
};
export type CheckFlightStartEligibilityParams = {
    flightActive?: boolean;
    lastFlightEndMs?: number | null;
    nowEpochMs?: number;
    simconnectConnected?: boolean;
    inFlightContext?: boolean;
    altMslFt?: number | null;
    iasKnots?: number | null;
    gsKnots?: number | null;
    raFeet?: number | null;
    wow?: boolean;
    slewActive?: boolean;
    motionDetected?: boolean;
    activeFieldCount?: number;
    cooldownMs?: number;
    maxAltMslFt?: number;
    minIasKts?: number;
    minGsKts?: number;
    minRaFt?: number;
    requireCount?: number;
    requireMovement?: boolean;
    requireTelemetryActivity?: boolean;
    minActiveFields?: number;
    blockOnSlew?: boolean;
};
export type ManualAutoStartSuppressionState = {
    active: boolean;
    sinceMs: number | null;
    aircraftTitle: string | null;
    parkedResetSinceMs: number | null;
    contextResetSinceMs: number | null;
};
export type UpdateManualAutoStartSuppressionParams = {
    suppression?: ManualAutoStartSuppressionState | null;
    nowEpochMs?: number;
    simconnectConnected?: boolean;
    inFlightContext?: boolean;
    aircraftTitle?: string | null;
    phase?: string | null;
    wow?: boolean;
    iasKnots?: number | null;
    gsKnots?: number | null;
    anyEngineRunning?: boolean | null;
    maxEnginePct?: number | null;
    parkedResetDwellMs?: number;
    contextResetDwellMs?: number;
    stoppedGsKts?: number;
    stoppedIasKts?: number;
    engineOffMaxPct?: number;
};
export type UpdateManualAutoStartSuppressionResult = {
    suppression: ManualAutoStartSuppressionState;
    suppressed: boolean;
    cleared: boolean;
    clearReason: string | null;
    blockers: string[];
};
export type MotionBaseline = {
    ts: number;
    ias: number;
    gs: number;
} | null;
export type MotionDebug = {
    ageMs: number;
    baseline: Exclude<MotionBaseline, null>;
    now: Exclude<MotionBaseline, null>;
    dIas: number;
    dGs: number;
} | null;
export type UpdateMotionDetectorParams = {
    flightActive: boolean;
    requireMovement: boolean;
    windowMs: number;
    minIasDeltaKts: number;
    minGsDeltaKts: number;
    nowEpochMs: number;
    iasKnots?: number | null;
    gs?: number | null;
    baseline?: MotionBaseline;
};
export type UpdateMotionDetectorResult = {
    telemetryValidForMotion: boolean;
    baseline: MotionBaseline;
    motionOverWindow: boolean;
    motionDebug: MotionDebug;
};
export type ActiveFlightEndGuardState = {
    lastSimconnectConnectedMs: number | null;
    simconnectDisconnectedSinceMs: number | null;
    simStoppedSinceMs: number | null;
    pendingReason: string | null;
};
export type UpdateActiveFlightEndGuardParams = {
    state?: Partial<ActiveFlightEndGuardState> | null;
    flightActive?: boolean;
    nowEpochMs?: number;
    simconnectConnected?: boolean;
    simRunning?: boolean | null;
    disconnectGraceMs?: number;
    simStoppedGraceMs?: number;
};
export type UpdateActiveFlightEndGuardResult = {
    state: ActiveFlightEndGuardState;
    pendingReasonStarted: string | null;
    pendingElapsedMs: number | null;
    endReason: string | null;
    endElapsedMs: number | null;
};
export type BuildFlightStartReasonParams = {
    flightId?: string | null;
    frame?: Record<string, unknown> | null;
    gs?: number | null;
    iasKnots?: number | null;
    wow?: boolean;
    raFeet?: number | null;
    engineLevels?: number[] | null;
    maxEngine?: number | null;
    requireMovement?: boolean;
    movementOk?: boolean;
    airStartOk?: boolean;
    airStartChecks?: Record<string, unknown> | null;
    motionOverWindow?: boolean;
    windowMs?: number;
    motionDebug?: MotionDebug;
    requireTelemetryActivity?: boolean;
    activeFieldCount?: number;
    minActiveFields?: number;
    telemetryActivityOk?: boolean;
};
export declare function computeInFlightContext({ simconnectConnected, simRunning, userInputEnabled, aircraftLoadedName, paused, }: ComputeInFlightContextParams): InFlightContextResult;
export declare function updateActiveFlightEndGuard({ state, flightActive, nowEpochMs, simconnectConnected, simRunning, disconnectGraceMs, simStoppedGraceMs, }: UpdateActiveFlightEndGuardParams): UpdateActiveFlightEndGuardResult;
export declare function updateManualAutoStartSuppression({ suppression, nowEpochMs, simconnectConnected, inFlightContext, aircraftTitle, phase, wow, iasKnots, gsKnots, anyEngineRunning, maxEnginePct, parkedResetDwellMs, contextResetDwellMs, stoppedGsKts, stoppedIasKts, engineOffMaxPct, }: UpdateManualAutoStartSuppressionParams): UpdateManualAutoStartSuppressionResult;
export declare function checkFlightStartEligibility({ flightActive, lastFlightEndMs, nowEpochMs, simconnectConnected, inFlightContext, altMslFt, iasKnots, gsKnots, raFeet, wow, slewActive, motionDetected, activeFieldCount, cooldownMs, maxAltMslFt, minIasKts, minGsKts, minRaFt, requireCount, requireMovement, requireTelemetryActivity, minActiveFields, blockOnSlew, }: CheckFlightStartEligibilityParams): EligibilityResult;
export declare function logStateTransition(state: string, blockers?: string[], verbose?: boolean): void;
export declare function resetStateLogger(): void;
export declare function updateMotionDetector({ flightActive, requireMovement, windowMs, minIasDeltaKts: _minIasDeltaKts, minGsDeltaKts, nowEpochMs, iasKnots, gs, baseline, }: UpdateMotionDetectorParams): UpdateMotionDetectorResult;
export declare function buildFlightStartReason({ flightId, frame, gs, iasKnots, wow, raFeet, engineLevels, maxEngine, requireMovement, movementOk, airStartOk, airStartChecks, motionOverWindow, windowMs, motionDebug, requireTelemetryActivity, activeFieldCount, minActiveFields, telemetryActivityOk, }: BuildFlightStartReasonParams): Record<string, unknown>;
