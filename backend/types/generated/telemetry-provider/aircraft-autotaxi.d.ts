import { type TaxiAircraftConfigResult } from '../autotaxi/aircraft-config.js';
type RecordValue = Record<string, any>;
export type AutotaxiOptions = {
    resolveModel?: (aircraftCfgPath: string) => TaxiAircraftConfigResult;
};
export declare function createAutotaxi(provider: RecordValue, profiles: RecordValue, now: () => number, options?: AutotaxiOptions): {
    state: (includeScene?: boolean) => {
        support: {
            family: import("../autotaxi/adapters.js").TaxiFamily;
            aircraftLabel: string;
            qualificationStatus: "unsupported" | "candidate";
            setupInstructions: readonly string[];
            reason: string;
        };
        scene?: import("../autotaxi/scene.js").TaxiScene;
        error: string;
        active: boolean;
        handedOver: boolean;
        steeringReversed: boolean;
        probing: boolean;
        runwayTravelM: number;
        joinM: number;
        observedSpeedKts: number;
        commanded: import("../autotaxi/controller.js").TaxiInput;
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
            stand?: import("../autotaxi/route.js").TaxiStand;
            points: import("../autotaxi/route.js").Point[];
            holdShort: import("../autotaxi/route.js").Point;
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
        status: "idle" | import("../autotaxi/controller.js").TaxiStatus | "planning";
        reason: string;
    };
    request: (message: Record<string, any>, client: unknown, connected?: () => boolean) => Promise<{
        support: {
            family: import("../autotaxi/adapters.js").TaxiFamily;
            aircraftLabel: string;
            qualificationStatus: "unsupported" | "candidate";
            setupInstructions: readonly string[];
            reason: string;
        };
        scene?: import("../autotaxi/scene.js").TaxiScene;
        error: string;
        active: boolean;
        handedOver: boolean;
        steeringReversed: boolean;
        probing: boolean;
        runwayTravelM: number;
        joinM: number;
        observedSpeedKts: number;
        commanded: import("../autotaxi/controller.js").TaxiInput;
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
            stand?: import("../autotaxi/route.js").TaxiStand;
            points: import("../autotaxi/route.js").Point[];
            holdShort: import("../autotaxi/route.js").Point;
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
        status: "idle" | import("../autotaxi/controller.js").TaxiStatus | "planning";
        reason: string;
    } | {
        support: {
            family: import("../autotaxi/adapters.js").TaxiFamily;
            aircraftLabel: string;
            qualificationStatus: "unsupported" | "candidate";
            setupInstructions: readonly string[];
            reason: string;
        };
        stands: string[];
        standOptions: import("../autotaxi/route.js").TaxiParkingOption[];
        scene?: import("../autotaxi/scene.js").TaxiScene;
        error: string;
        active: boolean;
        handedOver: boolean;
        steeringReversed: boolean;
        probing: boolean;
        runwayTravelM: number;
        joinM: number;
        observedSpeedKts: number;
        commanded: import("../autotaxi/controller.js").TaxiInput;
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
            stand?: import("../autotaxi/route.js").TaxiStand;
            points: import("../autotaxi/route.js").Point[];
            holdShort: import("../autotaxi/route.js").Point;
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
        status: "idle" | import("../autotaxi/controller.js").TaxiStatus | "planning";
        reason: string;
    } | {
        support: {
            family: import("../autotaxi/adapters.js").TaxiFamily;
            aircraftLabel: string;
            qualificationStatus: "unsupported" | "candidate";
            setupInstructions: readonly string[];
            reason: string;
        };
        preview: import("../autotaxi/route.js").TaxiRoute;
        reason: string;
        scene?: import("../autotaxi/scene.js").TaxiScene;
        error: string;
        active: boolean;
        handedOver: boolean;
        steeringReversed: boolean;
        probing: boolean;
        runwayTravelM: number;
        joinM: number;
        observedSpeedKts: number;
        commanded: import("../autotaxi/controller.js").TaxiInput;
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
            stand?: import("../autotaxi/route.js").TaxiStand;
            points: import("../autotaxi/route.js").Point[];
            holdShort: import("../autotaxi/route.js").Point;
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
        status: "idle" | import("../autotaxi/controller.js").TaxiStatus | "planning";
    }>;
    tick: () => Promise<void>;
    isActive: () => boolean;
    dispose(): Promise<void>;
};
export {};
