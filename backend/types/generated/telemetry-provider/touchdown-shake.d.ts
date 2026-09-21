export type TouchdownShakeMethod = 'eyepoint' | 'camera6dof';
export declare const MIN_TOUCHDOWN_SHAKE_VS_FPM = 50;
export type ShakeSample = {
    /** Degrees. Positive = nose down (camera looks further down). */
    pitch: number;
    /** Degrees. Positive = right wing down. */
    bank: number;
    /** Degrees. Positive = nose right. */
    heading: number;
    /** Metres, lateral. Positive = right. */
    dx: number;
    /** Metres, vertical. Positive = up. */
    dy: number;
    /** Metres, longitudinal. Positive = forward. */
    dz: number;
};
export declare const ZERO_SHAKE_SAMPLE: Readonly<ShakeSample>;
export type TouchdownShakeProfile = {
    vsFpm: number;
    /** 0..1, derived from touchdown vertical speed. */
    severity: number;
    intensity: number;
    seed: number;
    durationMs: number;
    /** Largest downward camera drop in metres (positive number). */
    peakDropMeters: number;
    /** Largest nose-down pitch in degrees (positive number). */
    peakPitchDegrees: number;
    sample(tSeconds: number): ShakeSample;
};
export type BuildTouchdownShakeProfileOptions = {
    intensity?: number;
    /** Seeds the rumble phases and wobble direction. Random when omitted. */
    seed?: number;
};
export declare function normalizeTouchdownShakeMethod(raw: unknown, fallback?: TouchdownShakeMethod): TouchdownShakeMethod;
export declare function normalizeTouchdownShakeIntensity(raw: unknown, fallback?: number): number;
/**
 * Map touchdown vertical speed to a 0..1 severity. -100 fpm is a greaser
 * (~0.16), -400 fpm a normal airline landing (~0.48), -1000 fpm and beyond a
 * hard landing (1.0).
 */
export declare function touchdownShakeSeverity(vsFpm: number): number;
export declare function buildTouchdownShakeProfile(vsFpm: number, options?: BuildTouchdownShakeProfileOptions): TouchdownShakeProfile;
export type ShakeTransport = {
    send(sample: ShakeSample): void;
};
export declare const TOUCHDOWN_SHAKE_DISABLED = true;
export type TouchdownShakeRunner = {
    readonly active: boolean;
    /** True after the shake finished while its trailing settle write is still pending. */
    readonly settling: boolean;
    cancel(): void;
};
type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | {
    unref?: () => void;
} | number;
export type RunTouchdownShakeOptions = {
    tickMs?: number;
    /** A second zero write shortly after the last one, in case a frame was dropped. */
    settleZeroDelayMs?: number;
    now?: () => number;
    setIntervalFn?: (fn: () => void, ms: number) => TimerHandle;
    clearIntervalFn?: (handle: TimerHandle) => void;
    setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
    clearTimeoutFn?: (handle: TimerHandle) => void;
    onComplete?: (reason: 'finished' | 'cancelled') => void;
};
/**
 * Play a profile through a transport on wall-clock time. The transport always
 * receives a zero sample last, both on natural completion and on cancel, and a
 * second zero shortly after completion.
 */
export declare function runTouchdownShake(profile: TouchdownShakeProfile, transport: ShakeTransport, options?: RunTouchdownShakeOptions): TouchdownShakeRunner;
export {};
