#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

const ROOT = path.resolve(__dirname, '..', '..');
const BUNDLED_PROFILES_DIR = path.join(ROOT, 'backend', 'aircraft', 'profiles', 'bundled');
const SDK_CONNECTOR_DIRS = [
  path.join(ROOT, 'backend', 'telemetry-provider', 'sdk-connectors'),
  path.join(ROOT, 'backend', 'telemetry-provider', 'rust-simconnect-sidecar', 'src', 'sdk', 'connectors'),
];

const MUTABLE_OR_UNSUPPORTED_CLAIMS = [
  /most[- ]downloaded/i,
  /most[- ]popular/i,
  /latest release/i,
  /current release/i,
];

const UNSUPPORTED_LVAR_PATTERNS = [
  /^MD11_LTS_EXT_/i,
];

const PROFILE_PROBE_ONLY_RE = /_probeOnly|\bprobe[- ]?only\b/i;
const UNSAFE_ACTIVE_LVAR_COMMENT = /\b(assumed|may work|not confirmed|needs in-sim verification)\b/i;
const TRUSTED_SOURCE_TYPES = new Set([
  'official-sdk',
  'official-docs',
  'forum',
  'wiki',
  'community',
  'manual-testing',
]);
const SOURCE_TYPES_REQUIRING_NOTES = new Set([
  'forum',
  'wiki',
  'community',
  'manual-testing',
]);
const ACTIVE_MAPPING_SOURCE_TYPES = new Set([
  'official-sdk',
  'official-docs',
  'forum',
]);
const ACTIVE_MAPPING_AUTHORITIES = new Set([
  'simulator-vendor',
  'aircraft-vendor',
]);
const FBW_A380X_THROTTLE_MAPPING_LVARS = [
  'IDLE',
  'CLIMB',
  'FLEXMCT',
  'TOGA',
].flatMap((detent) => (
  Array.from({ length: 4 }, (_, offset) => offset + 1).flatMap((index) => [
    `A32NX_THROTTLE_MAPPING_${detent}_LOW:${index}`,
    `A32NX_THROTTLE_MAPPING_${detent}_HIGH:${index}`,
  ])
));
const EXACT_STANDARD_EVENT_CONTRACTS = new Map([
  ['fbw-a380x', {
    profileKey: 'bundled/msfs/fbw-a380x',
    verification: 'untested',
    vendorEvents: [
      'A32NX.FCU_AP_1_PUSH',
      ...FBW_A380X_THROTTLE_MAPPING_LVARS,
    ],
    events: [
      'AUTO_THROTTLE_DISCONNECT',
      'AUTO_THROTTLE_ARM',
      'AP_LOC_HOLD',
      'AP_APR_HOLD',
      'AP_SPD_VAR_SET',
      'HEADING_BUG_SET',
      'AP_ALT_VAR_SET_ENGLISH',
      'STROBES_SET',
      'BEACON_LIGHTS_SET',
      'NAV_LIGHTS_SET',
      'LOGO_LIGHTS_SET',
      'WING_LIGHTS_SET',
      'LANDING_LIGHTS_SET',
      'TAXI_LIGHTS_SET',
      'GEAR_UP',
      'GEAR_DOWN',
      'FLAPS_DECR',
      'FLAPS_INCR',
      'PARKING_BRAKE_SET',
      'SPOILERS_ARM_OFF',
      'SPOILERS_ARM_ON',
      'SPOILERS_SET',
    ],
  }],
  ['inibuilds-a330', {
    profileKey: 'bundled/msfs/inibuilds-a330',
    verification: 'untested',
    events: [
      'AUTOPILOT_OFF',
      'AUTOPILOT_ON',
      'TOGGLE_FLIGHT_DIRECTOR',
      'AUTO_THROTTLE_ARM',
      'AP_AIRSPEED_OFF',
      'AP_AIRSPEED_ON',
      'AP_HDG_HOLD_OFF',
      'AP_HDG_HOLD_ON',
      'AP_ALT_HOLD_OFF',
      'AP_ALT_HOLD_ON',
      'AP_VS_OFF',
      'AP_VS_ON',
      'AP_NAV1_HOLD_OFF',
      'AP_NAV1_HOLD_ON',
      'AP_APR_HOLD_OFF',
      'AP_APR_HOLD_ON',
      'FLIGHT_LEVEL_CHANGE_OFF',
      'FLIGHT_LEVEL_CHANGE_ON',
      'AP_SPD_VAR_SET',
      'HEADING_BUG_SET',
      'AP_ALT_VAR_SET_ENGLISH',
      'AP_VS_VAR_SET_ENGLISH',
      'STROBES_SET',
      'BEACON_LIGHTS_SET',
      'NAV_LIGHTS_SET',
      'LOGO_LIGHTS_SET',
      'WING_LIGHTS_SET',
      'LANDING_LIGHTS_SET',
      'TAXI_LIGHTS_SET',
      'GEAR_UP',
      'GEAR_DOWN',
      'FLAPS_DECR',
      'FLAPS_INCR',
      'PARKING_BRAKE_SET',
      'SPOILERS_ARM_OFF',
      'SPOILERS_ARM_ON',
      'SPOILERS_SET',
    ],
  }],
  ['microsoft-inibuilds-a32x', {
    profileKeys: [
      'bundled/msfs/inibuilds-a320neo-v2',
      'bundled/msfs/inibuilds-a321lr',
    ],
    verification: 'untested',
    events: [
      'AUTOPILOT_OFF',
      'AUTOPILOT_ON',
      'TOGGLE_FLIGHT_DIRECTOR',
      'AUTO_THROTTLE_ARM',
      'AP_AIRSPEED_OFF',
      'AP_AIRSPEED_ON',
      'AP_HDG_HOLD_OFF',
      'AP_HDG_HOLD_ON',
      'AP_ALT_HOLD_OFF',
      'AP_ALT_HOLD_ON',
      'AP_VS_OFF',
      'AP_VS_ON',
      'AP_NAV1_HOLD_OFF',
      'AP_NAV1_HOLD_ON',
      'AP_APR_HOLD_OFF',
      'AP_APR_HOLD_ON',
      'AP_SPD_VAR_SET',
      'HEADING_BUG_SET',
      'AP_ALT_VAR_SET_ENGLISH',
      'AP_VS_VAR_SET_ENGLISH',
      'STROBES_SET',
      'BEACON_LIGHTS_SET',
      'NAV_LIGHTS_SET',
      'LOGO_LIGHTS_SET',
      'WING_LIGHTS_SET',
      'LANDING_LIGHTS_SET',
      'TAXI_LIGHTS_SET',
      'GEAR_UP',
      'GEAR_DOWN',
      'FLAPS_DECR',
      'FLAPS_INCR',
      'PARKING_BRAKE_SET',
    ],
  }],
  ['microsoft-737-max-8', {
    profileKey: 'bundled/msfs/microsoft-737-max-8',
    verification: 'untested',
    events: [
      'AUTOPILOT_OFF',
      'AUTOPILOT_ON',
      'TOGGLE_FLIGHT_DIRECTOR',
      'AUTO_THROTTLE_ARM',
      'AP_AIRSPEED_OFF',
      'AP_AIRSPEED_ON',
      'AP_HDG_HOLD_OFF',
      'AP_HDG_HOLD_ON',
      'AP_ALT_HOLD_OFF',
      'AP_ALT_HOLD_ON',
      'AP_VS_OFF',
      'AP_VS_ON',
      'AP_NAV1_HOLD_OFF',
      'AP_NAV1_HOLD_ON',
      'AP_APR_HOLD_OFF',
      'AP_APR_HOLD_ON',
      'FLIGHT_LEVEL_CHANGE_OFF',
      'FLIGHT_LEVEL_CHANGE_ON',
      'AP_SPD_VAR_SET',
      'HEADING_BUG_SET',
      'AP_ALT_VAR_SET_ENGLISH',
      'AP_VS_VAR_SET_ENGLISH',
      'STROBES_SET',
      'BEACON_LIGHTS_SET',
      'NAV_LIGHTS_SET',
      'LOGO_LIGHTS_SET',
      'WING_LIGHTS_SET',
      'LANDING_LIGHTS_SET',
      'TAXI_LIGHTS_SET',
      'GEAR_UP',
      'GEAR_DOWN',
      'FLAPS_DECR',
      'FLAPS_INCR',
      'PARKING_BRAKE_SET',
    ],
  }],
]);
const EXPLANATION_RE = /\b(suppress|suppressed|unreliable|not authoritative|n\/a|fallback|rather than (showing|guessing)|intentionally|requires)\b/i;

function listFiles(rootDir, predicate) {
  const files = [];
  function walk(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (!predicate || predicate(absolutePath)) {
        files.push(absolutePath);
      }
    }
  }
  if (fs.existsSync(rootDir)) walk(rootDir);
  return files;
}

function parseProfileDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function collectDateFields(profile) {
  return [
    ['createdAt', profile.createdAt],
    ['updatedAt', profile.updatedAt],
    ['meta.updated', profile.meta?.updated],
  ].filter(([, value]) => value);
}

function getActiveMappingSourceText(profile) {
  return JSON.stringify(
    (profile.provenance?.sources || []).filter((source) => source?.supportsActiveMappings === true),
  );
}

function getProfileEvidenceText(profile) {
  return [
    JSON.stringify(profile.integration || {}),
    JSON.stringify({
      sources: (profile.provenance?.sources || [])
        .filter((source) => source?.supportsActiveMappings === true),
      verification: profile.provenance?.verification || {},
    }),
    JSON.stringify(profile.meta || {}),
    JSON.stringify(profile.requirements || {}),
  ].join('\n');
}

function wildcardTokenToRegExp(token) {
  const escaped = token
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[A-Za-z0-9_:.]*');
  return new RegExp(`^${escaped}$`, 'i');
}

function extractWildcardTokens(text) {
  const tokens = new Set();
  const matches = text.match(/[A-Za-z][A-Za-z0-9_:.]*(?:\*[A-Za-z0-9_:.]*)+/g) || [];
  for (const match of matches) {
    tokens.add(match);
  }
  return [...tokens];
}

function sourceCoversName(sourceText, name) {
  if (!name) return false;
  if (sourceText.includes(name)) return true;
  return extractWildcardTokens(sourceText).some((token) => wildcardTokenToRegExp(token).test(name));
}

function extractLvarNames(value) {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (/^\(?A:/i.test(trimmed)) return [];

  const lvarMatches = [...trimmed.matchAll(/\(?L:([^,\)]+)/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (lvarMatches.length > 0) return lvarMatches;

  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
    return [trimmed];
  }

  return [];
}

function collectActiveLvars(node, pathParts = [], entries = []) {
  if (typeof node === 'string') {
    for (const name of extractLvarNames(node)) {
      entries.push({ name, path: pathParts.join('.') || '<root>' });
    }
    return entries;
  }

  if (Array.isArray(node) || !node || typeof node !== 'object') {
    return entries;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('_')) continue;
    collectActiveLvars(value, [...pathParts, key], entries);
  }
  return entries;
}

function normalizeActiveLvarIdentity(name) {
  const text = String(name || '').trim();
  const lvarMatch = text.match(/\(?\s*L:([^,)\s]+)/i);
  return (lvarMatch?.[1] || text.replace(/^L:/i, '')).toLowerCase();
}

function hasValueSemanticsEvidence(profileEvidenceText, sourceText, lvarName, requiredPattern) {
  const text = [profileEvidenceText, sourceText].join('\n');
  if (!sourceCoversName(text, lvarName)) return false;
  return requiredPattern.test(text);
}

function collectControlActions(node, pathParts = [], entries = []) {
  if (!node || typeof node !== 'object') return entries;

  if (typeof node.type === 'string' && typeof node.name === 'string') {
    entries.push({
      path: pathParts.join('.') || '<root>',
      action: node,
    });
    return entries;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => collectControlActions(item, [...pathParts, String(index)], entries));
    return entries;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('_')) continue;
    collectControlActions(value, [...pathParts, key], entries);
  }
  return entries;
}

function listSdkConnectorIds() {
  const ids = new Set();
  for (const dir of SDK_CONNECTOR_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const filePath of listFiles(dir, (candidate) => candidate.endsWith('.json'))) {
      const fileName = path.basename(filePath, '.json');
      ids.add(fileName);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof parsed.id === 'string') ids.add(parsed.id);
        if (typeof parsed.connectorId === 'string') ids.add(parsed.connectorId);
      } catch {
        // Connector syntax is covered elsewhere. This guard only needs known ids.
      }
    }
  }
  return ids;
}

function formatRelative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function collectAdapterRouteTokens(route) {
  if (!route || typeof route !== 'object') return [];
  if (route.type === 'lvar') {
    return /^L:/i.test(route.name || '') ? [String(route.name).replace(/^L:/i, '')] : [];
  }
  if (route.type === 'input-event') return [route.name].filter(Boolean);
  if (route.transport === 'lvar') return [String(route.lvar || '').replace(/^L:/i, '')].filter(Boolean);
  if (route.transport === 'input-event') return [route.inputEvent].filter(Boolean);
  if (route.transport === 'mobiflight-calculator') {
    const calculatorCodes = [
      route.code,
      route.pressCode,
      route.releaseCode,
      route.increaseCode,
      route.decreaseCode,
    ].filter((code) => typeof code === 'string');
    return [...new Set(calculatorCodes.flatMap((code) => (
      [...code.matchAll(/\(?L:([^,\)]+)/gi)]
        .map((match) => match[1].trim())
        .filter(Boolean)
    )))];
  }
  if (route.transport === 'simconnect-sequence') {
    return (route.operations || []).map((operation) => {
      if (operation?.type === 'lvar') return String(operation.name || '').replace(/^L:/i, '');
      if (operation?.type === 'event') return operation.name;
      return null;
    }).filter(Boolean);
  }
  return [];
}

function validateTrustedAdapterEvidence(failures) {
  let loader;
  let integrationRegistry;
  try {
    loader = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-loader.js'));
    ({ defaultAircraftIntegrationRegistry: integrationRegistry } = require(
      resolveBackendRuntimeFile('aircraft', 'aircraft-integrations', 'index.js'),
    ));
  } catch (error) {
    failures.push(`trusted adapter evidence could not be checked; build backend runtime first: ${error.message}`);
    return;
  }

  for (const integration of integrationRegistry.list()) {
    const customFieldRoutes = Object.values(integration.fields || {})
      .flatMap((field) => field.sources || [])
      .map((source) => source.route)
      .filter((route) => route?.type !== 'simvar');
    const actionRoutes = Object.values(integration.actions || {})
      .flatMap((action) => action.routes || []);
    if (customFieldRoutes.length === 0 && actionRoutes.length === 0) continue;

    for (const profileKey of integration.trustedProfileKeys) {
      const profile = loader.loadProfile(profileKey);
      const sources = (profile?.provenance?.sources || [])
        .filter((source) => source?.supportsActiveMappings === true);
      const evidenceText = JSON.stringify(sources);
      const hasOfficialSdk = sources.some((source) => (
        source.type === 'official-sdk'
        && ACTIVE_MAPPING_AUTHORITIES.has(source.authority)
      ));

      if (sources.length === 0) {
        failures.push(`${integration.id} (${profileKey}): custom adapter routes require authoritative active-mapping evidence`);
        continue;
      }

      const exactStandardContract = EXACT_STANDARD_EVENT_CONTRACTS.get(integration.id);
      const exactStandardProfileKeys = exactStandardContract?.profileKeys
        || [exactStandardContract?.profileKey].filter(Boolean);
      if (exactStandardContract && exactStandardProfileKeys.includes(profileKey)) {
        const standardEvents = [...exactStandardContract.events].sort();
        const vendorEvents = [...(exactStandardContract.vendorEvents || [])].sort();
        const expectedEvents = [...standardEvents, ...vendorEvents].sort();
        const activeEvents = [...new Set(actionRoutes.flatMap(collectAdapterRouteTokens))].sort();
        if (JSON.stringify(activeEvents) !== JSON.stringify(expectedEvents)) {
          failures.push(`${integration.id} (${profileKey}): standard-event contract drifted; expected ${expectedEvents.length} exact events, got ${activeEvents.length}`);
        }

        const officialSdkEvidenceText = JSON.stringify(sources.filter((source) => (
          source.type === 'official-sdk' && source.authority === 'simulator-vendor'
        )));
        for (const eventName of standardEvents) {
          if (!sourceCoversName(officialSdkEvidenceText, eventName)) {
            failures.push(`${integration.id} (${profileKey}): standard event lacks Microsoft SDK active-mapping evidence: ${eventName}`);
          }
        }

        const aircraftVendorEvidenceText = JSON.stringify(sources.filter((source) => (
          source.authority === 'aircraft-vendor'
        )));
        for (const eventName of vendorEvents) {
          if (!sourceCoversName(aircraftVendorEvidenceText, eventName)) {
            failures.push(`${integration.id} (${profileKey}): vendor event lacks aircraft-vendor active-mapping evidence: ${eventName}`);
          }
        }

        for (const action of Object.values(integration.actions || {})) {
          if (action.verification !== exactStandardContract.verification) {
            failures.push(`${integration.id} (${profileKey}): every standard-event action must remain ${exactStandardContract.verification}: ${action.id}`);
          }
        }
      }

      for (const route of customFieldRoutes) {
        if (route.type === 'sdk') {
          if (!hasOfficialSdk) {
            failures.push(`${integration.id} (${profileKey}): SDK field routes require official-sdk evidence`);
          }
          continue;
        }
        for (const token of collectAdapterRouteTokens(route)) {
          if (!sourceCoversName(evidenceText, token)) {
            failures.push(`${integration.id} (${profileKey}): custom field route is not covered by authoritative evidence: ${token}`);
          }
        }
      }

      for (const route of actionRoutes) {
        if (route.transport === 'sdk') {
          if (!hasOfficialSdk) {
            failures.push(`${integration.id} (${profileKey}): SDK action routes require official-sdk evidence`);
          }
          continue;
        }
        for (const token of collectAdapterRouteTokens(route)) {
          if (!sourceCoversName(evidenceText, token)) {
            failures.push(`${integration.id} (${profileKey}): custom action route is not covered by authoritative evidence: ${token}`);
          }
        }
      }
    }
  }
}

function main() {
  console.log('=== Aircraft Profile Provenance Check ===\n');

  const sdkConnectorIds = listSdkConnectorIds();
  const todayEndUtc = new Date();
  todayEndUtc.setUTCHours(23, 59, 59, 999);

  const failures = [];
  const profileFiles = listFiles(BUNDLED_PROFILES_DIR, (filePath) => filePath.endsWith('.json'));

  for (const filePath of profileFiles) {
    const relativePath = formatRelative(filePath);
    const rawText = fs.readFileSync(filePath, 'utf8');
    const profile = JSON.parse(rawText);
    const profileLabel = `${profile.id || path.basename(filePath)} (${relativePath})`;
    const sources = Array.isArray(profile.provenance?.sources) ? profile.provenance.sources : [];
    const activeMappingSourceText = getActiveMappingSourceText(profile);
    const profileEvidenceText = getProfileEvidenceText(profile);
    const verificationStatus = profile.provenance?.verification?.status || null;
    const metaStatus = profile.meta?.status || null;

    for (const source of sources) {
      if (!TRUSTED_SOURCE_TYPES.has(source.type)) {
        failures.push(`${profileLabel}: unsupported provenance source type for active profile evidence: ${source.type}`);
      }
      if (SOURCE_TYPES_REQUIRING_NOTES.has(source.type) && !String(source.notes || '').trim()) {
        failures.push(`${profileLabel}: ${source.type} provenance source requires notes explaining what it supports`);
      }
      if (
        (source.type === 'official-sdk' || source.type === 'official-docs')
        && !String(source.url || '').trim()
      ) {
        failures.push(`${profileLabel}: ${source.type} provenance source requires a reviewable URL`);
      }
      if (source.supportsActiveMappings === true) {
        if (!ACTIVE_MAPPING_SOURCE_TYPES.has(source.type)) {
          failures.push(`${profileLabel}: active mapping evidence cannot use source type ${source.type}`);
        }
        if (!ACTIVE_MAPPING_AUTHORITIES.has(source.authority)) {
          failures.push(`${profileLabel}: active mapping evidence requires simulator-vendor or aircraft-vendor authority`);
        }
        if (source.access !== 'public' && source.access !== 'vendor-install') {
          failures.push(`${profileLabel}: active mapping evidence requires access=public|vendor-install`);
        }
        if (!String(source.notes || '').trim()) {
          failures.push(`${profileLabel}: active mapping evidence requires claim-specific notes`);
        }
      }
    }

    for (const [field, value] of collectDateFields(profile)) {
      const parsed = parseProfileDate(value);
      if (!parsed) {
        failures.push(`${profileLabel}: ${field} is not a parseable date: ${value}`);
      } else if (parsed > todayEndUtc) {
        failures.push(`${profileLabel}: ${field} is in the future: ${value}`);
      }
    }

    for (const pattern of MUTABLE_OR_UNSUPPORTED_CLAIMS) {
      if (pattern.test(rawText)) {
        failures.push(`${profileLabel}: contains mutable/superlative claim matching ${pattern}`);
      }
    }

    if (PROFILE_PROBE_ONLY_RE.test(rawText)) {
      failures.push(`${profileLabel}: bundled profiles must not contain _probeOnly/probe-only entries; use active mappings or provenance/knownIssues notes`);
    }

    const lvars = profile.integration?.telemetry?.lvars;
    const activeLvarEntries = collectActiveLvars(lvars);
    const activeLvars = [...new Set(activeLvarEntries.map((entry) => entry.name))];
    const activeLvarIdentities = new Map();
    if (activeLvars.length > 0 && UNSAFE_ACTIVE_LVAR_COMMENT.test(JSON.stringify(lvars))) {
      failures.push(`${profileLabel}: active LVAR block still contains an unsafe uncertainty comment`);
    }
    if (activeLvars.length > 0 && sources.length === 0) {
      failures.push(`${profileLabel}: active LVAR mappings require provenance.sources[] evidence`);
    }

    for (const { name: lvarName, path: lvarPath } of activeLvarEntries) {
      if (UNSUPPORTED_LVAR_PATTERNS.some((pattern) => pattern.test(lvarName))) {
        failures.push(`${profileLabel}: unsupported/removed LVAR is active: ${lvarName}`);
        continue;
      }

      if (!sourceCoversName(activeMappingSourceText, lvarName)) {
        failures.push(`${profileLabel}: active LVAR ${lvarPath}=${lvarName} is not covered by authoritative active-mapping evidence`);
      }

      const identity = normalizeActiveLvarIdentity(lvarName);
      const previousPath = activeLvarIdentities.get(identity);
      if (previousPath && previousPath !== lvarPath) {
        failures.push(`${profileLabel}: active LVAR ${lvarName} is mapped more than once (${previousPath} and ${lvarPath}); use one canonical runtime key`);
      } else {
        activeLvarIdentities.set(identity, lvarPath);
      }

      if (lvarPath.endsWith('parkingBrake') && !hasValueSemanticsEvidence(
        profileEvidenceText,
        activeMappingSourceText,
        lvarName,
        /\b(0\s*=\s*(released|off|disengaged)|1\s*=\s*(set|on|engaged)|state indicator|lever position|parking brake state)\b/i,
      )) {
        failures.push(`${profileLabel}: parking brake LVAR ${lvarName} requires documented value semantics in profile comments or provenance`);
      }

      if (lvarPath.endsWith('flaps') && !hasValueSemanticsEvidence(
        profileEvidenceText,
        activeMappingSourceText,
        lvarName,
        /\b(flaps?\s+handle\s+position|physical\s+flaps?\s+handle|0\s*=\s*(up|0)|4\s*=\s*(full|FULL)|handle\s+index)\b/i,
      )) {
        failures.push(`${profileLabel}: flaps LVAR ${lvarName} requires documented handle-index/value semantics`);
      }

      if (lvarPath.endsWith('spoilers.armed') && !hasValueSemanticsEvidence(
        profileEvidenceText,
        activeMappingSourceText,
        lvarName,
        /\b(bool|0\s*\/\s*1|0\s*=|1\s*=|armed state)\b/i,
      )) {
        failures.push(`${profileLabel}: spoiler armed LVAR ${lvarName} requires documented boolean/value semantics`);
      }

      if (lvarPath.endsWith('spoilers.handlePosition') && !hasValueSemanticsEvidence(
        profileEvidenceText,
        activeMappingSourceText,
        lvarName,
        /\b(0\.0\s*(?:\.\.|-|to)\s*1\.0|0\s*(?:\.\.|-|to)\s*1|0\s*[-–]\s*1|fraction|percent|handle position)\b/i,
      )) {
        failures.push(`${profileLabel}: spoiler handle LVAR ${lvarName} requires documented scale/value semantics`);
      }
    }

    const sdk = profile.integration?.telemetry?.sdk;
    if (sdk && (sdk.connector || sdk.adapter || sdk.channel || sdk.target?.channel)) {
      if (sdk.connector && !sdkConnectorIds.has(sdk.connector)) {
        failures.push(`${profileLabel}: SDK connector is not checked in: ${sdk.connector}`);
      }
      for (const sdkToken of [sdk.connector, sdk.adapter, sdk.channel, sdk.target?.channel].filter(Boolean)) {
        if (!sourceCoversName(activeMappingSourceText, sdkToken)) {
          failures.push(`${profileLabel}: SDK mapping token is not covered by authoritative active-mapping evidence: ${sdkToken}`);
        }
      }
      if (/requires/i.test(JSON.stringify(sdk)) && !/requires/i.test(profileEvidenceText)) {
        failures.push(`${profileLabel}: SDK mapping has runtime requirements but provenance/verification does not document them`);
      }
    }

    const telemetry = profile.integration?.telemetry || {};
    const preferred = String(telemetry.preferred || '').toLowerCase();
    const suppressesFallback =
      (preferred && preferred !== 'simconnect' && (activeLvars.length > 0 || sdk)) ||
      telemetry.allowGenericFallback === false ||
      telemetry.spoilers?.simVarReliable === false ||
      telemetry.lights?.simVarReliable === false;
    if (suppressesFallback && !EXPLANATION_RE.test([JSON.stringify(telemetry), profileEvidenceText].join('\n'))) {
      failures.push(`${profileLabel}: suppressed or non-generic telemetry fallback requires provenance/comment explanation`);
    }

    const controlActions = collectControlActions(profile.integration?.controls);
    for (const { path: actionPath, action } of controlActions) {
      if (!action.verification) {
        failures.push(`${profileLabel}: control action ${actionPath} (${action.type}:${action.name}) requires verification=untested|partial|verified`);
      }
      if (!sourceCoversName(activeMappingSourceText, action.name)) {
        failures.push(`${profileLabel}: control action ${actionPath} lacks authoritative provenance evidence for ${action.name}`);
      }
    }

    const hasEvidenceGatedMappings = activeLvars.length > 0 || Boolean(sdk) || controlActions.length > 0;
    if (hasEvidenceGatedMappings && verificationStatus === 'verified' && metaStatus && metaStatus !== 'production') {
      failures.push(`${profileLabel}: provenance verification is verified but meta.status is ${metaStatus}`);
    }
    if (hasEvidenceGatedMappings && metaStatus === 'production' && verificationStatus !== 'verified') {
      failures.push(`${profileLabel}: production profile with active custom mappings must have provenance.verification.status=verified`);
    }
  }

  validateTrustedAdapterEvidence(failures);

  if (failures.length > 0) {
    console.error('Profile provenance failures:');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(`Checked ${profileFiles.length} bundled profiles.`);
  console.log('Active profile and trusted-adapter mappings are covered by authoritative vendor evidence; SDK connectors exist, controls carry verification status, dates are sane, and mutable claims are absent.');
}

main();
