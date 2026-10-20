import { type PushbackCommand } from '../autotaxi/pushback-session.js';
export declare function tugHeading(headingDeg: number): number;
export declare function writeSimulatorTug(bridge: {
    sendEvent: (name: string, value: number) => Promise<any>;
    startPushback?: () => Promise<any>;
}, command: PushbackCommand, valid: () => boolean): Promise<any[]>;
export declare function createAircraftPushback(provider: Record<string, any>, profiles: Record<string, any>, now?: () => number): {
    request: (message: Record<string, any>, client: object, connected: () => boolean) => Promise<{
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
    preview: (message: Record<string, any>, client: object, connected: () => boolean) => {
        scene?: import("../autotaxi/scene.js").TaxiScene;
        preview?: import("../autotaxi/route.js").TaxiRoute;
        canGuide: boolean;
        guidanceUnavailableReason: string;
        currentProfileKey: string;
        currentProfileRevision: number;
        aircraft: {
            headingDeg: number;
            speedKts: number;
            x: number;
            z: number;
        };
        sceneKey: number;
        pushbackPreview: {
            points?: import("../autotaxi/pushback-route.js").PushbackPoint[];
            id: string;
            icao: string;
            runway: string;
            phase: string;
            valid: boolean;
            lengthM: number;
            headingDeg: number;
            remainingM: number;
        };
    } | Promise<{
        scene?: import("../autotaxi/scene.js").TaxiScene;
        preview?: import("../autotaxi/route.js").TaxiRoute;
        canGuide: boolean;
        guidanceUnavailableReason: string;
        currentProfileKey: string;
        currentProfileRevision: number;
        aircraft: {
            headingDeg: number;
            speedKts: number;
            x: number;
            z: number;
        };
        sceneKey: number;
        pushbackPreview: {
            points?: import("../autotaxi/pushback-route.js").PushbackPoint[];
            id: string;
            icao: string;
            runway: string;
            phase: string;
            valid: boolean;
            lengthM: number;
            headingDeg: number;
            remainingM: number;
        };
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
