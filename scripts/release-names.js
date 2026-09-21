'use strict';

// The product name became one word, FlightFabric, after 0.9.9. Two kinds of
// name follow from it and they must not be confused:
//
//   - Build output names come from the Electron productName and apply to
//     whatever is built now: "FlightFabric Setup 0.9.10.exe", "FlightFabric.exe".
//   - Published asset names are frozen at publication. GitHub replaces spaces
//     with dots, and every release up to 0.9.9 was published under the old
//     name, so "Flight.Fabric.Setup.0.9.9.exe" stays that way forever.
//
// Every script that names an installer, portable build or executable goes
// through here so nobody hardcodes either form again.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REPO_URL = 'https://github.com/yenbuilds/flight-fabric';
const PRODUCT_NAME = 'FlightFabric';
const LEGACY_PRODUCT_NAME = 'Flight Fabric';
const FIRST_ONE_WORD_VERSION = '0.9.10';

function compareVersions(left, right) {
  const parse = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [a0, a1, a2] = parse(left);
  const [b0, b1, b2] = parse(right);
  if (a0 !== b0) return a0 - b0;
  if (a1 !== b1) return a1 - b1;
  return a2 - b2;
}

// The name a release of `version` was, or will be, published under.
function publishedProductName(version) {
  return compareVersions(version, FIRST_ONE_WORD_VERSION) >= 0 ? PRODUCT_NAME : LEGACY_PRODUCT_NAME;
}

function publishedInstallerAssetName(version) {
  return `${publishedProductName(version)} Setup ${version}.exe`.replace(/ /g, '.');
}

function publishedInstallerUrl(version) {
  return `${REPO_URL}/releases/download/v${version}/${publishedInstallerAssetName(version)}`;
}

// Both spellings of the local-only portable build, so release notes can be
// checked for either whatever the version.
function portableFileNames(version) {
  return [...new Set([PRODUCT_NAME, LEGACY_PRODUCT_NAME])].map((name) => `${name} ${version}.exe`);
}

// The name the Electron build actually produces, read from the build config
// rather than assumed, so a mismatch shows up as a failed check, not a
// silently wrong expectation.
function buildProductName(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
  const name = manifest?.build?.productName;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('electron/package.json build.productName is missing');
  }
  return name.trim();
}

function buildInstallerFileName(version, root = ROOT) {
  return `${buildProductName(root)} Setup ${version}.exe`;
}

function buildPortableFileName(version, root = ROOT) {
  return `${buildProductName(root)} ${version}.exe`;
}

function buildExecutableFileName(root = ROOT) {
  return `${buildProductName(root)}.exe`;
}

module.exports = {
  FIRST_ONE_WORD_VERSION,
  LEGACY_PRODUCT_NAME,
  PRODUCT_NAME,
  REPO_URL,
  buildExecutableFileName,
  buildInstallerFileName,
  buildPortableFileName,
  buildProductName,
  compareVersions,
  portableFileNames,
  publishedInstallerAssetName,
  publishedInstallerUrl,
  publishedProductName,
};
