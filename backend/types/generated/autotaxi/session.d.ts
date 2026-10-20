import { type TaxiInput, type TaxiSample, type TaxiStatus } from './controller.js';
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
    /** Read-only route guidance needs position/context, not engine or control readiness. */
    guidanceReady?: boolean;
    guidanceReason?: string;
};
export type TaxiSessionDependencies = {
    now: () => number;
    capture: () => TaxiObservation;
    /** Resolve the actual loaded aircraft. Explicit null blocks automatic control;
     * omitted only preserves legacy standalone callers and test fixtures. */
    handling?: () => TaxiHandling | null;
    /** Airport geometry; runway is null for a stand destination. */
    airport: (icao: string, runway: string | null) => Promise<TaxiAirport>;
    write: (input: TaxiInput, sameAircraft: () => boolean) => Promise<void>;
    /** One bounded transport recovery after a failed stop. Never resumes motion. */
    recover?: (error: unknown, sameAircraft: () => boolean) => Promise<boolean>;
    /** Set the parking brake while the toe brakes are held. Without it a stopped session keeps holding the toe brakes. */
    park?: (sameAircraft: () => boolean) => Promise<void>;
    /** Current parking-brake lever state, or null when unknown. */
    parked?: () => boolean | null;
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
        canGuide: boolean;
        guidanceUnavailableReason: string;
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
        canGuide: boolean;
        guidanceUnavailableReason: string;
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
        canGuide: boolean;
        guidanceUnavailableReason: string;
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
        canGuide: boolean;
        guidanceUnavailableReason: string;
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
