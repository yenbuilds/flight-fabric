#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const safetyNotice = read('SAFETY-NOTICE.md');
const installerNotice = read('electron/installer-notice.txt');
const coreUserFacingSurfaces = [
  'SAFETY-NOTICE.md',
  'README.md',
  'RELEASE_NOTES.md',
  'electron/installer-notice.txt',
  'frontend/src/vue/components/SettingsAboutLegal.vue',
];
const privateSourceSurfaceGroups = [
  {
    directory: 'docs',
    files: [
      'docs/APP-REFERENCE.md',
      'docs/PILOT-DEBRIEF-FEATURES.md',
    ],
  },
  {
    directory: 'site',
    files: ['site/flightfabric/index.html'],
  },
];

function surfacePathsPresentInThisCheckout() {
  const paths = [...coreUserFacingSurfaces];
  for (const group of privateSourceSurfaceGroups) {
    if (!fs.existsSync(path.join(ROOT, group.directory))) continue;
    for (const relativePath of group.files) {
      assert.ok(
        fs.existsSync(path.join(ROOT, relativePath)),
        `${relativePath} is required when ${group.directory}/ is present`,
      );
      paths.push(relativePath);
    }
  }
  return paths;
}

test('authoritative safety notice defines intended use and non-reliance', () => {
  assert.match(safetyNotice, /experimental alpha software designed for use with consumer\s+flight simulators/);
  assert.match(safetyNotice, /not\s+certified, approved, or intended for real-world aviation or any other\s+safety-critical use/);
  assert.match(safetyNotice, /Do not rely on Flight Fabric or any data, analysis, score, alert, recommendation/);
  assert.match(safetyNotice, /decisions affecting the safety of\s+any person or property/);
});

test('authoritative safety notice includes the complete legal qualifiers', () => {
  assert.match(safetyNotice, /provided "as is" and "as available\."/);
  assert.match(safetyNotice, /To the maximum extent\s+permitted by applicable law/);
  assert.match(safetyNotice, /cannot lawfully be excluded, restricted, or modified/);
  assert.match(safetyNotice, /does not impose an additional restriction on the rights granted by the GNU\s+Affero General Public License/);
});

test('installer presents the safety boundary before licence and storage details', () => {
  const safetyIndex = installerNotice.indexOf('not certified, approved, or intended');
  const licenceIndex = installerNotice.search(/GNU Affero General Public\s+License/);
  const storageIndex = installerNotice.indexOf('application-data directory');
  assert.ok(safetyIndex >= 0 && safetyIndex < licenceIndex);
  assert.ok(licenceIndex < storageIndex);
});

test('all user-facing safety surfaces reject the former field-of-use wording', () => {
  for (const relativePath of surfacePathsPresentInThisCheckout()) {
    const content = read(relativePath);
    assert.doesNotMatch(
      content,
      /entertainment(?: and general educational)? (?:use|purposes) only/i,
      `${relativePath} contains the former field-of-use wording`,
    );
    assert.doesNotMatch(
      content,
      /must not be used for real-world/i,
      `${relativePath} expresses the warning as a use restriction`,
    );
  }
});

test('network-facing and distribution surfaces provide corresponding source', () => {
  const sourceUrl = 'https://github.com/yenbuilds/flight-fabric/releases';
  assert.match(installerNotice, /corresponding source code/i);
  assert.ok(installerNotice.includes(sourceUrl));

  const aboutPanel = read('frontend/src/vue/components/SettingsAboutLegal.vue');
  const appFooter = read('frontend/src/vue/components/AppFooter.vue');
  assert.match(aboutPanel, /complete corresponding source code/i);
  assert.ok(aboutPanel.includes(sourceUrl));
  assert.ok(appFooter.includes(sourceUrl));
});

test('prominent distribution surfaces include alpha, intended-use, and non-reliance warnings', () => {
  const prominentSurfaces = [
    'README.md',
    'RELEASE_NOTES.md',
    'electron/installer-notice.txt',
    'frontend/src/vue/components/SettingsAboutLegal.vue',
  ];
  if (fs.existsSync(path.join(ROOT, 'site'))) {
    prominentSurfaces.push('site/flightfabric/index.html');
  }

  for (const relativePath of prominentSurfaces) {
    const content = read(relativePath);
    assert.match(content, /experimental alpha software/i, `${relativePath} omits alpha status`);
    assert.match(content, /not certified,[\s\S]{0,80}approved,[\s\S]{0,80}(?:or )?intended for\s+real-world\s+aviation/i, `${relativePath} omits intended-use boundary`);
    assert.match(content, /Do not rely/i, `${relativePath} omits non-reliance warning`);
  }
});

console.log('\nSafety notice checks complete.');
