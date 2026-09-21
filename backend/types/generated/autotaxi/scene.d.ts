/** Map context for the taxi diagram: nearby pavement and runway slabs around a planned route. */
import { type Point, type TaxiGraph, type TaxiRoute } from './route.js';
type Position = {
    lat: number;
    lon: number;
};
export type TaxiRunwayRecord = {
    id: string;
    reciprocal: string;
    threshold: Position;
    headingDeg: number;
    lengthM: number;
    widthM: number;
};
export type SceneLink = {
    a: Point;
    b: Point;
    widthM: number;
    runway: boolean;
};
export type SceneRunway = {
    id: string;
    reciprocal: string;
    corners: Point[];
    ends: [Point, Point];
};
export type SceneStand = Point & {
    radiusM: number;
    headingDeg: number;
    label: string;
};
export type TaxiScene = {
    key: number;
    origin: Position;
    marginM: number;
    bounds: {
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
    };
    runways: SceneRunway[];
    links: SceneLink[];
    stands: SceneStand[];
};
/** Pavement within `marginM` of the route's bounding box. Runways are always drawn whole. */
export declare function buildTaxiScene(graph: TaxiGraph, route: TaxiRoute, origin: Position, runways?: TaxiRunwayRecord[], marginM?: number): TaxiScene;
export {};
