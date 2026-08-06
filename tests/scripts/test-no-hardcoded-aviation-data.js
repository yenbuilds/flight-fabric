/**
 * Test: Prevent Hardcoded Aviation Data
 * 
 * Architecture guard to prevent brittle string matching for aircraft types,
 * airport codes, and other aviation data that should come from profiles/databases.
 * 
 * WHY THIS MATTERS:
 * - String matching breaks when variants are added (777-300ER, A320neo)
 * - Community aircraft use different naming conventions
 * - Profile system provides single source of truth (aircraftCategory, etc.)
 * - Changes require code edits instead of data updates
 * 
 * ALLOWED PATTERNS:
 * - Test fixtures and mock data
 * - Documentation and comments
 * - Data import scripts (data-sync/)
 * - User-facing display strings
 * 
 * FORBIDDEN PATTERNS:
 * - if (title.includes('777')) in business logic
 * - Hardcoded airport codes in search/routing logic
 * - Aircraft model strings in calculations
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { ROOT, listRepoSourceFiles, normalizeRepoRelative } = require('./backend-source-paths');

// ═════════════════════════════════════════════════════════════════════════════
// Configuration
// ═════════════════════════════════════════════════════════════════════════════

// Common aircraft model strings that should NOT appear in business logic
const FORBIDDEN_AIRCRAFT_STRINGS = [
  '737', '747', '757', '767', '777', '787',  // Boeing
  'a320', 'a321', 'a330', 'a340', 'a350', 'a380',  // Airbus
  'c172', 'c182', 'pa28', 'sr22',  // GA singles
  'crj', 'e-jet', 'embraer',  // Regional jets
];

// Airport codes that suggest hardcoding (should come from OurAirports data)
const FORBIDDEN_AIRPORT_CODES = [
  'ksfo', 'klax', 'kjfk', 'kewr', 'kord', 'katl',  // US majors
  'egll', 'egkk', 'lfpg', 'eddf', 'lemd',  // European majors
  'ksea', 'kden', 'kdfw', 'klas', 'kphx',  // More US
];

// Files/patterns to EXCLUDE from scanning
const EXCLUDE_PATTERNS = [
  /test\.[jt]s$/,  // Test files
  /mock.*\.[jt]s$/,  // Mock data
  /data-sync\//,  // Data import scripts
  /aircraft\/profiles\//,  // Profile data (JSON)
  /airport.*\.[jt]s$/,  // Airport search module (has legacy fallback)
  /\.test\.[jt]s$/,
  /test-.*\.[jt]s$/,
  /scripts\/test-/,  // Test scripts themselves
  /control-backends\//,  // Hardware control backends need aircraft-specific mappings
];

// Allowed contexts where hardcoded strings are OK
const ALLOWED_CONTEXTS = [
  // Comments and documentation
  /\/\/.*$/,
  /\/\*[\s\S]*?\*\//,
  
  // String literals in logs/debug (informational only)
  /Debug\.log\(/,
  /console\.(log|warn|error|debug)\(/,
  
  // Test assertions and fixtures
  /assert\./,
  /expect\(/,
  /describe\(/,
  /it\(/,
  /test\(/,
];

// ═════════════════════════════════════════════════════════════════════════════
// File Scanner
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Find all source-of-truth JS/TS files to scan.
 * @returns {string[]} Absolute file paths
 */
function findFiles() {
  const files = [
    ...listRepoSourceFiles('backend', { extensions: ['.js', '.ts'] }),
  ];

  const packagesRoot = path.join(ROOT, 'packages');
  if (!fs.existsSync(packagesRoot)) {
    return files;
  }

  for (const packageEntry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!packageEntry.isDirectory()) continue;
    const srcDir = path.join(packagesRoot, packageEntry.name, 'src');
    if (!fs.existsSync(srcDir)) continue;

    const stack = [srcDir];
    while (stack.length > 0) {
      const currentDir = stack.pop();
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
          if (entry.name.endsWith('.js') && fs.existsSync(fullPath.slice(0, -3) + '.ts')) {
            continue;
          }
          files.push(fullPath);
        }
      }
    }
  }

  return files;
}

/**
 * Check if file should be excluded
 * @param {string} filePath 
 * @returns {boolean}
 */
function shouldExclude(filePath) {
  const normalized = normalizeRepoRelative(filePath);
  return EXCLUDE_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Strip comments from code
 * @param {string} code 
 * @returns {string}
 */
function stripComments(code) {
  // Remove single-line comments
  code = code.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  code = code.replace(/\/\*[\s\S]*?\*\//g, '');
  return code;
}

/**
 * Check if line is in an allowed context (logging, etc.)
 * @param {string} line 
 * @returns {boolean}
 */
function isAllowedContext(line) {
  return ALLOWED_CONTEXTS.some(pattern => pattern.test(line));
}

// ═════════════════════════════════════════════════════════════════════════════
// Violation Detection
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Find hardcoded aircraft strings in file
 * @param {string} filePath 
 * @param {string} content 
 * @returns {Object[]} Violations
 */
function findAircraftViolations(filePath, content) {
  const violations = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    // Skip comments and allowed contexts
    if (isAllowedContext(line)) continue;
    
    // Check for forbidden aircraft strings in logic
    for (const aircraft of FORBIDDEN_AIRCRAFT_STRINGS) {
      const lowerLine = line.toLowerCase();
      const lowerAircraft = aircraft.toLowerCase();
      
      // Look for aircraft string in conditional logic or string operations
      if (lowerLine.includes(lowerAircraft)) {
        // Check if it's in a suspicious pattern
        const suspiciousPatterns = [
          `.includes('${lowerAircraft}')`,
          `.includes("${lowerAircraft}")`,
          `=== '${lowerAircraft}'`,
          `=== "${lowerAircraft}"`,
          `== '${lowerAircraft}'`,
          `== "${lowerAircraft}"`,
          `.startsWith('${lowerAircraft}')`,
          `.endsWith('${lowerAircraft}')`,
          `.indexOf('${lowerAircraft}')`,
        ];
        
        if (suspiciousPatterns.some(p => lowerLine.includes(p))) {
          violations.push({
            file: path.relative(path.join(__dirname, '..', '..'), filePath),
            line: lineNum,
            code: line.trim(),
            pattern: aircraft,
            type: 'aircraft',
            message: `Hardcoded aircraft string '${aircraft}' - use profile.aircraftCategory instead`,
          });
        }
      }
    }
  }
  
  return violations;
}

/**
 * Find hardcoded airport codes in file
 * @param {string} filePath 
 * @param {string} content 
 * @returns {Object[]} Violations
 */
function findAirportViolations(filePath, content) {
  const violations = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    // Skip comments and allowed contexts
    if (isAllowedContext(line)) continue;
    
    // Check for forbidden airport codes
    for (const airport of FORBIDDEN_AIRPORT_CODES) {
      const lowerLine = line.toLowerCase();
      const lowerAirport = airport.toLowerCase();
      
      // Look for airport code in conditional logic
      if (lowerLine.includes(lowerAirport)) {
        const suspiciousPatterns = [
          `=== '${lowerAirport}'`,
          `=== "${lowerAirport}"`,
          `== '${lowerAirport}'`,
          `== "${lowerAirport}"`,
          `.includes('${lowerAirport}')`,
        ];
        
        if (suspiciousPatterns.some(p => lowerLine.includes(p))) {
          violations.push({
            file: path.relative(path.join(__dirname, '..', '..'), filePath),
            line: lineNum,
            code: line.trim(),
            pattern: airport,
            type: 'airport',
            message: `Hardcoded airport code '${airport}' - use airport-search.js or user input`,
          });
        }
      }
    }
  }
  
  return violations;
}

// ═════════════════════════════════════════════════════════════════════════════
// Test Execution
// ═════════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Architecture Test: No Hardcoded Aviation Data');
console.log('═══════════════════════════════════════════════════════════════\n');

let totalViolations = 0;
const violationsByFile = new Map();

// Find all files to scan
const allFiles = findFiles();
const filesToScan = allFiles.filter(f => !shouldExclude(f));

console.log(`Scanning ${filesToScan.length} files...\n`);

// Scan each file
for (const filePath of filesToScan) {
  const content = fs.readFileSync(filePath, 'utf8');
  const strippedContent = stripComments(content);
  
  const aircraftViolations = findAircraftViolations(filePath, strippedContent);
  const airportViolations = findAirportViolations(filePath, strippedContent);
  
  const allViolations = [...aircraftViolations, ...airportViolations];
  
  if (allViolations.length > 0) {
    violationsByFile.set(filePath, allViolations);
    totalViolations += allViolations.length;
  }
}

// Report violations
if (totalViolations > 0) {
  console.log(`❌ Found ${totalViolations} hardcoded aviation data violations:\n`);
  
  for (const [filePath, violations] of violationsByFile.entries()) {
    const relPath = path.relative(path.join(__dirname, '..', '..'), filePath);
    console.log(`\n${relPath}:`);
    
    for (const v of violations) {
      console.log(`  Line ${v.line}: ${v.message}`);
      console.log(`    ${v.code}`);
    }
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('ARCHITECTURAL VIOLATION');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('Hardcoded aviation data creates brittle code that breaks when:');
  console.log('  - New aircraft variants are added (777-300ER, A320neo)');
  console.log('  - Community aircraft use different naming');
  console.log('  - Airport codes change or need updates\n');
  console.log('Instead, use:');
  console.log('  - profile.aircraftCategory (ICAO A/B/C/D standard)');
  console.log('  - profile.namespace for broad categories');
  console.log('  - airport-search.js for airport lookups');
  console.log('  - User input for specific locations\n');
  
  assert.fail(`Found ${totalViolations} hardcoded aviation data violations`);
}

console.log('✅ No hardcoded aviation data violations found\n');
console.log('Architecture guard: PASSED');
console.log('  - Aircraft types use profile.aircraftCategory');
console.log('  - Airport codes use airport-search.js or user input');
console.log('  - Business logic is data-driven, not string-matched\n');
