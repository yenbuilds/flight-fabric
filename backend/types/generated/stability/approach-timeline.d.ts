type Event = Record<string, any>;
/** Recorded assessment episodes are authoritative, including an empty list.
 * Do not recalculate them with today's thresholds during ordinary replay. */
export declare function applyRecordedApproachAssessments(events: Event[], flightStartMs: number): Event[];
export {};
