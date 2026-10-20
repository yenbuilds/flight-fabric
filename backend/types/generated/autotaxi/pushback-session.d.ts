import type { TaxiAirport, TaxiObservation } from './session.js';
import type { PreparedPushback } from './pushback-preview.js';
export type PushbackCommand = {
    kind: 'start' | 'stop';
} | {
    kind: 'steer';
    headingDeg: number;
};
export type PushbackDependencies = {
    now: () => number;
    capture: () => TaxiObservation & {
        parked: boolean | null;
        tug: {
            state: number;
            forwardSpeedFps: number;
        } | null;
    };
    dimensions: () => {
        wheelbaseM: number;
        lengthM: number;
    } | null;
    airport: (icao: string, runway: string) => Promise<TaxiAirport>;
    write: (command: PushbackCommand, valid: () => boolean) => Promise<void>;
    conflict: () => boolean;
};
/** One explicit start, one owner heartbeat, no automatic resume. Commands use
 * the simulator tug only: no throttle, parking-brake, slew or position writes. */
export declare function createPushbackSession(deps: PushbackDependencies): {
    request: (message: Record<string, any>, client: unknown, isConnected?: () => boolean, prepared?: PreparedPushback) => Promise<{
        type: string;
        status: string;
        active: boolean;
        reason: string;
        error: string;
        canStart: boolean;
        unavailableReason: string;
        currentProfileKey: string;
        currentProfileRevision: number;
        icao: string;
        runway: string;
        headingDeg: number;
        remainingM: number;
    }>;
    state: () => {
        type: string;
        status: string;
        active: boolean;
        reason: string;
        error: string;
        canStart: boolean;
        unavailableReason: string;
        currentProfileKey: string;
        currentProfileRevision: number;
        icao: string;
        runway: string;
        headingDeg: number;
        remainingM: number;
    };
    tick: () => Promise<void>;
    isActive: () => boolean;
    dispose(): Promise<void>;
};
