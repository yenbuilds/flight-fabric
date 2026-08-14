#!/usr/bin/env node
// test-aircraft-profile-loader.js
// Tests for aircraft profile loader functionality.
//
// Run: node tests/scripts/test-aircraft-profile-loader.js

// Simple test framework
let passed = 0;
let failed = 0;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-profile-loader-'));
const tempAppData = path.join(tempRoot, 'AppData', 'Roaming');
const tempXdgConfig = path.join(tempRoot, '.config');
const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.APPDATA = tempAppData;
process.env.XDG_CONFIG_HOME = tempXdgConfig;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

process.on('exit', () => {
  if (previousEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = previousEnv.HOME;
  if (previousEnv.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousEnv.USERPROFILE;
  if (previousEnv.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = previousEnv.HOMEDRIVE;
  if (previousEnv.HOMEPATH === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = previousEnv.HOMEPATH;
  if (previousEnv.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousEnv.APPDATA;
  if (previousEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousEnv.XDG_CONFIG_HOME;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function test(name, condition) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n${name}`);
  console.log('─'.repeat(50));
}

function hasUniqueValues(values) {
  return new Set(values).size === values.length;
}

function subscriptionsUseCanonicalProfileKeys(subscriptions = []) {
  const canonicalMcpKeys = new Set([
    'selected_altitude',
    'selected_heading',
    'selected_speed',
    'selected_vertical_speed',
    'mode_speed',
    'mode_lnav',
    'mode_vnav',
    'mode_loc',
    'mode_app',
    'mode_heading',
    'mode_altitude_hold',
    'mode_vertical_speed',
    'mode_flc',
    'mode_expedite',
    'ap_channel_a',
    'ap_channel_b',
  ]);
  for (const sub of subscriptions) {
    if (!sub || typeof sub !== 'object') return false;
    if (sub.sourcePath === 'integration.telemetry.lvars.parkingBrake' && sub.key !== 'parking_brake') return false;
    if (sub.sourcePath === 'integration.telemetry.lvars.spoilers.armed' && sub.key !== 'spoilers_armed') return false;
    if (sub.sourcePath === 'integration.telemetry.lvars.spoilers.handlePosition' && sub.key !== 'spoilers_handle') return false;
    if (sub.sourcePath?.startsWith('integration.telemetry.lvars.mcp.') && !canonicalMcpKeys.has(sub.key)) return false;
    if (sub.sourcePath?.startsWith('integration.telemetry.lvars.lights.') && !sub.key.startsWith('light_')) return false;
  }
  return true;
}

const MATCHING_IDENTITY_EXEMPT_PROFILE_IDS = new Set([
  'ga-base',
  'generic',
  'regional-jet',
  'turboprop-base',
  'widebody-base',
]);

const FIRST_PARTY_MODEL_PROFILE_IDS = new Set([
  'asobo-787',
  'inibuilds-a310',
  'inibuilds-a320neo-v2',
  'microsoft-737-max-8',
  'microsoft-atr-72-600',
  'workingtitle-747-8',
  'workingtitle-citation-longitude',
  'workingtitle-cj4',
]);

const VENDOR_SPECIFIC_MATCH_TOKENS = new Map([
  ['fbw-a32nx', ['flybywire', 'fbw', 'a32nx']],
  ['fbw-a380x', ['flybywire', 'fbw', 'a380x']],
  ['fenix-a319', ['fenix', 'fnx']],
  ['fenix-a320', ['fenix', 'fnx']],
  ['fenix-a321', ['fenix', 'fnx']],
  ['fss-e175', ['flightsimstudio', 'fss']],
  ['headwind-a330', ['headwind', 'a339x']],
  ['horizon-787-9', ['horizon']],
  ['ifly-737-max-8', ['ifly']],
  ['inibuilds-a300', ['inibuilds']],
  ['inibuilds-a310', ['inibuilds']],
  ['inibuilds-a321lr', ['inibuilds', 'microsoft']],
  ['inibuilds-a330', ['inibuilds', 'microsoft']],
  ['inibuilds-a400m', ['inibuilds', 'microsoft']],
  ['inibuilds-tristar', ['inibuilds']],
  ['justflight-146', ['justflight', 'just', 'jf', 'jfa']],
  ['kuro-787-8', ['kuro', 'kurorin']],
  ['miltech-c17', ['miltech']],
  ['tfdi-md-11', ['tfdi']],
  ['virtualcol-a220', ['virtualcol']],
]);

function normalizeMatchingEvidenceText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function matchingTextHasEvidence(value, tokens = []) {
  const normalized = normalizeMatchingEvidenceText(value);
  return tokens.some(token => normalized.includes(normalizeMatchingEvidenceText(token)));
}

function matchingArrayHasEvidence(values = [], tokens = []) {
  return Array.isArray(values) &&
    values.length > 0 &&
    values.every(value => matchingTextHasEvidence(value, tokens));
}

function matchingHasPathIdentity(matching = {}) {
  return (
    Array.isArray(matching.configPathContains) &&
      matching.configPathContains.some(value => String(value || '').trim())
  ) || (
    typeof matching.configPathRegex === 'string' &&
      matching.configPathRegex.trim().length > 0
  );
}

function matchingHasXplaneIdentity(matching = {}) {
  const xplane = matching.xplane || {};
  return [
    xplane.acfPaths,
    xplane.acfFileNames,
    xplane.aliases,
  ].some(values => (
    Array.isArray(values) &&
      values.some(value => String(value || '').trim())
  ));
}

// Load the module
const loader = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-loader.js'));
const controlService = require(resolveBackendRuntimeFile('aircraft', 'aircraft-control-service.js'));
const profileModel = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-model.js'));
const profileRegistry = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-registry.js'));
const { defaultAircraftIntegrationRegistry } = require(resolveBackendRuntimeFile('aircraft', 'aircraft-integrations', 'index.js'));
const storagePaths = require(resolveBackendRuntimeFile('utils', 'storage-paths.js'));
const retiredProfilesRootDir = path.join(storagePaths.getAppDataRoot(), 'Profiles');
const retiredAircraftProfilesDir = path.join(retiredProfilesRootDir, 'Aircraft');
const retiredBundledProfilesDir = path.join(retiredAircraftProfilesDir, 'Bundled');
const retiredLocalProfilesDir = path.join(retiredAircraftProfilesDir, 'Local');

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

section('Module Loading');
test('Module exports loadProfile', typeof loader.loadProfile === 'function');
test('Module exports detectProfile', typeof loader.detectProfile === 'function');
test('Module exports getActiveProfile', typeof loader.getActiveProfile === 'function');
test('Module exports listProfiles', typeof loader.listProfiles === 'function');
test('Module exports setActiveProfile', typeof loader.setActiveProfile === 'function');
test('Module exports clearCache', typeof loader.clearCache === 'function');
test('Module exports getStabilityScoringCriteria', typeof loader.getStabilityScoringCriteria === 'function');
test('Module exports getAircraftSpecificConfig', typeof loader.getAircraftSpecificConfig === 'function');

section('Constants');
test('BUILTIN_BUNDLED_DIR is defined', typeof loader.BUILTIN_BUNDLED_DIR === 'string');
test('Legacy AppData BUNDLED_DIR is not exposed', typeof loader.BUNDLED_DIR === 'undefined');
test('LOCAL_DIR is not exposed by the release-owned profile loader', typeof loader.LOCAL_DIR === 'undefined');
test('GENERIC_ID is "generic"', loader.GENERIC_ID === 'generic');
test('Profile JSON size budget is exported', Number.isFinite(loader.MAX_PROFILE_JSON_BYTES) && loader.MAX_PROFILE_JSON_BYTES > 0);
test('Loading profile modules does not create a retired AppData Profiles folder', !fs.existsSync(retiredProfilesRootDir));

section('Aircraft-Specific Provider Contracts');
const futureProviderProfile = {
  version: 2,
  id: 'future-provider-contract',
  name: 'Future Provider Contract',
  simulator: 'msfs',
  namespace: 'local',
  aircraft: {},
  integration: {
    aircraftSpecific: {
      adapter: 'test-adapter',
    },
    telemetry: {
      aircraftSpecific: {
        fields: {
          'mcp.altitudeFt': {
            source: {
              type: 'sdk',
              adapter: 'test-sdk',
              path: 'automation.mcp.altitudeFt',
            },
            decode: { type: 'number', precision: 0, unavailableValues: [-999] },
          },
        },
      },
    },
    controls: {
      aircraftSpecific: {
        actions: {
          'apu.start': {
            type: 'lvar',
            name: 'L:VERIFIED_APU_START_INPUT',
            unit: 'Number',
            value: 1,
          },
        },
      },
    },
    presentation: {
      aircraftSpecific: { template: 'future-provider-contract' },
    },
  },
};
test(
  'Schema accepts an aircraft adapter reference, numeric unavailable sentinels, normalized SDK reads, and logical action IDs',
  profileRegistry.validateExternal(futureProviderProfile).validation.valid === true,
);
const legacyProvenanceProfile = JSON.parse(JSON.stringify(futureProviderProfile));
const legacyProvenanceTypes = ['legacy-source-a', 'legacy-source-b'];
legacyProvenanceProfile.provenance = {
  sources: legacyProvenanceTypes.map((type, index) => ({
    type,
    name: `Legacy source ${index + 1}`,
    notes: 'Compatibility fixture only.',
  })),
};
const normalizedLegacyProvenanceProfile = profileModel.normalizeProfileDocument(legacyProvenanceProfile);
test(
  'Unsupported legacy provenance labels are discarded without mutating imported JSON',
  normalizedLegacyProvenanceProfile.provenance.sources.length === 0 &&
    legacyProvenanceProfile.provenance.sources.map(source => source.type).join(',') === legacyProvenanceTypes.join(','),
);
const legacyThrottleDetentsProfile = {
  id: 'legacy-throttle-detents',
  aircraft: {
    throttle: {
      type: 'detent',
      detents: [{ name: 'CL' }],
    },
  },
};
const normalizedLegacyThrottleDetentsProfile = profileModel.normalizeProfileDocument(legacyThrottleDetentsProfile);
test(
  'Legacy throttle detents are removed without mutating imported JSON',
  normalizedLegacyThrottleDetentsProfile.aircraft.throttle.detents === undefined &&
    Array.isArray(legacyThrottleDetentsProfile.aircraft.throttle.detents) &&
    legacyThrottleDetentsProfile.aircraft.throttle.detents[0]?.name === 'CL',
);
test(
  'Schema accepts normalized legacy provenance metadata',
  profileRegistry.validateExternal(legacyProvenanceProfile).validation.valid === true,
);
const malformedUnavailableValuesProfile = JSON.parse(JSON.stringify(futureProviderProfile));
malformedUnavailableValuesProfile.integration.telemetry.aircraftSpecific
  .fields['mcp.altitudeFt'].decode.unavailableValues = [];
test(
  'Schema rejects empty numeric unavailable-sentinel lists',
  profileRegistry.validateExternal(malformedUnavailableValuesProfile).validation.valid === false,
);
const malformedAdapterProfile = JSON.parse(JSON.stringify(futureProviderProfile));
malformedAdapterProfile.integration.aircraftSpecific.adapter = 'Bad Adapter';
test(
  'Schema rejects malformed aircraft adapter IDs',
  profileRegistry.validateExternal(malformedAdapterProfile).validation.valid === false,
);
const adapterWithExecutablePayload = JSON.parse(JSON.stringify(futureProviderProfile));
adapterWithExecutablePayload.integration.aircraftSpecific.code = '(>K:UNSAFE)';
test(
  'Schema rejects extra aircraft adapter payload fields',
  profileRegistry.validateExternal(adapterWithExecutablePayload).validation.valid === false,
);
const matchingExclusionProfile = JSON.parse(JSON.stringify(futureProviderProfile));
matchingExclusionProfile.id = 'matching-exclusion-contract';
matchingExclusionProfile.integration.matching = {
  titleRegex: '^Example Aircraft$',
  titleExcludes: ['Traffic'],
  configPathExcludes: ['Community', 'passiveaircraft'],
};
test(
  'Schema accepts declarative title and configuration-path exclusion arrays',
  profileRegistry.validateExternal(matchingExclusionProfile).validation.valid === true,
);
const malformedMatchingExclusionProfile = JSON.parse(JSON.stringify(matchingExclusionProfile));
malformedMatchingExclusionProfile.integration.matching.configPathExcludes = 'Community';
test(
  'Schema rejects scalar matching exclusions so veto behavior stays deterministic',
  profileRegistry.validateExternal(malformedMatchingExclusionProfile).validation.valid === false,
);
test('Profile import is not part of the release-owned loader API', typeof loader.importProfile === 'undefined');
test('Profile copy is not part of the release-owned loader API', typeof loader.copyProfileToLocal === 'undefined');
test('Profile deletion is not part of the release-owned loader API', typeof loader.deleteUserProfile === 'undefined');
const invalidFutureActionProfile = JSON.parse(JSON.stringify(futureProviderProfile));
invalidFutureActionProfile.integration.controls.aircraftSpecific.actions = {
  'apu start': {
    type: 'lvar',
    name: 'L:VERIFIED_APU_START_INPUT',
    value: 1,
  },
};
test(
  'Schema rejects malformed aircraft action IDs',
  profileRegistry.validateExternal(invalidFutureActionProfile).validation.valid === false,
);
const executableFutureActionProfile = JSON.parse(JSON.stringify(futureProviderProfile));
executableFutureActionProfile.integration.controls.aircraftSpecific.actions['apu.start'].calculatorCode = '(>K:UNSAFE)';
test(
  'Schema rejects executable-looking fields outside the declarative action contract',
  profileRegistry.validateExternal(executableFutureActionProfile).validation.valid === false,
);
const obsoletePresetActionProfile = JSON.parse(JSON.stringify(futureProviderProfile));
obsoletePresetActionProfile.integration.controls.aircraftSpecific.actions['apu.start'] = {
  type: 'mobiflight-preset',
  name: 'legacy.public.preset',
  verification: 'untested',
};
test(
  'Schema rejects the obsolete public MobiFlight preset action type',
  profileRegistry.validateExternal(obsoletePresetActionProfile).validation.valid === false,
);

section('Profile Loading');
loader.clearCache();

const generic = loader.loadProfile('generic');
test('Can load generic profile', generic !== null);
test('Generic profile has id', generic?.id === 'generic');
test('Generic profile has name', typeof generic?.name === 'string');
test('Generic profile has namespace', generic?.namespace === 'bundled');
test('Generic profile has simulator', generic?.simulator === 'msfs');
test('Generic profile has _loaded flag', generic?._loaded === true);
test('Generic profile has _qualifiedId', generic?._qualifiedId === 'bundled/msfs/generic');
test('Generic profile is loaded from built-in bundled profiles', typeof generic?._source === 'string' && generic._source.startsWith(loader.BUILTIN_BUNDLED_DIR));
test('MSFS generic does not assert flap notches', generic?.flaps == null && generic?.aircraft?.flaps == null);
test(
  'MSFS generic explicitly enables the fixed standard control baseline',
  generic?.integration?.controls?.backend === 'simconnect' &&
    generic?.integration?.controls?.genericFallback === true,
);

const builtinGenericPath = path.join(loader.BUILTIN_BUNDLED_DIR, 'msfs', 'generic.json');
const legacyBundledGenericDir = path.join(retiredBundledProfilesDir, 'msfs');
const legacyBundledGenericPath = path.join(legacyBundledGenericDir, 'generic.json');
fs.mkdirSync(legacyBundledGenericDir, { recursive: true });
fs.writeFileSync(legacyBundledGenericPath, JSON.stringify({ id: 'generic', name: 'Stale Generic', simulator: 'msfs' }, null, 2));
loader.clearCache();
const appDataShadowedGeneric = loader.loadProfile('generic');
test(
  'Legacy AppData bundled profile copies do not shadow built-in profiles',
  appDataShadowedGeneric?.name === generic?.name &&
    appDataShadowedGeneric?._source === builtinGenericPath &&
    fs.readFileSync(legacyBundledGenericPath, 'utf8').includes('Stale Generic')
);

const a32nx = loader.loadProfile('fbw-a32nx');
test('Can load fbw-a32nx profile', a32nx !== null);
test('A32NX has local source-backed flap detents for its flap LVAR', JSON.stringify(a32nx?.flaps?.notches?.map((notch) => notch.label)) === '["0","1/1+F","2","3","FULL"]');

for (const variant of ['a319', 'a320', 'a321']) {
  const fenixProfile = loader.loadProfile(`fenix-${variant}`);
  test(`Can load Fenix ${variant.toUpperCase()} profile`, fenixProfile !== null);
  test(
    `Fenix ${variant.toUpperCase()} activates the shared trusted adapter`,
    fenixProfile?.integration?.aircraftSpecific?.adapter === 'fenix-a32x',
  );
  test(
    `Fenix ${variant.toUpperCase()} uses guarded aircraft-specific writes and narrow surface fallback`,
    fenixProfile?.integration?.controls?.genericFallback === false
      && fenixProfile?.integration?.controls?.standardSurfaceFallback === true,
  );
}

const inibuildsA320neoV2 = loader.loadProfile('inibuilds-a320neo-v2');
test('Can load inibuilds-a320neo-v2 profile', inibuildsA320neoV2 !== null);
test('Microsoft / iniBuilds A320neo V2 activates the shared trusted adapter', inibuildsA320neoV2?.integration?.aircraftSpecific?.adapter === 'microsoft-inibuilds-a32x');
test('Microsoft / iniBuilds A320neo V2 does not inherit broad Airbus flap detents', inibuildsA320neoV2?.flaps == null && inibuildsA320neoV2?.aircraft?.flaps == null);
test('Microsoft / iniBuilds A320neo V2 uses narrow surface fallback only', inibuildsA320neoV2?.integration?.controls?.genericFallback === false && inibuildsA320neoV2?.integration?.controls?.standardSurfaceFallback === true);
test('Microsoft / iniBuilds A320neo V2 exposes no profile-level autopilot writes', inibuildsA320neoV2?.integration?.controls?.autopilot === undefined);

const inibuildsA321lr = loader.loadProfile('inibuilds-a321lr');
test('Can load inibuilds-a321lr profile', inibuildsA321lr !== null);
test('Microsoft / iniBuilds A321LR activates the shared trusted adapter', inibuildsA321lr?.integration?.aircraftSpecific?.adapter === 'microsoft-inibuilds-a32x');
test('Microsoft / iniBuilds A321LR does not inherit broad Airbus flap detents', inibuildsA321lr?.flaps == null && inibuildsA321lr?.aircraft?.flaps == null);
test('Microsoft / iniBuilds A321LR uses narrow surface fallback only', inibuildsA321lr?.integration?.controls?.genericFallback === false && inibuildsA321lr?.integration?.controls?.standardSurfaceFallback === true);
test('Microsoft / iniBuilds A321LR exposes no profile-level autopilot writes', inibuildsA321lr?.integration?.controls?.autopilot === undefined);

const inibuildsA330 = loader.loadProfile('inibuilds-a330');
test('Can load inibuilds-a330 profile', inibuildsA330 !== null);
test('iniBuilds A330 does not inherit broad Airbus flap detents', inibuildsA330?.flaps == null && inibuildsA330?.aircraft?.flaps == null);
test('iniBuilds A330 activates its dedicated trusted adapter', inibuildsA330?.integration?.aircraftSpecific?.adapter === 'inibuilds-a330');

const a300 = loader.loadProfile('inibuilds-a300');
test('Can load inibuilds-a300 profile', a300 !== null);
test('iniBuilds A300 uses conservative category D', a300?.aircraftCategory === 'D');
test('iniBuilds A300 has A300-family flap notches', JSON.stringify(a300?.flaps?.notches?.map((notch) => notch.label)) === '["0","15/0","15/15","30/20","30/40"]');
test('iniBuilds A300 uses narrow surface fallback only', a300?.integration?.controls?.genericFallback === false && a300?.integration?.controls?.standardSurfaceFallback === true);

const a310 = loader.loadProfile('inibuilds-a310');
test('Can load inibuilds-a310 profile', a310 !== null);
test('iniBuilds A310 uses category D', a310?.aircraftCategory === 'D');
test('Microsoft / iniBuilds A310 activates its dedicated trusted adapter', a310?.integration?.aircraftSpecific?.adapter === 'inibuilds-a310');
test('Microsoft / iniBuilds A310 uses narrow surface fallback only', a310?.integration?.controls?.genericFallback === false && a310?.integration?.controls?.standardSurfaceFallback === true);
test('Microsoft / iniBuilds A310 exposes no legacy profile-level autopilot writes', a310?.integration?.controls?.autopilot === undefined);

const tfdiMd11 = loader.loadProfile('tfdi-md-11');
test('Can load tfdi-md-11 profile', tfdiMd11 !== null);
test('TFDi Design MD-11 preserves the canonical product and vendor names', tfdiMd11?.name === 'TFDi Design MD-11' && tfdiMd11?.meta?.developer === 'TFDi Design');
test('TFDi Design MD-11 activates its exact trusted adapter', tfdiMd11?.integration?.aircraftSpecific?.adapter === 'tfdi-md-11');
test('TFDi Design MD-11 uses narrow surface fallback only', tfdiMd11?.integration?.controls?.genericFallback === false && tfdiMd11?.integration?.controls?.standardSurfaceFallback === true);
test('TFDi Design MD-11 exposes no profile-level autopilot writes', tfdiMd11?.integration?.controls?.autopilot === undefined);

const ifly737Max8 = loader.loadProfile('ifly-737-max-8');
test('Can load ifly-737-max-8 profile', ifly737Max8 !== null);
test('iFly 737 MAX 8 activates its dedicated trusted adapter', ifly737Max8?.integration?.aircraftSpecific?.adapter === 'ifly-737-max-8');
test('iFly 737 MAX 8 uses category D', ifly737Max8?.aircraftCategory === 'D');
test('iFly 737 MAX 8 has correct 737 MAX flap detents', JSON.stringify(ifly737Max8?.flaps?.notches?.map((notch) => notch.value)) === '[0,1,2,5,10,15,25,30,40]');
test('iFly 737 MAX 8 uses narrow surface fallback only', ifly737Max8?.integration?.controls?.genericFallback === false && ifly737Max8?.integration?.controls?.standardSurfaceFallback === true);

const microsoft737Max8 = loader.loadProfile('microsoft-737-max-8');
test('Can load microsoft-737-max-8 profile', microsoft737Max8 !== null);
test('Microsoft 737 MAX 8 activates its dedicated trusted adapter', microsoft737Max8?.integration?.aircraftSpecific?.adapter === 'microsoft-737-max-8');
test('Microsoft 737 MAX 8 uses category D', microsoft737Max8?.aircraftCategory === 'D');
test('Microsoft 737 MAX 8 does not inherit broad Boeing flap detents', microsoft737Max8?.flaps == null && microsoft737Max8?.aircraft?.flaps == null);
test('Microsoft 737 MAX 8 uses narrow surface fallback only', microsoft737Max8?.integration?.controls?.genericFallback === false && microsoft737Max8?.integration?.controls?.standardSurfaceFallback === true);

const microsoftAtr72 = loader.loadProfile('microsoft-atr-72-600');
test('Can load microsoft-atr-72-600 profile', microsoftAtr72 !== null);
test('Microsoft ATR 72-600 activates its dedicated trusted adapter', microsoftAtr72?.integration?.aircraftSpecific?.adapter === 'microsoft-atr-72-600');
test('Microsoft ATR 72-600 uses narrow surface fallback only', microsoftAtr72?.integration?.controls?.genericFallback === false && microsoftAtr72?.integration?.controls?.standardSurfaceFallback === true);

const microsoft747 = loader.loadProfile('workingtitle-747-8');
test('Can load the stock Boeing 747-8 profile by its stable key', microsoft747 !== null);
test('Stock Boeing 747-8 preserves Microsoft publication, Asobo development, and both included variants', microsoft747?.name === 'Microsoft / Asobo Studio Boeing 747-8i / 747-8F' && microsoft747?.meta?.developer === 'Asobo Studio');
test('Stock Boeing 747-8 activates its exact trusted adapter', microsoft747?.integration?.aircraftSpecific?.adapter === 'workingtitle-747-8');
test('Stock Boeing 747-8 declares four jet engines', microsoft747?.aircraft?.engines?.count === 4 && microsoft747?.aircraft?.engines?.type === 'jet');

const microsoft787 = loader.loadProfile('asobo-787');
test('Can load the stock Boeing 787-10 profile by its stable key', microsoft787 !== null);
test('Stock Boeing 787-10 preserves Microsoft publication and Asobo development identity', microsoft787?.name === 'Microsoft / Asobo Studio Boeing 787-10 Dreamliner' && microsoft787?.meta?.developer === 'Asobo Studio');
test('Stock Boeing 787-10 activates its exact trusted adapter', microsoft787?.integration?.aircraftSpecific?.adapter === 'asobo-787');
test('Stock Boeing 787-10 uses narrow surface fallback only', microsoft787?.integration?.controls?.genericFallback === false && microsoft787?.integration?.controls?.standardSurfaceFallback === true);

const resolvedKuro787 = loader.loadProfile('kuro-787-8');
const resolvedHorizon787 = loader.loadProfile('horizon-787-9');
test(
  '787 derivative profiles replace stock vetoes instead of inheriting self-rejecting rules',
  Array.isArray(resolvedKuro787?.integration?.matching?.titleExcludes) &&
    resolvedKuro787.integration.matching.titleExcludes.length === 0 &&
    Array.isArray(resolvedKuro787?.integration?.matching?.configPathExcludes) &&
    resolvedKuro787.integration.matching.configPathExcludes.length === 0 &&
    Array.isArray(resolvedHorizon787?.integration?.matching?.titleExcludes) &&
    resolvedHorizon787.integration.matching.titleExcludes.length === 0 &&
    Array.isArray(resolvedHorizon787?.integration?.matching?.configPathExcludes) &&
    resolvedHorizon787.integration.matching.configPathExcludes.length === 0,
);
test(
  '787 derivative profiles replace stock structured creator and model rules',
  JSON.stringify(resolvedKuro787?.integration?.matching?.aircraftCfg?.containsAll?.ui_createdby) === '["Kuro","Kurorin"]' &&
    JSON.stringify(resolvedKuro787?.integration?.matching?.aircraftCfg?.containsAny?.ui_type) === '["787-8","787-8 Dreamliner"]' &&
    resolvedHorizon787?.integration?.matching?.aircraftCfg?.containsAll?.ui_createdby === 'Horizon Simulations' &&
    JSON.stringify(resolvedHorizon787?.integration?.matching?.aircraftCfg?.containsAny?.ui_type) === '["787-9","787-9 Dreamliner"]',
);

const inibuildsA400m = loader.loadProfile('inibuilds-a400m');
test('Can load inibuilds-a400m profile', inibuildsA400m !== null);
test('iniBuilds A400M does not inherit generic placeholder flap detents', inibuildsA400m?.flaps == null && inibuildsA400m?.aircraft?.flaps == null);

const virtualcolA220 = loader.loadProfile('virtualcol-a220');
test('Can load virtualcol-a220 profile', virtualcolA220 !== null);
test('Virtualcol A220 uses category D', virtualcolA220?.aircraftCategory === 'D');

const sharedBaseProfileIds = [
  'airbus-base',
  'boeing-base',
  'ga-base',
  'regional-jet',
  'turboprop-base',
  'widebody-base',
];
const sharedBaseProfiles = sharedBaseProfileIds.map((id) => loader.loadProfile(id));
test('Can load shared base profiles', sharedBaseProfiles.every(Boolean));
test('Shared base profiles do not assert flap notches', sharedBaseProfiles.every((profile) =>
  profile?.flaps == null && profile?.aircraft?.flaps == null
));

const genericPlaceholderLabels = JSON.stringify(['UP', '25', '50', '75', 'FULL']);
const noSpecificProfileInheritsGenericPlaceholderFlaps = loader.listProfiles()
  .filter((summary) => summary.namespace === 'bundled' && summary.simulator === 'msfs' && summary.id !== 'generic')
  .every((summary) => {
    const profile = loader.loadProfile(summary.qualifiedId);
    const labels = profile?.flaps?.notches?.map((notch) => notch.label);
    return JSON.stringify(labels || []) !== genericPlaceholderLabels;
  });
test('No specific bundled MSFS profile inherits generic placeholder flap detents', noSpecificProfileInheritsGenericPlaceholderFlaps === true);

const justFlight146 = loader.loadProfile('justflight-146');
test('Can load Just Flight 146 profile', justFlight146 !== null);
test('Just Flight 146 has source-backed flap gates', JSON.stringify(justFlight146?.flaps?.notches?.map((notch) => notch.value)) === '[0,18,24,30,33]');
test('Just Flight 146 uses narrow surface fallback only', justFlight146?.integration?.controls?.genericFallback === false && justFlight146?.integration?.controls?.standardSurfaceFallback === true);

const tristar = loader.loadProfile('inibuilds-tristar');
test('Can load iniBuilds TriStar profile', tristar !== null);
test('iniBuilds TriStar activates its dedicated trusted adapter', tristar?.integration?.aircraftSpecific?.adapter === 'inibuilds-tristar');
test(
  'TriStar has source-backed AFCS toggle controls without broad generic fallback',
  tristar?.integration?.controls?.genericFallback === false &&
    tristar?.integration?.controls?.standardSurfaceFallback === true &&
    tristar?.integration?.controls?.autopilot?.actions?.masterToggle?.name === 'AP_MASTER' &&
    tristar?.integration?.controls?.autopilot?.actions?.headingHoldToggle?.name === 'AP_HDG_HOLD' &&
    tristar?.integration?.controls?.autopilot?.actions?.autothrottleToggle?.name === 'AP_AIRSPEED_HOLD' &&
    tristar?.integration?.controls?.autopilot?.actions?.insToggle?.name === 'TOGGLE_WATER_RUDDER' &&
    tristar?.integration?.controls?.autopilot?.actions?.speedHoldToggle === undefined &&
    tristar?.integration?.controls?.autopilot?.actions?.yawDamperToggle === undefined
);
test(
  'TriStar suppresses generic spoiler telemetry because the value can include DLC movement',
  tristar?.spoilers?.simVarReliable === false &&
    tristar?.integration?.telemetry?.spoilers?.simVarReliable === false
);
test(
  'TriStar suppresses generic AP readback while keeping AFCS write controls available',
  tristar?.integration?.telemetry?.autopilot?.simVarReliable === false
);

const tristarMasterToggle = controlService.resolveAircraftControl(
  { control: 'autopilot', target: 'master', operation: 'toggle' },
  { profile: tristar, capabilities: { simulator: 'msfs', actionTypes: ['key-event', 'lvar', 'simvar'] } }
);
test(
  'TriStar AP master toggle resolves through current MSFS provider capabilities',
  tristarMasterToggle?.ok === true &&
    tristarMasterToggle?.resolvedBy === 'profile' &&
    tristarMasterToggle?.action?.name === 'AP_MASTER'
);

const tristarHeadingHoldToggle = controlService.resolveAircraftControl(
  { control: 'autopilot', target: 'headingHold', operation: 'toggle' },
  { profile: tristar, capabilities: { simulator: 'msfs', actionTypes: ['key-event', 'lvar', 'simvar'] } }
);
test(
  'TriStar heading hold toggle resolves through the profile key-event mapping',
  tristarHeadingHoldToggle?.ok === true &&
    tristarHeadingHoldToggle?.resolvedBy === 'profile' &&
    tristarHeadingHoldToggle?.action?.name === 'AP_HDG_HOLD'
);

const tristarSpeedHoldSetOn = controlService.resolveAircraftControl(
  { control: 'autopilot', target: 'speedHold', operation: 'set', value: true },
  { profile: tristar, capabilities: { simulator: 'msfs', actionTypes: ['key-event', 'lvar', 'simvar'] } }
);
test(
  'TriStar does not use toggle-only AFCS events for on/off requests',
  tristarSpeedHoldSetOn?.ok === false &&
    tristarSpeedHoldSetOn?.code === 'unmapped_control'
);

const tristarSpeedSet = controlService.resolveAircraftControl(
  { control: 'autopilot', target: 'speed', operation: 'set', value: 250 },
  { profile: tristar, capabilities: { simulator: 'msfs', actionTypes: ['key-event', 'lvar', 'simvar'] } }
);
test(
  'TriStar does not fall back to broad generic autopilot selector writes',
  tristarSpeedSet?.ok === false &&
    tristarSpeedSet?.code === 'unmapped_control' &&
    tristarSpeedSet?.resolvedBy === 'profile'
);

const tristarLandingLightToggle = controlService.resolveAircraftControl(
  { control: 'lights', target: 'landing', operation: 'toggle' },
  { profile: tristar, capabilities: { simulator: 'msfs', actionTypes: ['key-event', 'lvar', 'simvar'] } }
);
test(
  'TriStar light key events stay inactive until the control service supports lights',
  tristarLandingLightToggle?.ok === false &&
    tristarLandingLightToggle?.code === 'unmapped_control'
);

section('Namespaced Loading');
loader.clearCache();

const bundledFbw = loader.loadProfile('bundled/msfs/fbw-a32nx');
test('Can load with full bundled/msfs prefix', bundledFbw !== null);
test('Bundled prefix resolves correctly', bundledFbw?.id === 'fbw-a32nx');

const resolved = loader.resolveProfilePath('fbw-a32nx');
test('resolveProfilePath returns object', resolved !== null);
test('resolveProfilePath has filePath', typeof resolved?.filePath === 'string');
test('resolveProfilePath has namespace', resolved?.namespace === 'bundled');
test('resolveProfilePath uses built-in bundled profile path', typeof resolved?.filePath === 'string' && resolved.filePath.startsWith(loader.BUILTIN_BUNDLED_DIR));

section('Profile Listing');
const profiles = loader.listProfiles();
test('listProfiles returns array', Array.isArray(profiles));
test('Has at least 4 profiles', profiles.length >= 4);

const profileIds = profiles.map(p => p.id);
test('List includes generic', profileIds.includes('generic'));
test('List excludes deferred PMDG profiles', !profileIds.some(id => id.startsWith('pmdg-')));
test('List includes airbus-base', profileIds.includes('airbus-base'));
test('List excludes the deferred Microsoft C408 profile', !profileIds.includes('microsoft-c408-skycourier'));
test('List excludes the deferred Microsoft DHC-6 profile', !profileIds.includes('microsoft-dhc6-twin-otter'));
test('List excludes the obsolete Asobo E175 compatibility shim', !profileIds.includes('asobo-e175'));
test(
  'Profile summaries retain null legacy administration fields for client compatibility',
  profiles.every(profile => (
    profile.remoteInstall === null &&
    profile.bundledProfileKey === null &&
    profile.localOverrideUpdateStatus === null
  )),
);

const abstractProfiles = profiles.filter(p => p.abstract);
test('airbus-base is marked abstract', abstractProfiles.some(p => p.id === 'airbus-base'));
test('Bundled profiles are labeled with bundled source', profiles.some(p => p.namespace === 'bundled' && p.source === 'bundled'));

const concreteBundledMsfsProfiles = profiles
  .filter(p => (
    p.namespace === 'bundled' &&
    p.simulator === 'msfs' &&
    !p.abstract &&
    !MATCHING_IDENTITY_EXEMPT_PROFILE_IDS.has(p.id)
  ))
  .map(p => loader.loadProfile(p.qualifiedId))
  .filter(Boolean);

const profilesMissingConfigPathIdentity = concreteBundledMsfsProfiles
  .filter(profile => !matchingHasPathIdentity(profile.integration?.matching))
  .map(profile => profile.id);
test(
  'Concrete bundled MSFS profiles declare config-path identity matchers',
  profilesMissingConfigPathIdentity.length === 0
);

const vendorSpecificBundledProfiles = concreteBundledMsfsProfiles
  .filter(profile => !FIRST_PARTY_MODEL_PROFILE_IDS.has(profile.id));
const vendorProfilesWithoutEvidencePolicy = vendorSpecificBundledProfiles
  .filter(profile => !VENDOR_SPECIFIC_MATCH_TOKENS.has(profile.id))
  .map(profile => profile.id);
test(
  'Vendor-specific bundled profiles have explicit matching evidence tokens',
  vendorProfilesWithoutEvidencePolicy.length === 0
);

const vendorProfilesWithLooseTitleContains = vendorSpecificBundledProfiles
  .filter(profile => {
    const tokens = VENDOR_SPECIFIC_MATCH_TOKENS.get(profile.id) || [];
    const titleContains = profile.integration?.matching?.titleContains;
    return Array.isArray(titleContains) && titleContains.length > 0 &&
      !matchingArrayHasEvidence(titleContains, tokens);
  })
  .map(profile => profile.id);
test(
  'Vendor-specific bundled profile titleContains entries require vendor/product evidence when present',
  vendorProfilesWithLooseTitleContains.length === 0
);

const vendorProfilesWithLooseTitleRegex = vendorSpecificBundledProfiles
  .filter(profile => {
    const tokens = VENDOR_SPECIFIC_MATCH_TOKENS.get(profile.id) || [];
    return !matchingTextHasEvidence(profile.integration?.matching?.titleRegex, tokens);
  })
  .map(profile => profile.id);
test(
  'Vendor-specific bundled profile titleRegex values require vendor/product evidence',
  vendorProfilesWithLooseTitleRegex.length === 0
);

const vendorProfilesWithLooseConfigPathIdentity = vendorSpecificBundledProfiles
  .filter(profile => {
    const tokens = VENDOR_SPECIFIC_MATCH_TOKENS.get(profile.id) || [];
    const matching = profile.integration?.matching || {};
    return !(
      matchingArrayHasEvidence(matching.configPathContains, tokens) &&
      matchingTextHasEvidence(matching.configPathRegex, tokens)
    );
  })
  .map(profile => profile.id);
test(
  'Vendor-specific bundled profile config-path matchers require vendor/product evidence',
  vendorProfilesWithLooseConfigPathIdentity.length === 0
);

const concreteBundledXplaneProfiles = profiles
  .filter(p => (
    p.namespace === 'bundled' &&
    p.simulator === 'xplane' &&
    !p.abstract &&
    p.id !== 'generic'
  ))
  .map(p => loader.loadProfile(p.qualifiedId))
  .filter(Boolean);
const xplaneProfilesMissingIdentity = concreteBundledXplaneProfiles
  .filter(profile => !matchingHasXplaneIdentity(profile.integration?.matching))
  .map(profile => profile.id);
test(
  'Concrete bundled X-Plane profiles declare explicit aircraft identity matchers',
  xplaneProfilesMissingIdentity.length === 0
);

section('Auto-Detection');
loader.clearCache();

const detected777 = loader.detectProfile('PMDG 777-300ER Captain');
test(
  'Deferred PMDG 777 does not activate a vendor integration',
  !String(detected777?.id || '').startsWith('pmdg-') &&
    detected777?.integration?.aircraftSpecific?.adapter == null
);

const detectedUnknown = loader.detectProfile('Some Random Aircraft XYZ');
test('Falls back to generic for unknown', detectedUnknown?.id === 'generic');

const detectedBoeing = loader.detectProfile('Boeing 777-200LR');
test('Does not detect PMDG 777 from generic Boeing title alone', detectedBoeing?.id !== 'pmdg-777');

const detectedA300 = loader.detectProfile('iniBuilds A300-600R Airliner');
test('Detects iniBuilds A300 specifically', detectedA300?.id === 'inibuilds-a300');

const detectedGenericA310 = loader.detectProfile('Airbus A310-300');
test('Detects the included Microsoft / iniBuilds A310 from its official product title', detectedGenericA310?.id === 'inibuilds-a310');

const detectedIniBuildsA310 = loader.detectProfile('iniBuilds Airbus A310-300');
test('Detects iniBuilds A310 when vendor evidence is present', detectedIniBuildsA310?.id === 'inibuilds-a310');

const detectedIniBuildsA310FromPath = loader.detectProfile('Airbus A310-300', {
  hint: 'SimObjects/Airplanes/inibuilds-aircraft-a310-300/aircraft.cfg',
});
test('Detects iniBuilds A310 from config-path evidence', detectedIniBuildsA310FromPath?.id === 'inibuilds-a310');

const detectedMicrosoftA310FromPath = loader.detectProfile('Unknown repaint', {
  hint: 'Official/OneStore/microsoft-aircraft-a310-300/SimObjects/Airplanes/A310/aircraft.cfg',
});
test('Detects included A310-300 from the Microsoft package path', detectedMicrosoftA310FromPath?.id === 'inibuilds-a310');

const detectedIniBuildsA300NotA310 = loader.detectProfile('iniBuilds Airbus A300-600R', {
  hint: 'Community/inibuilds-aircraft-a300-600r/SimObjects/Airplanes/A300/aircraft.cfg',
});
test('Does not confuse the iniBuilds A300-600R with the included A310-300', detectedIniBuildsA300NotA310?.id !== 'inibuilds-a310');

const tfdiMd11IdentityCases = [
  ['TFDi Design MD-11 Passenger GE', undefined],
  ['TFDi MD11 Freighter PW', undefined],
  [
    'Unknown repaint',
    'Community/tfdidesign-aircraft-md11/SimObjects/Airplanes/TFDi_Design_MD-11_GE/aircraft.cfg',
  ],
  [
    'Unknown repaint',
    'Community/repaint/SimObjects/Airplanes/TFDi_Design_MD-11_PW/aircraft.cfg',
  ],
];
test(
  'Detects TFDi Design MD-11 only from TFDi-qualified title or official path evidence',
  tfdiMd11IdentityCases.every(([title, hint]) => (
    loader.detectProfile(title, hint ? { hint } : undefined)?.id === 'tfdi-md-11'
  ))
);

const tfdiMd11CollisionCases = [
  ['McDonnell Douglas MD-11', undefined],
  ['Rotate MD-11', undefined],
  ['Sky Simulations MD-11', undefined],
  ['PMDG MD-11', undefined],
  ['TFDi Design MD-10', undefined],
  ['TFDi Design DC-10', undefined],
  [
    'FSLTL_MD11F_ZZZZ',
    'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_MD11F_ZZZZ/aircraft.cfg',
  ],
  [
    'Unknown repaint',
    'Community/generic-aircraft-md11/SimObjects/Airplanes/MD11/aircraft.cfg',
  ],
];
test(
  'TFDi MD-11 matcher rejects generic, competing-vendor, adjacent-model, and FSLTL AI identities',
  tfdiMd11CollisionCases.every(([title, hint]) => (
    loader.detectProfile(title, hint ? { hint } : undefined)?.id !== 'tfdi-md-11'
  ))
);

const fbwA380xIdentityCases = [
  ['FlyByWire A380X', undefined],
  ['FBW A380X', undefined],
  ['FlyByWire A380X (A380-842)', undefined],
  ['FlyByWire A380X (A380-842) No Cabin', undefined],
  [
    'Unknown repaint',
    'Community/flybywire-aircraft-a380-842/SimObjects/Airplanes/FlyByWire_A380_842/aircraft.cfg',
  ],
  [
    'Unknown repaint',
    'Community/fbw-a380x/SimObjects/Airplanes/FlyByWire_A380_842/aircraft.cfg',
  ],
  [
    'Unknown repaint',
    'SimObjects/Airplanes/FlyByWire_A380X/presets/flybywire/FlyByWire_A380_842_NoCabin/config/aircraft.cfg',
  ],
];
test(
  'Detects FlyByWire A380X only from vendor-qualified titles or documented package paths',
  fbwA380xIdentityCases.every(([title, hint]) => (
    loader.detectProfile(title, hint ? { hint } : undefined)?.id === 'fbw-a380x'
  ))
);

const fbwA380xCollisionCases = [
  ['A380X', undefined],
  ['Airbus A380X', undefined],
  ['Generic A380X', undefined],
  ['Headwind A380X', undefined],
  ['iniBuilds Airbus A380X', undefined],
  ['SomeVendor FlyByWire A380X', undefined],
  ['FlyByWire A380X SomeVendor', undefined],
  ['FSLTL FlyByWire A380X', undefined],
  [
    'FlyByWire A380X',
    'Community/headwind-aircraft-a380x/SimObjects/Airplanes/Headwind_A380X/aircraft.cfg',
  ],
  [
    'Unknown repaint',
    'Community/generic-aircraft-a380x/SimObjects/Airplanes/A380X/aircraft.cfg',
  ],
  [
    'Unknown repaint',
    'Community/somevendor/SimObjects/Airplanes/FlyByWire_A380X_Copy/aircraft.cfg',
  ],
];
test(
  'FlyByWire A380X matcher rejects bare, generic, competing-vendor, traffic, and conflicting-path identities',
  fbwA380xCollisionCases.every(([title, hint]) => (
    loader.detectProfile(title, hint ? { hint } : undefined)?.id !== 'fbw-a380x'
  ))
);

const detectedMicrosoftIniBuildsA320neoV2 = loader.detectProfile('Airbus A320neo (v2) - Microsoft / iniBuilds');
test(
  'Detects the observed Microsoft / iniBuilds Airbus A320neo V2 aircraft-card title',
  detectedMicrosoftIniBuildsA320neoV2?.id === 'inibuilds-a320neo-v2'
);

const detectedMicrosoftIniBuildsA321lr = loader.detectProfile('Airbus A321LR - Microsoft / iniBuilds');
test(
  'Detects the observed Microsoft / iniBuilds Airbus A321LR aircraft-card title',
  detectedMicrosoftIniBuildsA321lr?.id === 'inibuilds-a321lr'
);

const detectedMicrosoftIniBuildsA320neoV2FromPath = loader.detectProfile('Unknown repaint', {
  hint: 'Official/StreamedPackages/fs24-microsoft-aircraft-a320neo/SimObjects/Airplanes/microsoft-a320neo/aircraft.cfg',
});
test(
  'Detects the A320neo V2 from documented package and SimObject identifiers',
  detectedMicrosoftIniBuildsA320neoV2FromPath?.id === 'inibuilds-a320neo-v2'
);

const detectedMicrosoftIniBuildsA321lrFromPath = loader.detectProfile('Unknown repaint', {
  hint: 'Official/StreamedPackages/fs24-microsoft-aircraft-a321/SimObjects/Airplanes/microsoft-a321/aircraft.cfg',
});
test(
  'Detects the A321LR from documented package and SimObject identifiers',
  detectedMicrosoftIniBuildsA321lrFromPath?.id === 'inibuilds-a321lr'
);

test(
  'Microsoft / iniBuilds A32x identities do not cross-match their sibling profile',
  detectedMicrosoftIniBuildsA320neoV2?.id !== 'inibuilds-a321lr' &&
    detectedMicrosoftIniBuildsA321lr?.id !== 'inibuilds-a320neo-v2' &&
    detectedMicrosoftIniBuildsA320neoV2FromPath?.id !== 'inibuilds-a321lr' &&
    detectedMicrosoftIniBuildsA321lrFromPath?.id !== 'inibuilds-a320neo-v2'
);

const microsoftIniBuildsA32xCollisionCases = [
  ['Fenix A320neo', undefined, 'inibuilds-a320neo-v2'],
  ['Airbus A320neo V2', undefined, 'inibuilds-a320neo-v2'],
  ['Airbus A320neo (v2)', undefined, 'inibuilds-a320neo-v2'],
  ['Fenix Airbus A320neo V2', undefined, 'inibuilds-a320neo-v2'],
  ['FlyByWire Airbus A320neo (v2)', undefined, 'inibuilds-a320neo-v2'],
  ['LatinVFR Airbus A320neo V2', undefined, 'inibuilds-a320neo-v2'],
  ['SomeVendor Airbus A320neo V2 - Microsoft / iniBuilds', undefined, 'inibuilds-a320neo-v2'],
  ['Airbus A320neo V2 - Microsoft / iniBuilds SomeVendor', undefined, 'inibuilds-a320neo-v2'],
  ['FSLTL Airbus A320neo V2 - Microsoft / iniBuilds', undefined, 'inibuilds-a320neo-v2'],
  [
    'Airbus A320neo (v2) - Microsoft / iniBuilds',
    'Community/fenix-aircraft-a320/SimObjects/Airplanes/Fenix_A320/aircraft.cfg',
    'inibuilds-a320neo-v2',
  ],
  ['Airbus A320neo', 'Community/flybywire-aircraft-a320-neo/SimObjects/Airplanes/FlyByWire_A320_NEO/aircraft.cfg', 'inibuilds-a320neo-v2'],
  ['Asobo_A320_NEO', 'Official/OneStore/asobo-aircraft-a320-neo/SimObjects/Airplanes/Asobo_A320_NEO/aircraft.cfg', 'inibuilds-a320neo-v2'],
  ['Airbus A320neo', undefined, 'inibuilds-a320neo-v2'],
  ['Airbus A320ceo', undefined, 'inibuilds-a320neo-v2'],
  ['Microsoft A20N', undefined, 'inibuilds-a320neo-v2'],
  ['Fenix Simulations Airbus A321 LR', undefined, 'inibuilds-a321lr'],
  ['LatinVFR Airbus A321LR', 'Community/latinvfr-aircraft-a321neo/SimObjects/Airplanes/LVFR_A321neo/aircraft.cfg', 'inibuilds-a321lr'],
  ['Airbus A321LR', undefined, 'inibuilds-a321lr'],
  ['Airbus A321neo', undefined, 'inibuilds-a321lr'],
  ['Airbus A321ceo', undefined, 'inibuilds-a321lr'],
  ['Microsoft A21N', undefined, 'inibuilds-a321lr'],
];
test(
  'Microsoft / iniBuilds A32x matchers reject legacy, vendor, and model collisions',
  microsoftIniBuildsA32xCollisionCases.every(([title, hint, forbiddenId]) => (
    loader.detectProfile(title, hint ? { hint } : undefined)?.id !== forbiddenId
  ))
);

const detectedIfly737Max8 = loader.detectProfile('iFly Boeing 737 MAX 8');
test('Detects iFly 737 MAX 8 separately from PMDG 737', detectedIfly737Max8?.id === 'ifly-737-max-8');

const detectedNonIfly737Max8 = loader.detectProfile('Boeing 737 MAX 8');
test('Detects included MSFS 2024 737 MAX 8 without iFly identity', detectedNonIfly737Max8?.id === 'microsoft-737-max-8');

const detectedAsoboUnderscore737Max8 = loader.detectProfile('Asobo_B737_MAX8');
test('Detects included 737 MAX 8 from the Asobo underscore title', detectedAsoboUnderscore737Max8?.id === 'microsoft-737-max-8');

const detectedMicrosoft737Max8FromRuntimePath = loader.detectProfile('Unknown repaint', {
  hint: 'SimObjects\\Airplanes\\Asobo_B737_MAX8\\aircraft.cfg',
});
test(
  'Detects included 737 MAX 8 from the narrowly supported partial AircraftLoaded path shape',
  detectedMicrosoft737Max8FromRuntimePath?.id === 'microsoft-737-max-8',
);

const detectedGeneric737800 = loader.detectProfile('Boeing 737-800');
test('Does not confuse a generic 737-800 with the Microsoft 737 MAX 8', detectedGeneric737800?.id !== 'microsoft-737-max-8');

const microsoft737MaxCollisionCases = [
  ['PMDG Boeing 737 MAX 8', undefined],
  ['Bredok3D Boeing 737 MAX 8', undefined],
  ['FSLTL Boeing 737 MAX 8', undefined],
  ['iFly Boeing 737 MAX 8', undefined],
  ['Unknown repaint', 'Community/bredok3d-aircraft-b737max8/SimObjects/Airplanes/B737MAX8/aircraft.cfg'],
  ['Unknown traffic', 'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B38M/aircraft.cfg'],
  ['Unknown repaint', 'SimObjects/Airplanes/Asobo_B737_MAX80/aircraft.cfg'],
  ['Unknown repaint', 'SimObjects/Airplanes/Asobo_B737_MAX9/aircraft.cfg'],
];
test(
  'Microsoft 737 MAX 8 matcher rejects explicit third-party and traffic identities',
  microsoft737MaxCollisionCases.every(([title, hint]) => (
    loader.detectProfile(title, hint ? { hint } : undefined)?.id !== 'microsoft-737-max-8'
  ))
);

const detectedMicrosoftAtr72 = loader.detectProfile('Microsoft ATR 72-600');
test('Detects Microsoft / S&H ATR 72-600 from official product title', detectedMicrosoftAtr72?.id === 'microsoft-atr-72-600');

const detectedMicrosoftAtr72FromPath = loader.detectProfile('ATR 72-600', {
  hint: 'Official/OneStore/microsoft-aircraft-atr-72-600/SimObjects/Airplanes/ATR72/aircraft.cfg',
});
test('Detects Microsoft / S&H ATR 72-600 from official package path', detectedMicrosoftAtr72FromPath?.id === 'microsoft-atr-72-600');

const detectedMicrosoftAtr42 = loader.detectProfile('Microsoft ATR 42-600', {
  hint: 'Official/OneStore/microsoft-atr-common-pack/SimObjects/Airplanes/ATR42-600/aircraft.cfg',
});
test('Does not confuse the ATR 42-600 with the ATR 72-600 profile', detectedMicrosoftAtr42?.id !== 'microsoft-atr-72-600');

const microsoftAtrFreighterCollisionCases = [
  ['Microsoft ATR 72-600F', undefined],
  ['Microsoft ATR 72 600 F', undefined],
  ['Unknown repaint', 'Official/OneStore/microsoft-aircraft-atr72-600f/SimObjects/Airplanes/ATR72-600F/aircraft.cfg'],
];
test(
  'Microsoft ATR passenger matcher rejects ATR 72-600F title and package variants',
  microsoftAtrFreighterCollisionCases.every(([title, hint]) => (
    loader.detectProfile(title, hint ? { hint } : undefined)?.id !== 'microsoft-atr-72-600'
  ))
);

const detectedJustFlight146 = loader.detectProfile('Just Flight BAe 146-300 QT');
test('Detects Just Flight 146 specifically', detectedJustFlight146?.id === 'justflight-146');

const detectedWorkingTitle747UnderscoreTitle = loader.detectProfile('Asobo_B747_8i');
test(
  'Detects included Microsoft/Asobo 747-8 from its first-party underscore title',
  detectedWorkingTitle747UnderscoreTitle?.id === 'workingtitle-747-8'
);

const detectedObservedMicrosoft747Title = loader.detectProfile('747-8i');
test(
  'Detects the stock 747-8i SimConnect title',
  detectedObservedMicrosoft747Title?.id === 'workingtitle-747-8'
);

const detectedWorkingTitleMicrosoft747Title = loader.detectProfile('Boeing 747-8 - Working Title Simulations');
test(
  'Detects the stock 747-8 aircraft-selector identity',
  detectedWorkingTitleMicrosoft747Title?.id === 'workingtitle-747-8'
);

const detectedCanonicalMicrosoft747Titles = [
  'Microsoft / Asobo Studio Boeing 747-8i',
  'Microsoft / Asobo Studio Boeing 747-8i / 747-8F',
  'Boeing 747-8i (-8F)',
  'Boeing 747-8i & 8f',
].map((title) => loader.detectProfile(title));
test(
  'Detects canonical display and official combined names for the stock 747-8',
  detectedCanonicalMicrosoft747Titles.every((profile) => profile?.id === 'workingtitle-747-8'),
);

const detectedMicrosoft747FromPath = loader.detectProfile('Unknown repaint', {
  hint: 'SimObjects/Airplanes/asobo_b747_8i/aircraft.cfg',
});
test('Detects the stock 747-8 from its verified MSFS 2024 SimObject path', detectedMicrosoft747FromPath?.id === 'workingtitle-747-8');

const rejected747Cases = [
  ['Boeing 747 Intercontinental', undefined],
  ['Boeing 747-8', undefined],
  ['Boeing 747-400', undefined],
  ['Boeing 747-400 LCF Dreamlifter', undefined],
  ['Boeing 747-400 Global Supertanker', undefined],
  ['Salty Boeing 747-8i', 'Community/salty-747/SimObjects/Airplanes/Salty_B747_8i/aircraft.cfg'],
  ['Salty Asobo_B747_8i', undefined],
  ['FSLTL_B748_DLHX', 'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B748_DLHX/aircraft.cfg'],
  ['Asobo PassiveAircraft B747-8i', 'Official/StreamedPackages/fs24-asobo-passiveaircraft-b747family/SimObjects/Airplanes/Passive_B747_8i/aircraft.cfg'],
  ['747-8i', 'Community/salty-747/SimObjects/Airplanes/Salty_B747_8i/aircraft.cfg'],
  ['Unknown repaint', 'Community/fs24-asobo-aircraft-b7478i/SimObjects/Airplanes/asobo_b747_8i/aircraft.cfg'],
];
test(
  'Stock 747-8 matcher rejects ambiguous, 747-400, Salty, FSLTL, and passive-aircraft identities',
  rejected747Cases.every(([title, hint]) => loader.detectProfile(title, hint ? { hint } : undefined)?.id !== 'workingtitle-747-8')
);

const detectedMicrosoft787Title = loader.detectProfile('Boeing 787-10 Dreamliner');
test('Detects the exact stock 787-10 product title', detectedMicrosoft787Title?.id === 'asobo-787');

const detectedCanonicalMicrosoft787Title = loader.detectProfile('Microsoft / Asobo Studio Boeing 787-10 Dreamliner');
test('Detects the canonical display name for the stock 787-10', detectedCanonicalMicrosoft787Title?.id === 'asobo-787');

const detectedWorkingTitleMicrosoft787Title = loader.detectProfile('Boeing 787-10 Dreamliner - Working Title Simulations');
test('Detects the stock 787-10 aircraft-selector identity', detectedWorkingTitleMicrosoft787Title?.id === 'asobo-787');

const detectedMicrosoft787FromPath = loader.detectProfile('Unknown repaint', {
  hint: 'SimObjects/Airplanes/asobo_b787/aircraft.cfg',
});
test('Detects the stock 787-10 from its verified MSFS 2024 SimObject path', detectedMicrosoft787FromPath?.id === 'asobo-787');

const rejected787Cases = [
  ['Dreamliner', undefined],
  ['Boeing 787-8 Dreamliner', undefined],
  ['Boeing 787-9 Dreamliner', undefined],
  ['Heavy Division B78XH', undefined],
  ['QualityWings Boeing 787-10', undefined],
  ['Horizon Asobo_B787_10', 'SimObjects/Airplanes/Asobo_B787_10/aircraft.cfg'],
  ['FSLTL_B78X_UAE', 'Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B78X_UAE/aircraft.cfg'],
  ['Asobo PassiveAircraft B787-10', 'Official/StreamedPackages/fs24-asobo-passiveaircraft-b787family/SimObjects/Airplanes/Passive_B787_10/aircraft.cfg'],
  ['Boeing 787-10 Dreamliner', 'Community/heavy-division-b78xh/SimObjects/Airplanes/Asobo_B787_10/aircraft.cfg'],
  ['Unknown repaint', 'Community/asobo-aircraft-b787-10/SimObjects/Airplanes/asobo_b787/aircraft.cfg'],
];
test(
  'Stock 787-10 matcher rejects bare Dreamliner, adjacent variants, community vendors, traffic, and passive aircraft',
  rejected787Cases.every(([title, hint]) => loader.detectProfile(title, hint ? { hint } : undefined)?.id !== 'asobo-787')
);

const detectedPmdg737FromHintPath = loader.detectProfile('737-800 PAX SSW TC', {
  hint: 'SimObjects/Airplanes/PMDG 737-800/aircraft.cfg',
});
test('Deferred PMDG 737 path falls back to generic', detectedPmdg737FromHintPath?.id === 'generic');

const pmdg737LogConfigPath = 'SimObjects\\Airplanes\\PMDG 737-800\\presets\\pmdg\\PMDG 737-800 SSW TC\\config\\aircraft.CFG';
const detectedPmdg737FromLoadedPath = loader.detectProfile(pmdg737LogConfigPath, {
  hint: pmdg737LogConfigPath,
});
test('Deferred PMDG 737 loaded path falls back to generic', detectedPmdg737FromLoadedPath?.id === 'generic');

const legacyCommunityRootDir = path.join(retiredAircraftProfilesDir, 'Community');
const legacyCommunityPmdg737Path = path.join(legacyCommunityRootDir, 'pmdg-737.json');
const migratedLocalPmdg737Path = path.join(retiredLocalProfilesDir, 'msfs', 'pmdg-737.json');
fs.mkdirSync(legacyCommunityRootDir, { recursive: true });

fs.writeFileSync(legacyCommunityPmdg737Path, JSON.stringify({ notAProfile: true }, null, 2), 'utf8');
try {
  loader.clearCache();
  const detectedWithInvalidLegacyShadow = loader.detectProfile(pmdg737LogConfigPath, {
    hint: pmdg737LogConfigPath,
  });
  test(
    'Invalid legacy-root community PMDG 737 file does not create an integration',
    detectedWithInvalidLegacyShadow?._qualifiedId === 'bundled/msfs/generic'
  );
} finally {
  fs.unlinkSync(legacyCommunityPmdg737Path);
  loader.clearCache();
}

fs.writeFileSync(legacyCommunityPmdg737Path, JSON.stringify({
  version: 1,
  id: 'pmdg-737',
  name: 'Legacy Community PMDG Boeing 737',
  namespace: 'community',
  extends: 'boeing-base',
  aircraftCategory: 'C',
  matching: {
    priority: 100,
    titleContains: [
      'PMDG 737',
      'PMDG B737',
      'PMDG Boeing 737',
    ],
    titleRegex: '(pmdg).*(737|b737)|(737|b737).*(pmdg)',
  },
}, null, 2), 'utf8');
try {
  loader.clearCache();
  const listedWithLegacyCommunity = loader.listProfiles();
  test(
    'listProfiles does not migrate legacy-root community profiles into local',
    !listedWithLegacyCommunity.some(p => p.qualifiedId === 'local/msfs/pmdg-737') &&
      !fs.existsSync(migratedLocalPmdg737Path)
  );
  test(
    'listProfiles does not expose legacy-root community profiles as community namespace',
    !listedWithLegacyCommunity.some(p => p.namespace === 'community')
  );

  const resolvedLegacyCommunityLocator = loader.resolveProfilePath('community/msfs/pmdg-737');
  test(
    'Legacy community locator does not create or resolve a local profile',
    resolvedLegacyCommunityLocator === null && !fs.existsSync(migratedLocalPmdg737Path)
  );

  const detectedWithLegacyCommunity = loader.detectProfile(pmdg737LogConfigPath, {
    hint: pmdg737LogConfigPath,
  });
  test(
    'Legacy community PMDG 737 profile cannot silently activate',
    detectedWithLegacyCommunity?._qualifiedId === 'bundled/msfs/generic' &&
      !fs.existsSync(migratedLocalPmdg737Path)
  );
} finally {
  fs.unlinkSync(legacyCommunityPmdg737Path);
  if (fs.existsSync(migratedLocalPmdg737Path)) fs.unlinkSync(migratedLocalPmdg737Path);
  loader.clearCache();
}

const detectedGeneric737FromNonVendorHint = loader.detectProfile('737-800 PAX SSW TC', {
  hint: 'SimObjects/Airplanes/Asobo_B737_800/aircraft.cfg',
});
test('Does not mis-detect PMDG 737 from non-PMDG config-path hint', detectedGeneric737FromNonVendorHint?.id !== 'pmdg-737');

const detectedGenericB788FromTitle = loader.detectProfile('Boeing 787-8');
test('Does not detect Kuro 787-8 from generic 787-8 title alone', detectedGenericB788FromTitle?.id !== 'kuro-787-8');

const detectedKuro787FromTitle = loader.detectProfile('Kuro 787-8');
test('Detects Kuro 787-8 when vendor evidence is present in title', detectedKuro787FromTitle?.id === 'kuro-787-8');

const cfgFallbackDir = path.join(tempRoot, 'aircraft-cfg-fallback');
fs.mkdirSync(cfgFallbackDir, { recursive: true });

function detectFromStructuredA32xAircraftCfg(lines, relativeDirectory = '') {
  const cfgDirectory = path.join(cfgFallbackDir, relativeDirectory);
  fs.mkdirSync(cfgDirectory, { recursive: true });
  const cfgPath = path.join(cfgDirectory, 'aircraft.cfg');
  fs.writeFileSync(cfgPath, lines.join('\n'), 'utf8');
  try {
    loader.clearCache();
    return loader.detectProfile('Unknown repaint', { hint: cfgPath });
  } finally {
    fs.unlinkSync(cfgPath);
    loader.clearCache();
  }
}

const detectedMicrosoft747FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "B748"',
  '[FLTSIM.0]',
  'title = "Asobo_B747_8i"',
  'ui_type = "747-8i"',
  'ui_createdby = "Asobo Studio"',
  'isairtraffic = 0',
  'isuserselectable = 1',
]);
test('Detects the flyable stock 747-8 from exact B748 plus first-party structured metadata', detectedMicrosoft747FromCfgMetadata?.id === 'workingtitle-747-8');

const rejectedMicrosoft747FromConflictingPathAndCfg = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "B748"',
  '[FLTSIM.0]',
  'title = "Asobo_B747_8i"',
  'ui_type = "747-8i"',
  'ui_createdby = "Asobo Studio"',
  'isairtraffic = 0',
  'isuserselectable = 1',
], path.join('Community', 'salty-747'));
test(
  'A conflicting Community path vetoes even first-party-looking 747 title and structured metadata',
  rejectedMicrosoft747FromConflictingPathAndCfg?.id !== 'workingtitle-747-8',
);

const rejectedFsltl747FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "B748"',
  '[FLTSIM.0]',
  'title = "FSLTL_B748_DLHX"',
  'ui_type = "BOEING B748"',
  'ui_createdby = "FSLTL"',
  'isairtraffic = 1',
  'isuserselectable = 0',
]);
test('Does not promote FSLTL B748 traffic from a shared ICAO designator', rejectedFsltl747FromCfgMetadata?.id !== 'workingtitle-747-8');

const rejectedPassive747FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "B748"',
  '[FLTSIM.0]',
  'title = "Asobo PassiveAircraft B747-8i"',
  'ui_type = "747-8i"',
  'ui_createdby = "Asobo Studio"',
  'isairtraffic = 1',
  'isuserselectable = 0',
]);
test('Does not promote Asobo passive B748 assets despite their first-party creator', rejectedPassive747FromCfgMetadata?.id !== 'workingtitle-747-8');

const detectedMicrosoft787FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "B78X"',
  '[FLTSIM.0]',
  'title = "Asobo_B787_10"',
  'ui_type = "787-10 Dreamliner"',
  'ui_createdby = "Asobo Studio"',
  'isairtraffic = 0',
  'isuserselectable = 1',
]);
test('Detects the flyable stock 787-10 from exact B78X plus first-party structured metadata', detectedMicrosoft787FromCfgMetadata?.id === 'asobo-787');

const rejectedMicrosoft787FromConflictingPathAndCfg = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "B78X"',
  '[FLTSIM.0]',
  'title = "Asobo_B787_10"',
  'ui_type = "787-10 Dreamliner"',
  'ui_createdby = "Asobo Studio"',
  'isairtraffic = 0',
  'isuserselectable = 1',
], path.join('Community', 'heavy-division-b78xh'));
test(
  'A conflicting Community path vetoes even first-party-looking 787 title and structured metadata',
  rejectedMicrosoft787FromConflictingPathAndCfg?.id !== 'asobo-787',
);

const rejectedFsltl787FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "B78X"',
  '[FLTSIM.0]',
  'title = "FSLTL_B78X_UAE"',
  'ui_type = "BOEING B78X"',
  'ui_createdby = "FSLTL"',
  'isairtraffic = 1',
  'isuserselectable = 0',
]);
test('Does not promote FSLTL B78X traffic from a shared ICAO designator', rejectedFsltl787FromCfgMetadata?.id !== 'asobo-787');

const rejectedPassive787FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "B78X"',
  '[FLTSIM.0]',
  'title = "Asobo PassiveAircraft B787-10"',
  'ui_type = "787-10 Dreamliner"',
  'ui_createdby = "Asobo Studio"',
  'isairtraffic = 1',
  'isuserselectable = 0',
]);
test('Does not promote Asobo passive B78X assets despite their first-party creator', rejectedPassive787FromCfgMetadata?.id !== 'asobo-787');

const detectedTfdiMd11FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "MD11"',
  'icao_manufacturer = "MCDONNELL-DOUGLAS"',
  'icao_model = "MD-11"',
  '[FLTSIM.0]',
  'title = "TFDi_Design_MD-11_GE"',
  'ui_manufacturer = "McDonnell-Douglas"',
  'ui_type = "MD-11 Passenger GE"',
  'ui_createdby = "TFDi Design"',
]);
test(
  'Detects TFDi Design MD-11 from structured MD11 plus TFDi aircraft.cfg metadata',
  detectedTfdiMd11FromCfgMetadata?.id === 'tfdi-md-11'
);

const detectedFsltlMd11FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "MD11"',
  'icao_manufacturer = "MCDONNELL-DOUGLAS"',
  'icao_model = "MD-11F"',
  '[FLTSIM.0]',
  'title = "FSLTL_MD11F_ZZZZ"',
  'ui_manufacturer = "MCDONNELL-DOUGLAS"',
  'ui_type = "MCDONNELL-DOUGLAS MD11F"',
  'ui_createdby = "FSLTL"',
]);
test(
  'Does not promote an FSLTL AI MD11 from bare structured ICAO metadata',
  detectedFsltlMd11FromCfgMetadata?.id !== 'tfdi-md-11'
);

const detectedMicrosoftA320neoV2FromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "A20N"',
  'icao_manufacturer = "AIRBUS"',
  'icao_model = "A320neo V2"',
  '[FLTSIM.0]',
  'title = "Airbus A320neo (V2)"',
  'ui_manufacturer = "Airbus"',
  'ui_type = "A320neo V2"',
  'ui_createdby = "Microsoft / iniBuilds"',
]);
test(
  'Detects Microsoft / iniBuilds A320neo V2 from structured aircraft.cfg metadata',
  detectedMicrosoftA320neoV2FromCfgMetadata?.id === 'inibuilds-a320neo-v2'
);

const detectedMicrosoftA321lrFromCfgMetadata = detectFromStructuredA32xAircraftCfg([
  '[GENERAL]',
  'icao_type_designator = "A21N"',
  'icao_manufacturer = "AIRBUS"',
  'icao_model = "A321LR"',
  '[FLTSIM.0]',
  'title = "Airbus A321LR"',
  'ui_manufacturer = "Airbus"',
  'ui_type = "A321LR"',
  'ui_createdby = "Microsoft / iniBuilds"',
]);
test(
  'Detects Microsoft / iniBuilds A321LR from structured aircraft.cfg metadata',
  detectedMicrosoftA321lrFromCfgMetadata?.id === 'inibuilds-a321lr'
);

const structuredA32xCollisionCases = [
  {
    name: 'legacy Microsoft A320neo',
    forbiddenId: 'inibuilds-a320neo-v2',
    lines: [
      '[GENERAL]',
      'icao_type_designator = "A20N"',
      '[FLTSIM.0]',
      'title = "Airbus A320 Neo"',
      'ui_createdby = "Microsoft Corporation"',
    ],
  },
  {
    name: 'FlyByWire A32NX',
    expectedId: 'fbw-a32nx',
    forbiddenId: 'inibuilds-a320neo-v2',
    lines: [
      '[GENERAL]',
      'icao_type_designator = "A20N"',
      '[FLTSIM.0]',
      'title = "Airbus A320 Neo FlyByWire"',
      'ui_createdby = "FlyByWire Simulations"',
    ],
  },
  {
    name: 'Fenix A320',
    expectedId: 'fenix-a320',
    forbiddenId: 'inibuilds-a320neo-v2',
    lines: [
      '[GENERAL]',
      'icao_type_designator = "A20N"',
      '[FLTSIM.0]',
      'title = "Fenix A320neo V2"',
      'ui_createdby = "Fenix Simulations"',
    ],
  },
  {
    name: 'LatinVFR A321LR',
    forbiddenId: 'inibuilds-a321lr',
    lines: [
      '[GENERAL]',
      'icao_type_designator = "A21N"',
      '[FLTSIM.0]',
      'title = "LatinVFR Airbus A321LR"',
      'ui_createdby = "LatinVFR"',
    ],
  },
  {
    name: 'Fenix A321',
    expectedId: 'fenix-a321',
    forbiddenId: 'inibuilds-a321lr',
    lines: [
      '[GENERAL]',
      'icao_type_designator = "A21N"',
      '[FLTSIM.0]',
      'title = "Fenix Simulations Airbus A321 LR"',
      'ui_createdby = "Fenix Simulations"',
    ],
  },
];
for (const collisionCase of structuredA32xCollisionCases) {
  const detected = detectFromStructuredA32xAircraftCfg(collisionCase.lines);
  test(
    `Structured ${collisionCase.name} metadata does not activate the Microsoft / iniBuilds profile`,
    detected?.id !== collisionCase.forbiddenId &&
      (!collisionCase.expectedId || detected?.id === collisionCase.expectedId)
  );
}

const workingTitle747CfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(workingTitle747CfgPath, [
  '[GENERAL]',
  'icao_type_designator = "B748"',
  'icao_manufacturer = "BOEING"',
  'icao_model = "747-8 Intercontinental"',
  '[FLTSIM.0]',
  'title = "Asobo_B747_8i"',
  'ui_manufacturer = "Boeing"',
  'ui_type = "747-8 Intercontinental"',
  'ui_createdby = "Asobo Studio"',
  'isairtraffic = 0',
  'isuserselectable = 1',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedWorkingTitle747FromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: workingTitle747CfgPath,
  });
  test(
    'Detects Microsoft / Asobo 747-8 from structured aircraft.cfg metadata',
    detectedWorkingTitle747FromCfgMetadata?.id === 'workingtitle-747-8'
  );
} finally {
  fs.unlinkSync(workingTitle747CfgPath);
  loader.clearCache();
}

const genericBoeingCfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(genericBoeingCfgPath, [
  '[fltsim.0]',
  'title=Boeing 777-200LR',
  'ui_manufacturer=Boeing',
  'ui_type=777-200LR',
  'atc_model=B772',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedGenericBoeingFromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: genericBoeingCfgPath,
  });
  test(
    'Does not promote generic aircraft.cfg model metadata to PMDG 777',
    detectedGenericBoeingFromCfgMetadata?.id !== 'pmdg-777'
  );
} finally {
  fs.unlinkSync(genericBoeingCfgPath);
  loader.clearCache();
}

const kuro787CfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(kuro787CfgPath, [
  '[GENERAL]',
  'icao_type_designator = "B788"',
  'icao_manufacturer = "BOEING"',
  'icao_model = "787-8 Dreamliner"',
  '[FLTSIM.0]',
  'title = "Kuro_B787-8"',
  'ui_manufacturer = "Boeing"',
  'ui_type = "787-8 Dreamliner"',
  'ui_createdby = "Kurorin"',
  'isairtraffic = 0',
  'isuserselectable = 1',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedKuroFromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: kuro787CfgPath,
  });
  test(
    'Detects Kuro 787-8 from structured aircraft.cfg metadata',
    detectedKuroFromCfgMetadata?.id === 'kuro-787-8'
  );
} finally {
  fs.unlinkSync(kuro787CfgPath);
  loader.clearCache();
}

const genericB788CfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(genericB788CfgPath, [
  '[GENERAL]',
  'icao_type_designator = "B788"',
  'icao_manufacturer = "BOEING"',
  'icao_model = "787-8 Dreamliner"',
  '[FLTSIM.0]',
  'title = "Boeing 787-8"',
  'ui_manufacturer = "Boeing"',
  'ui_type = "787-8 Dreamliner"',
  'ui_createdby = "Asobo"',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedGenericB788FromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: genericB788CfgPath,
  });
  test(
    'Does not promote generic B788 aircraft.cfg metadata to Kuro 787-8',
    detectedGenericB788FromCfgMetadata?.id !== 'kuro-787-8'
  );
} finally {
  fs.unlinkSync(genericB788CfgPath);
  loader.clearCache();
}

const microsoft737MaxCfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(microsoft737MaxCfgPath, [
  '[GENERAL]',
  'icao_type_designator = "B38M"',
  'icao_manufacturer = "BOEING"',
  'icao_model = "737 MAX 8"',
  '[FLTSIM.0]',
  'title = "Asobo_B737_MAX8"',
  'ui_manufacturer = "Boeing"',
  'ui_type = "737 MAX 8"',
  'ui_createdby = "Asobo Studio"',
  'isairtraffic = 0',
  'isuserselectable = 1',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedMicrosoft737MaxFromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: microsoft737MaxCfgPath,
  });
  test(
    'Detects Microsoft 737 MAX 8 from structured aircraft.cfg metadata',
    detectedMicrosoft737MaxFromCfgMetadata?.id === 'microsoft-737-max-8'
  );
} finally {
  fs.unlinkSync(microsoft737MaxCfgPath);
  loader.clearCache();
}

const thirdParty737MaxCfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(thirdParty737MaxCfgPath, [
  '[GENERAL]',
  'icao_type_designator = "B38M"',
  'icao_manufacturer = "BOEING"',
  'icao_model = "737 MAX 8"',
  '[FLTSIM.0]',
  'title = "Bredok3D Boeing 737 MAX 8"',
  'ui_manufacturer = "Boeing"',
  'ui_type = "737 MAX 8"',
  'ui_createdby = "Microsoft / Asobo Studio"',
  'isairtraffic = 0',
  'isuserselectable = 1',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedThirdParty737MaxFromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: thirdParty737MaxCfgPath,
  });
  test(
    'Does not activate the trusted Microsoft 737 MAX adapter from third-party aircraft.cfg metadata',
    detectedThirdParty737MaxFromCfgMetadata?.id !== 'microsoft-737-max-8'
  );
} finally {
  fs.unlinkSync(thirdParty737MaxCfgPath);
  loader.clearCache();
}

const microsoftA310CfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(microsoftA310CfgPath, [
  '[GENERAL]',
  'icao_type_designator = "A310"',
  'icao_manufacturer = "AIRBUS"',
  'icao_model = "A310-300"',
  '[FLTSIM.0]',
  'title = "Microsoft Airbus A310-300"',
  'ui_manufacturer = "Airbus"',
  'ui_type = "A310-300"',
  'ui_createdby = "Microsoft / iniBuilds"',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedMicrosoftA310FromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: microsoftA310CfgPath,
  });
  test(
    'Detects Microsoft / iniBuilds A310-300 from structured aircraft.cfg metadata',
    detectedMicrosoftA310FromCfgMetadata?.id === 'inibuilds-a310'
  );
} finally {
  fs.unlinkSync(microsoftA310CfgPath);
  loader.clearCache();
}

const microsoftAtr72CfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(microsoftAtr72CfgPath, [
  '[GENERAL]',
  'icao_type_designator = "AT76"',
  'icao_manufacturer = "ATR"',
  'icao_model = "72-600"',
  '[FLTSIM.0]',
  'title = "Microsoft ATR 72-600"',
  'ui_manufacturer = "ATR"',
  'ui_type = "ATR 72-600"',
  'ui_createdby = "Microsoft / S&H Software"',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedMicrosoftAtr72FromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: microsoftAtr72CfgPath,
  });
  test(
    'Detects Microsoft / S&H ATR 72-600 from structured aircraft.cfg metadata',
    detectedMicrosoftAtr72FromCfgMetadata?.id === 'microsoft-atr-72-600'
  );
} finally {
  fs.unlinkSync(microsoftAtr72CfgPath);
  loader.clearCache();
}

const microsoftAtr72FreighterCfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(microsoftAtr72FreighterCfgPath, [
  '[GENERAL]',
  'icao_type_designator = "AT76"',
  'icao_manufacturer = "ATR"',
  'icao_model = "72-600F"',
  '[FLTSIM.0]',
  'title = "Microsoft ATR 72-600F"',
  'ui_manufacturer = "ATR"',
  'ui_type = "ATR 72-600F"',
  'ui_createdby = "Microsoft / S&H Software"',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedMicrosoftAtr72FreighterFromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: microsoftAtr72FreighterCfgPath,
  });
  test(
    'Does not activate the passenger ATR adapter from ATR 72-600F aircraft.cfg metadata',
    detectedMicrosoftAtr72FreighterFromCfgMetadata?.id !== 'microsoft-atr-72-600'
  );
} finally {
  fs.unlinkSync(microsoftAtr72FreighterCfgPath);
  loader.clearCache();
}

const ifly737MaxCfgPath = path.join(cfgFallbackDir, 'aircraft.cfg');
fs.writeFileSync(ifly737MaxCfgPath, [
  '[GENERAL]',
  'icao_type_designator = "B38M"',
  'icao_manufacturer = "BOEING"',
  'icao_model = "737 MAX 8"',
  '[FLTSIM.0]',
  'title = "iFly 737 MAX8"',
  'ui_manufacturer = "iFly"',
  'ui_type = "737 MAX 8"',
  'ui_createdby = "iFly Jets"',
].join('\n'), 'utf8');
try {
  loader.clearCache();
  const detectedIfly737MaxFromCfgMetadata = loader.detectProfile('Unknown repaint', {
    hint: ifly737MaxCfgPath,
  });
  test(
    'Detects iFly 737 MAX 8 from structured aircraft.cfg metadata',
    detectedIfly737MaxFromCfgMetadata?.id === 'ifly-737-max-8'
  );
} finally {
  fs.unlinkSync(ifly737MaxCfgPath);
  loader.clearCache();
}

const xplaneProfileId = `test-xplane-${Date.now()}`;
const xplaneProfileDir = path.join(retiredLocalProfilesDir, 'xplane');
const xplaneProfilePath = path.join(xplaneProfileDir, `${xplaneProfileId}.json`);
fs.mkdirSync(xplaneProfileDir, { recursive: true });
fs.writeFileSync(xplaneProfilePath, JSON.stringify({
  version: 2,
  id: xplaneProfileId,
  name: 'Test X-Plane Profile',
  simulator: 'xplane',
  namespace: 'local',
  abstract: false,
  aircraft: {
    category: 'D'
  },
  integration: {
    matching: {
      priority: 250,
      xplane: {
        acfPaths: ['Aircraft/FlightFactor/777/B777.acf'],
        acfFileNames: ['B777.acf'],
        aliases: ['ff777']
      }
    },
    telemetry: {
      preferred: 'xplane-custom',
      allowGenericFallback: true,
    }
  },
  meta: {
    platforms: ['xplane12'],
    status: 'experimental',
  },
}, null, 2), 'utf8');

try {
  loader.clearCache();
  const detectedXplaneByPath = loader.detectProfile(null, {
    xplane: {
      acfPath: 'Aircraft/FlightFactor/777/B777.acf',
    },
  });
  test('Ignores a Local X-Plane profile even when its exact acfPath matches', detectedXplaneByPath?._qualifiedId === 'bundled/xplane/generic');

  const detectedXplaneByAlias = loader.detectProfile('', {
    xplane: {
      id: 'ff777',
    },
  });
  test('Ignores a Local X-Plane profile even when its identity alias matches', detectedXplaneByAlias?._qualifiedId === 'bundled/xplane/generic');
} finally {
  fs.unlinkSync(xplaneProfilePath);
  loader.clearCache();
}

const detectedZiboXplane = loader.detectProfile(null, {
  xplane: {
    acfPath: 'Aircraft/B737-800X/b738.acf',
  },
});
test('Detects bundled X-Plane Zibo 737-800 from b738 acf path', detectedZiboXplane?.id === 'zibo-737-800');
test('Zibo 737-800 uses category D', detectedZiboXplane?.aircraftCategory === 'D');
test('Zibo 737-800 has X-Plane 737 flap detents', JSON.stringify(detectedZiboXplane?.flaps?.notches?.map((notch) => notch.value)) === '[0,1,2,5,10,15,25,30,40]');

const detectedAmbiguousB738Filename = loader.detectProfile(null, {
  xplane: {
    acfFileName: 'b738.acf',
  },
});
test('Ambiguous X-Plane b738 filename falls back to generic instead of guessing Zibo', detectedAmbiguousB738Filename?.id === 'generic');

const detectedLaminar737 = loader.detectProfile(null, {
  xplane: {
    acfPath: 'Aircraft/Laminar Research/Boeing 737-800/b738.acf',
  },
});
test('Detects bundled X-Plane Laminar 737-800 from default acf path', detectedLaminar737?.id === 'laminar-737-800');
test('Laminar 737-800 has X-Plane 737 flap detents', JSON.stringify(detectedLaminar737?.flaps?.notches?.map((notch) => notch.value)) === '[0,1,2,5,10,15,25,30,40]');

const detectedTolissA320 = loader.detectProfile(null, {
  xplane: {
    acfFileName: 'A320neo.acf',
  },
});
test('Detects bundled X-Plane ToLiss A320 family from A320neo acf filename', detectedTolissA320?.id === 'toliss-a320-family');

section('Active Profile Management');
loader.clearCache();

const active = loader.getActiveProfile();
test('getActiveProfile returns something', active !== null);
test('Active profile has id', typeof active?.id === 'string');

const activeId = loader.getActiveProfileId();
test('getActiveProfileId returns string', typeof activeId === 'string');

loader.setActiveProfile('fbw-a32nx');
const newActive = loader.getActiveProfile();
test('setActiveProfile changes active', newActive?.id === 'fbw-a32nx');

loader.setActiveProfileFromTitle('FlyByWire A32NX');
const autoActive = loader.getActiveProfile();
test('setActiveProfileFromTitle auto-detects', autoActive?.id === 'fbw-a32nx');

section('Config Accessors');
loader.setActiveProfile('fbw-a380x');

const flapsConfig = loader.getFlapsConfig();
test('getFlapsConfig returns flaps', flapsConfig !== null);
test('Flaps config has notches', Array.isArray(flapsConfig?.notches));

const stabilityConfig = loader.getStabilityConfig();
test('getStabilityConfig returns stability', stabilityConfig !== null);
test('Stability has runtime scoring speed band', stabilityConfig?.speedBand !== undefined);

const stabilityCriteria = loader.getStabilityScoringCriteria();
test('getStabilityScoringCriteria maps profile speed band', stabilityCriteria?.speedPlusKts === 15);
test('getStabilityScoringCriteria maps descent limit as negative fpm', stabilityCriteria?.vsMinFpm === -1000);
test('getStabilityScoringCriteria maps profile gate', stabilityCriteria?.gateRaFt === 1000);

const genericCriteria = loader.getStabilityScoringCriteria(loader.loadProfile('generic'));
test('Generic profile keeps permissive stability speed band', genericCriteria?.speedPlusKts === 100);
test('Generic profile keeps permissive descent limit', genericCriteria?.vsMinFpm === -3000);

const throttleConfig = loader.getThrottleConfig();
test('getThrottleConfig returns throttle', throttleConfig !== null);
test('Throttle type is detent', throttleConfig?.type === 'detent');

section('LVAR Subscriptions');
loader.setActiveProfile('fenix-a320');
const fenixA320Lvars = loader.getLvarConfig();
test(
  'Fenix A320 compiles its exact trusted page, field contract, confirmations, actions, and subscriptions',
  fenixA320Lvars?.aircraftSpecific?.templateId === 'fenix-a32x' &&
    fenixA320Lvars?.aircraftSpecific?.integrationId === 'fenix-a32x' &&
    fenixA320Lvars?.aircraftSpecific?.profileKey === 'bundled/msfs/fenix-a320' &&
    fenixA320Lvars?.aircraftSpecific?.fields?.length === 118 &&
    fenixA320Lvars?.aircraftSpecific?.confirmationFields?.length === 117 &&
    fenixA320Lvars?.subscriptions?.length === 118 &&
    Object.keys(defaultAircraftIntegrationRegistry.resolveIntegration('fenix-a32x', {
      profileKey: 'bundled/msfs/fenix-a320',
    })?.actions || {}).length === 273 &&
    defaultAircraftIntegrationRegistry.resolveIntegration('fenix-a32x', {
      profileKey: 'local/msfs/fenix-a320',
    }) === null,
);
test(
  'Fenix A320 subscribes AP2 under the canonical channel-B key for aggregate AP engagement',
  fenixA320Lvars?.subscriptions?.some(s => (
    s.key === 'ap_channel_b' &&
    s.expression === '(L:I_FCU_AP2)' &&
    s.sourcePath === 'integration.telemetry.lvars.mcp.cmdB'
  )) === true,
);
const fenixIntegration = defaultAircraftIntegrationRegistry.resolveIntegration('fenix-a32x', {
  profileKey: 'bundled/msfs/fenix-a320',
});
const fenixAltitudeTargetRoute = fenixIntegration?.actions?.['flightGuidance.altitudeHundred.set']?.routes?.[0];
test(
  'Fenix A320 compiles FCU target confirmations and generic route preconditions but keeps V/S display-only',
  ['flightGuidance.ap1', 'flightGuidance.ap2', 'flightGuidance.autothrust',
    'flightGuidance.localizer', 'flightGuidance.approach', 'flightGuidance.expedite',
    'flightGuidance.speedManaged', 'flightGuidance.headingManaged',
    'flightGuidance.altitudeManaged', 'flightGuidance.speedValue',
    'flightGuidance.headingDeg', 'flightGuidance.altitudeFt'].every(fieldId => (
    fenixA320Lvars?.aircraftSpecific?.confirmationFields?.some(field => field.id === fieldId)
  )) &&
    fenixAltitudeTargetRoute?.precondition?.fieldId === 'flightGuidance.altitudeIncrementMode' &&
    fenixA320Lvars?.aircraftSpecific?.confirmationFields?.some(field => (
      field.id === fenixAltitudeTargetRoute.precondition.fieldId
    )) &&
    fenixA320Lvars?.aircraftSpecific?.fields?.some(field => field.id === 'flightGuidance.verticalValue') &&
    !fenixA320Lvars?.aircraftSpecific?.confirmationFields?.some(field => (
      field.id === 'flightGuidance.verticalValue'
    )) &&
    fenixIntegration?.actions?.['flightGuidance.vertical.set'] === undefined,
);
const fenixFamilyContractMatches = ['a319', 'a320', 'a321'].every((variant) => {
  loader.setActiveProfile(`fenix-${variant}`);
  const config = loader.getLvarConfig();
  return config?.aircraftSpecific?.fields?.length === 118 &&
    config?.aircraftSpecific?.confirmationFields?.length === 117 &&
    config?.subscriptions?.length === 118;
});
loader.setActiveProfile('fenix-a320');
test('All exact Fenix family profiles compile the same 118/273/117 FCU contract', fenixFamilyContractMatches);

const tristarAutothrottleToggle = controlService.resolveAircraftControl(
  { control: 'autopilot', target: 'autothrottle', operation: 'toggle' },
  { profile: tristar, capabilities: { simulator: 'msfs', actionTypes: ['key-event', 'lvar', 'simvar'] } }
);
test(
  'TriStar AT pulse resolves to the vendor-documented AP_AIRSPEED_HOLD event',
  tristarAutothrottleToggle?.ok === true &&
    tristarAutothrottleToggle?.resolvedBy === 'profile' &&
    tristarAutothrottleToggle?.action?.name === 'AP_AIRSPEED_HOLD'
);

const tristarInsToggle = controlService.resolveAircraftControl(
  { control: 'autopilot', target: 'ins', operation: 'toggle' },
  { profile: tristar, capabilities: { simulator: 'msfs', actionTypes: ['key-event', 'lvar', 'simvar'] } }
);
test(
  'TriStar INS pulse owns the repurposed water-rudder event without exposing a yaw-damper control',
  tristarInsToggle?.ok === true &&
    tristarInsToggle?.resolvedBy === 'profile' &&
    tristarInsToggle?.action?.name === 'TOGGLE_WATER_RUDDER' &&
    controlService.resolveAircraftControl(
      { control: 'autopilot', target: 'yawDamper', operation: 'toggle' },
      { profile: tristar, capabilities: { simulator: 'msfs', actionTypes: ['key-event', 'lvar', 'simvar'] } }
    )?.ok === false
);

loader.setActiveProfile('fbw-a32nx');
const a32nxLvars = loader.getLvarConfig();
test('A32NX subscribes documented flap handle LVAR under canonical key', a32nxLvars?.subscriptions?.some(s =>
  s.key === 'flaps' &&
  s.expression === '(L:A32NX_FLAPS_HANDLE_INDEX)' &&
  s.sourcePath === 'integration.telemetry.lvars.flaps'
) === true);

loader.setActiveProfile('fbw-a32nx');
const fbwA32nxLvars = loader.getLvarConfig();
test(
  'FlyByWire A32NX activates its trusted template and published logical field contract',
  fbwA32nxLvars?.aircraftSpecific?.templateId === 'fbw-a32nx' &&
    fbwA32nxLvars?.aircraftSpecific?.integrationId === 'fbw-a32nx' &&
    fbwA32nxLvars?.aircraftSpecific?.profileKey === 'bundled/msfs/fbw-a32nx' &&
    fbwA32nxLvars?.aircraftSpecific?.fields?.length === 124 &&
    fbwA32nxLvars.aircraftSpecific.fields.some(field => (
      field.id === 'lights.strobeMode' &&
      field.source?.type === 'lvar' &&
      field.decode?.values?.['0'] === 'on' &&
      field.decode?.values?.['1'] === 'auto' &&
      field.decode?.values?.['2'] === 'off'
    )) &&
    fbwA32nxLvars.aircraftSpecific.fields.some(field => (
      field.id === 'lights.beacon' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'lights.beacon'
    )) &&
    fbwA32nxLvars.aircraftSpecific.fields.some(field => (
      field.id === 'lights.strobeActive' &&
      field.source?.type === 'lvar'
    )) &&
    fbwA32nxLvars.aircraftSpecific.fields.some(field => (
      field.id === 'lights.runwayTurnoff' &&
      field.source?.type === 'lvar'
    )) &&
    fbwA32nxLvars.aircraftSpecific.fields.some(field => field.id === 'lights.landingLeftCircuitOn') &&
    fbwA32nxLvars.aircraftSpecific.fields.some(field => field.id === 'systems.adirsAlignmentSeconds')
);
test(
  'FlyByWire A32NX write confirmations cover broad fixed commands while strobe proves output or AUTO mode',
  fbwA32nxLvars?.aircraftSpecific?.confirmationFields?.length === 95 &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'lights.strobeActive') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'lights.strobeAuto') &&
    !fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'lights.strobeMode') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'lights.runwayTurnoff') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'lights.noseMode') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'lights.landingLeftCircuitOn') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'lights.landingRightRetracted') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'systems.apuStart') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'systems.autobrakeMode') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'navigation.ndCaptainMode') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'surveillance.tcasMode') &&
    fbwA32nxLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'controls.spoilersHandle')
);
test(
  'FlyByWire A32NX keeps broad executable routes adapter-owned and generic AP writes disabled',
  loader.getActiveProfile()?.integration?.controls?.genericFallback === false &&
    loader.getActiveProfile()?.integration?.controls?.standardSurfaceFallback === true &&
    loader.getActiveProfile()?.integration?.controls?.autopilot === undefined &&
    loader.getActiveProfile()?.integration?.aircraftSpecific?.adapter === 'fbw-a32nx' &&
    loader.getActiveProfile()?.integration?.telemetry?.aircraftSpecific === undefined &&
    loader.getActiveProfile()?.integration?.controls?.aircraftSpecific === undefined &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'fbw-a32nx',
      profileKey: 'local/msfs/fbw-a32nx',
      actionId: 'lights.strobe.auto',
    }) === null
);
test('FlyByWire A32NX aircraft-specific reads stay within the sidecar subscription limit', fbwA32nxLvars.subscriptions.length <= 256);

loader.setActiveProfile('inibuilds-a320neo-v2');
const microsoftIniBuildsA320neoV2Config = loader.getLvarConfig();
test(
  'Microsoft / iniBuilds A320neo V2 activates the shared trusted 44-field compact page',
  microsoftIniBuildsA320neoV2Config?.aircraftSpecific?.templateId === 'microsoft-inibuilds-a32x' &&
    microsoftIniBuildsA320neoV2Config?.aircraftSpecific?.integrationId === 'microsoft-inibuilds-a32x' &&
    microsoftIniBuildsA320neoV2Config?.aircraftSpecific?.profileKey === 'bundled/msfs/inibuilds-a320neo-v2' &&
    microsoftIniBuildsA320neoV2Config?.aircraftSpecific?.fields?.length === 44 &&
    microsoftIniBuildsA320neoV2Config.aircraftSpecific.fields.some(field => (
      field.id === 'fcu.altitudeFt' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apAltTargetFt'
    )) &&
    microsoftIniBuildsA320neoV2Config.aircraftSpecific.fields.some(field => (
      field.id === 'flightGuidance.navHold' &&
      field.source?.type === 'simvar'
    )) &&
    microsoftIniBuildsA320neoV2Config.aircraftSpecific.confirmationFields.length === 23
);

loader.setActiveProfile('inibuilds-a321lr');
const microsoftIniBuildsA321lrConfig = loader.getLvarConfig();
test(
  'Microsoft / iniBuilds A321LR reuses the shared trusted 44-field compact page under its exact profile key',
  microsoftIniBuildsA321lrConfig?.aircraftSpecific?.templateId === 'microsoft-inibuilds-a32x' &&
    microsoftIniBuildsA321lrConfig?.aircraftSpecific?.integrationId === 'microsoft-inibuilds-a32x' &&
    microsoftIniBuildsA321lrConfig?.aircraftSpecific?.profileKey === 'bundled/msfs/inibuilds-a321lr' &&
    microsoftIniBuildsA321lrConfig?.aircraftSpecific?.fields?.length === 44 &&
    microsoftIniBuildsA321lrConfig.aircraftSpecific.fields.some(field => (
      field.id === 'fcu.altitudeFt' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apAltTargetFt'
    )) &&
    microsoftIniBuildsA321lrConfig.aircraftSpecific.confirmationFields.length === 23
);
const microsoftIniBuildsA32xIntegration = defaultAircraftIntegrationRegistry.resolveIntegration(
  'microsoft-inibuilds-a32x',
  { profileKey: 'bundled/msfs/inibuilds-a320neo-v2' },
);
const microsoftIniBuildsA321lrIntegration = defaultAircraftIntegrationRegistry.resolveIntegration(
  'microsoft-inibuilds-a32x',
  { profileKey: 'bundled/msfs/inibuilds-a321lr' },
);
const expectedMicrosoftIniBuildsA32xActionIds = [
  ...[
    'flightGuidance.apMaster',
    'flightGuidance.flightDirector',
    'flightGuidance.autothrottleArmed',
    'flightGuidance.speedHold',
    'flightGuidance.headingHold',
    'flightGuidance.altitudeHold',
    'flightGuidance.verticalSpeedHold',
    'flightGuidance.navHold',
    'flightGuidance.approachHold',
  ].flatMap(prefix => [`${prefix}.off`, `${prefix}.on`]),
  'flightGuidance.speed.set',
  'flightGuidance.heading.set',
  'flightGuidance.altitude.set',
  'flightGuidance.verticalSpeed.set',
  ...['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi'].flatMap(name => [
    `lights.${name}.off`,
    `lights.${name}.on`,
  ]),
  'controls.gear.up',
  'controls.gear.down',
  'controls.flaps.decrease',
  'controls.flaps.increase',
  'controls.parkingBrake.off',
  'controls.parkingBrake.on',
].sort();
const expectedMicrosoftIniBuildsA32xConfirmationIds = [
  'flightGuidance.apMaster',
  'flightGuidance.flightDirector',
  'flightGuidance.autothrottleArmed',
  'flightGuidance.speedHold',
  'flightGuidance.headingHold',
  'flightGuidance.altitudeHold',
  'flightGuidance.verticalSpeedHold',
  'flightGuidance.navHold',
  'flightGuidance.approachHold',
  'fcu.speedKts',
  'fcu.headingDeg',
  'fcu.altitudeFt',
  'fcu.verticalSpeedFpm',
  'lights.strobe',
  'lights.beacon',
  'lights.nav',
  'lights.logo',
  'lights.wing',
  'lights.landing',
  'lights.taxi',
  'controls.gearHandleDown',
  'controls.flapsIndex',
  'controls.parkingBrake',
].sort();
test(
  'Microsoft / iniBuilds A320neo V2 and A321LR expose the exact same 42-action contract only to both trusted keys',
  expectedMicrosoftIniBuildsA32xActionIds.length === 42 &&
    JSON.stringify(Object.keys(microsoftIniBuildsA32xIntegration?.actions || {}).sort()) === JSON.stringify(expectedMicrosoftIniBuildsA32xActionIds) &&
    JSON.stringify(Object.keys(microsoftIniBuildsA321lrIntegration?.actions || {}).sort()) === JSON.stringify(expectedMicrosoftIniBuildsA32xActionIds) &&
    JSON.stringify(microsoftIniBuildsA32xIntegration?.trustedProfileKeys || []) === JSON.stringify([
      'bundled/msfs/inibuilds-a320neo-v2',
      'bundled/msfs/inibuilds-a321lr',
    ])
);
test(
  'Microsoft / iniBuilds A32x uses no custom subscriptions and compiles exactly 23 unique confirmations for both aircraft',
  microsoftIniBuildsA320neoV2Config.enabled === false &&
    microsoftIniBuildsA320neoV2Config.subscriptions.length === 0 &&
    microsoftIniBuildsA321lrConfig.enabled === false &&
    microsoftIniBuildsA321lrConfig.subscriptions.length === 0 &&
    JSON.stringify(microsoftIniBuildsA320neoV2Config.aircraftSpecific.confirmationFields.map(field => field.id).sort()) === JSON.stringify(expectedMicrosoftIniBuildsA32xConfirmationIds) &&
    JSON.stringify(microsoftIniBuildsA321lrConfig.aircraftSpecific.confirmationFields.map(field => field.id).sort()) === JSON.stringify(expectedMicrosoftIniBuildsA32xConfirmationIds) &&
    new Set(microsoftIniBuildsA320neoV2Config.aircraftSpecific.confirmationFields.map(field => field.id)).size === 23 &&
    new Set(microsoftIniBuildsA321lrConfig.aircraftSpecific.confirmationFields.map(field => field.id)).size === 23
);
test(
  'Microsoft / iniBuilds A32x actions use one guarded untested SimConnect sequence and logical readback each',
  Object.keys(microsoftIniBuildsA32xIntegration?.actions || {}).length === 42 &&
    Object.values(microsoftIniBuildsA32xIntegration?.actions || {}).every(action => (
      action.verification === 'untested' &&
      action.guard?.retry === 'never' &&
      action.guard?.groupId?.startsWith('microsoftIniBuildsA32x.') &&
      action.routes?.length === 1 &&
      action.routes[0]?.id?.startsWith('microsoftIniBuildsA32x.') &&
      action.routes[0]?.transport === 'simconnect-sequence' &&
      action.routes[0]?.operations?.length === 1 &&
      action.routes[0]?.operations?.[0]?.type === 'event' &&
      typeof action.routes[0]?.readback?.fieldId === 'string'
    )) &&
    new Set(Object.values(microsoftIniBuildsA32xIntegration.actions).map(action => (
      action.routes[0].operations[0].name
    ))).size === 32 &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'microsoft-inibuilds-a32x',
      profileKey: 'bundled/msfs/inibuilds-a321lr',
      actionId: 'flightGuidance.altitude.set',
    })?.routes?.[0]?.operations?.[0]?.name === 'AP_ALT_VAR_SET_ENGLISH'
);
const microsoftIniBuildsA32xTypedActions = [
  ['flightGuidance.speed.set', 'fcu.speedKts', 'AP_SPD_VAR_SET', 100, 399, 1],
  ['flightGuidance.heading.set', 'fcu.headingDeg', 'HEADING_BUG_SET', 0, 359, 1],
  ['flightGuidance.altitude.set', 'fcu.altitudeFt', 'AP_ALT_VAR_SET_ENGLISH', 0, 49000, 100],
  ['flightGuidance.verticalSpeed.set', 'fcu.verticalSpeedFpm', 'AP_VS_VAR_SET_ENGLISH', -6000, 6000, 100],
];
test(
  'Microsoft / iniBuilds A32x typed FCU targets keep exact bounds, standard events, parameter zero, and matching readbacks',
  microsoftIniBuildsA32xTypedActions.every(([actionId, fieldId, event, min, max, step]) => {
    const action = microsoftIniBuildsA32xIntegration?.actions?.[actionId];
    return action?.input?.type === 'number' &&
      action.input.min === min &&
      action.input.max === max &&
      action.input.step === step &&
      action.routes?.[0]?.operations?.[0]?.name === event &&
      JSON.stringify(action.routes[0].operations[0].parameters) === '[0]' &&
      action.routes[0].operations[0].inputValue?.source === 'input' &&
      action.routes[0].readback?.fieldId === fieldId &&
      action.routes[0].readback?.expectedInput === true;
  })
);
test(
  'Microsoft / iniBuilds A32x keeps Airbus-private and non-priority controls excluded and rejects all untrusted copies',
  [
    'flightGuidance.apMaster.toggle',
    'flightGuidance.ap1.on',
    'flightGuidance.ap2.on',
    'flightGuidance.localizer.on',
    'flightGuidance.flightLevelChange.on',
    'flightGuidance.speed.managed',
    'lights.strobe.auto',
    'lights.runwayTurnoff.on',
    'controls.spoilersArmed.on',
    'controls.speedbrake.set',
    'systems.apuMaster.on',
  ].every(actionId => microsoftIniBuildsA32xIntegration?.actions?.[actionId] === undefined) &&
    defaultAircraftIntegrationRegistry.resolveIntegration('microsoft-inibuilds-a32x', {
      profileKey: 'local/msfs/inibuilds-a320neo-v2',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('microsoft-inibuilds-a32x', {
      profileKey: 'local/msfs/inibuilds-a321lr',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('microsoft-inibuilds-a32x', {
      profileKey: 'bundled/msfs/inibuilds-a330',
    }) === null &&
    [
      microsoftIniBuildsA32xIntegration,
      microsoftIniBuildsA321lrIntegration,
    ].every(integration => integration?.id === 'microsoft-inibuilds-a32x')
);

loader.setActiveProfile('inibuilds-a330');
const iniA330Config = loader.getLvarConfig();
test(
  'iniBuilds A330 activates its exact standard-SimVar and standard-event contract',
  iniA330Config?.aircraftSpecific?.templateId === 'inibuilds-a330' &&
    iniA330Config?.aircraftSpecific?.integrationId === 'inibuilds-a330' &&
    iniA330Config?.aircraftSpecific?.profileKey === 'bundled/msfs/inibuilds-a330' &&
    iniA330Config?.aircraftSpecific?.fields?.length === 45 &&
    iniA330Config.aircraftSpecific.fields.some(field => (
      field.id === 'flightGuidance.altitudeFt' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apAltTargetFt'
    )) &&
    iniA330Config.aircraftSpecific.fields.some(field => (
      field.id === 'controls.parkingBrake' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'brake'
    )) &&
    iniA330Config.aircraftSpecific.fields.some(field => (
      field.id === 'controls.spoilersArmed' &&
      field.source?.type === 'simvar'
    )) &&
    iniA330Config.aircraftSpecific.fields.some(field => field.id === 'systems.cabinDeltaPressurePsi')
);
const iniA330Integration = defaultAircraftIntegrationRegistry.resolveIntegration('inibuilds-a330', {
  profileKey: 'bundled/msfs/inibuilds-a330',
});
test(
  'iniBuilds A330 exposes 47 guarded standard-event actions with 26 unique confirmations and no custom subscriptions',
  iniA330Config.enabled === false &&
    iniA330Config.subscriptions.length === 0 &&
    iniA330Config.aircraftSpecific.confirmationFields.length === 26 &&
    new Set(iniA330Config.aircraftSpecific.confirmationFields.map(field => field.id)).size === 26 &&
    Object.keys(iniA330Integration?.actions || {}).length === 47 &&
    Object.values(iniA330Integration?.actions || {}).every(action => (
      action.verification === 'untested' &&
      action.guard?.retry === 'never' &&
      action.routes?.every(route => route.transport === 'simconnect-sequence')
    )) &&
    loader.getActiveProfile()?.integration?.controls?.genericFallback === false &&
    loader.getActiveProfile()?.integration?.controls?.standardSurfaceFallback === true &&
    loader.getActiveProfile()?.integration?.telemetry?.aircraftSpecific === undefined &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'inibuilds-a330',
      profileKey: 'bundled/msfs/inibuilds-a330',
      actionId: 'lights.beacon.on',
    })?.routes?.[0]?.operations?.[0]?.name === 'BEACON_LIGHTS_SET'
);
test(
  'iniBuilds A330 bounds typed selectors and excludes Airbus-private FCU semantics',
  iniA330Integration?.actions?.['flightGuidance.speed.set']?.input?.min === 100 &&
    iniA330Integration?.actions?.['flightGuidance.speed.set']?.input?.max === 399 &&
    iniA330Integration?.actions?.['flightGuidance.heading.set']?.input?.min === 0 &&
    iniA330Integration?.actions?.['flightGuidance.heading.set']?.input?.max === 359 &&
    iniA330Integration?.actions?.['flightGuidance.altitude.set']?.input?.max === 49000 &&
    iniA330Integration?.actions?.['flightGuidance.altitude.set']?.input?.step === 100 &&
    iniA330Integration?.actions?.['flightGuidance.verticalSpeed.set']?.input?.min === -6000 &&
    iniA330Integration?.actions?.['flightGuidance.verticalSpeed.set']?.input?.max === 6000 &&
    iniA330Integration?.actions?.['flightGuidance.verticalSpeed.set']?.input?.step === 100 &&
    iniA330Integration?.actions?.['controls.speedbrake.set']?.input?.min === 0 &&
    iniA330Integration?.actions?.['controls.speedbrake.set']?.input?.max === 100 &&
    iniA330Integration?.actions?.['controls.speedbrake.set']?.routes?.[0]?.operations?.[0]?.inputValue?.scale === 163.83 &&
    iniA330Integration?.actions?.['flightGuidance.ap1.on'] === undefined &&
    iniA330Integration?.actions?.['flightGuidance.ap2.on'] === undefined &&
    iniA330Integration?.actions?.['flightGuidance.speed.managed'] === undefined &&
    iniA330Integration?.actions?.['flightGuidance.exped.on'] === undefined
);
test(
  'untrusted local iniBuilds A330 profiles cannot activate its trusted adapter',
  defaultAircraftIntegrationRegistry.resolveIntegration('inibuilds-a330', {
    profileKey: 'local/msfs/inibuilds-a330',
  }) === null
);

loader.setActiveProfile('microsoft-737-max-8');
const microsoftMaxConfig = loader.getLvarConfig();
const microsoftMaxIntegration = defaultAircraftIntegrationRegistry.resolveIntegration(
  'microsoft-737-max-8',
  { profileKey: 'bundled/msfs/microsoft-737-max-8' },
);
const expectedMicrosoftMaxActionIds = [
  ...[
    'flightGuidance.apMaster',
    'flightGuidance.flightDirector',
    'flightGuidance.autothrottleArmed',
    'flightGuidance.speedHold',
    'flightGuidance.headingHold',
    'flightGuidance.altitudeHold',
    'flightGuidance.verticalSpeedHold',
    'flightGuidance.navHold',
    'flightGuidance.approachHold',
    'flightGuidance.flightLevelChange',
  ].flatMap(prefix => [`${prefix}.off`, `${prefix}.on`]),
  'flightGuidance.speed.set',
  'flightGuidance.heading.set',
  'flightGuidance.altitude.set',
  'flightGuidance.verticalSpeed.set',
  ...['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi'].flatMap(name => [
    `lights.${name}.off`,
    `lights.${name}.on`,
  ]),
  'controls.gear.up',
  'controls.gear.down',
  'controls.flaps.decrease',
  'controls.flaps.increase',
  'controls.parkingBrake.off',
  'controls.parkingBrake.on',
].sort();
const expectedMicrosoftMaxConfirmationIds = [
  'afds.apMaster',
  'afds.flightDirector',
  'afds.autothrottleArmed',
  'afds.speed',
  'afds.headingSelect',
  'afds.altitudeHold',
  'afds.verticalSpeed',
  'afds.lnav',
  'afds.approach',
  'afds.levelChange',
  'mcp.speedKts',
  'mcp.headingDeg',
  'mcp.altitudeFt',
  'mcp.verticalSpeedFpm',
  'lights.strobe',
  'lights.beacon',
  'lights.nav',
  'lights.logo',
  'lights.wing',
  'lights.landing',
  'lights.taxi',
  'controls.gearHandleDown',
  'controls.flapsIndex',
  'controls.parkingBrake',
].sort();
test(
  'Microsoft 737 MAX 8 activates its exact trusted compact control page',
  microsoftMaxConfig?.aircraftSpecific?.templateId === 'microsoft-737-max-8' &&
    microsoftMaxConfig?.aircraftSpecific?.integrationId === 'microsoft-737-max-8' &&
    microsoftMaxConfig?.aircraftSpecific?.profileKey === 'bundled/msfs/microsoft-737-max-8' &&
    microsoftMaxConfig?.aircraftSpecific?.fields?.length === 44 &&
    microsoftMaxConfig.aircraftSpecific.fields.some(field => (
      field.id === 'mcp.altitudeFt' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apAltTargetFt'
    )) &&
    microsoftMaxConfig.aircraftSpecific.confirmationFields.length === 24 &&
    JSON.stringify(Object.keys(microsoftMaxIntegration?.actions || {}).sort()) === JSON.stringify(expectedMicrosoftMaxActionIds) &&
    JSON.stringify(microsoftMaxConfig.aircraftSpecific.confirmationFields.map(field => field.id).sort()) === JSON.stringify(expectedMicrosoftMaxConfirmationIds)
);
test(
  'Microsoft 737 MAX 8 owns 44 guarded standard actions without custom subscriptions',
  microsoftMaxConfig.enabled === false &&
    microsoftMaxConfig.subscriptions.length === 0 &&
    expectedMicrosoftMaxActionIds.length === 44 &&
    Object.values(microsoftMaxIntegration?.actions || {}).every(action => (
      action.verification === 'untested' &&
      action.guard?.retry === 'never' &&
      action.guard?.groupId?.startsWith('microsoft737Max8.') &&
      action.routes?.length === 1 &&
      action.routes[0]?.id?.startsWith('microsoft737Max8.') &&
      action.routes[0]?.transport === 'simconnect-sequence' &&
      action.routes[0]?.operations?.length === 1 &&
      action.routes[0]?.operations?.[0]?.type === 'event' &&
      typeof action.routes[0]?.readback?.fieldId === 'string'
    )) &&
    new Set(Object.values(microsoftMaxIntegration.actions).map(action => (
      action.routes[0].operations[0].name
    ))).size === 34 &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'microsoft-737-max-8',
      profileKey: 'bundled/msfs/microsoft-737-max-8',
      actionId: 'flightGuidance.altitude.set',
    })?.routes?.[0]?.operations?.[0]?.name === 'AP_ALT_VAR_SET_ENGLISH' &&
    microsoftMaxIntegration.actions['flightGuidance.flightLevelChange.on']?.routes?.[0]?.operations?.[0]?.name === 'FLIGHT_LEVEL_CHANGE_ON' &&
    microsoftMaxIntegration.actions['lights.nav.on']?.guard?.skipIfSatisfied === false &&
    microsoftMaxIntegration.actions['afds.cmdA.on'] === undefined &&
    microsoftMaxIntegration.actions['afds.cmdB.on'] === undefined &&
    microsoftMaxIntegration.actions['afds.vnav.on'] === undefined &&
    microsoftMaxIntegration.actions['controls.speedbrake.set'] === undefined &&
    microsoftMaxIntegration.actions['lights.runwayTurnoff.on'] === undefined
);
const microsoftMaxTypedActions = [
  ['flightGuidance.speed.set', 'mcp.speedKts', 'AP_SPD_VAR_SET', 100, 399, 1],
  ['flightGuidance.heading.set', 'mcp.headingDeg', 'HEADING_BUG_SET', 0, 359, 1],
  ['flightGuidance.altitude.set', 'mcp.altitudeFt', 'AP_ALT_VAR_SET_ENGLISH', 0, 49000, 100],
  ['flightGuidance.verticalSpeed.set', 'mcp.verticalSpeedFpm', 'AP_VS_VAR_SET_ENGLISH', -6000, 6000, 100],
];
test(
  'Microsoft 737 MAX 8 typed MCP targets retain exact bounds, parameters, and confirmation fields',
  microsoftMaxTypedActions.every(([actionId, fieldId, event, min, max, step]) => {
    const action = microsoftMaxIntegration?.actions?.[actionId];
    return action?.input?.type === 'number' &&
      action.input.min === min &&
      action.input.max === max &&
      action.input.step === step &&
      action.routes?.[0]?.operations?.[0]?.name === event &&
      JSON.stringify(action.routes[0].operations[0].parameters) === '[0]' &&
      action.routes[0].operations[0].inputValue?.source === 'input' &&
      action.routes[0].readback?.fieldId === fieldId &&
      action.routes[0].readback?.expectedInput === true;
  })
);
test(
  'Microsoft 737 MAX 8 rejects untrusted copies and keeps Boeing-private or non-priority controls excluded',
  [
    'afds.cmdA.on',
    'afds.cmdB.on',
    'afds.vnav.on',
    'flightGuidance.vnav.on',
    'controls.autobrake.set',
    'controls.speedbrake.set',
    'lights.runwayTurnoff.on',
    'systems.engine1.start',
  ].every(actionId => microsoftMaxIntegration?.actions?.[actionId] === undefined) &&
    defaultAircraftIntegrationRegistry.resolveIntegration('microsoft-737-max-8', {
      profileKey: 'local/msfs/microsoft-737-max-8',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('microsoft-737-max-8', {
      profileKey: 'bundled/msfs/ifly-737-max-8',
    }) === null
);

loader.setActiveProfile('workingtitle-747-8');
const microsoft747Config = loader.getLvarConfig();
test(
  'Microsoft / Asobo Boeing 747-8 activates its exact four-engine monitoring page',
  microsoft747Config?.aircraftSpecific?.templateId === 'workingtitle-747-8' &&
    microsoft747Config?.aircraftSpecific?.integrationId === 'workingtitle-747-8' &&
    microsoft747Config?.aircraftSpecific?.profileKey === 'bundled/msfs/workingtitle-747-8' &&
    microsoft747Config?.aircraftSpecific?.fields?.length === 48 &&
    microsoft747Config.aircraftSpecific.fields.some(field => (
      field.id === 'systems.engine4N1' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.eng4N1'
    )) &&
    microsoft747Config.aircraftSpecific.fields.some(field => (
      field.id === 'systems.engine4Running' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.eng4Running'
    )) &&
    microsoft747Config.aircraftSpecific.confirmationFields.length === 0
);
test(
  'Microsoft / Asobo Boeing 747-8 exposes no custom subscriptions, guessed AP writes, or untrusted-local-profile access',
  microsoft747Config.enabled === false &&
    microsoft747Config.subscriptions.length === 0 &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'workingtitle-747-8',
      profileKey: 'bundled/msfs/workingtitle-747-8',
      actionId: 'afds.apMaster.toggle',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('workingtitle-747-8', {
      profileKey: 'local/msfs/workingtitle-747-8',
    }) === null
);

loader.setActiveProfile('asobo-787');
const microsoft787Config = loader.getLvarConfig();
test(
  'Microsoft / Asobo Boeing 787-10 activates its exact monitoring page',
  microsoft787Config?.aircraftSpecific?.templateId === 'asobo-787' &&
    microsoft787Config?.aircraftSpecific?.integrationId === 'asobo-787' &&
    microsoft787Config?.aircraftSpecific?.profileKey === 'bundled/msfs/asobo-787' &&
    microsoft787Config?.aircraftSpecific?.fields?.length === 44 &&
    microsoft787Config.aircraftSpecific.fields.some(field => (
      field.id === 'mcp.altitudeFt' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apAltTargetFt'
    )) &&
    microsoft787Config.aircraftSpecific.confirmationFields.length === 0
);
test(
  'Microsoft / Asobo Boeing 787-10 exposes no custom subscriptions, guessed AP writes, or untrusted-local-profile access',
  microsoft787Config.enabled === false &&
    microsoft787Config.subscriptions.length === 0 &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'asobo-787',
      profileKey: 'bundled/msfs/asobo-787',
      actionId: 'afds.apMaster.toggle',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('asobo-787', {
      profileKey: 'local/msfs/asobo-787',
    }) === null
);

let inherited787PagesStayDisabled = true;
for (const profileId of ['kuro-787-8', 'horizon-787-9']) {
  loader.setActiveProfile(profileId);
  const childConfig = loader.getLvarConfig();
  inherited787PagesStayDisabled = inherited787PagesStayDisabled &&
    childConfig?.aircraftSpecific?.integrationId === null &&
    childConfig?.aircraftSpecific?.templateId === null &&
    childConfig?.aircraftSpecific?.fields?.length === 0;
}
test('Kuro 787-8 and Horizon 787-9 cannot inherit the trusted stock 787-10 page', inherited787PagesStayDisabled);

loader.setActiveProfile('inibuilds-a310');
const microsoftA310Config = loader.getLvarConfig();
test(
  'Microsoft / iniBuilds A310 activates its exact trusted monitoring page',
  microsoftA310Config?.aircraftSpecific?.templateId === 'inibuilds-a310' &&
    microsoftA310Config?.aircraftSpecific?.integrationId === 'inibuilds-a310' &&
    microsoftA310Config?.aircraftSpecific?.profileKey === 'bundled/msfs/inibuilds-a310' &&
    microsoftA310Config?.aircraftSpecific?.fields?.length === 42 &&
    microsoftA310Config.aircraftSpecific.fields.some(field => (
      field.id === 'fcp.altitudeFt' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apAltTargetFt'
    )) &&
    microsoftA310Config.aircraftSpecific.fields.some(field => (
      field.id === 'controls.parkingBrake' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'brake'
    )) &&
    microsoftA310Config.aircraftSpecific.confirmationFields.length === 0
);
test(
  'Microsoft / iniBuilds A310 page uses no custom subscriptions and exposes no writes',
  microsoftA310Config.enabled === false &&
    microsoftA310Config.subscriptions.length === 0 &&
    loader.getActiveProfile()?.integration?.controls?.autopilot === undefined &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'inibuilds-a310',
      profileKey: 'bundled/msfs/inibuilds-a310',
      actionId: 'fcp.ap.toggle',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('inibuilds-a310', {
      profileKey: 'local/msfs/inibuilds-a310',
    }) === null
);

loader.setActiveProfile('inibuilds-tristar');
const tristarLvars = loader.getLvarConfig();
test(
  'TriStar enables only bounded standard A-var gauge subscriptions, not vendor-private LVARs',
  tristarLvars?.enabled === true &&
    Array.isArray(tristarLvars?.subscriptions) &&
    tristarLvars.subscriptions.length === 12 &&
    tristarLvars.subscriptions.every(subscription => /^\(A:[^)]+\)$/.test(subscription.expression)) &&
    tristarLvars.subscriptions.some(subscription => (
      subscription.key === 'aircraft_specific_systems_engine3_epr' &&
      subscription.expression === '(A:TURB ENG PRESSURE RATIO:3)' &&
      subscription.unit === 'Ratio'
    )) &&
    tristarLvars.subscriptions.some(subscription => (
      subscription.key === 'aircraft_specific_systems_engine2_fuel_flow_pph' &&
      subscription.unit === 'Pounds per hour'
    )) &&
    new Set(tristarLvars.subscriptions.map(subscription => subscription.key)).size === 12 &&
    new Set(tristarLvars.subscriptions.map(subscription => subscription.expression)).size === 12
);
test(
  'TriStar activates its trusted L-1011-500 three-engine page',
  tristarLvars?.aircraftSpecific?.templateId === 'inibuilds-tristar' &&
    tristarLvars?.aircraftSpecific?.integrationId === 'inibuilds-tristar' &&
    tristarLvars?.aircraftSpecific?.profileKey === 'bundled/msfs/inibuilds-tristar' &&
    tristarLvars?.aircraftSpecific?.fields?.length === 41 &&
    tristarLvars.aircraftSpecific.fields.some(field => (
      field.id === 'systems.engine3N1' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.eng3N1' &&
      field.decode?.precision === 1
    )) &&
    tristarLvars.aircraftSpecific.fields.some(field => (
      field.id === 'systems.engine3Running' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.eng3Running'
    )) &&
    tristarLvars.aircraftSpecific.fields.some(field => (
      field.id === 'systems.engine3Epr' &&
      field.source?.type === 'lvar' &&
      field.source?.key === 'aircraft_specific_systems_engine3_epr' &&
      field.decode?.precision === 2
    ))
);
test(
  'TriStar page excludes unsupported AFCS selector/mode readbacks and DLC-inclusive generic spoiler state',
  !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'flightGuidance.apMaster') &&
    !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'flightGuidance.headingHold') &&
    !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'flightGuidance.speedValue') &&
    !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'flightGuidance.headingDeg') &&
    !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'flightGuidance.altitudeFt') &&
    !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'flightGuidance.verticalSpeedFpm') &&
    !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'navigation.course1Deg') &&
    !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'navigation.course2Deg') &&
    !tristarLvars.aircraftSpecific.fields.some(field => field.id === 'controls.speedbrakePercent') &&
    tristarLvars.aircraftSpecific.confirmationFields.length === 7 &&
    new Set(tristarLvars.aircraftSpecific.confirmationFields.map(field => field.id)).size === 7 &&
    tristarLvars.aircraftSpecific.confirmationFields.some(field => field.id === 'lights.wing')
);
test(
  'TriStar trusted adapter exposes confirmed lights and acknowledged selector steps only to its exact bundled profile',
  defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: 'inibuilds-tristar',
    profileKey: 'bundled/msfs/inibuilds-tristar',
    actionId: 'lights.wing.setOn',
  })?.routes?.[0]?.readback?.fieldId === 'lights.wing' &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'inibuilds-tristar',
      profileKey: 'bundled/msfs/inibuilds-tristar',
      actionId: 'navigation.course1.increase',
    })?.routes?.[0]?.confirmation === 'transport-acknowledged' &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'inibuilds-tristar',
      profileKey: 'bundled/msfs/inibuilds-tristar',
      actionId: 'afcs.altitude.set',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'inibuilds-tristar',
      profileKey: 'bundled/msfs/inibuilds-tristar',
      actionId: 'flightGuidance.master.toggle',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('inibuilds-tristar', {
      profileKey: 'local/msfs/inibuilds-tristar',
    }) === null
);
test(
  'TriStar keeps its source-backed profile-level AFCS controls separate from the adapter',
  loader.getActiveProfile()?.integration?.controls?.autopilot?.actions?.masterToggle?.name === 'AP_MASTER' &&
    loader.getActiveProfile()?.integration?.controls?.autopilot?.actions?.headingHoldToggle?.name === 'AP_HDG_HOLD' &&
    loader.getActiveProfile()?.integration?.controls?.autopilot?.actions?.autothrottleToggle?.name === 'AP_AIRSPEED_HOLD' &&
    loader.getActiveProfile()?.integration?.controls?.autopilot?.actions?.insToggle?.name === 'TOGGLE_WATER_RUDDER'
);

loader.setActiveProfile('microsoft-atr-72-600');
const atrLvars = loader.getLvarConfig();
test(
  'ATR custom LVAR subscriptions stay disabled without a vendor variable contract',
  atrLvars?.enabled === false && atrLvars?.subscriptions?.length === 0
);
test(
  'ATR activates its exact standard-SimVar monitoring page',
  atrLvars?.aircraftSpecific?.templateId === 'microsoft-atr-72-600' &&
    atrLvars?.aircraftSpecific?.integrationId === 'microsoft-atr-72-600' &&
    atrLvars?.aircraftSpecific?.profileKey === 'bundled/msfs/microsoft-atr-72-600' &&
    atrLvars?.aircraftSpecific?.fields?.length === 34 &&
    atrLvars.aircraftSpecific.fields.some(field => (
      field.id === 'fgcp.altitudeFt' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apAltTargetFt'
    )) &&
    atrLvars.aircraftSpecific.fields.some(field => (
      field.id === 'fgcp.apMaster' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apMaster'
    )) &&
    !atrLvars.aircraftSpecific.fields.some(field => field.id === 'fgcp.vnav') &&
    atrLvars.aircraftSpecific.confirmationFields.length === 0
);
test(
  'ATR monitoring page contains no unverified MSATR readbacks',
  atrLvars?.subscriptions?.length === 0 &&
    atrLvars.aircraftSpecific.fields.every(field => field.source?.type === 'simvar')
);

loader.setActiveProfile('inibuilds-a300');
const a300Lvars = loader.getLvarConfig();
test(
  'iniBuilds A300 custom LVAR subscriptions stay disabled without vendor evidence',
  a300Lvars?.enabled === false
);
test(
  'iniBuilds A300 contains no unverified aircraft-specific telemetry subscriptions',
  a300Lvars?.subscriptions?.length === 0
);

loader.setActiveProfile('ifly-737-max-8');
const ifly737Max8Lvars = loader.getLvarConfig();
test(
  'iFly 737 MAX 8 custom LVAR subscriptions stay disabled without vendor evidence',
  ifly737Max8Lvars?.enabled === false
);
test(
  'iFly 737 MAX 8 contains no unverified VC_* telemetry subscriptions',
  ifly737Max8Lvars?.subscriptions?.length === 0
);
test(
  'iFly 737 MAX 8 activates its exact trusted 41-field standard-SimVar page',
  ifly737Max8Lvars?.aircraftSpecific?.templateId === 'ifly-737-max-8' &&
    ifly737Max8Lvars?.aircraftSpecific?.integrationId === 'ifly-737-max-8' &&
    ifly737Max8Lvars?.aircraftSpecific?.profileKey === 'bundled/msfs/ifly-737-max-8' &&
    ifly737Max8Lvars?.aircraftSpecific?.fields?.length === 41 &&
    ifly737Max8Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'mcp.altitudeFt' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apAltTargetFt'
    )) &&
    ifly737Max8Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'lights.runwayTurnoff' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'lights.turnoff'
    ))
);
test(
  'iFly page uses documented standard SimVars with strict boolean decoders',
  ifly737Max8Lvars.aircraftSpecific.fields.some(field => (
    field.id === 'afds.cmdA' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apMaster' &&
      JSON.stringify(field.decode?.trueValues) === '[true,1]' &&
      JSON.stringify(field.decode?.falseValues) === '[false,0]'
  )) &&
    ifly737Max8Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'afds.lnav' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.apNavHold'
    )) &&
    !ifly737Max8Lvars.aircraftSpecific.fields.some(field => field.id === 'afds.vnav') &&
    ifly737Max8Lvars.subscriptions.length === 0
);
test(
  'iFly page excludes unverified aircraft-specific rows',
  !ifly737Max8Lvars.aircraftSpecific.fields.some(field => (
    field.id === 'afds.cmdB' || field.id === 'afds.n1' || field.id === 'afds.speed'
  )) && ifly737Max8Lvars.subscriptions.length === 0
);
test(
  'iFly trusted adapter exposes no writes and untrusted local profiles cannot activate it',
  ifly737Max8Lvars.aircraftSpecific.confirmationFields.length === 0 &&
    loader.getActiveProfile()?.integration?.controls?.genericFallback === false &&
    loader.getActiveProfile()?.integration?.controls?.standardSurfaceFallback === true &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'ifly-737-max-8',
      profileKey: 'bundled/msfs/ifly-737-max-8',
      actionId: 'afds.cmdA.toggle',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('ifly-737-max-8', {
      profileKey: 'local/msfs/ifly-737-max-8',
    }) === null
);

loader.setActiveProfile('headwind-a330');
const headwindLvars = loader.getLvarConfig();
test(
  'Headwind A330 custom LVAR config stays disabled without a compatibility contract',
  headwindLvars?.enabled === false
);
test(
  'Headwind A330 does not assume inherited A32NX_* compatibility',
  headwindLvars?.subscriptions?.length === 0
);

loader.setActiveProfile('fbw-a380x');
const a380Lvars = loader.getLvarConfig();
test('A380X LVAR config is enabled from documented FBW A380X API variables', a380Lvars?.enabled === true);
test(
  'A380X activates its exact trusted compact page and representative custom, gauge, light, and four-engine fields',
  a380Lvars?.aircraftSpecific?.templateId === 'fbw-a380x' &&
    a380Lvars?.aircraftSpecific?.integrationId === 'fbw-a380x' &&
    a380Lvars?.aircraftSpecific?.profileKey === 'bundled/msfs/fbw-a380x' &&
    a380Lvars?.aircraftSpecific?.fields?.length === 42 &&
    a380Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'flightGuidance.altitudeFt' &&
      field.source?.type === 'lvar' &&
      field.source?.key === 'aircraft_specific_flight_guidance_altitude_ft' &&
      field.decode?.type === 'number' &&
      field.decode?.precision === 0
    )) &&
    a380Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'flightGuidance.autothrust' &&
      field.source?.type === 'lvar' &&
      field.source?.key === 'autothrottle' &&
      JSON.stringify(field.decode?.trueValues) === '[1,2]'
    )) &&
    a380Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'lights.strobe' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'lights.strobe'
    )) &&
    a380Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'systems.engine4N1' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.eng4N1' &&
      field.decode?.precision === 1
    ))
);
test(
  'A380X subscribes documented AP, A/THR, FCU, gauge-altitude, flaps, spoilers, and parking-brake readbacks without duplicates',
  a380Lvars?.subscriptions?.some(s => s.key === 'autopilot' && s.expression === '(L:A32NX_AUTOPILOT_1_ACTIVE)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'autothrottle' && s.expression === '(L:A32NX_AUTOTHRUST_STATUS)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'flaps' && s.expression === '(L:A32NX_FLAPS_HANDLE_INDEX)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'selected_speed' && s.expression === '(L:A32NX_AUTOPILOT_SPEED_SELECTED)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'selected_heading' && s.expression === '(L:A32NX_AUTOPILOT_HEADING_SELECTED)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'selected_vertical_speed' && s.expression === '(L:A32NX_AUTOPILOT_VS_SELECTED)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'mode_loc' && s.expression === '(L:A32NX_FCU_LOC_MODE_ACTIVE)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'mode_app' && s.expression === '(L:A32NX_FCU_APPR_MODE_ACTIVE)') === true &&
    a380Lvars?.subscriptions?.some(s => (
      s.key === 'aircraft_specific_flight_guidance_altitude_ft' &&
      s.expression === '(A:AUTOPILOT ALTITUDE LOCK VAR:3)' &&
      s.unit === 'Feet'
    )) === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'spoilers_armed' && s.expression === '(L:A32NX_SPOILERS_ARMED)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'spoilers_handle' && s.expression === '(L:A32NX_SPOILERS_HANDLE_POSITION)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'parking_brake' && s.expression === '(L:A32NX_PARK_BRAKE_LEVER_POS)') === true &&
    a380Lvars?.subscriptions?.some(s => s.key === 'parkingBrake') === false &&
    new Set(a380Lvars.subscriptions.map(subscription => subscription.key)).size === a380Lvars.subscriptions.length &&
    new Set(a380Lvars.subscriptions.map(subscription => subscription.expression.toLowerCase())).size === a380Lvars.subscriptions.length
);
const a380Integration = defaultAircraftIntegrationRegistry.resolveIntegration('fbw-a380x', {
  profileKey: 'bundled/msfs/fbw-a380x',
});
const expectedA380ActionIds = [
  ...['ap1', 'autothrust', 'localizer', 'approach'].flatMap(name => [
    `flightGuidance.${name}.off`,
    `flightGuidance.${name}.on`,
  ]),
  'flightGuidance.speed.set',
  'flightGuidance.heading.set',
  'flightGuidance.altitude.set',
  ...['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi'].flatMap(name => [
    `lights.${name}.off`,
    `lights.${name}.on`,
  ]),
  'controls.parkingBrake.released',
  'controls.parkingBrake.set',
  'controls.spoilersArmed.off',
  'controls.spoilersArmed.on',
  'controls.spoilers.set',
  'controls.flaps.decrease',
  'controls.flaps.increase',
  'controls.gear.up',
  'controls.gear.down',
].sort();
test(
  'A380X exposes exactly 34 guarded untested SimConnect-sequence actions with 19 unique confirmation fields',
  JSON.stringify(Object.keys(a380Integration?.actions || {}).sort()) === JSON.stringify(expectedA380ActionIds) &&
    expectedA380ActionIds.length === 34 &&
    a380Lvars.aircraftSpecific.confirmationFields.length === 19 &&
    new Set(a380Lvars.aircraftSpecific.confirmationFields.map(field => field.id)).size === 19 &&
    Object.values(a380Integration?.actions || {}).every(action => (
      action.verification === 'untested' &&
      action.guard?.retry === 'never' &&
      action.routes?.length === 1 &&
      action.routes[0]?.transport === 'simconnect-sequence' &&
      typeof action.routes[0]?.readback?.fieldId === 'string'
    ))
);
test(
  'A380X bounds typed FCU and spoiler inputs and keeps deliberately unsupported semantics absent',
  a380Integration?.actions?.['flightGuidance.speed.set']?.input?.min === 100 &&
    a380Integration.actions['flightGuidance.speed.set'].input.max === 399 &&
    a380Integration.actions['flightGuidance.speed.set'].input.step === 1 &&
    a380Integration.actions['flightGuidance.heading.set'].input.min === 0 &&
    a380Integration.actions['flightGuidance.heading.set'].input.max === 359 &&
    a380Integration.actions['flightGuidance.heading.set'].input.step === 1 &&
    a380Integration.actions['flightGuidance.altitude.set'].input.min === 0 &&
    a380Integration.actions['flightGuidance.altitude.set'].input.max === 49000 &&
    a380Integration.actions['flightGuidance.altitude.set'].input.step === 100 &&
    a380Integration.actions['controls.spoilers.set'].input.min === 0 &&
    a380Integration.actions['controls.spoilers.set'].input.max === 1 &&
    a380Integration.actions['controls.spoilers.set'].input.step === 0.25 &&
    [
      'flightGuidance.ap2.on',
      'flightGuidance.verticalSpeed.set',
      'flightGuidance.speed.managed',
      'flightGuidance.altitude.selected',
      'lights.strobe.auto',
      'lights.runwayTurnoff.on',
      'systems.apuMaster.on',
      'systems.engine1Master.on',
    ].every(actionId => a380Integration.actions[actionId] === undefined)
);
test(
  'A380X keeps generic controls disabled, retains standard surface fallback, and rejects untrusted profile copies',
  loader.getActiveProfile()?.integration?.controls?.genericFallback === false &&
    loader.getActiveProfile()?.integration?.controls?.standardSurfaceFallback === true &&
    loader.getActiveProfile()?.integration?.controls?.autopilot === undefined &&
    loader.getActiveProfile()?.integration?.aircraftSpecific?.adapter === 'fbw-a380x' &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'fbw-a380x',
      profileKey: 'bundled/msfs/fbw-a380x',
      actionId: 'lights.beacon.on',
    })?.routes?.[0]?.operations?.[0]?.name === 'BEACON_LIGHTS_SET' &&
    defaultAircraftIntegrationRegistry.resolveIntegration('fbw-a380x', {
      profileKey: 'local/msfs/fbw-a380x',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('fbw-a380x', {
      profileKey: 'bundled/msfs/fbw-a32nx',
    }) === null
);

loader.setActiveProfile('tfdi-md-11');
const md11Lvars = loader.getLvarConfig();
test('MD-11 LVAR config is enabled', md11Lvars?.enabled === true);
test(
  'TFDi MD-11 activates its exact trusted tri-jet monitoring page',
  md11Lvars?.aircraftSpecific?.templateId === 'tfdi-md-11' &&
    md11Lvars?.aircraftSpecific?.integrationId === 'tfdi-md-11' &&
    md11Lvars?.aircraftSpecific?.profileKey === 'bundled/msfs/tfdi-md-11' &&
    md11Lvars?.aircraftSpecific?.fields?.length === 47 &&
    md11Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'afs.apState' &&
      field.source?.type === 'lvar' &&
      field.decode?.values?.['0'] === 'off' &&
      field.decode?.values?.['3'] === 'dual'
    )) &&
    md11Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'afs.speedMode' &&
      field.source?.type === 'lvar' &&
      field.decode?.values?.['0'] === 'ias' &&
      field.decode?.values?.['1'] === 'mach'
    )) &&
    md11Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'afs.speedValue' &&
      JSON.stringify(field.decode?.unavailableValues) === '[-999]'
    )) &&
    md11Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'afs.headingValue' &&
      JSON.stringify(field.decode?.unavailableValues) === '[-999]'
    )) &&
    md11Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'afs.verticalValue' &&
      JSON.stringify(field.decode?.unavailableValues) === '[-9999]'
    )) &&
    md11Lvars.aircraftSpecific.fields.some(field => (
      field.id === 'systems.engine3N1' &&
      field.source?.type === 'simvar' &&
      field.source?.path === 'fdm.eng3N1'
    )) &&
    !md11Lvars.aircraftSpecific.fields.some(field => field.id === 'controls.speedbrakePercent') &&
    md11Lvars.aircraftSpecific.confirmationFields.length === 0
);
test(
  'TFDi MD-11 keeps CEVENT/state writes disabled and rejects untrusted local profiles',
  loader.getActiveProfile()?.integration?.controls?.genericFallback === false &&
    loader.getActiveProfile()?.integration?.controls?.standardSurfaceFallback === true &&
    loader.getActiveProfile()?.integration?.controls?.autopilot === undefined &&
    defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: 'tfdi-md-11',
      profileKey: 'bundled/msfs/tfdi-md-11',
      actionId: 'afs.ap.toggle',
    }) === null &&
    defaultAircraftIntegrationRegistry.resolveIntegration('tfdi-md-11', {
      profileKey: 'local/msfs/tfdi-md-11',
    }) === null
);
test(
  'TFDi MD-11 subscriptions stay bounded and include documented mode, V-speed, and APU rows',
  md11Lvars?.subscriptions?.length <= 256 &&
    md11Lvars.subscriptions.some(s => s.expression === '(L:MD11_AP_IAS_MACH)') &&
    md11Lvars.subscriptions.some(s => s.expression === '(L:MD11_AP_HDG_TRK)') &&
    md11Lvars.subscriptions.some(s => s.expression === '(L:MD11_AP_VS_FPA)') &&
    md11Lvars.subscriptions.some(s => s.expression === '(L:MD11_AP_FT_M)') &&
    md11Lvars.subscriptions.some(s => s.expression === '(L:MD11_V1)') &&
    md11Lvars.subscriptions.some(s => s.expression === '(L:MD11_VFR)') &&
    md11Lvars.subscriptions.some(s => s.expression === '(L:MD11_APU_STATE)')
);
test(
  'MD-11 subscribes vendor-published overhead nav light LVAR',
  md11Lvars?.subscriptions?.some(s => s.key === 'light_nav' && s.expression === '(L:MD11_OVHD_LTS_NAV_LT)') === true
);
test(
  'MD-11 subscribes verified light LVARs from dataSource',
  md11Lvars?.subscriptions?.some(s => s.key === 'light_logo' && s.sourcePath === 'integration.telemetry.lvars.lights.logo') === true
);
test(
  'MD-11 subscribes paired turnoff light LVARs',
  md11Lvars?.subscriptions?.some(s => s.key === 'light_turnoff_left') === true &&
    md11Lvars?.subscriptions?.some(s => s.key === 'light_turnoff_right') === true
);
test(
  'MD-11 does not subscribe removed guessed light LVAR names',
  md11Lvars?.subscriptions?.every(s => !s.expression.includes('MD11_LTS_EXT')) === true
);

const bundledLvarProfiles = loader.listProfiles().filter(p => p.namespace === 'bundled');
let allBundledLvarSubscriptionsAreCanonical = true;
let allBundledFlapLvarProfilesHaveFlapNotches = true;
for (const summary of bundledLvarProfiles) {
  loader.setActiveProfile(summary.qualifiedId);
  const lvarConfig = loader.getLvarConfig();
  const subscriptions = Array.isArray(lvarConfig?.subscriptions) ? lvarConfig.subscriptions : [];
  const keys = subscriptions.map(s => s.key);
  const expressions = subscriptions.map(s => String(s.expression || '').toLowerCase());
  allBundledLvarSubscriptionsAreCanonical = allBundledLvarSubscriptionsAreCanonical &&
    hasUniqueValues(keys) &&
    hasUniqueValues(expressions) &&
    subscriptionsUseCanonicalProfileKeys(subscriptions);
  if (subscriptions.some(s => s.key === 'flaps')) {
    const profile = loader.getActiveProfile();
    allBundledFlapLvarProfilesHaveFlapNotches = allBundledFlapLvarProfilesHaveFlapNotches &&
      Array.isArray(profile?.flaps?.notches) &&
      profile.flaps.notches.length > 0;
  }
}
test('All bundled profile LVAR subscriptions use unique canonical runtime keys', allBundledLvarSubscriptionsAreCanonical === true);
test('Bundled profiles with active flap LVARs define local/resolved flap notches', allBundledFlapLvarProfilesHaveFlapNotches === true);

section('Flap Helpers');
loader.setActiveProfile('fbw-a32nx');
test('isLandingFlaps(3) is true for A32NX', loader.isLandingFlaps(3) === true);
test('isLandingFlaps(4) is true for A32NX', loader.isLandingFlaps(4) === true);
test('isLandingFlaps(2) is false for A32NX', loader.isLandingFlaps(2) === false);

const notch3 = loader.getFlapNotch(3);
test('getFlapNotch(3) returns notch', notch3 !== null);
test('Notch 3 has label "3"', notch3?.label === '3');

section('Cache Behavior');
const before = loader.loadProfile('fbw-a32nx');
const after = loader.loadProfile('fbw-a32nx');
test('Cached profiles are same reference', before === after);

loader.clearCache();
const afterClear = loader.loadProfile('fbw-a32nx');
test('clearCache invalidates cache', before !== afterClear);

loader.clearCache();
const xplaneGeneric = loader.loadProfile('bundled/xplane/generic');
const bareGenericAfterXplaneLoad = loader.loadProfile('generic');
test('Can load X-Plane generic profile explicitly', xplaneGeneric?._qualifiedId === 'bundled/xplane/generic');
test('X-Plane generic does not assert flap notches', xplaneGeneric?.flaps == null && xplaneGeneric?.aircraft?.flaps == null);
test('Bare generic is not poisoned by explicit X-Plane cache entry', bareGenericAfterXplaneLoad?._qualifiedId === 'bundled/msfs/generic');

loader.clearCache();
loader.loadProfile('bundled/xplane/generic');
const activeBareGeneric = loader.setActiveProfile('generic');
test('setActiveProfile(generic) resolves configured simulator despite X-Plane cache entry', activeBareGeneric?._qualifiedId === 'bundled/msfs/generic');

// -----------------------------------------------------------------------------
// Release-owned Profile Isolation
// -----------------------------------------------------------------------------

section('Release-owned Profile Isolation');

const userDir = retiredLocalProfilesDir;
test('getCommunityProfilesDir is no longer exported', typeof storagePaths.getCommunityProfilesDir === 'undefined');
test('Legacy Community dir is different from user dir', legacyCommunityRootDir !== userDir);
test('Legacy Community dir ends with Community', legacyCommunityRootDir.endsWith(path.join('Aircraft', 'Community')));

const tempId = `test-community-${Date.now()}`;
const communityMsfsDir = path.join(legacyCommunityRootDir, 'msfs');
const localMsfsDir = path.join(userDir, 'msfs');
const tempFile = path.join(communityMsfsDir, `${tempId}.json`);
const localTempFile = path.join(localMsfsDir, `${tempId}.json`);
fs.mkdirSync(communityMsfsDir, { recursive: true });
fs.mkdirSync(localMsfsDir, { recursive: true });
const legacyProfileBytes = JSON.stringify({
  version: 2,
  id: tempId,
  name: 'Test Community Profile',
  simulator: 'msfs',
  namespace: 'community',
  aircraft: { category: 'C' },
  integration: { telemetry: { preferred: 'simconnect' }, matching: { titleContains: [tempId] } },
  meta: { status: 'experimental' },
});
fs.writeFileSync(tempFile, legacyProfileBytes);
const localProfileBytes = legacyProfileBytes.replace('"community"', '"local"');
fs.writeFileSync(localTempFile, localProfileBytes);
try {
  const resolvedCommunity = loader.resolveProfilePath(`community/msfs/${tempId}`);
  const resolvedLocal = loader.resolveProfilePath(`local/msfs/${tempId}`);
  test('resolveProfilePath rejects the legacy Community namespace', resolvedCommunity === null);
  test('resolveProfilePath rejects the Local namespace', resolvedLocal === null);
  const listed = loader.listProfiles();
  test('listProfiles returns bundled profiles only', listed.length > 0 && listed.every(p => p.namespace === 'bundled'));
  test('listProfiles excludes ignored Local and Community profiles', !listed.some(p => p.id === tempId));
  test('Profile reads leave ignored Community files byte-for-byte untouched', fs.readFileSync(tempFile, 'utf8') === legacyProfileBytes);
  test('Profile reads leave ignored Local files byte-for-byte untouched', fs.readFileSync(localTempFile, 'utf8') === localProfileBytes);
} finally {
  fs.unlinkSync(tempFile);
  fs.unlinkSync(localTempFile);
  loader.clearCache();
}

const ghostId = `test-legacy-ghost-${Date.now()}`;
const legacyBareGhostFile = path.join(legacyCommunityRootDir, `${ghostId}.json`);
const localMsfsGhostFile = path.join(localMsfsDir, `${ghostId}.json`);
const localXplaneDir = path.join(userDir, 'xplane');
const localXplaneGhostFile = path.join(localXplaneDir, `${ghostId}.json`);
fs.mkdirSync(legacyCommunityRootDir, { recursive: true });
fs.mkdirSync(localXplaneDir, { recursive: true });
fs.writeFileSync(legacyBareGhostFile, JSON.stringify({
  version: 2,
  id: ghostId,
  name: 'Bare Legacy MSFS Ghost',
  namespace: 'community',
  aircraft: { category: 'C' },
  integration: { telemetry: { preferred: 'simconnect' }, matching: { titleContains: [ghostId] } },
  meta: { status: 'experimental' },
}, null, 2), 'utf8');
fs.writeFileSync(localXplaneGhostFile, JSON.stringify({
  version: 2,
  id: ghostId,
  name: 'Local X-Plane Profile Without Identity Hints',
  simulator: 'xplane',
  namespace: 'local',
  aircraft: { category: 'C' },
  integration: { telemetry: { preferred: 'simconnect' }, matching: { titleContains: [ghostId] } },
  meta: { status: 'experimental' },
}, null, 2), 'utf8');
try {
  loader.clearCache();
  const listedAfterBareLegacy = loader.listProfiles();
  test(
    'bare legacy-root Community profiles do not create MSFS local overrides',
    !listedAfterBareLegacy.some(p => p.qualifiedId === `local/msfs/${ghostId}`) && !fs.existsSync(localMsfsGhostFile)
  );
  test(
    'listProfiles ignores Local X-Plane profiles as well as legacy files',
    !listedAfterBareLegacy.some(p => p.qualifiedId === `local/xplane/${ghostId}`)
  );
  test(
    'resolveProfilePath rejects explicit Local X-Plane locators',
    loader.resolveProfilePath(`local/xplane/${ghostId}`) === null
  );
} finally {
  for (const filePath of [
    legacyBareGhostFile,
    localMsfsGhostFile,
    localXplaneGhostFile,
  ]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  loader.clearCache();
}

section('Profile Size Guards');

const oversizedProfileId = `test-oversized-profile-${Date.now()}`;
const oversizedProfileDir = path.join(retiredLocalProfilesDir, 'msfs');
const oversizedProfilePath = path.join(oversizedProfileDir, `${oversizedProfileId}.json`);
fs.mkdirSync(oversizedProfileDir, { recursive: true });
try {
  fs.writeFileSync(oversizedProfilePath, '{"id":"test-oversized-profile","name":"Oversized"', 'utf8');
  fs.truncateSync(oversizedProfilePath, loader.MAX_PROFILE_JSON_BYTES + 1);
  loader.clearCache();
  const oversizedProfile = loader.loadProfile(`local/msfs/${oversizedProfileId}`);
  const listedOversized = loader.listProfiles().some((profile) => profile.id === oversizedProfileId);
  test('Oversized local profile files fail closed before JSON parse', oversizedProfile === null);
  test('Oversized local profile files are omitted from profile listings', listedOversized === false);
} finally {
  if (fs.existsSync(oversizedProfilePath)) fs.unlinkSync(oversizedProfilePath);
  loader.clearCache();
}

test('Profile import remains unavailable for oversized input as well', typeof loader.importProfile === 'undefined');

section('Read-only Mutation Boundary');
test('The loader exposes no Local mutation entry points', [
  loader.importProfile,
  loader.copyProfileToLocal,
  loader.deleteUserProfile,
].every((entryPoint) => entryPoint === undefined));

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(50));

process.exit(failed > 0 ? 1 : 0);
