#!/usr/bin/env node
'use strict';

// MSFS 2024 toolbar package: compiled definition, assembled package,
// desktop installer, packaging declarations and the served panel page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { page, aircraftProfile } = require('./test-msfs-toolbar-panel-runtime');

const ROOT = path.resolve(__dirname, '..', '..');
const spb = require(path.join(ROOT, 'msfs-toolbar-panel', 'tools', 'spb.js'));
const buildPackage = require(path.join(ROOT, 'msfs-toolbar-panel', 'tools', 'build-package.js'));
const contract = require(path.join(ROOT, 'electron', 'msfs-toolbar-panel-package.js'));
const installerModule = require(path.join(ROOT, 'electron', 'msfs-toolbar-panel-installer.js'));
const { STATUS, createToolbarPanelInstaller } = installerModule;

const PACKAGE_DIR = path.join(ROOT, 'msfs-toolbar-panel', 'package');
const TOOLBAR_PAGE_DIR = path.join(ROOT, 'frontend', 'toolbar');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

for (const mode of ['hidden-through-touchdown', 'hidden-before-final-result', 'opened-after-touchdown']) {
  test(`toolbar recovers latest landing and cautions: ${mode}`, () => {
    const { createSimbridgeRuntimeState, rememberReplayMessage, getReplayMessages } = require(resolveBackendRuntimeFile('core/simbridge-runtime-state.js'));
    const backend = createSimbridgeRuntimeState();
    const runtime = page(); runtime.api.boot();
    runtime.requests.find(request => request.url.startsWith('/api/toolbar/bootstrap')).succeed(); runtime.sockets[0].onopen();
    const broadcast = message => {
      rememberReplayMessage(backend, message);
      if (!runtime.sockets.at(-1).closed) runtime.api.receive(message);
    };
    broadcast(aircraftProfile());
    // Live flightTime carries startedAt, without active/flightId fields.
    broadcast({ type: 'flightTime', startedAt: '2026-09-21T01:00:00Z', elapsedHms: '01:12:34' });
    if (mode === 'hidden-before-final-result') broadcast({ type: 'landing', final: false, grade: 'GOOD' });
    runtime.api.setVisible(false); runtime.timer.advance(20001);
    assert.equal(runtime.sockets[0].closed, true);
    broadcast({ type: 'landing', final: true, vs: -650, grade: 'HARD', runwayExcursion: true });
    broadcast({ type: 'ultimateStabilityScore', score: 45, verdict: 'unstable' });
    broadcast({ type: 'flightViolation', event: 'start', label: 'Stall', severity: 'critical', timestamp_ms: 1234 });
    const target = mode === 'opened-after-touchdown' ? page() : runtime;
    if (target !== runtime) target.api.boot(); else target.api.setVisible(true);
    target.requests.findLast(request => request.url.startsWith('/api/toolbar/bootstrap')).succeed(); target.sockets.at(-1).onopen();
    const subscriptions = new Set(new URL(target.sockets.at(-1).url).searchParams.get('subscribe').split(','));
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const message of getReplayMessages(backend, subscriptions)) target.api.receive(message);
      assert.equal(target.api.state.landing?.final, true);
      assert.equal(target.api.state.landing?.grade, 'HARD');
      assert.equal(target.api.state.landing?.ultimateStability.score, 45);
      assert.equal(target.api.state.cautions.length, 1);
      const rendered = target.document.getElementById('tab-flight').text();
      for (const text of ['HARD', 'Runway excursion', '45%', 'Stall']) assert.ok(rendered.includes(text), text);
    }
  });
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('toolbar refreshes voice commands on matching capability updates, including SDK loss and recovery', () => {
  const vm = require('node:vm');
  // Run the shipped message handler; rendering is outside this protocol test.
  const source = read('frontend/toolbar/toolbar.js').replace(/\}\)\(\);\s*$/, `
    renderFlight = renderVoice = renderTabs = function () {};
    globalThis.panel = { receive: handleMessage, state: state, subscriptions: SUBSCRIPTION };
  })();`);
  const context = { window: { localStorage: null }, document: { readyState: 'loading', addEventListener() {} },
    FlightFabricToolbarTaxi: { createTaxiPanel() { return { update() {}, reset() {} }; } },
    setTimeout() {}, clearTimeout() {}, FlightFabricToolbarPresets: { createPresetPanel() { return { update() {}, reset() {} }; } } };
  vm.runInNewContext(source, context);
  const { panel } = context;
  const profile = { _profileKey: 'bundled/msfs/pmdg-737', profileRevision: 4 };
  const empty = { aircraftCommands: { commands: [] } };
  const ready = { aircraftCommands: { commands: [{ id: 'systems.apu.start', speech: { patterns: ['start apu'] } }] } };
  panel.receive({ type: 'aircraftProfile', profile, controlCapabilities: empty });
  const update = { type: 'dataSources', profileKey: profile._profileKey, profileRevision: 4, controlCapabilities: ready };
  panel.receive(update);
  assert.equal(panel.state.commands.length, 1, 'SDK becomes ready without a profile replay');
  assert.ok(panel.subscriptions.includes('dataSources'));
  for (const stale of [{ profileKey: 'another-aircraft' }, { profileRevision: 3 }, { profileRevision: undefined }]) {
    panel.receive({ ...update, ...stale, controlCapabilities: empty });
    assert.equal(panel.state.commands.length, 1, 'stale or unidentified source updates are ignored');
  }
  panel.receive({ ...update, controlCapabilities: empty });
  assert.equal(panel.state.commands.length, 0, 'SDK loss clears commands');
  panel.receive(update);
  assert.equal(panel.state.commands.length, 1, 'SDK recovery restores commands');
});

// ---------------------------------------------------------------- SPB format

test('SPB keystream and string obfuscation match the recovered format', () => {
  assert.deepEqual([...spb.keystream(10)], [42, 7, 43, 49, 50, 92, 99, 142, 191, 241]);
  assert.equal(spb.encodeString('InGamePanels').toString('hex'), '63696c505f3933efd1943ec648');
  assert.equal(spb.decodeString(Buffer.from('63696c505f3933efd1943ec648', 'hex')), 'InGamePanels');
  assert.throws(() => spb.encodeString('caf\u00e9'), /printable ASCII/);
});

test('SPB encoder round-trips the toolbar definition and preserves attribute order', () => {
  const definition = buildPackage.panelDefinition();
  const compiled = spb.encodeInGamePanelsDocument(definition);
  const decoded = spb.decodeInGamePanelsDocument(compiled);
  assert.equal(decoded.filename, definition.filename);
  assert.deepEqual(decoded.version, [1, 0]);
  assert.deepEqual(decoded.panel, definition.panel);
  assert.deepEqual(decoded.attributeOrder, spb.PANEL_ATTRIBUTE_ORDER);
  assert.equal(decoded.panel.id, contract.PANEL_ID);
  assert.equal(decoded.panel.url, contract.PANEL_URL);
  assert.equal(decoded.panel.icon, contract.PANEL_ICON_ID);

  const reordered = spb.encodeInGamePanelsDocument({
    ...definition,
    attributeOrder: ['id', 'name', 'url', 'icon', 'resizeDirections', 'minWidth', 'minHeight', 'defaultWidth', 'defaultHeight', 'defaultTop', 'defaultRight', 'buttonVisible'],
  });
  assert.notEqual(reordered.toString('hex'), compiled.toString('hex'));
  assert.deepEqual(spb.decodeInGamePanelsDocument(reordered).panel, definition.panel);
});

test('SPB decoder rejects truncated and foreign documents', () => {
  const compiled = spb.encodeInGamePanelsDocument(buildPackage.panelDefinition());
  assert.throws(() => spb.decodeInGamePanelsDocument(compiled.subarray(0, compiled.length - 3)), /overruns|truncated|terminator/);
  assert.throws(() => spb.decodeInGamePanelsDocument(Buffer.from('not an spb file')), /not an SPB/);
});

// ---------------------------------------------------------------- assembled package

test('committed toolbar package matches a fresh build for this app version', () => {
  assert.deepEqual(buildPackage.check(), []);
});

test('toolbar layout sizes survive fresh checkouts with Windows and Unix line-ending settings', (t) => {
  const root = makeTempRoot(t);
  const source = path.join(root, 'source');
  const packagePath = 'msfs-toolbar-panel/package';
  fs.mkdirSync(source);
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(source, '.gitattributes'));
  fs.cpSync(PACKAGE_DIR, path.join(source, packagePath), { recursive: true });
  fs.writeFileSync(path.join(source, 'line-endings.txt'), 'probe\n');
  const git = (...args) => execFileSync('git', args, {
    cwd: source, stdio: 'pipe', windowsHide: true,
  });
  git('init');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('-c', 'user.name=FlightFabric test', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '-m', 'Toolbar fixture');
  for (const autocrlf of ['true', 'false']) {
    const checkout = path.join(root, `checkout-${autocrlf}`);
    git('clone', '--no-hardlinks', '--config', `core.autocrlf=${autocrlf}`, source, checkout);
    assert.equal(fs.readFileSync(path.join(checkout, 'line-endings.txt'), 'utf8'),
      autocrlf === 'true' ? 'probe\r\n' : 'probe\n', 'fixture actually applies the requested checkout conversion');
    const layout = JSON.parse(fs.readFileSync(path.join(checkout, packagePath, 'layout.json'), 'utf8'));
    for (const entry of layout.content) {
      const file = path.join(checkout, packagePath, ...entry.path.split('/'));
      assert.equal(fs.statSync(file).size, entry.size, `autocrlf=${autocrlf}: ${entry.path}`);
    }
  }
});

test('assembled package carries exactly the contract payload with matching layout sizes', () => {
  const layout = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'layout.json'), 'utf8'));
  assert.deepEqual(layout.content.map((entry) => entry.path), [...contract.PACKAGE_PAYLOAD_FILES]);
  for (const entry of layout.content) {
    const stat = fs.statSync(path.join(PACKAGE_DIR, ...entry.path.split('/')));
    assert.equal(stat.size, entry.size, `${entry.path} size`);
    assert.equal(typeof entry.date, 'number');
  }
  const layoutText = fs.readFileSync(path.join(PACKAGE_DIR, 'layout.json'), 'utf8');
  assert.match(layoutText, /"date": \d{18}\n/, 'FILETIME dates are emitted as exact integers');

  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.title, 'FlightFabric Toolbar');
  assert.equal(manifest.creator, 'FlightFabric');
  assert.equal(manifest.manufacturer, 'FlightFabric');
  assert.equal(manifest.content_type, 'MISC');
  assert.equal(manifest.package_order_hint, 'CUSTOM_INSTRUMENT');
  assert.equal(manifest.package_version, APP_VERSION);
  assert.equal(manifest.total_package_size, String(layout.content.reduce((sum, entry) => sum + entry.size, 0)).padStart(20, '0'));
  assert.ok(contract.isOwnedManifest(manifest));
});

test('assembled package loader is simulator-safe and references its own files', () => {
  const html = fs.readFileSync(path.join(PACKAGE_DIR, 'html_ui', 'InGamePanels', 'FlightFabric', 'FlightFabric.html'), 'utf8');
  const js = fs.readFileSync(path.join(PACKAGE_DIR, 'html_ui', 'InGamePanels', 'FlightFabric', 'FlightFabric.js'), 'utf8');
  const config = fs.readFileSync(path.join(PACKAGE_DIR, ...contract.CONFIG_FILE.split('/')), 'utf8');
  assert.match(html, new RegExp(`panel-id="${contract.PANEL_ID}"`));
  assert.match(html, /src="FlightFabric\.config\.js"/);
  assert.match(html, /src="FlightFabric\.js"/);
  assert.match(html, /<link\s+rel="import"\s+href="\/templates\/NewPushButton\/NewPushButton\.html"\s*\/>/, 'native header actions require the icon-button component');
  assert.match(html, /\/templates\/ingameUi\/ingameUi\.html/);
  assert.match(js, /customElements\.define\("flightfabric-panel"/);
  assert.match(js, /checkAutoload\(\);/);
  assert.match(js, /"\/toolbar\/\?wsPort="/);
  assert.match(js, /event\.origin !== this\.origin/, 'loader accepts page messages only from the exact loopback origin');
  assert.match(js, /event\.source !== this\.iframe\.contentWindow/, 'loader accepts page messages only from its own iframe');
  for (const source of [html, js, config]) {
    assert.doesNotMatch(source, /[^\x09\x0a\x0d\x20-\x7e]/, 'simulator files stay ASCII');
    assert.doesNotMatch(source, /\?\.[a-zA-Z(\[]|\?\?/, 'no optional chaining or nullish coalescing for Coherent GT');
  }
  assert.ok(config.includes(contract.HTTP_PORT_PLACEHOLDER) && config.includes(contract.WS_PORT_PLACEHOLDER));
  const icon2024 = fs.readFileSync(path.join(PACKAGE_DIR, 'html_ui', 'icons', 'toolbar', `${contract.PANEL_ICON_ID}.svg`));
  const iconLegacy = fs.readFileSync(path.join(PACKAGE_DIR, 'html_ui', 'Textures', 'Menu', 'toolbar', `${contract.PANEL_ICON_ID}.svg`));
  assert.ok(icon2024.equals(iconLegacy), 'both toolbar icon lookups ship the same file');
});

test('native toolbar brand mark uses closed filled contours that tolerate forced fills', () => {
  const { renderToolbarIcon } = require('../../msfs-toolbar-panel/tools/toolbar-icon');
  const svg = renderToolbarIcon();
  assert.doesNotMatch(svg, /\b(?:stroke|transform|style|fill-rule)=|<(?:g|defs|mask|clipPath|image|use|text)\b|NaN|Infinity/);
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="#ffffff" \/>/g)];
  assert.ok(paths.length > 1, 'brand silhouette includes the orbits and flight trail');
  for (const [, data] of paths) {
    assert.match(data, /^M[\d. -]+(?:L[\d. -]+)+Z$/, 'each part is a single solid contour, without holes or open arcs');
    const coordinates = data.match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.ok(coordinates.every(value => value >= 0 && value <= 64), 'all contours remain inside the native viewBox');
    assert.equal(coordinates.length % 2, 0);
  }
});

test('toolbar HTML minimum dimensions use the compiled panel geometry units', () => {
  const html = read('msfs-toolbar-panel/package/html_ui/InGamePanels/FlightFabric/FlightFabric.html');
  const { panel } = buildPackage.panelDefinition();
  // Native ingame-ui multiplies both attributes by virtualHeight / 100.
  // Pixel-like values here briefly create an oversized frame before setup
  // replaces them with the compiled definition's dimensions.
  assert.equal(Number(/\bmin-width="([\d.]+)"/.exec(html)?.[1]), panel.minWidth);
  assert.equal(Number(/\bmin-height="([\d.]+)"/.exec(html)?.[1]), panel.minHeight);
});

test('package contract config rendering substitutes and parses ports', () => {
  const template = contract.renderConfigTemplate(APP_VERSION);
  const configured = contract.substituteConfigPorts(template, { httpPort: 8101, wsPort: 8100 });
  assert.doesNotMatch(configured, /__FF_/);
  assert.deepEqual(contract.parseConfigSource(configured), { httpPort: 8101, wsPort: 8100, packageVersion: APP_VERSION });
  assert.equal(contract.parseConfigSource(template), null);
  assert.equal(contract.parseConfigSource('window.SOMETHING_ELSE = {}'), null);
  assert.throws(() => contract.substituteConfigPorts(template, { httpPort: 80, wsPort: 8100 }), /1024 through 65535/);
  assert.throws(() => contract.substituteConfigPorts(template, { httpPort: 8100, wsPort: 8100 }), /must differ/);
  assert.throws(() => contract.substituteConfigPorts('no placeholders', { httpPort: 8101, wsPort: 8100 }), /placeholders/);
  assert.throws(() => contract.buildLayout([{ path: 'evil.exe', size: 1, mtimeMs: 0 }]), /Unexpected/);
  assert.equal(contract.toFileTime(0), '116444736000000000');
});

// ---------------------------------------------------------------- installer

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-toolbar-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeInstaller(t, overrides = {}) {
  const root = makeTempRoot(t);
  const community = path.join(root, 'Packages', 'Community');
  const community2024 = path.join(root, 'Packages', 'Community2024');
  fs.mkdirSync(community, { recursive: true });
  fs.mkdirSync(community2024, { recursive: true });
  const ports = { httpPort: 8101, wsPort: 8100 };
  const entry = {
    id: 'msfs2024-steam',
    label: 'MSFS 2024 - Steam',
    found: true,
    localCache: root,
    packagesFolder: path.join(root, 'Packages'),
    communityFolder: community,
    community2024Folder: community2024,
    preferredCommunityFolder: community2024,
    officialFolder: null,
  };
  const installer = createToolbarPanelInstaller({
    detectInstalls: () => [entry, { id: 'msfs2020-steam', label: 'MSFS 2020 - Steam', found: true, communityFolder: community }],
    resolveSourceDir: () => PACKAGE_DIR,
    getPorts: () => ports,
    packageVersion: APP_VERSION,
    ...overrides,
  });
  return { installer, community, community2024, ports, entry, target: path.join(community, contract.PACKAGE_DIRECTORY_NAME) };
}

function statusFor(installer, installId = 'msfs2024-steam') {
  const status = installer.getStatus();
  assert.equal(status.ok, true, status.error);
  return status.installs.find((install) => install.installId === installId);
}

test('installer reports not_installed, installs a configured copy, then reports installed', (t) => {
  const { installer, target, ports } = makeInstaller(t);
  const before = statusFor(installer);
  assert.equal(before.status, STATUS.NOT_INSTALLED);
  assert.equal(before.canInstall, true);
  assert.equal(installer.getStatus().installs.some((install) => install.installId === 'msfs2020-steam'), false, 'MSFS 2020 is never offered');

  const result = installer.install('msfs2024-steam');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, STATUS.INSTALLED);
  assert.equal(result.restartRequired, true);

  const config = contract.parseConfigSource(fs.readFileSync(path.join(target, ...contract.CONFIG_FILE.split('/')), 'utf8'));
  assert.deepEqual(config, { httpPort: ports.httpPort, wsPort: ports.wsPort, packageVersion: APP_VERSION });
  const layout = JSON.parse(fs.readFileSync(path.join(target, 'layout.json'), 'utf8'));
  for (const entry of layout.content) {
    assert.equal(fs.statSync(path.join(target, ...entry.path.split('/'))).size, entry.size, `installed ${entry.path} size`);
  }
  const after = statusFor(installer);
  assert.equal(after.status, STATUS.INSTALLED);
  assert.equal(after.installedVersion, APP_VERSION);
  assert.deepEqual(after.installedPorts, ports);
  assert.equal(fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith('.flightfabric-toolbar-staging-')).length, 0, 'staging directory removed');
});

test('installer refuses unsupported ids and unknown installs without touching disk', (t) => {
  const { installer, community } = makeInstaller(t);
  for (const id of ['msfs2020-steam', '../evil', '', null, 'msfs2024-other']) {
    const result = installer.install(id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported_install', String(id));
    const removal = installer.uninstall(id);
    assert.equal(removal.ok, false);
    assert.equal(removal.code, 'unsupported_install', String(id));
  }
  assert.deepEqual(fs.readdirSync(community), []);
});

test('installer classifies port changes, version changes and damaged copies', (t) => {
  const state = { ports: { httpPort: 8101, wsPort: 8100 } };
  const { installer, target } = makeInstaller(t, { getPorts: () => state.ports });
  assert.equal(installer.install('msfs2024-steam').ok, true);

  state.ports = { httpPort: 9001, wsPort: 9000 };
  assert.equal(statusFor(installer).status, STATUS.CONFIGURATION_UPDATE_REQUIRED);
  assert.equal(installer.install('msfs2024-steam').ok, true);
  assert.equal(statusFor(installer).status, STATUS.INSTALLED);

  const manifestPath = path.join(target, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, package_version: '0.0.1' }));
  assert.equal(statusFor(installer).status, STATUS.UPDATE_AVAILABLE);

  fs.unlinkSync(path.join(target, ...contract.SPB_FILE.split('/')));
  const damaged = statusFor(installer);
  assert.equal(damaged.status, STATUS.REPAIR_REQUIRED);
  assert.ok(damaged.problems.some((problem) => problem.includes(contract.SPB_FILE)));
  assert.equal(installer.install('msfs2024-steam').ok, true, 'repair reinstalls a damaged owned copy');
  assert.equal(statusFor(installer).status, STATUS.INSTALLED);
});

test('installer never replaces or removes a same-name folder it does not own', (t) => {
  const { installer, target } = makeInstaller(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ title: 'Somebody Else Toolbar', creator: 'Other' }));
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');

  const status = statusFor(installer);
  assert.equal(status.status, STATUS.FOREIGN_PACKAGE);
  assert.equal(status.canInstall, false);
  const install = installer.install('msfs2024-steam');
  assert.equal(install.ok, false);
  assert.equal(install.code, 'foreign_package');
  const uninstall = installer.uninstall('msfs2024-steam');
  assert.equal(uninstall.ok, false);
  assert.equal(uninstall.code, 'foreign_package');
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
});

test('installer refuses a linked target directory', (t) => {
  const { installer, target, community } = makeInstaller(t);
  const elsewhere = path.join(community, '..', 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'manifest.json'), JSON.stringify({ title: 'FlightFabric Toolbar', creator: 'FlightFabric' }));
  try {
    fs.symlinkSync(elsewhere, target, 'junction');
  } catch {
    t.skip('directory links are not available on this machine');
    return;
  }
  assert.equal(statusFor(installer).status, STATUS.FOREIGN_PACKAGE);
  const install = installer.install('msfs2024-steam');
  assert.equal(install.ok, false);
  assert.equal(install.code, 'foreign_package');
  const uninstall = installer.uninstall('msfs2024-steam');
  assert.equal(uninstall.ok, false);
  assert.ok(fs.existsSync(path.join(elsewhere, 'manifest.json')), 'link target untouched');
});

test('uninstall preserves a same-name folder with a missing or invalid manifest', (t) => {
  const { installer, target } = makeInstaller(t);
  fs.mkdirSync(target);
  const preserved = path.join(target, 'keep.txt');
  fs.writeFileSync(preserved, 'unrelated files');
  for (const manifest of [null, '{invalid json']) {
    if (manifest !== null) fs.writeFileSync(path.join(target, 'manifest.json'), manifest);
    const result = installer.uninstall('msfs2024-steam');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'foreign_package');
    assert.equal(fs.readFileSync(preserved, 'utf8'), 'unrelated files');
  }
});

test('uninstall refuses a junction nested in an owned package without touching the other add-on', (t) => {
  const { installer, target, community } = makeInstaller(t);
  assert.equal(installer.install('msfs2024-steam').ok, true);
  const otherAddon = path.join(community, 'another-addon');
  fs.mkdirSync(otherAddon);
  fs.writeFileSync(path.join(otherAddon, 'keep.txt'), 'other add-on');
  fs.symlinkSync(otherAddon, path.join(target, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');

  const result = installer.uninstall('msfs2024-steam');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsafe_package');
  assert.equal(fs.readFileSync(path.join(otherAddon, 'keep.txt'), 'utf8'), 'other add-on');
  assert.ok(fs.existsSync(path.join(target, 'manifest.json')), 'refuses the package before deleting its files');
});

test('uninstall refuses a redirected Community root even when its target has an owned manifest', (t) => {
  const { installer, target, community, entry } = makeInstaller(t);
  assert.equal(installer.install('msfs2024-steam').ok, true);
  const redirected = path.join(path.dirname(community), 'LinkedCommunity');
  fs.symlinkSync(community, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  entry.communityFolder = redirected;

  const result = installer.uninstall('msfs2024-steam');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsafe_directory');
  assert.ok(fs.existsSync(path.join(target, 'manifest.json')), 'the redirected package remains untouched');
});

test('installer restores the previous copy when the commit rename fails', (t) => {
  let renames = 0;
  let failAt = -1;
  const { installer, target } = makeInstaller(t, {
    rename: (from, to) => {
      renames += 1;
      if (renames === failAt) throw new Error('simulated rename failure');
      fs.renameSync(from, to);
    },
  });
  assert.equal(installer.install('msfs2024-steam').ok, true);
  const marker = path.join(target, 'html_ui', 'marker.txt');
  fs.writeFileSync(marker, 'previous copy');

  // Second install: rename #1 moves the old copy aside, rename #2 commits.
  failAt = renames + 2;
  const result = installer.install('msfs2024-steam');
  assert.equal(result.ok, false);
  assert.match(result.error, /simulated rename failure/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'previous copy', 'previous copy restored in place');
  assert.equal(fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith('.flightfabric-toolbar-staging-')).length, 0, 'staging cleaned up after rollback');
  assert.equal(statusFor(installer).status, STATUS.INSTALLED, 'the restored copy is the previously verified package');
});

test('installer cleans up an owned stray copy in Community2024 and uninstall removes both', (t) => {
  const { installer, community, community2024, target } = makeInstaller(t);
  const stray = path.join(community2024, contract.PACKAGE_DIRECTORY_NAME);
  const preserved = [];
  for (const folder of [community, community2024]) {
    const sibling = path.join(folder, 'another-addon');
    fs.mkdirSync(sibling);
    for (const file of [path.join(sibling, 'keep.txt'), path.join(folder, 'keep.txt')]) {
      fs.writeFileSync(file, 'unrelated content');
      preserved.push(file);
    }
  }
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'manifest.json'), JSON.stringify({ title: 'FlightFabric Toolbar', creator: 'FlightFabric', package_version: '0.1.0' }));
  assert.equal(statusFor(installer).status, STATUS.NOT_INSTALLED);
  assert.equal(statusFor(installer).strayCopies.length, 1);

  assert.equal(installer.install('msfs2024-steam').ok, true);
  assert.equal(fs.existsSync(stray), false, 'stray copy removed after commit');
  assert.equal(statusFor(installer).status, STATUS.INSTALLED);

  fs.mkdirSync(stray);
  fs.writeFileSync(path.join(stray, 'manifest.json'), JSON.stringify(contract.PACKAGE_IDENTITY));
  const uninstall = installer.uninstall('msfs2024-steam');
  assert.equal(uninstall.ok, true);
  assert.equal(uninstall.removed, true);
  assert.equal(uninstall.restartRequired, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(stray), false);
  for (const file of preserved) assert.equal(fs.readFileSync(file, 'utf8'), 'unrelated content', file);
  const again = installer.uninstall('msfs2024-steam');
  assert.equal(again.removed, false);
  assert.equal(again.restartRequired, false);
});

test('installer reports incomplete cleanup instead of success and can retry without losing the installed copy', (t) => {
  const { installer, community2024, target } = makeInstaller(t);
  const stray = path.join(community2024, contract.PACKAGE_DIRECTORY_NAME);
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'manifest.json'), JSON.stringify({ title: 'FlightFabric Toolbar', creator: 'FlightFabric', package_version: '0.1.0' }));
  const remove = fs.unlinkSync;
  const blocked = t.mock.method(fs, 'unlinkSync', (candidate) => {
    if (path.resolve(candidate) === path.join(stray, 'manifest.json')) throw Object.assign(new Error('fixture: old toolbar files are locked'), { code: 'EBUSY' });
    return remove(candidate);
  });
  const result = installer.install('msfs2024-steam');
  assert.equal(result.ok, false, 'partial cleanup is not a completed installation');
  assert.equal(result.code, 'cleanup_incomplete');
  assert.match(result.error, /installed.*cleanup/i);
  assert.match(result.error, /Close MSFS and retry/);
  assert.equal(result.installedPath, target);
  assert.equal(result.restartRequired, true);
  assert.equal(fs.existsSync(path.join(target, 'manifest.json')), true, 'the committed current copy stays in place');
  assert.equal(fs.existsSync(stray), true, 'the failed removal leaves the old copy available');
  assert.equal(statusFor(installer).status, STATUS.UPDATE_AVAILABLE);
  blocked.mock.restore();
  assert.equal(installer.install('msfs2024-steam').ok, true);
  assert.equal(fs.existsSync(stray), false);
  assert.equal(statusFor(installer).status, STATUS.INSTALLED);
});

test('installer reports leftover staging data after a committed install', (t) => {
  const { installer, community, target } = makeInstaller(t);
  const remove = fs.rmdirSync;
  t.mock.method(fs, 'rmdirSync', (candidate, options) => {
    if (path.dirname(path.resolve(candidate)) === community && path.basename(candidate).startsWith('.flightfabric-toolbar-staging-')) {
      throw Object.assign(new Error('fixture: staging cleanup is locked'), { code: 'EBUSY' });
    }
    return remove(candidate, options);
  });
  const result = installer.install('msfs2024-steam');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cleanup_incomplete');
  assert.equal(result.installedPath, target);
  assert.equal(fs.existsSync(path.join(target, 'manifest.json')), true);
  const remaining = fs.readdirSync(community).find((name) => name.startsWith('.flightfabric-toolbar-staging-'));
  assert.ok(remaining);
  assert.ok(result.error.includes(path.join(community, remaining)), 'identify the exact leftover temporary folder');
  assert.match(result.error, /Close MSFS before removing that temporary folder/);
  assert.doesNotMatch(result.error, /retry the installation/, 'a new install cannot remove an earlier staging directory');
});

test('installer surfaces a missing bundled source without throwing', (t) => {
  const { installer } = makeInstaller(t, { resolveSourceDir: () => path.join(os.tmpdir(), 'ff-missing-toolbar-source') });
  const status = installer.getStatus();
  assert.equal(status.ok, false);
  assert.match(status.error, /source/i);
  const install = installer.install('msfs2024-steam');
  assert.equal(install.ok, false);
  assert.equal(install.code, 'missing_directory');
});

// ---------------------------------------------------------------- packaging and bridge

test('Electron packaging and bridge declare the toolbar installer', () => {
  const electronPkg = JSON.parse(read('electron/package.json'));
  for (const file of ['msfs-toolbar-panel-installer.js', 'msfs-toolbar-panel-package.js', 'safe-directory-removal.js', 'msfs-detect.js']) {
    assert.ok(electronPkg.build.files.includes(file), `${file} packaged`);
  }
  const resource = electronPkg.build.extraResources.find((entry) => entry && entry.to === 'msfs-toolbar-panel');
  assert.ok(resource, 'toolbar package is an extraResources entry');
  assert.equal(resource.from, '../msfs-toolbar-panel/package');

  const preload = read('electron/preload.js');
  assert.match(preload, /toolbarPanel: Object\.freeze\(\{/);
  assert.match(preload, /requireInstallId\(installId\)/);
  const main = read('electron/main.js');
  for (const channel of ['toolbar-panel-status', 'toolbar-panel-install', 'toolbar-panel-uninstall']) {
    assert.match(main, new RegExp(`registerTrustedIpcHandler\\('${channel}'`));
  }
  assert.match(main, /path\.join\(process\.resourcesPath, 'msfs-toolbar-panel'\)/);
});

// ---------------------------------------------------------------- served page

test('toolbar page subscribes only to subscribable low-rate message types', () => {
  const { SUBSCRIBABLE_MESSAGE_TYPES } = require(resolveBackendRuntimeFile('core', 'ws-bootstrap.js'));
  const pageSource = fs.readFileSync(path.join(TOOLBAR_PAGE_DIR, 'toolbar.js'), 'utf8');
  const match = /var SUBSCRIPTION = \[([\s\S]*?)\];/.exec(pageSource);
  assert.ok(match, 'toolbar.js declares its subscription list');
  const types = [...match[1].matchAll(/'([a-zA-Z]+)'/g)].map((entry) => entry[1]);
  assert.ok(types.length >= 8);
  for (const type of types) {
    assert.ok(SUBSCRIBABLE_MESSAGE_TYPES.includes(type), `${type} is subscribable`);
  }
  for (const streamed of ['ias', 'vs', 'altitude', 'attitude', 'position', 'aircraftSpecificState']) {
    assert.ok(!types.includes(streamed), `${streamed} is never subscribed`);
    assert.ok(!SUBSCRIBABLE_MESSAGE_TYPES.includes(streamed), `${streamed} is not subscribable`);
  }
});

test('toolbar page files are Coherent-safe and complete', () => {
  for (const name of ['index.html', 'toolbar.js', 'presets.js', 'taxi.js', 'toolbar.css', 'voice-reference.json', 'ping.svg']) {
    assert.ok(fs.existsSync(path.join(TOOLBAR_PAGE_DIR, name)), `${name} exists`);
  }
  const js = fs.readFileSync(path.join(TOOLBAR_PAGE_DIR, 'toolbar.js'), 'utf8');
  assert.doesNotMatch(js, /\?\.[a-zA-Z(\[]|\?\?|\.flat\(|Object\.fromEntries|\.matchAll\(|\.replaceAll\(/, 'ES2017 only');
  assert.equal(js.includes('.innerHTML'), false, 'renders with textContent only');
  assert.match(js, /new WebSocket\(url\)/);
  assert.match(js, /\/api\/toolbar\/bootstrap/);
  assert.doesNotMatch(js, /\/api\/bootstrap['"?]/, 'the panel never requests the privileged session bootstrap');
  assert.doesNotMatch(js, /token=/, 'the panel never sends a desktop session token');
  const html = fs.readFileSync(path.join(TOOLBAR_PAGE_DIR, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script>[^<]/, 'no inline scripts under the strict CSP');
  assert.doesNotMatch(html, / on[a-z]+="/, 'no inline event handlers');
  const buildSource = read('frontend/build.js');
  assert.match(buildSource, /'toolbar',/, 'frontend build copies the toolbar page');
  assert.match(buildSource, /assertBundledToolbarPage\(\)/);
});

test('generated voice reference is current with the desktop voice modules', async () => {
  const generator = await import(pathToFileURL(path.join(ROOT, 'scripts', 'build-toolbar-voice-reference.mjs')).href);
  const expected = generator.serializeVoiceReference(generator.buildVoiceReference());
  const current = fs.readFileSync(path.join(TOOLBAR_PAGE_DIR, 'voice-reference.json'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(current, expected, 'run node scripts/build-toolbar-voice-reference.mjs');
  const parsed = JSON.parse(current);
  assert.ok(parsed.flightPlanQueries.length >= 3);
  assert.ok(Object.keys(parsed.aircraftQueries).length >= 5);
});

// ---------------------------------------------------------------- relays

test('flight plan relay bounds every field and keeps nested groups', () => {
  const { sanitizeFlightPlanFields } = require(resolveBackendRuntimeFile('core', 'flight-plan-relay.js'));
  const sanitized = sanitizeFlightPlanFields({
    origin: 'yssy', destination: 'ymml!', alternate: 'YS', departureRunway: '34l', arrivalRunway: 'rwy 16',
    route: 'X'.repeat(5000), weightUnit: 'stone', costIndex: '42', eteSeconds: 'soon',
    procedures: { sid: 'deenA1', sidTransition: null, star: 'bad-ident' },
    fuel: { trip: '1234.5', taxi: null, bogus: 1 },
    weights: { passengers: 150 },
    weather: { originMetar: 'YSSY 010000Z', originTaf: 42 },
    navlog: [{ ident: 'DEENA', altitude: '5000', windDirection: 250 }, { altitude: 1 }, 'junk'],
    username: 'pilot', extra: 'ignored',
  });
  assert.equal(sanitized.origin, 'YSSY');
  assert.equal(sanitized.destination, 'YMML');
  assert.equal(sanitized.alternate, null);
  assert.equal(sanitized.departureRunway, '34L');
  assert.equal(sanitized.arrivalRunway, null);
  assert.equal(sanitized.route.length, 2000);
  assert.equal(sanitized.weightUnit, null);
  assert.equal(sanitized.costIndex, 42);
  assert.equal(sanitized.eteSeconds, null);
  assert.deepEqual(sanitized.procedures, { sid: 'DEENA1', sidTransition: null, star: null });
  assert.deepEqual(sanitized.fuel, { trip: 1234.5, taxi: null });
  assert.deepEqual(sanitized.weights, { passengers: 150 });
  assert.deepEqual(sanitized.weather, { originMetar: 'YSSY 010000Z', originTaf: null });
  assert.deepEqual(sanitized.navlog, [{ ident: 'DEENA', altitude: 5000, windDirection: 250 }]);
  assert.equal('username' in sanitized, false);
  assert.equal('extra' in sanitized, false);
});

test('voice status relay is bounded and projected for unpaired clients', () => {
  const { sanitizeVoiceStatusFields } = require(resolveBackendRuntimeFile('core', 'voice-status-relay.js'));
  const { projectServerMessageForClient } = require(resolveBackendRuntimeFile('core', 'server-message-projection.js'));
  assert.equal(sanitizeVoiceStatusFields({}), null);
  const fields = sanitizeVoiceStatusFields({
    status: 'listening', statusText: 'Listening\u0000\u2026', transcript: 'x'.repeat(1000), lastCommand: 'set heading 270',
    shortcut: 'Ctrl+Shift+Space', joystick: 'T.16000M button 5', enabled: 'yes', available: true, profileKey: 'bundled/msfs/pmdg-737',
  });
  assert.equal(fields.status, 'listening');
  assert.equal(fields.statusText, 'Listening \u2026');
  assert.equal(fields.transcript.length, 400);
  assert.equal(fields.enabled, false);
  assert.equal(fields.available, true);
  assert.equal(sanitizeVoiceStatusFields({ status: 'made-up' }).status, 'unknown');

  const projected = projectServerMessageForClient({ __ffPrivilegedClient: false }, {
    type: 'voiceStatus', updatedAt: 123, status: 'sent', statusText: 'Sent heading 270.', transcript: 'set heading 270',
    lastCommand: 'set heading 270', shortcut: 'Ctrl+Shift+Space', joystick: '', enabled: true, available: true, profileKey: 'bundled/msfs/pmdg-737',
    secretPath: 'C:\\Users\\pilot\\private.txt',
  });
  assert.equal(projected.type, 'voiceStatus');
  assert.equal(projected.updatedAt, 123);
  assert.equal(projected.status, 'sent');
  assert.equal('secretPath' in projected, false);
});


test('toolbar bundles match the shared app rules and DOM views', async () => {
  const { buildToolbarPresets, buildToolbarTaxi } = await import(pathToFileURL(path.join(ROOT, 'scripts/build-toolbar-presets.mjs')).href);
  assert.equal(read('frontend/toolbar/presets.js').replace(/\r\n/g, '\n'), await buildToolbarPresets());
  const taxi = read('frontend/toolbar/taxi.js').replace(/\r\n/g, '\n');
  assert.equal(taxi, await buildToolbarTaxi());
  assert.doesNotMatch(taxi, /\.at\(|\.flatMap\(|\.flat\(|Object\.fromEntries|\.replaceAll\(/, 'Coherent runtime has no modern array polyfills');
});
