export type AirportSearchSource = {
    isDataLoaded: () => boolean;
    loadData: () => boolean;
    findAirportByIcao: (icao: string | null | undefined) => {
        isoCountry: string | null;
    } | null;
};
type AnyRecord = Record<string, unknown>;
export type AirportCountryLookup = (icao: string | null | undefined) => string | null;
export type FlightCountries = {
    departureCountry: string | null;
    arrivalCountry: string | null;
};
export type LandingCountry = {
    country: string | null;
};
export declare const AIRPORT_DATA_RETRY_MS = 60000;
export declare function createAirportCountryLookup(search?: AirportSearchSource, now?: () => number): AirportCountryLookup;
export declare const airportIsoCountry: AirportCountryLookup;
/**
 * Add `departureCountry` / `arrivalCountry` to a timeline flight row. Indexed
 * rows carry `departureIcao` / `arrivalIcao`; directory scans carry the
 * airport summaries (or NEAR fallbacks) from the timeline generator. Fields
 * are always present (null when unknown) so the client shape is stable.
 */
export declare function withFlightCountries<T extends AnyRecord>(flight: T, lookup?: AirportCountryLookup): T & FlightCountries;
/** Add `country` to a logbook landing entry from its `icao`. */
export declare function withLandingCountry<T extends AnyRecord>(entry: T, lookup?: AirportCountryLookup): T & LandingCountry;
export declare function withFlightCountriesList(flights: unknown, lookup?: AirportCountryLookup): unknown;
export declare function withLandingCountryList(entries: unknown, lookup?: AirportCountryLookup): unknown;
export {};
