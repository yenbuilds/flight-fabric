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
    "CLOSE AIRPORT",
];

// These layouts mirror the ordered fields registered above. Keep field order,
// scalar widths, and `repr(C)` in sync with the SimConnect facility definition.
#[repr(C)]
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
    use super::*;
    use std::mem::offset_of;

    fn test_runway() -> DecodedRunway {
        DecodedRunway {
            latitude_deg: 0.0,
            longitude_deg: 0.0,
            altitude_m: 0.0,
            heading_deg: 0.0,
            length_m: 1000.0,
            width_m: 30.0,
            surface: 0,
            primary_number: 1,
            primary_designator: 0,
            secondary_number: 19,
            secondary_designator: 0,
            pavements: Vec::new(),
        }
    }

    fn c_char_array<const N: usize>(value: &str) -> [c_char; N] {
        let mut output = [0; N];
        for (slot, byte) in output.iter_mut().zip(value.bytes()) {
            *slot = byte as c_char;
        }
        output
    }

    #[test]
    fn facility_payload_reader_rejects_each_truncated_layout() {
        let message = SimConnectRecvFacilityData {
            dw_size: size_of::<SimConnectRecvFacilityData>() as Dword,
            dw_version: 0,
            dw_id: SIMCONNECT_RECV_ID_FACILITY_DATA,
            user_request_id: 1,
            unique_request_id: 2,
            parent_unique_request_id: 0,
            facility_type: FACILITY_DATA_AIRPORT,
            is_list_item: 0,
            item_index: 0,
            list_size: 1,
            data: 0,
        };

        // SAFETY: each call deliberately supplies a length smaller than T, so
        // the decoder must return before reading the trailing payload.
        unsafe {
            assert!(read_facility_payload::<AirportPayload>(
                &message,
                size_of::<AirportPayload>() - 1,
            )
            .is_none());
            assert!(read_facility_payload::<RunwayPayload>(
                &message,
                size_of::<RunwayPayload>() - 1,
            )
            .is_none());
            assert!(read_facility_payload::<PavementPayload>(
                &message,
                size_of::<PavementPayload>() - 1,
            )
            .is_none());
        }
    }

    #[test]
    fn airport_payload_decodes_at_the_exact_reported_size() {
        #[repr(C)]
        struct AirportCallbackFixture {
            header: SimConnectRecvFacilityData,
            tail: [u8; size_of::<AirportPayload>() - size_of::<Dword>()],
        }

        let mut fixture = AirportCallbackFixture {
            header: SimConnectRecvFacilityData {
                dw_size: (facility_data_offset() + size_of::<AirportPayload>()) as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_FACILITY_DATA,
                user_request_id: 1,
                unique_request_id: 2,
                parent_unique_request_id: 0,
                facility_type: FACILITY_DATA_AIRPORT,
                is_list_item: 0,
                item_index: 0,
                list_size: 1,
                data: 0,
            },
            tail: [0; size_of::<AirportPayload>() - size_of::<Dword>()],
        };
        let payload = AirportPayload {
            latitude_deg: -35.3069,
            longitude_deg: 149.195,
            altitude_m: 575.0,
            name: c_char_array("Canberra Airport"),
            icao: c_char_array("YSCB"),
            n_runways: 2,
        };

        // SAFETY: the fixture reserves the fixed header plus the entire trailing
        // AirportPayload, and the decoder intentionally supports unaligned payloads.
        unsafe {
            let payload_ptr = (&mut fixture as *mut AirportCallbackFixture as *mut u8)
                .add(facility_data_offset()) as *mut AirportPayload;
            ptr::write_unaligned(payload_ptr, payload);
        }

        let mut request = AirportFacilityRequest::new(77, "YSCB", "AU");
        request.handle_data(&fixture.header, size_of::<AirportPayload>());
        let decoded = request.to_json(Some("test-simconnect"));

        assert_eq!(decoded["requestId"], 77);
        assert_eq!(decoded["airport"]["icao"], "YSCB");
        assert_eq!(decoded["airport"]["name"], "Canberra Airport");
        assert_eq!(decoded["airport"]["nRunways"], 2);
        assert_eq!(decoded["airport"]["lat"], -35.3069);
        assert_eq!(decoded["airport"]["lon"], 149.195);
        assert!(decoded["airport"]["elevationFt"].as_f64().is_some());
        assert_eq!(decoded["runways"], json!([]));
    }

    #[test]
    fn runway_end_id_formats_number_and_designator() {
        assert_eq!(runway_end_id(1, 0).as_deref(), Some("01"));
        assert_eq!(runway_end_id(9, 1).as_deref(), Some("09L"));
        assert_eq!(runway_end_id(27, 2).as_deref(), Some("27R"));
        assert_eq!(runway_end_id(0, 0), None);
    }

    #[test]
    fn facility_data_type_values_match_msfs_sdk_order() {
        assert_eq!(FACILITY_DATA_AIRPORT, 0);
        assert_eq!(FACILITY_DATA_RUNWAY, 1);
        assert_eq!(FACILITY_DATA_PAVEMENT, 23);
    }

    #[test]
    fn airport_facility_definition_matches_the_documented_sdk_sequence() {
        assert_eq!(
            AIRPORT_FACILITY_FIELDS,
            [
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
                "CLOSE AIRPORT",
            ]
        );
    }

    #[test]
    fn facility_payload_field_offsets_and_wire_widths_match_the_sdk() {
        assert_eq!(offset_of!(AirportPayload, latitude_deg), 0);
        assert_eq!(offset_of!(AirportPayload, longitude_deg), 8);
        assert_eq!(offset_of!(AirportPayload, altitude_m), 16);
        assert_eq!(offset_of!(AirportPayload, name), 24);
        assert_eq!(offset_of!(AirportPayload, icao), 88);
        assert_eq!(offset_of!(AirportPayload, n_runways), 96);
        let airport_wire_bytes = offset_of!(AirportPayload, n_runways) + size_of::<i32>();
        assert_eq!(airport_wire_bytes, 100);
        // `repr(C)` rounds the Rust type up to f64 alignment. Recording the
        // difference prevents a future audit from mistaking 104 for the SDK's
        // serialized field width.
        assert_eq!(size_of::<AirportPayload>(), 104);
        assert_eq!(size_of::<AirportPayload>() - airport_wire_bytes, 4);

        assert_eq!(offset_of!(RunwayPayload, latitude_deg), 0);
        assert_eq!(offset_of!(RunwayPayload, longitude_deg), 8);
        assert_eq!(offset_of!(RunwayPayload, altitude_m), 16);
        assert_eq!(offset_of!(RunwayPayload, heading_deg), 24);
        assert_eq!(offset_of!(RunwayPayload, length_m), 28);
        assert_eq!(offset_of!(RunwayPayload, width_m), 32);
        assert_eq!(offset_of!(RunwayPayload, surface), 36);
        assert_eq!(offset_of!(RunwayPayload, primary_number), 40);
        assert_eq!(offset_of!(RunwayPayload, primary_designator), 44);
        assert_eq!(offset_of!(RunwayPayload, secondary_number), 48);
        assert_eq!(offset_of!(RunwayPayload, secondary_designator), 52);
        assert_eq!(size_of::<RunwayPayload>(), 56);

        assert_eq!(offset_of!(PavementPayload, length_m), 0);
        assert_eq!(offset_of!(PavementPayload, width_m), 4);
        assert_eq!(offset_of!(PavementPayload, enable), 8);
        assert_eq!(size_of::<PavementPayload>(), 12);
    }

    #[test]
    fn facility_collection_limits_are_far_above_normal_airport_data() {
        let mut request = AirportFacilityRequest::new(1, "TEST", "");
        assert!(request.can_accept_runway());
        request.runways = vec![test_runway(); MAX_FACILITY_RUNWAYS];
        assert_eq!(request.runways.len(), 256);
        assert!(!request.can_accept_runway());

        request.runways[0].pavements = vec![
            DecodedPavement {
                length_m: 1.0,
                width_m: 1.0,
                enable: true,
            };
            MAX_FACILITY_PAVEMENTS_PER_RUNWAY
        ];
        assert_eq!(request.runways[0].pavements.len(), 64);
        assert!(!request.can_accept_pavement(0));
        assert!(!request.can_accept_pavement(MAX_FACILITY_RUNWAYS));
    }

    #[test]
    fn runway_records_use_physical_threshold_plus_displacement() {
        let runway = DecodedRunway {
            latitude_deg: 0.0,
            longitude_deg: 0.0,
            altitude_m: 10.0,
            heading_deg: 0.0,
            length_m: 304.8,
            width_m: 45.72,
            surface: 4,
            primary_number: 18,
            primary_designator: 0,
            secondary_number: 36,
            secondary_designator: 0,
            pavements: vec![
                DecodedPavement {
                    length_m: 30.48,
                    width_m: 45.72,
                    enable: true,
                },
                DecodedPavement {
                    length_m: 0.0,
                    width_m: 45.72,
                    enable: false,
                },
            ],
        };

        let records = runway_to_end_records(&runway, "TEST", "Test Airport", Some(33.0));
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["runway"], "18");
        assert_eq!(records[0]["surface"], "ASPHALT");
        assert_eq!(records[0]["elevationReference"], "runway");
        assert!((records[0]["elevation_ft"].as_f64().unwrap() - 32.8084).abs() < 0.01);
        assert!((records[0]["physicalLengthFt"].as_f64().unwrap() - 1000.0).abs() < 0.01);
        assert!((records[0]["displacedThresholdFt"].as_f64().unwrap() - 100.0).abs() < 0.01);
        assert!((records[0]["lengthFt"].as_f64().unwrap() - 900.0).abs() < 0.01);
        assert_ne!(
            records[0]["threshold"]["lat"].as_f64().unwrap(),
            records[0]["physicalThreshold"]["lat"].as_f64().unwrap()
        );

        let mut runway_without_elevation = runway.clone();
        runway_without_elevation.altitude_m = f64::NAN;
        let fallback_records = runway_to_end_records(
            &runway_without_elevation,
            "TEST",
            "Test Airport",
            Some(33.0),
        );
        assert_eq!(fallback_records[0]["elevationReference"], "airport");
        assert_eq!(fallback_records[0]["elevation_ft"], 33.0);
    }
}
