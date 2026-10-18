import { readBundledDefinitionBytes } from './integration-engine/definition-yaml.js';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');

/** One bounded release-owned file list serves both integration and profile discovery. */
export function readAircraftDefinitionFiles(directory: string): readonly string[] {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, '..', 'aircraft-definition-files.json');
  const manifestBytes = readBundledDefinitionBytes(manifestPath, 32 * 1024);
  const files: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (!Array.isArray(files) || files.length === 0 || files.length > 256
    || files.some(file => typeof file !== 'string' || !/^[a-z0-9][a-z0-9_-]*\.yaml$/.test(file))
    || new Set(files).size !== files.length) {
    throw new Error(`Invalid aircraft definition file manifest: "${manifestPath}"`);
  }
  const actualFiles = fs.readdirSync(root).filter(file => file.endsWith('.yaml'));
  if (actualFiles.some(file => !files.includes(file))) throw new Error(`Unlisted aircraft definition in "${root}"`);
  for (const file of files) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
      throw new Error(`Missing aircraft definition "${filePath}"`);
    }
  }
  return files;
}
