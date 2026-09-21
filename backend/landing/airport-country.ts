// airport-country.ts
// Attribute an ISO 3166-1 alpha-2 country to logged airports so the Logbook
// and Recent flights lists can show a flag. Countries come from the bundled
// OurAirports data by exact ICAO / ident match only: a fuzzy name match must
// never put the wrong flag on a flight. Enrichment happens when a list is sent
// to a client, so recordings made before this field existed get flags too.

export type AirportSearchSource = {
  isDataLoaded: () => boolean;
  loadData: () => boolean;
  findAirportByIcao: (icao: string | null | undefined) => { isoCountry: string | null } | null;
};

const airportSearch = require('./airport-search') as AirportSearchSource;

type AnyRecord = Record<string, unknown>;

export type AirportCountryLookup = (icao: string | null | undefined) => string | null;
export type FlightCountries = { departureCountry: string | null; arrivalCountry: string | null };
export type LandingCountry = { country: string | null };

// airport-search re-parses the whole airports.csv on every call after a
// failed load. A list response makes one lookup per airport, so remember a
// failure for a while rather than paying that parse for each row.
export const AIRPORT_DATA_RETRY_MS = 60_000;

export function createAirportCountryLookup(search: AirportSearchSource = airportSearch, now: () => number = Date.now): AirportCountryLookup {
  let failedAtMs: number | null = null;
  return (icao) => {
    if (typeof icao !== 'string' || !icao.trim()) return null;
    try {
      if (!search.isDataLoaded()) {
        if (failedAtMs !== null && now() - failedAtMs < AIRPORT_DATA_RETRY_MS) return null;
        if (!search.loadData()) {
          failedAtMs = now();
          return null;
        }
        failedAtMs = null;
      }
      return search.findAirportByIcao(icao)?.isoCountry || null;
    } catch {
      failedAtMs = now();
      return null;
    }
  };
}

export const airportIsoCountry: AirportCountryLookup = createAirportCountryLookup();

function airportIcaoOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const icao = (value as AnyRecord).icao;
    return typeof icao === 'string' && icao.trim() ? icao.trim() : null;
  }
  return null;
}

/**
 * Add `departureCountry` / `arrivalCountry` to a timeline flight row. Indexed
 * rows carry `departureIcao` / `arrivalIcao`; directory scans carry the
 * airport summaries (or NEAR fallbacks) from the timeline generator. Fields
 * are always present (null when unknown) so the client shape is stable.
 */
export function withFlightCountries<T extends AnyRecord>(flight: T, lookup: AirportCountryLookup = airportIsoCountry): T & FlightCountries {
  if (!flight || typeof flight !== 'object') return flight as T & FlightCountries;
  const departureIcao = airportIcaoOf(flight.departureIcao)
    || airportIcaoOf(flight.departureAirport)
    || airportIcaoOf(flight.departureNearbyAirport);
  const arrivalIcao = airportIcaoOf(flight.arrivalIcao)
    || airportIcaoOf(flight.arrivalAirport)
    || airportIcaoOf(flight.arrivalNearbyAirport);
  return {
    ...flight,
    departureCountry: lookup(departureIcao),
    arrivalCountry: lookup(arrivalIcao),
  };
}

/** Add `country` to a logbook landing entry from its `icao`. */
export function withLandingCountry<T extends AnyRecord>(entry: T, lookup: AirportCountryLookup = airportIsoCountry): T & LandingCountry {
  if (!entry || typeof entry !== 'object') return entry as T & LandingCountry;
  return { ...entry, country: lookup(airportIcaoOf(entry.icao)) };
}

export function withFlightCountriesList(flights: unknown, lookup: AirportCountryLookup = airportIsoCountry): unknown {
  if (!Array.isArray(flights)) return flights;
  return flights.map((flight) => (flight && typeof flight === 'object' ? withFlightCountries(flight as AnyRecord, lookup) : flight));
}

export function withLandingCountryList(entries: unknown, lookup: AirportCountryLookup = airportIsoCountry): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry) => (entry && typeof entry === 'object' ? withLandingCountry(entry as AnyRecord, lookup) : entry));
}
