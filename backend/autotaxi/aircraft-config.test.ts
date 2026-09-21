import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearTaxiAircraftConfigCache, resolveTaxiAircraftConfig } from './aircraft-config.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-taxi-config-'));
  const packages = path.join(root, 'Community');
  const write = (name: string, text: string) => {
    const file = path.join(packages, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const close = () => { clearTaxiAircraftConfigCache(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, packages, write, close };
}
const geometry = `[CONTACT_POINTS]
point.0 = 1, 25, 0, -5, 750, 0, 1, 70
point.1 = 1, -15, -10, -5, 750, 1, 1, 0
point.2 = 1, -15, 10, -5, 750, 2, 1, 0
[AIRPLANE_GEOMETRY]
fuselage_length = 120
`;

test('loaded aircraft geometry is read in feet and converted without a 737 fallback', () => {
  const h = fixture();
  try {
    const aircraft = h.write('one/SimObjects/Airplanes/Jet/aircraft.cfg', '[GENERAL]\nCategory=Airplane');
    h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', geometry);
    const result = resolveTaxiAircraftConfig(aircraft, { packageRoots: [h.packages] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.wheelbaseM, 12.192);
    assert.equal(result.wheelTrackM, 6.096);
    assert.equal(result.maxSteeringDeg, 70);
    assert.equal(result.lengthM, 36.576);
    assert.equal(result.noseOffsetM, 7.62);
    assert.equal(result.sourceFiles.length, 2);
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(resolveTaxiAircraftConfig(aircraft, { packageRoots: [h.packages] }), result);
  } finally { h.close(); }
});

test('multi-bogie track includes the outer wheels rather than each side average', () => {
  const h = fixture();
  try {
    const aircraft = h.write('one/SimObjects/Airplanes/Jet/aircraft.cfg', '[GENERAL]');
    h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', geometry.replace('[AIRPLANE_GEOMETRY]',
      'point.3 = 1, -15, -20, -5, 750, 1, 1, 0\npoint.4 = 1, -15, 20, -5, 750, 2, 1, 0\n[AIRPLANE_GEOMETRY]'));
    const result = resolveTaxiAircraftConfig(aircraft, { packageRoots: [] });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.wheelTrackM, 12.192);
      assert.equal(result.wheelbaseM, 12.192);
    }
  } finally { h.close(); }
});

test('VFS selection resolves one installed package and rejects duplicate matches', () => {
  const h = fixture();
  try {
    h.write('one/SimObjects/Airplanes/Jet/aircraft.cfg', '[GENERAL]');
    h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', geometry);
    const reference = 'SimObjects\\Airplanes\\Jet\\aircraft.cfg';
    assert.equal(resolveTaxiAircraftConfig(reference, { packageRoots: [h.packages] }).ok, true);
    h.write('two/SimObjects/Airplanes/Jet/aircraft.cfg', '[GENERAL]');
    clearTaxiAircraftConfigCache();
    assert.deepEqual(resolveTaxiAircraftConfig(reference, { packageRoots: [h.packages] }), {
      ok: false, reason: 'More than one installed package matches the loaded aircraft configuration.',
    });
  } finally { h.close(); }
});

test('UserCfg package location is used for a relative loaded path', () => {
  const h = fixture();
  try {
    h.write('one/SimObjects/Airplanes/Jet/aircraft.cfg', '[GENERAL]');
    h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', geometry);
    const config = path.join(h.root, 'UserCfg.opt');
    fs.writeFileSync(config, `InstalledPackagesPath "${h.root}"`);
    assert.equal(resolveTaxiAircraftConfig('SimObjects/Airplanes/Jet/aircraft.cfg', { userCfgPaths: [config] }).ok, true);
  } finally { h.close(); }
});

test('livery inherits parent geometry and fingerprints both parent and selected overrides', () => {
  const h = fixture();
  try {
    h.write('one/SimObjects/Airplanes/Base/aircraft.cfg', '[GENERAL]');
    const model = h.write('one/SimObjects/Airplanes/Base/flight_model.cfg', geometry);
    const aircraft = h.write('one/SimObjects/Airplanes/Livery/aircraft.cfg', '[VARIATION]\nbase_container="../Base"');
    const override = h.write('one/SimObjects/Airplanes/Livery/flight_model.cfg', '[AIRPLANE_GEOMETRY]\nfuselage_length=125');
    const before = resolveTaxiAircraftConfig(aircraft, { packageRoots: [] });
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.equal(before.lengthM, 38.1);
    assert.equal(before.wheelbaseM, 12.192);
    assert.ok(before.sourceFiles.includes(model));
    assert.ok(before.sourceFiles.includes(override));
    fs.appendFileSync(model, '\n; installed aircraft update\n');
    clearTaxiAircraftConfigCache();
    const after = resolveTaxiAircraftConfig(aircraft, { packageRoots: [] });
    assert.equal(after.ok, true);
    if (after.ok) assert.notEqual(after.fingerprint, before.fingerprint);
  } finally { h.close(); }
});

test('VFS base_container can resolve another package but ambiguous overlays fail', () => {
  const h = fixture();
  try {
    const aircraft = h.write('paint/SimObjects/Airplanes/Livery/aircraft.cfg', '[LIVERY]\nbase_container="SimObjects/Airplanes/Base"');
    h.write('base/SimObjects/Airplanes/Base/aircraft.cfg', '[GENERAL]');
    h.write('base/SimObjects/Airplanes/Base/flight_model.cfg', geometry);
    assert.equal(resolveTaxiAircraftConfig(aircraft, { packageRoots: [h.packages] }).ok, true);
    h.write('conflict/SimObjects/Airplanes/Base/aircraft.cfg', '[GENERAL]');
    clearTaxiAircraftConfigCache();
    assert.equal(resolveTaxiAircraftConfig(aircraft, { packageRoots: [h.packages] }).ok, false);
  } finally { h.close(); }
});

test('relative VFS livery inheritance resolves a base in another installed package', () => {
  const h = fixture();
  try {
    const selected = h.write('paint/SimObjects/Airplanes/Livery/aircraft.cfg', '[VARIATION]\nbase_container="../Base"');
    h.write('base/SimObjects/Airplanes/Base/aircraft.cfg', '[GENERAL]');
    h.write('base/SimObjects/Airplanes/Base/flight_model.cfg', geometry);
    assert.equal(resolveTaxiAircraftConfig(selected, { packageRoots: [h.packages] }).ok, true);
  } finally { h.close(); }
});

test('full-steering speed uses the configured feet-per-second scale', () => {
  const h = fixture();
  try {
    const aircraft = h.write('one/SimObjects/Airplanes/Jet/aircraft.cfg', '[GENERAL]');
    h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', geometry.replace('[CONTACT_POINTS]', '[CONTACT_POINTS]\nmax_speed_full_steering = 8.43905'));
    const result = resolveTaxiAircraftConfig(aircraft, { packageRoots: [] });
    assert.equal(result.ok, true);
    if (result.ok) assert.ok(Math.abs(result.fullSteeringSpeedKts! - 5) < 0.001);
    h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', geometry.replace('[CONTACT_POINTS]', '[CONTACT_POINTS]\nmax_speed_full_steering = NaN'));
    clearTaxiAircraftConfigCache();
    assert.equal(resolveTaxiAircraftConfig(aircraft, { packageRoots: [] }).ok, false);
  } finally { h.close(); }
});

test('configuration cycles, escapes, unavailable geometry and excessive file size fail closed', () => {
  const h = fixture();
  try {
    const aircraft = h.write('one/SimObjects/Airplanes/Jet/aircraft.cfg', '[VARIATION]\nbase_container="../Jet"');
    assert.match((resolveTaxiAircraftConfig(aircraft, { packageRoots: [] }) as { reason: string }).reason, /cycle/);
    fs.writeFileSync(aircraft, '[VARIATION]\nbase_container="../../../outside"');
    clearTaxiAircraftConfigCache();
    assert.match((resolveTaxiAircraftConfig(aircraft, { packageRoots: [] }) as { reason: string }).reason, /leaves/);
    fs.writeFileSync(aircraft, '[GENERAL]');
    clearTaxiAircraftConfigCache();
    assert.equal(resolveTaxiAircraftConfig(aircraft, { packageRoots: [] }).ok, false);
    h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', 'x'.repeat(1024 * 1024 + 1));
    clearTaxiAircraftConfigCache();
    assert.match((resolveTaxiAircraftConfig(aircraft, { packageRoots: [] }) as { reason: string }).reason, /too large/);
  } finally { h.close(); }
});

test('2024 selected preset resolves static root attachment contacts, including named properties', () => {
  const h = fixture();
  try {
    const folder = 'one/SimObjects/Airplanes/Family';
    const selected = h.write(`${folder}/presets/vendor/Variant/config/aircraft.cfg`, '[MODULAR_MERGE]\nauto=true');
    h.write(`${folder}/presets/vendor/Variant/config/flight_model.cfg`, '; generated file');
    h.write(`${folder}/presets/vendor/Variant/config/attached_objects.cfg`, '[SIM_ATTACHMENT.0]\nalias=Exterior\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Exterior"');
    h.write(`${folder}/attachments/vendor/Exterior/attachment.cfg`, '[VERSION]\nmajor=1');
    const model = h.write(`${folder}/attachments/vendor/Exterior/config/flight_model.cfg`, geometry.replace(/(point\.[0-2] = )/g, '$1Name:wheel#Properties:'));
    const result = resolveTaxiAircraftConfig(selected, { packageRoots: [] });
    assert.equal(result.ok, true);
    if (result.ok) { assert.equal(result.wheelbaseM, 12.192); assert.ok(result.sourceFiles.includes(model)); }
  } finally { h.close(); }
});

test('2024 dynamic attachment overrides and conflicting geometry are rejected', () => {
  const h = fixture();
  try {
    const folder = 'one/SimObjects/Airplanes/Family';
    const selected = h.write(`${folder}/presets/vendor/Variant/config/aircraft.cfg`, '[MODULAR_MERGE]\nauto=true');
    const reference = '[SIM_ATTACHMENT.0]\nalias=Exterior\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Exterior"';
    const attached = h.write(`${folder}/presets/vendor/Variant/config/attached_objects.cfg`, `${reference}\ncfg_parameter.0="nose,30"`);
    h.write(`${folder}/attachments/vendor/Exterior/config/flight_model.cfg`, geometry);
    assert.match((resolveTaxiAircraftConfig(selected, { packageRoots: [] }) as { reason: string }).reason, /Dynamic/);
    fs.writeFileSync(attached, `${reference}\n[SIM_ATTACHMENT.1]\nalias=Other\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Other"`);
    h.write(`${folder}/attachments/vendor/Other/config/flight_model.cfg`, geometry);
    clearTaxiAircraftConfigCache();
    assert.match((resolveTaxiAircraftConfig(selected, { packageRoots: [] }) as { reason: string }).reason, /Several/);
  } finally { h.close(); }
});

test('geometry-free visual attachments may share the wheel attachment alias', () => {
  const h = fixture();
  try {
    const folder = 'one/SimObjects/Airplanes/Family';
    const selected = h.write(`${folder}/presets/vendor/Variant/config/aircraft.cfg`, '[MODULAR_MERGE]\nauto=true');
    h.write(`${folder}/presets/vendor/Variant/config/attached_objects.cfg`,
      '[SIM_ATTACHMENT.0]\nalias=Exterior\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Exterior"\n'
      + '[SIM_ATTACHMENT.1]\nalias=Exterior\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Winglet"\nattach_to_node=Wing');
    h.write(`${folder}/attachments/vendor/Exterior/config/flight_model.cfg`, geometry);
    const visual = h.write(`${folder}/attachments/vendor/Winglet/attachment.cfg`, '[VERSION]\nmajor=1');
    const result = resolveTaxiAircraftConfig(selected, { packageRoots: [] });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.wheelbaseM, 12.192);
      assert.ok(result.sourceFiles.includes(visual), 'visual attachments remain inspected and fingerprinted');
    }
    h.write(`${folder}/attachments/vendor/Winglet/config/flight_model.cfg`, '[AIRPLANE_GEOMETRY]\nfuselage_length=130');
    clearTaxiAircraftConfigCache();
    const changed = resolveTaxiAircraftConfig(selected, { packageRoots: [] });
    assert.equal(changed.ok, false, 'a duplicate alias must not acquire a geometry override');
    if (!changed.ok) assert.match(changed.reason, /aliases/);
  } finally { h.close(); }
});

test('tailwheel, castering, asymmetric brakes and non-finite dimensions cannot qualify', () => {
  const h = fixture();
  try {
    const aircraft = h.write('one/SimObjects/Airplanes/Jet/aircraft.cfg', '[GENERAL]');
    const cases = [
      geometry.replace('1, 25, 0', '1, -25, 0'),
      geometry.replace('1, 70', '1, 180'),
      geometry.replace('1, 70', '1, 90'),
      geometry.replace('1, -15, 10', '1, -35, 10'),
      geometry.replace('fuselage_length = 120', 'fuselage_length = NaN'),
      geometry.replace('1, 25, 0', '1, [nose], 0'),
      geometry.replace('[AIRPLANE_GEOMETRY]', 'point.3=1,0,40,-5,750,0,1,0\n[AIRPLANE_GEOMETRY]'),
      geometry.replace('[AIRPLANE_GEOMETRY]', 'point.3=1,0,40,-5,750,4,1,0\n[AIRPLANE_GEOMETRY]'),
    ];
    for (const content of cases) {
      h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', content);
      clearTaxiAircraftConfigCache();
      assert.equal(resolveTaxiAircraftConfig(aircraft, { packageRoots: [] }).ok, false, content);
    }
  } finally { h.close(); }
});

test('a flight_model-only package overlay cannot silently override the selected aircraft', () => {
  const h = fixture();
  try {
    const aircraft = h.write('one/SimObjects/Airplanes/Jet/aircraft.cfg', '[GENERAL]');
    h.write('one/SimObjects/Airplanes/Jet/flight_model.cfg', geometry);
    h.write('overlay/SimObjects/Airplanes/Jet/flight_model.cfg', geometry.replace('120', '125'));
    const result = resolveTaxiAircraftConfig(aircraft, { packageRoots: [h.packages] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /More than one.*source/);
    fs.unlinkSync(path.join(h.packages, 'one/SimObjects/Airplanes/Jet/flight_model.cfg'));
    clearTaxiAircraftConfigCache();
    const missing = resolveTaxiAircraftConfig(aircraft, { packageRoots: [h.packages] });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /overlaid/);
  } finally { h.close(); }
});

test('modular contacts in common, root attachment and preset are not treated as key overrides', () => {
  const h = fixture();
  try {
    const folder = 'one/SimObjects/Airplanes/Family';
    const selected = h.write(`${folder}/presets/vendor/Variant/config/aircraft.cfg`, '[MODULAR_MERGE]\nauto=true');
    h.write(`${folder}/presets/vendor/Variant/config/attached_objects.cfg`, '[SIM_ATTACHMENT.0]\nalias=Exterior\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Exterior"');
    h.write(`${folder}/attachments/vendor/Exterior/config/flight_model.cfg`, geometry);
    const common = h.write(`${folder}/common/config/flight_model.cfg`, '[CONTACT_POINTS]\npoint.0=1,40,0,-5,750,0,1,75');
    let result = resolveTaxiAircraftConfig(selected, { packageRoots: [] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /Several modular sources/);
    fs.unlinkSync(common);
    h.write(`${folder}/presets/vendor/Variant/config/flight_model.cfg`, '[CONTACT_POINTS]\npoint.0=1,40,0,-5,750,0,1,75');
    clearTaxiAircraftConfigCache();
    result = resolveTaxiAircraftConfig(selected, { packageRoots: [] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /Several modular sources/);
  } finally { h.close(); }
});

test('modular geometry attachment aliases must be unique and the actual transform keys are checked', () => {
  const h = fixture();
  try {
    const folder = 'one/SimObjects/Airplanes/Family';
    const selected = h.write(`${folder}/presets/vendor/Variant/config/aircraft.cfg`, '[MODULAR_MERGE]\nauto=true');
    h.write(`${folder}/attachments/vendor/Exterior/config/flight_model.cfg`, geometry);
    const reference = '[SIM_ATTACHMENT.0]\nalias=Exterior\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Exterior"';
    for (const transform of ['attach_offset=10,0,0', 'attach_pbh=0,30,0', 'attach_scale=2']) {
      h.write(`${folder}/presets/vendor/Variant/config/attached_objects.cfg`, `${reference}\n${transform}`);
      clearTaxiAircraftConfigCache();
      const result = resolveTaxiAircraftConfig(selected, { packageRoots: [] });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /Transformed/);
    }
    h.write(`${folder}/presets/vendor/Variant/config/attached_objects.cfg`, reference.replace('alias=Exterior\n', ''));
    clearTaxiAircraftConfigCache();
    assert.match((resolveTaxiAircraftConfig(selected, { packageRoots: [] }) as { reason: string }).reason, /aliases/);
    h.write(`${folder}/presets/vendor/Variant/config/attached_objects.cfg`, `${reference}\n${reference.replace('SIM_ATTACHMENT.0', 'SIM_ATTACHMENT.1')}`);
    clearTaxiAircraftConfigCache();
    assert.match((resolveTaxiAircraftConfig(selected, { packageRoots: [] }) as { reason: string }).reason, /aliases|Several modular sources/);
  } finally { h.close(); }
});

test('repeated geometry-free attachment DAGs have a traversal bound, not only a unique-file bound', () => {
  const h = fixture();
  try {
    const folder = 'one/SimObjects/Airplanes/Family';
    const selected = h.write(`${folder}/presets/vendor/Variant/config/aircraft.cfg`, '[MODULAR_MERGE]\nauto=true');
    h.write(`${folder}/presets/vendor/Variant/config/flight_model.cfg`, geometry);
    h.write(`${folder}/presets/vendor/Variant/config/attached_objects.cfg`, '[SIM_ATTACHMENT.0]\nalias=Root\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Level0"');
    for (let level = 0; level < 5; level++) {
      h.write(`${folder}/attachments/vendor/Level${level}/attachment.cfg`, '[VERSION]\nmajor=1');
      if (level === 4) continue;
      h.write(`${folder}/attachments/vendor/Level${level}/config/attached_objects.cfg`, Array.from({ length: 5 }, (_, i) =>
        `[SIM_ATTACHMENT.${i}]\nalias=Alias${i}\nattachment_root="SimObjects/Airplanes/Family/attachments/vendor/Level${level + 1}"`).join('\n'));
    }
    const result = resolveTaxiAircraftConfig(selected, { packageRoots: [] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /too many references/);
  } finally { h.close(); }
});
