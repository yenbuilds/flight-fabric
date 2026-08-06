#!/usr/bin/env node
// test-type-drift.js
// Static-analysis guard: runtime object shapes vs JSDoc typedefs in types.js.
//
// Each test reads one or more source files that PRODUCE an object, extracts the
// actual field names / enum values with a regex, then verifies they all appear
// in the corresponding @typedef in backend/core/types.js.
//
// When to update this file:
//   - When adding a new field to a runtime object shape (add a test or extend an
//     existing one to cover the new field).
//   - When renaming a field (update the regression guard, add new positive assertion).
//   - When adding a new @typedef to types.js that has a clear single-source-of-truth
//     file (add a new test block).
//
// What this does NOT cover:
//   - Optional fields that are conditionally present and not in any single object
//     literal (those are covered by code review / manual audit).
//   - Typedefs for external inputs (provider frames vary by source).

'use strict';

const { readRepoSource } = require('./backend-source-paths');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const sharedSettings = require('../../shared/app-settings-shared.js');
const broadcastersRuntime = require(resolveBackendRuntimeFile('events', 'broadcasters.js'));

let passed = 0;
let failed = 0;

function fail(message) {
  failed++;
  console.error(`  FAIL ${message}`);
}

function pass(message) {
  passed++;
  console.log(`  PASS ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function test(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(`${name}: ${err.message}`);
  }
}

function read(relativePath) {
  return readRepoSource(relativePath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFunctionStart(src, functionName, options = {}) {
  const exportPrefix = options.allowExport === false ? '' : '(?:export\\s+)?';
  const pattern = new RegExp(`${exportPrefix}function\\s+${escapeRegExp(functionName)}\\s*\\(`);
  const match = pattern.exec(src);
  assert(match, `${functionName} not found in source`);
  return match.index;
}

function findObjectEnd(src, openIdx) {
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  assert(closeIdx !== -1, 'could not find matching closing brace');
  return closeIdx;
}

function findMethodBody(src, methodName) {
  const idx = src.indexOf(`${methodName}(`);
  assert(idx !== -1, `${methodName} method not found in source`);
  const openIdx = src.indexOf('{', idx);
  assert(openIdx !== -1, `no { found after ${methodName}`);
  const closeIdx = findObjectEnd(src, openIdx);
  return src.slice(openIdx + 1, closeIdx);
}

// Strip block and line comments while preserving line numbers.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─── types.js helpers ──────────────────────────────────────────────────────

const TYPES_SOURCE = read('backend/core/types.js');

/**
 * Return the Set of @property names documented in a specific @typedef block.
 * Handles both `@property {T} name` and `@property {T} [name]` (optional).
 */
function getTypedefProperties(typedefName) {
  const typedefRe = new RegExp(`@typedef \\{Object\\} ${typedefName}\\b`);
  const match = typedefRe.exec(TYPES_SOURCE);
  assert(match, `typedef ${typedefName} not found in types.js`);
  const start = match.index;
  const end = TYPES_SOURCE.indexOf('*/', start);
  assert(end !== -1, `typedef ${typedefName} block is not closed`);

  const block = TYPES_SOURCE.slice(start, end);
  const props = new Set();
  const re = /@property\s+\{[^}]+\}\s+\[?([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    props.add(m[1]);
  }
  return props;
}

/**
 * Return the Set of string values in a union type for a specific @property.
 * e.g. @property {'PERFECT'|'GOOD'} grade  →  Set { 'PERFECT', 'GOOD' }
 */
function getPropertyUnionValues(typedefName, propertyName) {
  const typedefRe = new RegExp(`@typedef \\{Object\\} ${typedefName}\\b`);
  const match = typedefRe.exec(TYPES_SOURCE);
  assert(match, `typedef ${typedefName} not found in types.js`);
  const start = match.index;
  const end = TYPES_SOURCE.indexOf('*/', start);
  const block = TYPES_SOURCE.slice(start, end);

  const propRe = new RegExp(`@property\\s+\\{([^}]+)\\}\\s+\\[?${propertyName}\\b`);
  const propMatch = propRe.exec(block);
  assert(propMatch, `@property ${propertyName} not found in ${typedefName}`);

  const values = new Set();
  const valueRe = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = valueRe.exec(propMatch[1])) !== null) {
    values.add(m[1]);
  }
  return values;
}

function getValueAtPath(root, path) {
  return path.split('.').reduce((value, part) => (
    value && typeof value === 'object' ? value[part] : undefined
  ), root);
}

function getNormalizedAppSettingsFixture() {
  return sharedSettings.normalizeAppSettings({}, {
    defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
  });
}

function collectLeafPaths(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      paths.push(...collectLeafPaths(child, childPrefix));
    } else {
      paths.push(childPrefix);
    }
  }
  return paths;
}

function compareSets(actual, expected, { actualName, expectedName }) {
  const missing = [...expected].filter((field) => !actual.has(field));
  const extra = [...actual].filter((field) => !expected.has(field));
  assert(missing.length === 0, `${actualName} missing fields from ${expectedName}: ${missing.join(', ')}`);
  assert(extra.length === 0, `${actualName} has fields not in ${expectedName}: ${extra.join(', ')}`);
}

function collapseSettingsEditorPath(path) {
  if (path.startsWith('debrief.stabilityCriteria.')) return 'debrief.stabilityCriteria';
  return path;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// LandingEvent
// ---------------------------------------------------------------------------

test('LandingEvent.grade union exactly matches runtime grade strings in landing.js', () => {
  const src = stripComments(read('backend/landing/landing.js'));

  const runtimeGrades = new Set();
  const re = /grade:\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) runtimeGrades.add(m[1]);
  assert(runtimeGrades.size > 0, 'could not extract grade strings from landing.js');

  const documented = getPropertyUnionValues('LandingEvent', 'grade');

  const missing = [...runtimeGrades].filter(g => !documented.has(g));
  const extra   = [...documented].filter(g => !runtimeGrades.has(g));
  assert(missing.length === 0, `runtime grades missing from types.js: ${missing.join(', ')}`);
  assert(extra.length   === 0, `types.js grades not in landing.js: ${extra.join(', ')}`);
});

test('LandingEvent documents vs_fpm (not the bare "vs" field)', () => {
  const props = getTypedefProperties('LandingEvent');
  assert(props.has('vs_fpm'), 'LandingEvent must document vs_fpm');
  assert(!props.has('vs'),    'LandingEvent must not use bare "vs" (runtime field is vs_fpm)');
});

// ---------------------------------------------------------------------------
// FlapState
// ---------------------------------------------------------------------------

test('FlapState.source union exactly matches runtime source strings in flaps.js', () => {
  const src = stripComments(read('backend/aircraft/flaps.js'));

  const runtimeSources = new Set();
  const re = /source:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) runtimeSources.add(m[1]);
  assert(runtimeSources.size > 0, 'could not extract source strings from flaps.js');

  const documented = getPropertyUnionValues('FlapState', 'source');

  const missing = [...runtimeSources].filter(s => !documented.has(s));
  const extra   = [...documented].filter(s => !runtimeSources.has(s));
  assert(missing.length === 0, `FlapState sources in flaps.js missing from types.js: ${missing.join(', ')}`);
  assert(extra.length   === 0, `FlapState sources in types.js not in flaps.js: ${extra.join(', ')}`);
});

// ---------------------------------------------------------------------------
// StabilityBreakdown
// ---------------------------------------------------------------------------

test('StabilityBreakdown documents all _ok fields produced by stability-runner.js', () => {
  const src = stripComments(read('backend/stability/stability-runner.js'));

  const runtimeFields = new Set();
  const re = /\b(\w+_ok)\s*:/g;
  let m;
  while ((m = re.exec(src)) !== null) runtimeFields.add(m[1]);
  assert(runtimeFields.size > 0, 'could not extract _ok fields from stability-runner.js');

  const documented = getTypedefProperties('StabilityBreakdown');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  assert(
    missing.length === 0,
    `StabilityBreakdown fields in stability-runner not in types.js: ${missing.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// GearState
// ---------------------------------------------------------------------------

test('GearState documents all fields returned by decodeGearState in helpers.js', () => {
  const src = stripComments(read('backend/utils/helpers.js'));
  const afterFn = src.slice(findFunctionStart(src, 'decodeGearState'));
  const runtimeFields = extractObjectFields(afterFn, 'return {');
  assert(runtimeFields.size > 0, 'could not extract decodeGearState property names from helpers.js');

  const documented = getTypedefProperties('GearState');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  assert(
    missing.length === 0,
    `GearState fields from decodeGearState not in types.js: ${missing.join(', ')}`,
  );
});

test('GearState documents broadcast-time fields added by computeGearBroadcastState', () => {
  const src = stripComments(read('backend/core/simbridge-core-utils.ts'));
  const afterFn = src.slice(findFunctionStart(src, 'computeGearBroadcastState'));
  const runtimeFields = extractObjectFields(afterFn, 'payload: {');

  const documented = getTypedefProperties('GearState');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  assert(
    missing.length === 0,
    `GearState broadcast fields in computeGearBroadcastState not in types.js: ${missing.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// SpoilerState
// ---------------------------------------------------------------------------

test('SpoilerState documents available and _source suppression fields', () => {
  const props = getTypedefProperties('SpoilerState');
  assert(props.has('available'), 'SpoilerState must document available');
  assert(props.has('_source'),   'SpoilerState must document _source');
});

// ---------------------------------------------------------------------------
// LightState
// ---------------------------------------------------------------------------

test('LightState documents all SDK-path fields (available, turnoff, panel, recog, cabin)', () => {
  const props = getTypedefProperties('LightState');
  for (const field of ['available', 'turnoff', 'panel', 'recog', 'cabin']) {
    assert(props.has(field), `LightState must document ${field}`);
  }
});

// ---------------------------------------------------------------------------
// TickFrame regression guards
// ---------------------------------------------------------------------------

test('TickFrame documents heading (not hdg) and lat/lon (not gps)', () => {
  const props = getTypedefProperties('TickFrame');
  assert(props.has('heading'), 'TickFrame must document heading');
  assert(!props.has('hdg'),    'TickFrame must not use hdg (runtime field is heading)');
  assert(!props.has('gps'),    'TickFrame must not document gps (does not exist; position is lat/lon)');
});

// ---------------------------------------------------------------------------
// Broadcaster shape guards
// Bidirectional: all broadcast fields must be in typedef AND all typedef
// fields must be in the broadcast object. This ensures the typedef is an
// exact mirror of the runtime shape — no phantom fields, no undocumented fields.
// ---------------------------------------------------------------------------

/**
 * Extract field names from a broadcast object starting at `anchor` in `src`.
 * Uses brace-counting to find the matching close brace.
 * Handles both multi-line (key: value,\n) and single-line ({key: val, ...})
 * object literals, and shorthand properties (key, without colon).
 * Excludes the `type` field (wire discriminant, not a semantic payload field).
 * @param {string} src - Stripped source text
 * @param {string} anchor - Text that appears at/before the opening brace
 * @returns {Set<string>} Set of field names
 */
function extractObjectFields(src, anchor, excludeFields = []) {
  const idx = src.indexOf(anchor);
  assert(idx !== -1, `anchor "${anchor}" not found in source`);
  const fromAnchor = src.slice(idx);
  const openIdx = fromAnchor.indexOf('{');
  assert(openIdx !== -1, `no { found after anchor "${anchor}"`);
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < fromAnchor.length; i++) {
    if (fromAnchor[i] === '{') depth++;
    else if (fromAnchor[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
  }
  assert(closeIdx !== -1, `could not find closing } for anchor "${anchor}"`);
  const body = fromAnchor.slice(openIdx + 1, closeIdx);
  const fields = new Set();
  const isMultiLine = body.includes('\n');
  // Multi-line: match standard (key:) and shorthand (key,) properties at line starts.
  // Single-line: match only key: patterns (shorthand in single-line is uncommon here).
  const re = isMultiLine ? /^\s+(\w+)\s*[,:]/gm : /(?:^|,)\s*(\w+)\s*(?::|(?=\s*(?:,|$)))/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!excludeFields.includes(m[1])) fields.add(m[1]);
  }
  return fields;
}

function extractBroadcastFields(src, anchor) {
  return extractObjectFields(src, anchor, ['type']);
}

function extractTopLevelObjectFields(src, anchor, excludeFields = []) {
  const idx = src.indexOf(anchor);
  assert(idx !== -1, `anchor "${anchor}" not found in source`);
  const fromAnchor = src.slice(idx);
  const openIdx = fromAnchor.indexOf('{');
  assert(openIdx !== -1, `no { found after anchor "${anchor}"`);
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < fromAnchor.length; i++) {
    if (fromAnchor[i] === '{') depth++;
    else if (fromAnchor[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
  }
  assert(closeIdx !== -1, `could not find closing } for anchor "${anchor}"`);
  const body = fromAnchor.slice(openIdx + 1, closeIdx);

  const fields = new Set();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    if (!/[A-Za-z0-9_]/.test(body[i])) { i++; continue; }

    let name = '';
    while (i < body.length && /[A-Za-z0-9_]/.test(body[i])) {
      name += body[i++];
    }
    while (i < body.length && /\s/.test(body[i])) i++;

    if (i < body.length && body[i] === ':') {
      if (!excludeFields.includes(name)) fields.add(name);
      i++; // skip colon
      let nesting = 0;
      while (i < body.length) {
        const ch = body[i];
        if (ch === '{' || ch === '[' || ch === '(') nesting++;
        else if (ch === '}' || ch === ']' || ch === ')') nesting = Math.max(0, nesting - 1);
        else if (ch === ',' && nesting === 0) { i++; break; }
        i++;
      }
      continue;
    }

    if (!excludeFields.includes(name)) fields.add(name);
  }
  return fields;
}

const BROADCASTERS_SRC = stripComments(read('backend/events/broadcasters.js'));
const SIMBRIDGE_CORE_SRC = stripComments(read('backend/core/simbridge-core.js'));

function getRuntimePayloadFields(payload) {
  assert(payload && typeof payload === 'object', 'expected runtime payload object');
  return new Set(Object.keys(payload).filter((field) => field !== 'type'));
}

/**
 * Scan `src` for broadcast({ ... }) calls and return the field set from the
 * first call whose body contains `msgTypeRef`. Returns null if not found.
 * Handles multi-line and single-line objects, and shorthand properties.
 * Excludes the `type` field.
 */
function getBroadcastFieldsByType(src, msgTypeRef) {
  let searchFrom = 0;
  while (true) {
    const idx = src.indexOf('broadcast({', searchFrom);
    if (idx === -1) break;
    const fromBc = src.slice(idx);
    const openIdx = fromBc.indexOf('{');
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < fromBc.length; i++) {
      if (fromBc[i] === '{') depth++;
      else if (fromBc[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) break;
    const body = fromBc.slice(openIdx + 1, closeIdx);
    if (body.includes(msgTypeRef)) {
      const fields = new Set();
      const isMultiLine = body.includes('\n');
      const re = isMultiLine ? /^\s+(\w+)\s*[,:]/gm : /\b(\w+)\s*:/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        if (m[1] !== 'type') fields.add(m[1]);
      }
      return fields;
    }
    searchFrom = idx + 11;
  }
  return null;
}

function getObjectFieldsForContainingText(src, opener, matchText, excludeFields = ['type']) {
  let searchFrom = 0;
  while (true) {
    const idx = src.indexOf(opener, searchFrom);
    if (idx === -1) break;
    const fromMatch = src.slice(idx);
    const openIdx = fromMatch.indexOf('{');
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < fromMatch.length; i++) {
      if (fromMatch[i] === '{') depth++;
      else if (fromMatch[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) break;
    const body = fromMatch.slice(openIdx + 1, closeIdx);
    if (body.includes(matchText)) {
      const fields = new Set();
      const isMultiLine = body.includes('\n');
      const re = isMultiLine ? /^\s+(\w+)\s*[,:]/gm : /(?:^|,)\s*(\w+)\s*(?::|(?=\s*(?:,|$)))/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        if (!excludeFields.includes(m[1])) fields.add(m[1]);
      }
      return fields;
    }
    searchFrom = idx + opener.length;
  }
  return null;
}

function getUnionObjectFieldsForContainingText(src, opener, matchText, excludeFields = ['type']) {
  const union = new Set();
  let found = false;
  let searchFrom = 0;
  while (true) {
    const idx = src.indexOf(opener, searchFrom);
    if (idx === -1) break;
    const fromMatch = src.slice(idx);
    const openIdx = fromMatch.indexOf('{');
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < fromMatch.length; i++) {
      if (fromMatch[i] === '{') depth++;
      else if (fromMatch[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) break;
    const body = fromMatch.slice(openIdx + 1, closeIdx);
    if (body.includes(matchText)) {
      found = true;
      const isMultiLine = body.includes('\n');
      const re = isMultiLine ? /^\s+(\w+)\s*[,:]/gm : /(?:^|,)\s*(\w+)\s*(?::|(?=\s*(?:,|$)))/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        if (!excludeFields.includes(m[1])) union.add(m[1]);
      }
    }
    searchFrom = idx + opener.length;
  }
  return found ? union : null;
}

test('AutopilotState fields exactly match sendAutopilot broadcast object (bidirectional)', () => {
  const runtimeFields = getRuntimePayloadFields(
    broadcastersRuntime.buildAutopilotBroadcastPayload(
      {
        apMaster: true,
        apFdActive: true,
        athrArmed: true,
        athrActive: true,
        apHdgHold: true,
        apNavHold: true,
        apLnavHold: true,
        apLocHold: true,
        apAltHold: true,
        apVsHold: true,
        apVnavHold: true,
        apLvlChgHold: true,
        apExpedHold: true,
        apApprHold: true,
        apSpeedHold: true,
        apHdgTargetDeg: 180,
        apAltTargetFt: 3000,
        apVsTargetFpm: -700,
        apSpeedTargetKts: 150,
        apMachTarget: 0.78,
      },
      { apReliable: true, athrReliable: true, reason: 'test' },
    ),
  );
  const documented = getTypedefProperties('AutopilotState');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `broadcast fields not in AutopilotState typedef: ${missing.join(', ')}`);
  assert(extra.length   === 0, `AutopilotState typedef fields not in broadcast: ${extra.join(', ')}`);
});

test('AttitudeState fields exactly match sendAttitude broadcast object (bidirectional)', () => {
  const runtimeFields = getRuntimePayloadFields(
    broadcastersRuntime.buildAttitudeBroadcastPayload({
      valid: true,
      pitchDeg: 2,
      bankDeg: -1,
      pitchRad: 0.034,
      bankRad: -0.017,
      pitchSource: 'simconnect',
      bankSource: 'simconnect',
      pitchRaw: 0.034,
      bankRaw: -0.017,
      pitchDegPrimary: 2,
      bankDegPrimary: -1,
      pitchModePrimary: 'primary',
      bankModePrimary: 'primary',
    }),
  );
  const documented = getTypedefProperties('AttitudeState');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `broadcast fields not in AttitudeState typedef: ${missing.join(', ')}`);
  assert(extra.length   === 0, `AttitudeState typedef fields not in broadcast: ${extra.join(', ')}`);
});

test('AltitudeData fields exactly match MSG.ALTITUDE broadcast in sendBasicStreams (bidirectional)', () => {
  const runtimeFields = getRuntimePayloadFields(
    broadcastersRuntime.buildAltitudeBroadcastPayload({
      vsFeetPerMin: -700,
      iasKnots: 145,
      gsKnots: 150,
      alt_msl_ft: 3000,
      raFeet: 1200,
      pressureAltFt: 3200,
      xwind: 15,
      lights: {},
      hdgMag: 180,
      hdgTrue: 185,
    }),
  );
  const documented = getTypedefProperties('AltitudeData');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `MSG.ALTITUDE broadcast fields not in AltitudeData typedef: ${missing.join(', ')}`);
  assert(extra.length   === 0, `AltitudeData typedef fields not in MSG.ALTITUDE broadcast: ${extra.join(', ')}`);
});

test('EnvironmentData fields exactly match sendEnvironment broadcast object (bidirectional)', () => {
  const runtimeFields = getRuntimePayloadFields(
    broadcastersRuntime.buildEnvironmentBroadcastPayload({
      cabinAltFt: 7200,
      cabinAltRateFpm: 300,
      cabinAltTargetFt: 6500,
      oatC: 7,
    }),
  );
  const documented = getTypedefProperties('EnvironmentData');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `broadcast fields not in EnvironmentData typedef: ${missing.join(', ')}`);
  assert(extra.length   === 0, `EnvironmentData typedef fields not in broadcast: ${extra.join(', ')}`);
});

test('SimState fields exactly match publishSimState const object in simbridge-core.js (bidirectional)', () => {
  const runtimeFields = extractBroadcastFields(SIMBRIDGE_CORE_SRC, 'const simState = {');
  const documented = getTypedefProperties('SimState');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `simState object fields not in SimState typedef: ${missing.join(', ')}`);
  assert(extra.length   === 0, `SimState typedef fields not in simState object: ${extra.join(', ')}`);
});

test('UltimateStabilityScoreData fields exactly match MSG.ULTIMATE_STABILITY_SCORE broadcast (bidirectional)', () => {
  // Use getBroadcastFieldsByType to avoid matching the Debug.log object that follows the broadcast.
  const runtimeFields = getBroadcastFieldsByType(SIMBRIDGE_CORE_SRC, 'MSG.ULTIMATE_STABILITY_SCORE');
  const documented = getTypedefProperties('UltimateStabilityScoreData');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `ULTIMATE_STABILITY_SCORE broadcast fields not in typedef: ${missing.join(', ')}`);
  assert(extra.length   === 0, `UltimateStabilityScoreData typedef fields not in broadcast: ${extra.join(', ')}`);
});

test('VreSamplingData fields exactly match MSG.VRE_SAMPLING broadcast (bidirectional)', () => {
  const runtimeFields = getBroadcastFieldsByType(SIMBRIDGE_CORE_SRC, 'MSG.VRE_SAMPLING');
  const documented = getTypedefProperties('VreSamplingData');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `VRE_SAMPLING broadcast fields not in typedef: ${missing.join(', ')}`);
  assert(extra.length   === 0, `VreSamplingData typedef fields not in broadcast: ${extra.join(', ')}`);
});

test('FlightViolationPayload fields exactly match MSG.FLIGHT_VIOLATION payload object (bidirectional)', () => {
  const violationSrc = stripComments(read('backend/flight-violations/flight-violation-runner.js'));
  // The violation broadcast uses broadcast(payload) not broadcast({...}), so scan const payload = {
  // blocks to find the one containing MSG.FLIGHT_VIOLATION.
  let runtimeFields = null;
  let searchFrom = 0;
  while (true) {
    const idx = violationSrc.indexOf('const payload = {', searchFrom);
    if (idx === -1) break;
    const fromPayload = violationSrc.slice(idx);
    const openIdx = fromPayload.indexOf('{');
    let depth = 0, closeIdx = -1;
    for (let i = openIdx; i < fromPayload.length; i++) {
      if (fromPayload[i] === '{') depth++;
      else if (fromPayload[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) break;
    const body = fromPayload.slice(openIdx + 1, closeIdx);
    if (body.includes('MSG.FLIGHT_VIOLATION')) {
      runtimeFields = new Set();
      const re = /^\s+(\w+)\s*[,:]/gm;
      let m;
      while ((m = re.exec(body)) !== null) { if (m[1] !== 'type') runtimeFields.add(m[1]); }
      break;
    }
    searchFrom = idx + 17;
  }
  assert(runtimeFields !== null, 'could not find const payload = { MSG.FLIGHT_VIOLATION } in flight-violation-runner.js');
  const documented = getTypedefProperties('FlightViolationPayload');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `FLIGHT_VIOLATION payload fields not in typedef: ${missing.join(', ')}`);
  assert(extra.length   === 0, `FlightViolationPayload typedef fields not in payload: ${extra.join(', ')}`);
});

test('FlightViolationPayload.severity union exactly matches rule severity literals in flight-violation-runner.js', () => {
  const violationSrc = read('backend/flight-violations/flight-violation-runner.js');
  const rulesSeverities = new Set();
  const re = /severity:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(violationSrc)) !== null) rulesSeverities.add(m[1]);
  assert(rulesSeverities.size > 0, 'could not extract severity values from flight-violation-runner.js');
  const documented = getPropertyUnionValues('FlightViolationPayload', 'severity');
  const missing = [...rulesSeverities].filter(s => !documented.has(s));
  const extra   = [...documented].filter(s => !rulesSeverities.has(s));
  assert(missing.length === 0, `severity values in source not in FlightViolationPayload union: ${missing.join(', ')}`);
  assert(extra.length   === 0, `FlightViolationPayload severity union has phantom values: ${extra.join(', ')}`);
});

test('FlightViolationPayload.event union exactly matches event literals in flight-violation-runner.js', () => {
  const violationSrc = read('backend/flight-violations/flight-violation-runner.js');
  const eventValues = new Set();
  const re = /event:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(violationSrc)) !== null) eventValues.add(m[1]);
  assert(eventValues.size > 0, 'could not extract event values from flight-violation-runner.js');
  const documented = getPropertyUnionValues('FlightViolationPayload', 'event');
  const missing = [...eventValues].filter(v => !documented.has(v));
  const extra   = [...documented].filter(v => !eventValues.has(v));
  assert(missing.length === 0, `event values in source not in FlightViolationPayload union: ${missing.join(', ')}`);
  assert(extra.length   === 0, `FlightViolationPayload event union has phantom values: ${extra.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Logbook / update / airport-search contracts
// ---------------------------------------------------------------------------

test('LogbookEntry documents all fields produced by extractEntry()', () => {
  const src = stripComments(read('backend/landing/flight-logbook.js'));
  const fnIdx = findFunctionStart(src, 'extractEntry');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'return {');
  const documented = getTypedefProperties('LogbookEntry');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  assert(missing.length === 0, `extractEntry fields not in LogbookEntry typedef: ${missing.join(', ')}`);
});

test('LogbookEntry documents all fields produced by parseLandingsFromContent()', () => {
  const src = stripComments(read('backend/landing/flight-logbook.js'));
  const fnIdx = findFunctionStart(src, 'parseLandingsFromContent');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'landings.push({');
  const documented = getTypedefProperties('LogbookEntry');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  assert(missing.length === 0, `parseLandingsFromContent fields not in LogbookEntry typedef: ${missing.join(', ')}`);
});

test('LogbookStats fields exactly match computeStatsFromEntries() return object (bidirectional)', () => {
  const src = stripComments(read('backend/landing/flight-logbook.js'));
  const fnIdx = findFunctionStart(src, 'computeStatsFromEntries');
  const afterFn = src.slice(fnIdx);
  const accumulatorIdx = afterFn.indexOf('const aircraftSet');
  assert(accumulatorIdx !== -1, 'computeStatsFromEntries accumulator block not found in flight-logbook.js');
  const afterAccumulatorInit = afterFn.slice(accumulatorIdx);
  const runtimeFields = extractObjectFields(afterAccumulatorInit, 'return {');
  const documented = getTypedefProperties('LogbookStats');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `computeStatsFromEntries fields not in LogbookStats typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `LogbookStats typedef fields not in computeStatsFromEntries return: ${extra.join(', ')}`);
});

test('LogbookMessage fields exactly match requestLogbook response object (bidirectional)', () => {
  const src = stripComments(read('backend/core/client-message-handler.js'));
  const fnIdx = src.indexOf("case 'requestLogbook': {");
  assert(fnIdx !== -1, 'requestLogbook handler not found in client-message-handler.js');
  const afterCase = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterCase, 'ws.send(JSON.stringify({', ['type']);
  const documented = getTypedefProperties('LogbookMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `requestLogbook payload fields not in LogbookMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `LogbookMessage typedef fields not in requestLogbook payload: ${extra.join(', ')}`);
});

test('UpdateAvailableMessage fields exactly match update-checker payload (bidirectional)', () => {
  const src = stripComments(read('backend/core/update-checker.js'));
  const runtimeFields = extractObjectFields(src, 'lastUpdateMsg = {', ['type']);
  const documented = getTypedefProperties('UpdateAvailableMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `update-checker payload fields not in UpdateAvailableMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `UpdateAvailableMessage typedef fields not in update-checker payload: ${extra.join(', ')}`);
});

test('AirportSearchResult fields exactly match airport-search suitable-airport result object (bidirectional)', () => {
  const src = stripComments(read('backend/landing/airport-search.js'));
  const fnIdx = findFunctionStart(src, 'findSuitableAirports');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'const results');
  const documented = getTypedefProperties('AirportSearchResult');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `findSuitableAirports result fields not in AirportSearchResult typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `AirportSearchResult typedef fields not in findSuitableAirports result: ${extra.join(', ')}`);
});

test('AirportSearchStats fields exactly match airport-search getStats() return object (bidirectional)', () => {
  const src = stripComments(read('backend/landing/airport-search.js'));
  const fnIdx = findFunctionStart(src, 'getStats');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'return {');
  const documented = getTypedefProperties('AirportSearchStats');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `airport-search getStats fields not in AirportSearchStats typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `AirportSearchStats typedef fields not in airport-search getStats return: ${extra.join(', ')}`);
});

test('AirportDistanceResult fields exactly match airport-search getDistanceToAirport() return object (bidirectional)', () => {
  const src = stripComments(read('backend/landing/airport-search.js'));
  const fnIdx = findFunctionStart(src, 'getDistanceToAirport');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'return {');
  const documented = getTypedefProperties('AirportDistanceResult');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `getDistanceToAirport fields not in AirportDistanceResult typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `AirportDistanceResult typedef fields not in getDistanceToAirport return: ${extra.join(', ')}`);
});

test('FlightTimeEstimate fields exactly match airport-search estimateFlightTime() return object (bidirectional)', () => {
  const src = stripComments(read('backend/landing/airport-search.js'));
  const fnIdx = findFunctionStart(src, 'estimateFlightTime');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'return {');
  const documented = getTypedefProperties('FlightTimeEstimate');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `estimateFlightTime fields not in FlightTimeEstimate typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `FlightTimeEstimate typedef fields not in estimateFlightTime return: ${extra.join(', ')}`);
});

// ---------------------------------------------------------------------------
// App settings / relay / remaining broadcaster contracts
// ---------------------------------------------------------------------------

test('AppStorageSummary fields exactly match buildStorageSummary() return object (bidirectional)', () => {
  const src = stripComments(read('backend/core/client-message-handler.js'));
  const fnIdx = findFunctionStart(src, 'buildStorageSummary');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'return {');
  const documented = getTypedefProperties('AppStorageSummary');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `buildStorageSummary fields not in AppStorageSummary typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `AppStorageSummary typedef fields not in buildStorageSummary return: ${extra.join(', ')}`);
});

test('AppSettings section fields exactly match buildAppSettingsMessage() nested settings objects', () => {
  const handlerSrc = stripComments(read('backend/core/client-message-handler.js'));
  const handlerFnIdx = findFunctionStart(handlerSrc, 'buildAppSettingsMessage');
  const handlerAfterFn = handlerSrc.slice(handlerFnIdx);
  assert(handlerAfterFn.includes('settings: normalizedSettings'), 'buildAppSettingsMessage should use normalizedSettings');

  const sharedSrc = stripComments(read('shared/app-settings-shared.js'));
  const normalizeFnIdx = findFunctionStart(sharedSrc, 'normalizeAppSettings', { allowExport: false });
  const normalizeAfterFn = sharedSrc.slice(normalizeFnIdx);

  const sectionExpectations = [
    ['AppSettings', 'return {'],
    ['AppSettingsAircraft', 'aircraft: {'],
    ['AppSettingsSimulator', 'simulator: {'],
    ['AppSettingsNetwork', 'network: {'],
    ['AppSettingsCabinAnnouncements', 'cabinAnnouncements: {'],
  ];

  for (const [typedefName, anchor] of sectionExpectations) {
    const runtimeFields = extractTopLevelObjectFields(normalizeAfterFn, anchor);
    const documented = getTypedefProperties(typedefName);
    const missing = [...runtimeFields].filter(f => !documented.has(f));
    const extra   = [...documented].filter(f => !runtimeFields.has(f));
    assert(missing.length === 0, `${typedefName} fields missing from types.js: ${missing.join(', ')}`);
    assert(extra.length === 0, `${typedefName} typedef fields not present in buildAppSettingsMessage: ${extra.join(', ')}`);
  }
});

test('Backend DEFAULT_SETTINGS covers every normalized app-settings field', () => {
  const normalized = getNormalizedAppSettingsFixture();
  const source = stripComments(read('backend/core/user-settings.ts'));
  const defaultTopFields = extractTopLevelObjectFields(source, 'const DEFAULT_SETTINGS: SettingsObject = {', [
    '_version',
    '_description',
  ]);

  for (const section of Object.keys(normalized)) {
    assert(defaultTopFields.has(section), `DEFAULT_SETTINGS missing normalized section: ${section}`);
  }

  const sectionAnchors = {
    aircraft: 'aircraft: {',
    simulator: 'simulator: {',
    network: 'network: {',
    recording: 'recording: {',
    cabinAnnouncements: 'cabinAnnouncements: {',
    debrief: 'debrief: {',
  };

  for (const [section, anchor] of Object.entries(sectionAnchors)) {
    const expected = new Set(Object.keys(normalized[section] || {}));
    const documented = extractTopLevelObjectFields(source, anchor);
    const missing = [...expected].filter((field) => !documented.has(field));
    assert(missing.length === 0, `DEFAULT_SETTINGS.${section} missing normalized fields: ${missing.join(', ')}`);
  }

  const expectedStabilityFields = new Set(Object.keys(normalized.debrief.stabilityCriteria || {}));
  const defaultStabilityFields = extractTopLevelObjectFields(source, 'stabilityCriteria: {');
  const missingStability = [...expectedStabilityFields].filter((field) => !defaultStabilityFields.has(field));
  assert(missingStability.length === 0, `DEFAULT_SETTINGS.debrief.stabilityCriteria missing fields: ${missingStability.join(', ')}`);
});

test('Settings editor mappings cover every normalized app-settings path', () => {
  const normalized = getNormalizedAppSettingsFixture();
  const expectedPaths = new Set(collectLeafPaths(normalized).map(collapseSettingsEditorPath));
  const bindings = [
    ['aircraft.profile', 'aircraftProfile'],
    ['simulator.protocol', 'simconnectProtocol'],
    ['network.wsPort', 'wsPort', {
      applyNeedle: 'this.wsPort = String(next.network.wsPort)',
    }],
    ['network.httpPort', 'httpPort', {
      applyNeedle: 'this.httpPort = String(next.network.httpPort)',
    }],
    ['network.remoteAccess', 'remoteAccess'],
    ['network.remoteAircraftControl', 'remoteAircraftControl'],
    ['network.updateChecks', 'updateChecks'],
    ['network.onlineMapTiles', 'onlineMapTiles'],
    ['recording.autoStart', 'recordingAutoStart'],
    ['cabinAnnouncements.enabled', 'cabinAnnouncementsEnabled'],
    ['cabinAnnouncements.style', 'cabinAnnouncementsStyle'],
    ['cabinAnnouncements.startupGraceMs', 'cabinAnnouncementsStartupGraceMs', {
      applyNeedle: 'this.cabinAnnouncementsStartupGraceMs = String(next.cabinAnnouncements.startupGraceMs)',
    }],
    ['debrief.stabilityCriteria', 'stabilityCriteria', {
      applyNeedle: 'this.stabilityCriteria = { ...next.debrief.stabilityCriteria }',
      serializeNeedle: 'stabilityCriteria: this.stabilityCriteria',
    }],
  ];

  compareSets(new Set(bindings.map(([path]) => path)), expectedPaths, {
    actualName: 'settings editor binding map',
    expectedName: 'normalizeAppSettings leaf paths',
  });

  const source = stripComments(read('frontend/src/vue/stores/settings-editor.js'));
  const stateFields = extractTopLevelObjectFields(source, 'state: () => ({');
  const applyBody = findMethodBody(source, 'applySettings');
  const serializeBody = findMethodBody(source, 'serializeSettings');

  for (const [settingsPath, stateName, options = {}] of bindings) {
    const runtimeValue = getValueAtPath(normalized, settingsPath);
    assert(runtimeValue !== undefined, `normalized settings path not found: ${settingsPath}`);
    assert(stateFields.has(stateName), `settings editor state missing ${stateName} for ${settingsPath}`);

    const defaultApplyNeedle = `this.${stateName} = next.${settingsPath}`;
    const applyNeedle = options.applyNeedle || defaultApplyNeedle;
    assert(
      applyBody.includes(applyNeedle),
      `applySettings missing ${settingsPath} -> ${stateName} mapping (${applyNeedle})`,
    );

    const serializeNeedle = options.serializeNeedle || `this.${stateName}`;
    assert(
      serializeBody.includes(serializeNeedle),
      `serializeSettings missing ${stateName} -> ${settingsPath} mapping (${serializeNeedle})`,
    );
  }
});

test('AppSettingsMessage fields exactly match buildAppSettingsMessage() return object (bidirectional)', () => {
  const src = stripComments(read('backend/core/client-message-handler.js'));
  const fnIdx = findFunctionStart(src, 'buildAppSettingsMessage');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractTopLevelObjectFields(afterFn, 'return {', ['type']);
  const documented = getTypedefProperties('AppSettingsMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `buildAppSettingsMessage fields not in AppSettingsMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `AppSettingsMessage typedef fields not in buildAppSettingsMessage return: ${extra.join(', ')}`);
});

test('AppSettingsSavedMessage documents all MSG.APP_SETTINGS_SAVED payload fields', () => {
  const src = stripComments(read('backend/core/client-message-handler.js'));
  const runtimeFields = getUnionObjectFieldsForContainingText(src, 'ws.send(JSON.stringify({', 'MSG.APP_SETTINGS_SAVED');
  assert(runtimeFields, 'could not find APP_SETTINGS_SAVED payloads in client-message-handler.js');
  const documented = getTypedefProperties('AppSettingsSavedMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `APP_SETTINGS_SAVED payload fields not in AppSettingsSavedMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `AppSettingsSavedMessage typedef fields not produced by APP_SETTINGS_SAVED payloads: ${extra.join(', ')}`);
});

test('SignalReliabilityMap fields exactly match DEFAULT_SIGNAL_RELIABILITY keys (bidirectional)', () => {
  const src = stripComments(read('backend/core/simbridge-core-utils.js'));
  const runtimeFields = extractObjectFields(src, 'const DEFAULT_SIGNAL_RELIABILITY = Object.freeze({');
  const documented = getTypedefProperties('SignalReliabilityMap');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `DEFAULT_SIGNAL_RELIABILITY keys not in SignalReliabilityMap typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `SignalReliabilityMap typedef fields not in DEFAULT_SIGNAL_RELIABILITY: ${extra.join(', ')}`);
});

test('SignalReliabilityMessage fields exactly match buildSignalReliabilityPayload() return object (bidirectional)', () => {
  const src = stripComments(read('backend/core/simbridge-core-utils.js'));
  const fnIdx = findFunctionStart(src, 'buildSignalReliabilityPayload');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'return {', ['type']);
  const documented = getTypedefProperties('SignalReliabilityMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `buildSignalReliabilityPayload fields not in SignalReliabilityMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `SignalReliabilityMessage typedef fields not in buildSignalReliabilityPayload return: ${extra.join(', ')}`);
});

test('DataSourcePrimary documents telemetry-provider fallback primary fields', () => {
  const indexSrc = stripComments(read('backend/telemetry-provider/index.js'));
  const fnIdx = findFunctionStart(indexSrc, 'getDataSourceInfo');
  const afterFn = indexSrc.slice(fnIdx);
  const fallbackFields = extractObjectFields(afterFn, 'const primary = providerPrimary || {');
  const providerSrc = stripComments(read('backend/telemetry-provider/simconnect-telemetry-provider.js'));
  const rustIdx = providerSrc.indexOf('_buildRustSimvarSource() {');
  assert(rustIdx !== -1, '_buildRustSimvarSource not found in simconnect-telemetry-provider.js');
  const rustFields = extractTopLevelObjectFields(providerSrc.slice(rustIdx), 'return {');
  const runtimeFields = new Set([...fallbackFields, ...rustFields]);
  const documented = getTypedefProperties('DataSourcePrimary');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  assert(missing.length === 0, `getDataSourceInfo primary fields not in DataSourcePrimary typedef: ${missing.join(', ')}`);
});

test('DataSourcePreviewItem fields exactly match LVAR buildPreviewItems() output (bidirectional)', () => {
  const src = stripComments(read('backend/telemetry-provider/simconnect-telemetry-provider.js'));
  const runtimeFields = extractObjectFields(src, 'items.push({');
  const documented = getTypedefProperties('DataSourcePreviewItem');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `buildPreviewItems fields not in DataSourcePreviewItem typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `DataSourcePreviewItem typedef fields not in buildPreviewItems output: ${extra.join(', ')}`);
});

test('DataSourceDebugWatch fields exactly match LVAR debugWatch object (bidirectional)', () => {
  const src = stripComments(read('backend/telemetry-provider/simconnect-telemetry-provider.js'));
  const fnIdx = src.indexOf('_buildLvarSecondarySource() {');
  assert(fnIdx !== -1, '_buildLvarSecondarySource not found in simconnect-telemetry-provider.js');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'debugWatch: {');
  const documented = getTypedefProperties('DataSourceDebugWatch');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `debugWatch fields not in DataSourceDebugWatch typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `DataSourceDebugWatch typedef fields not in debugWatch object: ${extra.join(', ')}`);
});

test('SecondaryDataSource documents all runtime fields from source descriptors', () => {
  const src = stripComments(read('backend/telemetry-provider/simconnect-telemetry-provider.js'));
  const lvarIdx = src.indexOf('_buildLvarSecondarySource() {');
  const sdkIdx = src.indexOf('_buildSdkSecondarySource() {');
  assert(lvarIdx !== -1, '_buildLvarSecondarySource not found in simconnect-telemetry-provider.js');
  assert(sdkIdx !== -1, '_buildSdkSecondarySource not found in simconnect-telemetry-provider.js');
  const lvarFields = extractTopLevelObjectFields(src.slice(lvarIdx), 'return {');
  const sdkFields = extractTopLevelObjectFields(src.slice(sdkIdx), 'return {');
  const runtimeFields = new Set([...lvarFields, ...sdkFields]);
  const documented = getTypedefProperties('SecondaryDataSource');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  assert(missing.length === 0, `secondary source fields not in SecondaryDataSource typedef: ${missing.join(', ')}`);
});

test('DataSourcesMessage fields exactly match reconnect DATA_SOURCES payload (bidirectional)', () => {
  const src = stripComments(read('backend/telemetry-provider/index.js'));
  const fnIdx = findFunctionStart(src, 'getDataSourceInfo');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractTopLevelObjectFields(afterFn, 'return {');
  const documented = getTypedefProperties('DataSourcesMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `DATA_SOURCES payload fields not in DataSourcesMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `DataSourcesMessage typedef fields not in DATA_SOURCES payload: ${extra.join(', ')}`);
});

test('FlightRecordingMessage documents all runtime fields from FLIGHT_RECORDING payloads', () => {
  const simbridgeSrc = stripComments(read('backend/core/simbridge-core.js'));
  const clientSrc = stripComments(read('backend/core/client-message-handler.js'));
  const simbridgeFields = getUnionObjectFieldsForContainingText(simbridgeSrc, 'broadcast({', 'MSG.FLIGHT_RECORDING') || new Set();
  const reconnectFields = getUnionObjectFieldsForContainingText(simbridgeSrc, 'ws.send(JSON.stringify({', 'MSG.FLIGHT_RECORDING') || new Set();
  const requestStateFields = getUnionObjectFieldsForContainingText(clientSrc, 'ws.send(JSON.stringify({', 'MSG.FLIGHT_RECORDING') || new Set();
  const runtimeFields = new Set([...simbridgeFields, ...reconnectFields, ...requestStateFields]);
  const documented = getTypedefProperties('FlightRecordingMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `FLIGHT_RECORDING payload fields not in FlightRecordingMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `FlightRecordingMessage typedef fields not produced by FLIGHT_RECORDING payloads: ${extra.join(', ')}`);
});

test('TargetLocation fields exactly match sanitizeTarget() return object (bidirectional)', () => {
  const src = stripComments(read('backend/core/destination-target-store.js'));
  const fnIdx = findFunctionStart(src, 'sanitizeTarget');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractObjectFields(afterFn, 'return {');
  const documented = getTypedefProperties('TargetLocation');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `sanitizeTarget fields not in TargetLocation typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `TargetLocation typedef fields not in sanitizeTarget return: ${extra.join(', ')}`);
});

test('DestinationTargetMessage documents all DESTINATION_TARGET payload fields', () => {
  const simbridgeSrc = stripComments(read('backend/core/simbridge-core.js'));
  const clientSrc = stripComments(read('backend/core/client-message-handler.js'));
  const simbridgeFields = getUnionObjectFieldsForContainingText(simbridgeSrc, 'ws.send(JSON.stringify({', 'MSG.DESTINATION_TARGET') || new Set();
  const clientFields = getUnionObjectFieldsForContainingText(clientSrc, 'ws.send(JSON.stringify({', 'MSG.DESTINATION_TARGET') || new Set();
  const broadcastFields = getUnionObjectFieldsForContainingText(clientSrc, 'broadcast({', 'MSG.DESTINATION_TARGET') || new Set();
  const runtimeFields = new Set([...simbridgeFields, ...clientFields, ...broadcastFields]);
  const documented = getTypedefProperties('DestinationTargetMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `DESTINATION_TARGET payload fields not in DestinationTargetMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `DestinationTargetMessage typedef fields not produced by DESTINATION_TARGET payloads: ${extra.join(', ')}`);
});

test('OriginTargetMessage documents all ORIGIN_TARGET payload fields', () => {
  const simbridgeSrc = stripComments(read('backend/core/simbridge-core.js'));
  const clientSrc = stripComments(read('backend/core/client-message-handler.js'));
  const simbridgeFields = getUnionObjectFieldsForContainingText(simbridgeSrc, 'ws.send(JSON.stringify({', 'MSG.ORIGIN_TARGET') || new Set();
  const clientFields = getUnionObjectFieldsForContainingText(clientSrc, 'ws.send(JSON.stringify({', 'MSG.ORIGIN_TARGET') || new Set();
  const broadcastFields = getUnionObjectFieldsForContainingText(clientSrc, 'broadcast({', 'MSG.ORIGIN_TARGET') || new Set();
  const runtimeFields = new Set([...simbridgeFields, ...clientFields, ...broadcastFields]);
  const documented = getTypedefProperties('OriginTargetMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `ORIGIN_TARGET payload fields not in OriginTargetMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `OriginTargetMessage typedef fields not produced by ORIGIN_TARGET payloads: ${extra.join(', ')}`);
});

test('AirportLookupResultMessage documents all requestAirportLookup payload fields', () => {
  const documented = getTypedefProperties('AirportLookupResultMessage');
  const runtimeFields = new Set(['requestId', 'icao', 'success', 'error', 'name', 'lat', 'lon', 'runwayCount']);
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `AirportLookupResultMessage missing payload fields: ${missing.join(', ')}`);
  assert(extra.length === 0, `AirportLookupResultMessage typedef has phantom fields: ${extra.join(', ')}`);
});

test('FuelUnitMessage fields exactly match fuel-unit relay payload (bidirectional)', () => {
  const src = stripComments(read('backend/core/client-message-handler.js'));
  const runtimeFields = extractObjectFields(src, 'const fuelUnitMsg = {', ['type']);
  const documented = getTypedefProperties('FuelUnitMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `fuelUnit relay fields not in FuelUnitMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `FuelUnitMessage typedef fields not in fuelUnit relay payload: ${extra.join(', ')}`);
});

test('ShowBrandingMessage fields exactly match branding relay payload (bidirectional)', () => {
  const src = stripComments(read('backend/core/client-message-handler.js'));
  const runtimeFields = extractObjectFields(src, 'const brandingMsg = {', ['type']);
  const documented = getTypedefProperties('ShowBrandingMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `showBranding relay fields not in ShowBrandingMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `ShowBrandingMessage typedef fields not in showBranding relay payload: ${extra.join(', ')}`);
});

test('FuelMessage fields exactly match sendFuel broadcast object (bidirectional)', () => {
  const runtimeFields = getRuntimePayloadFields(
    broadcastersRuntime.buildFuelBroadcastPayload({ totalGal: 420.4, totalPct: 62.8 }),
  );
  const documented = getTypedefProperties('FuelMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `sendFuel fields not in FuelMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `FuelMessage typedef fields not in sendFuel payload: ${extra.join(', ')}`);
});

test('PositionMessage fields exactly match sendPosition broadcast object (bidirectional)', () => {
  const runtimeFields = getRuntimePayloadFields(
    broadcastersRuntime.buildPositionBroadcastPayload({ lat: 47.45, lon: -122.31, hdg: 165 }),
  );
  const documented = getTypedefProperties('PositionMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `sendPosition fields not in PositionMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `PositionMessage typedef fields not in sendPosition payload: ${extra.join(', ')}`);
});

test('SurfaceState fields exactly match normalized surface object shape (bidirectional)', () => {
  const src = stripComments(read('backend/telemetry-provider/simconnect-telemetry-provider.js'));
  const fnIdx = src.indexOf('_decodeSurfaceType(type, wow, onAnyRunway) {');
  assert(fnIdx !== -1, '_decodeSurfaceType not found in simconnect-telemetry-provider.js');
  const afterFn = src.slice(fnIdx);
  const runtimeFields = extractTopLevelObjectFields(afterFn, 'return {');
  const documented = getTypedefProperties('SurfaceState');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `normalized surface fields not in SurfaceState typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `SurfaceState typedef fields not in normalized surface object: ${extra.join(', ')}`);
});

test('SurfaceMessage fields exactly match sendSurface broadcast object (bidirectional)', () => {
  const runtimeFields = getRuntimePayloadFields(
    broadcastersRuntime.buildSurfaceBroadcastPayload({
      raw: 1,
      name: 'Asphalt',
      class: 'hard',
      runwayLike: true,
      onGround: true,
      valid: true,
    }),
  );
  const documented = getTypedefProperties('SurfaceMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `sendSurface fields not in SurfaceMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `SurfaceMessage typedef fields not in sendSurface payload: ${extra.join(', ')}`);
});

test('ControlsMessage fields exactly match sendControls broadcast object (bidirectional)', () => {
  const runtimeFields = getRuntimePayloadFields(
    broadcastersRuntime.buildControlsBroadcastPayload({ yokeX: 12, yokeY: -4, rudderPedalPct: 6 }),
  );
  const documented = getTypedefProperties('ControlsMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `sendControls fields not in ControlsMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `ControlsMessage typedef fields not in sendControls payload: ${extra.join(', ')}`);
});

test('EnginesData documents all runtime fields from engine payload builders', () => {
  const providerSrc = stripComments(read('backend/telemetry-provider/simconnect-telemetry-provider.js'));
  const coreUtilsSrc = stripComments(read('backend/core/simbridge-core-utils.ts'));
  const engineHelperSrc = coreUtilsSrc.slice(findFunctionStart(coreUtilsSrc, 'buildEnginesBroadcastData'));
  const providerFields = extractObjectFields(providerSrc, 'return {');
  const fallbackFields = extractObjectFields(engineHelperSrc, 'return {');
  const runtimeFields = new Set([...providerFields].filter((f) => (
    ['count', 'source', 'eng1', 'eng2', 'eng3', 'eng4', 'eng1Text', 'eng2Text', 'eng3Text', 'eng4Text'].includes(f)
  )));
  for (const field of fallbackFields) {
    if (['count', 'source', 'eng1', 'eng2', 'eng3', 'eng4', 'eng1Text', 'eng2Text', 'eng3Text', 'eng4Text'].includes(field)) {
      runtimeFields.add(field);
    }
  }
  const documented = getTypedefProperties('EnginesData');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `engine data fields not in EnginesData typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `EnginesData typedef fields not produced by engine payload builders: ${extra.join(', ')}`);
});

test('EnginesMessage fields exactly match MSG.ENGINES broadcast wrapper (bidirectional)', () => {
  const coreSrc = stripComments(read('backend/core/simbridge-core.js'));
  const runtimeFields = getObjectFieldsForContainingText(coreSrc, 'broadcast({', 'MSG.ENGINES');
  assert(runtimeFields, 'could not find MSG.ENGINES broadcast in simbridge-core.js');
  const documented = getTypedefProperties('EnginesMessage');
  const missing = [...runtimeFields].filter(f => !documented.has(f));
  const extra   = [...documented].filter(f => !runtimeFields.has(f));
  assert(missing.length === 0, `MSG.ENGINES wrapper fields not in EnginesMessage typedef: ${missing.join(', ')}`);
  assert(extra.length === 0, `EnginesMessage typedef fields not in MSG.ENGINES wrapper: ${extra.join(', ')}`);
});

// ---------------------------------------------------------------------------

console.log(`\nType drift tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
