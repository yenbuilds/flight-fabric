'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const {
  ensureDirExists,
  getCommunitySdkConnectorsDir,
  getCommunitySdkConnectorsRemoteMetaDir,
  getLocalSdkConnectorsDir,
} = require('../utils/storage-paths.js') as {
  ensureDirExists: (dirPath: string) => string | null | undefined;
  getCommunitySdkConnectorsDir: () => string;
  getCommunitySdkConnectorsRemoteMetaDir: () => string;
  getLocalSdkConnectorsDir: () => string;
};
const {
  computeSha256FromFile,
  computeSha256FromText,
  createManagedInstallStateStore,
  sanitizeManagedInstallId,
} = require('../utils/managed-install-state.js') as {
  computeSha256FromFile: (filePath: string) => string;
  computeSha256FromText: (text: unknown) => string;
  createManagedInstallStateStore: (options: Record<string, any>) => {
    inspectInstall: (id: unknown) => Record<string, any>;
    readInstallMetadata: (id: unknown) => Record<string, any> | null;
    writeInstallMetadata: (id: unknown, payload: Record<string, any>) => Record<string, any>;
  };
  sanitizeManagedInstallId: (id: unknown) => string;
};
const { safeReplaceTextFileSync } = require('../utils/safe-fs.js') as {
  safeReplaceTextFileSync: (_options: {
    allowedExtensions?: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
};

type GenericRecord = Record<string, any>;
type ConnectorNamespace = 'local' | 'community';

const CONNECTOR_KIND = 'sdk-clientdata-connector';
const CONNECTOR_SCHEMA_VERSION = 1;
const MAX_CONNECTOR_TEXT_BYTES = 256 * 1024;
const MAX_CLIENT_DATA_SIZE = 16 * 1024;
const MAX_FIELDS = 512;
const MAX_NORMALIZED_MAPPINGS = 512;
const LOCAL_DIR = getLocalSdkConnectorsDir();
const COMMUNITY_DIR = getCommunitySdkConnectorsDir();
const REMOTE_META_DIR = getCommunitySdkConnectorsRemoteMetaDir();

const sanitizeConnectorId = sanitizeManagedInstallId;

function isObject(value: unknown): value is GenericRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function isSafeToken(value: unknown, maxLength = 96): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return /^[a-z0-9][a-z0-9._-]*$/i.test(trimmed) && trimmed.length <= maxLength;
}

function isSafeFieldName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/i.test(value.trim()) && value.trim().length <= 96;
}

function isSafeNormalizedPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) return false;
  const parts = trimmed.split('.');
  return parts.length > 0 && parts.length <= 8 && parts.every((part) => isSafeFieldName(part));
}

function isPrimitiveJson(value: unknown): boolean {
  return value == null || ['boolean', 'number', 'string'].includes(typeof value);
}

function isReadType(value: unknown): boolean {
  return typeof value === 'string'
    && ['bool', 'boolean', 'u8', 'uint8', 'i16le', 'int16le', 'u16le', 'uint16le', 'i32le', 'int32le', 'u32le', 'uint32le', 'f32le', 'float32le']
      .includes(value.trim().toLowerCase());
}

function readTypeWidth(value: unknown): number {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'bool' || normalized === 'boolean' || normalized === 'u8' || normalized === 'uint8') return 1;
  if (normalized === 'i16le' || normalized === 'int16le' || normalized === 'u16le' || normalized === 'uint16le') return 2;
  if (normalized === 'i32le' || normalized === 'int32le' || normalized === 'u32le' || normalized === 'uint32le' || normalized === 'f32le' || normalized === 'float32le') return 4;
  return 0;
}

function readWithinBounds(entry: GenericRecord, dataSize: number): boolean {
  if (!isReadType(entry.type)) return false;
  const offset = Number(entry.offset);
  const width = readTypeWidth(entry.type);
  return Number.isInteger(offset) && offset >= 0 && width > 0 && offset + width <= dataSize;
}

function isCondition(value: unknown, dataSize: number): boolean {
  if (!isObject(value) || !readWithinBounds(value, dataSize)) return false;
  const allowed = new Set(['offset', 'type', 'equals', 'gt', 'gte', 'lt', 'lte']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if ('equals' in value && !isPrimitiveJson(value.equals)) return false;
  for (const key of ['gt', 'gte', 'lt', 'lte']) {
    if (key in value && !(typeof value[key] === 'number' && Number.isFinite(value[key]))) return false;
  }
  return true;
}

function isFieldDefinition(value: unknown, dataSize: number): boolean {
  if (!isObject(value) || !isSafeFieldName(value.name)) return false;
  const op = typeof value.op === 'string' && value.op.trim() ? value.op.trim() : 'read';
  if (op !== 'read' && op !== 'any') return false;

  if (op === 'read' && !readWithinBounds(value, dataSize)) return false;
  if (op === 'any') {
    if (!Array.isArray(value.terms) || value.terms.length === 0 || value.terms.length > 16) return false;
    if (!value.terms.every((term) => isObject(term) && readWithinBounds(term, dataSize))) return false;
  }

  if ('equals' in value && !isPrimitiveJson(value.equals)) return false;
  if ('round' in value && !(Number.isInteger(value.round) && value.round >= 0 && value.round <= 6)) return false;
  if ('fallback' in value && !isPrimitiveJson(value.fallback)) return false;
  if ('map' in value) {
    if (!isObject(value.map) || Object.keys(value.map).length > 64) return false;
    if (!Object.values(value.map).every(isPrimitiveJson)) return false;
  }
  if ('when' in value) {
    if (!Array.isArray(value.when) || value.when.length > 16) return false;
    if (!value.when.every((condition) => isCondition(condition, dataSize))) return false;
  }
  return true;
}

function isKnownFieldReference(value: unknown, knownFields: Set<string>): boolean {
  return isSafeFieldName(value) && knownFields.has(value.trim().toLowerCase());
}

function isNormalizedCondition(value: unknown, knownFields: Set<string>): boolean {
  if (!isObject(value)) return false;
  const allowed = new Set(['field', 'equals']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!isKnownFieldReference(value.field, knownFields)) return false;
  return 'equals' in value && isPrimitiveJson(value.equals);
}

function isNormalizedMapping(value: unknown, knownFields: Set<string>): boolean {
  if (!isObject(value) || !isSafeNormalizedPath(value.path)) return false;
  const op = typeof value.op === 'string' && value.op.trim() ? value.op.trim() : 'copy';
  if (op !== 'copy' && op !== 'read' && op !== 'any') return false;

  if (op === 'copy' || op === 'read') {
    if (!isKnownFieldReference(value.field, knownFields)) return false;
    if ('fields' in value && Array.isArray(value.fields) && value.fields.length > 0) return false;
  } else {
    if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > 16) return false;
    if (!value.fields.every((field) => isKnownFieldReference(field, knownFields))) return false;
    if ('field' in value && value.field != null) return false;
  }

  if ('fallback' in value && !isPrimitiveJson(value.fallback)) return false;
  if ('map' in value) {
    if (!isObject(value.map) || Object.keys(value.map).length > 64) return false;
    if (!Object.values(value.map).every(isPrimitiveJson)) return false;
  }
  if ('when' in value) {
    if (!Array.isArray(value.when) || value.when.length > 16) return false;
    if (!value.when.every((condition) => isNormalizedCondition(condition, knownFields))) return false;
  }
  return true;
}

function isSdkConnectorDefinition(connector: unknown): connector is GenericRecord {
  if (!isObject(connector)) return false;
  if (connector.kind !== CONNECTOR_KIND || connector.schemaVersion !== CONNECTOR_SCHEMA_VERSION) return false;
  if (!isSafeToken(connector.id)) return false;
  if (typeof connector.displayName !== 'string' || !connector.displayName.trim() || connector.displayName.length > 128) return false;
  if (!Array.isArray(connector.targets) || connector.targets.length === 0 || connector.targets.length > 16) return false;
  if (!connector.targets.every((target) => isSafeToken(target))) return false;
  const clientData = connector.clientData;
  if (!isObject(clientData)) return false;
  if (typeof clientData.name !== 'string' || !clientData.name.trim() || clientData.name.includes('\0') || clientData.name.length > 128) return false;
  for (const key of ['dataId', 'defineId', 'requestId', 'size']) {
    if (!Number.isInteger(clientData[key]) || clientData[key] < 0) return false;
  }
  if (clientData.size <= 0 || clientData.size > MAX_CLIENT_DATA_SIZE) return false;
  if (!Array.isArray(connector.fields) || connector.fields.length === 0 || connector.fields.length > MAX_FIELDS) return false;
  const names = new Set<string>();
  for (const field of connector.fields) {
    if (!isFieldDefinition(field, clientData.size)) return false;
    const name = String(field.name).toLowerCase();
    if (names.has(name)) return false;
    names.add(name);
  }
  if ('normalized' in connector) {
    if (!Array.isArray(connector.normalized) || connector.normalized.length > MAX_NORMALIZED_MAPPINGS) return false;
    if (!connector.normalized.every((mapping) => isNormalizedMapping(mapping, names))) return false;
  }
  return true;
}

function serializeConnector(connector: GenericRecord): string {
  return JSON.stringify(connector, null, 2);
}

function getNamespaceDir(namespace: ConnectorNamespace): string {
  return namespace === 'community' ? COMMUNITY_DIR : LOCAL_DIR;
}

function resolveConnectorPath(id: unknown, namespace: ConnectorNamespace = 'community'): string | null {
  const connectorId = sanitizeConnectorId(id);
  if (!connectorId) return null;
  return path.join(getNamespaceDir(namespace), `${connectorId}.json`);
}

function readConnectorFile(filePath: string): GenericRecord | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_CONNECTOR_TEXT_BYTES) return null;
    const parsed = parseJsonText(fs.readFileSync(filePath, 'utf8'));
    return isSdkConnectorDefinition(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function importConnectorDefinition(connector: GenericRecord, options: { namespace?: ConnectorNamespace; overwrite?: boolean } = {}): GenericRecord {
  if (!isSdkConnectorDefinition(connector)) {
    return { ok: false, error: 'SDK connector definition failed schema validation.' };
  }

  const namespace = options.namespace === 'local' ? 'local' : 'community';
  const connectorId = sanitizeConnectorId(connector.id);
  const filePath = resolveConnectorPath(connectorId, namespace);
  if (!filePath) return { ok: false, error: 'Invalid SDK connector id.' };
  if (fs.existsSync(filePath) && options.overwrite !== true) {
    return { ok: false, error: 'SDK connector already exists.' };
  }

  ensureDirExists(path.dirname(filePath));
  safeReplaceTextFileSync({
    allowedExtensions: ['.json'],
    data: serializeConnector(connector),
    operation: 'importSdkConnectorDefinition',
    rootDir: getNamespaceDir(namespace),
    targetPath: filePath,
  });
  return { ok: true, id: connectorId, filePath, namespace };
}

function listConnectorFiles(namespace: ConnectorNamespace): string[] {
  const dir = getNamespaceDir(namespace);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(dir, entry.name));
}

function listInstalledConnectors(): GenericRecord[] {
  const entries: GenericRecord[] = [];
  for (const namespace of ['local', 'community'] as ConnectorNamespace[]) {
    for (const filePath of listConnectorFiles(namespace)) {
      const connector = readConnectorFile(filePath);
      if (!connector) continue;
      entries.push({
        id: connector.id,
        displayName: connector.displayName,
        namespace,
        filePath,
        targets: connector.targets,
        sha256: computeSha256FromFile(filePath),
      });
    }
  }
  return entries;
}

const installStateStore = createManagedInstallStateStore({
  metadataDir: REMOTE_META_DIR,
  receiptKind: 'remote-sdk-connector-install',
  idField: 'connectorId',
  inspectIdKey: 'connectorId',
  resolveInstallPath: (id: string) => resolveConnectorPath(id, 'community'),
  buildStoredMetadata(payload: GenericRecord) {
    return {
      slug: typeof payload.slug === 'string' ? payload.slug : '',
      sourceBaseUrl: typeof payload.sourceBaseUrl === 'string' ? payload.sourceBaseUrl : '',
      remoteVersion: typeof payload.remoteVersion === 'string' ? payload.remoteVersion : '',
      remoteSha256: typeof payload.remoteSha256 === 'string' ? payload.remoteSha256 : '',
      installedLocalSha256: typeof payload.installedLocalSha256 === 'string' ? payload.installedLocalSha256 : '',
      installedAt: typeof payload.installedAt === 'string' ? payload.installedAt : new Date().toISOString(),
      remoteUpdatedAt: typeof payload.remoteUpdatedAt === 'string' ? payload.remoteUpdatedAt : null,
      title: typeof payload.title === 'string' ? payload.title : '',
    };
  },
  normalizeStoredMetadata(parsed: GenericRecord) {
    return {
      slug: typeof parsed.slug === 'string' ? parsed.slug : '',
      sourceBaseUrl: typeof parsed.sourceBaseUrl === 'string' ? parsed.sourceBaseUrl : '',
      remoteVersion: typeof parsed.remoteVersion === 'string' ? parsed.remoteVersion : '',
      remoteSha256: typeof parsed.remoteSha256 === 'string' ? parsed.remoteSha256 : '',
      installedLocalSha256: typeof parsed.installedLocalSha256 === 'string' ? parsed.installedLocalSha256 : '',
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
      remoteUpdatedAt: typeof parsed.remoteUpdatedAt === 'string' ? parsed.remoteUpdatedAt : null,
      title: typeof parsed.title === 'string' ? parsed.title : '',
    };
  },
});

const sdkConnectorStoreApi = {
  computeSha256FromFile,
  computeSha256FromText,
  importConnectorDefinition,
  inspectCommunityConnectorInstall: installStateStore.inspectInstall,
  isSdkConnectorDefinition,
  listInstalledConnectors,
  readConnectorFile,
  resolveConnectorPath,
  sanitizeConnectorId,
  serializeConnector,
  writeInstallMetadata: installStateStore.writeInstallMetadata,
};

module.exports = sdkConnectorStoreApi;

export {};
