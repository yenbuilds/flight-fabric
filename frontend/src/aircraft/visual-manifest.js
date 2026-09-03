const ASSET_ROOT = '/assets/aircraft';

function asset(label) {
  return Object.freeze({
    label,
    width: 720,
    height: 480,
  });
}

export const AIRCRAFT_VISUAL_ASSETS = Object.freeze({
  'airbus-a220-300': asset('Airbus A220-300'),
  'airbus-a300-600r': asset('Airbus A300-600R'),
  'airbus-a310-300': asset('Airbus A310-300'),
  'airbus-a319': asset('Airbus A319'),
  'airbus-a320ceo': asset('Airbus A320ceo'),
  'airbus-a320neo': asset('Airbus A320neo'),
  'airbus-a321': asset('Airbus A321'),
  'airbus-a321lr': asset('Airbus A321LR'),
  'airbus-a330-family': asset('Airbus A330 Family'),
  'airbus-a330-900neo': asset('Airbus A330-900neo'),
  'airbus-a380-800': asset('Airbus A380-800'),
  'airbus-a400m': asset('Airbus A400M'),
  'atr-72-600': asset('ATR 72-600'),
  'bae-146-family': asset('BAe 146 / Avro RJ'),
  'boeing-737-800': asset('Boeing 737-800'),
  'boeing-737-max-8': asset('Boeing 737 MAX 8'),
  'boeing-747-8': asset('Boeing 747-8'),
  'boeing-777-300er': asset('Boeing 777-300ER'),
  'boeing-787-8': asset('Boeing 787-8'),
  'boeing-787-9': asset('Boeing 787-9'),
  'boeing-787-10': asset('Boeing 787-10'),
  'boeing-c17': asset('C-17 Globemaster III'),
  'citation-cj4': asset('Citation CJ4'),
  'citation-longitude': asset('Citation Longitude'),
  'embraer-e170-e175': asset('Embraer E170 / E175'),
  'general-aviation': asset('General Aviation Aircraft'),
  'generic-aircraft': asset('Aircraft'),
  'lockheed-l1011-500': asset('Lockheed L-1011-500'),
  'mcdonnell-douglas-md11': asset('McDonnell Douglas MD-11'),
  'regional-jet': asset('Regional Jet'),
  'turboprop': asset('Regional Turboprop'),
  'widebody': asset('Widebody Aircraft'),
});

export const AIRCRAFT_PROFILE_VISUALS = Object.freeze({
  'bundled/msfs/asobo-787': { assetKey: 'boeing-787-10', fidelity: 'exact' },
  'bundled/msfs/fbw-a32nx': { assetKey: 'airbus-a320neo', fidelity: 'exact' },
  'bundled/msfs/fbw-a380x': { assetKey: 'airbus-a380-800', fidelity: 'exact' },
  'bundled/msfs/fenix-a319': { assetKey: 'airbus-a319', fidelity: 'exact' },
  'bundled/msfs/fenix-a320': { assetKey: 'airbus-a320ceo', fidelity: 'exact' },
  'bundled/msfs/fenix-a321': { assetKey: 'airbus-a321', fidelity: 'exact' },
  'bundled/msfs/fss-e175': { assetKey: 'embraer-e170-e175', fidelity: 'family' },
  'bundled/msfs/ga-base': { assetKey: 'general-aviation', fidelity: 'class' },
  'bundled/msfs/generic': { assetKey: 'generic-aircraft', fidelity: 'class' },
  'bundled/msfs/headwind-a330': { assetKey: 'airbus-a330-900neo', fidelity: 'exact' },
  'bundled/msfs/horizon-787-9': { assetKey: 'boeing-787-9', fidelity: 'exact' },
  'bundled/msfs/ifly-737-max-8': { assetKey: 'boeing-737-max-8', fidelity: 'exact' },
  'bundled/msfs/inibuilds-a300': { assetKey: 'airbus-a300-600r', fidelity: 'family' },
  'bundled/msfs/inibuilds-a310': { assetKey: 'airbus-a310-300', fidelity: 'family' },
  'bundled/msfs/inibuilds-a320neo-v2': { assetKey: 'airbus-a320neo', fidelity: 'exact' },
  'bundled/msfs/inibuilds-a321lr': { assetKey: 'airbus-a321lr', fidelity: 'exact' },
  'bundled/msfs/inibuilds-a330': { assetKey: 'airbus-a330-family', fidelity: 'family' },
  'bundled/msfs/inibuilds-a350-900': { assetKey: 'widebody', fidelity: 'class' },
  'bundled/msfs/inibuilds-a350-1000': { assetKey: 'widebody', fidelity: 'class' },
  'bundled/msfs/inibuilds-a400m': { assetKey: 'airbus-a400m', fidelity: 'exact' },
  'bundled/msfs/inibuilds-tristar': { assetKey: 'lockheed-l1011-500', fidelity: 'exact' },
  'bundled/msfs/justflight-146': { assetKey: 'bae-146-family', fidelity: 'family' },
  'bundled/msfs/kuro-787-8': { assetKey: 'boeing-787-8', fidelity: 'exact' },
  'bundled/msfs/microsoft-737-max-8': { assetKey: 'boeing-737-max-8', fidelity: 'exact' },
  'bundled/msfs/microsoft-atr-72-600': { assetKey: 'atr-72-600', fidelity: 'exact' },
  'bundled/msfs/miltech-c17': { assetKey: 'boeing-c17', fidelity: 'exact' },
  'bundled/msfs/pmdg-737': { assetKey: 'boeing-737-800', fidelity: 'exact' },
  'bundled/msfs/pmdg-737-600': { assetKey: 'boeing-737-800', fidelity: 'family' },
  'bundled/msfs/pmdg-737-700': { assetKey: 'boeing-737-800', fidelity: 'family' },
  'bundled/msfs/pmdg-737-900': { assetKey: 'boeing-737-800', fidelity: 'family' },
  'bundled/msfs/pmdg-777': { assetKey: 'boeing-777-300er', fidelity: 'exact' },
  'bundled/msfs/pmdg-777-200er': { assetKey: 'boeing-777-300er', fidelity: 'family' },
  'bundled/msfs/pmdg-777-200lr': { assetKey: 'boeing-777-300er', fidelity: 'family' },
  'bundled/msfs/pmdg-777f': { assetKey: 'boeing-777-300er', fidelity: 'family' },
  'bundled/msfs/regional-jet': { assetKey: 'regional-jet', fidelity: 'class' },
  'bundled/msfs/tfdi-md-11': { assetKey: 'mcdonnell-douglas-md11', fidelity: 'exact' },
  'bundled/msfs/turboprop-base': { assetKey: 'turboprop', fidelity: 'class' },
  'bundled/msfs/virtualcol-a220': { assetKey: 'airbus-a220-300', fidelity: 'family' },
  'bundled/msfs/widebody-base': { assetKey: 'widebody', fidelity: 'class' },
  'bundled/msfs/workingtitle-747-8': { assetKey: 'boeing-747-8', fidelity: 'exact' },
  'bundled/msfs/workingtitle-citation-longitude': { assetKey: 'citation-longitude', fidelity: 'exact' },
  'bundled/msfs/workingtitle-cj4': { assetKey: 'citation-cj4', fidelity: 'exact' },
  'bundled/xplane/generic': { assetKey: 'generic-aircraft', fidelity: 'class' },
  'bundled/xplane/laminar-737-800': { assetKey: 'boeing-737-800', fidelity: 'exact' },
  'bundled/xplane/toliss-a320-family': { assetKey: 'airbus-a320neo', fidelity: 'family' },
  'bundled/xplane/zibo-737-800': { assetKey: 'boeing-737-800', fidelity: 'exact' },
});

const FALLBACK_ASSET_KEYS = new Set([
  'general-aviation',
  'generic-aircraft',
  'regional-jet',
  'turboprop',
  'widebody',
]);

const NAME_RULES = [
  { aliases: ['A380', 'A380X', 'A388'], assetKey: 'airbus-a380-800' },
  // "Atlas" alone is unsafe: it is also an airline and appears in unrelated aircraft names.
  { aliases: ['A400M'], assetKey: 'airbus-a400m' },
  {
    aliases: ['A330-900', 'A330-900neo', 'A330-941', 'A339', 'A339X'],
    wholeAliases: ['Headwind A330'],
    allOf: [
      ['Headwind'],
      ['A330', 'A339X'],
    ],
    assetKey: 'airbus-a330-900neo',
  },
  { aliases: ['A330', 'A332', 'A333', 'A33F'], assetKey: 'airbus-a330-family' },
  {
    allOf: [
      ['Fenix', 'FNX'],
      ['A321', 'FNX321'],
    ],
    assetKey: 'airbus-a321',
  },
  { aliases: ['A321LR'], assetKey: 'airbus-a321lr' },
  { aliases: ['A321', 'A21N', 'FNX321'], assetKey: 'airbus-a321' },
  {
    allOf: [
      ['Fenix', 'FNX'],
      ['A320', 'FNX320', 'FNX32X'],
    ],
    assetKey: 'airbus-a320ceo',
  },
  {
    aliases: ['A320neo', 'A20N', 'A32NX'],
    allOf: [
      ['FlyByWire', 'FBW'],
      ['A320'],
    ],
    assetKey: 'airbus-a320neo',
  },
  { aliases: ['A320', 'FNX320', 'FNX32X'], assetKey: 'airbus-a320ceo' },
  { aliases: ['A319', 'A19N', 'FNX319'], assetKey: 'airbus-a319' },
  { aliases: ['A310'], assetKey: 'airbus-a310-300' },
  { aliases: ['A300', 'A306'], assetKey: 'airbus-a300-600r' },
  { aliases: ['A220', 'A220-300', 'A223', 'BCS3', 'CS300', 'BD-500'], assetKey: 'airbus-a220-300' },
  { aliases: ['787-10', 'B78X'], assetKey: 'boeing-787-10' },
  { aliases: ['787-9', 'B789'], assetKey: 'boeing-787-9' },
  { aliases: ['787-8', 'B788'], assetKey: 'boeing-787-8' },
  // The catalog art is specifically the -300ER; only identified PMDG siblings use it as family art.
  {
    allOf: [
      ['PMDG'],
      ['777-300ER', '77W', '777-200ER', '777-200LR', '77L', '777F', '777 Freighter'],
    ],
    assetKey: 'boeing-777-300er',
  },
  {
    aliases: ['777-300ER', 'B77W'],
    assetKey: 'boeing-777-300er',
  },
  {
    aliases: ['737 MAX 8', '737-8 MAX', 'B38M'],
    allOf: [
      ['iFly'],
      ['MAX 8'],
    ],
    assetKey: 'boeing-737-max-8',
  },
  {
    allOf: [
      ['PMDG'],
      ['737-600', 'B736', '737-700', 'B737', '737-800', 'B738', '737-900', '737-900ER', 'B739'],
    ],
    assetKey: 'boeing-737-800',
  },
  {
    aliases: ['737-800', 'B738'],
    wholeAliases: ['Laminar 737', 'Laminar Research 737'],
    assetKey: 'boeing-737-800',
  },
  { aliases: ['747-8', 'B748'], assetKey: 'boeing-747-8' },
  { aliases: ['C-17', 'C17', 'Globemaster'], assetKey: 'boeing-c17' },
  {
    aliases: ['E170', 'E175', 'E75S', 'E75L', 'ERJ-170', 'ERJ-175', 'Embraer 170', 'Embraer 175'],
    assetKey: 'embraer-e170-e175',
  },
  {
    aliases: ['BAe 146', 'BA146', 'Avro RJ', 'RJ85', 'RJ100'],
    allOf: [
      ['Just Flight', 'JustFlight', 'JF', 'JFA'],
      ['146'],
    ],
    assetKey: 'bae-146-family',
  },
  { aliases: ['ATR 72', 'ATR72', 'AT76'], assetKey: 'atr-72-600' },
  { aliases: ['L-1011', 'L1011', 'L101', 'TriStar'], assetKey: 'lockheed-l1011-500' },
  { aliases: ['MD-11', 'MD11'], assetKey: 'mcdonnell-douglas-md11' },
  {
    aliases: ['Citation Longitude', 'Cessna Citation Longitude', 'Cessna Model 700'],
    wholeAliases: ['Longitude', 'Model 700'],
    allOf: [
      ['Working Title'],
      ['Longitude'],
    ],
    assetKey: 'citation-longitude',
  },
  {
    aliases: ['Citation CJ4', 'CJ4', 'Cessna Model 525C'],
    wholeAliases: ['Model 525C'],
    assetKey: 'citation-cj4',
  },
];

function normalizeIdentity(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/([a-z])(?=\d)|(\d)(?=[a-z])/g, '$& ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesIdentityPhrase(identity, phrase) {
  const normalizedPhrase = normalizeIdentity(phrase);
  if (!normalizedPhrase) return false;
  return ` ${identity} `.includes(` ${normalizedPhrase} `);
}

function matchesAnyIdentityPhrase(identity, phrases) {
  return Array.isArray(phrases) && phrases.some((phrase) => includesIdentityPhrase(identity, phrase));
}

function matchesNameRule(identity, rule) {
  if (matchesAnyIdentityPhrase(identity, rule.aliases)) return true;
  if (Array.isArray(rule.wholeAliases)
    && rule.wholeAliases.some((alias) => identity === normalizeIdentity(alias))) {
    return true;
  }
  if (Array.isArray(rule.allOf)
    && rule.allOf.every((phrases) => matchesAnyIdentityPhrase(identity, phrases))) {
    return true;
  }
  return false;
}

function normalizeProfileId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

const SHORT_PROFILE_VISUALS = Object.freeze(Object.entries(AIRCRAFT_PROFILE_VISUALS).reduce((index, [qualifiedId, mapping]) => {
  const shortId = qualifiedId.split('/').pop();
  if (!shortId) return index;
  if (!index[shortId] || index[shortId].assetKey === mapping.assetKey) {
    index[shortId] = mapping;
  } else {
    index[shortId] = null;
  }
  return index;
}, {}));

function resolveProfileMapping(profileId) {
  const normalized = normalizeProfileId(profileId);
  if (!normalized) return null;
  if (AIRCRAFT_PROFILE_VISUALS[normalized]) return AIRCRAFT_PROFILE_VISUALS[normalized];
  const shortId = normalized.split('/').pop();
  return SHORT_PROFILE_VISUALS[shortId] || null;
}

function resolveNameAssetKey(aircraftName) {
  const normalized = normalizeIdentity(aircraftName);
  if (!normalized) return '';
  return NAME_RULES.find((rule) => matchesNameRule(normalized, rule))?.assetKey || '';
}

function buildResolvedVisual(assetKey, fidelity) {
  const safeAssetKey = AIRCRAFT_VISUAL_ASSETS[assetKey] ? assetKey : 'generic-aircraft';
  const definition = AIRCRAFT_VISUAL_ASSETS[safeAssetKey];
  return Object.freeze({
    ...definition,
    assetKey: safeAssetKey,
    fidelity: safeAssetKey === assetKey ? fidelity : 'class',
    src: `${ASSET_ROOT}/${safeAssetKey}.png`,
  });
}

export function resolveAircraftVisual({ profileId = '', profileKey = '', aircraftName = '' } = {}) {
  const profileMapping = resolveProfileMapping(profileKey) || resolveProfileMapping(profileId);
  if (profileMapping && !FALLBACK_ASSET_KEYS.has(profileMapping.assetKey)) {
    return buildResolvedVisual(profileMapping.assetKey, profileMapping.fidelity);
  }

  const nameAssetKey = resolveNameAssetKey(aircraftName);
  if (nameAssetKey) return buildResolvedVisual(nameAssetKey, 'name');
  if (profileMapping) return buildResolvedVisual(profileMapping.assetKey, profileMapping.fidelity);
  return buildResolvedVisual('generic-aircraft', 'class');
}

export function getAircraftVisualAssetKeys() {
  return Object.keys(AIRCRAFT_VISUAL_ASSETS);
}
