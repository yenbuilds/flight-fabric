import { type PushbackPlan } from './pushback-route.js';
import { type TaxiScene } from './scene.js';
import type { PushbackDependencies } from './pushback-session.js';
import type { TaxiAirport } from './session.js';
export type PreparedPushback = {
    id: string;
    icao: string;
    runway: string;
    airport: TaxiAirport;
    plan: PushbackPlan;
    scene: TaxiScene;
    /** Read-only checks against the aircraft/configuration that produced this plan. */
    sameAircraft: () => boolean;
    valid: () => boolean;
};
type Dependencies = Pick<PushbackDependencies, 'now' | 'capture' | 'dimensions' | 'airport'>;
/** Per-viewer dry runs. This module has no simulator write dependency. */
export declare function createPushbackPreviews(deps: Dependencies): {
    request: (message: Record<string, any>, client: object, connected: () => boolean) => Promise<{
        scene?: TaxiScene;
        preview?: import("./route.js").TaxiRoute;
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
            points?: import("./pushback-route.js").PushbackPoint[];
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
    prepared: (message: Record<string, any>, client: object) => PreparedPushback;
    view: (p: PreparedPushback | null, geometry?: boolean, phase?: string, remainingM?: number) => {
        scene?: TaxiScene;
        preview?: import("./route.js").TaxiRoute;
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
            points?: import("./pushback-route.js").PushbackPoint[];
            id: string;
            icao: string;
            runway: string;
            phase: string;
            valid: boolean;
            lengthM: number;
            headingDeg: number;
            remainingM: number;
        };
    };
    matches: (p: PreparedPushback, message: Record<string, any>) => boolean;
};
export {};
