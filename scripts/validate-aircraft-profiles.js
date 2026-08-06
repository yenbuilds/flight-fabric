#!/usr/bin/env node
// Validate all aircraft profiles against the JSON schema.
//
// Flags:
//   --strict   Fail on warnings too
//   --ajv-strict Enable Ajv strict mode (CI/pre-merge)
//   --manifest Output registry manifest JSON
//   --stats    Show summary statistics

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const registry = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-registry.js'));

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const ajvStrict = args.includes('--ajv-strict');
const showManifest = args.includes('--manifest');
const showStats = args.includes('--stats');

if (ajvStrict) {
  const strictResult = registry.validateProfilesWithAjvStrict();
  if (!strictResult.success) {
    console.error('❌ Ajv strict validation failed');
    if (strictResult.error) {
      console.error(strictResult.error);
    }
    if (Array.isArray(strictResult.failures) && strictResult.failures.length > 0) {
      for (const failure of strictResult.failures.slice(0, 10)) {
        console.error(`  - ${failure.id}: ${failure.errors.length} error(s)`);
      }
      if (strictResult.failures.length > 10) {
        console.error(`  ... and ${strictResult.failures.length - 10} more`);
      }
    }
    process.exit(1);
  }
}

// Initialize registry (loads schema, scans all profiles, validates)
const result = registry.initialize();

if (!result.success) {
  console.error('❌ Registry initialization failed');
  console.error(result.errors);
  process.exit(1);
}

// Get detailed results
const profileIds = registry.getProfileIds();
let hasErrors = false;
let hasWarnings = false;

console.log('\n=== Aircraft Profile Validation ===\n');

for (const id of profileIds) {
  const profile = registry.getProfile(id);
  const validation = registry.getValidation(id);
  
  // Determine status icon
  let icon = '✅';
  if (!validation.valid) {
    icon = '❌';
    hasErrors = true;
  } else if (validation.warnings.length > 0) {
    icon = '⚠️';
    hasWarnings = true;
  }

  console.log(`${icon} ${id} (${profile.meta?.status || 'unknown'})`);
  
  if (!validation.valid) {
    for (const err of validation.errors) {
      console.log(`     ❌ ${err.path}: ${err.message}`);
    }
  }
  
  if (validation.warnings.length > 0) {
    for (const warn of validation.warnings) {
      console.log(`     ⚠️  ${warn}`);
    }
  }
}

// Summary
console.log('\n--- Summary ---');
const stats = registry.getStats();
console.log(`Total: ${stats.total} profiles`);
console.log(`Valid: ${stats.valid} | Invalid: ${stats.invalid}`);
console.log(`By status:`, stats.byStatus);

if (showStats) {
  console.log(`By namespace:`, stats.byNamespace);
}

// Output manifest if requested
if (showManifest) {
  console.log('\n--- Registry Manifest ---\n');
  console.log(JSON.stringify(registry.getManifest(), null, 2));
}

// Exit code
if (hasErrors) {
  console.log('\n❌ Validation failed - schema errors found');
  process.exit(1);
} else if (strict && hasWarnings) {
  console.log('\n⚠️  Validation failed (strict mode) - warnings found');
  process.exit(1);
} else if (hasWarnings) {
  console.log('\n⚠️  Validation passed with warnings');
  process.exit(0);
} else {
  console.log('\n✅ All profiles valid');
  process.exit(0);
}
