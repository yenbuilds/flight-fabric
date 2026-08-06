'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, listRepoSourceFiles } = require('./backend-source-paths');

const CORE_DIR = path.join(ROOT, 'backend', 'core');
const VIOLATION_RULES_PATH = path.join(ROOT, 'shared', 'violation-rules.js');
const VIOLATION_RULE_TYPES_PATH = path.join(ROOT, 'shared', 'violation-rules.d.ts');
const { VIOLATION_RULE } = require(VIOLATION_RULES_PATH);
const FLIGHT_PHASES_PATH = path.join(ROOT, 'shared', 'flight-phases.js');
const FLIGHT_PHASE_TYPES_PATH = path.join(ROOT, 'shared', 'flight-phases.d.ts');
const { PHASES, PUBLISHED_PHASES, ALL_PHASES } = require(FLIGHT_PHASES_PATH);

function relPath(...parts) {
  return path.join(...parts).replace(/\\/g, '/');
}

const ALLOW_DATE_NOW = new Set([
  relPath('backend', 'core', 'time-source.ts'),
  relPath('backend', 'core', 'time-source.js'),
]);

const ALLOW_PROCESS_ENV = new Set([
  relPath('backend', 'core', 'config.ts'),
  relPath('backend', 'core', 'config.js'),
  relPath('backend', 'core', 'user-settings.ts'),
  relPath('backend', 'core', 'user-settings.js'),
  relPath('backend', 'core', 'config.test.ts'),
  relPath('backend', 'core', 'config.test.js'),
  relPath('backend', 'core', 'debug.test.ts'),
  relPath('backend', 'core', 'debug.test.js'),
  relPath('backend', 'core', 'client-message-handler.aircraft-control.test.ts'),
  relPath('backend', 'core', 'client-message-handler.aircraft-control.test.js'),
]);

const CANONICAL_DOMAIN_TYPES = {
  PhaseMap: {
    owner: relPath('shared', 'flight-phases.d.ts'),
    allow: [relPath('frontend', 'flight-phases.d.ts')],
    message: 'Use PhaseMap from shared/flight-phases.d.ts instead of redeclaring the flight phase shape.',
  },
  PhaseValue: {
    owner: relPath('shared', 'flight-phases.d.ts'),
    allow: [relPath('frontend', 'flight-phases.d.ts')],
    message: 'Use PhaseValue from shared/flight-phases.d.ts instead of deriving a local flight phase union.',
  },
  FlightTypeMap: {
    owner: relPath('backend', 'lifecycle', 'flight-types.ts'),
    message: 'Use FlightTypeMap from backend/lifecycle/flight-types.ts instead of redeclaring flight classification labels.',
  },
  FlightTypeValue: {
    owner: relPath('backend', 'lifecycle', 'flight-types.ts'),
    message: 'Use FlightTypeValue from backend/lifecycle/flight-types.ts instead of deriving a local flight classification union.',
  },
};

const CANONICAL_STRING_LITERALS = [
  {
    name: 'timeline-violation-rule-ids',
    owner: relPath('shared', 'violation-rules.js'),
    allow: [
      relPath('shared', 'violation-rules.d.ts'),
      relPath('scripts', 'test-architecture-guards.js'),
    ],
    values: Object.values(VIOLATION_RULE),
    message: 'Use VIOLATION_RULE from shared/violation-rules.js instead of copying violation rule-id strings.',
  },
];

const CANONICAL_REGISTRY_PATTERNS = [
  {
    rule: 'no-local-flight-phases-registry',
    pattern: /\b(?:const\s+PHASES|PHASES)\s*[:=]\s*Object\.freeze\s*\(/,
    allow: [
      relPath('shared', 'flight-phases.js'),
      relPath('frontend', 'flight-phases.js'),
    ],
    message: 'Use shared/flight-phases.js instead of declaring a local PHASES registry.',
  },
];

function listSourceFiles(relativeDir) {
  return listRepoSourceFiles(relativeDir, {
    extensions: ['.js', '.ts'],
  });
}

function normalizeRel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function findViolations(filePath, pattern) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.endsWith('*/')) {
      continue;
    }
    if (pattern.test(line)) {
      violations.push({ line: i + 1, code: line.trim() });
    }
  }
  return violations;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDeclaredLiteralMap(filePath, exportName) {
  const source = fs.readFileSync(filePath, 'utf8');
  const blockPattern = new RegExp(`export\\s+const\\s+${escapeRegex(exportName)}\\s*:\\s*\\{([\\s\\S]*?)\\}\\s*;`);
  const block = source.match(blockPattern);
  if (!block) return null;

  const values = new Map();
  const duplicates = new Set();
  const pattern = /readonly\s+([A-Z][A-Z0-9_]*):\s*'([^']+)'\s*;/g;
  let match;
  while ((match = pattern.exec(block[1])) !== null) {
    if (values.has(match[1])) duplicates.add(match[1]);
    values.set(match[1], match[2]);
  }
  return { values, duplicates };
}

function parseDeclaredLiteralTuple(filePath, exportName) {
  const source = fs.readFileSync(filePath, 'utf8');
  const tuplePattern = new RegExp(`export\\s+const\\s+${escapeRegex(exportName)}\\s*:\\s*readonly\\s*\\[([\\s\\S]*?)\\]\\s*;`);
  const tuple = source.match(tuplePattern);
  if (!tuple) return null;

  const values = [];
  const valuePattern = /'([^']+)'/g;
  let match;
  while ((match = valuePattern.exec(tuple[1])) !== null) values.push(match[1]);
  return values;
}

function pushRegistryFailure(failures, rule, file, code, message) {
  failures.push({ rule, file, line: 1, code, message });
}

function checkLiteralMapParity({ runtime, declarationPath, exportName, rule, failures }) {
  const declarationFile = normalizeRel(declarationPath);
  const parsed = parseDeclaredLiteralMap(declarationPath, exportName);
  if (!parsed) {
    pushRegistryFailure(
      failures,
      rule,
      declarationFile,
      `${exportName} declaration was not found`,
      `Declare ${exportName} as a readonly literal map matching its runtime registry.`,
    );
    return;
  }

  for (const duplicate of parsed.duplicates) {
    pushRegistryFailure(
      failures,
      rule,
      declarationFile,
      `${duplicate} is declared more than once`,
      `Keep ${exportName} declaration keys unique.`,
    );
  }

  for (const [key, value] of Object.entries(runtime)) {
    const declaredValue = parsed.values.get(key);
    if (declaredValue === value) continue;
    pushRegistryFailure(
      failures,
      rule,
      declarationFile,
      declaredValue === undefined
        ? `${key} is missing`
        : `${key} declares '${declaredValue}' instead of '${value}'`,
      `Keep ${exportName} exactly aligned with its runtime registry.`,
    );
  }

  for (const [key, value] of parsed.values) {
    if (Object.prototype.hasOwnProperty.call(runtime, key)) continue;
    pushRegistryFailure(
      failures,
      rule,
      declarationFile,
      `${key}: '${value}' has no runtime entry`,
      `Remove ${exportName} declarations that are not present at runtime.`,
    );
  }
}

function checkLiteralTupleParity({ runtime, declarationPath, exportName, rule, failures }) {
  const declarationFile = normalizeRel(declarationPath);
  const declared = parseDeclaredLiteralTuple(declarationPath, exportName);
  if (!declared) {
    pushRegistryFailure(
      failures,
      rule,
      declarationFile,
      `${exportName} declaration was not found`,
      `Declare ${exportName} as a readonly literal tuple matching runtime order.`,
    );
    return;
  }

  const maxLength = Math.max(runtime.length, declared.length);
  for (let index = 0; index < maxLength; index++) {
    if (runtime[index] === declared[index]) continue;
    pushRegistryFailure(
      failures,
      rule,
      declarationFile,
      `${exportName}[${index}] is '${declared[index] ?? '<missing>'}' instead of '${runtime[index] ?? '<none>'}'`,
      `Keep ${exportName} declaration values and order aligned with runtime.`,
    );
    break;
  }
}

function checkUniqueRuntimeValues(runtime, registryName, runtimePath, failures) {
  const values = Array.isArray(runtime) ? runtime : Object.values(runtime);
  if (new Set(values).size === values.length) return;
  pushRegistryFailure(
    failures,
    'duplicate-registry-value',
    normalizeRel(runtimePath),
    `${registryName} contains duplicate string values`,
    `Every ${registryName} value must be unique.`,
  );
}

function checkSharedRegistryParity(failures) {
  checkLiteralMapParity({
    runtime: VIOLATION_RULE,
    declarationPath: VIOLATION_RULE_TYPES_PATH,
    exportName: 'VIOLATION_RULE',
    rule: 'violation-rule-type-drift',
    failures,
  });
  checkUniqueRuntimeValues(VIOLATION_RULE, 'VIOLATION_RULE', VIOLATION_RULES_PATH, failures);

  checkLiteralMapParity({
    runtime: PHASES,
    declarationPath: FLIGHT_PHASE_TYPES_PATH,
    exportName: 'PHASES',
    rule: 'flight-phase-type-drift',
    failures,
  });
  checkLiteralTupleParity({
    runtime: PUBLISHED_PHASES,
    declarationPath: FLIGHT_PHASE_TYPES_PATH,
    exportName: 'PUBLISHED_PHASES',
    rule: 'flight-phase-type-drift',
    failures,
  });
  checkLiteralTupleParity({
    runtime: ALL_PHASES,
    declarationPath: FLIGHT_PHASE_TYPES_PATH,
    exportName: 'ALL_PHASES',
    rule: 'flight-phase-type-drift',
    failures,
  });
  checkUniqueRuntimeValues(PHASES, 'PHASES', FLIGHT_PHASES_PATH, failures);
  checkUniqueRuntimeValues(PUBLISHED_PHASES, 'PUBLISHED_PHASES', FLIGHT_PHASES_PATH, failures);
  checkUniqueRuntimeValues(ALL_PHASES, 'ALL_PHASES', FLIGHT_PHASES_PATH, failures);

  const expectedAllPhases = [PHASES.UNKNOWN, ...PUBLISHED_PHASES];
  if (JSON.stringify(ALL_PHASES) !== JSON.stringify(expectedAllPhases)) {
    pushRegistryFailure(
      failures,
      'flight-phase-runtime-contract',
      normalizeRel(FLIGHT_PHASES_PATH),
      'ALL_PHASES must equal [PHASES.UNKNOWN, ...PUBLISHED_PHASES]',
      'Keep the complete phase list derived from the internal and published phase lists.',
    );
  }
  if (PUBLISHED_PHASES.includes(PHASES.UNKNOWN)) {
    pushRegistryFailure(
      failures,
      'flight-phase-runtime-contract',
      normalizeRel(FLIGHT_PHASES_PATH),
      'PUBLISHED_PHASES includes PHASES.UNKNOWN',
      'UNKNOWN is internal and must not be published.',
    );
  }
  const phaseValues = new Set(Object.values(PHASES));
  for (const phase of PUBLISHED_PHASES) {
    if (phaseValues.has(phase)) continue;
    pushRegistryFailure(
      failures,
      'flight-phase-runtime-contract',
      normalizeRel(FLIGHT_PHASES_PATH),
      `PUBLISHED_PHASES contains unknown value '${phase}'`,
      'Every published phase must come from PHASES.',
    );
  }
}

function main() {
  if (!fs.existsSync(CORE_DIR)) {
    console.error('[arch-guard] backend/core not found');
    process.exit(1);
  }

  const files = listSourceFiles('backend/core');
  const backendFiles = listRepoSourceFiles('backend', {
    extensions: ['.js', '.ts'],
    exclude: (rel) => rel === 'backend/types/generated' || rel.startsWith('backend/types/generated/'),
  });
  const guardSourceFiles = [
    ...backendFiles,
    ...listRepoSourceFiles('frontend', {
      extensions: ['.js', '.ts'],
      exclude: (rel) => rel === 'frontend/node_modules' || rel.startsWith('frontend/node_modules/'),
    }),
    ...listRepoSourceFiles('shared', { extensions: ['.js', '.ts', '.d.ts'] }),
    ...listRepoSourceFiles('packages', {
      extensions: ['.js', '.ts', '.d.ts'],
      exclude: (rel) => rel.includes('/node_modules/') || rel.includes('/dist/'),
    }),
    ...listRepoSourceFiles('scripts', { extensions: ['.js', '.ts'] }),
  ];
  const failures = [];
  checkSharedRegistryParity(failures);

  for (const file of files) {
    const rel = normalizeRel(file);

    if (!ALLOW_DATE_NOW.has(rel)) {
      const hits = findViolations(file, /\bDate\.now\s*\(/);
      for (const hit of hits) {
        failures.push({
          rule: 'no-direct-date-now',
          file: rel,
          line: hit.line,
          code: hit.code,
          message: 'Use backend/core/time-source.ts instead of direct Date.now().',
        });
      }
    }

    if (!ALLOW_PROCESS_ENV.has(rel)) {
      const hits = findViolations(file, /\bprocess\.env\b/);
      for (const hit of hits) {
        failures.push({
          rule: 'no-direct-process-env',
          file: rel,
          line: hit.line,
          code: hit.code,
          message: 'Read env through backend/core/config.ts (or approved settings module).',
        });
      }
    }
  }

  for (const file of guardSourceFiles) {
    const rel = normalizeRel(file);
    for (const [typeName, rule] of Object.entries(CANONICAL_DOMAIN_TYPES)) {
      if (rel === rule.owner) continue;
      if (rule.allow && rule.allow.includes(rel)) continue;
      const hits = findViolations(file, new RegExp(`\\btype\\s+${typeName}\\s*=`));
      for (const hit of hits) {
        failures.push({
          rule: 'no-local-domain-type',
          file: rel,
          line: hit.line,
          code: hit.code,
          message: rule.message,
        });
      }
    }
  }

  for (const registry of CANONICAL_STRING_LITERALS) {
    for (const file of guardSourceFiles) {
      const rel = normalizeRel(file);
      if (rel === registry.owner) continue;
      if (registry.allow && registry.allow.includes(rel)) continue;

      for (const value of registry.values) {
        const pattern = new RegExp(`(['"\`])${escapeRegex(value)}\\1`);
        const hits = findViolations(file, pattern);
        for (const hit of hits) {
          failures.push({
            rule: 'no-copied-domain-literal',
            file: rel,
            line: hit.line,
            code: hit.code,
            message: registry.message,
          });
        }
      }
    }
  }

  for (const registry of CANONICAL_REGISTRY_PATTERNS) {
    for (const file of guardSourceFiles) {
      const rel = normalizeRel(file);
      if (registry.allow.includes(rel)) continue;
      const hits = findViolations(file, registry.pattern);
      for (const hit of hits) {
        failures.push({
          rule: registry.rule,
          file: rel,
          line: hit.line,
          code: hit.code,
          message: registry.message,
        });
      }
    }
  }

  if (failures.length > 0) {
    console.error('\n=== Architecture Guard Failures ===');
    for (const f of failures) {
      console.error(`- [${f.rule}] ${f.file}:${f.line}`);
      console.error(`  ${f.message}`);
      console.error(`  ${f.code}`);
    }
    console.error(`\nTotal violations: ${failures.length}`);
    process.exit(1);
  }

  console.log('Architecture guard: PASS (backend/core and shared-domain ownership)');
}

main();
