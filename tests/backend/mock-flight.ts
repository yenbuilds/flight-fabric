const fs = require('fs');
const { decodeLights, rad2deg } = require("../../backend/utils/helpers");
const { feetToMeters, fpmToMs } = require("../../backend/utils/units");

// ------------------------------
// MOCK FLIGHT FRAME GENERATOR
// ------------------------------
// Units match SimConnect-native frame contract (see frame-contract.js):
//   - ias: knots (SimConnect native)
//   - vs:  m/s (converted from SimConnect fps)
//   - ra:  meters (converted from SimConnect feet)
//   - gs:  knots (SimConnect native)
//   - display: pre-computed display units for downstream consumers
// 
// All downstream code should use frame.display.* for threshold logic.
// ------------------------------

// Replay mode state
let replayFrames = null;
let replayIndex = 0;
let replayMetadata = null;

// Sinusoidal mock state
let mock_t = 0;

/**
 * Load an external flight fixture for replay mode.
 * @param {string} filepath - Path to a compatible JSON replay fixture
 * @returns {object} Metadata about loaded flight
 */
function loadReplayFile(filepath) {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (!data.frames || data.frames.length === 0) {
        throw new Error('No frames in replay file');
    }
    replayFrames = data.frames;
    replayIndex = 0;
    replayMetadata = data.metadata;
    console.log(`[Mock] Loaded replay: ${data.metadata.callsign || data.metadata.icao24} (${data.frames.length} frames)`);
    return data.metadata;
}

/**
 * Reset replay to beginning.
 */
function resetReplay() {
    replayIndex = 0;
}

/**
 * Stop replay mode and return to sinusoidal mock.
 */
function stopReplay() {
    replayFrames = null;
    replayIndex = 0;
    replayMetadata = null;
}

/**
 * Convert an external replay frame to Flight Fabric frame format.
 */
function convertReplayFrame(osFrame) {
    const {
        lat,
        lon,
        alt_msl_ft,
        ra_ft,
        hdg_deg,
        ias_kts,
        gs_kts,
        vs_fpm,
        gear_down,
        flaps_extended,
        wow
    } = osFrame;
    
    // Convert to frame contract units (SimConnect-native)
    const ra = feetToMeters(ra_ft || 0);   // meters (internal)
    const ias = ias_kts || 140;             // knots (SimConnect native)
    const vs = fpmToMs(vs_fpm || 0);        // m/s (internal)
    
    const display = {
        iasKts: ias_kts || 0,
        vsFpm: vs_fpm || 0,
        raFt: ra_ft || 0,
        gsKts: gs_kts || 0
    };
    
    return {
        ias,
        vs,
        ra,
        wow: wow || false,
        display,
        gearHandle: gear_down ? 1 : 0,
        gearDownLocked: gear_down ? 0b111 : 0,
        // Gear positions: 0-100 percent (SimConnect-native)
        gearLeft: gear_down ? 100 : 0,
        gearRight: gear_down ? 100 : 0,
        gearNose: gear_down ? 100 : 0,
        lights: decodeLights(1 << 2),
        // Flaps: 0-100 percent (SimConnect-native)
        flaps: flaps_extended ? 100 : 0,
        spoilers: 0,
        pitch: 0,
        bank: 0,
        heading: hdg_deg || 0,
        windSpeed: 5,
        windDir: 270,
        gs: gs_kts || 0,
        alt_msl: alt_msl_ft || 0,
        lat: lat || 0,
        lon: lon || 0,
        checks: {
            speed_ok: ias_kts >= 120 && ias_kts <= 180,
            vs_ok: vs_fpm > -1200,
            gear_ok: gear_down,
            flaps_ok: flaps_extended,
            spoilers_ok: true,
            lights_ok: true,
            pitch_ok: true,
            bank_ok: true
        },
        _replay: true
    };
}

function getMockFrame() {
    // If replay mode is active, return frames from file
    if (replayFrames && replayFrames.length > 0) {
        const frame = replayFrames[replayIndex];
        replayIndex++;
        
        // Loop back to start when done
        if (replayIndex >= replayFrames.length) {
            replayIndex = 0;
        }
        
        return convertReplayFrame(frame);
    }
    
    // Otherwise, generate sinusoidal mock data
    // Target values in display units (for readability)
    const ra_ft  = Math.max(0, 1200 - mock_t * 3);  // feet
    const ias_kt = 150 + Math.sin(mock_t / 10) * 5; // knots
    const vs_fpm = -700 + Math.sin(mock_t / 8) * 40; // fpm

    // Convert to frame contract units (SimConnect-native)
    const ra  = feetToMeters(ra_ft);        // meters (internal storage)
    const ias = ias_kt;                     // knots (SimConnect native)
    const vs  = fpmToMs(vs_fpm);            // m/s (internal storage)
    const gs  = 140;                        // knots (SimConnect native)

    // Pre-computed display units (what downstream modules should use)
    const display = {
        iasKts: ias_kt,
        vsFpm: vs_fpm,
        raFt: ra_ft,
        gsKts: gs,
    };

    const gear     = ra_ft < 900;
    const flaps    = ra_ft < 800;
    const spoilers = false;

    const pitch = 0.05 * Math.sin(mock_t / 12); // radians
    const bank  = 0.03 * Math.sin(mock_t / 7);  // radians

    mock_t++;

    return {
        // Source units (SimConnect-native frame contract)
        ias,        // knots
        vs,         // m/s
        ra,         // meters
        wow: ra_ft < 5,

        // Display units (what downstream modules should use)
        display,

        // mock gear fields match real frame shape
        // Gear positions: 0-100 percent (SimConnect-native)
        gearHandle:     gear ? 1 : 0,
        gearDownLocked: gear ? 0b111 : 0,
        gearLeft:       gear ? 100 : 0,
        gearRight:      gear ? 100 : 0,
        gearNose:       gear ? 100 : 0,

        lights: decodeLights(1 << 2), // landing light ON
        // Flaps/spoilers: 0-100 percent (SimConnect-native)
        flaps: flaps ? 100 : 0,
        spoilers: spoilers ? 100 : 0,
        pitch,
        bank,
        heading: 0,
        windSpeed: 5,
        windDir: 270,
        gs,
        alt_msl: 3000,

        // GPS position - simulated flight path around KJFK (New York JFK)
        // Circle around the airport to show movement on the map
        lat: 40.6413 + 0.01 * Math.sin(mock_t / 50),  // ~JFK latitude
        lon: -73.7781 + 0.01 * Math.cos(mock_t / 50), // ~JFK longitude

        // Minimal checks for stability scorer and landing breakdown in mock
        checks: {
            speed_ok:    (ias_kt >= 140 && ias_kt <= 165),
            vs_ok:       (vs_fpm > -1000),
            gear_ok:     gear,
            flaps_ok:    flaps,
            spoilers_ok: !spoilers,
            lights_ok:   true,
            pitch_ok:    (rad2deg(pitch) > -3 && rad2deg(pitch) < 8),
            bank_ok:     (Math.abs(rad2deg(bank)) < 7)
        }
    };
}

module.exports = { 
    getMockFrame,
    loadReplayFile,
    resetReplay,
    stopReplay,
    isReplaying: () => replayFrames !== null,
    getReplayMetadata: () => replayMetadata
};

export {};
