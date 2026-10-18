import { AIRCRAFT_DEFINITION_MAX_BYTES, bundledProfileKeySchema, createDocumentValidator, loadYamlDocument, strictObject } from './integration-engine/definition-yaml.js';
import { readAircraftDefinitionFiles } from './aircraft-definition-catalogue.js';

const path: typeof import('node:path') = require('node:path');

type ProfileDocument = Record<string, any>;
type AircraftDocument = { schemaVersion: 1; integration?: Record<string, unknown>; profiles?: Record<string, ProfileDocument> };
export type BundledProfileSource = Readonly<{
  profileKey: string;
  filePath: string;
  namespace: 'bundled';
  simulator: 'msfs' | 'xplane';
  id: string;
  rawProfile: ProfileDocument;
}>;

export const BUNDLED_PROFILE_SOURCE_DIR = path.join(__dirname, 'aircraft-integrations');
const validateDocument = createDocumentValidator<AircraftDocument>({
  ...strictObject({
    schemaVersion: { const: 1 },
    integration: { type: 'object' },
    profiles: {
      type: 'object', minProperties: 1,
      propertyNames: bundledProfileKeySchema,
      additionalProperties: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string', minLength: 1 } },
      },
    },
  }, ['schemaVersion']),
  anyOf: [
    { properties: { integration: {} }, required: ['integration'] },
    { properties: { profiles: {} }, required: ['profiles'] },
  ],
});
const sourceCaches = new Map<string, ReadonlyMap<string, BundledProfileSource>>();

function getSourceIndex(directory: string): ReadonlyMap<string, BundledProfileSource> {
  const root = path.resolve(directory);
  const cached = sourceCaches.get(root);
  if (cached) return cached;
  const sources = new Map<string, BundledProfileSource>();
  const files = readAircraftDefinitionFiles(root);
  for (const file of files) {
    const filePath = path.join(root, file);
    const document = loadYamlDocument(filePath, validateDocument, AIRCRAFT_DEFINITION_MAX_BYTES);
    for (const [profileKey, rawProfile] of Object.entries(document.profiles || {})) {
      const [, simulator, id] = profileKey.split('/') as ['bundled', 'msfs' | 'xplane', string];
      if (rawProfile.id !== id || (rawProfile.namespace !== undefined && rawProfile.namespace !== 'bundled')
        || (rawProfile.simulator !== undefined && rawProfile.simulator !== simulator)) {
        throw new Error(`Aircraft profile identity does not match "${profileKey}" in "${filePath}"`);
      }
      if (sources.has(profileKey)) throw new Error(`Duplicate bundled aircraft profile "${profileKey}"`);
      sources.set(profileKey, Object.freeze({ profileKey, filePath, namespace: 'bundled', simulator, id, rawProfile }));
    }
  }
  if (sources.size === 0) throw new Error(`No bundled aircraft profiles found in "${root}"`);
  // Preserve the former simulator-directory / JSON-filename discovery order:
  // family-variant.json sorts before family.json, unlike the bare logical keys.
  const ordered = new Map([...sources].sort(([a], [b]) => {
    const formerPathA = `${a}.json`;
    const formerPathB = `${b}.json`;
    return formerPathA < formerPathB ? -1 : formerPathA > formerPathB ? 1 : 0;
  }));
  sourceCaches.set(root, ordered);
  return ordered;
}

export function listBundledProfileSources(directory = BUNDLED_PROFILE_SOURCE_DIR): readonly BundledProfileSource[] {
  return [...getSourceIndex(directory).values()];
}

export function getBundledProfileSource(profileKey: string, directory = BUNDLED_PROFILE_SOURCE_DIR): BundledProfileSource | null {
  return getSourceIndex(directory).get(profileKey) || null;
}

export function readBundledProfile(profileKey: string, directory = BUNDLED_PROFILE_SOURCE_DIR): ProfileDocument | null {
  const source = getBundledProfileSource(profileKey, directory);
  // Callers historically received independent parsed JSON objects.
  return source ? JSON.parse(JSON.stringify(source.rawProfile)) : null;
}

export function clearBundledProfileSourceCache(): void {
  sourceCaches.clear();
}
