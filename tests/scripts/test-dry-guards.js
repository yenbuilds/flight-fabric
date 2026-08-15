'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveRepoSourcePath } = require('./backend-source-paths');
const sharedSettings = require('../../shared/app-settings-shared.js');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath) {
  const resolvedPath = relativePath.startsWith('backend/')
    ? resolveRepoSourcePath(relativePath)
    : path.join(ROOT_DIR, relativePath);
  return fs.readFileSync(resolvedPath, 'utf8');
}

function repoFileExists(relativePath) {
  const resolvedPath = relativePath.startsWith('backend/')
    ? resolveRepoSourcePath(relativePath)
    : path.join(ROOT_DIR, relativePath);
  return fs.existsSync(resolvedPath);
}

function normalizeTextForMirrorCompare(value) {
  return String(value).replace(/\r\n/g, '\n');
}

function listRepoFiles(dir, predicate) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'types' || entry.name === 'generated') continue;
      out.push(...listRepoFiles(fullPath, predicate));
    } else if (!predicate || predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed += 1;
  }
}

test('shared settings module exposes canonical normalization API', () => {
  assert.equal(typeof sharedSettings.normalizeAppSettings, 'function');
  assert.equal(typeof sharedSettings.sanitizeAppSettingsPatch, 'function');

  const normalized = sharedSettings.normalizeAppSettings({
    aircraft: { profile: '  test-profile  ' },
    advanced: { debugMode: true },
    performance: { pollRateMs: '999999' },
    cabinAnnouncements: { style: ' cinematic!! ' },
  }, {
    defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
  });

  assert.equal(normalized.aircraft.profile, 'test-profile');
  assert.equal(normalized.simulator.protocol, 'KittyHawk');
  assert.equal(sharedSettings.FIXED_TELEMETRY_POLL_RATE_MS, 100);
  assert.equal(Object.hasOwn(normalized, 'performance'), false);
  assert.equal(Object.hasOwn(normalized, 'advanced'), false);
  assert.equal(
    Object.hasOwn(sharedSettings.sanitizeAppSettingsPatch({
      performance: { pollRateMs: 50 },
    }), 'performance'),
    false,
  );
  assert.equal(
    Object.hasOwn(sharedSettings.sanitizeAppSettingsPatch({
      advanced: { debugMode: true },
    }), 'advanced'),
    false,
  );
  assert.equal(normalized.cabinAnnouncements.enabled, false);
  assert.equal(normalized.cabinAnnouncements.style, 'cinematic');

  assert.equal(
    sharedSettings.normalizeAppSettings({ simulator: { protocol: 'XPLANE_WEB' } }).simulator.protocol,
    'XPLANE_WEB',
  );
  assert.equal(
    sharedSettings.normalizeAppSettings({ simulator: { protocol: 'FSX_SP2' } }).simulator.protocol,
    'KittyHawk',
  );
});

test('telemetry poll cadence is fixed and absent from user interfaces', () => {
  const configSource = readRepoFile('backend/core/config.js');
  const settingsPanelsSource = readRepoFile('frontend/src/vue/components/SettingsFormPanels.vue');
  const settingsEditorSource = readRepoFile('frontend/src/vue/stores/settings-editor.js');
  const launcherSource = readRepoFile('electron/launcher/index.html');

  assert(configSource.includes('rateMs: FIXED_TELEMETRY_POLL_RATE_MS'));
  assert(configSource.includes('intervalMs: FIXED_TELEMETRY_POLL_RATE_MS'));
  assert(!configSource.includes("int('POLL_RATE_MS'"));
  assert(!configSource.includes("int('POLL_INTERVAL_MS'"));
  assert(!settingsPanelsSource.includes('setting-poll-rate-ms'));
  assert(!settingsEditorSource.includes('pollRateMs'));
  assert(!launcherSource.includes('summary-poll-rate'));
});

test('backend path containment uses shared guard helpers instead of string prefix checks', () => {
  const backendRoot = path.join(ROOT_DIR, 'backend');
  const offenders = listRepoFiles(
    backendRoot,
    (filePath) => /\.(js|ts)$/.test(filePath) && !filePath.includes(`${path.sep}types${path.sep}generated${path.sep}`),
  ).filter((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    return /startsWith\s*\([^)]*path\.sep/.test(source) || /startsWith\s*\(\s*`[^`]*\$\{path\.sep\}/.test(source);
  });

  assert.deepStrictEqual(
    offenders.map((filePath) => path.relative(ROOT_DIR, filePath).replace(/\\/g, '/')),
    [],
    'use backend/utils/path-guard.ts for path containment instead of startsWith(...path.sep)',
  );
});

test('runtime destructive filesystem operations use explicit safe-fs guards', () => {
  const safeFsSource = readRepoFile('backend/utils/safe-fs.js');
  const timelineGeneratorSource = readRepoFile('backend/events/timeline-generator.js');
  const profileLoaderSource = readRepoFile('backend/aircraft/aircraft-profile-loader.js');
  const destinationTargetSource = readRepoFile('backend/core/destination-target-store.js');
  const managedInstallSource = readRepoFile('backend/utils/managed-install-state.js');
  const sdkConnectorSource = readRepoFile('backend/telemetry-provider/sdk-connector-store.js');
  const userSettingsSource = readRepoFile('backend/core/user-settings.js');
  const userIdentitySource = readRepoFile('backend/utils/user-identity.js');
  const logbookSource = readRepoFile('backend/landing/flight-logbook.js');
  const recordingPathGuardSource = readRepoFile('backend/flight-recording/recording-path-guard.js');
  const flightCsvWriterSource = readRepoFile('backend/flight-recording/flight-csv-writer.js');
  const csvWorkerSource = readRepoFile('backend/flight-recording/csv-line-writer-worker.js');
  const automationJsonlSource = readRepoFile('backend/flight-recording/automation-jsonl-recorder.js');
  const aircraftSpecificJsonlSource = readRepoFile('backend/flight-recording/aircraft-specific-jsonl-recorder.js');

  assert(safeFsSource.includes('function assertSafeFileTarget'), 'safe-fs should centralize root/path/extension checks');
  assert(safeFsSource.includes('target is outside the allowed root'), 'safe-fs should reject paths outside an allowed root');
  assert(safeFsSource.includes('target extension is not allowlisted'), 'safe-fs should enforce operation-specific extension allowlists');
  assert(safeFsSource.includes('target is a symbolic link'), 'safe-fs should reject symlink targets by default');
  assert(safeFsSource.includes('target parent contains a symbolic link'), 'safe-fs should reject symlinked parent directories by default');

  assert(timelineGeneratorSource.includes('safeUnlinkSync({'), 'flight CSV deletion should route through safeUnlinkSync');
  assert(timelineGeneratorSource.includes("operation: 'deleteFlightCsv'"), 'flight CSV deletion should name the guarded operation');
  assert(timelineGeneratorSource.includes("operation: 'writeTimelineSidecar'"), 'timeline sidecar writes should use guarded app-format writes');
  assert(!profileLoaderSource.includes('safeCopyFileSync({'), 'bundled profiles should not be copied into app data');
  assert(!profileLoaderSource.includes('seedBundledAircraftProfile'), 'bundled profile app-data seeding should stay removed');
  assert(!profileLoaderSource.includes('refreshBundledAircraftProfile'), 'bundled profile app-data refreshes should stay removed');
  assert(!profileLoaderSource.includes('safeReplaceTextFileSync({'), 'release-owned profiles should expose no runtime write path');
  assert(!profileLoaderSource.includes('overwriteLocalProfileKey'), 'release-owned profiles should expose no local overwrite path');
  assert(!profileLoaderSource.includes("operation: 'deleteUserProfile'"), 'release-owned profiles should expose no user deletion path');
  assert(destinationTargetSource.includes("operation: 'clearRouteTarget'"), 'route target clears should use guarded named deletes');
  assert(managedInstallSource.includes('safeUnlinkSync({'), 'managed install metadata deletion should route through safeUnlinkSync');
  assert(sdkConnectorSource.includes("operation: 'importSdkConnectorDefinition'"), 'SDK connector definition writes should use guarded app-data writes');
  assert(userSettingsSource.includes("operation: 'saveUserSettings'"), 'settings writes should use guarded app-data writes');
  assert(userIdentitySource.includes("operation: 'writeUserId'"), 'user id writes should use guarded app-data writes');
  assert(logbookSource.includes("operation: 'writeLogbook'"), 'logbook writes should use guarded app-data writes');
  assert(recordingPathGuardSource.includes('recording files must be direct children'), 'recording path guard should refuse nested recording write paths');
  assert(recordingPathGuardSource.includes('createSafeRecordingWriteStream'), 'recording path guard should centralize recording stream creation');
  assert(flightCsvWriterSource.includes('startWorkerFlightCsvRecording'), 'worker CSV start should validate the target path before spawning the writer');
  assert(csvWorkerSource.includes('createSafeRecordingWriteStream({'), 'CSV worker stream creation should route through recording path guard');
  assert(csvWorkerSource.includes('safeRenameRecordingFileSync({'), 'CSV worker rename should route through recording path guard');
  assert(automationJsonlSource.includes('openAutomationJsonlRecording'), 'automation JSONL stream creation should route through recording path guard');
  assert(automationJsonlSource.includes('renameAutomationJsonlRecording'), 'automation JSONL rename should route through recording path guard');
  assert(aircraftSpecificJsonlSource.includes('openAircraftSpecificJsonlRecording'), 'aircraft-specific JSONL stream creation should route through recording path guard');
  assert(aircraftSpecificJsonlSource.includes('renameAircraftSpecificJsonlRecording'), 'aircraft-specific JSONL rename should route through recording path guard');
});

test('flight recorder session stats count only accepted CSV samples', () => {
  const simbridgeCoreSource = readRepoFile('backend/core/simbridge-core.js');
  assert.match(
    simbridgeCoreSource,
    /if\s*\(\s*flightCsvWriter\.writeSample\(enrichedFrame\)\s*\)\s*\{\s*recordingSession\.incrementSampleCount\(\);/s,
    'recording session sample count should increment only after the CSV writer accepts the row',
  );
});

test('backend runtime build preserves a locked running Rust sidecar', () => {
  const buildRuntimeSource = readRepoFile('scripts/build-backend-runtime.js');
  const startSimbridgeSource = readRepoFile('start-simbridge.bat');
  const electronMainSource = readRepoFile('electron/main.js');
  const runtimeOwnerLockSource = readRepoFile('electron/runtime-owner-lock.js');
  const backendWrapperSource = readRepoFile('scripts/start-backend-runtime.js');
  const prepareStartRuntimeSource = readRepoFile('scripts/prepare-start-runtime.js');
  const runtimePathsSource = readRepoFile('scripts/backend-runtime-paths.js');
  const rustArtifactSource = readRepoFile('shared/rust-sidecar-artifact.js');
  const runtimeOwnerLockTestSource = readRepoFile('tests/scripts/test-runtime-owner-lock.js');
  const packagedLifecycleTestSource = readRepoFile('tests/scripts/test-electron-packaged-lifecycle.js');
  const windowsProcessCleanupSource = readRepoFile('tests/scripts/windows-process-cleanup.js');
  const rustSimvarBridgeSource = readRepoFile('backend/telemetry-provider/rust-simvar-bridge.ts');
  const lvarBridgeSource = readRepoFile('backend/telemetry-provider/lvar-sidecar-bridge.ts');
  const sdkLaunchSource = readRepoFile('backend/telemetry-provider/sdk-adapters/rust-clientdata-launch.ts');

  assert(buildRuntimeSource.includes('function isRustSidecarDistPath'), 'runtime build should identify the dist Rust sidecar binary');
  assert(buildRuntimeSource.includes('function isBackendRuntimePath'), 'runtime build should identify files inside dist/backend');
  assert(buildRuntimeSource.includes("'Rust sidecar binary'"), 'runtime build cleanup should label a locked running sidecar');
  assert(buildRuntimeSource.includes('Preserving locked ${label}'), 'runtime build cleanup should preserve locked backend runtime files');
  assert(buildRuntimeSource.includes('Preserving locked runtime file'), 'runtime build copy should tolerate locked runtime DLLs from a running backend');
  assert(buildRuntimeSource.includes("getRepoScratchPath('rust-sidecar-release-target')"), 'runtime builds should use an ignored Rust target that cannot be the running development binary');
  assert(buildRuntimeSource.includes("resetRepoScratchDirectory('rust-sidecar-release-target')"), 'runtime builds should recreate the exact Rust target before Cargo can reuse ignored output');
  assert(buildRuntimeSource.includes("'--locked'"), 'runtime Cargo builds should honor the committed dependency lock');
  assert(buildRuntimeSource.includes("'--target-dir'"), 'runtime Cargo builds should explicitly select the isolated release target');
  assert(buildRuntimeSource.includes("RUST_SIDECAR_PENDING_DIR = path.join(RUST_SIDECAR_DIST_DIR, '.pending')"), 'locked Rust builds should have an exact managed pending directory');
  assert(buildRuntimeSource.includes("return 'copied'"), 'runtime copies should report a successful replacement truthfully');
  assert(buildRuntimeSource.includes("return 'preserved'"), 'runtime copies should report a locked preserved destination truthfully');
  assert(buildRuntimeSource.includes('copyFile(sourcePath, RUST_SIDECAR_PENDING_BINARY)'), 'a locked main Rust executable should stage the verified current binary');
  assert(buildRuntimeSource.includes('removeTarget(RUST_SIDECAR_PENDING_DIR)'), 'a successful main Rust copy should clean an older staged artifact when possible');
  assert(rustArtifactSource.includes('return pendingMtimeMs >= mainMtimeMs ? pendingPath : mainPath'), 'managed Rust resolution should select the newer artifact with a deterministic pending tie');
  for (const [label, source] of [
    ['Rust SimVar bridge', rustSimvarBridgeSource],
    ['LVAR bridge', lvarBridgeSource],
    ['SDK ClientData bridge', sdkLaunchSource],
    ['standalone guardian', backendWrapperSource],
    ['Electron guardian', electronMainSource],
  ]) {
    assert(source.includes('selectNewestManagedRustSidecar'), `${label} should select the newest managed main/pending Rust artifact`);
  }
  assert(prepareStartRuntimeSource.includes("'telemetry-provider', RUST_SIDECAR_BINARY_NAME"), 'startup freshness should include the normal dist Rust executable');
  assert(runtimePathsSource.includes("'telemetry-provider', RUST_SIDECAR_BINARY_NAME"), 'runtime completeness should require the normal dist Rust executable');
  const rustBuildCallIndex = buildRuntimeSource.indexOf('buildRustSidecarBinary();', buildRuntimeSource.indexOf('function copyRustSidecarBinary'));
  const rustReleaseCopyIndex = buildRuntimeSource.indexOf('const sourcePath = RUST_SIDECAR_RELEASE_BINARY;', rustBuildCallIndex);
  assert(rustBuildCallIndex > 0 && rustReleaseCopyIndex > rustBuildCallIndex, 'runtime builds should always refresh the release Rust binary before copying it');
  const rustTargetResetIndex = buildRuntimeSource.indexOf("resetRepoScratchDirectory('rust-sidecar-release-target')");
  const rustCargoBuildIndex = buildRuntimeSource.indexOf('execFileSync(cargo', rustTargetResetIndex);
  assert(rustTargetResetIndex > 0 && rustCargoBuildIndex > rustTargetResetIndex, 'runtime builds should clear the isolated Rust target before invoking Cargo');
  assert(buildRuntimeSource.includes("verifyRustSidecarGuardianCapability(sourcePath)"), 'runtime builds should fail closed unless the Rust binary exposes process guardian mode');
  assert(buildRuntimeSource.includes("spawnSync(binaryPath, ['--process-guardian']"), 'runtime build guardian capability check should be bounded and non-interactive');
  assert(startSimbridgeSource.includes('node scripts\\prepare-start-runtime.js'), 'dev launcher should refresh stale built output before starting the backend');
  assert(startSimbridgeSource.includes('set "FF_LOCAL_BAT_LAUNCH=1"'), 'dev launcher should mark local batch launches for backend config');
  assert(startSimbridgeSource.includes('set "STABILITY_DEBUG_LOG=0"'), 'dev launcher should force stability debug file logging off');
  assert(startSimbridgeSource.includes('set "STABILITY_DEBUG_ALWAYS_ACTIVE=0"'), 'dev launcher should force always-active stability debug mode off');
  assert(startSimbridgeSource.includes(':classify_flight_fabric_backend_pid'), 'dev launcher should classify port-owner identity before taskkill');
  assert(startSimbridgeSource.includes("core[\\\\/]+simbridge\\.js"), 'dev launcher port-owner verification should match the backend entrypoint');
  assert(startSimbridgeSource.includes('--ff-launch-owner=batch'), 'dev launcher should mark standalone batch-owned backends');
  assert(electronMainSource.includes("'--ff-launch-owner=electron'"), 'Electron should mark its managed backend child');
  assert(runtimeOwnerLockSource.includes('exclusive: true'), 'launch-mode lock should use an exclusive OS-owned listener');
  assert(runtimeOwnerLockSource.includes('getDefaultRuntimeOwnerPipePath'), 'Windows launch-mode locking should use a per-user named pipe');
  assert(electronMainSource.includes("acquireRuntimeOwnerLock({ owner: 'electron' })"), 'Electron should hold the shared launch-mode lock for its lifetime');
  assert(backendWrapperSource.includes("acquireRuntimeOwnerLock({ owner: 'standalone' })"), 'standalone wrapper should acquire the same launch-mode lock before spawning');
  assert(backendWrapperSource.includes('function canonicalizeBackendArgs'), 'standalone wrapper should canonicalize caller-controlled launch identity arguments');
  assert(backendWrapperSource.includes("forwarded.push(`${LAUNCH_OWNER_FLAG}=batch`)"), 'standalone wrapper should emit exactly its canonical batch owner marker');
  assert(backendWrapperSource.includes('const backendEntry = resolveBackendEntry();'), 'standalone wrapper should resolve its backend entry while holding the launch-mode lock');
  assert(
    backendWrapperSource.indexOf("acquireRuntimeOwnerLock({ owner: 'standalone' })") < backendWrapperSource.indexOf('const backendEntry = resolveBackendEntry();'),
    'standalone wrapper should acquire the launch-mode lock before entry resolution can rebuild runtime output',
  );
  assert(backendWrapperSource.includes("const PREPARE_RUNTIME_FLAG = '--ff-wrapper-prepare-runtime'"), 'standalone wrapper should consume the private locked-preparation flag');
  assert(backendWrapperSource.includes('runRuntimePreparation();'), 'standalone wrapper should run batch preparation while holding the lock');
  assert(backendWrapperSource.includes('await waitForWrapperControl(launchContext)'), 'standalone wrapper should wait for post-preparation port approval before spawning');
  assert(backendWrapperSource.includes('startProcessGuardian(backendEntry, backendChild)'), 'standalone wrapper should establish the native guardian before reporting a safe launch');
  assert(backendWrapperSource.includes('line === PROCESS_GUARDIAN_READY_MARKER'), 'standalone wrapper should accept only the exact guardian readiness line');
  assert(backendWrapperSource.includes('waitForBackendReadyMarker(backendChild)'), 'standalone wrapper should require the exact canonical backend readiness line');
  assert(backendWrapperSource.includes("status: 'ready'"), 'standalone wrapper should expose a nonce-bound ready state only after its startup gates');
  assert(startSimbridgeSource.includes('call :wait_for_wrapper_ready'), 'batch launcher should wait for guardian and provider readiness before listener revalidation');
  assert(!startSimbridgeSource.includes('RUNTIME_OWNER_LOCK_PORT'), 'batch launcher should not probe a TCP port for the named-pipe launch lock');
  const runtimeOwnerPortCleanupSource = runtimeOwnerLockTestSource.match(
    /function forceCleanupPorts\(ports\) \{[\s\S]*?\n\}/,
  )?.[0] || '';
  assert(runtimeOwnerPortCleanupSource.includes('captureCurrentUserWindowsProcessIdentity'), 'runtime-owner test cleanup should verify a same-user process identity before stopping a port owner');
  assert(runtimeOwnerPortCleanupSource.includes('predicate: isExpectedTestBackendIdentity'), 'runtime-owner test cleanup should require its exact backend identity predicate');
  assert(runtimeOwnerPortCleanupSource.includes('forceStopVerifiedWindowsProcessTree(identity)'), 'runtime-owner test cleanup should revalidate the captured process instance immediately before taskkill');
  assert(!runtimeOwnerPortCleanupSource.includes("execFileSync('taskkill.exe'"), 'runtime-owner port cleanup should not directly taskkill an unverified listener');
  assert(runtimeOwnerLockTestSource.includes('`--ff-launch-nonce=${SAFE_TEST_NONCE}`'), 'runtime-owner cleanup identity should include the unique test launch nonce');
  assert(windowsProcessCleanupSource.includes('isSameWindowsProcessIdentity(normalizedInitial, currentIdentity)'), 'test process cleanup should reject PID reuse before forced termination');
  assert(packagedLifecycleTestSource.includes('captureCurrentUserWindowsProcessIdentity'), 'packaged lifecycle cleanup should capture managed process identities');
  assert(packagedLifecycleTestSource.includes('forceStopVerifiedWindowsProcessTree(identity)'), 'packaged lifecycle cleanup should reject changed process identities before taskkill');
  for (const owner of ['UNVERIFIED', 'ELECTRON', 'STANDALONE', 'VERIFIED_UNKNOWN']) {
    assert(startSimbridgeSource.includes(owner), `dev launcher classifier should include ${owner}`);
  }
  assert(!startSimbridgeSource.includes('Kill this unverified process and continue'), 'dev launcher should never offer to kill an unverified port owner');
  assert(startSimbridgeSource.includes('GetOwnerSid'), 'dev launcher should verify a port owner belongs to the current Windows user');
  assert(startSimbridgeSource.includes('$owner.Sid -ne $currentSid'), 'dev launcher should fail closed for another Windows user\'s marked backend');
  assert(startSimbridgeSource.includes('This launcher will not detach or replace a backend owned by the desktop app.'), 'dev launcher should refuse to replace an Electron-owned backend');
  assert(startSimbridgeSource.includes('only stops backends marked as standalone batch launches'), 'dev launcher should fail closed for unmarked and unverified owners');
  assert(startSimbridgeSource.includes('if "!P8100_PID!"=="!P8099_PID!" ('), 'dev launcher should classify and stop the same backend PID only once');
  assert(startSimbridgeSource.includes('value>=1 && value<=65535'), 'dev launcher should reject invalid configured port ranges before startup');
  assert(startSimbridgeSource.includes('WebSocket and HTTP ports must be different.'), 'dev launcher should reject a shared WebSocket/HTTP port');
  assert.equal((startSimbridgeSource.match(/taskkill \/PID !FF_STOP_PID! \/T \/F/g) || []).length, 1, 'dev launcher should centralize tree-aware backend termination');
  const stopHelperStart = startSimbridgeSource.indexOf(':stop_standalone_backend_pid');
  const stopHelperEnd = startSimbridgeSource.indexOf('\n:after_helpers', stopHelperStart);
  const stopHelperSource = startSimbridgeSource.slice(stopHelperStart, stopHelperEnd);
  assert.equal(
    (stopHelperSource.match(/call :capture_standalone_backend_identity "!FF_STOP_PID!" "!FF_STOP_NONCE!"/g) || []).length,
    2,
    'stop helper should capture and immediately re-read one complete process identity before mutation',
  );
  assert(stopHelperSource.includes('if not "!FF_CAPTURED_BACKEND_IDENTITY!"=="!FF_STOP_ORIGINAL_IDENTITY!"'), 'PID reuse or identity mutation should prevent taskkill');
  assert(stopHelperSource.indexOf('FF_STOP_ORIGINAL_IDENTITY') < stopHelperSource.indexOf('taskkill '), 'only an unchanged standalone identity should reach taskkill');
  assert(startSimbridgeSource.includes('creationToken=$p.CreationDate.ToUniversalTime().Ticks.ToString()'), 'batch cleanup identity should include an immutable process creation token');
  assert(startSimbridgeSource.includes('ownerSid=[string]$owner.Sid'), 'batch cleanup identity should include the exact current-user SID');
  assert(startSimbridgeSource.includes('commandLine=$commandLine'), 'batch cleanup identity should include the exact marked command line and optional nonce');
  assert(stopHelperSource.includes('FF_TASKKILL_RESULT'), 'stop helper should check taskkill failure');
  assert(stopHelperSource.includes('is still running after taskkill'), 'stop helper should verify PID exit');
  const launchIndex = startSimbridgeSource.indexOf('start "Flight Fabric Backend"');
  const nonceGenerationIndex = startSimbridgeSource.indexOf("require('crypto').randomBytes(32).toString('hex')");
  assert(nonceGenerationIndex > 0 && nonceGenerationIndex < launchIndex, 'dev launcher should create a cryptographically random identity immediately before launch');
  assert(startSimbridgeSource.includes('--ff-launch-nonce=!FF_BACKEND_LAUNCH_NONCE!'), 'dev launcher should pass its unique identity through the wrapper to the backend');
  assert(startSimbridgeSource.includes('--ff-wrapper-prepare-runtime'), 'dev launcher should ask the wrapper to prepare runtime output under its lock');
  const preparedProbeLine = startSimbridgeSource
    .split(/\r?\n/)
    .find((line) => line.includes("state.status==='prepared'"));
  assert(preparedProbeLine?.includes('} catch (_) {}"'), 'prepared-state probe should remain valid JavaScript and fail closed without hanging');
  assert(!preparedProbeLine?.includes('!state') && !preparedProbeLine?.includes('!=='), 'prepared-state probe should avoid JavaScript bangs that delayed expansion mangles');
  const readyProbeLine = startSimbridgeSource
    .split(/\r?\n/)
    .find((line) => line.includes("state.status==='ready'"));
  assert(!readyProbeLine?.includes('!state') && !readyProbeLine?.includes('!=='), 'ready-state probe should avoid JavaScript bangs that delayed expansion mangles');
  const preparedWaitIndex = startSimbridgeSource.indexOf('call :wait_for_wrapper_prepared', launchIndex);
  const finalPortRefreshIndex = startSimbridgeSource.indexOf('call :refresh_backend_port_pids', preparedWaitIndex);
  const launchAuthorizationIndex = startSimbridgeSource.indexOf('call :signal_prepared_wrapper go', preparedWaitIndex);
  assert(preparedWaitIndex > launchIndex, 'dev launcher should wait for locked preparation after starting the wrapper');
  assert(finalPortRefreshIndex > preparedWaitIndex, 'dev launcher should refresh owners using post-preparation effective ports');
  assert(launchAuthorizationIndex > finalPortRefreshIndex, 'dev launcher should recheck both ports before authorizing backend spawn');
  const readinessCallIndex = startSimbridgeSource.indexOf('call :wait_for_standalone_backend_ready', launchIndex);
  const browserOpenIndex = startSimbridgeSource.indexOf('start "" "!UI_URL!"', launchIndex);
  assert(readinessCallIndex > launchIndex, 'dev launcher should wait for the launched backend after starting its wrapper');
  assert(browserOpenIndex > readinessCallIndex, 'dev launcher should open the browser only after backend readiness succeeds');
  assert(startSimbridgeSource.includes('if errorlevel 1 goto :backend_launch_failed'), 'dev launcher should abort visibly when wrapper startup or readiness fails');
  const readinessHelperStart = startSimbridgeSource.indexOf(':wait_for_standalone_backend_ready');
  const readinessHelperEnd = startSimbridgeSource.indexOf('\n:after_helpers', readinessHelperStart);
  const readinessHelperSource = startSimbridgeSource.slice(readinessHelperStart, readinessHelperEnd);
  assert(readinessHelperSource.includes('if not "!P8099_PID!"=="!P8100_PID!"'), 'backend readiness should require one PID to own both configured ports');
  assert(readinessHelperSource.includes('if "!P8099_OWNER!"=="STANDALONE"'), 'backend readiness should require the listener PID to be a marked standalone backend');
  const nonceReadinessCheckIndex = readinessHelperSource.indexOf('call :verify_backend_launch_nonce "!P8099_PID!" "!FF_BACKEND_LAUNCH_NONCE!"');
  const readyPidAssignmentIndex = readinessHelperSource.indexOf('set "FF_BACKEND_READY_PID=!P8099_PID!"');
  assert(nonceReadinessCheckIndex > 0 && readyPidAssignmentIndex > nonceReadinessCheckIndex, 'backend readiness should accept only the listener carrying this launcher instance nonce');
  assert(readinessHelperSource.includes('if "!FF_BACKEND_LAUNCH_NONCE_MATCH!"=="1"'), 'backend readiness should fail closed when another batch invocation owns the listeners');
  assert(readinessHelperSource.includes('if not "!P8099_OWNER!"=="UNVERIFIED"'), 'backend readiness should retry ambiguous WebSocket ownership instead of abandoning a possibly healthy child');
  assert(readinessHelperSource.includes('if not "!P8100_OWNER!"=="UNVERIFIED"'), 'backend readiness should retry ambiguous HTTP ownership instead of abandoning a possibly healthy child');
  assert(readinessHelperSource.includes('if "!FF_BACKEND_LAUNCH_NONCE_MATCH!"=="0"'), 'backend readiness should reject a definite nonce mismatch while retrying an unverifiable nonce query');
  assert(readinessHelperSource.includes('exit /b 1'), 'backend readiness should fail closed on timeout or unexpected ownership');
  const failedLaunchLabelIndex = startSimbridgeSource.indexOf('\n:backend_launch_failed');
  const failedLaunchCleanupIndex = startSimbridgeSource.indexOf('call :cleanup_failed_backend_launch', failedLaunchLabelIndex);
  assert(failedLaunchCleanupIndex > failedLaunchLabelIndex && failedLaunchCleanupIndex < browserOpenIndex, 'readiness failure should clean up only the backend spawned by this invocation before returning');
  const cleanupHelperStart = startSimbridgeSource.indexOf(':cleanup_failed_backend_launch');
  const cleanupHelperEnd = startSimbridgeSource.indexOf('\n:after_helpers', cleanupHelperStart);
  const cleanupHelperSource = startSimbridgeSource.slice(cleanupHelperStart, cleanupHelperEnd);
  assert(cleanupHelperSource.includes('call :find_backend_pid_by_launch_nonce "!FF_BACKEND_LAUNCH_NONCE!"'), 'failed-launch cleanup should locate only its cryptographic nonce owner');
  assert(cleanupHelperSource.includes('call :stop_standalone_backend_pid "!FF_NONCE_BACKEND_PID!" "!FF_BACKEND_LAUNCH_NONCE!"'), 'failed-launch cleanup should carry the nonce into the final pre-kill verification');
  assert(cleanupHelperSource.includes('if "!FF_NONCE_BACKEND_PID!"=="MULTIPLE"'), 'failed-launch cleanup should refuse ambiguous nonce ownership');
  const successMessageIndex = startSimbridgeSource.indexOf('Backend running in a separate window.');
  assert(successMessageIndex > browserOpenIndex, 'dev launcher should not report success until readiness has passed and the browser was opened');
  const refreshHelperStart = startSimbridgeSource.indexOf(':refresh_backend_port_pids');
  const refreshHelperEnd = startSimbridgeSource.indexOf('\n:stop_standalone_backend_pid', refreshHelperStart);
  const refreshHelperSource = startSimbridgeSource.slice(refreshHelperStart, refreshHelperEnd);
  assert(!refreshHelperSource.includes('.*LISTENING'), 'port refresh helper should not use prefix-ambiguous findstr matching');
  assert(refreshHelperSource.includes('const match=/:(\\d+)$/.exec(fields[1]);'), 'port refresh helper should parse the final numeric local-endpoint port exactly');
  assert(refreshHelperSource.includes("fields[3].toUpperCase()==='LISTENING'"), 'port refresh helper should parse netstat state as its own field');
  assert(refreshHelperSource.includes("/^\\d+$/.test(fields[4])"), 'port refresh helper should accept only a numeric netstat PID field');
  assert(refreshHelperSource.includes('if "%%P"=="!WS_PORT!"') && refreshHelperSource.includes('if "%%P"=="!HTTP_PORT_VALUE!"'), 'port refresh helper should map only exact configured port numbers');
  assert(prepareStartRuntimeSource.includes('ensureRequiredOurAirportsData'), 'start prep should ensure required airport data before starting the backend');
  assert(!prepareStartRuntimeSource.includes('sync-aviation-data.js'), 'start prep should not fetch OurAirports data implicitly');
  assert(prepareStartRuntimeSource.includes('Run npm run data:sync:required explicitly'), 'start prep should tell developers how to fetch required data explicitly');
  assert(prepareStartRuntimeSource.includes('Backend runtime is stale'), 'start prep should rebuild stale backend runtime output');
  assert(prepareStartRuntimeSource.includes('Frontend bundle is stale'), 'start prep should rebuild stale frontend bundle output');
  assert(prepareStartRuntimeSource.includes('FRONTEND_TAILWIND'), 'start prep should treat compiled Tailwind CSS as required frontend output');
  assert(runtimePathsSource.includes('ensureBackendRuntimeFile'), 'runtime path resolver should rebuild partial dist outputs when an exact requested file is missing');
});

test('frontend flight phase compatibility assets mirror the shared registry', () => {
  assert.equal(
    normalizeTextForMirrorCompare(readRepoFile('frontend/flight-phases.js')),
    normalizeTextForMirrorCompare(readRepoFile('shared/flight-phases.js')),
  );
  assert.equal(
    normalizeTextForMirrorCompare(readRepoFile('frontend/flight-phases.d.ts')),
    normalizeTextForMirrorCompare(readRepoFile('shared/flight-phases.d.ts')),
  );
});

test('frontend app shell does not contain mojibake UI text', () => {
  const html = readRepoFile('frontend/index.html');
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const autopilotControlsSource = readRepoFile('frontend/src/vue/components/AutopilotControlsTab.vue');
  const mojibakeMarkers = ['Ã', 'Â', 'â‚¬', 'â€', 'Ë†'];
  const found = [
    ...mojibakeMarkers
      .filter((marker) => html.includes(marker))
      .map((marker) => `frontend/index.html:${marker}`),
    ...mojibakeMarkers
      .filter((marker) => appShellSource.includes(marker))
      .map((marker) => `frontend/src/vue/components/AppShell.vue:${marker}`),
    ...mojibakeMarkers
      .filter((marker) => autopilotControlsSource.includes(marker))
      .map((marker) => `frontend/src/vue/components/AutopilotControlsTab.vue:${marker}`),
  ];
  assert.deepStrictEqual(found, [], `frontend shell contains mojibake markers: ${found.join(', ')}`);

  const decrementLabels = Array.from(autopilotControlsSource.matchAll(/\{\s*action:\s*'dec[^']*',\s*label:\s*'([^']*)'\s*\}/g))
    .map((match) => match[1]);
  assert(decrementLabels.length >= 4, 'expected autopilot decrement buttons to be present');
  assert(
    decrementLabels.every((label) => label === '-' || label === '--'),
    'autopilot decrement controls should use plain ASCII minus labels',
  );
  assert(!autopilotControlsSource.includes('$event'), 'AutopilotControlsTab should not route control commands through raw DOM event targets');
  assert(autopilotControlsSource.includes(':disabled="isCommandDisabled('), 'AutopilotControlsTab should render store-driven disabled state');
});

test('release-facing setup HTML and build logs stay ASCII-safe', () => {
  const httpServerSource = readRepoFile('backend/core/http-server.ts');
  const electronBuildSource = readRepoFile('electron/build-electron.js');
  const electronMainSource = readRepoFile('electron/main.js');

  assert(httpServerSource.includes('<h1>Mobile Browser Setup</h1>'), 'mobile setup page should use an ASCII-safe heading');
  assert(httpServerSource.includes('<h1>Flight Fabric</h1>'), 'fallback HTTP page should use an ASCII-safe heading');
  assert(!httpServerSource.includes('📱'), 'mobile setup page should not rely on emoji rendering');
  assert(!httpServerSource.includes('✈'), 'fallback HTTP page should not rely on emoji rendering');
  assert(electronBuildSource.includes("log('  Profile validated OK');"), 'release build validation log should use ASCII-safe success text');
  assert(!electronBuildSource.includes('Profile validated ✓'), 'release build logs should not rely on symbol rendering');
  assert(!electronBuildSource.includes('— skipping'), 'release build warnings should use ASCII-safe punctuation');
  assert(!electronMainSource.includes('Flight Fabric —'), 'Electron tooltips should use ASCII-safe punctuation');
});

test('OBS widgets load telemetry-ui before inline widget scripts run', () => {
  const widgetEntrypoints = [
    'frontend/widgets-compact/widget.html',
    'frontend/widgets-compact/widget-autopilot.html',
    'frontend/widgets-compact/widget-bottom.html',
    'frontend/widgets-compact/widget-environment.html',
    'frontend/widgets-compact/widget-history.html',
    'frontend/widgets-compact/widget-top.html',
  ];

  const offenders = widgetEntrypoints.filter((relativePath) => {
    const source = readRepoFile(relativePath);
    return /type=["']module["']\s+src=["']\.\.\/telemetry-ui\.js["']/.test(source)
      || !source.includes('<script src="../telemetry-ui.js"></script>');
  });

  assert.deepStrictEqual(
    offenders,
    [],
    'widget pages must load telemetry-ui.js as a classic blocking script before inline scripts use window.TelemetryUI',
  );
});

test('streaming widgets display live aircraft titles instead of profile names', () => {
  for (const relativePath of ['frontend/widgets-compact/widget.html', 'frontend/widgets-compact/widget-top.html']) {
    const source = readRepoFile(relativePath);
    assert(
      source.includes('profile.aircraftTitle || msg.displayName || profile.name ||'),
      `${relativePath} should prefer the simulator aircraft title before falling back to matched profile name`,
    );
    assert(
      !source.includes('profile.name || msg.displayName')
        && !source.includes('(msg.profile || {}).name || msg.displayName'),
      `${relativePath} should not render the matched profile name ahead of the live aircraft title`,
    );
  }
});

test('aircraft control runtime is store-first', () => {
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');
  const messageHandlersSource = readRepoFile('frontend/src/app/message-handlers.js');
  const autopilotPanelSource = readRepoFile('frontend/src/aircraft/autopilot-panel.js');
  const controlControllerSource = readRepoFile('frontend/src/aircraft/control-controller.js');

  assert(appRuntimeSource.includes("requireRuntimeStore(runtimeStores, 'aircraftControls')"), 'app runtime should resolve the aircraft controls store from the injected store bundle');
  assert(appRuntimeSource.includes('aircraftControlsStore,'), 'app runtime should inject the aircraft controls store into aircraft control runtimes');
  assert(!autopilotPanelSource.includes('runtime-bridge.js'), 'autopilot runtime should receive the aircraft controls store from app runtime');
  assert(!autopilotPanelSource.includes('getVueStore'), 'autopilot runtime should not pull the aircraft controls store from the Vue bridge');
  assert(!controlControllerSource.includes('runtime-bridge.js'), 'aircraft control controller should receive the aircraft controls store from app runtime');
  assert(!controlControllerSource.includes('getVueStore'), 'aircraft control controller should not pull the aircraft controls store from the Vue bridge');
  assert(autopilotPanelSource.includes('controlsStore.bindCommandAction('), 'autopilot runtime should bind commands into the aircraft-controls store');
  assert(!autopilotPanelSource.includes("addEventListener('click'"), 'autopilot runtime should not install legacy button click handlers');
  assert(!controlControllerSource.includes("classList.toggle('opacity-50'"), 'aircraft control availability should not toggle Vue-owned disabled styling classes');
  assert(!controlControllerSource.includes("classList.toggle('cursor-not-allowed'"), 'aircraft control availability should not toggle Vue-owned cursor styling classes');
  assert(!controlControllerSource.includes('setActionBusy'), 'aircraft control controller should not depend on legacy busy-button helpers');
  assert(!controlControllerSource.includes('clearActionBusy'), 'aircraft control controller should not depend on legacy busy-button helpers');
  assert(controlControllerSource.includes('function clearProfileToken()'), 'aircraft control controller should expose token-only invalidation');
  assert(messageHandlersSource.includes("aircraftControl.clearProfileToken?.('Simulator disconnected. Waiting for profile refresh.');"), 'sim disconnect should invalidate aircraft write tokens');
  assert(appRuntimeSource.includes("aircraftControl.clearProfileToken('Backend connection lost. Waiting for profile refresh.');"), 'backend socket close should invalidate aircraft write tokens');
});

test('aircraft control writes stay routed through the Rust sidecar bridge', () => {
  const controlServiceSource = readRepoFile('backend/aircraft/aircraft-control-service.ts');
  const simconnectProviderSource = readRepoFile('backend/telemetry-provider/simconnect-telemetry-provider.ts');
  const configSource = readRepoFile('backend/core/config.ts');
  const sidecarBridgeSource = readRepoFile('backend/telemetry-provider/lvar-sidecar-bridge.ts');
  const executeStart = simconnectProviderSource.indexOf('async executeAircraftControlAction(action');
  const executeEnd = simconnectProviderSource.indexOf('async start()', executeStart);
  const executeBlock = simconnectProviderSource.slice(executeStart, executeEnd);

  assert(executeStart >= 0, 'MSFS provider should expose executeAircraftControlAction');
  assert(executeEnd > executeStart, 'MSFS provider control execution block should be discoverable');
  assert(controlServiceSource.includes('SAFE_ACTION_NAME_RE'), 'control resolver should validate simulator action target tokens');
  assert(controlServiceSource.includes('MAX_ACTION_PARAMETERS'), 'control resolver should bound profile action parameters');
  assert(controlServiceSource.includes('pruneActionFields(action)'), 'control resolver should strip unexpected profile action fields');
  assert(simconnectProviderSource.includes('const bridge = await this._ensureControlWriteBridge();'), 'MSFS control writes should require the sidecar bridge');
  assert(simconnectProviderSource.includes('const ack = await bridge.sendEvent(eventName'), 'key-event writes should go through sidecar sendEvent');
  assert(simconnectProviderSource.includes('const ack = await bridge.setNamedVar({'), 'simvar/lvar writes should go through sidecar setNamedVar');
  assert(configSource.includes("facilitiesProbeEnable: bool('MSFS_FACILITIES_PROBE_ENABLE', false)"), 'MSFS Facilities diagnostic probe should default off');
  assert(simconnectProviderSource.includes('if (config.simconnect?.facilitiesProbeEnable === false) return;'), 'MSFS Facilities diagnostic probe should remain behind the config switch');
  assert(!executeBlock.includes('this._handle'), 'control execution should not use the legacy direct SimConnect handle');
  assert(sidecarBridgeSource.includes("type LaunchProvider = 'rust';"), 'the LVAR/control bridge should resolve only the Rust sidecar provider');
  assert(sidecarBridgeSource.includes("return this._sendWithAck({ type: 'sendEvent'"), 'sidecar sendEvent should be message-based');
  assert(sidecarBridgeSource.includes("type: 'setNamedVar'"), 'sidecar setNamedVar should be message-based');
  const sdkClientdataLaunchSource = readRepoFile('backend/telemetry-provider/sdk-adapters/rust-clientdata-launch.ts');
  assert(sdkClientdataLaunchSource.includes("args: ['--sdk-clientdata-bridge']"), 'SDK ClientData sidecars should use an explicit role flag instead of inherited environment presence');
});

test('Rust SimConnect sidecar keeps release-safe loader and input limits', () => {
  const rustSidecarSource = readRepoFile('backend/telemetry-provider/rust-simconnect-sidecar/src/main.rs');
  const rustControlsSource = readRepoFile('backend/telemetry-provider/rust-simconnect-sidecar/src/controls.rs');
  const rustProtocolSource = readRepoFile('backend/telemetry-provider/rust-simconnect-sidecar/src/protocol.rs');
  const rustLoaderSource = readRepoFile('backend/telemetry-provider/rust-simconnect-sidecar/src/dll_loader.rs');
  const rustFfiSource = readRepoFile('backend/telemetry-provider/rust-simconnect-sidecar/src/simconnect_ffi.rs');
  const rustOwnerLifelineSource = readRepoFile('backend/telemetry-provider/rust-simconnect-sidecar/src/owner_lifeline.rs');
  const rustSubscriptionsSource = readRepoFile('backend/telemetry-provider/rust-simconnect-sidecar/src/subscriptions.rs');
  const rustSidecarCargo = readRepoFile('backend/telemetry-provider/rust-simconnect-sidecar/Cargo.toml');
  assert(rustSidecarCargo.includes('unsafe_op_in_unsafe_fn = "deny"'), 'Rust sidecar should require explicit unsafe blocks inside unsafe functions');
  assert(rustSidecarSource.includes('mod controls;'), 'Rust sidecar control-write guards should live in a dedicated module');
  assert(rustSidecarSource.includes('mod protocol;'), 'Rust sidecar protocol parsing should live in a dedicated module');
  assert(rustSidecarSource.includes('mod dll_loader;'), 'Rust sidecar DLL loading should live in a dedicated module');
  assert(rustSidecarSource.includes('mod simconnect_ffi;'), 'Rust sidecar FFI declarations should live in a dedicated module');
  assert(rustSidecarSource.includes('mod subscriptions;'), 'Rust sidecar subscription preparation should live in a dedicated module');
  assert(rustSidecarSource.includes('mod owner_lifeline;'), 'Rust sidecars should retain a dedicated backend-owner death guard');
  assert(rustSidecarSource.includes('start_owner_lifeline(&args)'), 'Rust sidecars should establish their owner lifeline before entering the SimConnect loop');
  assert(rustOwnerLifelineSource.includes('OpenProcess(SYNCHRONIZE'), 'Rust sidecars should watch an exact Windows owner-process handle instead of polling a reusable PID');
  assert(rustOwnerLifelineSource.includes('std::process::exit(0)'), 'a sidecar should terminate even when its main thread is blocked after its backend dies');
  assert(rustProtocolSource.includes('const MAX_STDIN_LINE_BYTES'), 'Rust sidecar stdin lines should be byte-limited before JSON parsing');
  assert(rustSubscriptionsSource.includes('const MAX_COMMAND_SUBSCRIPTIONS'), 'Rust sidecar subscription batches should have an explicit cap');
  assert(rustSubscriptionsSource.includes('fn normalize_subscriptions('), 'Rust sidecar should normalize and validate subscription input before registering it');
  assert(rustControlsSource.includes('fn bounded_event_data('), 'Rust sidecar event writes should bound numeric payloads before SimConnect');
  assert(rustLoaderSource.includes('fn is_rust_sidecar_target_dir('), 'Rust sidecar should only use the fixed dev relative DLL path from Cargo target dirs');
  assert(rustFfiSource.includes('fn callback_has_size<'), 'Rust sidecar callbacks should validate buffer size before raw pointer casts');
  assert(rustFfiSource.includes('SimConnectClearClientDataDefinition'), 'Rust sidecar FFI should declare the dedicated ClientData definition cleanup API');
  assert(rustLoaderSource.includes('SimConnect_ClearClientDataDefinition\\0'), 'Rust sidecar loader should bind the dedicated ClientData definition cleanup API');
  assert(rustSidecarSource.includes('clear_sdk_client_data_definition'), 'Rust SDK reconnects should clear their ClientData definitions before re-registering');
  assert(rustSidecarSource.includes('sdk_subscription_is_current('), 'Rust SDK same-target connects should be idempotent');
  assert(!rustSidecarSource.includes('hresult_is_benign_duplicate'), 'Rust SDK registration must not treat arbitrary failed HRESULTs as benign duplicates');
  assert(rustFfiSource.includes('fn hresult_succeeded(') && rustFfiSource.includes('hr >= 0'), 'Rust SimConnect HRESULT checks should use the canonical Windows SUCCEEDED sign test');
  assert(rustLoaderSource.includes('if !hresult_succeeded(hr)'), 'Rust SimConnect_Open probing should accept every successful HRESULT');
  assert(rustSidecarSource.includes('mapped_name.eq_ignore_ascii_case(data_name)'), 'Rust ClientData mapping cache should follow SimConnect case-insensitive name semantics');
  const sdkDisconnectStart = rustSidecarSource.indexOf('fn disconnect_sdk_checked(');
  const sdkDisconnectEnd = rustSidecarSource.indexOf('fn map_event(', sdkDisconnectStart);
  const sdkDisconnectSource = rustSidecarSource.slice(sdkDisconnectStart, sdkDisconnectEnd);
  const sdkStopFailureGuard = sdkDisconnectSource.indexOf('if !hresult_ok(stop_hr)');
  const sdkDefinitionCleanup = sdkDisconnectSource.indexOf('self.clear_sdk_client_data_definition()?');
  assert(
    sdkStopFailureGuard >= 0
      && sdkDefinitionCleanup > sdkStopFailureGuard
      && sdkDisconnectSource.slice(sdkStopFailureGuard, sdkDefinitionCleanup).includes('return Err('),
    'Rust SDK cleanup must preserve a still-active request and definition when PERIOD_NEVER fails',
  );
  assert(
    rustSidecarSource.includes('Some(&format!("sdk_disconnect_failed:{error}"))'),
    'an explicit SDK disconnect cleanup failure must be reported instead of claiming disconnection',
  );
  assert(rustSubscriptionsSource.includes('fn definition_payload_size('), 'Rust sidecar variable payload reads should be length-checked');
  assert(rustSidecarSource.includes('impl Drop for SimSession'), 'Rust sidecar sessions should close via RAII cleanup');
  assert(!rustSidecarSource.includes('_cb_data'), 'Rust sidecar should not ignore SimConnect callback buffer sizes');
  assert(!rustSidecarSource.includes('struct Command {'), 'Rust sidecar main should not own protocol message structs');
  assert(!rustSidecarSource.includes('struct Subscription {'), 'Rust sidecar main should not own subscription protocol structs');
  assert(!rustSidecarSource.includes('struct SimConnectApi {'), 'Rust sidecar main should not own DLL loader bindings');
  assert(!rustSidecarSource.includes('fn push_candidate('), 'Rust sidecar main should not own DLL candidate discovery');
  assert(!rustSidecarSource.includes('fn normalize_subscriptions('), 'Rust sidecar main should not own subscription validation');
  assert(!rustSidecarSource.includes('fn bounded_event_data('), 'Rust sidecar main should not own control payload numeric guards');
  assert(!rustSidecarSource.includes('struct PreparedSubscription {'), 'Rust sidecar main should not own subscription preparation structs');
  assert(!rustLoaderSource.includes('Candidate::System'), 'Rust sidecar should not use bare SimConnect.dll search-order loading');
  const dllCandidatesStart = rustLoaderSource.indexOf('fn simconnect_candidates()');
  const dllCandidatesEnd = rustLoaderSource.indexOf('\nfn is_rust_sidecar_target_dir(', dllCandidatesStart);
  assert(dllCandidatesStart >= 0 && dllCandidatesEnd > dllCandidatesStart, 'Rust sidecar DLL candidate discovery should remain directly auditable');
  const dllCandidatesSource = rustLoaderSource.slice(dllCandidatesStart, dllCandidatesEnd);
  assert(!dllCandidatesSource.includes('env::current_dir()'), 'Rust sidecar should not probe the process current directory for DLLs');
  assert(!rustLoaderSource.includes('fn possible_roots()'), 'Rust sidecar should not walk broad ancestor roots for DLL discovery');

});

test('frontend settings page consumes the shared settings module', () => {
  const settingsShellSource = readRepoFile('frontend/src/vue/components/SettingsTabShell.vue');
  const runtimeSource = readRepoFile('frontend/src/settings/runtime.js');
  const sharedGlobalsSource = readRepoFile('frontend/src/app/shared-globals.js');
  const sharedRuntimeSource = readRepoFile('frontend/src/settings/shared-runtime.js');
  const settingsPanelsSource = readRepoFile('frontend/src/vue/components/SettingsFormPanels.vue');
  const editorStoreSource = readRepoFile('frontend/src/vue/stores/settings-editor.js');
  assert(settingsShellSource.includes("from '../../settings/shared-runtime.js';"));
  assert(settingsShellSource.includes('getFlightFabricAppSettings()'));
  assert(settingsShellSource.includes('const tabs = useTabsStore();'), 'SettingsTabShell should own the tabs store for the settings runtime');
  assert(settingsShellSource.includes('tabsStore: tabs'), 'SettingsTabShell should pass the tabs store into the settings runtime');
  assert(settingsShellSource.includes('getAppSettings'));
  assert(settingsShellSource.includes('settingsRuntime?.cleanup?.();'), 'SettingsTabShell should clean up the settings runtime');
  assert(runtimeSource.includes('normalizeAppSettings('));
  assert(sharedGlobalsSource.includes('export function getFlightPhases('), 'shared globals helper should centralize phase lookup');
  assert(sharedGlobalsSource.includes('export function getPublishedFlightPhases('), 'shared globals helper should centralize published phase lookup');
  assert(sharedRuntimeSource.includes('export function getFlightFabricAppSettings()'), 'settings shared-runtime helper should centralize app-settings global access');
  assert(sharedRuntimeSource.includes("from '../app/shared-globals.js';"), 'settings shared-runtime helper should reuse the shared globals bridge');
  assert(editorStoreSource.includes("from '../../settings/shared-runtime.js';"), 'settings editor store should read shared globals through the shared-runtime helper');
  assert(runtimeSource.includes('registerBeforeChangeGuard'), 'settings runtime should use the tabs store leave-guard API');
  assert(runtimeSource.includes("() => tabsStore.activeTabId"), 'settings runtime should watch the tabs store for activation');
  assert(editorStoreSource.includes('sanitizeCabinAnnouncementStyle('));
  assert(editorStoreSource.includes('sanitizeClampedInt('));
  assert(!editorStoreSource.includes('window.FlightFabricAppSettings'), 'settings editor store should not read app settings globals directly');
  assert(!editorStoreSource.includes('window.FlightPhases'), 'settings editor store should not read phase globals directly');
  assert(!settingsPanelsSource.includes('window.FlightPhases'), 'settings panels should not read phase globals directly');
  assert(!runtimeSource.includes('function sanitizeStyle('));
  assert(!editorStoreSource.includes('function sanitizeStyle('));
});

test('tab navigation flows through the Vue tabs store', () => {
  const desktopTabsSource = readRepoFile('frontend/src/vue/components/DesktopTabs.vue');
  const mobileTabsSource = readRepoFile('frontend/src/vue/components/MobileTabs.vue');
  const mainShellSource = readRepoFile('frontend/src/vue/components/MainContentShell.vue');
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const tabsStoreSource = readRepoFile('frontend/src/vue/stores/tabs.js');
  const tabsRuntimeSource = readRepoFile('frontend/src/tabs/runtime.js');
  const tabConfigSource = readRepoFile('frontend/src/vue/tab-config.js');

  assert(desktopTabsSource.includes('@click="tabs.requestTabChange(tab.id)"'));
  assert(mobileTabsSource.includes('@click="tabs.requestTabChange(tab.id)"'));
  assert(mainShellSource.includes(':class="tabs.tabSectionClass('), 'tab panels should derive active classes from the tabs store');
  assert(appShellSource.includes('tabs.pullRefreshLabel'), 'pull-to-refresh copy should render from the tabs store');
  assert(tabsStoreSource.includes('function requestTabChange(tabId, options = {})'));
  assert(tabsStoreSource.includes('function registerBeforeChangeGuard(guard)'));
  assert(tabsStoreSource.includes('function tabSectionClass(tabId)'));
  assert(tabsStoreSource.includes('function showPullRefreshPrompt('));
  assert(tabConfigSource.includes("export const DEFAULT_TAB_ID = 'flight'"), 'Overview should be the centralized safe default tab');
  assert(tabsStoreSource.includes('ref(DEFAULT_TAB_ID)'), 'tabs store should render Overview before the browser runtime mounts');
  assert(tabsRuntimeSource.includes('LAST_ACTIVE_TAB_STORAGE_KEY'), 'tabs runtime should persist the last selected primary workspace');
  assert(tabsRuntimeSource.includes('readStorageValue(') && tabsRuntimeSource.includes('writeStorageValue('), 'tab persistence should use guarded browser storage helpers');
  assert(tabsRuntimeSource.includes('TAB_ORDER.includes(tabId)'), 'contextual tabs should not become sticky startup destinations');
  assert(tabsRuntimeSource.includes('resolvedTabsStore.requestTabChange(tabId, { direction })'));
  assert(appShellSource.includes('initTabsRuntime({'), 'AppShell should own tab runtime lifecycle');
  assert(appShellSource.includes('tabsStore: tabs'), 'AppShell should inject the tabs store into the tabs runtime');
  assert(!tabsRuntimeSource.includes('runtime-bridge.js'), 'tabs runtime should receive its store from AppShell instead of using the runtime bridge');
  assert(!tabsRuntimeSource.includes('getVueStore'), 'tabs runtime should not pull the tabs store from the Vue bridge');
  assert(!tabsRuntimeSource.includes('requireVueStore'), 'tabs runtime should not pull the tabs store from the Vue bridge');
  assert(!tabsRuntimeSource.includes("classList.toggle('active'"), 'tabs runtime should not manually toggle active tab sections');
  assert(!tabsRuntimeSource.includes('ptrEl.textContent'), 'tabs runtime should not mutate pull-to-refresh text directly');
  assert(!tabsRuntimeSource.includes('before-tab-changed'), 'tabs runtime should not emit the legacy before-tab-changed event');
  assert(!tabsRuntimeSource.includes("dispatchEvent(new CustomEvent('tab-changed'"), 'tabs runtime should not emit the dead tab-changed event');
  assert(tabsRuntimeSource.includes('TOUCH_NAVIGATION_EXCLUSION_SELECTOR'), 'touch navigation should centralize its interactive-control exclusions');
  assert(tabsRuntimeSource.includes("'[role=\"slider\"]'"), 'touch navigation should not steal horizontal slider gestures');
  assert(tabsRuntimeSource.includes('tabScrollPositions.set(previousTabId'), 'tab navigation should remember each tab scroll position');
  assert(tabsRuntimeSource.includes('tabScrollPositions.get(tabId)'), 'tab navigation should restore the destination tab scroll position');
});

test('responsive browser shell accounts for dynamic viewports and device safe areas', () => {
  const html = readRepoFile('frontend/index.html');
  const indexCssSource = readRepoFile('frontend/index.css');
  const mobileTabsSource = readRepoFile('frontend/src/vue/components/MobileTabs.vue');

  assert(html.includes('viewport-fit=cover'), 'mobile viewport should expose notch and home-indicator safe areas to CSS');
  assert(html.includes('interactive-widget=resizes-content'), 'mobile keyboard should resize the app viewport instead of covering form controls');
  assert(indexCssSource.includes('height: 100dvh;'), 'browser shell should follow the visible dynamic viewport height');
  assert(indexCssSource.includes('overscroll-behavior: none;'), 'browser shell should prevent page-level rubber-band scrolling');
  assert(indexCssSource.includes('env(safe-area-inset-left'), 'responsive shell should protect content from the left device cutout');
  assert(indexCssSource.includes('env(safe-area-inset-right'), 'responsive shell should protect content from the right device cutout');
  assert(indexCssSource.includes('(max-height: 500px) and (pointer: coarse)'), 'short coarse-pointer viewports should use the mobile navigation in landscape');
  assert(!mobileTabsSource.includes('sm:hidden'), 'the mobile More sheet should not disappear at Tailwind\'s narrower 640px breakpoint');
});

test('dark-only theme keeps DOM mutation in a runtime helper instead of the store', () => {
  const themeStoreSource = readRepoFile('frontend/src/vue/stores/theme.js');
  const themeRuntimeSource = readRepoFile('frontend/src/theme/runtime.js');
  const vueMainSource = readRepoFile('frontend/src/vue/main.js');
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const indexCssSource = readRepoFile('frontend/index.css');
  const themeDefinitionSource = readRepoFile('frontend/src/theme/definition.js');

  assert(themeStoreSource.includes('function bindRuntime('), 'theme store should expose explicit runtime bindings');
  assert(themeStoreSource.includes('const runtimeBound = ref(false);'), 'theme store should expose whether runtime theme actions are bound');
  assert(!themeStoreSource.includes('document.documentElement'), 'theme store should not mutate document root directly');
  assert(!themeStoreSource.includes("getElementById('theme-stylesheet')"), 'theme store should not query DOM theme nodes directly');
  assert(themeRuntimeSource.includes('export function createThemeRuntime('), 'theme runtime helper should own DOM theme application');
  assert(themeRuntimeSource.includes("root.classList.toggle('dark', config.mode === 'dark')"), 'theme runtime helper should own the document mode class');
  assert(themeRuntimeSource.includes("documentRef?.querySelector?.('meta[name=\"theme-color\"]')"), 'theme runtime helper should update the theme-color metadata');
  assert(!themeRuntimeSource.includes("getElementById?.('theme-stylesheet')"), 'theme runtime helper should no longer swap external theme stylesheets');
  assert(vueMainSource.includes('createThemeRuntime'), 'Vue bootstrap should initialize the theme runtime helper');
  assert(vueMainSource.includes('theme.bindRuntime({'), 'Vue bootstrap should bind theme runtime actions into the store');
  assert(vueMainSource.includes('theme.initialize();'), 'Vue bootstrap should initialize the theme store after binding the theme runtime');
  assert(themeDefinitionSource.includes("light: 'dark'"), 'legacy light theme names should normalize back to the dark theme');
  assert(!appHeaderSource.includes('ThemeSwitcher'), 'app header should not render the removed theme switcher');
  assert(!indexCssSource.includes('.theme-switcher'), 'theme switcher CSS should be removed with the UI');
});

test('browser environment helper centralizes store-level storage and media-query access', () => {
  const browserEnvironmentSource = readRepoFile('frontend/src/app/browser-environment.js');
  const simbriefStoreSource = readRepoFile('frontend/src/vue/stores/simbrief.js');
  const profilesStoreSource = readRepoFile('frontend/src/vue/stores/profiles.js');
  const themeDefinitionSource = readRepoFile('frontend/src/theme/definition.js');
  const themeStoreSource = readRepoFile('frontend/src/vue/stores/theme.js');
  const timelineStoreSource = readRepoFile('frontend/src/vue/stores/timeline.js');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');

  assert(browserEnvironmentSource.includes('export function readStorageValue('), 'browser environment helper should expose storage reads');
  assert(browserEnvironmentSource.includes('export function readStorageJson('), 'browser environment helper should expose JSON storage reads');
  assert(browserEnvironmentSource.includes('export function writeStorageValue('), 'browser environment helper should expose storage writes');
  assert(browserEnvironmentSource.includes('export function writeStorageJson('), 'browser environment helper should expose JSON storage writes');
  assert(browserEnvironmentSource.includes('export function matchesMedia('), 'browser environment helper should expose media-query checks');

  for (const source of [
    simbriefStoreSource,
    themeDefinitionSource,
    timelineStoreSource,
    statusStoreSource,
  ]) {
    assert(
      source.includes("from '../../app/browser-environment.js';")
      || source.includes("from '../app/browser-environment.js';"),
      'browser-facing Vue stores should reuse the shared browser environment helper',
    );
  }

  assert(!simbriefStoreSource.includes('localStorage.setItem('), 'SimBrief store should not write to localStorage directly');
  assert(!simbriefStoreSource.includes('localStorage.getItem('), 'SimBrief store should not read localStorage directly');
  assert(!profilesStoreSource.includes('localStorage.setItem('), 'profiles store should not write to localStorage directly');
  assert(!profilesStoreSource.includes('localStorage.getItem('), 'profiles store should not read localStorage directly');
  assert(!profilesStoreSource.includes('browser-environment.js'), 'profiles store should not retain browser storage after the Profiles page is retired');
  assert(!themeStoreSource.includes('localStorage.setItem('), 'theme store should not write to localStorage directly');
  assert(!themeStoreSource.includes('localStorage.getItem('), 'theme store should not read localStorage directly');
  assert(!timelineStoreSource.includes('globalThis.localStorage'), 'timeline store should not reach into global storage directly');
  assert(!timelineStoreSource.includes('window.matchMedia'), 'timeline store should not query media state directly');
  assert(!statusStoreSource.includes("typeof localStorage !== 'undefined'"), 'status store should not probe localStorage directly');
});

test('Vue overlays and widgets share the document-event composable for browser listeners', () => {
  const composableSource = readRepoFile('frontend/src/vue/composables/useDocumentEvent.js');
  const timelineMapControlsSource = readRepoFile('frontend/src/vue/components/TimelineMapControls.vue');
  const dataSourcesModalSource = readRepoFile('frontend/src/vue/components/DataSourcesModal.vue');
  const landingMetricModalSource = readRepoFile('frontend/src/vue/components/LandingMetricModal.vue');
  const msfsInstallsModalSource = readRepoFile('frontend/src/vue/components/MsfsInstallsModal.vue');
  const mobileTabsSource = readRepoFile('frontend/src/vue/components/MobileTabs.vue');

  assert(composableSource.includes("document.addEventListener(type, handler, options);"), 'document-event composable should own document listener registration');
  assert(composableSource.includes("document.removeEventListener(type, handler, options);"), 'document-event composable should own document listener cleanup');

  for (const source of [
    timelineMapControlsSource,
    dataSourcesModalSource,
    landingMetricModalSource,
    msfsInstallsModalSource,
    mobileTabsSource,
  ]) {
    assert(source.includes("from '../composables/useDocumentEvent.js';"), 'Vue listener-heavy components should reuse the document-event composable');
    assert(!source.includes('document.addEventListener('), 'listener-heavy Vue components should not register document listeners directly');
    assert(!source.includes('document.removeEventListener('), 'listener-heavy Vue components should not clean up document listeners directly');
  }
});

test('Vue shell chrome shares body-sync composables for document.body side effects', () => {
  const bodyClassComposableSource = readRepoFile('frontend/src/vue/composables/useBodyClass.js');
  const bodyStyleComposableSource = readRepoFile('frontend/src/vue/composables/useBodyStyle.js');
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const debugModalSource = readRepoFile('frontend/src/vue/components/DebugTelemetryModal.vue');
  const systemBannersSource = readRepoFile('frontend/src/vue/components/SystemBanners.vue');

  assert(bodyClassComposableSource.includes("document.body.classList.toggle(className, enabled === true);"), 'body-class composable should own body class mutation');
  assert(bodyStyleComposableSource.includes("document.body.style[propertyName] = value;"), 'body-style composable should own body style mutation');

  assert(appShellSource.includes("from '../composables/useBodyClass.js';"), 'AppShell should reuse the body-class composable');
  assert(appShellSource.includes("useBodyClass(() => status.simInMenu, 'sim-in-menu');"), 'AppShell should bind sim-menu body state through the composable');
  assert(appShellSource.includes("useBodyClass(() => status.quickGlanceVisible, 'quick-glance-active');"), 'AppShell should bind quick-glance body state through the composable');
  assert(!appShellSource.includes('document.body.classList.toggle('), 'AppShell should not mutate body classes directly');

  assert(debugModalSource.includes("from '../composables/useBodyClass.js';"), 'DebugTelemetryModal should reuse the body-class composable');
  assert(debugModalSource.includes("useBodyClass(() => debug.modalOpen, 'debug-modal-open');"), 'DebugTelemetryModal should bind body state through the composable');
  assert(!debugModalSource.includes('document.body.classList.toggle('), 'DebugTelemetryModal should not mutate body classes directly');

  const legacyCssSource = readRepoFile('frontend/styles/legacy.css');
  assert(legacyCssSource.includes('body.debug-modal-open > *:not(#vue-app-root):not(#debug-modal)'), 'debug modal open isolation must not hide the Vue root that contains the migrated modal');
  assert(!legacyCssSource.includes('body.debug-modal-open > *:not(#debug-modal) {'), 'legacy debug modal isolation must not assume #debug-modal is a body child');

  assert(systemBannersSource.includes("from '../composables/useBodyStyle.js';"), 'SystemBanners should reuse the body-style composable');
  assert(systemBannersSource.includes("() => status.systemBannerOffsetPx"), 'SystemBanners should bind the computed banner body offset through the composable');
  assert(!systemBannersSource.includes('document.body.style.paddingTop'), 'SystemBanners should not mutate body padding directly');
});

test('app shell services are registered explicitly and tab runtimes watch the tabs store', () => {
  const sharedSource = readRepoFile('frontend/app-shared.js');
  const appBootstrapSource = readRepoFile('frontend/src/app/bootstrap.js');
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');
  const appPreferencesSource = readRepoFile('frontend/src/app/preferences.js');
  const vueMainSource = readRepoFile('frontend/src/vue/main.js');
  const liveMapRuntimeSource = readRepoFile('frontend/src/live-map/runtime.js');
  const liveMapShellSource = readRepoFile('frontend/src/vue/components/LiveMapTabShell.vue');
  const timelineRuntimeSource = readRepoFile('frontend/src/timeline/runtime.js');
  const profilesRuntimeSource = readRepoFile('frontend/src/profiles/runtime.js');
  const profileSelectorSource = readRepoFile('frontend/src/vue/components/AircraftProfileSelector.vue');
  const logbookRuntimeSource = readRepoFile('frontend/src/logbook/runtime.js');
  const logbookPanelSource = readRepoFile('frontend/src/vue/components/LogbookPanel.vue');
  const settingsRuntimeSource = readRepoFile('frontend/src/settings/runtime.js');
  const settingsShellSource = readRepoFile('frontend/src/vue/components/SettingsTabShell.vue');
  const mockLandingSource = readRepoFile('frontend/src/landing/mock-runtime.js');
  const landingPanelSource = readRepoFile('frontend/src/vue/components/LandingPanel.vue');

  assert(sharedSource.includes('function syncCompatibilityShared()'));
  assert(sharedSource.includes('delete appShared[key]'), 'shared service cleanup should clear compatibility mirrors');
  assert(sharedSource.includes('export function setAppServices('));
  assert(sharedSource.includes('export function getWsUrl()'));
  assert(sharedSource.includes('export function getBackendHttpBase()'));
  assert(sharedSource.includes('export function getAuthorizationScope()'));
  assert(sharedSource.includes('export function getCoordValidator()'));
  assert(sharedSource.includes('export function getHandleMessage()'));
  assert(sharedSource.includes('export function getTimelineLandingHandler()'));
  assert(sharedSource.includes('export function getCabinAnnouncements()'));
  assert(sharedSource.includes('export function getReconnect()'));
  assert(!sharedSource.includes('windowRef._wsSend'));
  assert(!/windowRef\.__flightFabricApp\s*=(?!=)/.test(sharedSource));
  assert(vueMainSource.includes('export const vueRuntimeContext = {'), 'Vue bootstrap should export an explicit runtime context');
  assert(vueMainSource.includes('stores: {'), 'Vue runtime context should expose the Pinia store bundle');
  assert(!vueMainSource.includes('runtime-bridge.js'), 'Vue bootstrap should not register stores through the runtime bridge');
  assert(appBootstrapSource.includes("import { vueRuntimeContext } from '../vue/main.js';"), 'dashboard bootstrap should import the Vue runtime context');
  assert(appBootstrapSource.includes('stores: vueRuntimeContext.stores'), 'dashboard bootstrap should pass the Vue store bundle into app runtime');
  assert(appRuntimeSource.includes('setAppServices({'));
  assert(appRuntimeSource.includes('function requireRuntimeStore(stores, storeName)'), 'app runtime should validate injected stores explicitly');
  assert(!appRuntimeSource.includes('runtime-bridge.js'), 'app runtime should receive stores from bootstrap instead of the runtime bridge');
  assert(!appRuntimeSource.includes('getVueStore'), 'app runtime should not pull stores through the Vue bridge');
  assert(!appRuntimeSource.includes('waitForVueBridge'), 'app runtime should not wait on the retired Vue bridge');
  assert(appRuntimeSource.includes('getWsUrl: connection.getWsUrl'));
  assert(appRuntimeSource.includes('getBackendHttpBase: connection.getBackendHttpBase'));
  assert(appRuntimeSource.includes('getAuthorizationScope: connection.getAuthorizationScope'));
  assert(!appRuntimeSource.includes('window.__flightFabricApp ='));
  assert(!appRuntimeSource.includes('window.__flightFabricApp || {}'));
  assert(appRuntimeSource.includes("requireRuntimeStore(runtimeStores, 'preferences')"), 'app runtime should resolve the preferences store from the injected store bundle');
  assert(appRuntimeSource.includes('preferencesStore,'), 'app runtime should inject the preferences store into preferences runtime');
  assert(appRuntimeSource.includes('flightStore,'), 'app runtime should inject the flight store into preferences runtime');
  assert(!appPreferencesSource.includes('runtime-bridge.js'), 'app preferences runtime should receive stores from app runtime');
  assert(!appPreferencesSource.includes('getVueStore'), 'app preferences runtime should not pull stores from the Vue bridge');
  assert(appPreferencesSource.includes('getWsSend = () => null'));
  assert(!appPreferencesSource.includes('app-shared.js'));
  assert(!appPreferencesSource.includes('windowRef._wsSend'));
  assert(liveMapShellSource.includes('initLiveMapRuntime({'), 'LiveMapTabShell should own live-map runtime initialization');
  assert(liveMapShellSource.includes('cleanupLiveMapRuntime?.();'), 'LiveMapTabShell should clean up the live-map runtime');
  assert(liveMapShellSource.includes('liveMapStore: liveMap'), 'LiveMapTabShell should inject the live-map store into the runtime');
  assert(liveMapShellSource.includes('tabsStore: tabs'), 'LiveMapTabShell should inject the tabs store into the runtime');
  assert(liveMapShellSource.includes('statusStore: status'), 'LiveMapTabShell should inject the status store into the runtime');
  assert(liveMapRuntimeSource.includes("() => tabsStore.activeTabId"));
  assert(!liveMapRuntimeSource.includes('runtime-bridge.js'), 'live-map runtime should not reach through the Vue runtime bridge after component ownership');
  assert(logbookPanelSource.includes('initLogbookRuntime({'), 'LogbookPanel should own logbook runtime initialization');
  assert(logbookPanelSource.includes('cleanupLogbookRuntime?.();'), 'LogbookPanel should clean up the logbook runtime');
  assert(logbookPanelSource.includes('logbookStore: logbook'), 'LogbookPanel should inject the logbook store into the runtime');
  assert(logbookPanelSource.includes('tabsStore: tabs'), 'LogbookPanel should inject the tabs store into the runtime');
  assert(logbookPanelSource.includes('statusStore: status'), 'LogbookPanel should inject the status store into the runtime');
  assert(logbookRuntimeSource.includes("() => tabsStore.activeTabId"));
  assert(!logbookRuntimeSource.includes('runtime-bridge.js'), 'logbook runtime should not reach through the Vue runtime bridge after component ownership');
  assert(profileSelectorSource.includes('initProfilesRuntime({'), 'AircraftProfileSelector should own profiles runtime initialization');
  assert(profileSelectorSource.includes('cleanupProfilesRuntime?.();'), 'AircraftProfileSelector should clean up the profiles runtime');
  assert(profileSelectorSource.includes('profilesStore: profiles'), 'AircraftProfileSelector should inject the profiles store into the runtime');
  assert(!profilesRuntimeSource.includes('tabsStore'), 'profiles runtime should no longer depend on a retired Profiles tab');
  assert(!profilesRuntimeSource.includes('runtime-bridge.js'), 'profiles runtime should not reach through the Vue runtime bridge after component ownership');
  assert(settingsShellSource.includes('initSettingsRuntime({'), 'SettingsTabShell should own settings runtime initialization');
  assert(settingsShellSource.includes('settingsRuntime?.cleanup?.();'), 'SettingsTabShell should clean up the settings runtime');
  assert(settingsShellSource.includes('settingsEditorStore: settingsEditor'), 'SettingsTabShell should inject the settings editor store into the runtime');
  assert(settingsShellSource.includes('settingsFormStore: settingsForm'), 'SettingsTabShell should inject the settings form store into the runtime');
  assert(settingsShellSource.includes('settingsUiStore: settingsUi'), 'SettingsTabShell should inject the settings UI store into the runtime');
  assert(settingsShellSource.includes('tabsStore: tabs'), 'SettingsTabShell should inject the tabs store into the runtime');
  assert(settingsRuntimeSource.includes("() => tabsStore.activeTabId"));
  assert(timelineRuntimeSource.includes("() => tabsStore.activeTabId"));
  assert(mockLandingSource.includes('initMockLandingRuntime'));
  assert(mockLandingSource.includes('typeof getHandleMessage === \'function\''));
  assert(mockLandingSource.includes('cleanup()'));
  assert(mockLandingSource.includes("removeEventListener('click', handleDemoLandingClick)"));
  assert(!landingPanelSource.includes('initMockLandingRuntime'), 'LandingPanel should not ship mock landing runtime initialization');
  assert(!landingPanelSource.includes('getHandleMessage'), 'LandingPanel should not import shared message handler lookup for mock scenarios');
  assert(!landingPanelSource.includes('mockLandingRuntime'), 'LandingPanel should not retain mock landing runtime state');
  assert(!appBootstrapSource.includes('initMockLandingRuntime'), 'dashboard bootstrap should not own mock landing runtime initialization');
  assert(!mockLandingSource.includes("import { getHandleMessage } from '../../app-shared.js';"));
  assert(appShellSource.includes('initCabinAnnouncementsRuntime({'), 'AppShell should own cabin announcement runtime initialization');
  assert(appShellSource.includes('statusStore: status'), 'AppShell should inject the status store into cabin announcements runtime');
  assert(appShellSource.includes("setAppService('cabinAnnouncements', cabinAnnouncementsRuntime);"), 'AppShell should register the cabin announcements app service');
  assert(appShellSource.includes("setAppService('cabinAnnouncements', null);"), 'AppShell should clear the cabin announcements app service on unmount');
  assert(appShellSource.includes('cabinAnnouncementsRuntime?.cleanup?.();'), 'AppShell should clean up the cabin announcements runtime');
  assert(!appBootstrapSource.includes('initCabinAnnouncementsRuntime'), 'dashboard bootstrap should not own cabin announcements runtime initialization');
  assert(!appBootstrapSource.includes("setAppService('cabinAnnouncements'"), 'dashboard bootstrap should not register cabin announcements services');
  assert(!appRuntimeSource.includes('__flightFabricVue'));
  assert(!appPreferencesSource.includes('__flightFabricVue'));
  assert(!profilesRuntimeSource.includes('__flightFabricVue'));
  assert(!logbookRuntimeSource.includes('__flightFabricVue'));
  assert(!liveMapRuntimeSource.includes('__flightFabricVue'));
  assert(!vueMainSource.includes('__flightFabricVue'));
  assert(!profilesRuntimeSource.includes("window.addEventListener('tab-changed'"));
  assert(!logbookRuntimeSource.includes("window.addEventListener('tab-changed'"));
  assert(!timelineRuntimeSource.includes("windowRef.addEventListener('tab-changed'"));
  assert(!liveMapRuntimeSource.includes("window.addEventListener('tab-changed'"));
});

test('timeline and live-map helpers are now store-first', () => {
  const liveMapControllerSource = readRepoFile('frontend/src/live-map/map-controller.js');
  const timelineMapControllerSource = readRepoFile('frontend/src/timeline/map-controller.js');
  const timelinePageControllerSource = readRepoFile('frontend/src/timeline/page-controller.js');
  const timelineScrubberSource = readRepoFile('frontend/src/timeline/scrubber.js');
  const timelinePfdSource = readRepoFile('frontend/src/timeline/pfd.js');
  const timelinePfdOverlaySource = readRepoFile('frontend/src/timeline/pfd-overlay.js');

  assert(!liveMapControllerSource.includes('emptyEl'), 'live-map controller should not keep the legacy empty-state DOM fallback');
  assert(liveMapControllerSource.includes('liveMapStore.setMapEmptyState(state);'), 'live-map controller should publish empty-state changes through the store');
  assert(!timelineMapControllerSource.includes('mapEmptyEl'), 'timeline map controller should not keep the legacy map-empty DOM fallback');
  assert(!timelinePageControllerSource.includes('mapEmptyEl'), 'timeline page controller should not keep the legacy map-empty DOM fallback');
  assert(!timelineScrubberSource.includes('if (!timelineStore'), 'timeline scrubber should not fork between store and DOM ownership');
  assert(!timelinePfdSource.includes('if (!timelineStore'), 'timeline PFD should not fork between store and DOM readout ownership');
  assert(!timelinePfdOverlaySource.includes('if (!timelineStore'), 'timeline PFD overlay fitter should not fork between store and DOM ownership');
});

test('sim menu and quick-glance visibility are Vue state driven', () => {
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const displayDefaultsSource = readRepoFile('frontend/src/telemetry/display-defaults.js');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');
  const messageHandlersSource = readRepoFile('frontend/src/app/message-handlers.js');
  const debugModalSource = readRepoFile('frontend/src/vue/components/DebugTelemetryModal.vue');
  const indexCssSource = normalizeTextForMirrorCompare(readRepoFile('frontend/index.css'));

  assert(statusStoreSource.includes('quickGlanceVisible'), 'status store should own quick-glance visibility');
  assert(appShellSource.includes('status.quickGlanceVisible'), 'AppShell should render quick-glance visibility from the status store');
  assert(debugModalSource.includes('status.simInMenu'), 'DebugTelemetryModal should render its sim menu badge from the status store');
  assert(appShellSource.includes("useBodyClass(() => status.simInMenu, 'sim-in-menu');"), 'AppShell should mirror sim menu state onto the body for CSS compatibility');
  assert(appShellSource.includes("useBodyClass(() => status.quickGlanceVisible, 'quick-glance-active');"), 'AppShell should mirror quick-glance state onto the body for CSS compatibility');
  assert(indexCssSource.includes('.menu-overlay {\n  display: none;'), 'active app CSS should hide sim-menu overlays by default');
  assert(indexCssSource.includes('body.sim-in-menu .menu-overlay {\n  display: flex;'), 'active app CSS should show sim-menu overlays only from the Vue-owned body class');
  assert(!messageHandlersSource.includes("classList.toggle('sim-in-menu'"), 'message handlers should not mutate sim menu body state');
  assert(!messageHandlersSource.includes("classList.toggle('quick-glance-active'"), 'message handlers should not mutate quick-glance body state');
  assert(!messageHandlersSource.includes("classList.toggle('show', showQuickGlance"), 'message handlers should not toggle quick-glance visibility directly');
  assert(!messageHandlersSource.includes('debug-menu-indicator'), 'message handlers should not toggle the debug menu indicator directly');
  assert(!appRuntimeSource.includes("document.body.classList.contains('sim-in-menu'"), 'app runtime should read sim menu state from the Vue store');
  assert(!appRuntimeSource.includes("document.body.classList.remove('quick-glance-active'"), 'app runtime should not manually reset quick-glance body state');
  assert(!displayDefaultsSource.includes("'phase-badge'"), 'generic text reset should not mutate Vue-owned phase badge');
  assert(!displayDefaultsSource.includes("'phase-badge-mobile'"), 'generic text reset should not mutate Vue-owned mobile phase badge');
  assert(!displayDefaultsSource.includes("'menu-state-top'"), 'generic text reset should not mutate Vue-owned header sim badge');
  assert(!displayDefaultsSource.includes("'menu-state-bottom'"), 'generic text reset should not mutate Vue-owned footer sim badge');
});

test('VRE sampling indicator is Vue state driven', () => {
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const statusIndicatorsSource = readRepoFile('frontend/src/ui/status-indicators.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(statusStoreSource.includes('vreSampling: getDefaultVreSampling()'), 'status store should own VRE sampling state');
  assert(statusStoreSource.includes('updateVreSampling(message)'), 'status store should expose a VRE sampling update action');
  assert(appHeaderSource.includes('status.vreSamplingSummaryLabel'), 'AppHeader should render VRE sampling from the status store');
  assert(appRuntimeSource.includes('statusStore,'), 'app runtime should pass the status store into legacy indicator shims');
  assert(statusIndicatorsSource.includes('statusStore?.updateVreSampling'), 'legacy indicator shim should delegate VRE sampling to the store');
  assert(!statusIndicatorsSource.includes('formatSamplingBand'), 'legacy indicator shim should not format VRE sampling display text');
  assert(!statusIndicatorsSource.includes("setText('sampling-rate'"), 'legacy indicator shim should not mutate sampling detail text directly');
  assert(!statusIndicatorsSource.includes('samplingStyleClasses'), 'legacy indicator shim should not own VRE sampling tone classes');
  assert(!statusIndicatorsSource.includes("getElementById('sampling-indicator'"), 'legacy indicator shim should not manipulate the sampling indicator node directly');
});

test('assists indicator is Vue state driven', () => {
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const statusIndicatorsSource = readRepoFile('frontend/src/ui/status-indicators.js');

  assert(statusStoreSource.includes('ASSIST_CATEGORIES'), 'status store should own assist display categories');
  assert(statusStoreSource.includes('updateAssists(data)'), 'status store should expose an assists update action');
  assert(appHeaderSource.includes('status.activeAssistCategories'), 'AppHeader should render active assists from the status store');
  assert(appHeaderSource.includes('status.activeAssistCount'), 'AppHeader should render assist count from the status store');
  assert(statusIndicatorsSource.includes('statusStore?.updateAssists'), 'legacy indicator shim should delegate assists to the store');
  assert(!statusIndicatorsSource.includes('landingAssist'), 'legacy indicator shim should not know assist field names');
  assert(!statusIndicatorsSource.includes('assists-list'), 'legacy indicator shim should not mutate the assists list directly');
  assert(!statusIndicatorsSource.includes('list.innerHTML'), 'legacy indicator shim should not build assist HTML strings');
});

test('recording indicator is Vue state driven', () => {
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const statusIndicatorsSource = readRepoFile('frontend/src/ui/status-indicators.js');

  assert(statusStoreSource.includes('recording: getDefaultRecording()'), 'status store should own recording state');
  assert(statusStoreSource.includes('updateRecording(message)'), 'status store should expose a recording update action');
  assert(statusStoreSource.includes('recordingActive:'), 'status store should expose active recording state for manual start visibility');
  assert(statusStoreSource.includes('recordingStartAvailable:'), 'status store should gate manual start recording on simulator availability');
  assert(appHeaderSource.includes('status.recordingVisible'), 'AppHeader should render recording visibility from the status store');
  assert(appHeaderSource.includes('status.recordingDetail'), 'AppHeader should render recording detail from the status store');
  assert(appHeaderSource.includes('id="start-recording-btn"'), 'AppHeader should render a stable manual start-recording target');
  assert(appHeaderSource.includes('status.requestStartRecordingManual();'), 'AppHeader should delegate manual start-recording requests through the status store');
  assert(statusIndicatorsSource.includes('statusStore?.updateRecording'), 'legacy indicator shim should delegate recording to the store');
  assert(!statusIndicatorsSource.includes('recording-indicator'), 'legacy indicator shim should not manipulate the recording node directly');
  assert(!statusIndicatorsSource.includes('recording-path'), 'legacy indicator shim should not mutate the recording path directly');
  assert(!statusIndicatorsSource.includes('pathEl.innerHTML'), 'legacy indicator shim should not build recording HTML strings');
});

test('surface indicator is Vue state driven', () => {
  const appFooterSource = readRepoFile('frontend/src/vue/components/AppFooter.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const statusIndicatorsSource = readRepoFile('frontend/src/ui/status-indicators.js');

  assert(statusStoreSource.includes('surface: getDefaultSurface()'), 'status store should own surface state');
  assert(statusStoreSource.includes('updateSurface(surface)'), 'status store should expose a surface update action');
  assert(appFooterSource.includes('status.surfaceVisible'), 'AppFooter should render surface visibility from the status store');
  assert(appFooterSource.includes('status.surfaceLabel'), 'AppFooter should render surface text from the status store');
  assert(statusIndicatorsSource.includes('statusStore?.updateSurface'), 'legacy indicator shim should delegate surface messages to the store');
  assert(!statusIndicatorsSource.includes('surface-indicator'), 'legacy indicator shim should not manipulate the surface node directly');
  assert(!statusIndicatorsSource.includes('surface.runwayLike'), 'legacy indicator shim should not own surface tone rules');
  assert(!statusIndicatorsSource.includes('el.textContent'), 'legacy indicator shim should not mutate surface text directly');
});

test('runway context footer is Vue state driven', () => {
  const appFooterSource = readRepoFile('frontend/src/vue/components/AppFooter.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const messageHandlersSource = readRepoFile('frontend/src/app/message-handlers.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(statusStoreSource.includes('runwayContext: getDefaultRunwayContext()'), 'status store should own runway context state');
  assert(statusStoreSource.includes('updateRunwayContext(message)'), 'status store should expose a runway context update action');
  assert(appFooterSource.includes('status.runwayContextVisible'), 'AppFooter should render runway context visibility from the status store');
  assert(appFooterSource.includes('status.runwayContextLabel'), 'AppFooter should render runway context text from the status store');
  assert(!messageHandlersSource.includes('updateRunwayContextDisplay'), 'message handlers should not own runway context display formatting');
  assert(!messageHandlersSource.includes("setText('runway-context'"), 'message handlers should not mutate runway context text directly');
  assert(!messageHandlersSource.includes("toggleClass('runway-context'"), 'message handlers should not toggle runway context visibility directly');
  assert(!appRuntimeSource.includes("toggleClass('runway-context'"), 'app runtime should not reset runway context DOM directly');
});

test('header flight time and aircraft profile are Vue state driven', () => {
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const messageHandlersSource = readRepoFile('frontend/src/app/message-handlers.js');
  const displayDefaultsSource = readRepoFile('frontend/src/telemetry/display-defaults.js');

  assert(statusStoreSource.includes('flightTime: \'00:00:00\''), 'status store should own flight time state');
  assert(statusStoreSource.includes('aircraftProfile: getDefaultAircraftProfile()'), 'status store should own aircraft profile display state');
  assert(statusStoreSource.includes('updateFlightTime(message)'), 'status store should expose a flight time update action');
  assert(statusStoreSource.includes("this.updateFlightTime({ type: 'flightTime', elapsedHms: '00:00:00' });"), 'status store should reset flight time after a successful manual flight end');
  assert(statusStoreSource.includes('updateAircraftProfile(message)'), 'status store should expose an aircraft profile update action');
  assert(appHeaderSource.includes('status.flightTimeLabel'), 'AppHeader should render flight time from the status store');
  assert(appHeaderSource.includes('status.aircraftNameLabel'), 'AppHeader should render aircraft name from the status store');
  assert(appHeaderSource.includes('status.profileBadgeLabel'), 'AppHeader should render profile badge from the status store');
  assert(!messageHandlersSource.includes("setText('flight-time'"), 'message handlers should not mutate flight time directly');
  assert(!messageHandlersSource.includes("setText('aircraft-name'"), 'message handlers should not mutate aircraft name directly');
  assert(!messageHandlersSource.includes("getElementById('profile-badge'"), 'message handlers should not mutate profile badge directly');
  assert(!displayDefaultsSource.includes("'flight-time'"), 'generic text reset should not mutate Vue-owned flight time');
  assert(!displayDefaultsSource.includes("'aircraft-name'"), 'generic text reset should not mutate Vue-owned aircraft name');
  assert(!displayDefaultsSource.includes("'profile-badge'"), 'generic text reset should not mutate Vue-owned profile badge');
});

test('cabin PA playback state stays out of header controls', () => {
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const cabinAnnouncementsSource = readRepoFile('frontend/src/cabin-announcements/runtime.js');
  const messageHandlersSource = readRepoFile('frontend/src/app/message-handlers.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(statusStoreSource.includes('cabinAnnouncements: getDefaultCabinAnnouncements()'), 'status store should own cabin announcement UI state');
  assert(statusStoreSource.includes('setCabinAnnouncementsState(partialState = {})'), 'status store should expose a cabin announcement state setter');
  assert(statusStoreSource.includes('bindHeaderActions({ onStartRecordingManual = null, onEndFlightManual = null } = {})'), 'status store should expose header action binding for manual recording controls');
  assert(statusStoreSource.includes('requestStartRecordingManual()'), 'status store should expose a manual start-recording request action');
  assert(statusStoreSource.includes('requestEndFlightManual()'), 'status store should expose a manual end-flight request action');
  assert(!appHeaderSource.includes('pa-indicator'), 'AppHeader should not render a PA indicator');
  assert(!appHeaderSource.includes('status.paPlaying'), 'AppHeader should not render PA playback state');
  assert(!statusStoreSource.includes('paPlaying'), 'status store should not expose a PA indicator getter');
  assert(!statusStoreSource.includes('setCabinPaPlaying'), 'status store should not expose a PA indicator action');
  assert(!appHeaderSource.includes('cabin-ann-mute-btn'), 'AppHeader should not render a PA on/off button');
  assert(!appHeaderSource.includes('handleCabinMuteClick'), 'AppHeader should not expose a PA mute button click handler');
  assert(!appHeaderSource.includes('toggleCabinAnnouncementsMuted'), 'AppHeader should not expose cabin PA mute controls');
  assert(appHeaderSource.includes('status.requestStartRecordingManual();'), 'AppHeader should delegate manual start-recording requests through the status store');
  assert(appHeaderSource.includes('status.requestEndFlightManual();'), 'AppHeader should delegate manual end-flight requests through the status store');
  assert(!appHeaderSource.includes('window.endFlightManual'), 'AppHeader should not depend on a global manual end-flight handler');
  assert(appRuntimeSource.includes('statusStore?.bindHeaderActions?.({'), 'app runtime should bind header actions into the status store');
  assert(!appRuntimeSource.includes('window.endFlightManual ='), 'app runtime should not expose a global manual end-flight handler');
  assert(appShellSource.includes('statusStore: status'), 'AppShell should inject the status store into the cabin announcement runtime');
  assert(cabinAnnouncementsSource.includes('_statusStore?.setCabinAnnouncementsState'), 'cabin announcement runtime should publish playback state through the injected status store');
  assert(!cabinAnnouncementsSource.includes('pa-indicator'), 'cabin announcement runtime should not inject PA indicator styles');
  assert(!cabinAnnouncementsSource.includes('_setPaIndicator'), 'cabin announcement runtime should not maintain a PA indicator helper');
  assert(!cabinAnnouncementsSource.includes('runtime-bridge.js'), 'cabin announcement runtime should not reach through the Vue runtime bridge after component ownership');
  assert(!cabinAnnouncementsSource.includes('getVueStore'), 'cabin announcement runtime should receive Vue state explicitly from AppShell');
  assert(!cabinAnnouncementsSource.includes("getElementById('pa-indicator'"), 'cabin announcement runtime should not mutate the PA indicator DOM directly');
  assert(!cabinAnnouncementsSource.includes("getElementById('cabin-ann-mute-btn'"), 'cabin announcement runtime should not mutate the PA mute button DOM directly');
  assert(!statusStoreSource.includes('paMuteButton'), 'status store should not expose header PA mute button getters');
  assert(!messageHandlersSource.includes("cabin-ann-mute-btn"), 'message handlers should not show the PA mute button directly');
});

test('footer connection info is Vue state driven', () => {
  const appFooterSource = readRepoFile('frontend/src/vue/components/AppFooter.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(statusStoreSource.includes('connectionInfo: \'ws://localhost:8099\''), 'status store should own connection info state');
  assert(statusStoreSource.includes('setConnectionInfo(value)'), 'status store should expose a connection info setter');
  assert(appFooterSource.includes('status.connectionInfoLabel'), 'AppFooter should render connection info from the status store');
  assert(appRuntimeSource.includes('statusStore?.setConnectionInfo?.(wsUrl)'), 'app runtime should update connection info through the status store');
  assert(!appRuntimeSource.includes("setText('connection-info'"), 'app runtime should not mutate connection info text directly');
});

test('system banners are Vue state driven', () => {
  const systemBannersSource = readRepoFile('frontend/src/vue/components/SystemBanners.vue');
  const statusStoreSource = readRepoFile('frontend/src/vue/stores/status.js');
  const telemetryWarningsSource = readRepoFile('frontend/src/telemetry/warnings.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(statusStoreSource.includes('systemBanners: getDefaultSystemBanners()'), 'status store should own system banner state');
  assert(statusStoreSource.includes('showDiskWarning(message = {})'), 'status store should expose a disk warning action');
  assert(statusStoreSource.includes('showUpdateBanner(message = {})'), 'status store should expose an update banner action');
  assert(statusStoreSource.includes('showRestartRequiredBanner(message = {})'), 'status store should expose a restart-required banner action');
  assert(systemBannersSource.includes('status.diskWarningVisible'), 'SystemBanners should render disk warning visibility from the status store');
  assert(systemBannersSource.includes('status.updateBannerVisible'), 'SystemBanners should render update warning visibility from the status store');
  assert(systemBannersSource.includes('status.restartRequiredBannerVisible'), 'SystemBanners should render restart-required visibility from the status store');
  assert(systemBannersSource.includes('useSettingsUiStore()'), 'SystemBanners should reuse the shared restart action store');
  assert(systemBannersSource.includes('settingsUi.requestRestart()'), 'SystemBanners restart button should delegate through the shared restart action');
  assert(systemBannersSource.includes('window.confirm('), 'SystemBanners restart button should confirm before restarting the app');
  assert(systemBannersSource.includes('status.dismissUpdateBanner()'), 'SystemBanners should own update dismissal through the store');
  assert(systemBannersSource.includes('status.dismissRestartRequiredBanner()'), 'SystemBanners should own restart-required dismissal through the store');
  assert(telemetryWarningsSource.includes('statusStore?.showDiskWarning?.(msg)'), 'warning shim should delegate disk warnings to the store');
  assert(telemetryWarningsSource.includes('statusStore?.showUpdateBanner?.(msg)'), 'warning shim should delegate update banners to the store');
  assert(appRuntimeSource.includes('statusStore,'), 'app runtime should pass status store into telemetry warnings');
  assert(!telemetryWarningsSource.includes("$('disk-warning-banner'"), 'warning shim should not query the disk warning banner');
  assert(!telemetryWarningsSource.includes("$('update-banner'"), 'warning shim should not query the update banner');
  assert(!telemetryWarningsSource.includes("documentRef.body.style.paddingTop = '40px'"), 'warning shim should not mutate body padding for banners');
});

test('desktop update checks stay low-cadence and opt-out', () => {
  const simbridgeCoreSource = readRepoFile('backend/core/simbridge-core.ts');
  const configSource = readRepoFile('backend/core/config.ts');
  const sharedSettingsSource = readRepoFile('shared/app-settings-shared.js');
  const updateCheckerSource = readRepoFile('backend/core/update-checker.ts');

  assert(configSource.includes("enabled: bool('UPDATE_CHECKS_ENABLED'"), 'config should expose an explicit update-check gate');
  assert(sharedSettingsSource.includes('updateChecks: true'), 'shared settings should default update checks on');
  assert(updateCheckerSource.includes('CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000'), 'update checker should use a daily cadence');
  assert(simbridgeCoreSource.includes('|| config.env.isLocalBatchLaunch'), 'update checker should run for packaged, Electron desktop, and local batch backends');
  assert(simbridgeCoreSource.includes('if (config.updates?.enabled === true)'), 'desktop update checker should only start when update checks remain enabled');
});

test('app feedback toast is Vue state driven', () => {
  const appFeedbackToastSource = readRepoFile('frontend/src/vue/components/AppFeedbackToast.vue');
  const feedbackStoreSource = readRepoFile('frontend/src/vue/stores/feedback.js');
  const feedbackRuntimeSource = readRepoFile('frontend/src/ui/feedback.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');
  const vueMainSource = readRepoFile('frontend/src/vue/main.js');

  assert(feedbackStoreSource.includes("defineStore('feedback'"), 'feedback store should own app feedback state');
  assert(feedbackStoreSource.includes('showToast({'), 'feedback store should expose a toast action');
  assert(appFeedbackToastSource.includes('feedback.toastClass'), 'AppFeedbackToast should render classes from the feedback store');
  assert(appFeedbackToastSource.includes('feedback.toastTitle'), 'AppFeedbackToast should render title from the feedback store');
  assert(appFeedbackToastSource.includes('feedback.toastMessage'), 'AppFeedbackToast should render copy from the feedback store');
  assert(feedbackRuntimeSource.includes('feedbackStore?.showToast'), 'feedback helper should publish toast state through the store');
  assert(feedbackRuntimeSource.includes('feedbackStore?.hideToast'), 'feedback helper should hide toast through the store');
  assert(appRuntimeSource.includes("requireRuntimeStore(runtimeStores, 'feedback')"), 'app runtime should resolve the feedback store from the injected store bundle');
  assert(appRuntimeSource.includes('createAppFeedback({ windowRef: window, feedbackStore })'), 'app runtime should pass the feedback store into helper wiring');
  assert(vueMainSource.includes('useFeedbackStore'), 'Vue bootstrap should register the feedback store');
  assert(!feedbackRuntimeSource.includes("$('app-feedback-toast'"), 'feedback helper should not query the toast root');
  assert(!feedbackRuntimeSource.includes('app-feedback-toast-title'), 'feedback helper should not mutate toast title text directly');
  assert(!feedbackRuntimeSource.includes('app-feedback-toast-copy'), 'feedback helper should not mutate toast copy text directly');
  assert(!feedbackRuntimeSource.includes('toastEl.className'), 'feedback helper should not rewrite toast classes directly');
  assert(!feedbackRuntimeSource.includes('appFeedbackIdleHtml'), 'feedback helper should not carry legacy busy-button HTML swapping');
  assert(!feedbackRuntimeSource.includes('button.innerHTML'), 'feedback helper should not mutate button HTML directly');
});

test('debug modal chrome is Vue state driven', () => {
  const debugModalSource = readRepoFile('frontend/src/vue/components/DebugTelemetryModal.vue');
  const debugStoreSource = readRepoFile('frontend/src/vue/stores/debug.js');
  const debugRuntimeSource = readRepoFile('frontend/src/debug/runtime.js');
  const messageHandlersSource = readRepoFile('frontend/src/app/message-handlers.js');
  const runtimeSignalsSource = readRepoFile('frontend/src/app/runtime-signals.js');
  const vueMainSource = readRepoFile('frontend/src/vue/main.js');

  assert(debugStoreSource.includes("defineStore('debug'"), 'debug store should own debug modal chrome state');
  assert(debugStoreSource.includes('toggleModal()'), 'debug store should expose modal toggling');
  assert(debugStoreSource.includes('setConnectionStatus(connected)'), 'debug store should expose connection status updates');
  assert(debugModalSource.includes('debug.modalClass'), 'DebugTelemetryModal should render visibility classes from the debug store');
  assert(debugModalSource.includes('debug.statusDotClass'), 'DebugTelemetryModal should render status dot classes from the debug store');
  assert(debugModalSource.includes('debug.statusText'), 'DebugTelemetryModal should render status text from the debug store');
  assert(debugModalSource.includes('initDebugRuntime({'), 'DebugTelemetryModal should own debug runtime lifecycle');
  assert(debugModalSource.includes('subscribeDebugFrameSignal: subscribeDebugFrame'), 'DebugTelemetryModal should own debug-frame signal wiring');
  assert(debugModalSource.includes('subscribeWsMessageSignal: subscribeWsMessage'), 'DebugTelemetryModal should own websocket-message signal wiring');
  assert(debugRuntimeSource.includes('debugStore.toggleModal()'), 'debug runtime should toggle the modal through the debug store');
  assert(debugRuntimeSource.includes('debugStore.setConnectionStatus(isActuallyConnected);'), 'debug runtime should publish connection state through the debug store');
  assert(messageHandlersSource.includes('emitDebugFrame(message);'), 'app message handlers should emit debug-frame runtime signals');
  assert(runtimeSignalsSource.includes("debugFrame: new Set()"), 'runtime signals should expose a dedicated debug-frame signal');
  assert(runtimeSignalsSource.includes("export const subscribeDebugFrame ="), 'runtime signals should expose debug-frame subscriptions');
  assert(vueMainSource.includes('useDebugStore'), 'Vue bootstrap should register the debug store');
  assert(!debugRuntimeSource.includes('runtime-signals.js'), 'debug runtime should not import runtime signals directly');
  assert(!debugRuntimeSource.includes('_debugFrameHandler'), 'debug runtime should not expose a global debug frame handler');
  assert(!debugRuntimeSource.includes("debugModal.classList.toggle('hidden'"), 'debug runtime should not toggle modal visibility directly');
  assert(!debugRuntimeSource.includes("debugModal.classList.add('hidden'"), 'debug runtime should not close the modal by direct class mutation');
  assert(!debugRuntimeSource.includes('debug-status-dot'), 'debug runtime should not mutate status dot DOM directly');
  assert(!debugRuntimeSource.includes('debug-status-text'), 'debug runtime should not mutate status text DOM directly');
  assert(!debugRuntimeSource.includes('debug-modal-open'), 'debug runtime should not own debug body class syncing');
});

test('flight telemetry panel values are Vue state driven', () => {
  const displayDefaultsSource = readRepoFile('frontend/src/telemetry/display-defaults.js');
  const telemetryDisplaySource = readRepoFile('frontend/src/telemetry/display.js');
  const telemetryWarningsSource = readRepoFile('frontend/src/telemetry/warnings.js');
  const messageHandlersSource = readRepoFile('frontend/src/app/message-handlers.js');
  const appPreferencesSource = readRepoFile('frontend/src/app/preferences.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');
  const vuePanelSource = readRepoFile('frontend/src/vue/components/FlightTelemetryPanel.vue');
  const flightStoreSource = readRepoFile('frontend/src/vue/stores/flight.js');

  const vueOwnedIds = [
    'ias-value',
    'gs-value',
    'vs-value',
    'alt-value',
    'hdg-value',
    'xwind-value',
    'xwind-arrow',
    'fuel-value',
    'flaps-value',
    'flaps-unit',
    'spoilers-value',
    'gear-state',
    'eng1-value',
    'cabin-alt-value',
    'oat-value',
  ];

  for (const id of vueOwnedIds) {
    assert(
      vuePanelSource.includes(`id="${id}"`)
        || vuePanelSource.includes(`valueId: '${id}'`)
        || vuePanelSource.includes(`cardId: '${id}'`)
        || vuePanelSource.includes(`\`${id.replace(/[0-9]/g, '${engine.number}')}\``),
      `${id} should remain represented in the Vue telemetry panel`,
    );
    assert(!displayDefaultsSource.includes(`'${id}'`), `generic text reset should not mutate Vue-owned ${id}`);
    assert(!telemetryDisplaySource.includes(`setText('${id}'`), `telemetry display should not mutate Vue-owned ${id}`);
    assert(!messageHandlersSource.includes(`setText('${id}'`), `message handlers should not mutate Vue-owned ${id}`);
    assert(!appPreferencesSource.includes(`setText('${id}'`), `preferences should not mutate Vue-owned ${id}`);
  }

  assert(!telemetryDisplaySource.includes('setValueColor('), 'telemetry display should expose value tones through the flight store');
  assert(!messageHandlersSource.includes('setValueColor'), 'message handlers should not receive legacy value color helpers');
  assert(!messageHandlersSource.includes('telemetryShell'), 'message handlers should update telemetry store state directly');
  assert(!appRuntimeSource.includes('telemetry-shell'), 'app runtime should not wire the obsolete telemetry shell shim');
  assert(!appRuntimeSource.includes('telemetryShell'), 'app runtime should not keep the obsolete telemetry shell instance');
  assert(!appRuntimeSource.includes('function setValueColor'), 'app runtime should not keep the legacy value color helper after telemetry migration');
  assert(!appRuntimeSource.includes("className = 'gear-dot'"), 'app runtime should not reset gear dots directly');
  assert(!appRuntimeSource.includes("classList.remove('on'"), 'app runtime should not reset light indicators directly');
  assert(flightStoreSource.includes('warnings: getDefaultWarnings()'), 'flight store should own live telemetry warning state');
  assert(flightStoreSource.includes('updateSpeedWarning('), 'flight store should expose speed warning updates');
  assert(flightStoreSource.includes('updateCabinAltitudeWarning('), 'flight store should expose cabin warning updates');
  assert(vuePanelSource.includes('flight.speedWarningVisible'), 'FlightTelemetryPanel should render speed warning visibility from the store');
  assert(vuePanelSource.includes('flight.fuelExhaustedWarningVisible'), 'FlightTelemetryPanel should render fuel warning visibility from the store');
  assert(vuePanelSource.includes('flight.cabinAltitudeBannerVisible'), 'FlightTelemetryPanel should render cabin warning visibility from the store');
  assert(telemetryWarningsSource.includes('flightStore?.updateSpeedWarning'), 'warning shim should delegate speed warnings to the flight store');
  assert(telemetryWarningsSource.includes('flightStore?.showFuelExhaustedWarning'), 'warning shim should delegate fuel warnings to the flight store');
  assert(telemetryWarningsSource.includes('flightStore?.updateCabinAltitudeWarning'), 'warning shim should delegate cabin warnings to the flight store');
  assert(!telemetryWarningsSource.includes('querySelector'), 'warning shim should not query telemetry warning DOM');
  assert(!telemetryWarningsSource.includes('getElementById'), 'warning shim should not query telemetry warning DOM by id');
  assert(!telemetryWarningsSource.includes('createElement'), 'warning shim should not create telemetry warning DOM');
  assert(!telemetryWarningsSource.includes('classList'), 'warning shim should not toggle telemetry warning classes directly');
  assert(!appRuntimeSource.includes('fuel-exhausted-banner'), 'app runtime should not reset fuel warning DOM directly');
  assert(!appRuntimeSource.includes('cabin-altitude-banner'), 'app runtime should not reset cabin warning DOM directly');
  assert(!appRuntimeSource.includes("data-card=\"ias\""), 'app runtime should not query the old IAS warning overlay');
});

test('Vue components centralize repeated display primitives', () => {
  const flightTelemetrySource = readRepoFile('frontend/src/vue/components/FlightTelemetryPanel.vue');
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const liveMapHeaderSource = readRepoFile('frontend/src/vue/components/LiveMapHeader.vue');
  const systemBannersSource = readRepoFile('frontend/src/vue/components/SystemBanners.vue');

  assert(flightTelemetrySource.includes('primaryMetricCards'), 'flight telemetry primary readouts should be data-driven');
  assert(flightTelemetrySource.includes('environmentCards'), 'flight telemetry environment readouts should be data-driven');
  assert(flightTelemetrySource.includes('lightItems'), 'flight telemetry light indicators should use shared metadata');
  assert(flightTelemetrySource.includes('telemetryValueLargeClass'), 'flight telemetry large value classes should be centralized');
  assert(flightTelemetrySource.includes('warningBannerBaseClass'), 'flight telemetry warning banner classes should be centralized');
  assert(appHeaderSource.includes('samplingDetails'), 'header sampling details should be data-driven');
  assert(appHeaderSource.includes('AppTooltip'), 'header hover/click hints should use the shared Floating UI tooltip component');
  assert(!appHeaderSource.includes('popoverPanelClass'), 'header should not keep the retired CSS-hover popover class helper');
  assert(liveMapHeaderSource.includes('routeFields'), 'live map route controls should be data-driven');
  assert(liveMapHeaderSource.includes('routeButtonClass'), 'live map route button classes should be centralized');
  assert(
    liveMapHeaderSource.indexOf('id="live-map-route-inputs"') > liveMapHeaderSource.indexOf('class="live-map-inline-meta"'),
    'live map route controls should live inside the header meta grid',
  );
  assert(systemBannersSource.includes('bannerInnerClass'), 'system banner inner layout classes should be centralized');
  assert(systemBannersSource.includes('dismissButtonClass'), 'system banner dismiss button classes should be centralized');
});

test('frontend timeline and settings formatting helpers are shared', () => {
  const formattingSource = readRepoFile('frontend/src/utils/formatting.js');
  const timelineStoreSource = readRepoFile('frontend/src/vue/stores/timeline.js');
  const timelineFlightsSource = readRepoFile('frontend/src/vue/components/TimelineFlightsPanel.vue');
  const settingsUiSource = readRepoFile('frontend/src/vue/stores/settings-ui.js');
  const timelineModelSource = readRepoFile('frontend/src/timeline/model.js');

  assert(formattingSource.includes('export function formatBytes'), 'shared formatting module should export formatBytes');
  assert(formattingSource.includes('export function formatDuration'), 'shared formatting module should export formatDuration');
  assert(formattingSource.includes('export function formatFuelBurn'), 'shared formatting module should export formatFuelBurn');
  assert(formattingSource.includes('export function getFiniteFuelBurnGal'), 'shared formatting module should export fuel-burn normalization');
  assert(timelineStoreSource.includes("from '../../utils/formatting.js'"), 'timeline store should use shared formatting helpers');
  assert(timelineFlightsSource.includes("from '../../utils/formatting.js'"), 'timeline flights panel should use shared formatting helpers');
  assert(timelineModelSource.includes("from '../utils/formatting.js'"), 'timeline model should use shared formatting helpers');
  assert(!/function formatBytes\s*\(/.test(timelineStoreSource), 'timeline store should not duplicate formatBytes');
  assert(!/function formatBytes\s*\(/.test(timelineFlightsSource), 'timeline flights panel should not duplicate formatBytes');
  assert(!/function formatBytes\s*\(/.test(settingsUiSource), 'settings UI store should not duplicate formatBytes');
  assert(!/function formatFuelBurn\s*\(/.test(timelineFlightsSource), 'timeline flights panel should not duplicate formatFuelBurn');
  assert(!/function getFiniteFuelBurnGal\s*\(/.test(timelineStoreSource), 'timeline store should not duplicate fuel-burn normalization');
  assert(!/function getFiniteFuelBurnGal\s*\(/.test(timelineFlightsSource), 'timeline flights panel should not duplicate fuel-burn normalization');
});

test('live map and timeline runtime bridges use store-driven signals', () => {
  const liveMapStoreSource = readRepoFile('frontend/src/vue/stores/live-map.js');
  const liveMapHeaderSource = readRepoFile('frontend/src/vue/components/LiveMapHeader.vue');
  const liveMapRuntimeSource = readRepoFile('frontend/src/live-map/runtime.js');
  const liveMapShellSource = readRepoFile('frontend/src/vue/components/LiveMapTabShell.vue');
  const timelineStoreSource = readRepoFile('frontend/src/vue/stores/timeline.js');
  const timelineRuntimeSource = readRepoFile('frontend/src/timeline/runtime.js');
  const timelineBootstrapSource = readRepoFile('frontend/src/timeline/bootstrap.js');
  const timelineTabShellSource = readRepoFile('frontend/src/vue/components/TimelineTabShell.vue');
  const timelinePfdOverlaySource = readRepoFile('frontend/src/timeline/pfd-overlay.js');

  assert(liveMapStoreSource.includes('function requestCenter()'));
  assert(liveMapStoreSource.includes('function requestSetTarget()'));
  assert(liveMapStoreSource.includes('function bindRuntimeActions({'));
  assert(liveMapHeaderSource.includes('@click="liveMap.requestCenter()"'));
  assert(liveMapHeaderSource.includes("setAction: 'requestSetTarget'"), 'route metadata should preserve set-target action');
  assert(liveMapHeaderSource.includes("clearAction: 'requestClearTarget'"), 'route metadata should preserve clear-target action');
  assert(liveMapHeaderSource.includes("setAction: 'requestSetOrigin'"), 'route metadata should preserve set-origin action');
  assert(liveMapHeaderSource.includes("clearAction: 'requestClearOrigin'"), 'route metadata should preserve clear-origin action');
  assert(liveMapHeaderSource.includes('@click="liveMap[field.setAction]()"'), 'route set buttons should call store actions from metadata');
  assert(liveMapHeaderSource.includes('@click="liveMap[field.clearAction]()"'), 'route clear buttons should call store actions from metadata');
  assert(!liveMapHeaderSource.includes('requestEvent('));
  assert(liveMapRuntimeSource.includes('liveMapStore.bindRuntimeActions({'), 'live-map runtime should bind store actions explicitly');
  assert(liveMapRuntimeSource.includes('return function cleanupLiveMapRuntime()'), 'live-map runtime should expose a component-owned cleanup function');
  assert(liveMapRuntimeSource.includes('liveMapStore.bindRuntimeActions({});'), 'live-map cleanup should unbind runtime actions from the store');
  assert(liveMapShellSource.includes('onMounted(() => {'), 'LiveMapTabShell should initialize the runtime from Vue lifecycle');
  assert(liveMapShellSource.includes('onUnmounted(() => {'), 'LiveMapTabShell should clean up the runtime from Vue lifecycle');
  assert(!liveMapRuntimeSource.includes('centerRequestNonce'), 'live-map runtime should not depend on nonce-based action signals');
  assert(!liveMapRuntimeSource.includes('setTargetRequestNonce'), 'live-map runtime should not depend on nonce-based target action signals');
  assert(!liveMapRuntimeSource.includes("window.addEventListener('live-map-center-request'"));
  assert(!liveMapRuntimeSource.includes("window.addEventListener('ws-open'"));
  assert(!liveMapRuntimeSource.includes("window.addEventListener('ws-close'"));
  assert(timelineRuntimeSource.includes("() => timelineStore.mapFilters"));
  assert(timelineRuntimeSource.includes('cleanup()'), 'timeline runtime should expose component-owned cleanup');
  assert(timelineRuntimeSource.includes('windowRef.removeEventListener?.(\'resize\', handleResize)'), 'timeline runtime cleanup should remove resize listeners');
  assert(timelineRuntimeSource.includes('pendingRequestTimers.clear()'), 'timeline runtime cleanup should clear deferred refresh timers');
  assert(timelineBootstrapSource.includes('return function cleanupTimelinePage()'), 'timeline bootstrap should return a Vue-owned cleanup function');
  assert(timelineBootstrapSource.includes('timelineRuntime?.cleanup?.();'), 'timeline cleanup should stop runtime subscriptions and watchers');
  assert(timelineBootstrapSource.includes('timelineScrubber?.cleanup?.();'), 'timeline cleanup should unbind replay actions');
  assert(timelineBootstrapSource.includes('timelineMapController?.destroy?.();'), 'timeline cleanup should destroy map resources');
  assert(timelineTabShellSource.includes('initTimelinePage({'), 'TimelineTabShell should own timeline page initialization');
  assert(timelineTabShellSource.includes('cleanupTimelinePage?.();'), 'TimelineTabShell should clean up timeline page runtime');
  assert(timelineTabShellSource.includes('timelineStore: timeline'), 'TimelineTabShell should inject the timeline store');
  assert(timelineTabShellSource.includes('tabsStore: tabs'), 'TimelineTabShell should inject the tabs store');
  assert(timelineTabShellSource.includes('statusStore: status'), 'TimelineTabShell should inject the status store');
  assert(!timelineRuntimeSource.includes("windowRef.addEventListener('timeline-map-filters-changed'"));
  assert(!timelineBootstrapSource.includes('runtime-bridge.js'), 'timeline bootstrap should receive Vue stores from TimelineTabShell');
  assert(!timelineStoreSource.includes('dispatchWindowEvent('));
  assert(!timelineStoreSource.includes('timeline-map-filters-changed'));
  assert(!timelineStoreSource.includes('timeline-pfd-collapsed-changed'));
  assert(timelinePfdOverlaySource.includes("() => timelineStore.pfdCollapsed"));
});

test('SimBrief frontend surfaces use runtime-bound connection helpers instead of connection globals', () => {
  const simbriefStoreSource = readRepoFile('frontend/src/vue/stores/simbrief.js');
  const simbriefTabSource = readRepoFile('frontend/src/vue/components/SimbriefTab.vue');
  const connectionSource = readRepoFile('frontend/src/ws/connection.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(simbriefStoreSource.includes('function bindRuntime('), 'SimBrief store should bind runtime capabilities explicitly');
  assert(!simbriefStoreSource.includes('app-shared.js'), 'SimBrief store should not import shared connection helpers directly');
  assert(!simbriefTabSource.includes('runtime-signals.js'), 'SimBrief tab should not subscribe to websocket runtime signals directly');
  assert(appRuntimeSource.includes('simbriefStore?.bindRuntime?.({'), 'app runtime should bind SimBrief connection helpers');
  assert(simbriefStoreSource.includes('getHttpBase = null,'), 'SimBrief store should accept a live HTTP-base resolver');
  assert(simbriefStoreSource.includes('function resolveBackendHttpBase()'), 'SimBrief store should resolve the backend HTTP base at use time');
  assert(appRuntimeSource.includes('getHttpBase: () => connection.getBackendHttpBase()'), 'app runtime should bind the live backend HTTP base into SimBrief');
  assert(appRuntimeSource.includes('simbriefStore?.relayPlan?.();'), 'app runtime should rebroadcast SimBrief plans on websocket open');
  assert(!simbriefStoreSource.includes('window._getBackendHttpBase'));
  assert(!connectionSource.includes('windowRef._getWsUrl'));
  assert(!connectionSource.includes('windowRef._getBackendHttpBase'));
  assert(!connectionSource.includes('windowRef._wsSend'));
  assert(appRuntimeSource.includes('simbriefStore?.restore?.();'), 'app runtime should restore SimBrief state during app startup');
  assert(appRuntimeSource.includes('simbriefStore?.relayPlan?.();'), 'app runtime should rebroadcast the active SimBrief plan when the websocket opens');
});

test('SimBrief proxy rate limiter keeps its username cache bounded', () => {
  const httpServerSource = readRepoFile('backend/core/http-server.ts');

  assert(httpServerSource.includes('SIMBRIEF_RATE_LIMIT_MAX_KEYS'), 'SimBrief limiter should define a hard key cap');
  assert(httpServerSource.includes('SIMBRIEF_RATE_LIMIT_RETENTION_MS'), 'SimBrief limiter should age out old usernames');
  assert(httpServerSource.includes('export function createSimbriefRequestLimiter'), 'SimBrief limiter should keep state per HTTP server');
  assert(httpServerSource.includes('function prune(at: number): void'), 'SimBrief limiter should have an explicit pruning helper');
  assert(httpServerSource.includes('lastAttemptByUsername.delete(username)'), 'SimBrief limiter should delete stale or excess usernames');
  assert(httpServerSource.includes('prune(at);'), 'SimBrief requests should prune before checking the cache');
});

test('retired stopwatch surfaces stay removed from runtime and overlays', () => {
  const retiredFiles = [
    'frontend/widget-stopwatch.html',
    'frontend/src/vue/components/StopwatchWidget.vue',
    'frontend/src/vue/stores/stopwatch.js',
  ];
  for (const relativePath of retiredFiles) {
    assert(!fs.existsSync(path.join(ROOT_DIR, relativePath)), `${relativePath} should stay removed`);
  }

  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const messageTypesSource = readRepoFile('backend/core/message-types.ts');
  const clientMessageHandlerSource = readRepoFile('backend/core/client-message-handler.ts');

  assert(!appRuntimeSource.includes('stopwatchStore'), 'app runtime should not bind retired stopwatch lifecycle hooks');
  assert(!appHeaderSource.includes('comp-sw-toggle'), 'header should not render the retired stopwatch toggle');
  assert(!messageTypesSource.includes('STOPWATCH'), 'backend message types should not expose the retired stopwatch relay');
  assert(!clientMessageHandlerSource.includes('sanitizeStopwatchRelayState'), 'backend should not keep retired stopwatch relay state');
});

test('page runtimes receive runtime signals through entry and bootstrap wiring', () => {
  const appBootstrapSource = readRepoFile('frontend/src/app/bootstrap.js');
  const runtimeSignalsSource = readRepoFile('frontend/src/app/runtime-signals.js');
  const settingsRuntimeSource = readRepoFile('frontend/src/settings/runtime.js');
  const settingsShellSource = readRepoFile('frontend/src/vue/components/SettingsTabShell.vue');
  const profilesRuntimeSource = readRepoFile('frontend/src/profiles/runtime.js');
  const profileSelectorSource = readRepoFile('frontend/src/vue/components/AircraftProfileSelector.vue');
  const logbookRuntimeSource = readRepoFile('frontend/src/logbook/runtime.js');
  const logbookPanelSource = readRepoFile('frontend/src/vue/components/LogbookPanel.vue');
  const liveMapRuntimeSource = readRepoFile('frontend/src/live-map/runtime.js');
  const liveMapShellSource = readRepoFile('frontend/src/vue/components/LiveMapTabShell.vue');
  const timelineBootstrapSource = readRepoFile('frontend/src/timeline/bootstrap.js');
  const timelineRuntimeSource = readRepoFile('frontend/src/timeline/runtime.js');
  const timelineTabShellSource = readRepoFile('frontend/src/vue/components/TimelineTabShell.vue');

  assert(runtimeSignalsSource.includes("landingReceived: new Set()"), 'runtime signals should expose a dedicated landing-received signal');
  assert(runtimeSignalsSource.includes('export const subscribeLandingReceived ='), 'runtime signals should expose landing-received subscriptions');
  assert(runtimeSignalsSource.includes('export const emitLandingReceived ='), 'runtime signals should expose landing-received emissions');

  assert(settingsShellSource.includes('subscribeAppSettingsSignal: subscribeAppSettings'), 'SettingsTabShell should own app-settings signal wiring');
  assert(settingsShellSource.includes('subscribeAppSettingsSavedSignal: subscribeAppSettingsSaved'), 'SettingsTabShell should own app-settings-saved signal wiring');
  assert(settingsShellSource.includes('subscribeWsOpenSignal: subscribeWsOpen'), 'SettingsTabShell should own settings websocket-open signal wiring');
  assert(!appBootstrapSource.includes('initSettingsRuntime({'), 'dashboard bootstrap should not initialize the component-owned settings runtime');
  assert(!settingsRuntimeSource.includes('runtime-signals.js'), 'settings runtime should not import runtime signals directly');

  assert(profileSelectorSource.includes('subscribeWsMessageSignal: subscribeWsMessage'), 'AircraftProfileSelector should own profiles websocket-message signal wiring');
  assert(profileSelectorSource.includes('subscribeWsCloseSignal: subscribeWsClose'), 'AircraftProfileSelector should clear profile authorization when its websocket closes');
  assert(profileSelectorSource.includes('subscribeWsConnectingSignal: subscribeWsConnecting'), 'AircraftProfileSelector should fail closed while its websocket reconnects');
  assert(profileSelectorSource.includes('subscribeWsErrorSignal: subscribeWsError'), 'AircraftProfileSelector should fail closed on websocket errors');
  assert(profileSelectorSource.includes('subscribeWsOpenSignal: subscribeWsOpen'), 'AircraftProfileSelector should own profiles websocket-open signal wiring');
  assert(!profileSelectorSource.includes('window.confirm'), 'read-only profile selection should not wire mutation confirmations');
  assert(!appBootstrapSource.includes('initProfilesRuntime({'), 'dashboard bootstrap should not initialize the component-owned profiles runtime');
  assert(!profilesRuntimeSource.includes('runtime-signals.js'), 'profiles runtime should not import runtime signals directly');

  assert(logbookPanelSource.includes('subscribeLandingReceivedSignal: subscribeLandingReceived'), 'LogbookPanel should own logbook landing-received signal wiring');
  assert(logbookPanelSource.includes('subscribeWsOpenSignal: subscribeWsOpen'), 'LogbookPanel should own logbook websocket-open signal wiring');
  assert(!appBootstrapSource.includes('initLogbookRuntime({'), 'dashboard bootstrap should not initialize the component-owned logbook runtime');
  assert(!logbookRuntimeSource.includes('runtime-signals.js'), 'logbook runtime should not import runtime signals directly');
  assert(!logbookRuntimeSource.includes("windowRef.addEventListener('landing-received'"), 'logbook runtime should not listen for DOM landing events directly');

  assert(liveMapShellSource.includes('subscribeWsMessageSignal: subscribeWsMessage'), 'LiveMapTabShell should own live-map websocket-message signal wiring');
  assert(!appBootstrapSource.includes('initLiveMapRuntime({'), 'dashboard bootstrap should not initialize the component-owned live-map runtime');
  assert(!liveMapRuntimeSource.includes('runtime-signals.js'), 'live-map runtime should not import runtime signals directly');
  assert(!liveMapRuntimeSource.includes("from '../app/shared-globals.js';"), 'live-map runtime should not retain a phase dependency after remote pilots are removed');
  assert(!liveMapRuntimeSource.includes('windowRef.FlightPhases?.PHASES'), 'live-map runtime should not read phase globals directly');

  assert(timelineTabShellSource.includes('subscribeLandingReceivedSignal: subscribeLandingReceived'), 'TimelineTabShell should own landing-received signal wiring');
  assert(timelineTabShellSource.includes('subscribeWsMessageSignal: subscribeWsMessage'), 'TimelineTabShell should own websocket-message signal wiring');
  assert(!appBootstrapSource.includes('initTimelinePage({'), 'dashboard bootstrap should not initialize the component-owned timeline runtime');
  assert(!timelineBootstrapSource.includes('runtime-signals.js'), 'timeline bootstrap should receive runtime signals from TimelineTabShell');
  assert(!timelineRuntimeSource.includes('runtime-signals.js'), 'timeline runtime should not import runtime signals directly');
  assert(!timelineRuntimeSource.includes("windowRef.addEventListener('landing-received'"), 'timeline runtime should not listen for DOM landing events directly');
});

test('landing and cabin runtime bridges use shared services instead of direct globals', () => {
  const sharedSource = readRepoFile('frontend/app-shared.js');
  const appBootstrapSource = readRepoFile('frontend/src/app/bootstrap.js');
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const landingControllerSource = readRepoFile('frontend/src/landing/controller.js');
  const landingCardSource = readRepoFile('frontend/src/landing/card.js');
  const runtimeSignalsSource = readRepoFile('frontend/src/app/runtime-signals.js');
  const timelineStoreSource = readRepoFile('frontend/src/vue/stores/timeline.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');
  const settingsControllerSource = readRepoFile('frontend/src/app/settings-controller.js');
  const messageHandlersSource = readRepoFile('frontend/src/app/message-handlers.js');
  const cabinAnnouncementsSource = readRepoFile('frontend/src/cabin-announcements/runtime.js');
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const mockLandingSource = readRepoFile('frontend/src/landing/mock-runtime.js');
  const landingPanelSource = readRepoFile('frontend/src/vue/components/LandingPanel.vue');
  const approachProfileSource = readRepoFile('frontend/src/landing/approach-profile-global.js');

  assert(sharedSource.includes("showTimelineLanding(event)"));
  assert(sharedSource.includes("getCabinAnnouncements()"));
  assert(runtimeSignalsSource.includes('emitLandingReceived'), 'runtime signals should expose landing-received emissions');
  assert(appRuntimeSource.includes("requireRuntimeStore(runtimeStores, 'landing')"), 'app runtime should resolve the landing store from the injected store bundle');
  assert(appRuntimeSource.includes('landingStore,'), 'app runtime should inject the landing store into the landing controller');
  assert(appRuntimeSource.includes('tabsStore,'), 'app runtime should inject the tabs store into the landing controller');
  assert(appRuntimeSource.includes('showTimelineLanding: landingController.showTimelineLanding'));
  assert(!landingControllerSource.includes('runtime-bridge.js'), 'landing controller should receive stores from app runtime instead of using the runtime bridge');
  assert(!landingControllerSource.includes('getVueStore'), 'landing controller should not pull Vue stores through the runtime bridge');
  assert(!landingControllerSource.includes("setAppService('showTimelineLanding'"));
  assert(!landingControllerSource.includes('windowRef.__showTimelineLanding'));
  assert(!landingControllerSource.includes('innerHTML'), 'landing controller should not inject landing SVG markup directly into the DOM');
  assert(!landingCardSource.includes("$('landing-card')"), 'landing card renderer should not treat the legacy card element as the source of truth');
  assert(landingCardSource.includes('emitLandingReceived({'), 'landing card renderer should publish landing events through runtime signals');
  assert(!landingCardSource.includes("dispatchEvent(new windowRef.CustomEvent('landing-received'"), 'landing card renderer should not dispatch DOM landing events directly');
  assert(timelineStoreSource.includes('bindDetailActions({'));
  assert(timelineStoreSource.includes('onOpenSelectedLanding = null'));
  assert(timelineStoreSource.includes('onOpenFlightLanding = null'));
  assert(timelineStoreSource.includes('onFlightLandingLoadStart = null'));
  assert(timelineStoreSource.includes('onFlightLandingLoadError = null'));
  assert(timelineStoreSource.includes('return this._onOpenSelectedLanding(this.selectedLandingEvent) !== false;'));
  assert(!timelineStoreSource.includes('__showTimelineLanding'));
  assert(appRuntimeSource.includes('getCabinAnnouncements, setAppServices'), 'app runtime should own cabin-announcement shared-service lookup');
  assert(settingsControllerSource.includes('getCabinAnnouncements = () => null'), 'settings controller should accept injected cabin-announcement access');
  assert(messageHandlersSource.includes('getCabinAnnouncements = () => null'), 'message handler should accept injected cabin-announcement access');
  assert(cabinAnnouncementsSource.includes('export const cabinAnnouncementsApi'));
  assert(cabinAnnouncementsSource.includes('export function initCabinAnnouncementsRuntime'));
  assert(!cabinAnnouncementsSource.includes('app-shared.js'));
  assert(appShellSource.includes("setAppService('cabinAnnouncements', cabinAnnouncementsRuntime);"));
  assert(appShellSource.includes("setAppService('cabinAnnouncements', null);"));
  assert(!appBootstrapSource.includes("setAppService('cabinAnnouncements'"));
  assert(!appBootstrapSource.includes('initCabinAnnouncementsRuntime'));
  assert(!cabinAnnouncementsSource.includes('runtime-bridge.js'), 'cabin announcement runtime should receive Vue state from AppShell instead of the bridge');
  assert(cabinAnnouncementsSource.includes("from '../app/shared-globals.js';"), 'cabin announcement runtime should use the shared globals bridge for phases');
  assert(!appHeaderSource.includes('toggleCabinAnnouncementsMuted'), 'AppHeader should not expose PA mute clicks');
  assert(!cabinAnnouncementsSource.includes('window.CabinAnnouncements ='));
  assert(!cabinAnnouncementsSource.includes('globalThis.FlightPhases'), 'cabin announcement runtime should not read phase globals directly');
  assert(mockLandingSource.includes('export function initMockLandingRuntime'));
  assert(!mockLandingSource.includes('app-shared.js'));
  assert(!landingPanelSource.includes('initMockLandingRuntime'), 'LandingPanel should not ship mock landing runtime initialization');
  assert(!landingPanelSource.includes('mockLandingRuntime'), 'LandingPanel should not retain mock landing runtime state');
  assert(!appBootstrapSource.includes('initMockLandingRuntime'), 'app bootstrap should not initialize mock landing runtime');
  assert(!mockLandingSource.includes('window.__mockLanding ='));
  assert(!approachProfileSource.includes('window.__approachProfile ='));
});

test('profiles store exposes no profile-file mutation bindings', () => {
  const profilesStoreSource = readRepoFile('frontend/src/vue/stores/profiles.js');
  const profilesRuntimeSource = readRepoFile('frontend/src/profiles/runtime.js');

  for (const retiredAction of ['importProfile', 'copyProfileToLocal', 'deleteUserProfile', 'requestImportFile']) {
    assert(!profilesStoreSource.includes(retiredAction), `${retiredAction} should stay absent from the profiles store`);
    assert(!profilesRuntimeSource.includes(retiredAction), `${retiredAction} should stay absent from the profiles runtime`);
  }
  assert(!profilesRuntimeSource.includes('FileReader'), 'profiles runtime should not read imported profile files');
  assert(!profilesRuntimeSource.includes('confirm'), 'profiles runtime should not bind mutation confirmations');
});

test('simbrief store delegates clipboard writes through runtime bindings', () => {
  const simbriefStoreSource = readRepoFile('frontend/src/vue/stores/simbrief.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(simbriefStoreSource.includes('const copyRouteActionBound = ref(false);'), 'SimBrief store should expose whether route-copy actions are bound');
  assert(simbriefStoreSource.includes('copyRouteText = null,'), 'SimBrief runtime binding should accept a route-copy action');
  assert(!simbriefStoreSource.includes('navigator.clipboard.writeText'), 'SimBrief store should not write to navigator.clipboard directly');
  assert(appRuntimeSource.includes('copyRouteText: async (text) => {'), 'app runtime should bind clipboard writes into the SimBrief store');
});

test('settings desktop actions delegate through store/runtime bindings', () => {
  const settingsUiStoreSource = readRepoFile('frontend/src/vue/stores/settings-ui.js');
  const settingsRuntimeSource = readRepoFile('frontend/src/settings/runtime.js');
  const msfsModalSource = readRepoFile('frontend/src/vue/components/MsfsInstallsModal.vue');
  const settingsAboutSource = readRepoFile('frontend/src/vue/components/SettingsAboutLegal.vue');

  assert(settingsUiStoreSource.includes('bindDesktopActions({'), 'settings UI store should expose explicit desktop-action bindings');
  assert(settingsUiStoreSource.includes('async requestMsfsInstallDetection()'), 'settings UI store should own the MSFS detection action flow');
  assert(settingsUiStoreSource.includes('async requestStorageLocations()'), 'settings UI store should own storage-location loading');
  assert(settingsUiStoreSource.includes('async requestOpenStorageLocation(location)'), 'settings UI store should own storage-location opening');
  assert(settingsUiStoreSource.includes('async requestCopyStorageLocationPath(location)'), 'settings UI store should own storage-location copying');
  assert(settingsUiStoreSource.includes('async requestOpenLegalFile(filename)'), 'settings UI store should own legal-file opening');
  assert(settingsUiStoreSource.includes('async requestRevealLegalFolder()'), 'settings UI store should own legal-folder opening');
  assert(!settingsUiStoreSource.includes('window.electronAPI'), 'settings UI store should not read Electron globals directly');
  assert(msfsModalSource.includes('await settingsUi.requestMsfsInstallDetection();'), 'MSFS installs modal should route detection through the store');
  assert(settingsAboutSource.includes('await settingsUi.requestOpenStorageLocation(location);'), 'settings storage panel should route folder opening through the store');
  assert(settingsAboutSource.includes('await settingsUi.requestCopyStorageLocationPath(location);'), 'settings storage panel should route path copying through the store');
  assert(settingsAboutSource.includes("await settingsUi.requestOpenLegalFile(filename);"), 'settings legal panel should route legal-file opening through the store');
  assert(settingsAboutSource.includes('await settingsUi.requestRevealLegalFolder();'), 'settings legal panel should route legal-folder opening through the store');
  assert(!msfsModalSource.includes('window.electronAPI'), 'MSFS installs modal should not call Electron APIs directly');
  assert(!settingsAboutSource.includes('window.electronAPI'), 'settings legal panel should not call Electron APIs directly');
  assert(settingsRuntimeSource.includes('settingsUiStore?.bindDesktopActions?.({'), 'settings runtime should bind Electron-backed desktop actions into the store');
  assert(settingsRuntimeSource.includes('getStorageLocations: typeof windowRef.electronAPI?.getStorageLocations'), 'settings runtime should bind storage-location loading from Electron');
  assert(settingsRuntimeSource.includes('openStorageLocation: typeof windowRef.electronAPI?.revealInExplorer'), 'settings runtime should reuse the allowlisted Explorer reveal IPC for storage paths');
});

test('timeline flights panel delegates browser side effects through store/runtime bindings', () => {
  const timelineFlightsSource = readRepoFile('frontend/src/vue/components/TimelineFlightsPanel.vue');
  const timelineStoreSource = readRepoFile('frontend/src/vue/stores/timeline.js');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(timelineStoreSource.includes('bindPanelActions({'), 'timeline store should expose explicit flights-panel runtime bindings');
  assert(timelineStoreSource.includes('async requestDeleteFlight(flight)'), 'timeline store should own the delete-flight action flow');
  assert(timelineStoreSource.includes('async requestOpenStorageFolder()'), 'timeline store should own the open-folder action flow');
  assert(timelineStoreSource.includes('async requestCopyStoragePath()'), 'timeline store should own the copy-path action flow');
  assert(timelineStoreSource.includes('storagePathCopyLabel'), 'timeline store should own the copy-path button label');
  assert(timelineFlightsSource.includes('timeline.requestDeleteFlight(flight);'), 'timeline flights panel should route deletes through the timeline store');
  assert(timelineFlightsSource.includes('await timeline.requestOpenStorageFolder();'), 'timeline flights panel should route folder-open actions through the timeline store');
  assert(timelineFlightsSource.includes('await timeline.requestCopyStoragePath();'), 'timeline flights panel should route copy-path actions through the timeline store');
  assert(timelineFlightsSource.includes('{{ timeline.storagePathCopyLabel }}'), 'timeline flights panel should render the store-backed copy label');
  assert(!timelineFlightsSource.includes('window.confirm('), 'timeline flights panel should not call window.confirm directly');
  assert(!timelineFlightsSource.includes('window.alert('), 'timeline flights panel should not call window.alert directly');
  assert(!timelineFlightsSource.includes('window.prompt('), 'timeline flights panel should not call window.prompt directly');
  assert(!timelineFlightsSource.includes('window.electronAPI'), 'timeline flights panel should not depend on Electron APIs directly');
  assert(!timelineFlightsSource.includes('navigator.clipboard.writeText'), 'timeline flights panel should not write to the clipboard directly');
  assert(appRuntimeSource.includes('timelineStore?.bindPanelActions?.({'), 'app runtime should bind the timeline flights-panel runtime actions');
  assert(appRuntimeSource.includes('confirmDeleteFlight(message) {'), 'app runtime should own delete confirmations for the timeline panel');
  assert(appRuntimeSource.includes('async openStorageFolder(dir) {'), 'app runtime should own timeline storage-folder opening');
  assert(appRuntimeSource.includes('async copyStoragePath(dir) {'), 'app runtime should own timeline storage-path copying');
});

test('manual end-flight confirmation uses browser newlines', () => {
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');

  assert(
    appRuntimeSource.includes('End flight and save log now?\\n\\nThis will finalize the current flight recording.'),
    'manual end-flight confirmation should use JS newline escapes',
  );
  assert(
    !appRuntimeSource.includes('End flight and save log now?\\\\n\\\\nThis will finalize the current flight recording.'),
    'manual end-flight confirmation should not show literal backslash-n text',
  );
});

test('backend settings handler consumes the shared settings module', () => {
  const source = readRepoFile('backend/core/client-message-handler.js');
  assert(source.includes("require('../../shared/app-settings-shared.js')"));
  assert(source.includes('normalizeAppSettings(settings'));
  assert(source.includes('sanitizeSharedAppSettingsPatch('));
  assert(!source.includes('function sanitizeLiveSharingRelayUrl('));
  assert(!source.includes('function sanitizeObsSceneMap('));
});

test('retired live-sharing and OBS automation paths stay removed', () => {
  const configSource = readRepoFile('backend/core/config.js');
  const simbridgeCoreSource = readRepoFile('backend/core/simbridge-core.js');
  const settingsPanelsSource = readRepoFile('frontend/src/vue/components/SettingsFormPanels.vue');
  const normalized = sharedSettings.normalizeAppSettings({
    liveSharing: { enabled: true },
    obs: { enabled: true },
  });

  assert(!Object.hasOwn(normalized, 'liveSharing'), 'normalized settings should omit retired live-sharing state');
  assert(!Object.hasOwn(normalized, 'obs'), 'normalized settings should omit retired OBS automation state');
  assert(!configSource.includes('liveSharing'), 'backend config should omit retired live-sharing configuration');
  assert(!configSource.includes('OBS_ENABLED'), 'backend config should omit retired OBS automation configuration');
  assert(!simbridgeCoreSource.includes('live-sharing/client'), 'simbridge core should not load the retired live-sharing client');
  assert(!simbridgeCoreSource.includes("require('./obs-bridge')"), 'simbridge core should not load the retired OBS bridge');
  assert(!settingsPanelsSource.includes('settings-obs-panel'), 'settings UI should omit retired OBS automation controls');
});

test('frontend HTML and HTTP server expose the shared settings script', () => {
  const html = readRepoFile('frontend/index.html');
  const dashboardBootstrapSource = readRepoFile('frontend/src/app/bootstrap.js');
  const httpServer = readRepoFile('backend/core/http-server.js');
  assert(html.includes('type="module" src="src/app/bootstrap.js"'));
  assert(dashboardBootstrapSource.includes("import '../../app-settings-shared.js';"));
  assert(httpServer.includes("urlPath.match(/^\\/shared\\/.*\\.js$/)"));
  assert(httpServer.includes("'Cache-Control': 'no-store, max-age=0'"), 'local app assets should not let stale browser cache hide live-update fixes');
});

test('remote access defaults to local-only and LAN aircraft control is narrowly scoped', () => {
  const backendSettings = readRepoFile('backend/core/user-settings.js');
  const configSource = readRepoFile('backend/core/config.js');
  const wsBootstrap = readRepoFile('backend/core/ws-bootstrap.js');
  const httpServerSource = readRepoFile('backend/core/http-server.js');
  const simbridgeCore = readRepoFile('backend/core/simbridge-core.js');
  const launcherSource = readRepoFile('electron/launcher/index.html');
  const systemHostSource = readRepoFile('frontend/src/vue/stores/system-host.js');
  const systemTabSource = readRepoFile('frontend/src/vue/components/SystemTabShell.vue');
  const secondScreenGuideSource = readRepoFile('frontend/src/vue/components/SecondScreenGuide.vue');
  const appHeaderSource = readRepoFile('frontend/src/vue/components/AppHeader.vue');
  const aircraftControlSource = readRepoFile('frontend/src/aircraft/control-controller.js');

  assert.equal(sharedSettings.APP_SETTINGS_DEFAULTS.remoteAccess, false);
  assert.equal(sharedSettings.APP_SETTINGS_DEFAULTS.remoteAircraftControl, false);
  assert(/remoteAccess:\s*false/.test(backendSettings), 'backend user settings should default remote access to false');
  assert(/remoteAircraftControl:\s*false/.test(backendSettings), 'backend user settings should default LAN aircraft control to false');
  assert(configSource.includes("getSetting(userSettings, 'network.remoteAccess', 'REMOTE_ACCESS_ENABLE', false)"));
  assert(configSource.includes("getSetting(userSettings, 'network.remoteAircraftControl', 'REMOTE_AIRCRAFT_CONTROL_ENABLE', false)"));
  assert(wsBootstrap.includes("const wsBindAddress = remoteAccessEnable ? '0.0.0.0' : '127.0.0.1'"));
  assert(wsBootstrap.includes('host: wsBindAddress'));
  assert(httpServerSource.includes('function buildBootstrapPayload'), 'HTTP bootstrap should centralize token exposure policy');
  assert(httpServerSource.includes('isLoopbackRemoteAddress(req.socket?.remoteAddress)'), 'HTTP bootstrap should expose privileged WS token only to loopback clients');
  assert(httpServerSource.includes("wsAuthToken: isLoopbackClient ? wsAuthToken : ''"), 'LAN remote clients should bootstrap without privileged WS token');
  assert(httpServerSource.includes("aircraftControlToken: isLoopbackClient ? aircraftControlToken : ''"), 'LAN remote clients should not receive the aircraft-control pairing token from bootstrap');
  assert(httpServerSource.includes('networkInfo: isLoopbackClient'), 'only loopback bootstrap should expose LAN addresses for the desktop QR');
  assert(httpServerSource.includes("console.log('[http] Request:', req.method, requestPathname)"), 'HTTP request logging should omit query secrets');
  assert(!httpServerSource.includes("console.log('[http] Request:', req.method, requestUrl)"), 'HTTP request logging must not print aircraft pairing tokens');
  assert(simbridgeCore.includes('remoteAccessEnable: config.http?.remoteAccessEnable === true'));
  assert(simbridgeCore.includes('remoteAircraftControlEnable: config.http?.remoteAircraftControlEnable === true'));
  assert(simbridgeCore.includes("const aircraftControlToken = crypto.randomBytes(32).toString('hex')"), 'backend should generate a distinct per-session aircraft-control pairing token');
  assert(wsBootstrap.includes("extractTokenFromRequestUrl(info.req?.url, 'aircraftControlToken')"), 'WS bootstrap should read the dedicated pairing query parameter');
  assert(wsBootstrap.includes('isAircraftControlClient: hasAircraftControlScope'), 'WS bootstrap should attach only the narrow aircraft-control scope');
  assert(wsBootstrap.includes('isPrivateOrLoopbackRemoteAddress(remoteAddress)'), 'aircraft-control scope should require a private or loopback peer address');
  assert(wsBootstrap.includes('remoteAccessEnable') && wsBootstrap.includes('remoteAircraftControlEnable'), 'aircraft-control scope should require both LAN settings');
  assert(wsBootstrap.includes('requestedAircraftControlToken === aircraftControlToken'), 'aircraft-control scope should require the per-session pairing token');
  assert(!wsBootstrap.includes('isAircraftControlClient: hasValidToken'), 'privileged WS authentication and aircraft-control pairing must stay distinct');
  const messageHandler = readRepoFile('backend/core/client-message-handler.js');
  const messageAuthorization = readRepoFile('backend/core/client-message-authorization.js');
  assert(messageHandler.includes("require('./client-message-authorization')"), 'standard client messages should use the shared authorization policy');
  assert(simbridgeCore.includes("require('./client-message-authorization')"), 'simbridge special messages should use the shared authorization policy');
  assert(messageAuthorization.includes('AIRCRAFT_CONTROL_MESSAGE_TYPE_SET.has(messageType)'), 'only classified aircraft controls should use the LAN scope');
  assert(messageAuthorization.includes('client?.__ffAircraftControlClient === true'), 'authorization policy should require the scoped WS capability');
  assert(messageAuthorization.includes('TRUSTED_LAN_SAFE_READ_MESSAGE_TYPE_SET.has(messageType)'), 'LAN clients should be limited to an explicit safe-read allowlist');
  assert(/remoteAccess:\s*false/.test(launcherSource), 'launcher settings summary should default remote access to false');
  assert(launcherSource.includes('aircraftControlToken='), 'desktop Mobile Browser URL should carry the scoped pairing token');
  assert(launcherSource.includes('starting a new flight does not expire it'), 'launcher should distinguish backend-session pairing from a new flight');
  assert(systemHostSource.includes('fetchBrowserBootstrap'), 'loopback browser System UI should fetch bootstrap data for its phone QR');
  assert(systemHostSource.includes('const remoteViewerUrl = computed'), 'phone URL construction should retain its token-free fallback');
  assert(systemHostSource.includes('const remoteControlPairingUrl = computed'), 'phone URL construction should retain the current session token URL');
  assert(systemHostSource.includes('remoteControlPairingUrl.value || remoteViewerUrl.value'), 'phone setup should choose one best URL without redistributing received tokens');
  assert(systemTabSource.includes(':value="systemHost.remoteBrowserUrl"'), 'the single phone QR must use the best available phone URL');
  assert.equal((systemTabSource.match(/<RemoteBrowserQr/g) || []).length, 1, 'PC setup should render only one phone QR choice');
  assert(!systemTabSource.includes(':value="systemHost.remoteViewerUrl"') && !systemTabSource.includes(':value="systemHost.remoteControlPairingUrl"'), 'PC setup should not expose separate viewer and control choices');
  assert(systemTabSource.includes('Starting a new flight does not require another scan'), 'PC setup should explain that new flights do not rotate the backend token');
  assert(secondScreenGuideSource.includes('New flights appear automatically'), 'phone onboarding should explain repeat-flight behavior');
  assert(secondScreenGuideSource.includes('only after the Flight Fabric backend restarts'), 'phone onboarding should explain when control re-pairing is required');
  assert(appHeaderSource.includes('id="header-mobile-access-btn"'), 'desktop header should expose an obvious Phone setup action');
  assert(aircraftControlSource.includes('choose Phone, then scan the QR shown there'), 'read-only control attempts should point directly to the single phone QR');
});

test('remote access UI warns users to stay on trusted private networks', () => {
  const settingsPanelsSource = readRepoFile('frontend/src/vue/components/SettingsFormPanels.vue');
  const httpServerSource = readRepoFile('backend/core/http-server.js');

  assert(settingsPanelsSource.includes('Allow trusted LAN access'), 'settings toggle should frame remote access as trusted-LAN access');
  assert(settingsPanelsSource.includes('id="setting-remote-access-warning"'), 'settings panel should render a trusted-LAN warning when enabled');
  assert(settingsPanelsSource.includes('public/shared networks'), 'settings panel should warn against public/shared networks');
  assert(settingsPanelsSource.includes("http://localhost:{{ settings.httpPort || '8100' }}/setup"), 'settings panel should reveal the setup URL only in the enabled warning');
  assert(httpServerSource.includes('Trusted LAN only.'), 'mobile setup page should warn that LAN access is trusted-network only');
  assert(httpServerSource.includes('public/shared networks'), 'mobile setup page should warn against public/shared networks');
});

test('websocket no longer exposes online catalog request handlers', () => {
  const source = readRepoFile('backend/core/client-message-handler.js');
  assert(!source.includes("case 'listRemoteAircraftProfiles'"));
  assert(!source.includes("case 'installRemoteAircraftProfile'"));
});

test('frontend shared bootstrap is used across the core tabs', () => {
  const dashboardBootstrapSource = readRepoFile('frontend/src/app/bootstrap.js');
  const timelineTabShellSource = readRepoFile('frontend/src/vue/components/TimelineTabShell.vue');
  const timelineBootstrapSource = readRepoFile('frontend/src/timeline/bootstrap.js');
  const profileSelectorSource = readRepoFile('frontend/src/vue/components/AircraftProfileSelector.vue');
  const profilesRuntimeSource = readRepoFile('frontend/src/profiles/runtime.js');
  const settingsShellSource = readRepoFile('frontend/src/vue/components/SettingsTabShell.vue');
  const liveMapShellSource = readRepoFile('frontend/src/vue/components/LiveMapTabShell.vue');
  const liveMapRuntimeSource = readRepoFile('frontend/src/live-map/runtime.js');
  const logbookPanelSource = readRepoFile('frontend/src/vue/components/LogbookPanel.vue');
  const logbookRuntimeSource = readRepoFile('frontend/src/logbook/runtime.js');

  assert(!dashboardBootstrapSource.includes('initLiveMapRuntime'), 'dashboard bootstrap should not own the Live Map runtime lifecycle');
  assert(liveMapShellSource.includes('initLiveMapRuntime({'), 'LiveMapTabShell should own the Live Map runtime lifecycle');
  assert(!liveMapRuntimeSource.includes('runtime-bridge.js'), 'live-map runtime should receive stores from its Vue shell instead of using the runtime bridge');
  assert(!dashboardBootstrapSource.includes('initLogbookRuntime'), 'dashboard bootstrap should not own the Logbook runtime lifecycle');
  assert(logbookPanelSource.includes('initLogbookRuntime({'), 'LogbookPanel should own the Logbook runtime lifecycle');
  assert(!logbookRuntimeSource.includes('runtime-bridge.js'), 'logbook runtime should receive stores from its Vue panel instead of using the runtime bridge');
  assert(!dashboardBootstrapSource.includes('initProfilesRuntime'), 'dashboard bootstrap should not own the profiles runtime lifecycle');
  assert(profileSelectorSource.includes('initProfilesRuntime({'), 'AircraftProfileSelector should own the profiles runtime lifecycle');
  assert(!profilesRuntimeSource.includes('runtime-bridge.js'), 'profiles runtime should receive stores from its selector component instead of using the runtime bridge');
  assert(!dashboardBootstrapSource.includes('initSettingsRuntime'), 'dashboard bootstrap should not own the Settings runtime lifecycle');
  assert(settingsShellSource.includes('initSettingsRuntime({'), 'SettingsTabShell should own the Settings runtime lifecycle');
  assert(!dashboardBootstrapSource.includes('initTimelinePage'), 'dashboard bootstrap should not own the Timeline runtime lifecycle');
  assert(timelineTabShellSource.includes('initTimelinePage({'), 'TimelineTabShell should own the Timeline runtime lifecycle');
  assert(!timelineBootstrapSource.includes('runtime-bridge.js'), 'timeline bootstrap should receive stores from its Vue shell instead of using the runtime bridge');
  assert(!timelineBootstrapSource.includes('window.__flightFabricApp || {}'), 'timeline bootstrap should not inline appShared bootstrap');
});

test('main tab scaffold is owned by the Vue bootstrap', () => {
  const html = readRepoFile('frontend/index.html');
  const vueMain = readRepoFile('frontend/src/vue/main.js');
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const mainShellSource = readRepoFile('frontend/src/vue/components/MainContentShell.vue');
  const timelineTabShellSource = readRepoFile('frontend/src/vue/components/TimelineTabShell.vue');

  assert(html.includes('id="vue-app-root"'), 'index.html should expose one Vue-owned app root');
  assert(!html.includes('id="vue-main-root"'), 'raw HTML should not own the main application shell');
  assert(!html.includes('id="tab-flight"'), 'raw HTML should not own tab panels after the shell migration');
  assert(vueMain.includes('AppShell'), 'Vue bootstrap should mount the top-level app shell');
  assert(appShellSource.includes('id="vue-main-root"'), 'app shell should render the main runtime target');
  assert(appShellSource.includes('MainContentShell'), 'app shell should compose the main content shell');
  assert(mainShellSource.includes('id="tab-flight"'), 'main shell should render flight tab section');
  assert(mainShellSource.includes('id="tab-livemap"'), 'main shell should render live map tab section');
  assert(mainShellSource.includes('TimelineTabShell'), 'main shell should compose the timeline tab shell');
  assert(timelineTabShellSource.includes('id="timeline-card"'), 'timeline tab shell should preserve timeline controller target');
});

test('frontend runtime does not fetch remote executable scripts', () => {
  const frontendRoot = path.join(ROOT_DIR, 'frontend');
  const sourceFiles = listRepoFiles(
    path.join(frontendRoot, 'src'),
    (filePath) => /\.(js|vue|html)$/.test(filePath),
  ).concat(
    listRepoFiles(frontendRoot, (filePath) => {
      const relative = path.relative(frontendRoot, filePath).replace(/\\/g, '/');
      return !relative.includes('/')
        && /\.(js|html)$/.test(filePath)
        && !relative.endsWith('package-lock.json');
    }),
  );

  const offenders = sourceFiles
    .filter((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      return /script\.src\s*=\s*['"]https?:\/\//.test(source)
        || /<script[^>]+src=["']https?:\/\//i.test(source);
    })
    .map((filePath) => path.relative(ROOT_DIR, filePath).replace(/\\/g, '/'));

  assert.deepStrictEqual(offenders, []);
});

test('frontend dynamic UI text is not interpolated into executable HTML hotspots', () => {
  const feedbackSource = readRepoFile('frontend/src/ui/feedback.js');
  const warningsSource = readRepoFile('frontend/src/telemetry/warnings.js');
  const widgetSource = readRepoFile('frontend/widgets-compact/widget.html');

  assert(!/\$\{label\}/.test(feedbackSource), 'busy button labels should be assigned with textContent');
  assert(!/banner\.innerHTML\s*=/.test(warningsSource), 'warning banners should use text nodes for dynamic text');
  assert(widgetSource.includes('aria-label="${escapeHtml(key)}"'), 'LVAR widget accessibility labels should escape profile-provided keys');
  assert(widgetSource.includes('${escapeHtml(value)}'), 'LVAR widget values should escape profile-provided values');
});

test('helper scripts avoid shell-string OpenSky credential commands', () => {
  const helperPath = path.join(ROOT_DIR, 'scripts/real-flight-data/opensky-simple.js');
  if (!fs.existsSync(helperPath)) {
    console.log('  SKIP helper scripts avoid shell-string OpenSky credential commands (scripts/real-flight-data absent)');
    return;
  }

  const source = fs.readFileSync(helperPath, 'utf8');
  assert(source.includes('execFileSync'), 'OpenSky helper should use argv-based process execution');
  assert(!source.includes('execSync('), 'OpenSky helper should not interpolate credentials into shell strings');
  assert(source.includes('new URLSearchParams'), 'OpenSky helper should form OAuth payloads structurally');
});

test('data sources shell is owned by the Vue bootstrap', () => {
  const html = readRepoFile('frontend/index.html');
  const vueMain = readRepoFile('frontend/src/vue/main.js');
  const appShellSource = readRepoFile('frontend/src/vue/components/AppShell.vue');
  const footerSource = readRepoFile('frontend/src/vue/components/AppFooter.vue');
  const appRuntimeSource = readRepoFile('frontend/src/app/runtime.js');
  const lvarInspectorSource = readRepoFile('frontend/src/data-sources/lvar-inspector-controller.js');
  assert(html.includes('vue-app-root'));
  assert(appShellSource.includes('vue-footer-root'));
  assert(footerSource.includes('vue-datasources-button-root'));
  assert(appShellSource.includes('vue-datasources-modal-root'));
  assert(footerSource.includes('DataSourcesButton'));
  assert(appShellSource.includes('DataSourcesModal'));
  assert(vueMain.includes('AppShell'));
  assert(appRuntimeSource.includes("requireRuntimeStore(runtimeStores, 'lvarInspector')"), 'app runtime should resolve the LVAR inspector store from the injected store bundle');
  assert(appRuntimeSource.includes('lvarInspectorStore,'), 'app runtime should inject the LVAR inspector store into the controller');
  assert(!lvarInspectorSource.includes('runtime-bridge.js'), 'LVAR inspector controller should receive its store from app runtime');
  assert(!lvarInspectorSource.includes('getVueStore'), 'LVAR inspector controller should not pull its store from the Vue bridge');
});

test('release-owned profile store keeps catalogs and file administration removed', () => {
  const storeSource = readRepoFile('frontend/src/vue/stores/profiles.js');

  assert(!storeSource.includes('getRemoteAircraftProfileInstallState('));
  assert(!storeSource.includes('listRemoteAircraftProfiles'));
});

if (failed > 0) {
  console.error(`\nDRY guard tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nDRY guard tests: ${passed} passed, ${failed} failed`);
