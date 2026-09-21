import { type TaxiInput, type TaxiSample, type TaxiStatus, type TaxiTrace } from './controller.js';
import { type TaxiGraph, type TaxiRoute } from './route.js';
import { type TaxiRunwayRecord, type TaxiScene } from './scene.js';
import { type TaxiHandling } from './handling.js';
type Position = {
    lat: number;
    lon: number;
};
export type TaxiAirport = {
    origin: Position;
    graph: TaxiGraph;
    threshold: Position | null;
    reciprocal: string | null;
    runways?: TaxiRunwayRecord[];
};
export type TaxiObservation = TaxiSample & Position & {
    profileKey: string;
    profileRevision: number;
    generation: unknown;
    /** Extra simulator readbacks for the session log only; the controller never reads them. */
    sim?: Record<string, number | boolean | null>;
};
/** One line of the session log, in the shape of the other JSONL sidecars: a prefixed `type` and epoch `timeMs` from `deps.now`. */
export type TaxiRecord = {
    timeMs: number;
} & ({
    type: 'autotaxi_session_start';
    icao: string;
    runway: string | null;
    parking: string | null;
    profileKey: string;
    profileRevision: number;
    steeringSign: 1 | -1 | null;
    handling: TaxiHandling;
    start: Position & {
        headingDeg: number;
        speedKts: number;
    };
    route: TaxiRoute;
    airport: {
        origin: Position;
        threshold: Position | null;
        reciprocal: string | null;
    };
    scene: TaxiScene;
} | {
    type: 'autotaxi_tick';
    sample: Position & TaxiSample & {
        sim?: Record<string, number | boolean | null>;
    };
    trace: TaxiTrace | null;
    input: TaxiInput;
    status: TaxiStatus;
    writeMs: number;
    writeError: string | null;
    heartbeatAgeMs: number;
} | {
    type: 'autotaxi_transition';
    from: TaxiStatus | null;
    to: TaxiStatus;
    reason: string;
} | {
    type: 'autotaxi_handover';
    ok: boolean;
    error: string | null;
} | {
    type: 'autotaxi_session_end';
    status: TaxiStatus | null;
    reason: string | null;
    error: string | null;
    ticks: number;
    steeringSign: 1 | -1 | null;
});
export type TaxiSessionDependencies = {
    now: () => number;
    capture: () => TaxiObservation;
    /** Resolve the actual loaded aircraft. Explicit null blocks preview/start;
     * omitted only preserves legacy standalone callers and test fixtures. */
    handling?: () => TaxiHandling | null;
    /** Airport geometry; runway is null for a stand destination. */
    airport: (icao: string, runway: string | null) => Promise<TaxiAirport>;
    write: (input: TaxiInput, sameAircraft: () => boolean) => Promise<void>;
    /** Set the parking brake while the toe brakes are held. Without it a stopped session keeps holding the toe brakes. */
    park?: (sameAircraft: () => boolean) => Promise<void>;
    /** Current parking-brake lever state, or null when unknown. */
    parked?: () => boolean | null;
    /** Session log sink. Rows are best effort: a throwing sink is ignored and never affects control. */
    record?: (row: TaxiRecord) => void;
};
/** One owner, one serial write loop, no auto-resume after any interruption. */
export declare function createTaxiSession(deps: TaxiSessionDependencies): {
    request: (message: Record<string, any>, client: unknown, connected?: () => boolean) => Promise<{
        scene?: TaxiScene;
        error: string;
        active: boolean;
        handedOver: boolean;
        steeringReversed: boolean;
        probing: boolean;
        runwayTravelM: number;
        joinM: number;
        observedSpeedKts: number;
        commanded: TaxiInput;
        canStart: boolean;
        unavailableReason: string;
        handling: {
            id: string;
            label: string;
        };
        currentProfileKey: string;
        currentProfileRevision: number;
        profileKey: string;
        profileRevision: number;
        route: {
            stand?: import("./route.js").TaxiStand;
            points: import("./route.js").Point[];
            holdShort: import("./route.js").Point;
            lengthM: number;
            runway: string;
            kind: "hold" | "stand";
            label: string;
        };
        aircraft: {
            headingDeg: number;
            speedKts: number;
            x: number;
            z: number;
        };
        sceneKey: number;
        remainingM?: number;
        runway?: string;
        type: string;
        status: "idle" | TaxiStatus | "planning";
        reason: string;
    } | {
        stands: string[];
        standOptions: import("./route.js").TaxiParkingOption[];
        scene?: TaxiScene;
        error: string;
        active: boolean;
        handedOver: boolean;
        steeringReversed: boolean;
        probing: boolean;
        runwayTravelM: number;
        joinM: number;
        observedSpeedKts: number;
        commanded: TaxiInput;
        canStart: boolean;
        unavailableReason: string;
        handling: {
            id: string;
            label: string;
        };
        currentProfileKey: string;
        currentProfileRevision: number;
        profileKey: string;
        profileRevision: number;
        route: {
            stand?: import("./route.js").TaxiStand;
            points: import("./route.js").Point[];
            holdShort: import("./route.js").Point;
            lengthM: number;
            runway: string;
            kind: "hold" | "stand";
            label: string;
        };
        aircraft: {
            headingDeg: number;
            speedKts: number;
            x: number;
            z: number;
        };
        sceneKey: number;
        remainingM?: number;
        runway?: string;
        type: string;
        status: "idle" | TaxiStatus | "planning";
        reason: string;
    } | {
        preview: TaxiRoute;
        reason: string;
        scene?: TaxiScene;
        error: string;
        active: boolean;
        handedOver: boolean;
        steeringReversed: boolean;
        probing: boolean;
        runwayTravelM: number;
        joinM: number;
        observedSpeedKts: number;
        commanded: TaxiInput;
        canStart: boolean;
        unavailableReason: string;
        handling: {
            id: string;
            label: string;
        };
        currentProfileKey: string;
        currentProfileRevision: number;
        profileKey: string;
        profileRevision: number;
        route: {
            stand?: import("./route.js").TaxiStand;
            points: import("./route.js").Point[];
            holdShort: import("./route.js").Point;
            lengthM: number;
            runway: string;
            kind: "hold" | "stand";
            label: string;
        };
        aircraft: {
            headingDeg: number;
            speedKts: number;
            x: number;
            z: number;
        };
        sceneKey: number;
        remainingM?: number;
        runway?: string;
        type: string;
        status: "idle" | TaxiStatus | "planning";
    }>;
    state: (includeScene?: boolean) => {
        scene?: TaxiScene;
        error: string;
        active: boolean;
        handedOver: boolean;
        steeringReversed: boolean;
        probing: boolean;
        runwayTravelM: number;
        joinM: number;
        observedSpeedKts: number;
        commanded: TaxiInput;
        canStart: boolean;
        unavailableReason: string;
        handling: {
            id: string;
            label: string;
        };
        currentProfileKey: string;
        currentProfileRevision: number;
        profileKey: string;
        profileRevision: number;
        route: {
            stand?: import("./route.js").TaxiStand;
            points: import("./route.js").Point[];
            holdShort: import("./route.js").Point;
            lengthM: number;
            runway: string;
            kind: "hold" | "stand";
            label: string;
        };
        aircraft: {
            headingDeg: number;
            speedKts: number;
            x: number;
            z: number;
        };
        sceneKey: number;
        remainingM?: number;
        runway?: string;
        type: string;
        status: "idle" | TaxiStatus | "planning";
        reason: string;
    };
    tick: () => Promise<void>;
    isActive: () => boolean;
    dispose(): Promise<void>;
};
export {};
