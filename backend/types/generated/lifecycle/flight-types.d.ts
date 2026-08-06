declare const FLIGHT_TYPE: Readonly<{
    readonly PATTERN_WORK: "PATTERN_WORK";
    readonly CROSS_COUNTRY: "CROSS_COUNTRY";
    readonly LOCAL_FLIGHT: "LOCAL_FLIGHT";
    readonly UNKNOWN: "UNKNOWN";
}>;
export type FlightTypeMap = typeof FLIGHT_TYPE;
export type FlightTypeValue = FlightTypeMap[keyof FlightTypeMap];
export {};
