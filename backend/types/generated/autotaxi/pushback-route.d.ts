import { type Point, type TaxiRoute } from './route.js';
import type { TaxiAirport } from './session.js';
export type PushbackPoint = Point & {
    headingDeg: number;
    distanceM: number;
};
export type PushbackPlan = {
    points: PushbackPoint[];
    lengthM: number;
    headingDeg: number;
    taxiRoute: TaxiRoute;
};
/** Back clear, turn in reverse and align on the taxiway. Prefer one arc; a bounded
 * opposite turn first can leave room to face out of a dead-end apron.
 * Choose direction by routing to the selected runway, never its compass number.
 */
export declare function planPushback(airport: TaxiAirport, start: Point, headingDeg: number, runway: string, dimensions: {
    wheelbaseM: number;
    lengthM: number;
}): PushbackPlan;
