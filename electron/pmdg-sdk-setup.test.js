'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createPmdgSdkSetup, parseBroadcastSettings } = require('./pmdg-sdk-setup');

const SCRATCH = path.resolve(__dirname, '../.tmp/pmdg-sdk-setup');
function fixture(t, chooseOptionsFile) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, 'test-'));
  t.after(() => {
    assert.equal(path.dirname(root), SCRATCH);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local') };
  const revealed = [];
  const service = createPmdgSdkSetup({ env, platform: 'win32', showItemInFolder: file => revealed.push(file), chooseOptionsFile });
  function write(relative, text = '[SDK]\nEnableDataBroadcast=1\n') {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }
  return { root, env, revealed, service, write };
}
const STEAM = 'Roaming/Microsoft Flight Simulator 2024/WASM/MSFS2024/pmdg-aircraft-738/work/737_Options.ini';

test('INI parsing distinguishes absent, disabled, enabled and ambiguous SDK settings', () => {
  assert.deepEqual(parseBroadcastSettings('\uFEFF[ sdk ]\r\n EnableDataBroadcast = 1\r\nEnableCDUBroadcast.0=0\r\n'), {
    section: 'present', data: 'enabled', cduLeft: 'disabled', cduRight: 'missing',
  });
  for (const text of ['', ';[SDK]\n;EnableDataBroadcast=1', '[Other]\nEnableDataBroadcast=1', '[SDK]\n#EnableDataBroadcast=1']) {
    assert.equal(parseBroadcastSettings(text).data, 'missing');
  }
  for (const text of ['[SDK]\nEnableDataBroadcast=1\nEnableDataBroadcast=0', '[SDK]\nEnableDataBroadcast=1\n[SDK]',
    '[SDK]\nEnableDataBroadcast=true', '[SDK]\nEnableDataBroadcast=1 ;comment', '[SDK]\nEnableDataBroadcast=1\n[broken']) {
    assert.equal(parseBroadcastSettings(text).data, 'unknown', text);
  }
  assert.equal(parseBroadcastSettings('[SDK]\nEnableDataBroadcast=0').data, 'disabled');
  assert.equal(parseBroadcastSettings('[General]\nValue=1').section, 'missing');
  assert.equal(parseBroadcastSettings('[SDK]\nEnableDataBroadcast=0').section, 'present');
  assert.equal(parseBroadcastSettings('[SDK]\n[SDK]').section, 'unknown');
});

test('finds Steam/Store 2020/2024 work files, legacy names, compatibility layout and both families', async t => {
  const h = fixture(t);
  const paths = [
    STEAM,
    'Roaming/Microsoft Flight Simulator/packages/pmdg-aircraft-737/work/737NG3_Options.ini',
    'Local/Packages/Microsoft.FlightSimulator_8wekyb3d8bbwe/LocalState/packages/pmdg-aircraft-736/work/737_Options.ini',
    'Local/Packages/Microsoft.Limitless_8wekyb3d8bbwe/LocalState/WASM/MSFS2024/pmdg-aircraft-739/work/737_Options.ini',
    'Roaming/Microsoft Flight Simulator 2024/WASM/MSFS2020/pmdg-aircraft-737/work/737_Options.ini',
  ].map(file => h.write(file));
  const triple = h.write('Roaming/Microsoft Flight Simulator 2024/WASM/MSFS2024/pmdg-aircraft-77w/work/777_Options.ini');
  h.write('Roaming/Microsoft Flight Simulator 2024/WASM/MSFS2024/pmdg-aircraft-738/work/other.ini');
  const found = await h.service.getStatus('pmdg-737');
  assert.deepEqual(found.files.map(file => file.path).sort(), paths.sort());
  assert(found.files.every(file => file.canReveal && file.settings.data === 'enabled'));
  assert.deepEqual((await h.service.getStatus('pmdg-777')).files.map(file => file.path), [triple]);
  assert.equal(h.revealed.length, 0, 'detection never opens Explorer');
  for (const file of paths) assert.equal(fs.readFileSync(file, 'utf8'), '[SDK]\nEnableDataBroadcast=1\n');
});

test('supports UTF-8 BOM and UTF-16 BOM options and rejects oversized or binary files', async t => {
  const h = fixture(t);
  const text = '[SDK]\r\nEnableDataBroadcast=1\r\n';
  const file = h.write(STEAM);
  for (const bytes of [Buffer.from('\uFEFF' + text), Buffer.from('\uFEFF' + text, 'utf16le'), Buffer.from('\uFEFF' + text, 'utf16le').swap16()]) {
    fs.writeFileSync(file, bytes);
    assert.equal((await h.service.getStatus('pmdg-737')).files[0].settings.data, 'enabled');
  }
  for (const bytes of [Buffer.alloc(65537, 65), Buffer.from('[SDK]\nEnableDataBroadcast=1\0')]) {
    fs.writeFileSync(file, bytes);
    const entry = (await h.service.getStatus('pmdg-737')).files[0];
    assert.equal(entry.settings.data, 'unknown');
    assert.equal(entry.canReveal, false);
  }
});

test('active profiles narrow discovery without confusing other aircraft or coalescing different variants', async t => {
  const h = fixture(t);
  const eight = h.write(STEAM);
  const six = h.write(STEAM.replace('pmdg-aircraft-738', 'pmdg-aircraft-736'), '[SDK]\nEnableDataBroadcast=0\n');
  const [a, b, c] = await Promise.all([
    h.service.getStatus('pmdg-737', 'pmdg-737'),
    h.service.getStatus('pmdg-737', 'pmdg-737-600'),
    h.service.getStatus('pmdg-737', 'pmdg-737-700'),
  ]);
  assert.deepEqual(a.files.map(file => file.path), [eight]);
  assert.deepEqual(b.files.map(file => file.path), [six]);
  assert.equal(b.files[0].settings.data, 'disabled');
  assert.deepEqual(c.files, []);
  assert.equal((await h.service.getStatus('pmdg-737', 'custom-profile')).files.length, 2, 'unknown profiles retain family choices');
  await assert.rejects(h.service.getStatus('pmdg-737', {}));
  await assert.rejects(h.service.getStatus('pmdg-737', 'x'.repeat(65)));
});

test('truncated UTF-16 options never report enabled settings', async t => {
  const h = fixture(t);
  const content = Buffer.from('\uFEFF[SDK]\r\nEnableDataBroadcast=1\r\n', 'utf16le');
  for (const bytes of [content, Buffer.from(content).swap16()]) {
    h.write(STEAM, Buffer.concat([bytes, Buffer.from([0x31])]));
    const [entry] = (await h.service.getStatus('pmdg-737')).files;
    assert.equal(entry.settings.data, 'unknown');
    assert.equal(entry.canReveal, false);
  }
});

test('fresh checks see edits, absent files stay unknown and invalid IDs never reach Explorer', async t => {
  const h = fixture(t);
  assert.deepEqual((await h.service.getStatus('pmdg-737')).files, []);
  const file = h.write(STEAM, '[SDK]\nEnableDataBroadcast=0\n');
  const entry = (await h.service.getStatus('pmdg-737')).files[0];
  assert.equal(entry.settings.data, 'disabled');
  assert.equal((await h.service.revealFile('pmdg-737', entry.id)).success, true);
  assert.deepEqual(h.revealed, [file]);
  fs.writeFileSync(file, '[SDK]\nEnableDataBroadcast=1\n');
  assert.equal((await h.service.getStatus('pmdg-737')).files[0].settings.data, 'enabled');
  for (const id of [file, '..\\secret.ini', '\\\\server\\share', 'C:\\Windows\\system.ini', entry.id + ':stream', {}, null, 'x'.repeat(121)]) {
    assert.equal((await h.service.revealFile('pmdg-737', id)).success, false);
  }
  assert.equal((await h.service.revealFile('pmdg-777', entry.id)).success, false);
  fs.unlinkSync(file);
  assert.equal((await h.service.revealFile('pmdg-737', entry.id)).success, false);
  assert.equal(h.revealed.length, 1);
  for (const family of ['__proto__', 'constructor', '../../', '', null, {}]) await assert.rejects(h.service.getStatus(family));
});

test('refuses hardlinks and junctions, including a directory replaced after detection', async t => {
  const h = fixture(t);
  const file = h.write(STEAM);
  const entry = (await h.service.getStatus('pmdg-737')).files[0];
  const target = h.write('elsewhere/737_Options.ini');
  fs.unlinkSync(file);
  fs.linkSync(target, file);
  assert.equal((await h.service.getStatus('pmdg-737')).files[0].canReveal, false);
  assert.equal((await h.service.revealFile('pmdg-737', entry.id)).success, false);
  fs.unlinkSync(file);
  fs.rmdirSync(path.dirname(file));
  fs.symlinkSync(path.dirname(target), path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.service.getStatus('pmdg-737')).files[0].canReveal, false);
  assert.equal((await h.service.revealFile('pmdg-737', entry.id)).success, false);
  assert.deepEqual(h.revealed, []);
});

test('unsupported platforms and network/device roots do not expose files', async () => {
  assert.deepEqual(await createPmdgSdkSetup({ platform: 'linux' }).getStatus('pmdg-737'), { supported: false, files: [] });
  for (const APPDATA of ['\\\\server\\share', '\\\\?\\C:\\data', 'relative', 'C:\\data:stream']) {
    const service = createPmdgSdkSetup({ platform: 'win32', env: { APPDATA } });
    assert.deepEqual((await service.getStatus('pmdg-737')).files, []);
  }
});

test('native selections are checked, remembered per variant, refreshed and scoped to this session', async t => {
  let picked = { canceled: true };
  const h = fixture(t, async () => picked);
  const file = h.write(STEAM);
  assert.deepEqual(await h.service.chooseFile('pmdg-737'), { canceled: true });
  picked = { canceled: false, filePaths: [file] };
  const first = await h.service.chooseFile('pmdg-737', 'pmdg-737');
  assert.equal(first.success, true);
  assert.match(first.file.id, /^selected:[0-9a-f-]+$/);
  assert.equal(first.file.settings.data, 'enabled');
  assert.deepEqual(h.revealed, [], 'selecting a file does not open Explorer');
  assert.deepEqual((await h.service.getStatus('pmdg-737', 'pmdg-737')).files.map(item => item.id), [first.file.id], 'do not duplicate an automatic match');
  assert.equal((await h.service.revealFile('pmdg-777', first.file.id)).success, false);
  assert.equal((await h.service.getStatus('pmdg-737', 'pmdg-737-600')).files.length, 0);
  fs.writeFileSync(file, '[SDK]\nEnableDataBroadcast=0\n');
  assert.equal((await h.service.getStatus('pmdg-737')).files[0].settings.data, 'disabled');
  const other = h.write('OtherDrive/pmdg-aircraft-738/work/737_Options.ini');
  picked = { canceled: false, filePaths: [other] };
  const second = await h.service.chooseFile('pmdg-737', 'pmdg-737');
  assert.equal(second.success, true);
  assert.equal((await h.service.revealFile('pmdg-737', first.file.id)).success, false, 'replacing a selection revokes its opaque ID');
  picked = { canceled: true };
  await h.service.chooseFile('pmdg-737');
  assert.equal((await h.service.revealFile('pmdg-737', second.file.id)).success, true, 'cancel keeps the last selection');
  assert.deepEqual(h.revealed, [other]);
  assert.equal((await createPmdgSdkSetup({ env: h.env, platform: 'win32' }).revealFile('pmdg-737', second.file.id)).success, false, 'a new session has no grant');
});

test('an explicitly picked Store redirect pins its canonical file without weakening automatic discovery', async t => {
  let picked;
  const h = fixture(t, async () => ({ canceled: false, filePaths: [picked] }));
  const packageRoot = 'Local/Packages/Microsoft.Limitless_8wekyb3d8bbwe';
  const suffix = 'WASM/MSFS2024/pmdg-aircraft-77w/work/777_Options.ini';
  const state = 'OtherDrive/WpSystem/S-1-5-21-1-2-3-1001/AppData/Local/Packages/Microsoft.Limitless_8wekyb3d8bbwe/LocalState';
  const canonical = h.write(`${state}/${suffix}`);
  const marker = h.write(`${packageRoot}/marker.txt`, '');
  const junction = path.join(path.dirname(marker), 'LocalState');
  fs.symlinkSync(path.join(h.root, state), junction, process.platform === 'win32' ? 'junction' : 'dir');
  picked = path.join(junction, suffix);
  assert((await h.service.getStatus('pmdg-777')).files.every(item => !item.canReveal));
  const selection = await h.service.chooseFile('pmdg-777', 'pmdg-777');
  assert.equal(selection.success, true);
  assert.equal(selection.file.path, canonical);
  fs.unlinkSync(junction);
  const changed = h.write(`Changed/${suffix}`);
  fs.symlinkSync(path.join(h.root, 'Changed'), junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.service.revealFile('pmdg-777', selection.file.id)).success, true);
  assert.deepEqual(h.revealed, [canonical], 'later redirection cannot retarget the selected grant');
  fs.unlinkSync(canonical);
  fs.rmdirSync(path.dirname(canonical));
  fs.symlinkSync(path.dirname(changed), path.dirname(canonical), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.service.revealFile('pmdg-777', selection.file.id)).success, false, 'canonical path is revalidated before reveal');
  assert.equal(h.revealed.length, 1);
});

test('picker rejects wrong aircraft, arbitrary files, nonlocal paths, oversized data and hardlinks', async t => {
  let picked;
  const h = fixture(t, async () => ({ canceled: false, filePaths: [picked] }));
  const wrongFiles = [
    h.write('OtherDrive/pmdg-aircraft-736/work/737_Options.ini'),
    h.write('OtherDrive/pmdg-aircraft-77w/work/777_Options.ini'),
    h.write('OtherDrive/pmdg-aircraft-738/work/other.ini'),
    h.write('OtherDrive/737_Options.ini'),
    '\\\\server\\share\\pmdg-aircraft-738\\work\\737_Options.ini',
    'C:\\data:stream\\pmdg-aircraft-738\\work\\737_Options.ini',
  ];
  for (picked of wrongFiles) assert.equal((await h.service.chooseFile('pmdg-737', 'pmdg-737')).success, false);
  picked = h.write('OtherDrive/pmdg-aircraft-738/work/737_Options.ini', Buffer.alloc(65537, 65));
  assert.equal((await h.service.chooseFile('pmdg-737')).success, false);
  fs.writeFileSync(picked, '[SDK]\nEnableDataBroadcast=1\0');
  assert.equal((await h.service.chooseFile('pmdg-737')).success, false);
  fs.unlinkSync(picked);
  const target = h.write('Elsewhere/737_Options.ini');
  fs.linkSync(target, picked);
  assert.equal((await h.service.chooseFile('pmdg-737')).success, false);
  assert.deepEqual((await h.service.getStatus('pmdg-737')).files, []);
  assert.deepEqual(h.revealed, []);
});

test('only one native picker can run, and invalid inputs never reach it', async t => {
  let resolvePick, calls = 0;
  const h = fixture(t, () => { calls++; return new Promise(resolve => { resolvePick = resolve; }); });
  await assert.rejects(h.service.chooseFile('../', ''));
  await assert.rejects(h.service.chooseFile('pmdg-737', {}));
  assert.equal(calls, 0);
  const pending = h.service.chooseFile('pmdg-737');
  assert.equal((await h.service.chooseFile('pmdg-777')).success, false);
  assert.equal(calls, 1);
  resolvePick({ canceled: true });
  assert.deepEqual(await pending, { canceled: true });
});

test('picker bounds redirect loops and rejects network redirect targets before probing them', async t => {
  let picked;
  const h = fixture(t, async () => ({ canceled: false, filePaths: [picked] }));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const first = path.join(h.root, 'loop-a'), second = path.join(h.root, 'loop-b');
  fs.symlinkSync(second, first, linkType);
  fs.symlinkSync(first, second, linkType);
  picked = path.join(first, 'pmdg-aircraft-738/work/737_Options.ini');
  assert.equal((await h.service.chooseFile('pmdg-737')).success, false, 'cycles finish without following indefinitely');

  const asyncFs = require('node:fs/promises');
  // Simulate a network redirect without creating or touching a network share.
  const lstat = asyncFs.lstat.bind(asyncFs);
  const probed = [];
  t.mock.method(asyncFs, 'lstat', async value => { probed.push(value); return lstat(value); });
  const readlink = t.mock.method(asyncFs, 'readlink', async () => '\\\\untrusted.invalid\\share');
  assert.equal((await h.service.chooseFile('pmdg-737')).success, false);
  assert.equal(readlink.mock.callCount(), 1);
  assert(probed.every(value => !value.startsWith('\\\\')), 'UNC target is never passed to filesystem inspection');
  assert.deepEqual(h.revealed, []);
});

test('preload exposes only bounded IDs and production handlers use the trusted sender gate', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { api = value; } }, ipcRenderer: { invoke: (...args) => calls.push(args) } }),
    process: { env: {}, platform: 'win32' }, console: { log() {} },
  });
  api.pmdgSdk.getStatus('pmdg-737', 'pmdg-737-600');
  api.pmdgSdk.revealFile('pmdg-777', 'detected-id');
  api.pmdgSdk.chooseFile('pmdg-777', 'pmdg-777');
  assert.deepEqual(calls, [['pmdg-sdk-status', 'pmdg-737', 'pmdg-737-600'], ['pmdg-sdk-reveal', 'pmdg-777', 'detected-id'], ['pmdg-sdk-choose', 'pmdg-777', 'pmdg-777']]);
  assert.throws(() => api.pmdgSdk.getStatus('pmdg-737', {}));
  assert.throws(() => api.pmdgSdk.getStatus('../'));
  assert.throws(() => api.pmdgSdk.revealFile('pmdg-737', {}));
  assert.throws(() => api.pmdgSdk.chooseFile('../'));
  assert.throws(() => api.pmdgSdk.chooseFile('pmdg-737', {}));
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  for (const channel of ['pmdg-sdk-status', 'pmdg-sdk-reveal', 'pmdg-sdk-choose']) assert(main.includes(`registerTrustedIpcHandler('${channel}'`));
  assert(require('./package.json').build.files.includes('pmdg-sdk-setup.js'));
});
