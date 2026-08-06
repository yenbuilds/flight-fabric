'use strict';

const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { ensureDirExists } = require('./storage-paths.js') as {
  ensureDirExists: (dirPath: string) => string | null | undefined;
};
const { safeReplaceTextFileSync, safeUnlinkSync } = require('./safe-fs.js') as {
  safeReplaceTextFileSync: (_options: {
    allowedExtensions?: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
  safeUnlinkSync: (_options: {
    allowedExtensions?: string[];
    allowMissing?: boolean;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => boolean;
};

type GenericRecord = Record<string, any>;

type ManagedInstallStateStoreOptions = {
  acceptedVersions?: number[];
  buildStoredMetadata?: (payload: GenericRecord, sanitizedId: string) => GenericRecord;
  extraInspect?: (state: GenericRecord) => GenericRecord | null | undefined;
  idField?: string;
  inspectIdKey?: string;
  inspectPathKey?: string;
  metadataDir?: string;
  normalizeStoredMetadata?: (parsed: GenericRecord, sanitizedId: string) => GenericRecord;
  receiptKind?: string;
  receiptVersion?: number;
  resolveInstallPath?: (id: string) => string | null;
};

type ManagedInstallStateStore = {
  deleteInstallMetadata: (id: unknown) => void;
  getMetadataPath: (id: unknown) => string | null;
  inspectInstall: (id: unknown) => GenericRecord;
  readInstallMetadata: (id: unknown) => GenericRecord | null;
  writeInstallMetadata: (id: unknown, payload: GenericRecord) => GenericRecord;
};

function sanitizeManagedInstallId(id: unknown): string {
  if (typeof id !== 'string') return '';
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
}

function computeSha256FromBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function computeSha256FromText(text: unknown): string {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function computeSha256FromFile(filePath: string): string {
  return computeSha256FromBuffer(fs.readFileSync(filePath));
}

function createManagedInstallStateStore(options: ManagedInstallStateStoreOptions = {}): ManagedInstallStateStore {
  const {
    metadataDir,
    receiptKind,
    receiptVersion = 1,
    acceptedVersions = [receiptVersion],
    idField,
    inspectIdKey = idField,
    inspectPathKey = 'filePath',
    resolveInstallPath,
    buildStoredMetadata,
    normalizeStoredMetadata,
    extraInspect,
  } = options;

  if (!metadataDir || !receiptKind || !idField || typeof resolveInstallPath !== 'function') {
    throw new Error('Managed install state store requires metadataDir, receiptKind, idField, and resolveInstallPath.');
  }

  const resolvedIdField = idField as string;
  const resolvedInspectIdKey = (inspectIdKey || resolvedIdField) as string;
  const resolvedMetadataDir = metadataDir as string;
  const resolvedResolveInstallPath = resolveInstallPath as (id: string) => string | null;

  function getMetadataPath(id: unknown): string | null {
    const sanitizedId = sanitizeManagedInstallId(id);
    if (!sanitizedId) return null;
    return path.join(resolvedMetadataDir, `${sanitizedId}.json`);
  }

  function readInstallMetadata(id: unknown): GenericRecord | null {
    const sanitizedId = sanitizeManagedInstallId(id);
    const metadataPath = getMetadataPath(sanitizedId);
    if (!sanitizedId || !metadataPath || !fs.existsSync(metadataPath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as GenericRecord;
      if (!parsed || typeof parsed !== 'object') return null;
      if (parsed.kind !== receiptKind) return null;
      if (!acceptedVersions.includes(parsed.version)) return null;
      const storedId =
        typeof parsed[resolvedIdField] === 'string' && parsed[resolvedIdField].trim()
          ? parsed[resolvedIdField].trim()
          : sanitizedId;
      if (sanitizeManagedInstallId(storedId) !== sanitizedId) return null;

      const baseMetadata: GenericRecord = {
        kind: receiptKind,
        version: parsed.version,
        [resolvedIdField]: storedId,
      };
      const extraMetadata = typeof normalizeStoredMetadata === 'function'
        ? normalizeStoredMetadata(parsed, sanitizedId)
        : {};

      return { ...baseMetadata, ...extraMetadata };
    } catch {
      return null;
    }
  }

  function writeInstallMetadata(id: unknown, payload: GenericRecord = {}): GenericRecord {
    const sanitizedId = sanitizeManagedInstallId(id);
    const metadataPath = getMetadataPath(sanitizedId);
    if (!sanitizedId || !metadataPath) {
      throw new Error(`Invalid install ID for ${receiptKind} metadata`);
    }
    const storedId = typeof id === 'string' && id.trim() ? id.trim() : sanitizedId;

    ensureDirExists(resolvedMetadataDir);

    const next: GenericRecord = {
      kind: receiptKind,
      version: receiptVersion,
      [resolvedIdField]: storedId,
      ...(typeof buildStoredMetadata === 'function' ? buildStoredMetadata(payload || {}, sanitizedId) : {}),
    };

    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: JSON.stringify(next, null, 2),
      operation: `write${receiptKind}Metadata`,
      rootDir: resolvedMetadataDir,
      targetPath: metadataPath,
    });
    return next;
  }

  function deleteInstallMetadata(id: unknown): void {
    const metadataPath = getMetadataPath(id);
    if (!metadataPath) return;
    safeUnlinkSync({
      allowedExtensions: ['.json'],
      allowMissing: true,
      operation: `delete${receiptKind}Metadata`,
      rootDir: resolvedMetadataDir,
      targetPath: metadataPath,
    });
  }

  function inspectInstall(id: unknown): GenericRecord {
    const sanitizedId = sanitizeManagedInstallId(id);
    const installId = typeof id === 'string' && id.trim() ? id.trim() : sanitizedId;
    const installPath = resolvedResolveInstallPath(installId);
    const metadataPath = getMetadataPath(sanitizedId);
    const metadata = readInstallMetadata(sanitizedId);
    const exists = Boolean(installPath && fs.existsSync(installPath));
    const currentLocalSha256 = exists && installPath ? computeSha256FromFile(installPath) : null;
    const isManifestLocallyModified = Boolean(
      exists &&
      metadata &&
      typeof metadata.installedLocalSha256 === 'string' &&
      metadata.installedLocalSha256 &&
      currentLocalSha256 &&
      metadata.installedLocalSha256 !== currentLocalSha256
    );

    const extraState = typeof extraInspect === 'function'
      ? (extraInspect({
          id: installId,
          metadata,
          exists,
          installPath,
          metadataPath,
          currentLocalSha256,
          isManifestLocallyModified,
        }) || {})
      : {};
    const { isLocallyModified: explicitIsLocallyModified, ...restExtraState } = extraState;

    return {
      [resolvedInspectIdKey]: (metadata && metadata[resolvedIdField]) || installId || null,
      [inspectPathKey]: installPath,
      metadataPath,
      exists,
      metadata,
      hasMetadata: Boolean(metadata),
      currentLocalSha256,
      isManifestLocallyModified,
      isLocallyModified:
        typeof explicitIsLocallyModified === 'boolean' ? explicitIsLocallyModified : isManifestLocallyModified,
      ...restExtraState,
    };
  }

  return Object.freeze({
    deleteInstallMetadata,
    getMetadataPath,
    inspectInstall,
    readInstallMetadata,
    writeInstallMetadata,
  });
}

const managedInstallStateApi = {
  computeSha256FromBuffer,
  computeSha256FromFile,
  computeSha256FromText,
  createManagedInstallStateStore,
  sanitizeManagedInstallId,
};

module.exports = managedInstallStateApi;

export {};
