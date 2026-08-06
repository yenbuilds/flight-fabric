#!/usr/bin/env node
/**
 * Test: V1 CSV Assist Columns
 *
 * Ensures assist detection columns are included in V1 CSV output.
 * This is a regression test for the slew/assist visibility feature.
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const schemaFieldMap = require(resolveBackendRuntimeFile('flight-recording', 'schema-field-map.js'));
const { buildSimConnectAssists } = require(resolveBackendRuntimeFile('telemetry-provider', 'simconnect-frame-builder.js'));
const { readRepoSource } = require('./backend-source-paths');

console.log('=== V1 CSV Assist Columns Test ===\n');

// Required assist columns that MUST be in V1 CSV for user transparency.
const REQUIRED_V1_ASSIST_COLUMNS = [
  { col: 'assist_unlimited_fuel', on: true, off: false },
  { col: 'assist_landing_enabled', on: true, off: false },
  { col: 'assist_takeoff_enabled', on: true, off: false },
  { col: 'assist_ai_controls', on: true, off: false },
  { col: 'assist_ai_autotrim', on: true, off: false },
  { col: 'assist_ai_delegated', on: true, off: false },
  { col: 'assist_ai_antistall_state', on: 1, off: 2 },
  { col: 'assist_ai_antistall_active', on: true, off: false },
  { col: 'assist_realism_pct', on: 75, off: 100 },
  { col: 'assist_full_realism', on: false, off: true },
  { col: 'assist_slew_active', on: true, off: false },
  { col: 'assist_any_active', on: true, off: false },
];
const REQUIRED_V1_ASSIST_COLUMN_NAMES = REQUIRED_V1_ASSIST_COLUMNS.map((entry) => entry.col);

const v1Columns = schemaFieldMap.getV1Columns();

let passed = 0;
let failed = 0;

console.log('Test 1: Required assist columns in V1 CSV...');
for (const col of REQUIRED_V1_ASSIST_COLUMN_NAMES) {
  if (v1Columns.includes(col)) {
    console.log(`  OK ${col}: present in V1`);
    passed++;
  } else {
    console.log(`  FAIL ${col}: missing from V1 (check schema-field-map.ts)`);
    failed++;
  }
}

console.log('\nTest 2: Extractor functions work...');

const mockFrame = {
  assists: {
    unlimitedFuel: true,
    landingAssist: true,
    takeoffAssist: true,
    aiControls: true,
    aiAutotrim: true,
    aiDelegated: true,
    aiAntistall: 1,
    aiAntistallActive: true,
    realismPercent: 75,
    fullRealism: false,
    slewActive: true,
    anyAssistActive: true,
  },
};

const mockFrameOff = {
  assists: {
    unlimitedFuel: false,
    landingAssist: false,
    takeoffAssist: false,
    aiControls: false,
    aiAutotrim: false,
    aiDelegated: false,
    aiAntistall: 2,
    aiAntistallActive: false,
    realismPercent: 100,
    fullRealism: true,
    slewActive: false,
    anyAssistActive: false,
  },
};

const mockFlatFrame = {
  assist_unlimited_fuel: true,
  assist_landing_enabled: true,
  assist_takeoff_enabled: true,
  assist_ai_controls: true,
  assist_ai_autotrim: true,
  assist_ai_delegated: true,
  assist_ai_antistall_state: 1,
  assist_ai_antistall_active: true,
  assist_realism_pct: 75,
  assist_full_realism: false,
  assist_slew_active: true,
  assist_any_active: true,
};

for (const { col, on, off } of REQUIRED_V1_ASSIST_COLUMNS) {
  const field = schemaFieldMap.getField(col);
  if (!field) {
    console.log(`  FAIL ${col}: field definition not found`);
    failed++;
    continue;
  }

  const valueOn = field.extract(mockFrame);
  const valueOff = field.extract(mockFrameOff);
  const valueFlat = field.extract(mockFlatFrame);

  if (Object.is(valueOn, on) && Object.is(valueOff, off) && Object.is(valueFlat, on)) {
    console.log(`  OK ${col}: extracts nested and flat values correctly`);
    passed++;
  } else {
    console.log(`  FAIL ${col}: extraction failed (got nested=${valueOn}/${valueOff}, flat=${valueFlat})`);
    failed++;
  }
}

console.log('\nTest 3: SimConnect source data and assist mapping exist...');
const providerCode = readRepoSource('backend/telemetry-provider/simconnect-telemetry-provider.js', 'utf8');

for (const simvar of [
  'UNLIMITED FUEL',
  'ASSISTANCE LANDING ENABLED',
  'ASSISTANCE TAKEOFF ENABLED',
  'AI CONTROLS',
  'AI AUTOTRIM ACTIVE',
  'DELEGATE CONTROLS TO AI',
  'AI ANTISTALL STATE',
  'REALISM',
  'IS SLEW ACTIVE',
]) {
  if (providerCode.includes(`simvar: '${simvar}'`)) {
    console.log(`  OK ${simvar} SimVar defined in provider`);
    passed++;
  } else {
    console.log(`  FAIL ${simvar} SimVar not found in provider`);
    failed++;
  }
}

const assists = buildSimConnectAssists(
  {
    unlimitedFuel: 0,
    realismPercent: 100,
    assistLanding: 0,
    assistTakeoff: 0,
    aiControls: 0,
    aiAutotrim: 0,
    aiDelegated: 0,
    aiAntistall: 0,
    slewActive: 1,
  },
  (value) => (value == null ? null : Boolean(value)),
);

if (assists && assists.slewActive === true) {
  console.log('  OK slewActive mapped to frame.assists');
  passed++;
} else {
  console.log('  FAIL slewActive not mapped to frame.assists');
  failed++;
}

if (
  assists &&
  assists.unlimitedFuel === false &&
  assists.landingAssist === false &&
  assists.takeoffAssist === false &&
  assists.aiControls === false &&
  assists.aiAutotrim === false &&
  assists.aiDelegated === false &&
  assists.aiAntistall === 0 &&
  assists.aiAntistallActive === true &&
  assists.realismPercent === 100 &&
  assists.fullRealism === false &&
  assists.anyAssistActive === true
) {
  console.log('  OK detailed assist flags mapped to frame.assists');
  passed++;
} else {
  console.log('  FAIL detailed assist flags not mapped to frame.assists as expected');
  failed++;
}

console.log('\n========================================');
if (failed === 0) {
  console.log(`PASS all ${passed} tests passed`);
  console.log('V1 CSV will include assist detection columns');
} else {
  console.log(`FAIL ${failed} test(s) failed, ${passed} passed`);
  console.log('V1 CSV may not show assist or slew data to users');
  process.exit(1);
}
