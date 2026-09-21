import { type Point, type TaxiRoute } from './route.js';
import { type TaxiHandling } from './handling.js';
export type TaxiSample = Point & {
    timeMs: number;
    headingDeg: number;
    speedKts: number;
    ready: boolean;
    reason?: string;
};
export type TaxiInput = {
    throttle: number;
    brake: number;
    steering: number;
};
export type TaxiStatus = 'taxiing' | 'stopping' | 'holding' | 'stopped' | 'fault';
/** steeringSign: +1 when positive AXIS_STEERING_SET turns right as documented, -1 when reversed, null/absent when unknown. */
export type TaxiControllerOptions = {
    steeringSign?: 1 | -1 | null;
    handling?: TaxiHandling;
};
/** The internals of one update, for the session log. Fields stay null on the paths that never compute them. */
export type TaxiTrace = {
    dtS: number;
    sampleAgeMs: number;
    movedM: number;
    turnedDeg: number;
    segment: number;
    remainingM: number;
    crossTrackM: number | null;
    limitM: number | null;
    headingErrorDeg: number | null;
    target: Point | null;
    demand: number | null;
    steering: number;
    targetKts: number | null;
    excessKts: number | null;
    throttle: number;
    accelerationKtsS: number;
    brake: number;
    probe: {
        yaw: number;
        travelledM: number;
        direction: 1 | -1 | null;
    } | null;
    steeringSign: 1 | -1 | null;
    evidence: number;
};
export declare const STOP_INPUT: TaxiInput;
/** Isolated, deterministic low-speed controller. No simulator or network I/O. */
export declare function createTaxiController(route: TaxiRoute, options?: TaxiControllerOptions): {
    update: (sample: TaxiSample, now: number) => TaxiInput;
    stop: (message?: string) => void;
    fault: (message: string) => void;
    getState: () => {
        status: TaxiStatus;
        reason: string;
        remainingM: number;
        runway: string;
        settled: boolean;
        steeringSign: 1 | -1;
        probing: boolean;
    };
    /** Internals of the most recent update, or null before the first valid sample. */
    trace: () => TaxiTrace;
};
