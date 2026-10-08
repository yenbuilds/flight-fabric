'use strict';

// Read historical data with the current readers. No installer runs, network
// calls, simulator connection, or actual user directories are involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getRepoScratchPath } = require('./repo-scratch');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');

const fixtures = path.resolve(__dirname, '../fixtures/update-data-compatibility');
const provenance = JSON.parse(fs.readFileSync(path.join(fixtures, 'provenance.json'), 'utf8'));
const scratch = getRepoScratchPath('update-data-compatibility');
fs.mkdirSync(scratch, { recursive: true });
const home = fs.mkdtempSync(path.join(scratch, 'run-'));
// Configure all storage locations before loading any backend modules. Leave the
// disposable run directory for inspection; never open the person's settings.
for (const [key, value] of Object.entries({
  HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: '1',
})) process.env[key] = value;
for (const key of ['HOMEDRIVE', 'HOMEPATH', 'OneDrive', 'ONEDRIVE', 'OneDriveConsumer', 'OneDriveCommercial']) delete process.env[key];

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputHashes = Object.fromEntries([
  ...provenance.settings.map(item => [item.file, item.sha256]),
  [provenance.profile.file, provenance.profile.sha256],
  ...Object.entries(provenance.recording.files).map(([name, hash]) => [provenance.recording.directory + '/' + name, hash]),
]);
for (const [name, hash] of Object.entries(inputHashes)) assert.equal(sha256(path.join(fixtures, name)), hash, 'historical fixture fingerprint: ' + name);
const storage = require(runtime('utils', 'storage-paths.js'));
const settingsFile = storage.getSettingsFilePath(process.env);
assert.ok(path.relative(home, settingsFile) && !path.relative(home, settingsFile).startsWith('..'), 'settings stay inside disposable home');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

function assertPreferences(settings) {
  assert.equal(settings.network.remoteAccess, true);
  assert.equal(settings.network.remoteAircraftControl, false);
  assert.equal(settings.network.updateChecks, false);
  assert.equal(settings.network.onlineMapTiles, false);
  assert.equal(settings.recording.autoStart, false);
  assert.equal(settings.aircraft.profile, 'bundled/msfs/fbw-a32nx');
  assert.equal(settings.cabinAnnouncements.enabled, true);
  assert.equal(settings.cabinAnnouncements.style, 'custom-fixture-pack');
  assert.equal(settings.debrief.stabilityCriteria.speedPlusKts, 7);
}

for (const historical of provenance.settings) {
  test(historical.tag + ' settings retain saved choices on direct load, save and reopen', () => {
    fs.copyFileSync(path.join(fixtures, historical.file), settingsFile);
    const settingsModule = runtime('core', 'user-settings.js');
    delete require.cache[settingsModule];
    const current = require(settingsModule);
    assertPreferences(current.settings);
    current.saveUserSettings(current.settings);
    assertPreferences(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
    delete require.cache[settingsModule];
    assertPreferences(require(settingsModule).settings);
  });
}

test('bundled manual profile resolves; retired Local/Community profile copies remain untouched and excluded', () => {
  const loader = require(runtime('aircraft', 'aircraft-profile-loader.js'));
  const paths = ['Local', 'Community'].map(namespace => path.join(storage.getAppDataRoot(process.env), 'Profiles', 'Aircraft', namespace, 'msfs', 'fbw-a32nx.json'));
  for (const file of paths) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(fixtures, provenance.profile.file), file);
  }
  loader.clearCache();
  const selected = loader.setActiveProfile('bundled/msfs/fbw-a32nx');
  assert.equal(selected.id, 'fbw-a32nx');
  assert.equal(selected._qualifiedId, 'bundled/msfs/fbw-a32nx');
  assert.equal(loader.resolveProfilePath('local/msfs/fbw-a32nx'), null);
  assert.equal(loader.resolveProfilePath('community/msfs/fbw-a32nx'), null);
  assert.ok(loader.listProfiles().every(profile => profile.namespace === 'bundled'));
  for (const file of paths) assert.equal(sha256(file), provenance.profile.sha256);
});

test('v0.10.0 recorder bundle is discovered and read without changing certified members', async () => {
  const { resolveFlightLogsDir } = require(runtime('utils', 'flight-logs-dir.js'));
  const logs = resolveFlightLogsDir();
  assert.ok(path.relative(home, logs) && !path.relative(home, logs).startsWith('..'), 'flight logs stay inside disposable home');
  const bundle = path.join(logs, path.basename(provenance.recording.directory));
  fs.cpSync(path.join(fixtures, provenance.recording.directory), bundle, { recursive: true });
  const csv = path.join(bundle, 'telemetry.csv');
  const timeline = require(runtime('events', 'timeline-generator.js'));
  const { readFlightSummary } = require(runtime('flight-recording', 'read-flight-summary.js'));
  const { getLandingsFromCsvFile } = require(runtime('landing', 'flight-logbook.js'));
  const listed = await timeline.listCSVFlights();
  assert.ok(listed.some(flight => path.resolve(flight.filePath) === path.resolve(csv)), 'old complete recording appears in history discovery');
  const result = await timeline.generateFromCSV(csv);
  assert.equal(result.success, true, result.error);
  assert.equal(result.timeline.sampleCount, 61);
  const summary = readFlightSummary(csv);
  assert.equal(summary.max_alt_ft, 30000);
  assert.equal(summary.max_ias_kts, 240);
  assert.deepEqual(await getLandingsFromCsvFile(csv, { bypassCache: true }), [], 'cruise-only fixture invents no recorded landing');
  for (const [name, hash] of Object.entries(provenance.recording.files)) assert.equal(sha256(path.join(bundle, name)), hash, 'copied historical member preserved: ' + name);
});

test.after(() => {
  for (const [name, hash] of Object.entries(inputHashes)) assert.equal(sha256(path.join(fixtures, name)), hash, 'original fixture unchanged: ' + name);
  console.log('Historical data read acceptance: ' + home);
});
