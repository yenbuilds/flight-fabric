export type TargetLocation = {
    icao: string;
    name: string;
    lat: number;
    lon: number;
    initialDistanceNm: number | null;
};
type TargetInput = {
    icao?: unknown;
    name?: unknown;
    lat?: unknown;
    lon?: unknown;
    initialDistanceNm?: unknown;
} | null | undefined;
declare const DESTINATION_TARGET_FILE: string;
declare const ORIGIN_TARGET_FILE: string;
export declare function sanitizeTarget(input: TargetInput): TargetLocation | null;
export declare function readDestinationTarget(): TargetLocation | null;
export declare function writeDestinationTarget(target: TargetLocation | null): void;
export declare function clearDestinationTargetFile(): void;
export declare function readOriginTarget(): TargetLocation | null;
export declare function writeOriginTarget(target: TargetLocation | null): void;
export declare function clearOriginTargetFile(): void;
export { DESTINATION_TARGET_FILE, ORIGIN_TARGET_FILE, };
