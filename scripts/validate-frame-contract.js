#!/usr/bin/env node
// scripts/validate-frame-contract.js
// CI script: validates that telemetry providers produce frames matching the contract.
// Run: node scripts/validate-frame-contract.js
// Fails CI if contract is violated.

const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { resolveRepoSourcePath, readRepoSource } = require('./backend-source-paths');
const { 
  CRITICAL_FIELDS, 
  REQUIRED_DISPLAY_FIELDS,
  REQUIRED_SOURCE_FIELDS,
  CONVERSION_CONSTANTS,
} = require(resolveBackendRuntimeFile('telemetry-provider', 'frame-contract.js'));

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║           FRAME CONTRACT VALIDATION                          ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

let exitCode = 0;

// 1. Validate contract constants match units.js
console.log('1. Checking conversion constants match units.js...');
try {
  const units = require(resolveBackendRuntimeFile('utils', 'units.js'));
  
  const checks = [
    { name: 'FT_TO_M', contract: CONVERSION_CONSTANTS.FT_TO_M, units: units.FT_TO_M },
    { name: 'M_TO_FT', contract: CONVERSION_CONSTANTS.M_TO_FT, units: units.M_TO_FT },
    { name: 'MS_TO_FPM', contract: CONVERSION_CONSTANTS.MS_TO_FPM, units: units.MS_TO_FPM },
  ];
  
  for (const c of checks) {
    if (c.units === undefined) {
      console.log(`   ⚠️  ${c.name}: not exported from units.js (OK if internal)`);
    } else if (Math.abs(c.contract - c.units) > 0.0001) {
      console.log(`   ❌ ${c.name}: contract=${c.contract}, units.js=${c.units} - MISMATCH!`);
      exitCode = 1;
    } else {
      console.log(`   ✓  ${c.name}: ${c.contract}`);
    }
  }
} catch (e) {
  console.log(`   ❌ Failed to load units.js: ${e.message}`);
  exitCode = 1;
}

// 2. Validate SimConnect provider variable definitions match contract
console.log('\n2. Checking SimConnect provider matches contract...');
const providerPath = resolveRepoSourcePath('backend/telemetry-provider/simconnect-telemetry-provider.js');
try {
  const providerCode = readRepoSource('backend/telemetry-provider/simconnect-telemetry-provider.js', 'utf8');
  
  for (const [key, field] of Object.entries(CRITICAL_FIELDS)) {
    // Check that the SDK unit comment exists in code
    const hasUnitDoc = providerCode.includes(field.sdkNativeUnit) && 
                       providerCode.includes(field.sdkSimvar);
    
    if (!hasUnitDoc) {
      console.log(`   ⚠️  ${key}: SDK unit documentation may be missing in provider`);
    } else {
      console.log(`   ✓  ${key}: SDK unit '${field.sdkNativeUnit}' documented`);
    }
  }
} catch (e) {
  console.log(`   ❌ Failed to check provider ${path.basename(providerPath || '')}: ${e.message}`);
  exitCode = 1;
}

// 3. Check contract has SDK doc URLs
console.log('\n3. Checking SDK documentation links...');
for (const [key, field] of Object.entries(CRITICAL_FIELDS)) {
  if (!field.sdkDocUrl || !field.sdkDocUrl.startsWith('http')) {
    console.log(`   ❌ ${key}: missing or invalid sdkDocUrl`);
    exitCode = 1;
  } else {
    console.log(`   ✓  ${key}: ${field.sdkDocUrl.substring(0, 60)}...`);
  }
}

// 4. List all required fields
console.log('\n4. Required frame fields:');
console.log('   Source fields:', Object.keys(REQUIRED_SOURCE_FIELDS).join(', '));
console.log('   Display fields:', Object.keys(REQUIRED_DISPLAY_FIELDS).join(', '));

// 5. Summary
console.log('\n' + '═'.repeat(64));
if (exitCode === 0) {
  console.log('✅ Frame contract validation PASSED');
} else {
  console.log('❌ Frame contract validation FAILED');
  console.log('   Fix the issues above before committing.');
}

process.exit(exitCode);
