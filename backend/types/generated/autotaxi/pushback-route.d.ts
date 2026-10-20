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
/** Back straight, then one reversing arc and a short alignment on the taxiway. Choose the
 * onward direction by routing to the selected runway, never its compass number.
 * This bounded manoeuvre deliberately rejects complex/ambiguous apron layouts.
 */
export declare function planPushback(airport: TaxiAirport, start: Point, headingDeg: number, runway: string, dimensions: {
    wheelbaseM: number;
    lengthM: number;
}): PushbackPlan;
