#!/usr/bin/env node
/**
 * test-csv-roundtrip.js
 *
 * End-to-end CSV roundtrip test:
 *   enriched frame → FlightCSVWriter.writeSample() → CSV file →
 *   parseCSV() + mapCsvRow() → csvRowToStabilityFrame() → verify values
 *
 * This test verifies that data written to CSV
 * can be correctly read back with all values intact. A silent bug anywhere in
 * this chain corrupts historical flight analysis, approach profiles, and landing
 * grades.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { getRepoScratchAppData } = require('./repo-scratch');

const tempAppData = getRepoScratchAppData('csv-roundtrip-appdata');
fs.mkdirSync(tempAppData, { recursive: true });
process.env.APPDATA = tempAppData;

const { FlightCSVWriter } = require(resolveBackendRuntimeFile('flight-recording', 'flight-csv-writer.js'));
const { readAutomationRowsForCsv } = require(
  resolveBackendRuntimeFile('flight-recording', 'automation-jsonl-reader.js')
);
const {
  parseCSV,
  _csvRowToStabilityFrame: csvRowToStabilityFrame,
  _generateTimelineFromRows: generateTimelineFromRows,
} =
  require(resolveBackendRuntimeFile('events', 'timeline-generator.js'));
const { parseCsvLine, splitCsvLines } = require(resolveBackendRuntimeFile('utils', 'csv.js'));

const testDir = path.join(os.tmpdir(), 'ff-roundtrip-test-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

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

function approx(a, b, tol = 0.05) {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= tol;
}

function findFirstDifference(left, right, location = 'root') {
  if (Object.is(left, right)) return null;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return { location, left, right };
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.join('\0') !== rightKeys.join('\0')) {
    return { location: `${location} keys`, left: leftKeys, right: rightKeys };
  }
  for (const key of leftKeys) {
    const difference = findFirstDifference(left[key], right[key], `${location}.${key}`);
    if (difference) return difference;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a representative enriched frame with known values
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN = {
  ias: 145.3,
  vs: -700.0,
  altMsl: 2500.0,
  ra: 800.0,
  gs: 148.0,
  oat: -10.0,
  tat: 5.5,
  eng1N1: 55.5,
  eng2N1: 55.5,
  eng3N1: 55.5,  // 3-engine aircraft (DC-10 style)
  eng1N2: 88.0,
  eng2N2: 88.0,
  eng3N2: 88.0,
  eng1Egt: 610,
  eng2Egt: 615,
  eng3Egt: 618,
  eng1FF: 3800,
  eng2FF: 3820,
  eng3FF: 3790,
  thr1: 40.0,
  thr2: 40.0,
  thr3: 40.0,
  onGround: false,
  // lat/lon as flat fields (enriched frame convention)
  lat: 51.4700,
  lon: -0.4543,
  // Nested heading
  heading: { true: 270.0, magnetic: 265.0 },
  altitude: { msl: 2500.0, agl: 800.0 },
  // Flaps as object
  flaps: { percent: 20.0, notch: 2 },
  // Spoilers
  spoilerState: 'ARMED',
  spoilers: { percent: 39.0, state: 'ARMED' },
  yokeX: 0.05,
  yokeY: -0.12,
  pitch: -3.5,
  bank: 1.2,
  aircraft: 'PMDG 777-300ER',
  aircraftProfileId: 'pmdg-777',
  dataSource: 'simconnect',
  userId: 'user-roundtrip',
  sessionId: 'session-roundtrip',
  flightStartIso: '2025-01-01T00:00:00.000Z',
  phase: 'APPROACH',
  stability: 'STABLE',
  fdm: {},
};

async function main() {
// ─────────────────────────────────────────────────────────────────────────────
// 1. Write frame to CSV via FlightCSVWriter
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nCSV write');

const csvWriter = new FlightCSVWriter({
  flightId: '2025-01-01T00-00-00',
  recordingSessionId: 'recording-session-roundtrip',
  outputDir: testDir,
});

let csvPath;
test('writer.start() returns true', () => {
  const ok = csvWriter.start();
  csvPath = csvWriter.filePath;
  assert(ok === true, 'expected true');
});

test('writeSample returns true', () => {
  const frame = { ...KNOWN };
  const ok = csvWriter.writeSample(frame);
  assert(ok === true, `expected true, got ${ok}`);
});

// Write a second sample with special chars in aircraft name (escaping test)
test('writeSample with comma in aircraft name does not crash', () => {
  const frame = { ...KNOWN, aircraft: 'McDonnell Douglas DC-10, Series 10' };
  const ok = csvWriter.writeSample(frame);
  assert(ok === true, `expected true, got ${ok}`);
});

// 4-engine sample: eng4 fields present
test('writeSample for 4-engine aircraft', () => {
  const frame = {
    ...KNOWN,
    eng4N1: 55.5,
    eng4N2: 88.0,
    eng4Egt: 620,
    eng4FF: 3810,
    thr4: 40.0,
  };
  const ok = csvWriter.writeSample(frame);
  assert(ok === true, `expected true, got ${ok}`);
});

// close() is async — await flush before reading back
await csvWriter.close();

// ─────────────────────────────────────────────────────────────────────────────
// 2. Read CSV back and verify structure
// ─────────────────────────────────────────────────────────────────────────────

const rawContent = fs.readFileSync(csvPath, 'utf8');
const rawLines = splitCsvLines(rawContent, { trimAndDropEmpty: true });
const rawHeaders = parseCsvLine(rawLines[0]);
const rawRow = (lineIndex) => {
  const values = parseCsvLine(rawLines[lineIndex]);
  return Object.fromEntries(rawHeaders.map((field, index) => [field, values[index] ?? '']));
};
const rawManifest = rawRow(1);
const rawRow0 = rawRow(2);
const rawRow1 = rawRow(3);

console.log('\nCSV compact metadata');

test('recording manifest durably establishes the CSV identity envelope', () => {
  assert(rawManifest.record_type === 'RECORDING_MANIFEST', `expected manifest, got ${rawManifest.record_type}`);
  assert(rawManifest.sample_index === '0', `expected manifest index 0, got ${rawManifest.sample_index}`);
  assert(rawManifest.schema_version === '3', `expected schema_version 3, got ${rawManifest.schema_version}`);
  assert(rawManifest.recording_session_id === 'recording-session-roundtrip',
    `expected recording_session_id anchor, got ${rawManifest.recording_session_id}`);
  assert(rawManifest.flight_id === '2025-01-01T00-00-00',
    `expected flight_id anchor, got ${rawManifest.flight_id}`);
  assert(rawManifest.flight_start_iso === csvWriter.recordingStartIso,
    `expected flight_start_iso anchor, got ${rawManifest.flight_start_iso}`);
});

test('first raw sample keeps sample-specific metadata anchors', () => {
  assert(rawRow0.schema_version === '', `expected manifest-compacted schema_version, got ${rawRow0.schema_version}`);
  assert(rawRow0.user_id === KNOWN.userId, `expected user_id anchor, got ${rawRow0.user_id}`);
  assert(rawRow0.session_id === KNOWN.sessionId, `expected session_id anchor, got ${rawRow0.session_id}`);
  assert(rawRow0.recording_session_id === '',
    `expected manifest-compacted recording_session_id, got ${rawRow0.recording_session_id}`);
  assert(rawRow0.flight_id === '', `expected manifest-compacted flight_id, got ${rawRow0.flight_id}`);
  assert(rawRow0.flight_start_iso === '', `expected manifest-compacted flight_start_iso, got ${rawRow0.flight_start_iso}`);
  assert(rawRow0.aircraft === KNOWN.aircraft, `expected aircraft anchor, got ${rawRow0.aircraft}`);
  assert(rawRow0.aircraft_profile_id === KNOWN.aircraftProfileId, `expected profile anchor, got ${rawRow0.aircraft_profile_id}`);
  assert(rawRow0.data_source === KNOWN.dataSource, `expected data_source anchor, got ${rawRow0.data_source}`);
});

test('later raw rows omit repeated metadata while preserving aircraft changes', () => {
  assert(rawRow1.schema_version === '', `expected compact schema_version, got ${rawRow1.schema_version}`);
  assert(rawRow1.user_id === '', `expected compact user_id, got ${rawRow1.user_id}`);
  assert(rawRow1.session_id === '', `expected compact session_id, got ${rawRow1.session_id}`);
  assert(rawRow1.recording_session_id === '',
    `expected compact recording_session_id, got ${rawRow1.recording_session_id}`);
  assert(rawRow1.flight_id === '', `expected compact flight_id, got ${rawRow1.flight_id}`);
  assert(rawRow1.flight_start_iso === '', `expected compact flight_start_iso, got ${rawRow1.flight_start_iso}`);
  assert(rawRow1.aircraft === 'McDonnell Douglas DC-10, Series 10', `expected changed aircraft to be written, got ${rawRow1.aircraft}`);
  assert(rawRow1.aircraft_profile_id === '', `expected compact profile id, got ${rawRow1.aircraft_profile_id}`);
  assert(rawRow1.data_source === '', `expected compact data_source, got ${rawRow1.data_source}`);
});

console.log('\nCSV read-back structure');

const { headers, rows, error } = await parseCSV(csvPath);
const sparseCsvResult = await parseCSV(csvPath, { sparseRows: true });

test('parseCSV succeeds', () => assert(!error, `parseCSV error: ${error}`));
test('has header row', () => assert(headers.length > 100, `only ${headers.length} headers`));
test('has one manifest and 3 data rows', () => assert(rows.length === 4, `expected 4, got ${rows.length}`));
test('parseCSV keeps dense rows by default', () => {
  assert(Object.prototype.hasOwnProperty.call(rows[1], 'eng4_n1_pct'),
    'default parser must retain empty columns');
  assert(rows[1].eng4_n1_pct === null, `expected dense empty value, got ${rows[1].eng4_n1_pct}`);
});
test('parseCSV sparse mode omits only empty cells and retains hydrated metadata', () => {
  assert(!sparseCsvResult.error, `sparse parseCSV error: ${sparseCsvResult.error}`);
  assert(sparseCsvResult.headers.join('\0') === headers.join('\0'), 'sparse mode changed CSV headers');
  assert(sparseCsvResult.rows.length === rows.length, 'sparse mode changed CSV row count');
  assert(!Object.prototype.hasOwnProperty.call(sparseCsvResult.rows[1], 'eng4_n1_pct'),
    'sparse mode should omit an empty fourth-engine value');
  assert(sparseCsvResult.rows[1].flight_id === rows[1].flight_id,
    'sparse mode must retain compact metadata hydration');

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (const [key, value] of Object.entries(rows[rowIndex])) {
      if (value === null) continue;
      assert(sparseCsvResult.rows[rowIndex][key] === value,
        `sparse mode changed row ${rowIndex + 1} field ${key}`);
    }
    assert(!Object.values(sparseCsvResult.rows[rowIndex]).includes(null),
      `sparse row ${rowIndex + 1} retained an empty value`);
  }
});
test('sparse rows produce the same Timeline output as dense rows', () => {
  const denseTimeline = generateTimelineFromRows(csvPath, rows.map((row) => ({ ...row })));
  const sparseTimeline = generateTimelineFromRows(
    csvPath,
    sparseCsvResult.rows.map((row) => ({ ...row })),
  );
  if (denseTimeline.timeline && sparseTimeline.timeline) {
    denseTimeline.timeline.generatedAt = '<generated-at>';
    sparseTimeline.timeline.generatedAt = '<generated-at>';
  }
  const difference = findFirstDifference(denseTimeline, sparseTimeline);
  assert(!difference,
    `Timeline output changed when sparse parsing was enabled: ${JSON.stringify(difference)}`);
});

const oversizedCsvPath = path.join(testDir, 'oversized-timeline.csv');
fs.writeFileSync(oversizedCsvPath, 'record_type\nSAMPLE\n', 'utf8');
const oversizedFd = fs.openSync(oversizedCsvPath, 'r+');
fs.ftruncateSync(oversizedFd, (200 * 1024 * 1024) + 1);
fs.closeSync(oversizedFd);
const oversizedResult = await parseCSV(oversizedCsvPath);

test('parseCSV refuses oversized timeline CSVs before loading rows', () => {
  assert(oversizedResult.rows.length === 0, `expected no rows, got ${oversizedResult.rows.length}`);
  assert(
    /CSV is too large to open in Timeline/.test(oversizedResult.error || '') &&
      /limit is 200 MB/.test(oversizedResult.error || ''),
    `expected oversized CSV error, got ${oversizedResult.error}`
  );
});

const swappedCsvPath = path.join(testDir, 'csv-open-swap.csv');
const swappedCsvOtherPath = path.join(testDir, 'csv-open-swap-other.csv');
fs.copyFileSync(csvPath, swappedCsvPath);
fs.copyFileSync(csvPath, swappedCsvOtherPath);
const originalCsvPromisesOpen = fs.promises.open;
fs.promises.open = async (targetPath, ...args) => originalCsvPromisesOpen.call(
  fs.promises,
  targetPath === swappedCsvPath ? swappedCsvOtherPath : targetPath,
  ...args,
);
let swappedCsvResult;
try {
  swappedCsvResult = await parseCSV(swappedCsvPath);
} finally {
  fs.promises.open = originalCsvPromisesOpen;
}
test('parseCSV rejects a path replacement between lstat and open', () => {
  assert(/changed while it was being opened/.test(swappedCsvResult.error || ''),
    `expected CSV open-identity error, got ${swappedCsvResult.error}`);
  assert(swappedCsvResult.rows.length === 0, 'CSV path replacement must fail closed');
});

console.log('\nCrash-tail and sidecar integrity');

const tornCsvPath = path.join(testDir, 'torn-tail.csv');
fs.writeFileSync(tornCsvPath, 'a,b,c\n1,2,3\n4,5', 'utf8');
const tornCsvResult = await parseCSV(tornCsvPath);
test('parseCSV preserves committed rows and quarantines one unterminated torn tail', () => {
  assert(!tornCsvResult.error, `unexpected torn-tail error: ${tornCsvResult.error}`);
  assert(tornCsvResult.rows.length === 1, `expected one committed row, got ${tornCsvResult.rows.length}`);
  assert(tornCsvResult.recoveredTail === true, 'expected recoveredTail marker');
});

const tornQuotedCsvPath = path.join(testDir, 'torn-quoted-tail.csv');
fs.writeFileSync(tornQuotedCsvPath, 'a,b,c\n1,2,3\n4,"unfinished', 'utf8');
const tornQuotedCsvResult = await parseCSV(tornQuotedCsvPath);
test('parseCSV quarantines an unterminated quoted tail', () => {
  assert(!tornQuotedCsvResult.error, `unexpected quoted-tail error: ${tornQuotedCsvResult.error}`);
  assert(tornQuotedCsvResult.rows.length === 1, `expected one committed row, got ${tornQuotedCsvResult.rows.length}`);
  assert(tornQuotedCsvResult.recoveredTail === true, 'expected quoted recoveredTail marker');
});

const tornQuotedNewlineCsvPath = path.join(testDir, 'torn-quoted-newline-tail.csv');
fs.writeFileSync(tornQuotedNewlineCsvPath, 'a,b,c\n1,2,3\n4,"unfinished\n', 'utf8');
const tornQuotedNewlineCsvResult = await parseCSV(tornQuotedNewlineCsvPath);
test('parseCSV treats a trailing newline inside an open quoted field as torn data', () => {
  assert(!tornQuotedNewlineCsvResult.error,
    `unexpected quoted-newline tail error: ${tornQuotedNewlineCsvResult.error}`);
  assert(tornQuotedNewlineCsvResult.rows.length === 1,
    `expected one committed row, got ${tornQuotedNewlineCsvResult.rows.length}`);
  assert(tornQuotedNewlineCsvResult.recoveredTail === true, 'expected quoted-newline recoveredTail marker');
});

const malformedInteriorCsvPath = path.join(testDir, 'malformed-interior.csv');
fs.writeFileSync(malformedInteriorCsvPath, 'a,b,c\n1,2\n4,5,6\n', 'utf8');
const malformedInteriorCsvResult = await parseCSV(malformedInteriorCsvPath);
test('parseCSV rejects malformed committed interior rows', () => {
  assert(/CSV row 2 has 2 columns/.test(malformedInteriorCsvResult.error || ''),
    `expected interior width error, got ${malformedInteriorCsvResult.error}`);
  assert(malformedInteriorCsvResult.rows.length === 0, 'malformed interior data must fail closed');
});

const invalidUtf8CsvPath = path.join(testDir, 'invalid-utf8.csv');
fs.writeFileSync(invalidUtf8CsvPath, Buffer.concat([
  Buffer.from('a,b\n1,', 'utf8'),
  Buffer.from([0xff]),
  Buffer.from('\n', 'utf8'),
]));
const invalidUtf8CsvResult = await parseCSV(invalidUtf8CsvPath);
test('parseCSV rejects invalid UTF-8 instead of accepting replacement characters', () => {
  assert(/invalid UTF-8/.test(invalidUtf8CsvResult.error || ''),
    `expected UTF-8 error, got ${invalidUtf8CsvResult.error}`);
  assert(invalidUtf8CsvResult.rows.length === 0, 'invalid UTF-8 must fail closed');
});

const csvEnvelopeStartIso = '2026-07-20T00:00:00.000Z';
const csvEnvelopeStartMs = Date.parse(csvEnvelopeStartIso);
const csvEnvelopeHeaders = [
  'record_type',
  'schema_version',
  'sample_index',
  'recording_session_id',
  'flight_id',
  'flight_start_iso',
  'flight_elapsed_ms',
  'timestamp_monotonic',
  'ts',
  'timestamp_utc',
];
const csvEnvelopeRow = (sampleIndex, overrides = {}) => {
  const elapsedMs = sampleIndex * 1000;
  return {
    record_type: sampleIndex === 0 ? 'RECORDING_MANIFEST' : 'SAMPLE',
    schema_version: sampleIndex === 0 ? 3 : '',
    sample_index: sampleIndex,
    recording_session_id: sampleIndex === 0 ? 'csv-envelope-session' : '',
    flight_id: sampleIndex === 0 ? 'csv-envelope-flight' : '',
    flight_start_iso: sampleIndex === 0 ? csvEnvelopeStartIso : '',
    flight_elapsed_ms: elapsedMs,
    timestamp_monotonic: elapsedMs,
    ts: csvEnvelopeStartMs + elapsedMs,
    timestamp_utc: new Date(csvEnvelopeStartMs + elapsedMs).toISOString(),
    ...overrides,
  };
};
const writeCsvEnvelopeFixture = (name, fixtureRows) => {
  const fixturePath = path.join(testDir, `${name}.csv`);
  const lines = [
    csvEnvelopeHeaders.join(','),
    ...fixtureRows.map((row) => csvEnvelopeHeaders.map((header) => row[header] ?? '').join(',')),
  ];
  fs.writeFileSync(fixturePath, `${lines.join('\n')}\n`, 'utf8');
  return fixturePath;
};

const validCsvEnvelopePath = writeCsvEnvelopeFixture('csv-envelope-valid', [
  csvEnvelopeRow(0),
  csvEnvelopeRow(1),
]);
const validCsvEnvelopeResult = await parseCSV(validCsvEnvelopePath);
test('parseCSV accepts a compact, contiguous new recording envelope', () => {
  assert(!validCsvEnvelopeResult.error, `unexpected CSV envelope error: ${validCsvEnvelopeResult.error}`);
  assert(validCsvEnvelopeResult.rows.length === 2,
    `expected two CSV envelope rows, got ${validCsvEnvelopeResult.rows.length}`);
  assert(validCsvEnvelopeResult.rows[1].recording_session_id === 'csv-envelope-session',
    'compact recording identity should hydrate after validation');
});

const writeDowngradedCsvEnvelopeFixture = (name, excludedHeaders) => {
  const fixturePath = path.join(testDir, `${name}.csv`);
  const projectedHeaders = csvEnvelopeHeaders.filter((header) => !excludedHeaders.includes(header));
  const fixtureRows = [csvEnvelopeRow(0), csvEnvelopeRow(1)];
  fs.writeFileSync(
    fixturePath,
    `${[
      projectedHeaders.join(','),
      ...fixtureRows.map((row) => projectedHeaders.map((header) => row[header] ?? '').join(',')),
    ].join('\n')}\n`,
    'utf8',
  );
  return fixturePath;
};

const removedSessionEnvelopeResult = await parseCSV(writeDowngradedCsvEnvelopeFixture(
  'csv-envelope-session-column-removed',
  ['recording_session_id'],
));
test('parseCSV cannot be downgraded by removing the recording-session column', () => {
  assert(/recording_session_id/.test(removedSessionEnvelopeResult.error || ''),
    `expected missing-session error, got ${removedSessionEnvelopeResult.error}`);
  assert(removedSessionEnvelopeResult.rows.length === 0, 'removed session column must fail closed');
});

const removedTypeAndSessionEnvelopeResult = await parseCSV(writeDowngradedCsvEnvelopeFixture(
  'csv-envelope-type-and-session-columns-removed',
  ['record_type', 'recording_session_id'],
));
test('parseCSV keeps legacy schema-v3 SAMPLE recordings readable without bundle markers', () => {
  assert(!removedTypeAndSessionEnvelopeResult.error,
    `legacy schema-v3 recording should remain readable: ${removedTypeAndSessionEnvelopeResult.error}`);
  assert(removedTypeAndSessionEnvelopeResult.rows.length === 2,
    `expected two legacy schema-v3 rows, got ${removedTypeAndSessionEnvelopeResult.rows.length}`);
});

const strictBlankCsvPath = path.join(testDir, 'csv-envelope-blank-row.csv');
fs.writeFileSync(
  strictBlankCsvPath,
  [
    csvEnvelopeHeaders.join(','),
    csvEnvelopeHeaders.map((header) => csvEnvelopeRow(0)[header] ?? '').join(','),
    '',
    csvEnvelopeHeaders.map((header) => csvEnvelopeRow(1)[header] ?? '').join(','),
    '',
  ].join('\n'),
  'utf8',
);
const strictBlankCsvResult = await parseCSV(strictBlankCsvPath);
test('parseCSV rejects a committed blank logical row in a current recording', () => {
  assert(/blank logical row at row 3/.test(strictBlankCsvResult.error || ''),
    `expected blank-row error, got ${strictBlankCsvResult.error}`);
  assert(strictBlankCsvResult.rows.length === 0, 'strict blank CSV row must fail closed');
});

const quotedNewlineHeaders = [...csvEnvelopeHeaders, 'notes'];
const quotedNewlineCsvPath = path.join(testDir, 'csv-envelope-quoted-newline.csv');
const quotedNewlineRow = (row, notes) => [
  ...csvEnvelopeHeaders.map((header) => row[header] ?? ''),
  notes,
].join(',');
fs.writeFileSync(
  quotedNewlineCsvPath,
  [
    quotedNewlineHeaders.join(','),
    quotedNewlineRow(csvEnvelopeRow(0), '"manifest\nnotes"'),
    quotedNewlineRow(csvEnvelopeRow(1), ''),
    '',
  ].join('\n'),
  'utf8',
);
const quotedNewlineCsvResult = await parseCSV(quotedNewlineCsvPath);
test('parseCSV preserves a quoted embedded newline in a strict CSV', () => {
  assert(!quotedNewlineCsvResult.error, `unexpected quoted-newline error: ${quotedNewlineCsvResult.error}`);
  assert(quotedNewlineCsvResult.rows.length === 2, 'quoted newline must remain inside one logical row');
  assert(quotedNewlineCsvResult.rows[0].notes === 'manifest\nnotes',
    `expected embedded newline value, got ${JSON.stringify(quotedNewlineCsvResult.rows[0].notes)}`);
});

for (const [label, invalidNotes, expectedError] of [
  ['quote inside unquoted field', 'bad"quote', /quote inside an unquoted field/],
  ['characters after closing quote', '"quoted"x', /characters after a closing quote/],
]) {
  const invalidQuoteCsvPath = path.join(testDir, `csv-envelope-${label.replace(/\s+/g, '-')}.csv`);
  fs.writeFileSync(
    invalidQuoteCsvPath,
    [
      quotedNewlineHeaders.join(','),
      quotedNewlineRow(csvEnvelopeRow(0), ''),
      quotedNewlineRow(csvEnvelopeRow(1), invalidNotes),
      '',
    ].join('\n'),
    'utf8',
  );
  const invalidQuoteResult = await parseCSV(invalidQuoteCsvPath);
  test(`parseCSV rejects ${label} in a strict recording`, () => {
    assert(expectedError.test(invalidQuoteResult.error || ''),
      `unexpected strict quote error: ${invalidQuoteResult.error}`);
    assert(invalidQuoteResult.rows.length === 0, 'invalid strict quote placement must fail closed');
  });
}

const completeLookingTornCsvPath = path.join(testDir, 'csv-envelope-complete-looking-torn-tail.csv');
fs.writeFileSync(
  completeLookingTornCsvPath,
  [
    csvEnvelopeHeaders.join(','),
    csvEnvelopeHeaders.map((header) => csvEnvelopeRow(0)[header] ?? '').join(','),
    csvEnvelopeHeaders.map((header) => csvEnvelopeRow(1)[header] ?? '').join(','),
  ].join('\n'),
  'utf8',
);
const completeLookingTornCsvResult = await parseCSV(completeLookingTornCsvPath);
test('parseCSV quarantines a complete-looking new-bundle row without its commit newline', () => {
  assert(!completeLookingTornCsvResult.error,
    `unexpected complete-looking CSV tail error: ${completeLookingTornCsvResult.error}`);
  assert(completeLookingTornCsvResult.rows.length === 1,
    `expected one committed CSV row, got ${completeLookingTornCsvResult.rows.length}`);
  assert(completeLookingTornCsvResult.recoveredTail === true, 'expected complete-looking CSV tail recovery');
});

const invalidCsvEnvelopeCases = [
  ['flight identity drift', csvEnvelopeRow(1, { flight_id: 'other-flight' }), /flight_id changed/],
  ['recording session drift', csvEnvelopeRow(1, { recording_session_id: 'other-session' }), /recording_session_id changed/],
  ['start clock drift', csvEnvelopeRow(1, { flight_start_iso: '2026-07-20T00:00:01.000Z' }), /flight_start_iso changed/],
  ['sequence gap', csvEnvelopeRow(2), /non-contiguous sample_index/],
  ['unsafe sample index', csvEnvelopeRow(1, { sample_index: Number.MAX_SAFE_INTEGER + 1 }), /non-contiguous sample_index/],
  ['fractional elapsed clock', csvEnvelopeRow(1, { flight_elapsed_ms: 1000.5 }), /flight_elapsed_ms/],
  ['backwards elapsed clock', csvEnvelopeRow(1, {
    flight_elapsed_ms: -1,
    timestamp_monotonic: -1,
    ts: csvEnvelopeStartMs - 1,
    timestamp_utc: new Date(csvEnvelopeStartMs - 1).toISOString(),
  }), /flight_elapsed_ms/],
  ['monotonic clock mismatch', csvEnvelopeRow(1, { timestamp_monotonic: 999 }), /timestamp_monotonic/],
  ['epoch clock mismatch', csvEnvelopeRow(1, { ts: csvEnvelopeStartMs + 999 }), /immutable flight start clock/],
  ['UTC clock mismatch', csvEnvelopeRow(1, { timestamp_utc: csvEnvelopeStartIso }), /timestamp_utc/],
  ['schema drift', csvEnvelopeRow(1, { schema_version: 4 }), /schema_version must be 3/],
  ['fractional schema version', csvEnvelopeRow(1, { schema_version: 3.5 }), /schema_version must be 3/],
  ['duplicate manifest', csvEnvelopeRow(1, { record_type: 'RECORDING_MANIFEST' }), /only valid as the first row/],
];

for (const [label, secondRow, expectedError] of invalidCsvEnvelopeCases) {
  const fixturePath = writeCsvEnvelopeFixture(`csv-envelope-${String(label).replace(/\s+/g, '-')}`, [
    csvEnvelopeRow(0),
    secondRow,
  ]);
  const result = await parseCSV(fixturePath);
  test(`parseCSV rejects ${label}`, () => {
    assert(expectedError.test(result.error || ''), `unexpected CSV integrity result: ${result.error}`);
    assert(result.rows.length === 0, `${label} must fail closed`);
  });
}

const invalidCsvEnvelopeFirstRows = [
  ['missing manifest', csvEnvelopeRow(0, { record_type: 'SAMPLE' }), /must begin with a RECORDING_MANIFEST/],
  ['missing schema version', csvEnvelopeRow(0, { schema_version: '' }), /schema_version must be 3/],
  ['missing recording session', csvEnvelopeRow(0, { recording_session_id: '' }), /recording_session_id/],
  ['missing flight identity', csvEnvelopeRow(0, { flight_id: '' }), /flight_id/],
  ['missing start clock', csvEnvelopeRow(0, { flight_start_iso: '' }), /flight_start_iso/],
  ['missing sample index', csvEnvelopeRow(0, { sample_index: '' }), /sample_index/],
  ['missing elapsed clock', csvEnvelopeRow(0, { flight_elapsed_ms: '' }), /flight_elapsed_ms/],
  ['missing monotonic clock', csvEnvelopeRow(0, { timestamp_monotonic: '' }), /timestamp_monotonic/],
  ['missing epoch clock', csvEnvelopeRow(0, { ts: '' }), /immutable flight start clock/],
  ['non-zero manifest clock', csvEnvelopeRow(0, {
    flight_elapsed_ms: 100,
    timestamp_monotonic: 100,
    ts: csvEnvelopeStartMs + 100,
    timestamp_utc: new Date(csvEnvelopeStartMs + 100).toISOString(),
  }), /must start at flight_elapsed_ms 0/],
];

for (const [label, firstRow, expectedError] of invalidCsvEnvelopeFirstRows) {
  const fixturePath = writeCsvEnvelopeFixture(`csv-envelope-${String(label).replace(/\s+/g, '-')}`, [firstRow]);
  const result = await parseCSV(fixturePath);
  test(`parseCSV rejects ${label} in a new recording`, () => {
    assert(expectedError.test(result.error || ''), `unexpected missing-field result: ${result.error}`);
    assert(result.rows.length === 0, `${label} must fail closed`);
  });
}

const lateCsvManifestPath = writeCsvEnvelopeFixture('csv-envelope-late-manifest', [
  csvEnvelopeRow(0),
  csvEnvelopeRow(1),
  csvEnvelopeRow(2, { record_type: 'RECORDING_MANIFEST' }),
]);
const lateCsvManifestResult = await parseCSV(lateCsvManifestPath);
test('parseCSV rejects a late recording manifest', () => {
  assert(/only valid as the first row/.test(lateCsvManifestResult.error || ''),
    `expected late-manifest error, got ${lateCsvManifestResult.error}`);
  assert(lateCsvManifestResult.rows.length === 0, 'late manifest must fail closed');
});

const legacyIdentityDriftPath = path.join(testDir, 'legacy-csv-identity-drift.csv');
fs.writeFileSync(
  legacyIdentityDriftPath,
  `record_type,flight_id,flight_start_iso\nSAMPLE,legacy-a,2025-01-01T00:00:00.000Z\nSAMPLE,legacy-b,2025-01-01T01:00:00.000Z\n`,
  'utf8',
);
const legacyIdentityDriftResult = await parseCSV(legacyIdentityDriftPath);
test('parseCSV preserves compatibility for legacy CSV identity drift', () => {
  assert(!legacyIdentityDriftResult.error, `unexpected legacy drift error: ${legacyIdentityDriftResult.error}`);
  assert(legacyIdentityDriftResult.rows.length === 2,
    `expected two legacy rows, got ${legacyIdentityDriftResult.rows.length}`);
});

const duplicateHeaderCsvPath = path.join(testDir, 'duplicate-header.csv');
fs.writeFileSync(duplicateHeaderCsvPath, 'record_type,flight_id,flight_id\nSAMPLE,one,two\n', 'utf8');
const duplicateHeaderCsvResult = await parseCSV(duplicateHeaderCsvPath);
test('parseCSV rejects duplicate header names', () => {
  assert(/duplicate column flight_id/.test(duplicateHeaderCsvResult.error || ''),
    `expected duplicate-header error, got ${duplicateHeaderCsvResult.error}`);
  assert(duplicateHeaderCsvResult.rows.length === 0, 'duplicate headers must fail closed');
});

const automationStartIso = '2026-07-20T01:00:00.000Z';
const automationStartMs = Date.parse(automationStartIso);
const automationRow = (seq, overrides = {}) => ({
  schemaVersion: 1,
  seq,
  type: 'automation_checkpoint',
  reason: seq === 1 ? 'first_snapshot' : 'heartbeat',
  timeMs: automationStartMs + (seq - 1) * 1000,
  timestampIso: new Date(automationStartMs + (seq - 1) * 1000).toISOString(),
  flightElapsedMs: (seq - 1) * 1000,
  flightId: 'integrity-flight',
  recordingSessionId: 'integrity-flight',
  flightStartIso: automationStartIso,
  raw: {},
  state: {},
  confidence: {},
  ...overrides,
});
const automationManifest = (overrides = {}) => ({
  schemaVersion: 1,
  seq: 1,
  type: 'automation_manifest',
  timeMs: automationStartMs,
  timestampIso: automationStartIso,
  flightElapsedMs: 0,
  flightId: 'integrity-flight',
  recordingSessionId: 'integrity-flight',
  flightStartIso: automationStartIso,
  ...overrides,
});
const createAutomationFixturePaths = (name) => {
  const safeName = String(name).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const fixtureDir = path.join(testDir, safeName);
  fs.mkdirSync(fixtureDir, { recursive: true });
  return {
    csvPath: path.join(fixtureDir, 'telemetry.csv'),
    sidecarPath: path.join(fixtureDir, 'automation.jsonl'),
  };
};
const automationSidecarPathForCsv = (csvPath) => path.join(path.dirname(csvPath), 'automation.jsonl');
const writeAutomationFixture = (name, chunks, options = {}) => {
  const { csvPath: fixtureCsvPath, sidecarPath: fixtureSidecarPath } = createAutomationFixturePaths(name);
  const csvRecordType = options.csvRecordType
    || (options.legacyCsv ? 'SAMPLE' : 'RECORDING_MANIFEST');
  fs.writeFileSync(
    fixtureCsvPath,
    options.legacyCsv
      ? `record_type,flight_id,flight_start_iso\n${csvRecordType},integrity-flight,${automationStartIso}\n`
      : `record_type,flight_id,flight_start_iso,recording_session_id\n${csvRecordType},integrity-flight,${automationStartIso},integrity-flight\n`,
    'utf8',
  );
  fs.writeFileSync(fixtureSidecarPath, Buffer.concat(chunks.map((chunk) => (
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
  ))));
  return fixtureCsvPath;
};

const validAutomationCsvPath = writeAutomationFixture('automation-valid', [
  `${JSON.stringify(automationManifest())}\n`,
  `${JSON.stringify(automationRow(2))}\n`,
]);
const validAutomationResult = await readAutomationRowsForCsv(validAutomationCsvPath);
test('automation reader accepts a contiguous immutable sidecar', () => {
  assert(!validAutomationResult.error, `unexpected automation error: ${validAutomationResult.error}`);
  assert(validAutomationResult.exists === true, 'an opened automation sidecar should report exists=true');
  assert(validAutomationResult.rows.length === 2, `expected two rows, got ${validAutomationResult.rows.length}`);
});

const compactAutomationManifest = (overrides = {}) => ({
  ...automationManifest(),
  schemaVersion: 2,
  bundleStatusRequired: false,
  ...overrides,
});
const compactAutomationRow = (seq, overrides = {}) => ({
  seq,
  type: 'automation_delta',
  timeMs: automationStartMs + (seq - 1) * 1000,
  stateChanged: { selectedAltitudeFt: 12000 },
  ...overrides,
});
const compactAutomationCsvPath = writeAutomationFixture('automation-compact-v2', [
  `${JSON.stringify(compactAutomationManifest())}\n`,
  `${JSON.stringify(compactAutomationRow(2))}\n`,
  `${JSON.stringify(compactAutomationRow(3, {
    type: 'automation_event',
    eventType: 'ap_disengaged',
    field: 'apMaster',
    previous: true,
    current: false,
    confidence: 'profile-confirmed',
    simconnectCorroborated: true,
  }))}\n`,
]);
const compactAutomationResult = await readAutomationRowsForCsv(compactAutomationCsvPath);
test('automation reader accepts compact v2 rows that inherit the manifest envelope', () => {
  assert(!compactAutomationResult.error, `unexpected compact automation error: ${compactAutomationResult.error}`);
  assert(compactAutomationResult.rows.length === 3,
    `expected three compact rows, got ${compactAutomationResult.rows.length}`);
  assert(compactAutomationResult.rows[1].schemaVersion === undefined,
    'compact data rows should not need a repeated schema version');
  assert(compactAutomationResult.rows[1].flightId === undefined,
    'compact data rows should not need repeated flight identity');
  assert(compactAutomationResult.rows[1].flightElapsedMs === undefined,
    'compact data rows should not need a repeated elapsed clock');
});

const { csvPath: missingAutomationCsvPath } = createAutomationFixturePaths('automation-missing-sidecar');
fs.writeFileSync(
  missingAutomationCsvPath,
  `record_type,flight_id,flight_start_iso,recording_session_id\nRECORDING_MANIFEST,integrity-flight,${automationStartIso},integrity-flight\n`,
  'utf8',
);
const missingAutomationResult = await readAutomationRowsForCsv(missingAutomationCsvPath);
test('automation reader distinguishes a missing sidecar from an invalid one', () => {
  assert(missingAutomationResult.exists === false, 'ENOENT sidecar should report exists=false');
  assert(!missingAutomationResult.error, `missing legacy-compatible sidecar should not invent a parse error: ${missingAutomationResult.error}`);
});

const {
  csvPath: missingCsvWithSidecarPath,
  sidecarPath: missingCsvWithSidecarSidecarPath,
} = createAutomationFixturePaths('automation-present-csv-missing');
fs.writeFileSync(
  missingCsvWithSidecarSidecarPath,
  `${JSON.stringify(automationManifest())}\n`,
  'utf8',
);
const missingCsvWithSidecarResult = await readAutomationRowsForCsv(missingCsvWithSidecarPath);
test('automation reader keeps sidecar existence true when the companion CSV read fails', () => {
  assert(missingCsvWithSidecarResult.exists === true,
    'a present sidecar must not be reported missing because its CSV is absent');
  assert(/ENOENT/.test(missingCsvWithSidecarResult.error || ''),
    `expected CSV ENOENT error, got ${missingCsvWithSidecarResult.error}`);
});

const emptyAutomationCsvPath = writeAutomationFixture('automation-empty-sidecar', []);
const emptyAutomationResult = await readAutomationRowsForCsv(emptyAutomationCsvPath);
test('automation reader rejects an empty sidecar paired with a current CSV', () => {
  assert(emptyAutomationResult.exists === true, 'an empty physical sidecar should report exists=true');
  assert(/must begin with an automation_manifest/.test(emptyAutomationResult.error || ''),
    `expected empty-sidecar manifest error, got ${emptyAutomationResult.error}`);
});

const {
  csvPath: nonRegularAutomationCsvPath,
  sidecarPath: nonRegularAutomationSidecarPath,
} = createAutomationFixturePaths('automation-nonregular');
fs.writeFileSync(
  nonRegularAutomationCsvPath,
  `record_type,flight_id,flight_start_iso,recording_session_id\nRECORDING_MANIFEST,integrity-flight,${automationStartIso},integrity-flight\n`,
  'utf8',
);
fs.mkdirSync(nonRegularAutomationSidecarPath);
const nonRegularAutomationResult = await readAutomationRowsForCsv(nonRegularAutomationCsvPath);
test('automation reader reports a non-regular sidecar as present and invalid', () => {
  assert(nonRegularAutomationResult.exists === true, 'non-regular sidecar path should report exists=true');
  assert(/not a regular file/.test(nonRegularAutomationResult.error || ''),
    `expected non-regular error, got ${nonRegularAutomationResult.error}`);
});

const swappedAutomationCsvPath = writeAutomationFixture('automation-open-swap', [
  `${JSON.stringify(automationManifest())}\n`,
]);
const swappedAutomationOtherPath = path.join(testDir, 'automation-open-swap-other.jsonl');
fs.writeFileSync(swappedAutomationOtherPath, `${JSON.stringify(automationManifest())}\n`, 'utf8');
const originalPromisesOpen = fs.promises.open;
fs.promises.open = async (targetPath, ...args) => originalPromisesOpen.call(
  fs.promises,
  targetPath === automationSidecarPathForCsv(swappedAutomationCsvPath)
    ? swappedAutomationOtherPath
    : targetPath,
  ...args,
);
let swappedAutomationResult;
try {
  swappedAutomationResult = await readAutomationRowsForCsv(swappedAutomationCsvPath);
} finally {
  fs.promises.open = originalPromisesOpen;
}
test('automation reader rejects a path replacement between lstat and open', () => {
  assert(swappedAutomationResult.exists === true, 'replaced sidecar path should remain classified as present');
  assert(/changed while it was being opened/.test(swappedAutomationResult.error || ''),
    `expected open-identity error, got ${swappedAutomationResult.error}`);
  assert(swappedAutomationResult.rows.length === 0, 'path replacement must fail closed');
});

const legacyNullElapsedAutomationCsvPath = writeAutomationFixture('automation-null-elapsed', [
  `${JSON.stringify(automationRow(1, { flightElapsedMs: null, recordingSessionId: undefined }))}\n`,
  `${JSON.stringify(automationRow(2, { flightElapsedMs: null, recordingSessionId: undefined }))}\n`,
], { legacyCsv: true });
const legacyNullElapsedAutomationResult = await readAutomationRowsForCsv(legacyNullElapsedAutomationCsvPath);
test('automation reader preserves schema-v1 compatibility for null elapsed clocks', () => {
  assert(!legacyNullElapsedAutomationResult.error,
    `unexpected null-elapsed compatibility error: ${legacyNullElapsedAutomationResult.error}`);
  assert(legacyNullElapsedAutomationResult.rows.length === 2,
    `expected two null-elapsed rows, got ${legacyNullElapsedAutomationResult.rows.length}`);
});

const legacyBlankAutomationCsvPath = writeAutomationFixture('automation-legacy-blank-row', [
  `${JSON.stringify(automationRow(1, { flightElapsedMs: null, recordingSessionId: undefined }))}\n`,
  '\n',
  `${JSON.stringify(automationRow(2, { flightElapsedMs: null, recordingSessionId: undefined }))}\n`,
], { legacyCsv: true });
const legacyBlankAutomationResult = await readAutomationRowsForCsv(legacyBlankAutomationCsvPath);
test('automation reader retains legacy tolerance for blank rows', () => {
  assert(!legacyBlankAutomationResult.error,
    `unexpected legacy blank-row error: ${legacyBlankAutomationResult.error}`);
  assert(legacyBlankAutomationResult.rows.length === 2,
    `expected two legacy rows around the blank, got ${legacyBlankAutomationResult.rows.length}`);
});

const manifestWithoutSessionAutomationCsvPath = writeAutomationFixture(
  'automation-manifest-without-session',
  [`${JSON.stringify(automationRow(1, { recordingSessionId: undefined }))}\n`],
  { legacyCsv: true, csvRecordType: 'RECORDING_MANIFEST' },
);
const manifestWithoutSessionAutomationResult = await readAutomationRowsForCsv(
  manifestWithoutSessionAutomationCsvPath,
);
test('automation reader cannot downgrade a manifest-first CSV by removing its session column', () => {
  assert(/recording_session_id/.test(manifestWithoutSessionAutomationResult.error || ''),
    `expected missing CSV session error, got ${manifestWithoutSessionAutomationResult.error}`);
  assert(manifestWithoutSessionAutomationResult.rows.length === 0,
    'manifest-first CSV without a session must fail closed');
});

const blankSessionAutomationCsvPath = writeAutomationFixture('automation-blank-csv-session', [
  `${JSON.stringify(automationManifest())}\n`,
]);
fs.writeFileSync(
  blankSessionAutomationCsvPath,
  `record_type,flight_id,flight_start_iso,recording_session_id\nRECORDING_MANIFEST,integrity-flight,${automationStartIso},\n`,
  'utf8',
);
const blankSessionAutomationResult = await readAutomationRowsForCsv(blankSessionAutomationCsvPath);
test('automation reader rejects a current CSV whose session value is blank', () => {
  assert(/recording_session_id/.test(blankSessionAutomationResult.error || ''),
    `expected blank CSV session error, got ${blankSessionAutomationResult.error}`);
  assert(blankSessionAutomationResult.rows.length === 0, 'blank current CSV session must fail closed');
});

const sampleFirstCurrentAutomationCsvPath = writeAutomationFixture(
  'automation-current-sample-first',
  [`${JSON.stringify(automationManifest())}\n`],
  { csvRecordType: 'SAMPLE' },
);
const sampleFirstCurrentAutomationResult = await readAutomationRowsForCsv(
  sampleFirstCurrentAutomationCsvPath,
);
test('automation reader rejects a session-scoped CSV without its recording manifest', () => {
  assert(/must begin with a RECORDING_MANIFEST/.test(sampleFirstCurrentAutomationResult.error || ''),
    `expected missing CSV manifest error, got ${sampleFirstCurrentAutomationResult.error}`);
  assert(sampleFirstCurrentAutomationResult.rows.length === 0,
    'session-scoped SAMPLE-first CSV must fail closed');
});

const strictBlankAutomationCsvPath = writeAutomationFixture('automation-strict-blank-row', [
  `${JSON.stringify(automationManifest())}\n`,
  '\n',
  `${JSON.stringify(automationRow(2))}\n`,
]);
const strictBlankAutomationResult = await readAutomationRowsForCsv(strictBlankAutomationCsvPath);
test('automation reader rejects a committed blank row in a current sidecar', () => {
  assert(/blank row at line 2/.test(strictBlankAutomationResult.error || ''),
    `expected strict blank-row error, got ${strictBlankAutomationResult.error}`);
  assert(strictBlankAutomationResult.rows.length === 0, 'strict blank row must fail closed');
});

const tornAutomationCsvPath = writeAutomationFixture('automation-torn-tail', [
  `${JSON.stringify(automationManifest())}\n`,
  '{"schemaVersion":1,"seq":2',
]);
const tornAutomationResult = await readAutomationRowsForCsv(tornAutomationCsvPath);
test('automation reader preserves committed rows and quarantines one malformed unterminated tail', () => {
  assert(!tornAutomationResult.error, `unexpected torn automation error: ${tornAutomationResult.error}`);
  assert(tornAutomationResult.rows.length === 1, `expected one committed row, got ${tornAutomationResult.rows.length}`);
  assert(tornAutomationResult.parseErrorCount === 1, 'expected one quarantined parse error');
  assert(tornAutomationResult.recoveredTail === true, 'expected automation recoveredTail marker');
});

const completeLookingTornAutomationCsvPath = writeAutomationFixture('automation-complete-looking-torn-tail', [
  `${JSON.stringify(automationManifest())}\n`,
  JSON.stringify(automationRow(2)),
]);
const completeLookingTornAutomationResult = await readAutomationRowsForCsv(completeLookingTornAutomationCsvPath);
test('automation reader quarantines a complete-looking row without its commit newline', () => {
  assert(!completeLookingTornAutomationResult.error,
    `unexpected complete-looking automation tail error: ${completeLookingTornAutomationResult.error}`);
  assert(completeLookingTornAutomationResult.rows.length === 1,
    `expected one committed automation row, got ${completeLookingTornAutomationResult.rows.length}`);
  assert(completeLookingTornAutomationResult.parseErrorCount === 0,
    'a syntactically valid torn row should not count as malformed JSON');
  assert(completeLookingTornAutomationResult.recoveredTail === true,
    'expected complete-looking automation tail recovery');
});

const malformedAutomationCsvPath = writeAutomationFixture('automation-malformed-interior', [
  `${JSON.stringify(automationManifest())}\n`,
  '{not-json}\n',
  `${JSON.stringify(automationRow(2))}\n`,
]);
const malformedAutomationResult = await readAutomationRowsForCsv(malformedAutomationCsvPath);
test('automation reader rejects malformed committed interior JSON', () => {
  assert(/malformed JSON at line 2/.test(malformedAutomationResult.error || ''),
    `expected interior JSON error, got ${malformedAutomationResult.error}`);
  assert(malformedAutomationResult.rows.length === 0, 'malformed interior JSON must fail closed');
});

const invalidUtf8AutomationCsvPath = writeAutomationFixture('automation-invalid-utf8', [
  Buffer.from(`${JSON.stringify(automationManifest()).slice(0, -1)},"note":"`, 'utf8'),
  Buffer.from([0xff]),
  Buffer.from('"}\n', 'utf8'),
]);
const invalidUtf8AutomationResult = await readAutomationRowsForCsv(invalidUtf8AutomationCsvPath);
test('automation reader rejects invalid UTF-8', () => {
  assert(/invalid UTF-8/.test(invalidUtf8AutomationResult.error || ''),
    `expected automation UTF-8 error, got ${invalidUtf8AutomationResult.error}`);
  assert(invalidUtf8AutomationResult.rows.length === 0, 'invalid automation UTF-8 must fail closed');
});

const invalidAutomationCases = [
  ['schema version', automationRow(2, { schemaVersion: 3 }), /schemaVersion/],
  ['row type', automationRow(2, { type: 'unknown_row' }), /row type/],
  ['sequence gap', automationRow(3), /non-contiguous seq/],
  ['unsafe sequence number', automationRow(2, { seq: Number.MAX_SAFE_INTEGER + 1 }), /non-contiguous seq/],
  ['fractional epoch clock', automationRow(2, { timeMs: automationStartMs + 1000.5 }), /timeMs/],
  ['fractional elapsed clock', automationRow(2, { flightElapsedMs: 1000.5 }), /flightElapsedMs/],
  ['null elapsed clock', automationRow(2, { flightElapsedMs: null }), /flightElapsedMs/],
  ['missing elapsed clock', automationRow(2, { flightElapsedMs: undefined }), /flightElapsedMs/],
  ['flight identity change', automationRow(2, {
    flightId: 'other-flight',
    recordingSessionId: 'other-flight',
  }), /flightId changed/],
  ['session identity change', automationRow(2, { recordingSessionId: 'other-session' }), /recordingSessionId changed/],
  ['start clock change', automationRow(2, { flightStartIso: '2026-07-20T01:00:01.000Z' }), /flightStartIso changed/],
  ['timestamp mismatch', automationRow(2, { timestampIso: '2026-07-20T01:00:02.000Z' }), /timestampIso does not match/],
  ['elapsed/start mismatch', automationRow(2, { flightElapsedMs: 999 }), /does not match the flight start clock/],
  ['backwards elapsed clock', automationRow(2, { flightElapsedMs: -1 }), /flightElapsedMs/],
];

for (const [label, secondRow, expectedError] of invalidAutomationCases) {
  const fixturePath = writeAutomationFixture(`automation-${String(label).replace(/[^a-z0-9]+/gi, '-')}`, [
    `${JSON.stringify(automationManifest())}\n`,
    `${JSON.stringify(secondRow)}\n`,
  ]);
  const result = await readAutomationRowsForCsv(fixturePath);
  test(`automation reader rejects ${label}`, () => {
    assert(expectedError.test(result.error || ''), `unexpected integrity result: ${result.error}`);
    assert(result.rows.length === 0, `${label} must fail closed`);
  });
}

const missingManifestAutomationCsvPath = writeAutomationFixture('automation-missing-manifest', [
  `${JSON.stringify(automationRow(1))}\n`,
]);
const missingManifestAutomationResult = await readAutomationRowsForCsv(missingManifestAutomationCsvPath);
test('automation reader rejects a session-scoped sidecar without its manifest', () => {
  assert(/must begin with an automation_manifest/.test(missingManifestAutomationResult.error || ''),
    `expected missing-manifest error, got ${missingManifestAutomationResult.error}`);
  assert(missingManifestAutomationResult.rows.length === 0, 'missing manifest must fail closed');
});

const lateManifestAutomationCsvPath = writeAutomationFixture('automation-late-manifest', [
  `${JSON.stringify(automationManifest())}\n`,
  `${JSON.stringify(automationManifest({ seq: 2, timeMs: automationStartMs + 1000,
    timestampIso: new Date(automationStartMs + 1000).toISOString(), flightElapsedMs: 1000 }))}\n`,
]);
const lateManifestAutomationResult = await readAutomationRowsForCsv(lateManifestAutomationCsvPath);
test('automation reader rejects a manifest after the first row', () => {
  assert(/only valid as the first row/.test(lateManifestAutomationResult.error || ''),
    `expected late-manifest error, got ${lateManifestAutomationResult.error}`);
  assert(lateManifestAutomationResult.rows.length === 0, 'late manifest must fail closed');
});

const backwardsWallAutomationCsvPath = writeAutomationFixture('automation-backwards-wall', [
  `${JSON.stringify(automationManifest())}\n`,
  `${JSON.stringify(automationRow(2, {
    timeMs: automationStartMs + 1000,
    timestampIso: new Date(automationStartMs + 1000).toISOString(),
    flightElapsedMs: 1000,
  }))}\n`,
  `${JSON.stringify(automationRow(3, {
    timeMs: automationStartMs + 500,
    timestampIso: new Date(automationStartMs + 500).toISOString(),
    flightElapsedMs: 500,
  }))}\n`,
]);
const backwardsWallAutomationResult = await readAutomationRowsForCsv(backwardsWallAutomationCsvPath);
test('automation reader rejects backwards wall clock', () => {
  assert(/timeMs moved backwards/.test(backwardsWallAutomationResult.error || ''),
    `expected backwards-clock error, got ${backwardsWallAutomationResult.error}`);
  assert(backwardsWallAutomationResult.rows.length === 0, 'backwards wall clock must fail closed');
});

const backwardsElapsedAutomationCsvPath = writeAutomationFixture('automation-backwards-elapsed', [
  `${JSON.stringify(automationManifest())}\n`,
  `${JSON.stringify(automationRow(2, { flightElapsedMs: 500 }))}\n`,
]);
const backwardsElapsedAutomationResult = await readAutomationRowsForCsv(backwardsElapsedAutomationCsvPath);
test('automation reader rejects a backwards non-negative elapsed clock', () => {
  assert(/does not match the flight start clock/.test(backwardsElapsedAutomationResult.error || ''),
    `expected inconsistent elapsed error, got ${backwardsElapsedAutomationResult.error}`);
  assert(backwardsElapsedAutomationResult.rows.length === 0, 'backwards elapsed time must fail closed');
});

const preStartAutomationCsvPath = writeAutomationFixture('automation-pre-start-time', [
  `${JSON.stringify(automationManifest())}\n`,
  `${JSON.stringify(automationRow(2, {
    timeMs: automationStartMs - 1,
    timestampIso: new Date(automationStartMs - 1).toISOString(),
    flightElapsedMs: null,
  }))}\n`,
]);
const preStartAutomationResult = await readAutomationRowsForCsv(preStartAutomationCsvPath);
test('automation reader rejects timestamps before the immutable flight start clock', () => {
  assert(/timeMs precedes flightStartIso/.test(preStartAutomationResult.error || ''),
    `expected pre-start clock error, got ${preStartAutomationResult.error}`);
  assert(preStartAutomationResult.rows.length === 0, 'pre-start automation time must fail closed');
});

const sampleRows = rows.filter((row) => row.record_type === 'SAMPLE');
const row0 = sampleRows[0]; // first sample (KNOWN frame)
const rowComma = sampleRows[1]; // comma-aircraft-name frame
const row4eng = sampleRows[2]; // 4-engine frame

test('record_type is SAMPLE', () => assert(row0.record_type === 'SAMPLE', `got ${row0.record_type}`));
test('header includes ias_kts', () => assert(headers.includes('ias_kts'), 'ias_kts missing from headers'));
test('header includes eng3_n1_pct', () => assert(headers.includes('eng3_n1_pct'), 'eng3_n1_pct missing'));
test('header includes eng4_n1_pct', () => assert(headers.includes('eng4_n1_pct'), 'eng4_n1_pct missing'));
test('header includes stability', () => assert(headers.includes('stability'), 'stability missing'));
test('parseCSV hydrates compact repeated metadata', () => {
  assert(row0.user_id === KNOWN.userId, `expected row0 user_id, got ${row0.user_id}`);
  assert(rowComma.user_id === KNOWN.userId, `expected hydrated rowComma user_id, got ${rowComma.user_id}`);
  assert(row4eng.session_id === KNOWN.sessionId, `expected hydrated row4eng session_id, got ${row4eng.session_id}`);
  assert(rowComma.flight_id === '2025-01-01T00-00-00', `expected hydrated flight_id, got ${rowComma.flight_id}`);
  assert(row4eng.recording_session_id === 'recording-session-roundtrip',
    `expected hydrated recording_session_id, got ${row4eng.recording_session_id}`);
  assert(row4eng.flight_start_iso === csvWriter.recordingStartIso,
    `expected hydrated flight_start_iso, got ${row4eng.flight_start_iso}`);
  assert(rowComma.aircraft_profile_id === KNOWN.aircraftProfileId, `expected hydrated profile id, got ${rowComma.aircraft_profile_id}`);
  assert(row4eng.data_source === KNOWN.dataSource, `expected hydrated data_source, got ${row4eng.data_source}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Verify column values survive the write→read cycle
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nCSV roundtrip values');

test('ias_kts roundtrips (1dp precision)', () => {
  assert(approx(row0.ias_kts, KNOWN.ias, 0.1), `expected ~${KNOWN.ias}, got ${row0.ias_kts}`);
});
test('vs_fpm roundtrips (1dp precision)', () => {
  assert(approx(row0.vs_fpm, KNOWN.vs, 0.1), `expected ~${KNOWN.vs}, got ${row0.vs_fpm}`);
});
test('alt_msl_ft roundtrips', () => {
  assert(approx(row0.alt_msl_ft, KNOWN.altMsl, 0.1), `expected ~${KNOWN.altMsl}, got ${row0.alt_msl_ft}`);
});
test('ra_ft roundtrips', () => {
  assert(approx(row0.ra_ft, KNOWN.ra, 0.1), `expected ~${KNOWN.ra}, got ${row0.ra_ft}`);
});
test('on_ground roundtrips (false → 0)', () => {
  assert(row0.on_ground === 0 || row0.on_ground === false, `expected 0/false, got ${row0.on_ground}`);
});
test('aircraft roundtrips', () => {
  assert(row0.aircraft === KNOWN.aircraft, `expected "${KNOWN.aircraft}", got "${row0.aircraft}"`);
});
test('phase roundtrips', () => {
  assert(row0.phase === KNOWN.phase, `got "${row0.phase}"`);
});
test('stability roundtrips', () => {
  assert(row0.stability === KNOWN.stability, `got "${row0.stability}"`);
});
test('pitch_deg roundtrips', () => {
  assert(approx(row0.pitch_deg, KNOWN.pitch, 0.1), `got ${row0.pitch_deg}`);
});
test('bank_deg roundtrips', () => {
  assert(approx(row0.bank_deg, KNOWN.bank, 0.1), `got ${row0.bank_deg}`);
});
test('eng1_n1_pct roundtrips', () => {
  assert(approx(row0.eng1_n1_pct, KNOWN.eng1N1, 0.1), `expected ~${KNOWN.eng1N1}, got ${row0.eng1_n1_pct}`);
});
test('eng3_n1_pct roundtrips (3-engine aircraft)', () => {
  assert(approx(row0.eng3_n1_pct, KNOWN.eng3N1, 0.1), `expected ~${KNOWN.eng3N1}, got ${row0.eng3_n1_pct}`);
});
test('eng4_n1_pct is empty for 3-engine aircraft', () => {
  assert(row0.eng4_n1_pct === null || row0.eng4_n1_pct === '' || !Number.isFinite(row0.eng4_n1_pct),
    `expected null/empty, got ${row0.eng4_n1_pct}`);
});
test('eng3_n2_pct roundtrips', () => {
  assert(approx(row0.eng3_n2_pct, KNOWN.eng3N2, 0.1), `got ${row0.eng3_n2_pct}`);
});
test('eng2_egt_c roundtrips', () => {
  assert(approx(row0.eng2_egt_c, KNOWN.eng2Egt, 0.1), `got ${row0.eng2_egt_c}`);
});
test('eng3_ff_pph roundtrips', () => {
  assert(approx(row0.eng3_ff_pph, KNOWN.eng3FF, 0.1), `got ${row0.eng3_ff_pph}`);
});
test('thr1_pct roundtrips', () => {
  assert(approx(row0.thr1_pct, KNOWN.thr1, 0.1), `got ${row0.thr1_pct}`);
});
test('thr3_pct roundtrips (3-engine)', () => {
  assert(approx(row0.thr3_pct, KNOWN.thr3, 0.1), `got ${row0.thr3_pct}`);
});
test('spoiler_state roundtrips', () => {
  assert(row0.spoiler_state === 'ARMED', `got "${row0.spoiler_state}"`);
});
test('yoke_x_pct roundtrips (×100 scaling)', () => {
  // yokeX: 0.05 → column should be 5.0
  assert(approx(row0.yoke_x_pct, 5.0, 0.1), `expected ~5.0, got ${row0.yoke_x_pct}`);
});
test('yoke_y_pct roundtrips (×100 scaling)', () => {
  // yokeY: -0.12 → column should be -12.0
  assert(approx(row0.yoke_y_pct, -12.0, 0.1), `expected ~-12.0, got ${row0.yoke_y_pct}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CSV escaping: aircraft name with comma
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nCSV escaping');

test('aircraft name with comma is unescaped correctly on read-back', () => {
  assert(rowComma.aircraft === 'McDonnell Douglas DC-10, Series 10',
    `got "${rowComma.aircraft}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 4-engine roundtrip
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n4-engine roundtrip');

test('eng4_n1_pct present in 4-engine row', () => {
  assert(approx(row4eng.eng4_n1_pct, 55.5, 0.1), `got ${row4eng.eng4_n1_pct}`);
});
test('thr4_pct present in 4-engine row', () => {
  assert(approx(row4eng.thr4_pct, 40.0, 0.1), `got ${row4eng.thr4_pct}`);
});
test('eng4_egt_c present in 4-engine row', () => {
  assert(approx(row4eng.eng4_egt_c, 620, 0.1), `got ${row4eng.eng4_egt_c}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. csvRowToStabilityFrame on the parsed row (full chain)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nFull chain: parsed CSV row → stability frame');

const sf = csvRowToStabilityFrame(row0, 100);

test('stability frame: ias correct', () => {
  assert(approx(sf.iasKts, KNOWN.ias, 0.1), `expected ~${KNOWN.ias}, got ${sf.iasKts}`);
});
test('stability frame: vs correct', () => {
  assert(approx(sf.vsFpm, KNOWN.vs, 0.1), `expected ~${KNOWN.vs}, got ${sf.vsFpm}`);
});
test('stability frame: ra correct', () => {
  assert(approx(sf.raFt, KNOWN.ra, 0.1), `expected ~${KNOWN.ra}, got ${sf.raFt}`);
});
test('stability frame: on_ground false', () => {
  assert(!sf.onGround, `expected false, got ${sf.onGround}`);
});
test('stability frame: flaps.percent correct', () => {
  assert(approx(sf.flapsPercent, 20.0, 0.1), `got ${sf.flapsPercent}`);
});
test('stability frame: spoilers.state = ARMED', () => {
  assert(sf.spoilersState === 'ARMED', `got "${sf.spoilersState}"`);
});

// 3-engine thrust: thr1=40, thr2=40, thr3=40, thr4=null → average = 40
test('stability frame: 3-engine thrust average = 40', () => {
  assert(approx(sf.thrustPct, 40.0, 0.1), `expected 40.0, got ${sf.thrustPct}`);
});

test('stability frame: lat_deg propagated', () => {
  assert(approx(sf.latDeg, 51.47, 0.01), `got ${sf.latDeg}`);
});
test('stability frame: lon_deg propagated', () => {
  assert(approx(sf.lonDeg, -0.4543, 0.001), `got ${sf.lonDeg}`);
});
test('stability frame: dtMs correct', () => {
  assert(sf.dtMs === 100, `got ${sf.dtMs}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch (_) {
  // cleanup failure is not a test failure
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✓ All ${passed} CSV roundtrip tests passed`);
} else {
  console.log(`✗ ${failed} failed, ${passed} passed`);
}

} // end main()

main().then(() => {
  process.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
