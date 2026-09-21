import { type TaxiHandling } from './handling.js';
/** Taxiway graph routing in metres east/north of the airport reference. */
export type Point = {
    x: number;
    z: number;
};
export type TaxiPoint = Point & {
    id: number;
    type: number;
    orientation: number;
};
export type TaxiPath = {
    id: number;
    type: number;
    widthM: number;
    start: number;
    end: number;
    runway: string | null;
};
/** SDK TAXI_PARKING record. name and suffix are SDK enums: 1-9 ramp areas, 10 GATE, 11 DOCK, 12-37 GATE_A..GATE_Z (suffix likewise A..Z). */
export type TaxiParking = {
    id: number;
    type: number;
    name: number;
    suffix: number;
    number: number;
    headingDeg: number;
    radiusM: number;
    x: number;
    z: number;
};
export type TaxiParkingOption = {
    label: string;
    typeLabel: string;
};
export type TaxiGraph = {
    complete: boolean;
    points: TaxiPoint[];
    paths: TaxiPath[];
    parkings?: TaxiParking[];
};
export type TaxiStand = Point & {
    headingDeg: number;
    radiusM: number;
    label: string;
};
export type TaxiRoute = {
    points: Point[];
    kind: 'hold' | 'stand';
    label: string;
    runway: string;
    lengthM: number;
    runwayTravelM: number;
    joinM: number;
    holdShort: Point;
    stand?: TaxiStand;
};
export declare const distance: (a: Point, b: Point) => number;
export declare const bearing: (a: Point, b: Point) => number;
export declare const angle: (degrees: number) => number;
export declare function project(p: Point, a: Point, b: Point): {
    point: Point;
    t: number;
    distance: number;
};
export declare function normalizeRunway(value: unknown): string;
export declare function localPosition(lat: number, lon: number, origin: {
    lat: number;
    lon: number;
}): Point;
/** Human label for a stand, e.g. "Gate D 12", "Parking 3A", "Dock 7". */
export declare function parkingLabel(p: TaxiParking): string;
/** Stand names and scenery types for a picker, in natural order. */
export declare function listParkingOptions(graph: TaxiGraph): TaxiParkingOption[];
/** Name-only list retained for clients without stand-type display. */
export declare function listParkings(graph: TaxiGraph): string[];
/** Resolve "D12", "Gate D 12" or "12" to one stand, or explain what is close. */
export declare function findParking(graph: TaxiGraph, query: unknown): TaxiParking;
/** Hold short of a runway: real scenery hold-short nodes only. Runway thresholds alone cannot authorize a route. */
export declare function planTaxiRoute(graph: TaxiGraph, start: Point, heading: number, runway: string, reciprocal: string, threshold: Point, handling?: TaxiHandling): TaxiRoute;
/** Taxi to a named stand, typically after landing: along the landing runway to an exit, then the taxiway network, then the stand's own lead-in link. */
export declare function planTaxiToStand(graph: TaxiGraph, start: Point, heading: number, query: unknown, handling?: TaxiHandling): TaxiRoute;
