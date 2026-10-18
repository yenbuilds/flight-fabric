import Ajv, { type AnySchema, type ValidateFunction } from 'ajv';

const fs: typeof import('node:fs') = require('node:fs');

export const logicalIdSchema = { type: 'string', pattern: '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)+(?![\\s\\S])' };
export const adapterIdSchema = { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?![\\s\\S])' };
export const bundledProfileKeySchema = { type: 'string', pattern: '^bundled/(msfs|xplane)/[a-z0-9][a-z0-9_-]*(?![\\s\\S])' };
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor', '<<']);
const MAX_FILE_BYTES = 64 * 1024;
export const AIRCRAFT_DEFINITION_MAX_BYTES = 2 * 1024 * 1024;
const ajv = new Ajv({ strict: true, allErrors: true, inlineRefs: false });

export function strictObject(properties: Record<string, AnySchema>, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties };
}

export function createDocumentValidator<T>(schema: AnySchema): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}

/** Read immutable release assets without allocating or reading beyond their byte limit. */
export function readBundledDefinitionBytes(filePath: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid aircraft definition byte limit');
  const initial = fs.lstatSync(filePath);
  if (!initial.isFile()) throw new Error(`Aircraft definition is not a regular file: "${filePath}"`);
  if (initial.size > maxBytes) throw new Error(`Aircraft definition "${filePath}" exceeds ${maxBytes} bytes`);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size) {
      throw new Error(`Aircraft definition changed while opening: "${filePath}"`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) throw new Error(`Aircraft definition changed while reading: "${filePath}"`);
      offset += bytesRead;
    }
    const final = fs.fstatSync(descriptor);
    if (final.size !== opened.size) throw new Error(`Aircraft definition changed while reading: "${filePath}"`);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function parseDefinition(text: string): unknown {
  if (text.startsWith('{')) {
    try {
      const data: unknown = JSON.parse(text, (key, value) => {
        if (RESERVED_KEYS.has(key)) throw new Error(`unsupported key "${key}"`);
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('YAML numeric values must be finite');
        return value;
      });
      if (JSON.stringify(data) === text) return data;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const { isAlias, isScalar, parseDocument, visit } = require('yaml') as typeof import('yaml');
  const document = parseDocument(text, {
    version: '1.2', schema: 'core', strict: true, uniqueKeys: true,
    stringKeys: true, merge: false, resolveKnownTags: false,
  });
  const issue = document.errors[0] || document.warnings[0];
  if (issue) throw new Error(issue.message);
  if (document.directives.yaml.version !== '1.2') throw new Error('requires YAML 1.2');
  visit(document, {
    Node(nodeKey, node) {
      if (isAlias(node)) throw new Error('YAML aliases are not supported');
      if (node.anchor || node.tag) throw new Error('YAML anchors and explicit tags are not supported');
      if (isScalar(node) && typeof node.value === 'number' && !Number.isFinite(node.value)) {
        throw new Error('YAML numeric values must be finite');
      }
      if (nodeKey === 'key' && isScalar(node) && RESERVED_KEYS.has(String(node.value))) {
        throw new Error(`unsupported key "${node.value}"`);
      }
    },
  });
  return document.toJS({ maxAliasCount: 0 });
}

/** Shared parsing boundary for bundled data. Tags, aliases and executable modules are never loaded. */
export function loadYamlDocument<T>(
  filePath: string,
  validate: ValidateFunction<T>,
  maxBytes = MAX_FILE_BYTES,
): T {
  try {
    const bytes = readBundledDefinitionBytes(filePath, maxBytes);
    const data = parseDefinition(bytes.toString('utf8'));
    if (!validate(data)) throw new Error(ajv.errorsText(validate.errors, { dataVar: 'definition' }));
    return freezeTree(data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid aircraft definition "${filePath}": ${reason}`, { cause: error });
  }
}
