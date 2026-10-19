//! Airport-facility response decoding and runway geometry assembly.
//!
//! SimConnect returns an airport as a hierarchy of airport, runway, threshold,
//! and pavement callbacks. `AirportFacilityRequest` accumulates that stream,
//! enforces collection limits, and turns the completed response into the
//! runway-end JSON consumed by the Node backend. Geometry helpers below derive
//! physical and displaced thresholds while rejecting non-finite native data.

use crate::simconnect_ffi::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::c_char;
use std::mem::size_of;
use std::ptr;
use std::slice;
use std::time::Instant;

const METERS_TO_FEET: f64 = 3.280_839_895;
const FT_PER_DEG_LAT: f64 = 364_567.0;

// MSFS SDK SIMCONNECT_FACILITY_DATA_TYPE enum order:
// AIRPORT=0, RUNWAY=1, PAVEMENT follows ROUTE at index 23.
pub(crate) const FACILITY_DATA_AIRPORT: Dword = 0;
pub(crate) const FACILITY_DATA_RUNWAY: Dword = 1;
pub(crate) const FACILITY_DATA_PAVEMENT: Dword = 23;
const FACILITY_DATA_TAXI_POINT: Dword = 14;
const FACILITY_DATA_TAXI_PARKING: Dword = 15;
const FACILITY_DATA_TAXI_PATH: Dword = 16;
const MAX_TAXI_ITEMS: usize = 20000;
pub(crate) const MAX_FACILITY_RUNWAYS: usize = 256;
pub(crate) const MAX_FACILITY_PAVEMENTS_PER_RUNWAY: usize = 64;

pub(crate) const AIRPORT_FACILITY_FIELDS: &[&str] = &[
    "OPEN AIRPORT",
    "LATITUDE",
    "LONGITUDE",
    "ALTITUDE",
    "NAME64",
    "ICAO",
    "N_RUNWAYS",
    "OPEN RUNWAY",
    "LATITUDE",
    "LONGITUDE",
    "ALTITUDE",
    "HEADING",
    "LENGTH",
    "WIDTH",
    "SURFACE",
    "PRIMARY_NUMBER",
    "PRIMARY_DESIGNATOR",
    "SECONDARY_NUMBER",
    "SECONDARY_DESIGNATOR",
    "OPEN PRIMARY_THRESHOLD",
    "LENGTH",
    "WIDTH",
    "ENABLE",
    "CLOSE PRIMARY_THRESHOLD",
    "OPEN SECONDARY_THRESHOLD",
    "LENGTH",
    "WIDTH",
    "ENABLE",
    "CLOSE SECONDARY_THRESHOLD",
    "CLOSE RUNWAY",
    "OPEN TAXI_POINT",
    "TYPE",
    "ORIENTATION",
    "BIAS_X",
    "BIAS_Z",
    "CLOSE TAXI_POINT",
    "OPEN TAXI_PARKING",
    "TYPE",
    "TAXI_POINT_TYPE",
    "NAME",
    "SUFFIX",
    "NUMBER",
    "ORIENTATION",
    "HEADING",
    "RADIUS",
    "BIAS_X",
    "BIAS_Z",
    "CLOSE TAXI_PARKING",
    "OPEN TAXI_PATH",
    "TYPE",
    "WIDTH",
    "START",
    "END",
    "RUNWAY_NUMBER",
    "RUNWAY_DESIGNATOR",
    "CLOSE TAXI_PATH",
    "CLOSE AIRPORT",
];

#[repr(C)]
#[derive(Clone, Copy)]
struct TaxiPointPayload { kind: i32, orientation: i32, x: f32, z: f32 }

#[repr(C)]
#[derive(Clone, Copy)]
struct TaxiPathPayload { kind: i32, width: f32, start: i32, end: i32, number: i32, designator: i32 }

// Parking spots (gates, stands, ramps). PARKING-type paths end on these indices.
#[repr(C)]
#[derive(Clone, Copy)]
struct TaxiParkingPayload { kind: i32, point_kind: i32, name: i32, suffix: i32, number: u32, orientation: i32, heading: f32, radius: f32, x: f32, z: f32 }

// These layouts mirror the ordered fields registered above. Keep field order,
// scalar widths, and `repr(C)` in sync with the SimConnect facility definition.
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
struct AirportPayload {
    latitude_deg: f64,
    longitude_deg: f64,
    altitude_m: f64,
    name: [c_char; 64],
    icao: [c_char; 8],
    n_runways: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct RunwayPayload {
    latitude_deg: f64,
    longitude_deg: f64,
    altitude_m: f64,
    heading_deg: f32,
    length_m: f32,
    width_m: f32,
    surface: i32,
    primary_number: i32,
    primary_designator: i32,
    secondary_number: i32,
    secondary_designator: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PavementPayload {
    length_m: f32,
    width_m: f32,
    enable: i32,
}

#[derive(Clone)]
struct DecodedAirport {
    latitude_deg: f64,
    longitude_deg: f64,
    altitude_m: f64,
    name: String,
    icao: String,
    n_runways: i32,
}

#[derive(Clone)]
struct DecodedRunway {
    latitude_deg: f64,
    longitude_deg: f64,
    altitude_m: f64,
    heading_deg: f64,
    length_m: f64,
    width_m: f64,
    surface: i32,
    primary_number: i32,
    primary_designator: i32,
    secondary_number: i32,
    secondary_designator: i32,
    pavements: Vec<DecodedPavement>,
}

#[derive(Clone)]
struct DecodedPavement {
    length_m: f64,
    width_m: f64,
    enable: bool,
}

// One accumulator exists per outstanding client request. SimConnect's native
// request ID is the map key in `main.rs`; `client_request_id` is echoed to JS.
pub(crate) struct AirportFacilityRequest {
    pub(crate) client_request_id: u64,
    requested_icao: String,
    region: String,
    started_at: Instant,
    airport: Option<DecodedAirport>,
    runways: Vec<DecodedRunway>,
    runway_index_by_unique_id: HashMap<Dword, usize>,
    taxi_points: HashMap<Dword, Value>,
    taxi_paths: HashMap<Dword, Value>,
    taxi_parkings: HashMap<Dword, Value>,
    taxi_point_count: usize,
    taxi_path_count: usize,
    taxi_parking_count: usize,
    taxi_invalid: bool,
}

impl AirportFacilityRequest {
    pub(crate) fn new(client_request_id: u64, requested_icao: &str, region: &str) -> Self {
        Self {
            client_request_id,
            requested_icao: requested_icao.trim().to_uppercase(),
            region: region.trim().to_uppercase(),
            started_at: Instant::now(),
            airport: None,
            runways: Vec::new(),
            runway_index_by_unique_id: HashMap::new(),
            taxi_points: HashMap::new(),
            taxi_paths: HashMap::new(),
            taxi_parkings: HashMap::new(),
            taxi_point_count: 0,
            taxi_path_count: 0,
            taxi_parking_count: 0,
            taxi_invalid: false,
        }
    }

    pub(crate) fn age_ms(&self) -> u128 {
        self.started_at.elapsed().as_millis()
    }

    pub(crate) fn requested_icao(&self) -> &str {
        &self.requested_icao
    }

    fn can_accept_runway(&self) -> bool {
        self.runways.len() < MAX_FACILITY_RUNWAYS
    }

    fn can_accept_pavement(&self, runway_index: usize) -> bool {
        self.runways
            .get(runway_index)
            .is_some_and(|runway| {
                runway.pavements.len() < MAX_FACILITY_PAVEMENTS_PER_RUNWAY
            })
    }

    pub(crate) fn handle_data(
        &mut self,
        message: &SimConnectRecvFacilityData,
        payload_len: usize,
    ) {
        match message.facility_type {
            FACILITY_DATA_TAXI_POINT | FACILITY_DATA_TAXI_PATH | FACILITY_DATA_TAXI_PARKING => {
                let count = message.list_size as usize;
                if message.is_list_item == 0 || count == 0 || count > MAX_TAXI_ITEMS || message.item_index as usize >= count {
                    self.taxi_invalid = true;
                    return;
                }
                if message.facility_type == FACILITY_DATA_TAXI_POINT {
                    if self.taxi_point_count != 0 && self.taxi_point_count != count { self.taxi_invalid = true; }
                    self.taxi_point_count = count;
                    if let Some(p) = unsafe { read_facility_payload::<TaxiPointPayload>(message, payload_len) } {
                        if !p.x.is_finite() || !p.z.is_finite() { self.taxi_invalid = true; return; }
                        if self.taxi_points.insert(message.item_index, json!({ "id": message.item_index,
                            "type": p.kind, "orientation": p.orientation, "x": p.x, "z": p.z })).is_some() {
                            self.taxi_invalid = true;
                        }
                    } else { self.taxi_invalid = true; }
                } else if message.facility_type == FACILITY_DATA_TAXI_PARKING {
                    if self.taxi_parking_count != 0 && self.taxi_parking_count != count { self.taxi_invalid = true; }
                    self.taxi_parking_count = count;
                    if let Some(p) = unsafe { read_facility_payload::<TaxiParkingPayload>(message, payload_len) } {
                        if !p.x.is_finite() || !p.z.is_finite() || !p.heading.is_finite() || !p.radius.is_finite() { self.taxi_invalid = true; return; }
                        if self.taxi_parkings.insert(message.item_index, json!({ "id": message.item_index,
                            "type": p.kind, "name": p.name, "suffix": p.suffix, "number": p.number,
                            "headingDeg": p.heading, "radiusM": p.radius, "x": p.x, "z": p.z })).is_some() {
                            self.taxi_invalid = true;
                        }
                    } else { self.taxi_invalid = true; }
                } else {
                    if self.taxi_path_count != 0 && self.taxi_path_count != count { self.taxi_invalid = true; }
                    self.taxi_path_count = count;
                    if let Some(p) = unsafe { read_facility_payload::<TaxiPathPayload>(message, payload_len) } {
                        if !p.width.is_finite() { self.taxi_invalid = true; return; }
                        if self.taxi_paths.insert(message.item_index, json!({ "id": message.item_index,
                            "type": p.kind, "widthM": p.width, "start": p.start, "end": p.end,
                            "runway": runway_end_id(p.number, p.designator) })).is_some() {
                            self.taxi_invalid = true;
                        }
                    } else { self.taxi_invalid = true; }
                }
            }
            FACILITY_DATA_AIRPORT => {
                if let Some(payload) = unsafe { read_facility_payload::<AirportPayload>(message, payload_len) } {
                    self.airport = Some(DecodedAirport {
                        latitude_deg: payload.latitude_deg,
                        longitude_deg: payload.longitude_deg,
                        altitude_m: payload.altitude_m,
                        name: char_array_to_string(&payload.name),
                        icao: char_array_to_string(&payload.icao).to_uppercase(),
                        n_runways: payload.n_runways,
                    });
                }
            }
            FACILITY_DATA_RUNWAY => {
                if !self.can_accept_runway() {
                    return;
                }
                if let Some(payload) = unsafe { read_facility_payload::<RunwayPayload>(message, payload_len) } {
                    let index = self.runways.len();
                    self.runways.push(DecodedRunway {
                        latitude_deg: payload.latitude_deg,
                        longitude_deg: payload.longitude_deg,
                        altitude_m: payload.altitude_m,
                        heading_deg: payload.heading_deg as f64,
                        length_m: payload.length_m as f64,
                        width_m: payload.width_m as f64,
                        surface: payload.surface,
                        primary_number: payload.primary_number,
                        primary_designator: payload.primary_designator,
                        secondary_number: payload.secondary_number,
                        secondary_designator: payload.secondary_designator,
                        pavements: Vec::new(),
                    });
                    self.runway_index_by_unique_id
                        .insert(message.unique_request_id, index);
                }
            }
            FACILITY_DATA_PAVEMENT => {
                let Some(index) = self
                    .runway_index_by_unique_id
                    .get(&message.parent_unique_request_id)
                    .copied()
                else {
                    return;
                };
                if !self.can_accept_pavement(index) {
                    return;
                }
                if let Some(payload) = unsafe { read_facility_payload::<PavementPayload>(message, payload_len) } {
                    self.runways[index].pavements.push(DecodedPavement {
                        length_m: payload.length_m as f64,
                        width_m: payload.width_m as f64,
                        enable: payload.enable != 0,
                    });
                }
            }
            _ => {}
        }
    }

    pub(crate) fn to_json(&self, library_spec: Option<&str>) -> Value {
        let airport = self.airport.clone();
        let icao = airport
            .as_ref()
            .map(|item| item.icao.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.requested_icao)
            .to_string();
        let airport_name = airport
            .as_ref()
            .map(|item| item.name.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or(&icao)
            .to_string();
        let airport_elevation_ft = airport.as_ref().and_then(|item| meters_to_feet(item.altitude_m));
        let runways: Vec<Value> = self
            .runways
            .iter()
            .flat_map(|runway| runway_to_end_records(runway, &icao, &airport_name, airport_elevation_ft))
            .collect();

        json!({
            "type": "facilityAirport",
            "ok": true,
            "requestId": self.client_request_id,
            "source": "msfs-facilities",
            "backend": "rust",
            "librarySpec": library_spec,
            "icao": icao,
            "region": self.region,
            "airportName": airport_name,
            "airport": {
                "icao": icao,
                "name": airport_name,
                "lat": airport.as_ref().and_then(|item| finite(item.latitude_deg)),
                "lon": airport.as_ref().and_then(|item| finite(item.longitude_deg)),
                "elevationFt": airport_elevation_ft,
                "nRunways": airport.as_ref().map(|item| item.n_runways),
            },
            "runways": runways,
            "taxiways": {
                "complete": !self.taxi_invalid && self.taxi_point_count > 0 && self.taxi_path_count > 0
                    && self.taxi_points.len() == self.taxi_point_count && self.taxi_paths.len() == self.taxi_path_count
                    && self.taxi_parkings.len() == self.taxi_parking_count,
                "points": (0..self.taxi_point_count as Dword).filter_map(|id| self.taxi_points.get(&id)).collect::<Vec<_>>(),
                "paths": (0..self.taxi_path_count as Dword).filter_map(|id| self.taxi_paths.get(&id)).collect::<Vec<_>>(),
                "parkings": (0..self.taxi_parking_count as Dword).filter_map(|id| self.taxi_parkings.get(&id)).collect::<Vec<_>>(),
            },
            "elapsedMs": self.age_ms(),
            "timestampIso": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        })
    }
}

// Native callbacks contain a fixed header followed by a variable payload.
// Callers pass the already-bounded payload length before this typed copy occurs.
unsafe fn read_facility_payload<T: Copy>(
    message: &SimConnectRecvFacilityData,
    payload_len: usize,
) -> Option<T> {
    if payload_len < size_of::<T>() {
        return None;
    }
    let ptr = ptr::addr_of!(message.data) as *const T;
    Some(unsafe { ptr::read_unaligned(ptr) })
}

fn char_array_to_string(raw: &[c_char]) -> String {
    let bytes = unsafe { slice::from_raw_parts(raw.as_ptr() as *const u8, raw.len()) };
    let len = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..len]).trim().to_string()
}

fn finite(value: f64) -> Option<f64> {
    if value.is_finite() {
        Some(value)
    } else {
        None
    }
}

fn meters_to_feet(value: f64) -> Option<f64> {
    if value.is_finite() && value >= 0.0 {
        Some(value * METERS_TO_FEET)
    } else {
        None
    }
}

fn normalize_heading(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    Some(value.rem_euclid(360.0))
}

fn move_along_heading(lat: f64, lon: f64, heading_deg: f64, distance_ft: f64) -> Option<(f64, f64)> {
    if ![lat, lon, heading_deg, distance_ft]
        .iter()
        .all(|value| value.is_finite())
    {
        return None;
    }
    let heading_rad = heading_deg.to_radians();
    let north_ft = heading_rad.cos() * distance_ft;
    let east_ft = heading_rad.sin() * distance_ft;
    let cos_lat = lat.to_radians().cos();
    if cos_lat.abs() < 1e-9 {
        return None;
    }
    Some((
        lat + north_ft / FT_PER_DEG_LAT,
        lon + east_ft / (FT_PER_DEG_LAT * cos_lat),
    ))
}

fn runway_end_id(number: i32, designator: i32) -> Option<String> {
    let base = match number {
        1..=36 => format!("{number:02}"),
        37 => "N".to_string(),
        38 => "NE".to_string(),
        39 => "E".to_string(),
        40 => "SE".to_string(),
        41 => "S".to_string(),
        42 => "SW".to_string(),
        43 => "W".to_string(),
        44 => "NW".to_string(),
        _ => return None,
    };
    let suffix = match designator {
        1 => "L",
        2 => "R",
        3 => "C",
        4 => "W",
        5 => "A",
        6 => "B",
        _ => "",
    };
    Some(format!("{base}{suffix}"))
}

fn surface_name(value: i32) -> &'static str {
    match value {
        0 => "CONCRETE",
        1 => "GRASS",
        2 => "WATER_FSX",
        3 => "GRASS_BUMPY",
        4 => "ASPHALT",
        5 => "SHORT_GRASS",
        6 => "LONG_GRASS",
        7 => "HARD_TURF",
        8 => "SNOW",
        9 => "ICE",
        10 => "URBAN",
        11 => "FOREST",
        12 => "DIRT",
        13 => "CORAL",
        14 => "GRAVEL",
        15 => "OIL_TREATED",
        16 => "STEEL_MATS",
        17 => "BITUMINUS",
        18 => "BRICK",
        19 => "MACADAM",
        20 => "PLANKS",
        21 => "SAND",
        22 => "SHALE",
        23 => "TARMAC",
        24 => "WRIGHT_FLYER_TRACK",
        26 => "OCEAN",
        27 => "WATER",
        28 => "POND",
        29 => "LAKE",
        30 => "RIVER",
        31 => "WASTE_WATER",
        32 => "PAINT",
        254 => "UNKNOWN",
        255 => "UNDEFINED",
        _ => "UNKNOWN",
    }
}

fn pavement_displacement_ft(pavement: Option<&DecodedPavement>) -> Option<f64> {
    let pavement = pavement?;
    if !pavement.enable {
        return Some(0.0);
    }
    meters_to_feet(pavement.length_m)
}

// A physical runway produces up to two consumer records, one for each usable
// direction. Each record gets its own threshold point, heading, and displacement.
fn runway_to_end_records(
    runway: &DecodedRunway,
    icao: &str,
    airport_name: &str,
    airport_elevation_ft: Option<f64>,
) -> Vec<Value> {
    let Some(heading) = normalize_heading(runway.heading_deg) else {
        return Vec::new();
    };
    let Some(physical_length_ft) = meters_to_feet(runway.length_m) else {
        return Vec::new();
    };
    let Some(width_ft) = meters_to_feet(runway.width_m) else {
        return Vec::new();
    };
    let Some(primary_id) = runway_end_id(runway.primary_number, runway.primary_designator) else {
        return Vec::new();
    };
    let Some(secondary_id) = runway_end_id(runway.secondary_number, runway.secondary_designator) else {
        return Vec::new();
    };

    let half_length_ft = physical_length_ft / 2.0;
    let Some((primary_lat, primary_lon)) = move_along_heading(
        runway.latitude_deg,
        runway.longitude_deg,
        heading + 180.0,
        half_length_ft,
    ) else {
        return Vec::new();
    };
    let Some((secondary_lat, secondary_lon)) = move_along_heading(
        runway.latitude_deg,
        runway.longitude_deg,
        heading,
        half_length_ft,
    ) else {
        return Vec::new();
    };

    let primary_displacement_ft = pavement_displacement_ft(runway.pavements.get(0));
    let secondary_displacement_ft = pavement_displacement_ft(runway.pavements.get(1));

    vec![
        build_runway_end_record(
            icao,
            airport_name,
            airport_elevation_ft,
            runway,
            &primary_id,
            &secondary_id,
            primary_lat,
            primary_lon,
            heading,
            physical_length_ft,
            width_ft,
            primary_displacement_ft,
            runway.pavements.get(0),
        ),
        build_runway_end_record(
            icao,
            airport_name,
            airport_elevation_ft,
            runway,
            &secondary_id,
            &primary_id,
            secondary_lat,
            secondary_lon,
            heading + 180.0,
            physical_length_ft,
            width_ft,
            secondary_displacement_ft,
            runway.pavements.get(1),
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn build_runway_end_record(
    icao: &str,
    airport_name: &str,
    airport_elevation_ft: Option<f64>,
    runway: &DecodedRunway,
    runway_id: &str,
    reciprocal_runway_id: &str,
    physical_lat: f64,
    physical_lon: f64,
    heading_deg: f64,
    physical_length_ft: f64,
    width_ft: f64,
    displaced_threshold_ft: Option<f64>,
    threshold_pavement: Option<&DecodedPavement>,
) -> Value {
    let heading = normalize_heading(heading_deg).unwrap_or(heading_deg);
    let displacement = displaced_threshold_ft.unwrap_or(0.0).max(0.0);
    let (threshold_lat, threshold_lon) = move_along_heading(physical_lat, physical_lon, heading, displacement)
        .unwrap_or((physical_lat, physical_lon));
    let length_ft = (physical_length_ft - displacement).max(0.0);
    let runway_elevation_ft = meters_to_feet(runway.altitude_m);
    let elevation_ft = runway_elevation_ft.or(airport_elevation_ft);
    let elevation_reference = if runway_elevation_ft.is_some() { "runway" } else { "airport" };

    json!({
        "icao": icao,
        "airportName": airport_name,
        "runway": runway_id,
        "reciprocalRunway": reciprocal_runway_id,
        "source": "msfs-facilities",
        "headingTrueDeg": heading,
        "heading_true_deg": heading,
        "heading": heading,
        "lengthFt": length_ft,
        "physicalLengthFt": physical_length_ft,
        "widthFt": width_ft,
        "surface": surface_name(runway.surface),
        "threshold": { "lat": threshold_lat, "lon": threshold_lon },
        "physicalThreshold": { "lat": physical_lat, "lon": physical_lon },
        "displacedThresholdFt": displaced_threshold_ft,
        "elevation_ft": elevation_ft,
        "elevationReference": elevation_reference,
        "thresholdPavement": threshold_pavement.map(|item| json!({
            "lengthFt": meters_to_feet(item.length_m),
            "widthFt": meters_to_feet(item.width_m),
            "enable": item.enable,
        })),
        "thresholdMapping": "facilities-threshold-pavement",
        "thresholdMappingValidated": false,
    })
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/facilities-tests.rs"));
}
