#!/usr/bin/env node
'use strict';

/**
 * Assemble the FlightFabric MSFS 2024 toolbar package.
 *
 *   node msfs-toolbar-panel/tools/build-package.js          # write package/
 *   node msfs-toolbar-panel/tools/build-package.js --check  # verify package/ is current
 *
 * Generates the compiled panel definition (SPB), the port-placeholder config
 * script, both native icons, layout.json and manifest.json next to the loader
 * files under msfs-toolbar-panel/package/. The output is committed; the
 * desktop app copies it into the simulator Community folder at install time
 * after substituting the user's ports.
 */

const fs = require('node:fs');
const path = require('node:path');
const contract = require('../../electron/msfs-toolbar-panel-package');
const spb = require('./spb');
const { renderToolbarIcon } = require('./toolbar-icon');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_DIR = path.join(ROOT, 'msfs-toolbar-panel', 'package');
const DEFINITION_FILE = path.join(ROOT, 'msfs-toolbar-panel', 'panel-definition.json');
const ROOT_PACKAGE_JSON = path.join(ROOT, 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function packageVersion() {
  const version = readJson(ROOT_PACKAGE_JSON).version;
  if (!contract.isValidPackageVersion(version)) {
    throw new Error(`Root package.json version is not MAJOR.MINOR.PATCH: ${String(version)}`);
  }
  return version;
}

function panelDefinition() {
  const geometry = readJson(DEFINITION_FILE);
  return {
    filename: path.posix.basename(contract.SPB_FILE),
    panel: {
      id: contract.PANEL_ID,
      name: contract.PANEL_NAME,
      url: contract.PANEL_URL,
      resizeDirections: geometry.resizeDirections,
      minWidth: geometry.minWidth,
      minHeight: geometry.minHeight,
      defaultWidth: geometry.defaultWidth,
      defaultHeight: geometry.defaultHeight,
      defaultTop: geometry.defaultTop,
      defaultRight: geometry.defaultRight,
      icon: contract.PANEL_ICON_ID,
      buttonVisible: geometry.buttonVisible,
    },
  };
}

/**
 * The generated files, keyed by package-relative path. Metadata files are
 * produced after the payload so their sizes reflect what is on disk.
 */
function generatedPayload(version) {
  const definition = panelDefinition();
  const compiled = spb.encodeInGamePanelsDocument(definition);
  // Prove the emitted definition parses back to the same values.
  const decoded = spb.decodeInGamePanelsDocument(compiled);
  if (JSON.stringify(decoded.panel) !== JSON.stringify(definition.panel)) {
    throw new Error('Compiled panel definition did not round-trip');
  }
  return {
    [contract.SPB_FILE]: compiled,
    [contract.CONFIG_FILE]: Buffer.from(contract.renderConfigTemplate(version), 'utf8'),
    [`html_ui/icons/toolbar/${contract.PANEL_ICON_ID}.svg`]: Buffer.from(renderToolbarIcon(), 'utf8'),
    [`html_ui/Textures/Menu/toolbar/${contract.PANEL_ICON_ID}.svg`]: Buffer.from(renderToolbarIcon(), 'utf8'),
  };
}

function statPayload(dir) {
  return contract.PACKAGE_PAYLOAD_FILES.map((relativePath) => {
    const filePath = path.join(dir, ...relativePath.split('/'));
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Toolbar package payload is not a file: ${relativePath}`);
    return { path: relativePath, size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

function buildMetadata(dir, version) {
  const entries = statPayload(dir);
  const layout = contract.buildLayout(entries);
  const totalPackageSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const manifest = contract.buildManifest({ packageVersion: version, totalPackageSize });
  return { layout, manifest };
}

function writeFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

function build() {
  const version = packageVersion();
  for (const [relativePath, data] of Object.entries(generatedPayload(version))) {
    writeFile(path.join(PACKAGE_DIR, ...relativePath.split('/')), data);
  }
  const { layout, manifest } = buildMetadata(PACKAGE_DIR, version);
  writeFile(path.join(PACKAGE_DIR, contract.LAYOUT_FILE), contract.serializeLayout(layout));
  writeFile(path.join(PACKAGE_DIR, contract.MANIFEST_FILE), contract.serializeManifest(manifest));
  return { version, layout, manifest };
}

/**
 * Compare the committed package with a fresh build. layout.json dates are
 * modification times and are ignored; everything else must match.
 */
function check() {
  const version = packageVersion();
  const problems = [];
  for (const [relativePath, expected] of Object.entries(generatedPayload(version))) {
    const filePath = path.join(PACKAGE_DIR, ...relativePath.split('/'));
    if (!fs.existsSync(filePath)) {
      problems.push(`${relativePath} is missing`);
      continue;
    }
    if (!fs.readFileSync(filePath).equals(expected)) problems.push(`${relativePath} is stale`);
  }
  if (problems.length === 0) {
    const { layout, manifest } = buildMetadata(PACKAGE_DIR, version);
    const committedLayout = readJson(path.join(PACKAGE_DIR, contract.LAYOUT_FILE));
    const committedManifest = readJson(path.join(PACKAGE_DIR, contract.MANIFEST_FILE));
    const stripDates = (value) => ({
      content: (value.content || []).map((entry) => ({ path: entry.path, size: entry.size })),
    });
    if (JSON.stringify(stripDates(committedLayout)) !== JSON.stringify(stripDates(layout))) {
      problems.push('layout.json does not match the payload on disk');
    }
    if (JSON.stringify(committedManifest) !== JSON.stringify(manifest)) {
      problems.push('manifest.json does not match the payload on disk or the app version');
    }
  }
  return problems;
}

function main(argv) {
  if (argv.includes('--check')) {
    const problems = check();
    if (problems.length > 0) {
      console.error('[msfs-toolbar-panel] package is out of date:');
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('Run: npm run build:msfs-toolbar-panel');
      process.exit(1);
    }
    console.log('[msfs-toolbar-panel] package is current');
    return;
  }
  const { version, layout, manifest } = build();
  console.log(`[msfs-toolbar-panel] built ${contract.PACKAGE_DIRECTORY_NAME} ${version}: ${layout.content.length} payload files, ${Number(manifest.total_package_size)} bytes`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { PACKAGE_DIR, build, check, panelDefinition };
