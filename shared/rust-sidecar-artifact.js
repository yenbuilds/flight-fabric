#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const RUST_SIDECAR_PENDING_DIR_NAME = '.pending';

function existingFileMtimeMs(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function getManagedRustSidecarPaths(telemetryProviderDir, binaryName) {
  const root = path.resolve(String(telemetryProviderDir || ''));
  const name = path.basename(String(binaryName || ''));
  if (!name || name === '.' || name === path.sep) {
    return { mainPath: null, pendingPath: null };
  }
  return {
    mainPath: path.join(root, name),
    pendingPath: path.join(root, RUST_SIDECAR_PENDING_DIR_NAME, name),
  };
}

/**
 * Choose the newest build-managed Rust executable.
 *
 * A live Windows build may be unable to replace whichever executable the
 * running backend currently owns. The builder writes the verified replacement
 * to the other managed location, so mtime determines the next process
 * generation. A tie deliberately selects the staged artifact; equal mtimes
 * mean both copies came from the same Cargo output, and this preserves the
 * pending-first handoff contract deterministically.
 */
function selectNewestManagedRustSidecar(telemetryProviderDir, binaryName) {
  const { mainPath, pendingPath } = getManagedRustSidecarPaths(
    telemetryProviderDir,
    binaryName,
  );
  const mainMtimeMs = existingFileMtimeMs(mainPath);
  const pendingMtimeMs = existingFileMtimeMs(pendingPath);

  if (mainMtimeMs === null) return pendingMtimeMs === null ? null : pendingPath;
  if (pendingMtimeMs === null) return mainPath;
  return pendingMtimeMs >= mainMtimeMs ? pendingPath : mainPath;
}

module.exports = {
  RUST_SIDECAR_PENDING_DIR_NAME,
  existingFileMtimeMs,
  getManagedRustSidecarPaths,
  selectNewestManagedRustSidecar,
};
