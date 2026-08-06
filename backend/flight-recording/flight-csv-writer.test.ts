/**
 * Tests for flight-csv-writer.
 * Run: node dist/backend/flight-recording/flight-csv-writer.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const testDir = path.join(os.tmpdir(), 'flight-csv-test-' + Date.now());
const isolatedHome = path.join(testDir, 'isolated-home');
const isolatedEnvironmentKeys = [
  'APPDATA',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'OneDrive',
  'ONEDRIVE',
  'OneDriveConsumer',
  'OneDriveCommercial',
  'FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS',
];
const previousEnvironment = Object.fromEntries(
  isolatedEnvironmentKeys.map((key) => [key, process.env[key]]),
);

process.env.APPDATA = path.join(isolatedHome, 'AppData', 'Roaming');
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config');
process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS = '1';
delete process.env.OneDrive;
delete process.env.ONEDRIVE;
delete process.env.OneDriveConsumer;
delete process.env.OneDriveCommercial;

// Load the recorder only after its Documents-path inputs are isolated. This
// keeps even default-path tests away from the user's real Flight Logs folder.
const writer = require('./flight-csv-writer.js');
const { parseCsvLine, splitCsvLines } = require('../utils/csv');
const timeSource = require('../core/time-source');

function restoreEnvironment() {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function readCsvDataRows(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = splitCsvLines(content, { trimAndDropEmpty: true });
  const headerFields = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(
      headerFields.map((field, index) => [field, values[index] ?? ''])
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Main async test runner
// ═══════════════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('\nFlight CSV Writer Tests\n');
  console.log('Test directory:', testDir);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // Test: Basic write cycle
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('Basic write cycle:');

  const w = writer.startFlight({ 
    flightId: '2025-01-03T12-00-00',
    outputDir: testDir,
  });

  test('startFlight returns writer', () => {
    assert(w !== null, 'Writer should not be null');
  });

  test('isRecording returns true', () => {
    assert(writer.isRecording(), 'Should be recording');
  });

  // Write samples
  for (let i = 0; i < 5; i++) {
    w.writeSample({
      timestampMs: Date.now() + i * 1000,
      timestampIso: new Date().toISOString(),
      onGround: i < 2,
      phase: i < 2 ? 'TAXI' : 'TAKEOFF',
      ias: 50 + i * 30,
      vs: i < 2 ? 0 : 500 + i * 100,
      pitch: 5,
      bank: 0,
      lat: 47.0 + i * 0.01,
      lon: -122.0,
      gForce: 1.0,
      xwind: 8,
      windSpeed: 10,
      windDir: 270,
      seaLevelPressureMb: 1013.2,
      precipRateMm: 1.25,
      precipState: 2,
      inCloud: true,
      surfaceCondition: 1,
      apFdActive: true,
      apFlcHold: true,
      apSpeedHold: true,
      apReliable: true,
      athrReliable: false,
      apReliabilityReason: 'simconnect-only',
      athrArmed: null,
      apMachTarget: 0.78,
      simTime: {
        zuluSec: 43200 + i,
        localSec: 39600 + i,
        zuluHms: `12:00:0${i}`,
        localHms: `11:00:0${i}`,
        zuluDate: '2026-06-07',
        localDate: '2026-06-07',
        zuluIso: `2026-06-07T12:00:0${i}Z`,
        localIso: `2026-06-07T11:00:0${i}`,
        zuluYear: 2026,
        zuluMonth: 6,
        zuluDay: 7,
        localYear: 2026,
        localMonth: 6,
        localDay: 7,
        timezoneOffsetSec: -3600,
        timeOfDay: 3,
        source: 'simconnect',
        valid: true,
      },
    });
  }

  test('writeSample increments rowCount', () => {
    assert(w.rowCount === 6, `Expected manifest + 5 rows, got ${w.rowCount}`);
  });

  // Write landing event
  w.writeEvent('LANDING', {
    phase: 'CLIMB',
    vs: -180,
    gforce: 1.2,
    icao: 'KSEA',
    runway: '16L',
    touchdown_distance_ft: 1200,
    wind_speed_kts: 10,
    wind_dir_deg: 270,
    xwind_kts: 8,
    fdm_surface_condition: 1,
    fdm_precip_state: 2,
    fdm_precip_rate_mm: 1.25,
    fdm_oat_c: 6.0,
    touchdown_capture_source: 'msfs_last_touchdown',
    td_sim_source: 'msfs_last_touchdown',
    td_sim_trusted: true,
    td_sim_fresh: true,
    td_sim_position_delta_ft: 42.4,
    td_sim_lat_deg: 47.4499,
    td_sim_lon_deg: -122.3088,
    td_sim_hdg_true_deg: 164.2,
    td_sim_hdg_mag_deg: 149.1,
    td_sim_pitch_deg: 3.4,
    td_sim_bank_deg: -1.2,
    td_sim_normal_velocity_fps: 8.25,
    td_sim_normal_velocity_fpm: 495,
    td_sim_landing_vs_fpm: -495,
  });

  test('writeEvent increments rowCount', () => {
    assert(w.rowCount === 7, `Expected manifest + 6 rows, got ${w.rowCount}`);
  });

  // Close and get stats - NOW ASYNC
  let stats;
  await testAsync('close returns stats', async () => {
    stats = await w.close();
    assert(stats !== null, 'Stats should not be null');
    assert(stats.rowCount === 7, `Expected manifest + 6 rows, got ${stats.rowCount}`);
    assert(stats.flightId === '2025-01-03T12-00-00', 'FlightId mismatch');
  });

  test('isRecording returns false after close', () => {
    assert(!writer.isRecording(), 'Should not be recording');
  });

  // Verify file content
  console.log('\nFile verification:');

  test('file exists', () => {
    assert(fs.existsSync(stats.filePath), `File should exist at ${stats.filePath}`);
  });

  let content, lines, headerFields, recordingManifestRow, sampleRows, landingRow;
  test('file is readable', () => {
    content = fs.readFileSync(stats.filePath, 'utf-8');
    lines = splitCsvLines(content, { trimAndDropEmpty: true });
    assert(lines.length > 0, 'File should have content');

    headerFields = parseCsvLine(lines[0]);
    const toRowObject = (line) => Object.fromEntries(
      headerFields.map((field, index) => [field, parseCsvLine(line)[index] ?? ''])
    );
    recordingManifestRow = toRowObject(lines[1]);
    sampleRows = lines.slice(2, 7).map(toRowObject);
    landingRow = toRowObject(lines[7]);
  });

  test('file has correct line count', () => {
    // Header + recording manifest + 5 samples + 1 landing = 8 lines
    assert(lines.length === 8, `Expected 8 lines, got ${lines.length}`);
  });

  test('startup row contains immutable recording identity', () => {
    assert(recordingManifestRow.record_type === 'RECORDING_MANIFEST', 'Expected startup manifest record type');
    assert(recordingManifestRow.sample_index === '0', 'Expected startup manifest sample_index 0');
    assert(recordingManifestRow.schema_version === '3', 'Expected startup manifest schema version 3');
    assert(recordingManifestRow.flight_id === '2025-01-03T12-00-00', 'Expected startup manifest flight identity');
    assert(recordingManifestRow.recording_session_id === '2025-01-03T12-00-00', 'Expected startup manifest recording identity');
    assert(recordingManifestRow.flight_elapsed_ms === '0', 'Expected startup manifest elapsed time 0');
    assert(recordingManifestRow.timestamp_monotonic === '0', 'Expected startup manifest monotonic time 0');
  });

  test('header contains V1 columns', () => {
    const header = lines[0];
    assert(header.includes('record_type'), 'Missing record_type');
    assert(header.includes('ias_kts'), 'Missing ias_kts');
    assert(header.includes('vs_fpm'), 'Missing vs_fpm');
    assert(header.includes('lat_deg'), 'Missing lat_deg');
    assert(header.includes('wind_speed_kts'), 'Missing wind_speed_kts');
    assert(header.includes('wind_dir_deg'), 'Missing wind_dir_deg');
    assert(header.includes('xwind_kts'), 'Missing xwind_kts');
    assert(header.includes('sea_level_pressure_mb'), 'Missing sea_level_pressure_mb');
    assert(header.includes('precip_rate_mm'), 'Missing precip_rate_mm');
    assert(header.includes('precip_state'), 'Missing precip_state');
    assert(header.includes('in_cloud'), 'Missing in_cloud');
    assert(header.includes('surface_condition'), 'Missing surface_condition');
    assert(header.includes('ap_fd_active'), 'Missing ap_fd_active');
    assert(header.includes('ap_flc_hold'), 'Missing ap_flc_hold');
    assert(header.includes('ap_speed_hold'), 'Missing ap_speed_hold');
    assert(header.includes('ap_mach_target'), 'Missing ap_mach_target');
    assert(header.includes('ap_reliable'), 'Missing ap_reliable');
    assert(header.includes('athr_reliable'), 'Missing athr_reliable');
    assert(header.includes('ap_reliability_reason'), 'Missing ap_reliability_reason');
    assert(header.includes('athr_armed'), 'Missing athr_armed');
    assert(header.includes('fdm_surface_condition'), 'Missing fdm_surface_condition');
    assert(header.includes('fdm_precip_state'), 'Missing fdm_precip_state');
    assert(header.includes('fdm_precip_rate_mm'), 'Missing fdm_precip_rate_mm');
    assert(header.includes('fdm_oat_c'), 'Missing fdm_oat_c');
    assert(header.includes('touchdown_distance_ft'), 'Missing touchdown_distance_ft');
    assert(header.includes('touchdown_capture_source'), 'Missing touchdown_capture_source');
    assert(header.includes('td_sim_normal_velocity_fps'), 'Missing td_sim_normal_velocity_fps');
    assert(header.includes('td_sim_landing_vs_fpm'), 'Missing td_sim_landing_vs_fpm');
    assert(header.includes('sample_index'), 'Missing sample_index');
    assert(header.includes('recorded_at_utc'), 'Missing recorded_at_utc');
    assert(header.includes('sim_datetime_utc'), 'Missing sim_datetime_utc');
    assert(header.includes('sim_datetime_local'), 'Missing sim_datetime_local');
    assert(header.includes('sim_time_local_sec'), 'Missing sim_time_local_sec');
    assert(header.includes('sim_datetime_valid'), 'Missing sim_datetime_valid');
  });

  test('sample rows start with SAMPLE', () => {
    for (let i = 2; i <= 6; i++) {
      assert(lines[i].startsWith('SAMPLE,'), `Line ${i} should start with SAMPLE`);
    }
  });

  test('sample rows contain wind values', () => {
    for (const row of sampleRows) {
      assert(row.wind_speed_kts === '10.0', `Expected sample wind speed 10.0, got ${row.wind_speed_kts}`);
      assert(row.wind_dir_deg === '270.0', `Expected sample wind dir 270.0, got ${row.wind_dir_deg}`);
      assert(row.xwind_kts === '8.0', `Expected sample crosswind 8.0, got ${row.xwind_kts}`);
    }
  });

  test('sample rows contain new weather and automation fields', () => {
    for (const row of sampleRows) {
      assert(row.sea_level_pressure_mb === '1013.2', `Expected sea level pressure 1013.2, got ${row.sea_level_pressure_mb}`);
      assert(row.precip_rate_mm === '1.25', `Expected precip rate 1.25, got ${row.precip_rate_mm}`);
      assert(row.precip_state === '2', `Expected precip state 2, got ${row.precip_state}`);
      assert(row.in_cloud === '1', `Expected in_cloud 1, got ${row.in_cloud}`);
      assert(row.surface_condition === '1', `Expected surface condition 1, got ${row.surface_condition}`);
      assert(row.ap_fd_active === '1', `Expected ap_fd_active 1, got ${row.ap_fd_active}`);
      assert(row.ap_flc_hold === '1', `Expected ap_flc_hold 1, got ${row.ap_flc_hold}`);
      assert(row.ap_speed_hold === '1', `Expected ap_speed_hold 1, got ${row.ap_speed_hold}`);
      assert(row.ap_mach_target === '0.780', `Expected ap_mach_target 0.780, got ${row.ap_mach_target}`);
      assert(row.ap_reliable === '1', `Expected ap_reliable 1, got ${row.ap_reliable}`);
      assert(row.athr_reliable === '0', `Expected athr_reliable 0, got ${row.athr_reliable}`);
      assert(row.ap_reliability_reason === 'simconnect-only', `Expected reliability reason simconnect-only, got ${row.ap_reliability_reason}`);
      assert(row.athr_armed === '', `Expected blank athr_armed, got ${row.athr_armed}`);
    }
  });

  test('sample rows contain replay ordering and simulator datetime fields', () => {
    sampleRows.forEach((row, index) => {
      assert(row.sample_index === String(index + 1), `Expected sample_index ${index + 1}, got ${row.sample_index}`);
      assert(row.recorded_at_utc, 'Expected recorded_at_utc to be populated');
      assert(row.sim_datetime_utc === `2026-06-07T12:00:0${index}Z`, `Expected sim_datetime_utc for sample ${index}, got ${row.sim_datetime_utc}`);
      assert(row.sim_datetime_local === `2026-06-07T11:00:0${index}`, `Expected sim_datetime_local for sample ${index}, got ${row.sim_datetime_local}`);
      assert(row.sim_time_zulu_sec === String(43200 + index), `Expected sim_time_zulu_sec ${43200 + index}, got ${row.sim_time_zulu_sec}`);
      assert(row.sim_time_local_sec === String(39600 + index), `Expected sim_time_local_sec ${39600 + index}, got ${row.sim_time_local_sec}`);
      assert(row.sim_date_utc === '2026-06-07', `Expected sim_date_utc, got ${row.sim_date_utc}`);
      assert(row.sim_datetime_source === 'simconnect', `Expected simconnect source, got ${row.sim_datetime_source}`);
      assert(row.sim_datetime_valid === '1', `Expected valid sim datetime, got ${row.sim_datetime_valid}`);
    });
    assert(landingRow.sample_index === '6', `Expected landing sample_index 6, got ${landingRow.sample_index}`);
  });

  test('landing row contains LANDING and KSEA', () => {
    assert(lines[7].startsWith('LANDING,'), 'Landing row should start with LANDING');
    assert(lines[7].includes('KSEA'), 'Landing row should contain KSEA');
    assert(lines[7].includes('16L'), 'Landing row should contain runway 16L');
  });

  test('landing event row forces LANDING phase and preserves detector phase hint', () => {
    assert(landingRow.record_type === 'LANDING', `Expected LANDING record, got ${landingRow.record_type}`);
    assert(landingRow.phase === 'LANDING', `Expected landing row phase LANDING, got ${landingRow.phase}`);
    assert(landingRow.flight_phase_hint === 'CLIMB', `Expected landing row flight_phase_hint CLIMB, got ${landingRow.flight_phase_hint}`);
  });

  test('landing row contains wind values', () => {
    assert(landingRow.wind_speed_kts === '10.0', `Expected landing wind speed 10.0, got ${landingRow.wind_speed_kts}`);
    assert(landingRow.wind_dir_deg === '270.0', `Expected landing wind dir 270.0, got ${landingRow.wind_dir_deg}`);
    assert(landingRow.xwind_kts === '8.0', `Expected landing crosswind 8.0, got ${landingRow.xwind_kts}`);
  });

  test('landing row contains touchdown weather snapshot', () => {
    assert(landingRow.fdm_surface_condition === '1', `Expected landing surface condition 1, got ${landingRow.fdm_surface_condition}`);
    assert(landingRow.fdm_precip_state === '2', `Expected landing precip state 2, got ${landingRow.fdm_precip_state}`);
    assert(landingRow.fdm_precip_rate_mm === '1.25', `Expected landing precip rate 1.25, got ${landingRow.fdm_precip_rate_mm}`);
    assert(landingRow.fdm_oat_c === '6.0', `Expected landing OAT 6.0, got ${landingRow.fdm_oat_c}`);
  });

  test('landing row contains MSFS touchdown diagnostic snapshot', () => {
    assert(landingRow.touchdown_capture_source === 'msfs_last_touchdown', `Expected touchdown source msfs_last_touchdown, got ${landingRow.touchdown_capture_source}`);
    assert(landingRow.td_sim_trusted === '1', `Expected trusted MSFS touchdown, got ${landingRow.td_sim_trusted}`);
    assert(landingRow.td_sim_fresh === '1', `Expected fresh MSFS touchdown, got ${landingRow.td_sim_fresh}`);
    assert(landingRow.td_sim_position_delta_ft === '42.4', `Expected position delta 42.4, got ${landingRow.td_sim_position_delta_ft}`);
    assert(landingRow.td_sim_lat_deg === '47.449900', `Expected MSFS touchdown lat 47.449900, got ${landingRow.td_sim_lat_deg}`);
    assert(landingRow.td_sim_lon_deg === '-122.308800', `Expected MSFS touchdown lon -122.308800, got ${landingRow.td_sim_lon_deg}`);
    assert(landingRow.td_sim_normal_velocity_fps === '8.25', `Expected normal velocity 8.25, got ${landingRow.td_sim_normal_velocity_fps}`);
    assert(landingRow.td_sim_landing_vs_fpm === '-495.0', `Expected landing VS -495.0, got ${landingRow.td_sim_landing_vs_fpm}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test('landing event defaults on_ground to true when no frame is provided', () => {
    assert(landingRow.on_ground === '1', `Expected landing on_ground 1, got ${landingRow.on_ground}`);
  });

  await testAsync('go-around event defaults on_ground to false when no frame is provided', async () => {
    const eventWriter = writer.startFlight({
      flightId: 'test-go-around-event-ground-state',
      outputDir: testDir,
    });

    assert(eventWriter.writeEvent('GO_AROUND', {
      event_id: 'GO_AROUND-fixed',
      altitude_ft: 700,
      ias_kts: 150,
      vs_fpm: 1100,
      previous_phase: 'APPROACH',
    }), 'GO_AROUND event write should succeed');

    const eventStats = await eventWriter.close();
    const eventContent = fs.readFileSync(eventStats.filePath, 'utf-8');
    const eventLines = splitCsvLines(eventContent, { trimAndDropEmpty: true });
    const eventHeaders = parseCsvLine(eventLines[0]);
    const eventValues = parseCsvLine(eventLines[2]);
    const eventRow = Object.fromEntries(
      eventHeaders.map((field, index) => [field, eventValues[index] ?? ''])
    );

    assert(eventRow.record_type === 'GO_AROUND', `Expected GO_AROUND row, got ${eventRow.record_type}`);
    assert(eventRow.on_ground === '0', `Expected go-around on_ground 0, got ${eventRow.on_ground}`);
  });

  await testAsync('writeEvent preserves camelCase eventId alias in inline and worker writers', async () => {
    async function writeFixture(WriterClass, label) {
      const csvWriter = new WriterClass({
        flightId: `test-event-id-${label}`,
        outputDir: path.join(testDir, label),
        syncIntervalMs: 60000,
      });

      assert(csvWriter.start(), `writer should start: ${csvWriter.lastError?.message || 'no error'}`);
      assert(csvWriter.writeEvent('GO_AROUND', {
        eventId: 'GO_AROUND-camel',
        altitude_ft: 700,
        ias_kts: 150,
        previous_phase: 'APPROACH',
      }), 'GO_AROUND event write should succeed');

      const eventStats = await csvWriter.close();
      const rows = readCsvDataRows(eventStats.filePath);
      return rows[1];
    }

    const inlineRow = await writeFixture(writer.FlightCSVWriter, 'inline-event-id');
    const workerRow = await writeFixture(writer.WorkerFlightCSVWriter, 'worker-event-id');

    assert(inlineRow.event_id === 'GO_AROUND-camel', `Expected inline event_id alias to survive, got ${inlineRow.event_id}`);
    assert(workerRow.event_id === 'GO_AROUND-camel', `Expected worker event_id alias to survive, got ${workerRow.event_id}`);
  });

  await testAsync('inline and worker writers own record type and CSV schema metadata', async () => {
    async function writeHostileFixture(WriterClass, label) {
      const csvWriter = new WriterClass({
        flightId: `test-owned-schema-${label}`,
        outputDir: path.join(testDir, label),
        syncIntervalMs: 60000,
      });
      assert(csvWriter.start(), `writer should start: ${csvWriter.lastError?.message || 'no error'}`);
      assert(csvWriter.writeSample({
        _recordType: 'HOSTILE_SAMPLE',
        schemaVersion: 999,
        schema_version: 998,
      }), 'sample write should succeed');
      assert(csvWriter.writeEvent('GO_AROUND', {
        _recordType: 'HOSTILE_EVENT',
        schemaVersion: 997,
        schema_version: 996,
      }), 'event write should succeed');
      const stats = await csvWriter.close();
      return readCsvDataRows(stats.filePath);
    }

    for (const [WriterClass, label] of [
      [writer.FlightCSVWriter, 'inline-owned-schema'],
      [writer.WorkerFlightCSVWriter, 'worker-owned-schema'],
    ]) {
      const rows = await writeHostileFixture(WriterClass, label);
      assert(rows[0].record_type === 'RECORDING_MANIFEST', `${label} startup record type must be writer-owned`);
      assert(rows[1].record_type === 'SAMPLE', `${label} sample record type must be writer-owned`);
      assert(rows[2].record_type === 'GO_AROUND', `${label} event record type must be writer-owned`);
      assert(rows[0].schema_version === '3', `${label} manifest schema version must be writer-owned`);
      assert(rows.slice(1).every((row) => row.schema_version === ''),
        `${label} later rows must compact-repeat, not accept hostile schema metadata`);
    }
  });

  await testAsync('module lifecycle preserves durable bundle-status opt-in', async () => {
    const lifecycleWriter = writer.startFlight({
      flightId: 'test-bundle-status-opt-in',
      recordingSessionId: 'test-bundle-status-opt-in-session',
      bundleBaseName: 'test-bundle-status-opt-in',
      bundleStatusRequired: true,
      outputDir: testDir,
      writerMode: 'inline',
    });
    assert(lifecycleWriter, 'module lifecycle writer should start');
    assert(writer.getStats()?.bundleStatusRequired === true,
      'module stats must retain the immutable completion requirement');
    const stats = await writer.endFlight();
    assert(stats?.bundleStatusRequired === true,
      'final stats must retain the immutable completion requirement');
    const rows = readCsvDataRows(stats.filePath);
    assert(rows[0].bundle_status_required === '1',
      'module lifecycle must persist the completion requirement in its manifest');
  });

  await testAsync('module lifecycle refuses a replacement while the prior CSV is finalizing', async () => {
    const lifecycleWriter = writer.startFlight({
      flightId: 'test-finalization-ownership',
      outputDir: testDir,
      writerMode: 'inline',
    });
    assert(lifecycleWriter, 'lifecycle writer should start');
    const originalClose = lifecycleWriter.close.bind(lifecycleWriter);
    let releaseClose;
    const closeGate = new Promise((resolve) => { releaseClose = resolve; });
    lifecycleWriter.close = async () => {
      await closeGate;
      return await originalClose();
    };

    const finalization = writer.endFlight();
    await Promise.resolve();
    assert(writer.isFinalizing(), 'module should expose raw CSV finalization ownership');
    assert(writer.getFinalizingStats()?.filePath === lifecycleWriter.filePath,
      'finalizing stats should retain the protected CSV path');
    assert(writer.startFlight({
      flightId: 'test-overlapping-finalization',
      outputDir: testDir,
      writerMode: 'inline',
    }) === null, 'overlapping writer start should be refused');

    releaseClose();
    await finalization;
    assert(!writer.isFinalizing(), 'finalization ownership should clear after the raw close settles');
  });

  // Test: Filename generation
  // ═══════════════════════════════════════════════════════════════════════════

  await testAsync('worker writer output matches inline writer byte-for-byte', async () => {
    async function writeFixture(WriterClass, outputDir) {
      const clock = timeSource.createFixedSource(Date.UTC(2026, 0, 1, 12, 0, 0));
      try {
        const csvWriter = new WriterClass({
          flightId: '2026-01-01T12-00-00',
          outputDir,
          syncIntervalMs: 60000,
        });
        assert(csvWriter.start(), 'writer should start');
        csvWriter.writeSample({
          timestampMs: clock.get(),
          timestampIso: new Date(clock.get()).toISOString(),
          onGround: false,
          phase: 'APPROACH',
          ias: 141.25,
          vs: -11.5,
          pitch: 3.25,
          bank: -1.5,
          lat: 47.1234,
          lon: -122.4567,
          gForce: 1.02,
          xwind: 7.5,
          windSpeed: 9.5,
          windDir: 274,
          aircraft: 'Test, Aircraft',
          apFdActive: true,
          apReliable: true,
          athrReliable: false,
        });
        clock.advance(100);
        csvWriter.writeSample({
          timestampMs: clock.get(),
          timestampIso: new Date(clock.get()).toISOString(),
          onGround: true,
          phase: 'LANDING',
          ias: 132.5,
          vs: -3,
          pitch: 5.1,
          bank: 0.2,
          lat: 47.124,
          lon: -122.457,
          gForce: 1.18,
          xwind: 8.2,
          windSpeed: 10.1,
          windDir: 276,
          aircraft: 'Test, Aircraft',
        });
        clock.advance(100);
        csvWriter.writeEvent('LANDING', {
          event_id: 'LANDING-fixed',
          vs: -180,
          gforce: 1.2,
          icao: 'KSEA',
          runway: '16L',
          touchdown_distance_ft: 1200,
        });
        const fixtureStats = await csvWriter.close();
        return fs.readFileSync(fixtureStats.filePath, 'utf8');
      } finally {
        timeSource.resetTimeSource();
      }
    }

    const inlineContent = await writeFixture(writer.FlightCSVWriter, path.join(testDir, 'inline-equivalence'));
    const workerContent = await writeFixture(writer.WorkerFlightCSVWriter, path.join(testDir, 'worker-equivalence'));
    assert(workerContent === inlineContent, 'worker CSV output should exactly match inline output');
  });

  console.log('\nFilename generation:');

  test('sanitizeFlightId removes colons and Z', () => {
    const result = writer.sanitizeFlightId('2025-01-03T12:00:00.123Z');
    assert(!result.includes(':'), 'Should not contain colons');
    assert(!result.includes('.123'), 'Should not contain milliseconds');
    assert(result === '2025-01-03T12-00-00', `Expected 2025-01-03T12-00-00, got ${result}`);
  });

  test('generateFilename with both airports', () => {
    const result = writer.generateFilename('2025-01-03T12-00-00', 'KJFK', 'KLAX');
    assert(result === '2025-01-03T12-00-00_KJFK-KLAX.csv', `Got: ${result}`);
  });

  test('generateFilename with departure only', () => {
    const result = writer.generateFilename('2025-01-03T12-00-00', 'KJFK', null);
    assert(result === '2025-01-03T12-00-00_from-KJFK.csv', `Got: ${result}`);
  });

  test('generateFilename with arrival only', () => {
    const result = writer.generateFilename('2025-01-03T12-00-00', null, 'KLAX');
    assert(result === '2025-01-03T12-00-00_to-KLAX.csv', `Got: ${result}`);
  });

  test('generateFilename with no airports', () => {
    const result = writer.generateFilename('2025-01-03T12-00-00', null, null);
    assert(result === '2025-01-03T12-00-00.csv', `Got: ${result}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test: Module API
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\nModule API:');

  test('getV1Columns returns array', () => {
    const cols = writer.getV1Columns();
    assert(Array.isArray(cols), 'Should be array');
    assert(cols.length > 50, 'Should have many columns');
    assert(cols.includes('record_type'), 'Should include record_type');
  });

  test('V1_COLUMNS is frozen', () => {
    const cols1 = writer.V1_COLUMNS;
    const cols2 = writer.getV1Columns();
    assert(cols1.length === cols2.length, 'Should have same length');
  });

  test('getDefaultFlightLogsDir returns valid path', () => {
    const dir = writer.getDefaultFlightLogsDir();
    const expectedDir = path.join(isolatedHome, 'Documents', 'Flight Fabric', 'Flight Logs');
    assert(path.resolve(dir) === path.resolve(expectedDir), `Unexpected flight logs directory: ${dir}`);
    assert(fs.existsSync(dir), 'Should exist');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test: Crash resilience (periodic fsync)
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\nCrash resilience (fsync):');

  await testAsync('default syncIntervalMs is 30000', async () => {
    const w2 = writer.startFlight({ 
      flightId: 'test-sync-default',
      outputDir: testDir,
    });
    assert(w2 !== null, 'writer should start');
    assert(w2.syncIntervalMs === 30000, `Expected 30000, got ${w2.syncIntervalMs}`);
    await w2.close();
  });

  await testAsync('syncIntervalMs is configurable', async () => {
    const w2 = writer.startFlight({ 
      flightId: 'test-sync-custom',
      outputDir: testDir,
      syncIntervalMs: 5000,
    });
    assert(w2 !== null, 'writer should start');
    assert(w2.syncIntervalMs === 5000, `Expected 5000, got ${w2.syncIntervalMs}`);
    await w2.close();
  });

  await testAsync('lastSyncTime is initialized', async () => {
    const w2 = writer.startFlight({ 
      flightId: 'test-sync-init',
      outputDir: testDir,
    });
    assert(w2 !== null, 'writer should start');
    assert(typeof w2.lastSyncTime === 'number', 'lastSyncTime should be a number');
    assert(w2.lastSyncTime > 0, 'lastSyncTime should be positive');
    await w2.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test: Immutable path route updates (updateFilename compatibility API)
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\nImmutable route metadata updates:');

  await testAsync('updateFilename records route metadata without renaming', async () => {
    const w2 = writer.startFlight({ 
      flightId: 'test-rename',
      outputDir: testDir,
    });
    
    // Write some data
    w2.writeSample({ timestampMs: Date.now(), ias: 100, phase: 'CRUISE' });
    w2.writeSample({ timestampMs: Date.now(), ias: 110, phase: 'CRUISE' });
    
    // Route metadata is presentation data; the bundle path stays immutable.
    const oldPath = w2.filePath;
    const result = await w2.updateFilename('KJFK', 'KLAX');
    
    assert(result === true, 'updateFilename should return true');
    assert(w2.filename === 'telemetry.csv', `Filename should remain canonical: ${w2.filename}`);
    assert(oldPath === w2.filePath, 'Route metadata must not rename the recording');
    assert(fs.existsSync(w2.filePath), 'Canonical file should exist');
    
    // Verify data wasn't lost
    const content = fs.readFileSync(w2.filePath, 'utf-8');
    const lines = splitCsvLines(content, { trimAndDropEmpty: true });
    assert(lines.length >= 3, `Should have header + 2 samples, got ${lines.length} lines`);
    
    await w2.close();
  });

  await testAsync('inline route metadata update preserves subsequent writes', async () => {
    const w2 = new writer.FlightCSVWriter({
      flightId: 'test-inline-queued-rename',
      outputDir: path.join(testDir, 'inline-queued-rename'),
      syncIntervalMs: 60000,
    });

    assert(w2.start(), `inline writer should start: ${w2.lastError?.message || 'no error'}`);
    assert(w2.writeSample({ timestampMs: Date.now(), ias: 100, phase: 'APPROACH' }), 'initial write should succeed');

    const renamePromise = w2.updateFilename('KJFK', 'KLAX');
    for (let index = 0; index < 25; index++) {
      assert(
        w2.writeSample({ timestampMs: Date.now() + index, ias: 110 + index, phase: 'FLARE' }),
        `queued write ${index} should succeed`
      );
    }
    assert(
      w2.writeEvent('GO_AROUND', {
        event_id: 'GO_AROUND-inline-rename',
        altitude_ft: 700,
        ias_kts: 150,
        previous_phase: 'APPROACH',
      }),
      'queued event write should succeed'
    );

    const renamed = await renamePromise;
    assert(renamed === true, 'inline rename should complete');

    const stats = await w2.close();
    const rows = readCsvDataRows(stats.filePath);
    assert(rows.length === 28, `Expected manifest + 27 inline rows, got ${rows.length}`);
    assert(stats.rowCount === 28, `Expected manifest + 27 inline rows in stats, got ${stats.rowCount}`);
    assert(rows[rows.length - 1].record_type === 'GO_AROUND', `Expected queued event at end, got ${rows[rows.length - 1].record_type}`);
    assert(w2.filename === 'telemetry.csv', `Filename should remain canonical: ${w2.filename}`);
  });

  await testAsync('inline close drains rows accepted after a route metadata update', async () => {
    const w2 = new writer.FlightCSVWriter({
      flightId: 'test-inline-close-during-rename',
      outputDir: path.join(testDir, 'inline-close-during-rename'),
      syncIntervalMs: 60000,
    });

    assert(w2.start(), `inline writer should start: ${w2.lastError?.message || 'no error'}`);
    assert(w2.writeSample({ timestampMs: Date.now(), ias: 100, phase: 'APPROACH' }), 'initial write should succeed');

    const renamePromise = w2.updateFilename('KJFK', 'KLAX');
    for (let index = 0; index < 25; index++) {
      assert(
        w2.writeSample({ timestampMs: Date.now() + index, ias: 110 + index, phase: 'FLARE' }),
        `queued write ${index} should succeed`,
      );
    }

    const closePromise = w2.close();
    const [renamed, stats] = await Promise.all([renamePromise, closePromise]);
    assert(renamed === true, 'inline rename should remain authoritative during close');
    const rows = readCsvDataRows(stats.filePath);
    assert(rows.length === 27, `Expected manifest + 26 inline rows, got ${rows.length}`);
    assert(stats.rowCount === 27, `Expected manifest + 26 inline rows in stats, got ${stats.rowCount}`);
    for (let index = 0; index < rows.length; index++) {
      assert(Number(rows[index].sample_index) === index, `Expected contiguous sample_index ${index}`);
    }
    assert(w2.filename === 'telemetry.csv', `Filename should remain canonical: ${w2.filename}`);
  });

  await testAsync('worker route metadata update preserves subsequent writes', async () => {
    const w2 = new writer.WorkerFlightCSVWriter({
      flightId: 'test-worker-queued-rename',
      outputDir: path.join(testDir, 'worker-queued-rename'),
      syncIntervalMs: 60000,
    });

    assert(w2.start(), `worker writer should start: ${w2.lastError?.message || 'no error'}`);
    assert(w2.writeSample({ timestampMs: Date.now(), ias: 100, phase: 'APPROACH' }), 'initial write should succeed');

    const renamePromise = w2.updateFilename('KJFK', 'KLAX');
    for (let index = 0; index < 25; index++) {
      assert(
        w2.writeSample({ timestampMs: Date.now() + index, ias: 110 + index, phase: 'FLARE' }),
        `queued write ${index} should succeed`
      );
    }

    const renamed = await renamePromise;
    assert(renamed === true, 'worker rename should complete');

    const stats = await w2.close();
    const content = fs.readFileSync(stats.filePath, 'utf-8');
    const lines = splitCsvLines(content, { trimAndDropEmpty: true });
    assert(lines.length === 28, `Expected header + manifest + 26 samples, got ${lines.length} lines`);
    assert(stats.rowCount === 27, `Expected manifest + 26 worker rows, got ${stats.rowCount}`);
    assert(w2.filename === 'telemetry.csv', `Filename should remain canonical: ${w2.filename}`);
  });

  await testAsync('worker flush makes queued rows visible before close', async () => {
    const w2 = new writer.WorkerFlightCSVWriter({
      flightId: 'test-worker-flush',
      outputDir: path.join(testDir, 'worker-flush'),
      syncIntervalMs: 60000,
    });

    assert(w2.start(), `worker writer should start: ${w2.lastError?.message || 'no error'}`);
    assert(w2.writeSample({ timestampMs: Date.now(), ias: 142, phase: 'LANDING' }), 'write should succeed');

    const flushed = await w2.flush();
    assert(flushed === true, 'flush should complete');
    assert(w2.inflightAppendBytes === 0, 'flush should clear acknowledged append bytes');

    const content = fs.readFileSync(w2.filePath, 'utf-8');
    const lines = splitCsvLines(content, { trimAndDropEmpty: true });
    assert(lines.length === 3, `Expected header + manifest + 1 sample after flush, got ${lines.length} lines`);

    await w2.close();
  });

  await testAsync('worker close immediately gates rows behind its close command', async () => {
    const w2 = new writer.WorkerFlightCSVWriter({
      flightId: 'test-worker-close-gate',
      outputDir: path.join(testDir, 'worker-close-gate'),
      syncIntervalMs: 60000,
    });

    assert(w2.start(), `worker writer should start: ${w2.lastError?.message || 'no error'}`);
    assert(w2.writeSample({ timestampMs: Date.now(), ias: 100, phase: 'APPROACH' }), 'pre-close write should succeed');
    const closePromise = w2.close();
    assert(
      w2.writeSample({ timestampMs: Date.now(), ias: 101, phase: 'FLARE' }) === false,
      'a row racing behind close must be rejected instead of acknowledged and lost',
    );
    const stats = await closePromise;
    const rows = readCsvDataRows(stats.filePath);
    assert(rows.length === 2, `Expected manifest + pre-close sample, got ${rows.length}`);
    assert(stats.rowCount === 2, `Expected manifest + pre-close sample in stats, got ${stats.rowCount}`);
  });

  test('worker closeSync flushes queued rows and clears pending request accounting', () => {
    const w2 = new writer.WorkerFlightCSVWriter({
      flightId: 'test-worker-close-sync',
      outputDir: path.join(testDir, 'worker-close-sync'),
      syncIntervalMs: 60000,
    });

    assert(w2.start(), `worker writer should start: ${w2.lastError?.message || 'no error'}`);
    assert(w2.writeSample({ timestampMs: Date.now(), ias: 128, phase: 'APPROACH' }), 'write should succeed');

    const stats = w2.closeSync();
    const content = fs.readFileSync(stats.filePath, 'utf-8');
    const lines = splitCsvLines(content, { trimAndDropEmpty: true });
    assert(lines.length === 3, `Expected header + manifest + 1 sample after closeSync, got ${lines.length} lines`);
    assert(w2.closed === true, 'writer should be closed after closeSync');
    assert(w2.pendingRequests.size === 0, 'closeSync should clear pending worker requests');
    assert(w2.inflightAppendBytes === 0, 'closeSync should clear in-flight append bytes');
  });

  await testAsync('worker append backlog is bounded when the disk cannot keep up', async () => {
    const w2 = new writer.WorkerFlightCSVWriter({
      flightId: 'test-worker-backlog-cap',
      outputDir: path.join(testDir, 'worker-backlog-cap'),
      syncIntervalMs: 60000,
    });

    assert(w2.start(), `worker writer should start: ${w2.lastError?.message || 'no error'}`);
    w2.inflightAppendBytes = 64 * 1024 * 1024 - 8;

    const originalConsoleError = console.error;
    console.error = () => {};
    let accepted = false;
    try {
      accepted = w2._postAppendLines(['sample'], 9);
    } finally {
      console.error = originalConsoleError;
    }

    assert(accepted === false, 'append should be rejected once the in-flight backlog cap is exceeded');
    assert(w2.closed === true, 'writer should fail closed when append backlog is unbounded');
    assert(
      w2.lastError && w2.lastError.message.includes('backlog exceeded'),
      `Expected backlog error, got ${w2.lastError && w2.lastError.message}`
    );

    await w2.close();
  });

  test('inline rename queue is bounded while route rename is blocked', () => {
    const w2 = new writer.FlightCSVWriter({
      flightId: 'test-inline-rename-backlog-cap',
      outputDir: path.join(testDir, 'inline-rename-backlog-cap'),
    });
    const largeLine = 'x'.repeat(1024 * 1024);
    const originalConsoleError = console.error;
    let rejected = false;

    w2.renameInProgress = true;
    console.error = () => {};
    try {
      for (let index = 0; index < 20; index += 1) {
        if (!w2._appendCsvLine(largeLine)) {
          rejected = true;
          break;
        }
      }
    } finally {
      console.error = originalConsoleError;
    }

    assert(rejected === true, 'inline rename queue should reject writes once capped');
    assert(w2.renameQueuedLineBytes <= 8 * 1024 * 1024, 'inline rename queue should stay within byte cap');
    assert(
      w2.lastError && w2.lastError.message.includes('rename backlog exceeded'),
      `Expected rename backlog error, got ${w2.lastError && w2.lastError.message}`
    );
  });

  test('inline stream writes are rejected when stream backlog is already capped', () => {
    const w2 = new writer.FlightCSVWriter({
      flightId: 'test-inline-stream-backlog-cap',
      outputDir: path.join(testDir, 'inline-stream-backlog-cap'),
    });
    const originalConsoleError = console.error;
    w2.stream = {
      writableLength: 16 * 1024 * 1024,
      write: () => {
        throw new Error('write should not be reached after backlog cap');
      },
    };

    let accepted = true;
    console.error = () => {};
    try {
      accepted = w2._appendCsvLine('sample');
    } finally {
      console.error = originalConsoleError;
    }

    assert(accepted === false, 'inline stream write should be rejected when stream backlog is capped');
    assert(w2.rowCount === 0, 'rejected inline stream write should not increment row count');
    assert(
      w2.lastError && w2.lastError.message.includes('stream backlog exceeded'),
      `Expected stream backlog error, got ${w2.lastError && w2.lastError.message}`
    );
  });

  await testAsync('worker burst writes are batched and fully flushed on close', async () => {
    const w2 = new writer.WorkerFlightCSVWriter({
      flightId: 'test-worker-burst',
      outputDir: path.join(testDir, 'worker-burst'),
      syncIntervalMs: 60000,
    });
    const burstRows = 2000;

    assert(w2.start(), `worker writer should start: ${w2.lastError?.message || 'no error'}`);
    for (let index = 0; index < burstRows; index++) {
      assert(
        w2.writeSample({
          timestampMs: Date.now() + index,
          ias: 130 + (index % 20),
          vs: -50 + index,
          phase: index > burstRows - 100 ? 'FLARE' : 'APPROACH',
          aircraft: `Burst Test ${index}, quoted "field"`,
        }),
        `burst write ${index} should succeed`
      );
    }

    assert(w2.pendingLines.length < 512, `Pending main-thread batch should stay bounded, got ${w2.pendingLines.length}`);

    const stats = await w2.close();
    const content = fs.readFileSync(stats.filePath, 'utf-8');
    const lines = splitCsvLines(content, { trimAndDropEmpty: true });
    assert(lines.length === burstRows + 2, `Expected header + manifest + ${burstRows} samples, got ${lines.length} lines`);
    assert(stats.rowCount === burstRows + 1, `Expected manifest + ${burstRows} worker rows, got ${stats.rowCount}`);
  });

  await testAsync('quoted multiline fields round-trip without column drift', async () => {
    const w3 = writer.startFlight({
      flightId: 'test-quoted-fields',
      outputDir: testDir,
    });

    const escalationReason = 'alpha, "beta"\r\ngamma';
    const apReliabilityReason = 'reason, with "quotes"\nnext line';

    w3.writeSample({
      timestampMs: Date.now(),
      timestampIso: new Date().toISOString(),
      phase: 'CRUISE',
      escalationReason,
      apReliabilityReason,
      aircraft: 'ACME "Special"',
      ias: 123,
    });

    const quotedStats = await w3.close();
    const quotedContent = fs.readFileSync(quotedStats.filePath, 'utf-8');
    const quotedLines = splitCsvLines(quotedContent, { trimAndDropEmpty: true });
    assert(quotedLines.length === 3, `Expected header + manifest + 1 logical row, got ${quotedLines.length}`);

    const quotedHeaders = parseCsvLine(quotedLines[0]);
    const quotedValues = parseCsvLine(quotedLines[2]);
    assert(quotedValues.length === quotedHeaders.length, `Expected ${quotedHeaders.length} columns, got ${quotedValues.length}`);

    const quotedRow = Object.fromEntries(
      quotedHeaders.map((field, index) => [field, quotedValues[index] ?? ''])
    );

    assert(quotedRow.escalation_reason === escalationReason, `Expected escalation_reason round-trip, got ${JSON.stringify(quotedRow.escalation_reason)}`);
    assert(quotedRow.ap_reliability_reason === apReliabilityReason, `Expected ap_reliability_reason round-trip, got ${JSON.stringify(quotedRow.ap_reliability_reason)}`);
    assert(quotedRow.aircraft === 'ACME "Special"', `Expected aircraft round-trip, got ${JSON.stringify(quotedRow.aircraft)}`);
    assert(quotedRow.ias_kts === '123.0', `Expected ias_kts 123.0, got ${quotedRow.ias_kts}`);
  });

  await testAsync('exclusive startup refuses to resume or append to a prior quoted CSV', async () => {
    const outputDir = path.join(testDir, 'resume-quoted-index');
    const flightId = 'test-resume-quoted-index';
    const firstWriter = new writer.FlightCSVWriter({ flightId, outputDir });
    assert(firstWriter.start(), 'first writer should start');
    assert(firstWriter.writeSample({
      timestampMs: Date.now(),
      timestampIso: new Date().toISOString(),
      phase: 'CRUISE',
      escalationReason: 'quoted\nmultiline\nreason',
      ias: 123,
    }), 'first sample should write');
    const firstStats = await firstWriter.close();
    const originalBytes = fs.readFileSync(firstStats.filePath);

    const secondWriter = new writer.FlightCSVWriter({ flightId, outputDir });
    assert(!secondWriter.start(), 'second writer must refuse the existing recording');
    assert(!secondWriter.writeSample({
      timestampMs: Date.now() + 1,
      timestampIso: new Date(Date.now() + 1).toISOString(),
      phase: 'DESCENT',
      ias: 124,
    }), 'failed replacement must reject writes');
    assert(fs.readFileSync(firstStats.filePath).equals(originalBytes), 'prior recording bytes must remain unchanged');

    const rows = readCsvDataRows(firstStats.filePath);
    assert(rows.length === 2, `Expected manifest + one logical sample, got ${rows.length}`);
    assert(rows[0].record_type === 'RECORDING_MANIFEST', `Expected manifest first, got ${rows[0].record_type}`);
    assert(rows[0].sample_index === '0', `Expected manifest sample_index 0, got ${rows[0].sample_index}`);
    assert(rows[1].sample_index === '1', `Expected sample_index 1, got ${rows[1].sample_index}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cleanup and summary
  // ═══════════════════════════════════════════════════════════════════════════

  // Cleanup
  try {
    fs.rmSync(testDir, { recursive: true });
  } catch (e) {
    console.log('Note: Could not clean up test directory');
  }
  restoreEnvironment();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

// Run the async tests
runTests().catch(err => {
  restoreEnvironment();
  console.error('Test runner error:', err);
  process.exit(1);
});

export {};
