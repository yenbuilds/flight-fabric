#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { getRepoScratchPath } = require('./repo-scratch');

const repoRoot = path.join(__dirname, '..', '..');
const frontendRoot = path.join(repoRoot, 'frontend');
const cacheRoot = getRepoScratchPath('vue-component-test-cache');
const compilerSfc = require(path.join(frontendRoot, 'node_modules', '@vue', 'compiler-sfc', 'dist', 'compiler-sfc.cjs.js'));
const sharedSettings = require(path.join(repoRoot, 'shared', 'app-settings-shared.js'));
const { PHASES, PUBLISHED_PHASES } = require(path.join(repoRoot, 'shared', 'flight-phases.js'));

const vueModuleUrl = pathToFileURL(path.join(frontendRoot, 'node_modules', 'vue', 'index.mjs')).href;
const vueServerRendererUrl = pathToFileURL(path.join(frontendRoot, 'node_modules', 'vue', 'server-renderer', 'index.mjs')).href;
const piniaModuleUrl = pathToFileURL(path.join(frontendRoot, 'node_modules', 'pinia', 'dist', 'pinia.mjs')).href;
const floatingUiVueUrl = pathToFileURL(path.join(frontendRoot, 'node_modules', '@floating-ui', 'vue', 'dist', 'floating-ui.vue.mjs')).href;

function toFrontendUrl(...segments) {
  return pathToFileURL(path.join(frontendRoot, ...segments)).href;
}

function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

function installBrowserGlobals(options = {}) {
  const storage = options.storage || createStorage();
  const windowRef = globalThis;

  windowRef.window = windowRef;
  windowRef.document = options.document || {};
  windowRef.localStorage = storage;
  windowRef.matchMedia = options.matchMedia || (() => ({ matches: false }));
  windowRef.navigator = options.navigator || { clipboard: null };
  windowRef.WebSocket = { OPEN: 1 };
  windowRef.FlightFabricAppSettings = sharedSettings;
  windowRef.FlightPhases = { PHASES, PUBLISHED_PHASES };
  windowRef.confirm = () => true;
  windowRef.alert = () => {};
  windowRef.prompt = () => '';
  windowRef.setTimeout = windowRef.setTimeout || setTimeout;
  windowRef.clearTimeout = windowRef.clearTimeout || clearTimeout;

  return { storage, windowRef };
}

function clearBrowserGlobals() {
  delete globalThis.document;
  delete globalThis.electronAPI;
  delete globalThis.localStorage;
  delete globalThis.matchMedia;
  delete globalThis.navigator;
  delete globalThis.WebSocket;
  delete globalThis.FlightFabricAppSettings;
  delete globalThis.FlightPhases;
  delete globalThis.confirm;
  delete globalThis.alert;
  delete globalThis.prompt;
  globalThis.window = globalThis;
}

function normalizeHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const compiledVueCache = new Map();
const compiledJavaScriptCache = new Map();

function hashId(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function rewriteSpecifier(specifier, sourceFilename) {
  if (specifier === 'vue') {
    return vueModuleUrl;
  }
  if (specifier === '@floating-ui/vue') {
    return floatingUiVueUrl;
  }
  if (!specifier.startsWith('.')) {
    return specifier;
  }

  const resolvedPath = path.resolve(path.dirname(sourceFilename), specifier);
  if (specifier.endsWith('.vue')) {
    return pathToFileURL(compileVueComponent(resolvedPath)).href;
  }
  if (
    specifier.endsWith('.js')
    && fs.readFileSync(resolvedPath, 'utf8').includes('.vue')
  ) {
    return pathToFileURL(compileJavaScriptModule(resolvedPath)).href;
  }
  return pathToFileURL(resolvedPath).href;
}

function rewriteImportSpecifiers(code, sourceFilename) {
  let rewritten = code.replace(/from\s+(['"])([^'"]+)\1/g, (match, quote, specifier) => {
    return `from ${quote}${rewriteSpecifier(specifier, sourceFilename)}${quote}`;
  });

  rewritten = rewritten.replace(/import\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (match, quote, specifier) => {
    return `import(${quote}${rewriteSpecifier(specifier, sourceFilename)}${quote})`;
  });

  return rewritten;
}

function compileVueComponent(filename) {
  const normalizedFilename = path.normalize(filename);
  if (compiledVueCache.has(normalizedFilename)) {
    return compiledVueCache.get(normalizedFilename);
  }

  const source = fs.readFileSync(normalizedFilename, 'utf8');
  let { descriptor } = compilerSfc.parse(source, { filename: normalizedFilename });
  if (!descriptor.script && !descriptor.scriptSetup) {
    descriptor = compilerSfc.parse(`${source}\n<script setup>\nconst __templateOnly = true;\n</script>\n`, {
      filename: normalizedFilename,
    }).descriptor;
  }
  const script = compilerSfc.compileScript(descriptor, {
    id: hashId(normalizedFilename),
    inlineTemplate: true,
  });

  const outputPath = path.join(
    cacheRoot,
    `${path.relative(frontendRoot, normalizedFilename).replace(/\\/g, '/')}.mjs`,
  );

  const outputCode = rewriteImportSpecifiers(script.content, normalizedFilename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputCode, 'utf8');

  compiledVueCache.set(normalizedFilename, outputPath);
  return outputPath;
}

function compileJavaScriptModule(filename) {
  const normalizedFilename = path.normalize(filename);
  if (compiledJavaScriptCache.has(normalizedFilename)) {
    return compiledJavaScriptCache.get(normalizedFilename);
  }

  const outputPath = path.join(
    cacheRoot,
    `${path.relative(frontendRoot, normalizedFilename).replace(/\\/g, '/')}.mjs`,
  );
  compiledJavaScriptCache.set(normalizedFilename, outputPath);

  const source = fs.readFileSync(normalizedFilename, 'utf8');
  const outputCode = rewriteImportSpecifiers(source, normalizedFilename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputCode, 'utf8');
  return outputPath;
}

async function main() {
  fs.rmSync(cacheRoot, { recursive: true, force: true });

  const [{ createSSRApp }, { renderToString }, { createPinia, setActivePinia }] = await Promise.all([
    import(vueModuleUrl),
    import(vueServerRendererUrl),
    import(piniaModuleUrl),
  ]);

  const [
    { useSettingsFormStore },
    { useSettingsUiStore },
    { useSettingsEditorStore },
    { useTabsStore },
    { useLiveMapStore },
    { useAppSettingsStore },
    { useAircraftControlsStore },
    { useAircraftSpecificStore },
    { useVoiceControlStore },
    { useTimelineStore },
    { usePreferencesStore },
    { useStatusStore },
    { useFeedbackStore },
    { useDebugStore },
    { useLandingStore },
    { useLvarInspectorStore },
    { useLogbookStore },
    { useFlightStore },
    { useSimbriefStore },
    { useProfilesStore },
    { useSystemHostStore },
    { useDataSourcesUiStore },
    { AIRCRAFT_CONTROL_BUTTON_SELECTOR },
    { resolveAircraftSpecificTemplate },
    { mcpDraftKey, submitMcpDraft },
    { triggerFenixThrottleHaptic },
  ] = await Promise.all([
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-form.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-ui.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-editor.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'tabs.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'live-map.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'app-settings.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'aircraft-controls.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'aircraft-specific.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'voice-control.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'timeline.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'preferences.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'status.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'feedback.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'debug.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'landing.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'lvar-inspector.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'logbook.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'flight.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'simbrief.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'profiles.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'system-host.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'data-sources-ui.js')),
    import(toFrontendUrl('src', 'aircraft', 'control-ui.js')),
    import(toFrontendUrl('src', 'vue', 'aircraft-specific', 'template-registry.js')),
    import(toFrontendUrl('src', 'vue', 'components', 'aircraft-specific', 'mcp-input.js')),
    import(toFrontendUrl('src', 'vue', 'aircraft-specific', 'paired-throttle-detents.js')),
  ]);

  let passed = 0;
  let failed = 0;

  async function renderComponent(relativePath, configure = () => {}, options = {}) {
    clearBrowserGlobals();
    const context = installBrowserGlobals(options);
    const pinia = createPinia();
    setActivePinia(pinia);

    await configure({
      useAppSettingsStore,
      useAircraftControlsStore,
      useAircraftSpecificStore,
      useVoiceControlStore,
      useLiveMapStore,
      useLogbookStore,
      usePreferencesStore,
      useSimbriefStore,
      useSettingsFormStore,
      useSettingsUiStore,
      useSettingsEditorStore,
      useStatusStore,
      useTabsStore,
      useTimelineStore,
      useFlightStore,
      useProfilesStore,
      useSystemHostStore,
      useDataSourcesUiStore,
      useFeedbackStore,
      useDebugStore,
      useLandingStore,
      useLvarInspectorStore,
    });

    const componentPath = path.join(frontendRoot, relativePath);
    const compiledUrl = `${pathToFileURL(compileVueComponent(componentPath)).href}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const componentModule = await import(compiledUrl);
    const app = createSSRApp(componentModule.default, options.props || {});
    app.use(pinia);
    const html = await renderToString(app);

    return {
      html: normalizeHtml(html),
      storage: context.storage,
    };
  }

  async function test(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  [FAIL] ${name}`);
      console.error(`    ${error.message}`);
    }
  }

  console.log('\n=== Vue Component SSR Tests ===\n');

  await test('Fenix throttle haptic uses one short capability-detected Android vibration', () => {
    const pulses = [];
    assert.equal(triggerFenixThrottleHaptic({
      vibrate(durationMs) {
        pulses.push(durationMs);
        return true;
      },
    }), true, 'a supported phone should accept the detent pulse');
    assert.deepEqual(pulses, [12], 'a detent tap should produce one subtle 12 ms pulse');
    assert.equal(triggerFenixThrottleHaptic({}), false, 'desktop Electron should safely do nothing');
    assert.equal(triggerFenixThrottleHaptic({ vibrate() { throw new Error('blocked'); } }), false, 'browser refusal must never break the throttle command');
  });

  await test('MCP draft submission rejects empty values without dispatching zero', async () => {
    const calls = [];
    const result = submitMcpDraft({
      config: { actionId: 'mcp.heading.set', fieldId: 'flightGuidance.headingDeg', min: 0, max: 359, step: 1 },
      disabled: false,
      groupId: 'mcp.heading',
      rawValue: '   ',
      requestAction: (...args) => {
        calls.push(args);
        return true;
      },
    });

    assert.equal(result, false, 'a cleared numeric input must fail closed');
    assert.deepEqual(calls, [], 'a cleared numeric input must not become a zero-valued aircraft command');
  });

  await test('MCP numeric drafts dispatch one validated target', async () => {
    const calls = [];
    const config = {
      actionId: 'mcp.altitude.set',
      fieldId: 'flightGuidance.altitudeFt',
      min: 0,
      max: 60000,
      step: 100,
    };
    const result = submitMcpDraft({
      config,
      disabled: false,
      groupId: 'mcp.altitude',
      rawValue: '12500',
      requestAction: (...args) => {
        calls.push(args);
        return true;
      },
    });

    assert.equal(result, true, 'valid typed target should dispatch');
    assert.deepEqual(calls, [['mcp.altitude.set', 'mcp.altitude', 12500]], 'submission should send one exact target');
    assert.equal(submitMcpDraft({
      config,
      disabled: false,
      groupId: 'mcp.altitude',
      rawValue: '12550',
      requestAction: (...args) => calls.push(args),
    }), false, 'off-step altitude must fail validation');
    assert.equal(calls.length, 1, 'invalid target must never dispatch');
  });

  await test('iniBuilds A330 typed altitude dispatches its exact action, group, and value', async () => {
    const calls = [];
    const config = {
      actionId: 'flightGuidance.altitude.set',
      fieldId: 'flightGuidance.altitudeFt',
      min: 0,
      max: 49000,
      step: 100,
    };

    assert.equal(submitMcpDraft({
      config,
      disabled: false,
      groupId: 'flightGuidance.altitude',
      rawValue: '37100',
      requestAction: (...args) => {
        calls.push(args);
        return true;
      },
    }), true, 'an aligned A330 altitude target should dispatch');
    assert.deepEqual(
      calls,
      [['flightGuidance.altitude.set', 'flightGuidance.altitude', 37100]],
      'the typed target must retain the exact A330 action, physical-control group, and numeric value',
    );

    assert.equal(submitMcpDraft({
      config,
      disabled: false,
      groupId: 'flightGuidance.altitude',
      rawValue: '37150',
      requestAction: (...args) => calls.push(args),
    }), false, 'an off-step A330 altitude target should fail closed');
    assert.equal(calls.length, 1, 'an invalid A330 target must not dispatch');
  });

  await test('FlyByWire A380X typed altitude dispatches one bounded exact target', async () => {
    const calls = [];
    const config = {
      actionId: 'flightGuidance.altitude.set',
      fieldId: 'flightGuidance.altitudeFt',
      min: 0,
      max: 49000,
      step: 100,
    };

    assert.equal(submitMcpDraft({
      config,
      disabled: false,
      groupId: 'flightGuidance.altitude',
      rawValue: '49000',
      requestAction: (...args) => {
        calls.push(args);
        return true;
      },
    }), true, 'the documented upper altitude target should dispatch');
    assert.deepEqual(
      calls,
      [['flightGuidance.altitude.set', 'flightGuidance.altitude', 49000]],
      'A380X typed altitude must retain its exact action, physical-control group, and value',
    );

    for (const invalidTarget of ['49050', '49100', '']) {
      assert.equal(submitMcpDraft({
        config,
        disabled: false,
        groupId: 'flightGuidance.altitude',
        rawValue: invalidTarget,
        requestAction: (...args) => calls.push(args),
      }), false, `invalid A380X altitude target ${invalidTarget || '(empty)'} should fail closed`);
    }
    assert.equal(calls.length, 1, 'invalid A380X targets must never dispatch');
  });

  await test('FlyByWire A380X numeric drafts reconcile availability and pending readback', async () => {
    const componentPath = path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'aircraft-specific',
      'templates',
      'FbwA380xAircraftPanel.vue',
    );
    const componentUrl = `${pathToFileURL(compileVueComponent(componentPath)).href}?t=a380-draft-lifecycle-${Date.now()}`;
    const { reconcileA380NumericDraftState } = await import(componentUrl);
    const profileKey = 'bundled/msfs/fbw-a380x';
    const snapshot = (overrides = {}) => ({
      rawValue: 37000,
      unavailable: false,
      profileKey,
      sourceStatus: 'connected',
      pending: false,
      ...overrides,
    });
    const previous = (overrides = {}) => {
      const value = snapshot(overrides);
      return [value.rawValue, value.unavailable, value.profileKey, value.sourceStatus, value.pending];
    };

    const rejected = { draft: '41000', dirty: true, error: 'Command could not be sent.' };
    assert.deepEqual(
      reconcileA380NumericDraftState(rejected, snapshot(), previous()),
      rejected,
      'an available rejected A380X target should remain editable',
    );
    assert.deepEqual(
      reconcileA380NumericDraftState(
        rejected,
        snapshot({ unavailable: true, pending: true }),
        previous(),
      ),
      { draft: '', dirty: false, error: '' },
      'field loss must clear stale A380X target intent even while the group is pending',
    );

    const accepted = { draft: '41000', dirty: false, error: '' };
    assert.deepEqual(
      reconcileA380NumericDraftState(accepted, snapshot({ rawValue: 37000, pending: true }), previous()),
      accepted,
      'an accepted A380X target should remain visible until pending readback completes',
    );
    assert.deepEqual(
      reconcileA380NumericDraftState(
        accepted,
        snapshot({ rawValue: 41000 }),
        previous({ rawValue: 37000, pending: true }),
      ),
      { draft: '41000', dirty: false, error: '' },
      'pending completion should reconcile the A380X input to fresh live readback',
    );
  });

  await test('iniBuilds A330 numeric drafts clear on field unavailability without regressing pending or rejection state', async () => {
    const componentPath = path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'aircraft-specific',
      'templates',
      'IniBuildsA330AircraftPanel.vue',
    );
    const componentUrl = `${pathToFileURL(compileVueComponent(componentPath)).href}?t=a330-draft-lifecycle-${Date.now()}`;
    const { reconcileA330NumericDraftState } = await import(componentUrl);
    const profileKey = 'bundled/msfs/inibuilds-a330';
    const snapshot = (overrides = {}) => ({
      rawValue: 250,
      unavailable: false,
      profileKey,
      sourceStatus: 'connected',
      pending: false,
      ...overrides,
    });
    const previous = (overrides = {}) => {
      const value = snapshot(overrides);
      return [value.rawValue, value.unavailable, value.profileKey, value.sourceStatus, value.pending];
    };

    const rejected = { draft: '310', dirty: true, error: 'Command could not be sent.' };
    assert.deepEqual(
      reconcileA330NumericDraftState(rejected, snapshot(), previous()),
      rejected,
      'an available rejected draft and its inline error should remain editable',
    );

    const unavailable = reconcileA330NumericDraftState(
      rejected,
      snapshot({ unavailable: true, pending: true }),
      previous(),
    );
    assert.deepEqual(
      unavailable,
      { draft: '', dirty: false, error: '' },
      'field unavailability must clear stale intent and errors even when the control group is pending',
    );

    const restoredWhilePending = reconcileA330NumericDraftState(
      unavailable,
      snapshot({ rawValue: 270, pending: true }),
      previous({ unavailable: true, pending: true }),
    );
    assert.deepEqual(
      restoredWhilePending,
      unavailable,
      'a field returning during a pending command must wait for pending reconciliation',
    );

    assert.deepEqual(
      reconcileA330NumericDraftState(
        restoredWhilePending,
        snapshot({ rawValue: 275 }),
        previous({ rawValue: 270, pending: true }),
      ),
      { draft: '275', dirty: false, error: '' },
      'the draft should repopulate from the latest live readback after pending clears',
    );

    assert.deepEqual(
      reconcileA330NumericDraftState(
        { draft: '300', dirty: false, error: '' },
        snapshot({ pending: true }),
        previous(),
      ),
      { draft: '300', dirty: false, error: '' },
      'an accepted target should remain visible while its control group is pending',
    );

    assert.deepEqual(
      reconcileA330NumericDraftState(
        rejected,
        snapshot({ sourceStatus: 'disconnected' }),
        previous(),
      ),
      { draft: '', dirty: false, error: '' },
      'disconnect should continue clearing the draft and validation state',
    );
  });

  await test('Fenix FCU drafts discard stale intent and reconcile accepted targets to live readback', async () => {
    const componentPath = path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'aircraft-specific',
      'templates',
      'FenixA32xAircraftPanel.vue',
    );
    const componentUrl = `${pathToFileURL(compileVueComponent(componentPath)).href}?t=fenix-draft-lifecycle-${Date.now()}`;
    const {
      reconcileFenixSelectorDraftState,
      resolveFenixSelectorSubmitState,
    } = await import(componentUrl);
    const snapshot = (overrides = {}) => ({
      rawValue: 250,
      unavailable: false,
      profileKey: 'bundled/msfs/fenix-a320',
      profileRevision: 8,
      sourceStatus: 'connected',
      pending: false,
      machMode: false,
      ...overrides,
    });
    const previous = (overrides = {}) => {
      const value = snapshot(overrides);
      return [
        value.rawValue,
        value.unavailable,
        value.profileKey,
        value.profileRevision,
        value.sourceStatus,
        value.pending,
        value.machMode,
      ];
    };
    const staleDraft = {
      draft: '310',
      dirty: true,
      error: 'Old validation error.',
      accepted: false,
    };

    for (const [label, current, prior] of [
      ['disconnect', snapshot({ sourceStatus: 'disconnected' }), previous()],
      ['field unavailability', snapshot({ unavailable: true }), previous()],
      ['Mach mode', snapshot({ rawValue: 0.78, machMode: true }), previous()],
      ['profile revision change', snapshot({ profileRevision: 9 }), previous()],
    ]) {
      assert.deepEqual(
        reconcileFenixSelectorDraftState(staleDraft, current, prior),
        { draft: '', dirty: false, error: '', accepted: false },
        `${label} must discard stale Fenix target intent`,
      );
    }

    const accepted = { draft: '310', dirty: false, error: '', accepted: true };
    assert.deepEqual(
      reconcileFenixSelectorDraftState(accepted, snapshot({ pending: true }), previous()),
      accepted,
      'an accepted target should remain visible while its physical knob group is pending',
    );
    assert.deepEqual(
      reconcileFenixSelectorDraftState(accepted, snapshot({ rawValue: 275 }), previous({ pending: true })),
      { draft: '275', dirty: false, error: '', accepted: false },
      'pending completion must reconcile the textbox to the latest live value even after backend rejection',
    );
    assert.deepEqual(
      reconcileFenixSelectorDraftState(staleDraft, snapshot({ rawValue: 260, pending: true }), previous()),
      { draft: '260', dirty: false, error: '', accepted: false },
      'unrelated pending activity must not preserve an unsent stale draft on the shared knob',
    );

    const immediateRejection = resolveFenixSelectorSubmitState(
      { draft: '310', dirty: true, error: '', accepted: false },
      false,
    );
    assert.equal(immediateRejection.draft, '310', 'an immediate send rejection should preserve the editable target');
    assert.equal(immediateRejection.dirty, true, 'an immediate send rejection should remain user-owned');
    assert.equal(immediateRejection.accepted, false, 'an immediate send rejection must never gain pending ownership');
    assert.match(immediateRejection.error, /could not be sent/i, 'an immediate send rejection should explain the failure');

    assert.deepEqual(
      resolveFenixSelectorSubmitState(staleDraft, true),
      { draft: '310', dirty: false, error: '', accepted: true },
      'an accepted target should own reconciliation until its pending command completes',
    );
  });

  await test('Fenix FCU drafts enforce the active altitude increment before dispatch', async () => {
    const calls = [];
    const thousandStepConfig = {
      actionId: 'flightGuidance.altitudeThousand.set',
      fieldId: 'flightGuidance.altitudeFt',
      min: 0,
      max: 49000,
      step: 1000,
    };

    assert.equal(submitMcpDraft({
      config: thousandStepConfig,
      disabled: false,
      groupId: 'flightGuidance.altitude',
      rawValue: '12500',
      requestAction: (...args) => calls.push(args),
    }), false, 'a 500-foot target must not pass while the live FCU step is 1000 feet');
    assert.deepEqual(calls, [], 'an off-step Fenix target must not dispatch');

    assert.equal(submitMcpDraft({
      config: thousandStepConfig,
      disabled: false,
      groupId: 'flightGuidance.altitude',
      rawValue: '12000',
      requestAction: (...args) => {
        calls.push(args);
        return true;
      },
    }), true, 'an aligned Fenix altitude target should dispatch');
    assert.deepEqual(
      calls,
      [['flightGuidance.altitudeThousand.set', 'flightGuidance.altitude', 12000]],
      'the validated target must retain the exact active-step action and shared physical-control group',
    );
  });

  await test('MCP drafts are isolated across selector modes with different units', async () => {
    const iasKey = mcpDraftKey({ actionId: 'mcp.ias.set', fieldId: 'flightGuidance.speedKts' }, 'speed');
    const machKey = mcpDraftKey({ actionId: 'mcp.mach.set', fieldId: 'flightGuidance.mach' }, 'speed');
    const vsKey = mcpDraftKey({ actionId: 'mcp.verticalSpeed.set', fieldId: 'flightGuidance.vsFpm' }, 'vertical');
    const fpaKey = mcpDraftKey({ actionId: 'mcp.fpa.set', fieldId: 'flightGuidance.fpaDeg' }, 'vertical');

    assert.notEqual(iasKey, machKey, 'an IAS draft must never be reused as Mach');
    assert.notEqual(vsKey, fpaKey, 'a vertical-speed draft must never be reused as FPA');
  });

  await test('Aircraft section headings keep space when no subheading follows', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /\[data-aircraft-template\]\s+\.dashboard-section-kicker:not\(:has\(\+ p\)\)\s*\{[\s\S]*?margin-bottom:\s*0\.5rem;/,
      'aircraft headings without helper copy should not sit against the next control row',
    );
  });

  console.log('--- overlay layering ---\n');
  await test('Header chrome no longer carries theme switcher overlay CSS', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /#app-header\s*\{[\s\S]*?overflow:\s*visible;/,
      'sticky header should keep existing popovers visible',
    );
    assert.doesNotMatch(css, /\.theme-switcher\b/, 'removed theme switcher CSS should stay out of the bundle');
    assert.doesNotMatch(css, /\.theme-dropdown\b/, 'removed theme dropdown CSS should stay out of the bundle');
  });

  await test('Timeline altitude profile empty overlay remains hidden when data is present', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /\.timeline-altitude-profile-empty\.hidden\s*\{[\s\S]*?display:\s*none;/,
      'altitude empty overlay must not override the shared hidden class when a profile path is visible',
    );
  });

  await test('Leaflet map stacks stay below app modal overlays', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /\.live-map-wrap,\s*\.timeline-map-wrap\s*\{[\s\S]*?z-index:\s*0;[\s\S]*?isolation:\s*isolate;/,
      'map wrappers should isolate Leaflet panes so app modals remain on top',
    );
  });

  await test('Timeline PFD stays composited above Leaflet during map movement', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /#vue-timeline-pfd-root\s*\{[\s\S]*?z-index:\s*1100;[\s\S]*?transform:\s*translate3d\(0,\s*0,\s*0\);/,
      'timeline PFD root should remain in a compositor layer above Leaflet controls and panes',
    );
    assert.match(
      css,
      /\.timeline-map-wrap\s*>\s*#timeline-map,\s*\.timeline-map-wrap\s*>\s*\.timeline-map-surface\s*\{[\s\S]*?z-index:\s*0;/,
      'timeline map surface should stay pinned to the wrapper base layer',
    );
  });

  await test('Timeline replay map has a non-black local fallback surface', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /#timeline-map,\s*\.timeline-map-surface\s*\{[\s\S]*?radial-gradient[\s\S]*?linear-gradient\(90deg[\s\S]*?background-size:/,
      'timeline replay surface should have a local fallback background when tiles are missing',
    );
    assert.match(
      css,
      /\.leaflet-container\s*\{[\s\S]*?radial-gradient[\s\S]*?linear-gradient\(90deg[\s\S]*?background-size:/,
      'Leaflet itself should retain the fallback surface if tile loading fails',
    );
  });

  await test('Timeline replay map surface fills its flex wrapper without percentage-height collapse', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /\.timeline-map-wrap\s*>\s*#timeline-map,\s*\.timeline-map-wrap\s*>\s*\.timeline-map-surface\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*0;/,
      'timeline replay map should fill the wrapper by inset positioning instead of percentage height',
    );
  });

  await test('Timeline replay column stretches through the available desktop modal height', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /\.timeline-mobile-viewer-open\s*>\s*#vue-timeline-map-shell-root\s*\{[\s\S]*?align-self:\s*stretch;[\s\S]*?height:\s*100%;/,
      'desktop replay column should fill its grid row so the flex map can use the remaining height',
    );
  });

  await test('Timeline replay modal reserves useful mobile space for map and events', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /@media\s*\(max-width:\s*760px\)[^{]*\{[\s\S]*?\.timeline-split\.timeline-mobile-viewer-open\s*\{[\s\S]*?grid-template-rows:\s*auto\s+minmax\(18rem,\s*48dvh\)\s+minmax\(0,\s*1fr\);/,
      'mobile timeline modal should reserve a visible row for the replay map',
    );
    assert.match(
      css,
      /\.timeline-mobile-viewer-open\s+\.timeline-map-wrap\s*\{[\s\S]*?flex:\s*1\s+1\s+0;[\s\S]*?min-height:\s*clamp\(10rem,\s*25dvh,\s*14rem\);/,
      'mobile replay map wrapper should keep a usable map height',
    );
    assert.match(
      css,
      /\.timeline-mobile-viewer-open\s+#timeline-events\s*\{[\s\S]*?min-height:\s*8rem;[\s\S]*?padding:\s*0\.45rem\s+0\.55rem\s*!important;/,
      'mobile timeline events should keep enough scrollable room for multiple rows',
    );
  });

  await test('Collapsed timeline PFD toggle keeps an explicit in-map anchor box', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /#vue-timeline-pfd-root\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?z-index:\s*1100;[\s\S]*?pointer-events:\s*none;/,
      'timeline PFD mount should occupy an explicit overlay plane above the isolated map surface',
    );
    assert.match(
      css,
      /\.timeline-pfd-overlay\.pfd-collapsed\s*\{[\s\S]*?width:\s*1\.7rem;[\s\S]*?height:\s*1\.55rem;/,
      'collapsed PFD overlay should keep a real desktop-sized anchor box inside the map',
    );
    assert.match(
      css,
      /\.timeline-pfd-overlay\.pfd-collapsed\s+\.pfd-toggle-btn\s*\{[\s\S]*?position:\s*static;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/,
      'collapsed PFD toggle should fill its explicit anchor instead of positioning outside it',
    );
    assert.match(
      css,
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.timeline-pfd-overlay\.pfd-collapsed\s*\{[\s\S]*?width:\s*2\.5rem;[\s\S]*?height:\s*2\.5rem;/,
      'collapsed PFD overlay should match the mobile touch target size',
    );
  });

  await test('AppTooltip constrains floating panels to the viewport', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');
    const source = fs.readFileSync(path.join(frontendRoot, 'src', 'vue', 'components', 'AppTooltip.vue'), 'utf8');

    assert.match(source, /size\(\{[\s\S]*rootBoundary:\s*'viewport'[\s\S]*style\.maxWidth[\s\S]*style\.maxHeight[\s\S]*--app-tooltip-available-height/, 'tooltip middleware should directly clamp floating panels to the viewport');
    assert.match(source, /shift\(\{\s*padding:\s*8,\s*mainAxis:\s*true,\s*crossAxis:\s*true,\s*rootBoundary:\s*'viewport'\s*\}\)/, 'tooltip shift middleware should correct both vertical and horizontal viewport overflow');
    assert.match(source, /transform:\s*false/, 'tooltip coordinates should use left/top so the viewport clamp can correct final placement');
    assert.match(source, /clampFloatingToViewport\(\)[\s\S]*getBoundingClientRect\(\)[\s\S]*rect\.right\s*>\s*viewportWidth/, 'tooltip should clamp final rendered horizontal coordinates against the viewport');
    assert.match(source, /availableHeight[\s\S]*effectiveHeight[\s\S]*clampedTop[\s\S]*Math\.max\(VIEWPORT_PADDING,\s*Math\.min\(top,\s*maxTop\)\)/, 'tooltip should clamp final rendered vertical coordinates against the viewport');
    assert.match(css, /\.app-tooltip\s*\{[\s\S]*max-width:\s*min\(20rem,\s*var\(--app-tooltip-available-width/, 'tooltip CSS should clamp to Floating UI available width');
    assert.match(css, /\.app-tooltip\s*\{[\s\S]*white-space:\s*normal;/, 'tooltip copy should wrap rather than clip');
    assert.match(css, /\.app-tooltip\s*\{[\s\S]*pointer-events:\s*none;/, 'tooltip panels should never steal pointer events from their trigger');
  });

  console.log('--- settings pending bar ---\n');
  await test('SettingsPendingBar renders visible pending copy and busy actions inside the expected shell', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'SettingsPendingBar.vue'),
      ({ useSettingsFormStore }) => {
        const store = useSettingsFormStore();
        store.setPendingState(true, {
          title: 'Unsaved changes with restart-required updates',
          meta: 'Save to apply the new backend path.',
        });
        store.setSaveEnabled(true);
        store.setSaveBusy(true);
        store.setReloadBusy(true);
      },
    );

    assert.match(html, /id="settings-pending-bar"/, 'pending bar root should render');
    assert.match(html, /class="settings-pending-bar is-visible"/, 'pending bar should render as visible');
    assert.match(html, /class="settings-pending-shell"/, 'pending bar should keep its shell wrapper');
    assert.match(html, /Unsaved changes with restart-required updates/, 'custom pending title should render');
    assert.match(html, /Save to apply the new backend path\./, 'custom pending meta should render');
    assert.match(html, /id="settings-pending-save-btn"[^>]*\sdisabled(?:=| |>)/, 'pending save button should disable while the store reports a save in progress');
    assert.match(html, /id="settings-pending-save-btn"[\s\S]*Saving\.\.\./, 'pending save button label should render from store state');
    assert.match(html, /id="settings-pending-reload-btn"[^>]*\sdisabled(?:=| |>)/, 'pending reload button should disable while the store reports a reload in progress');
    assert.match(html, /id="settings-pending-reload-btn"[\s\S]*Reloading\.\.\./, 'pending reload button label should render from store state');
  });

  await test('SettingsTabShell renders settings runtime form and embedded panels', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'SettingsTabShell.vue'));
    const ids = [
      'settings-form',
      'vue-settings-form-root',
      'setting-update-checks',
      'setting-online-map-tiles',
      'vue-settings-action-bar-root',
      'settings-reveal-file-btn',
      'settings-save-btn',
      'settings-reload-btn',
      'vue-settings-pending-bar-root',
      'settings-pending-bar',
      'vue-settings-about-root',
      'about-safety-notice',
      'about-open-safety-btn',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for settings runtime`);
    }

    assert.match(html, /App Settings/, 'settings form title should render');
    assert.match(html, /settings file/, 'settings explanatory copy should render');
    assert.doesNotMatch(html, /id="setting-aircraft-profile"/, 'settings should not duplicate the compact profile correction selector');
    assert.doesNotMatch(html, /id="settings-aircraft-profile-tools"/, 'settings should not expose profile file mutation tools');
    assert.match(html, /release-owned, read-only compatibility profiles/, 'settings should describe profile ownership explicitly');
    assert.doesNotMatch(html, /id="settings-manage-profiles-btn"/, 'settings should not link to a retired Profiles workspace');
    assert.doesNotMatch(html, /FSX_SP2|FSX \/ P3D/, 'settings should not advertise the removed legacy simulator path');
    assert.match(
      html,
      /<option value="XPLANE_WEB" disabled(?:=""|)>X-Plane 12 Web API \(experimental, currently unavailable\)<\/option>/,
      'settings should show X-Plane as unavailable and prevent users from selecting it'
    );
    assert.doesNotMatch(html, /Storage Layout/, 'settings shell should not render the storage-layout reference panel');
    assert.match(html, /Allow trusted LAN access/, 'settings panel should frame remote access as trusted LAN access');
    assert.doesNotMatch(html, /id="setting-remote-aircraft-control"/, 'aircraft-control opt-in should stay hidden until trusted LAN access is enabled');
    assert.match(html, /Check for app updates/, 'settings panel should expose update checks');
    assert.match(html, /Use online map tiles/, 'settings panel should expose online map tile control');
    assert.match(html, /Automatically start recording flights/, 'settings panel should expose automatic recording control');
    assert.match(
      html,
      /aria-describedby="setting-recording-auto-start-help"[\s\S]*id="setting-recording-auto-start-help"[\s\S]*Starts recording when a flight is detected\. Recordings are stored locally and can be deleted from the Logbook\./,
      'automatic recording control should explain its trigger, local storage, and deletion path',
    );
    assert.match(html, /id="setting-cabin-announcements-warning"[\s\S]*Experimental[\s\S]*timing can vary/, 'cabin audio panel should describe the phase-triggered PA audio timing limitation professionally');
    assert.doesNotMatch(html, /settings-debug-panel|setting-debug-mode|Backend Debug Logging/, 'settings should not expose backend debug logging');
    assert.match(html, /Keep this off on public or shared networks\./, 'remote access help should warn against public or shared networks');
    assert.match(html, /after startup and then daily/, 'update checks help should describe low-cadence checks');
    assert.match(html, /Turn this off for a fully quiet app\./, 'update checks help should describe quiet-app behavior');
    assert.match(html, /OpenFreeMap/, 'online map help should identify the basemap provider');
    assert.match(html, /dark vector basemap/, 'online map help should identify the dark map style');
    assert.match(html, /Turn this off to avoid third-party map traffic/, 'online map help should describe third-party map traffic');
    assert.match(html, /About Flight Fabric/, 'about panel should render inside shell');
    assert.match(html, /AGPL-3\.0-only/, 'about panel should render the project AGPL license identifier');
    assert.match(html, /License \(AGPLv3\)/, 'about panel license button should describe the bundled AGPL license');
    assert.match(html, /id="about-source-offer"[\s\S]*complete corresponding source code/i, 'about panel should prominently offer corresponding source');
    assert.match(html, /id="about-source-link"[\s\S]*href="https:\/\/github\.com\/yenbuilds\/flight-fabric\/releases"[\s\S]*View Corresponding Source/, 'about panel should link to matching release source archives');
    assert.match(html, /not certified,[\s\S]*approved,[\s\S]*or intended for real-world aviation/, 'about panel should render the intended-use boundary');
    assert.match(html, /Do not rely on Flight Fabric/, 'about panel should render the non-reliance warning');
    assert.match(html, /non-excludable-rights,[\s\S]*and GNU AGPL qualifiers/, 'about panel should point to the complete bundled qualifiers');
    assert.match(html, /SAFETY-NOTICE\.md/, 'about panel should open the bundled safety notice file');
  });

  await test('SettingsFormPanels exposes the narrow trusted-LAN aircraft-control opt-in', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'SettingsFormPanels.vue'),
      ({ useSettingsEditorStore }) => {
        const settings = useSettingsEditorStore();
        settings.remoteAccess = true;
        settings.remoteAircraftControl = true;
      },
    );

    assert.match(html, /id="setting-remote-aircraft-control"/, 'trusted LAN settings should expose aircraft control separately');
    assert.match(html, /Allow aircraft controls from trusted LAN/);
    assert.match(html, /does not grant settings, recordings, history, file deletion, or profile management/);
    assert.match(html, /id="setting-remote-aircraft-control-warning"/);
  });

  await test('SettingsActionBar renders store-backed action labels, restart state, and save flash state', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'SettingsActionBar.vue'),
      ({ useSettingsFormStore, useSettingsUiStore }) => {
        const settingsForm = useSettingsFormStore();
        settingsForm.setSaveEnabled(true);
        settingsForm.setReloadBusy(true);
        settingsForm.startSaveFlash();

        const settingsUi = useSettingsUiStore();
        settingsUi.setRestartActionState({
          available: false,
          busy: false,
          title: 'Only available in the Electron app - click for details.',
        });
      },
    );

      assert.match(html, /id="settings-restart-app-btn"[^>]*\sdisabled(?:=| |>)/, 'restart action should render disabled from store state');
      assert.match(html, /Only available in the Electron app - click for details\./,
        'restart action tooltip copy should render from store state');
      assert.match(html, /id="settings-reload-btn"[^>]*\sdisabled(?:=| |>)/, 'reload action should render disabled while the store reports a reload in progress');
      assert.match(html, /id="settings-reload-btn"[\s\S]*Reloading\.\.\./, 'reload action label should render from store state');
      assert.match(html, /id="settings-save-btn"[^>]*save-flash/, 'save action should render the store-backed flash class');
      assert.doesNotMatch(html, /id="settings-save-btn"[^>]*\sdisabled(?:=| |>)/, 'save action should remain enabled when the form store allows saving');
      assert.match(html, /id="settings-save-btn"[\s\S]*Save Settings/, 'save action label should render the idle store copy');
    });

  console.log('\n--- desktop tabs ---\n');
  await test('DesktopTabs renders the configured nav and marks the active tab', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'DesktopTabs.vue'),
      ({ useTabsStore }) => {
        const store = useTabsStore();
        store.setActiveTab('flight');
      },
    );

    assert.doesNotMatch(html, /role="tablist"/, 'desktop nav should use regular navigation semantics instead of partial tab ARIA');
    assert.match(html, /data-tab="livemap"/, 'live tab should render');
    assert.match(html, /data-tab="flight"/, 'flight tab should render');
    assert.doesNotMatch(html, /data-tab="lvars"/, 'LVARs should stay out of the primary desktop nav');
    assert.match(html, />Settings</, 'settings tab should render');
    assert.match(html, />System</, 'system tab should render as a first-class desktop tab');
    assert.doesNotMatch(html, /role="tooltip"|app-tooltip/, 'desktop navigation should not render redundant tooltips');
    assert.match(html, /class="desktop-tab active"[^>]*data-tab="flight"|data-tab="flight"[^>]*class="desktop-tab active"/, 'active tab should carry the active class');
    assert.match(html, /data-tab="flight"[^>]*aria-current="page"|aria-current="page"[^>]*data-tab="flight"/, 'active desktop nav item should expose aria-current');
    assert.match(html, /data-tab="flight"[^>]*aria-controls="tab-flight"|aria-controls="tab-flight"[^>]*data-tab="flight"/, 'desktop nav items should point to their sections');
    assert.match(html, /data-tab="flight"[\s\S]*?>Overview</, 'flight tab should render the Overview label');
    assert.match(html, /data-tab="autopilot"[\s\S]*?>Aircraft</, 'controls tab should render the Aircraft label');
    assert.doesNotMatch(html, /Command Deck|Telemetry, control, and debrief/, 'desktop tabs should not render decorative copy');
  });

  await test('DesktopTabs marks Aircraft when control setup is required', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'DesktopTabs.vue'),
      ({ useAircraftSpecificStore }) => {
        useAircraftSpecificStore().applyDependencies({
          mobiflightEventModule: {
            required: true,
            connected: false,
            status: 'missing',
            scope: 'all-controls',
          },
        });
      },
    );

    assert.match(
      html,
      /data-tab="autopilot"[^>]*aria-label="Aircraft, setup required"/,
      'the Aircraft nav item should announce its setup state',
    );
    assert.match(html, /data-aircraft-setup-indicator/, 'the Aircraft nav item should show a compact amber indicator');
  });

  await test('MobileTabs keeps Aircraft primary and moves Overview under More', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'MobileTabs.vue'),
      ({ useTabsStore }) => {
        const store = useTabsStore();
        store.setActiveTab('autopilot');
      },
    );

    const moreButtonIndex = html.indexOf('id="mobile-more-btn"');
    const aircraftIndex = html.indexOf('data-tab="autopilot"');
    const overviewIndex = html.indexOf('data-tab="flight"');
    assert.ok(aircraftIndex >= 0 && aircraftIndex < moreButtonIndex, 'Aircraft should remain in the primary mobile navigation');
    assert.ok(overviewIndex > moreButtonIndex, 'Overview should render in the mobile More sheet');
    assert.match(html, /data-tab="autopilot"[\s\S]*?>Aircraft</, 'primary mobile navigation should label the control surface Aircraft');
    assert.match(html, /data-tab="flight"[\s\S]*?>Overview</, 'mobile More should label the monitoring surface Overview');
  });

  await test('MobileTabs marks Aircraft when control setup is required', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'MobileTabs.vue'),
      ({ useAircraftSpecificStore }) => {
        useAircraftSpecificStore().applyDependencies({
          mobiflightEventModule: {
            required: true,
            connected: false,
            status: 'disabled',
            scope: 'all-controls',
          },
        });
      },
    );

    assert.match(
      html,
      /data-tab="autopilot"[^>]*aria-label="Aircraft, setup required"/,
      'the primary mobile Aircraft item should announce its setup state',
    );
    assert.match(html, /data-aircraft-setup-indicator/, 'the primary mobile Aircraft item should show the amber dot');
  });

  await test('DesktopTabs keeps profile administration out of primary navigation', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'DesktopTabs.vue'),
      ({ useProfilesStore }) => {
        const profiles = useProfilesStore();
        profiles.installedProfiles = [{
          id: 'pmdg-737',
          namespace: 'local',
          simulator: 'msfs',
        }];
      },
    );

    assert.doesNotMatch(html, /data-tab="profiles"/, 'Profiles should not render as a primary workspace tab');
    assert.doesNotMatch(html, /id="profiles-update-badge"/, 'retired profile administration badges should remain absent');
  });

  console.log('\n--- main content shell ---\n');
  await test('MainContentShell renders the tab scaffold and embedded Vue panels', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'MainContentShell.vue'));
    const ids = [
      'vue-phase-mobile-root',
      'vue-desktop-tabs-root',
      'tab-flight',
      'vue-flight-tab-root',
      'tab-autopilot',
      'vue-autopilot-root',
      'tab-landing',
      'vue-landing-root',
      'tab-timeline',
      'vue-timeline-tab-root',
      'timeline-card',
      'vue-logbook-root',
      'vue-timeline-flights-root',
      'vue-timeline-inspector-shell-root',
      'vue-timeline-summary-root',
      'vue-timeline-detail-root',
      'vue-timeline-map-shell-root',
      'tab-livemap',
      'vue-live-map-tab-root',
      'tab-lvars',
      'vue-lvars-root',
      'tab-settings',
      'vue-settings-root',
      'tab-system',
      'vue-system-root',
      'tab-dispatch',
      'vue-simbrief-root',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render from the main Vue shell`);
    }
    assert.doesNotMatch(html, /id="tab-profiles"/, 'the retired Profiles workspace should not render in the main shell');
    assert.match(html, /id="tab-flight" class="tab-section active"/, 'Overview should keep the state-driven active marker for first paint');
    assert.doesNotMatch(html, /id="tab-livemap" class="tab-section active"/, 'Live should not remain the first-paint default');
  });

  await test('SecondScreenGuide hides its complete panel on mobile while retaining desktop guidance', async () => {
    globalThis.location = {
      pathname: '/remote',
      search: '?wsPort=9199',
    };
    try {
      const { html } = await renderComponent(
        path.join('src', 'vue', 'components', 'SecondScreenGuide.vue'),
        ({ useProfilesStore }) => {
          globalThis.location = {
            pathname: '/remote',
            search: '?wsPort=9199',
          };
          useProfilesStore().setAuthorizationScope('read-only');
        },
      );

      assert.match(html, /id="second-screen-guide"/, 'remote browser should render the first-run second-screen guide');
      assert.match(html, /id="second-screen-guide"[^>]*class="[^"]*\bhidden\b[^"]*min-\[641px\]:block/, 'the complete guide container should stay hidden through the mobile breakpoint');
      assert.match(html, /Keep this second screen for every flight/, 'guide should make repeat-flight behavior explicit');
      assert.match(html, /New flights appear automatically/, 'guide should tell users a new flight needs no scan');
      assert.match(html, /id="second-screen-control-status"[^>]*>\s*Viewer mode\s*</, 'guide should expose the current read-only state');
      assert.match(html, /choose <strong>Phone<\/strong> on the Flight Fabric PC/, 'read-only guidance should point to the discoverable PC action');
    } finally {
      delete globalThis.location;
    }
  });

  await test('SecondScreenGuide describes the unchanged pairing lifetime when controls are active', async () => {
    try {
      const { html } = await renderComponent(
        path.join('src', 'vue', 'components', 'SecondScreenGuide.vue'),
        ({ useProfilesStore }) => {
          globalThis.location = {
            pathname: '/remote',
            search: '?wsPort=9199&aircraftControlToken=fixture-token',
          };
          useProfilesStore().setAuthorizationScope('aircraft-control');
        },
      );

      assert.match(html, /id="second-screen-control-status"[^>]*>\s*Controls paired\s*</, 'paired phone should expose its acknowledged control state');
      assert.match(html, /stay paired for this backend session/, 'paired guidance should retain the backend-session security lifetime');
      assert.match(html, /only after the Flight Fabric backend restarts/, 'paired guidance should say when another scan is required');
    } finally {
      delete globalThis.location;
    }
  });

  await test('SecondScreenGuide identifies a saved Phone link with an expired pairing token', async () => {
    try {
      const { html } = await renderComponent(
        path.join('src', 'vue', 'components', 'SecondScreenGuide.vue'),
        ({ useProfilesStore }) => {
          globalThis.location = {
            pathname: '/remote',
            search: '?wsPort=9199&aircraftControlToken=expired-token',
          };
          useProfilesStore().setAuthorizationScope('read-only', 'expired');
        },
      );

      assert.match(html, /id="second-screen-control-status"[^>]*>\s*Pairing expired\s*</, 'stale paired URL should not be described as generic viewer mode');
      assert.match(html, /id="second-screen-pairing-expired"[^>]*>[\s\S]*scan the current QR/, 'stale pairing guidance should point to the current PC Phone QR');
      assert.match(html, /token changes whenever the backend restarts/, 'stale pairing guidance should explain why the saved token expired');
    } finally {
      delete globalThis.location;
    }
  });

  await test('SystemTabShell renders Electron service controls with browser-safe fallback copy', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'SystemTabShell.vue'));

    const ids = [
      'system-tab-shell',
      'system-browser-mode-note',
      'system-backend-service',
      'system-frontend-service',
      'system-mobile-access',
      'system-history-index',
      'system-history-index-status',
      'system-history-index-check-btn',
      'system-history-index-rebuild-btn',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render from the system tab shell`);
    }

    assert.doesNotMatch(html, /id="system-host-mode"/, 'system tab should not repeat the Electron host mode beside Refresh');
    assert.match(html, /Native service controls are only available in the Electron app/, 'browser fallback copy should render outside Electron');
    assert.match(html, /LAN IP unavailable/, 'system tab should not render localhost as a phone URL before a LAN IP is known');
    assert.doesNotMatch(html, /id="system-mobile-qr"/, 'system tab should not render a stale phone QR before a LAN URL is known');
    assert.match(html, /Scan to connect/, 'system tab should present one clear phone setup action');
    assert.doesNotMatch(html, /Settings And Recovery/, 'settings and recovery controls should not be duplicated in the system tab');
    assert.doesNotMatch(html, /Recovery Launcher/, 'recovery launcher should remain outside the dashboard in the tray menu');
    assert.match(html, /never edits or deletes a flight CSV/, 'history rebuild safety boundary should be explicit');
  });

  await test('SystemTabShell renders a QR code for the mobile browser URL', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'SystemTabShell.vue'),
      async ({ useSystemHostStore }) => {
        globalThis.electronAPI = {
          getBackendStatus: async () => ({ status: 'running' }),
          getHttpStatus: async () => ({ status: 'running', port: 8123 }),
          getBackendWsPort: async () => 9199,
          getBackendHttpPort: async () => 8100,
          getStartupHealth: async () => ({ ok: true }),
          getNetworkInfo: async () => ({ ips: ['10.0.0.5', '192.168.1.42'], httpPort: 8100, wsPort: 9199 }),
          getSettings: async () => ({ success: true, settings: { remoteAccess: true }, settingsFile: 'C:\\Users\\Pilot\\settings.json' }),
          getBackendBootstrap: async () => ({
            ok: true,
            body: { aircraftControlToken: 'fixture-aircraft-token', remoteAccessEnabled: true },
          }),
        };

        const store = useSystemHostStore();
        await store.refresh();
      },
    );

    assert.match(html, /id="system-remote-url"[^>]*>\s*http:\/\/192\.168\.1\.42:8100\/remote\?wsPort=9199&amp;aircraftControlToken=fixture-aircraft-token\s*</, 'system tab should render one current-session phone URL');
    assert.match(html, /id="system-mobile-pairing-note"[^>]*>[\s\S]*scan again only after the Flight Fabric backend restarts/, 'system tab should label the pairing lifetime accurately');
    assert.match(html, /Starting a new flight does not require another scan/, 'system tab should distinguish a new flight from a backend restart');
    assert.match(html, /id="system-alt-ips"[^>]*>\s*Other IPs: 10\.0\.0\.5\s*</, 'system tab should keep alternate IP fallback copy');
    assert.match(html, /id="system-mobile-qr"/, 'system tab should render one phone QR');
    assert.doesNotMatch(html, /id="system-viewer-qr"|id="system-control-pairing-qr"/, 'system tab should not split phone setup into viewer and control choices');
    assert.match(html, /role="img"[^>]*aria-label="QR code for http:\/\/192\.168\.1\.42:8100\/remote\?wsPort=9199&amp;aircraftControlToken=fixture-aircraft-token"/, 'QR should describe the paired encoded URL and custom WebSocket port');
    assert.equal((html.match(/role="img"/g) || []).length, 1, 'system tab should render exactly one phone QR');
    assert.match(html, /<path[^>]+d="M/, 'QR should render dark modules as an SVG path');
  });

  await test('SystemTabShell labels the current phone as paired while keeping its share link read-only', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.location = {
      origin: 'http://192.168.1.42:8100',
      protocol: 'http:',
      host: '192.168.1.42:8100',
      hostname: '192.168.1.42',
      port: '8100',
      pathname: '/remote',
      search: '?wsPort=9199&aircraftControlToken=received-phone-token',
    };
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        wsAuthToken: '',
        aircraftControlToken: '',
        remoteAccessEnabled: true,
        networkInfo: { ips: [], httpPort: null, wsPort: null },
      }),
    });

    try {
      const { html } = await renderComponent(
        path.join('src', 'vue', 'components', 'SystemTabShell.vue'),
        async ({ useSystemHostStore }) => {
          const store = useSystemHostStore();
          await store.refresh();
        },
      );

      assert.match(html, /id="system-remote-url"[^>]*>\s*http:\/\/192\.168\.1\.42:8100\/remote\?wsPort=9199\s*</, 'paired phone should display a token-free share URL that retains the working custom WebSocket port');
      assert.doesNotMatch(html, /received-phone-token/, 'paired phone should not render its received token into copy or QR markup');
      assert.match(html, /This browser is paired for aircraft controls in the current backend session/, 'paired phone should describe its actual current control state');
      assert.match(html, /id="system-mobile-qr"/, 'paired phone may show its safe token-free viewer URL as the single phone link');
      assert.doesNotMatch(html, /id="system-control-pairing-qr"/, 'paired phone should never receive a redistributable pairing QR');
    } finally {
      delete globalThis.location;
      globalThis.fetch = originalFetch;
    }
  });

  await test('SystemTabShell hides phone pairing while trusted-LAN access is inactive', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'SystemTabShell.vue'),
      async ({ useSystemHostStore }) => {
        globalThis.electronAPI = {
          getBackendStatus: async () => ({ status: 'running' }),
          getHttpStatus: async () => ({ status: 'running', port: 8123 }),
          getBackendWsPort: async () => 9199,
          getBackendHttpPort: async () => 8100,
          getStartupHealth: async () => ({ ok: true }),
          getNetworkInfo: async () => ({ ips: ['192.168.1.42'], httpPort: 8100, wsPort: 9199 }),
          getSettings: async () => ({ success: true, settings: { remoteAccess: true } }),
          getBackendBootstrap: async () => ({
            ok: true,
            body: { aircraftControlToken: 'fixture-aircraft-token', remoteAccessEnabled: false },
          }),
        };

        await useSystemHostStore().refresh();
      },
    );

    assert.match(html, /LAN access is off/, 'phone card should explain why pairing is unavailable');
    assert.match(html, /id="system-mobile-disabled-note"[^>]*>[\s\S]*restart the backend before pairing/, 'phone card should explain how to activate LAN access');
    assert.doesNotMatch(html, /id="system-mobile-qr"/, 'inactive LAN access must not render a QR code');
    assert.doesNotMatch(html, /id="system-mobile-copy-btn"/, 'inactive LAN access must not expose a copy action');
    assert.doesNotMatch(html, /fixture-aircraft-token/, 'inactive LAN access must not render the pairing token');
  });

  console.log('\n--- app shell ---\n');
  await test('AppShell renders the top-level application chrome and modal roots', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AppShell.vue'),
      ({ useStatusStore, useTabsStore }) => {
        const status = useStatusStore();
        status.ingestMessage({ type: 'phase', value: 'APPROACH' });

        const tabs = useTabsStore();
        tabs.setActiveTab('livemap');
      },
    );
    const ids = [
      'vue-system-banners-root',
      'vue-header-root',
      'ptr-indicator',
      'quick-glance',
      'vue-main-root',
      'vue-mobile-tabs-root',
      'vue-footer-root',
      'vue-datasources-modal-root',
      'vue-msfs-installs-modal-root',
      'vue-landing-metric-modal-root',
      'vue-debug-modal-root',
      'vue-app-feedback-toast-root',
      'tab-livemap',
      'vue-live-map-tab-root',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render from AppShell`);
    }
    assert.match(html, /id="ptr-indicator" class="ptr-indicator"[^>]*>\s*Pull to reconnect\s*</, 'pull-to-refresh target should render from tab state');
    assert.match(html, /id="quick-glance" class="quick-glance show"/, 'quick glance visibility should render from status state');
    assert.doesNotMatch(html, /vue-stopwatch-root|comp-stopwatch|comp-sw-toggle/, 'retired stopwatch chrome should not render from AppShell');
  });

  console.log('\n--- data sources ---\n');
  await test('DataSourcesButton uses generic SDK source metadata', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'DataSourcesButton.vue'),
      ({ useStatusStore }) => {
        const status = useStatusStore();
        status.primarySource = { type: 'simconnect', name: 'SimConnect', connected: true };
        status.secondarySources = [
          { type: 'lvar-sidecar', name: 'LVAR Sidecar', connected: true },
          { type: 'sdk', name: 'ClientData SDK', connected: true, categories: ['sdk', 'autopilot'] },
        ];
      },
    );

    assert.match(html, /SimConnect \+ LVAR \+ SDK/, 'button should recognize generic SDK sources');
    assert.match(html, /aria-label="View active data sources"/, 'button should expose its action without a visual tooltip');
    assert.doesNotMatch(html, /role="tooltip"[\s\S]*View active data sources/, 'toolbar data-source button should not render a redundant tooltip');
    assert.doesNotMatch(html, /pmdg-sdk/, 'button should not depend on a PMDG-specific source type');
  });

  await test('DataSourcesModal renders a flat source list without legacy source groups', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'DataSourcesModal.vue'),
      ({ useDataSourcesUiStore, useStatusStore }) => {
        useDataSourcesUiStore().openModal();
        const status = useStatusStore();
        status.ingestMessage({
          type: 'dataSources',
          primary: {
            type: 'rust-simvars',
            name: 'Rust SimVars',
            connected: true,
            description: 'primary - 138 live',
          },
          secondary: [{
            type: 'lvar-sidecar',
            name: 'LVAR Sidecar',
            connected: false,
            description: 'Disconnected',
          }],
          sources: [
            {
              type: 'rust-simvars',
              name: 'Rust SimVars',
              connected: true,
              description: 'primary - 138 live',
            },
            {
              type: 'lvar-sidecar',
              name: 'LVAR Sidecar',
              connected: false,
              description: 'Disconnected',
            },
          ],
        });
      },
    );

    assert.match(html, /Data Sources/, 'modal should render when the data sources UI is open');
    assert.match(html, /Rust SimVars/, 'modal should list Rust SimVars from the flat source list');
    assert.match(html, /primary - 138 live/, 'modal should preserve source descriptions');
    assert.match(html, /LVAR Sidecar/, 'modal should include other available sources');
    assert.doesNotMatch(html, /Primary Telemetry/, 'modal should not render the old primary telemetry group');
    assert.doesNotMatch(html, /Additional Sources/, 'modal should not render the old additional sources group');
    assert.doesNotMatch(html, /<strong>SimConnect<\/strong>/, 'modal should not show the old hardcoded SimConnect footer');
  });

  await test('LvarInspectorTab renders store-backed preview and debug rows', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LvarInspectorTab.vue'),
      ({ useLvarInspectorStore }) => {
        const store = useLvarInspectorStore();
        store.hydrateWatchList(['MY_CUSTOM_SWITCH']);
        store.ingestDataSourcesMessage({
          secondary: [{
            type: 'lvar-sidecar',
            connected: true,
            description: 'Running',
            preview: [{ key: 'L:MY_CUSTOM_TEST', value: 1.234 }],
            debugWatch: {
              count: 2,
              items: [{ expression: '(L:MY_CUSTOM_TEST, number)', value: 42, live: true }],
            },
          }],
        });
      },
    );

    assert.match(html, /id="lvars-status"[^>]*>Running</, 'LVAR status should render from the store');
    assert.match(html, /id="lvars-count"[^>]*>1 profile \/ 2 debug</, 'combined LVAR counts should render from the store');
    assert.match(html, /id="lvars-debug-summary"[^>]*>1 configured locally - monitoring live values</, 'monitoring summary should render from store state');
    assert.match(html, /MY_CUSTOM_SWITCH/, 'watch textarea should reflect the hydrated watch list');
    assert.match(html, /id="lvars-profile-count"[^>]*>1 var</, 'profile count should render singular copy');
    assert.match(html, /id="lvars-table-body"[\s\S]*L:MY_CUSTOM_TEST[\s\S]*1\.234/, 'profile preview rows should render from the store');
    assert.match(html, /id="lvars-debug-count"[^>]*>2 vars</, 'debug count should render from the store');
    assert.match(html, /id="lvars-debug-table-body"[\s\S]*L:MY_CUSTOM_TEST, number[\s\S]*>42<[\s\S]*>LIVE</, 'debug watch rows should render from the store');
  });

  console.log('\n--- app footer ---\n');
  await test('AppFooter renders footer actions and embedded Vue status controls', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AppFooter.vue'),
      ({ useDebugStore, useStatusStore }) => {
        const debug = useDebugStore();
        debug.setToggleVisible(true);

        const status = useStatusStore();
        status.setWebsocket('ready');
        status.ingestMessage({
          type: 'dataSources',
          primary: { type: 'simconnect', name: 'SimConnect', connected: true },
          secondary: [{ type: 'lvar-sidecar', name: 'LVAR Sidecar', connected: true }],
        });
        status.ingestMessage({
          type: 'simState',
          simconnectConnected: true,
          inMenu: false,
          lifecycleState: 'flying',
          inFlightContext: true,
        });
        status.setConnectionInfo('ws://127.0.0.1:8123');
        status.ingestMessage({
          type: 'surface',
          value: {
            onGround: true,
            name: 'ASPHALT',
            class: 'PAVED',
            runwayLike: true,
          },
        });
        status.ingestMessage({ type: 'runwayContext', icao: 'YSSY', runway: '34L' });
      },
    );

    assert.match(html, /id="app-version"/, 'footer should expose app version target');
    assert.match(html, /id="footer-source-link"[\s\S]*href="https:\/\/github\.com\/yenbuilds\/flight-fabric\/releases"[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"[\s\S]*Source \(AGPL\)/, 'footer should prominently link to corresponding release source');
    assert.match(html, /id="msfs-installs-btn"/, 'footer should expose MSFS installs button target');
    assert.match(html, /id="vue-datasources-button-root"/, 'footer should keep data sources wrapper id');
    assert.match(html, /SimConnect \+ LVAR/, 'embedded data sources button should render from status store');
    assert.match(html, /id="surface-indicator"[^>]*bg-emerald-500\/20[^>]*>ASPHALT</, 'footer surface indicator should render from status state');
    assert.match(html, /id="vue-footer-sim-status-root"/, 'footer should keep footer sim status wrapper id');
    assert.match(html, /id="menu-state-bottom"[^>]*>SIM: IN FLIGHT</, 'footer sim status should render through Vue');
    assert.match(html, /id="runway-context"[^>]*>YSSY 34L</, 'footer runway context should render from status state');
    assert.match(html, /id="debug-toggle-btn"/, 'footer should expose debug toggle target');
    assert.doesNotMatch(html, /id="debug-toggle-btn"[^>]*hidden/, 'footer debug toggle should render from debug store visibility state');
    assert.doesNotMatch(html, /Open telemetry debug panel/, 'footer debug toggle should not render tooltip copy');
    assert.match(html, /id="connection-info"[^>]*>ws:\/\/127\.0\.0\.1:8123</, 'footer connection info should render from status state');
    assert.match(html, /id="footer-open-lvars-btn"/, 'footer should expose the compact LVARs shortcut');
    assert.match(html, /id="footer-open-lvars-btn"[\s\S]*LVARs/, 'footer LVARs shortcut should render its label');
    assert.doesNotMatch(html, /data-tab="lvars"/, 'footer should not expose hidden tab-routing hooks');
  });

  console.log('\n--- app header ---\n');
  await test('AppHeader renders header runtime targets and embedded Vue status controls', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AppHeader.vue'),
      ({ useLiveMapStore, useProfilesStore, useStatusStore }) => {
        globalThis.electronAPI = {};
        useProfilesStore().setAuthorizationScope('full-control');
        const status = useStatusStore();
        status.bindHeaderActions({ onStartRecordingManual: () => true });
        status.setWebsocket('ready');
        status.ingestMessage({
          type: 'dataSources',
          primary: { type: 'simconnect', name: 'SimConnect', connected: true },
          secondary: [],
        });
        status.ingestMessage({ type: 'phase', value: 'CRUISE' });
        status.ingestMessage({
          type: 'simState',
          simconnectConnected: true,
          inMenu: false,
          lifecycleState: 'flying',
          inFlightContext: true,
        });
        status.ingestMessage({
          type: 'vreSampling',
          active: true,
          band: 'ULTRA_FIDELITY',
          targetRateHz: 10,
          effectiveRateHz: 10,
          rateHz: 10,
          shouldSample: false,
          reason: 'ground_proximity,vs_magnitude',
          phase: 'APPROACH',
          raFt: 240,
          vsFpm: -720,
          intervalMs: 100,
          nextSampleInMs: 40,
          ultraFidelityDisabled: false,
          ultraFidelityTimeRemaining: 59000,
          ultraFidelitySamplesRemaining: 590,
        });
        status.ingestMessage({
          type: 'assists',
          data: {
            landingAssist: true,
            unlimitedFuel: true,
          },
        });
        status.ingestMessage({
          type: 'flightRecording',
          status: 'recording',
          filePath: 'C:/Flights/active-flight.csv',
        });
        status.ingestMessage({ type: 'flightTime', elapsedHms: '01:23:45' });
        status.ingestMessage({
          type: 'aircraftProfile',
          profile: { name: 'Fenix A320 Profile', id: 'fenix-a320', aircraftTitle: 'Fenix A320 CFM' },
          provenance: {
            verificationStatus: 'verified',
            sourceCount: 3,
            lastVerified: '2026-05-01',
          },
        });
        status.setCabinAnnouncementsState({
          enabled: true,
          available: true,
          muted: true,
          playing: true,
        });

        const liveMap = useLiveMapStore();
        liveMap.setDestinationProgress({ visible: true, label: 'To KBOS', text: '120 NM', percent: 42 });
      },
    );

    const ids = [
      'app-header',
      'app-brand-logo',
      'legacy-status-annunciator',
      'status-dot',
      'status-text',
      'vue-status-root',
      'vue-flight-status-root',
      'header-mobile-access-btn',
      'assists-indicator',
      'assists-count',
      'assists-list',
      'sampling-indicator',
      'sampling-pill',
      'sampling-dot',
      'sampling-band',
      'sampling-rate',
      'sampling-reason',
      'sampling-decision',
      'sampling-last',
      'sampling-safety',
      'recording-indicator',
      'recording-path',
      'end-flight-btn',
      'flight-time',
      'aircraft-name',
      'aircraft-profile-name',
      'profile-badge',
      'vue-destination-progress-root',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for the header runtime`);
    }

    assert.match(html, /SimConnect/, 'embedded status strip should render websocket state');
    assert.match(html, /id="phase-badge"[^>]*>CRUISE</, 'header phase badge should render through Vue');
    assert.match(html, /id="menu-state-top"[^>]*>SIM: IN FLIGHT</, 'header sim badge should render through Vue');
    assert.doesNotMatch(html, /State: IN FLIGHT/, 'header sim badge should not render tooltip copy');
    assert.doesNotMatch(html, /id="assists-indicator"[^>]*class="hidden"/, 'assist indicator visibility should render from status state');
    assert.match(html, /id="assists-count"[^>]*>2</, 'assist count should render from status state');
    assert.match(html, /Landing Assist/, 'assist item names should render from status state');
    assert.match(html, /Unlimited Fuel/, 'assist status item should render from status state');
    assert.doesNotMatch(html, /id="theme-switcher"/, 'theme switcher should not render inside header shell');
    assert.match(html, /id="dest-progress-wrap"/, 'destination progress shell should render inside header shell');
    assert.match(html, /To KBOS/, 'destination progress should render live map store state');
    assert.doesNotMatch(html, /id="sampling-indicator"[^>]*class="hidden"/, 'sampling indicator visibility should render from status state');
    assert.match(html, /VRE ULTRA 10 Hz/, 'sampling summary should render the achievable rate from the status store');
    assert.match(html, /ULTRA at 10 Hz \(100 ms\)/, 'sampling detail should render the hard-capped Ultra cadence');
    assert.match(html, /ground proximity, vs magnitude/, 'sampling reasons should render from the status store');
    assert.match(html, /waiting 40 ms/, 'sampling decision should render from the status store');
    assert.match(html, /APPROACH RA 240 ft VS -720 fpm/, 'sampling frame should render from the status store');
    assert.doesNotMatch(html, /id="recording-indicator"[^>]*class="hidden"/, 'recording indicator visibility should render from status state');
    assert.match(html, />REC</, 'recording badge should render from status state');
    assert.match(html, /Saving to:/, 'recording detail label should render from status state');
    assert.match(html, /C:\/Flights\/active-flight\.csv/, 'recording path should render from status state');
    assert.doesNotMatch(html, /id="start-recording-btn"/, 'manual start-recording action should stay hidden while the recording pill is visible');
    assert.match(html, /id="end-flight-btn"/, 'manual end-flight action should keep its stable target');
    assert.match(html, /role="dialog"[^>]*app-tooltip-interactive[\s\S]*id="end-flight-btn"/, 'recording control popover should be interactive so the end-flight action can be clicked');
    assert.match(html, /id="flight-time"[^>]*>01:23:45</, 'flight time should render from status state');
    assert.doesNotMatch(html, /id="comp-sw-toggle"/, 'retired stopwatch toggle should not render in the header');
    assert.match(html, /id="aircraft-name"[^>]*>Fenix A320 CFM</, 'aircraft name should render the live sim title from status state');
    assert.match(html, /id="aircraft-profile-name"[^>]*>[\s\S]*Fenix A320 Profile[\s\S]*Auto match[\s\S]*verified profile</, 'profile name, automatic selection mode, and verification should render separately from the live sim title');
    assert.match(html, /id="aircraft-profile-correction-btn"/, 'header should expose a compact mismatch correction control');
    assert.match(html, /Wrong aircraft\?/, 'mismatch correction control should use concise user-facing copy');
    assert.match(html, /id="aircraft-profile-correction-select"/, 'mismatch correction should default to a compact profile selector');
    assert.match(html, /id="profile-badge"[^>]*text-emerald-500[^>]*>\u2713</, 'profile badge should render from status state');
    assert.doesNotMatch(html, /id="pa-indicator"/, 'PA indicator should not render in the header');
    assert.doesNotMatch(html, /Cabin PA playing/, 'PA indicator tooltip copy should not render in the header');
    assert.doesNotMatch(html, /id="cabin-ann-mute-btn"/, 'PA on/off button should not render in the header');
  });

  await test('AppHeader hides partial profile verification indicators', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AppHeader.vue'),
      ({ useStatusStore }) => {
        const status = useStatusStore();
        status.ingestMessage({
          type: 'aircraftProfile',
          profile: { name: 'PMDG 737 Profile', id: 'pmdg-737', aircraftTitle: 'PMDG 737-800' },
          provenance: {
            verificationStatus: 'partial',
            sourceCount: 2,
            lastVerified: '2026-07-31',
          },
        });
      },
    );

    assert.doesNotMatch(html, /id="profile-badge"/, 'partial verification should not render a header badge');
    assert.doesNotMatch(html, /Profile: partial/i, 'partial verification should not render tooltip copy');
  });

  await test('AppHeader renders the manual start-recording action only when it is actionable', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AppHeader.vue'),
      ({ useStatusStore }) => {
        const status = useStatusStore();
        status.bindHeaderActions({ onStartRecordingManual: () => true });
        status.setWebsocket('ready');
        status.ingestMessage({
          type: 'simState',
          simconnectConnected: true,
          inMenu: false,
          lifecycleState: 'flying',
          inFlightContext: true,
        });
        status.ingestMessage({ type: 'flightRecording', status: 'stopped' });
      },
    );

    assert.match(html, /id="start-recording-btn"/, 'manual start-recording action should render when it is available');
  });

  await test('AppHeader hides the manual start-recording action when simulator telemetry is disconnected', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AppHeader.vue'),
      ({ useStatusStore }) => {
        const status = useStatusStore();
        status.bindHeaderActions({ onStartRecordingManual: () => true });
        status.setWebsocket('ready');
        status.ingestMessage({ type: 'simState', simconnectConnected: false, inMenu: false });
        status.ingestMessage({ type: 'flightRecording', status: 'stopped' });
      },
    );

    assert.doesNotMatch(html, /id="start-recording-btn"/, 'manual start-recording action should stay hidden while SimConnect is offline');
  });

  await test('FlightStatusBadges hides the phase badge until a real phase is available', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'FlightStatusBadges.vue'),
      ({ useStatusStore }) => {
        const status = useStatusStore();
        status.ingestMessage({
          type: 'simState',
          simconnectConnected: true,
          inMenu: false,
          lifecycleState: 'flying',
          inFlightContext: true,
        });
      },
    );

    assert.doesNotMatch(html, /id="phase-badge"/, 'placeholder phase should not render an empty header badge');
    assert.match(html, /id="menu-state-top"[^>]*>SIM: IN FLIGHT</, 'sim badge should still render when the phase badge is hidden');
  });

  console.log('\n--- autopilot controls ---\n');
  await test('AutopilotTargetEditor renders a keyboard-safe one-thumb altitude tuner', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AutopilotTargetEditor.vue'),
      () => {},
      {
        props: {
          open: true,
          mode: 'alt',
          displayValue: '12,000',
          liveValue: 12000,
          requestApply: () => true,
        },
      },
    );

    assert.match(html, /role="dialog"/, 'focused tuner should expose modal dialog semantics');
    assert.match(html, /class="autopilot-target-overlay ff-keyboard-safe-overlay"/, 'focused tuner should stay inside the visual viewport');
    assert.match(html, /data-no-swipe/, 'focused tuner should suppress page-navigation gestures');
    assert.match(html, /id="autopilot-target-input-alt"/, 'focused tuner should expose a direct numeric target field');
    assert.match(html, />−1,000<|>−1000</, 'altitude tuner should expose a large coarse decrement');
    assert.match(html, />\+1,000<|>\+1000</, 'altitude tuner should expose a large coarse increment');
    assert.match(html, /Apply ALT/, 'focused tuner should keep one explicit submission action');
    assert.match(html, /Live target 12,000 FT/, 'focused tuner should distinguish the aircraft readback from the draft');
  });

  await test('AutopilotControlsTab renders the controller-owned control targets', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AutopilotControlsTab.vue'),
      ({ useAircraftControlsStore, useFlightStore }) => {
        const controls = useAircraftControlsStore();
        const flight = useFlightStore();
        controls.setAvailability({
          enabled: true,
          reason: 'Ready. Commands are checked against the active profile and provider safety gate.',
        });
        controls.setFeedback({
          actionText: 'Selected altitude 12000',
          routeText: 'Profile override - K:AP_ALT_VAR_SET_ENGLISH - SimConnect',
          profileText: 'bundled/msfs/pmdg-777',
        });
        controls.setCommandPending({ type: 'control', id: 'gearUp' });
        controls.setCommandPending({ type: 'selector-adjust', mode: 'hdg', action: 'inc10' });
        controls.applyControlCapabilities({
          surface: {
            parkingBrake: true,
            spoilersPosition: true,
            spoilersArm: true,
          },
          lights: {
            nav: true,
            beacon: true,
            strobe: true,
            landing: true,
            taxi: true,
          },
        });
        flight.setFlightState('live');
        flight.updateGear({ gearState: 'DOWN', left: 1, right: 1, nose: 1, parkingBrake: true });
        flight.updateFlaps({ value: { percent: 25 } });
        flight.updateSpoilers({ state: 'ARMED' });
        flight.updateLights({ available: true, nav: true, beacon: true, strobe: false, landing: true, taxi: false });
        controls.updateAutopilot({
          master: true,
          athrActive: true,
          fdActive: true,
          spdHold: true,
          hdgHold: false,
          altHold: true,
          vsHold: false,
          locHold: true,
          apprHold: true,
          lvlChgHold: false,
          spdTarget: 245,
          hdgTarget: 87,
          altTarget: 12000,
          vsTarget: -700,
        });
      },
    );
    const controlIds = AIRCRAFT_CONTROL_BUTTON_SELECTOR
      .split(',')
      .map((selector) => selector.trim())
      .filter((selector) => selector.startsWith('#'))
      .map((selector) => selector.slice(1));

    for (const id of controlIds) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for the legacy control controller`);
    }

    assert.match(html, /id="controls-availability-text"/, 'availability text target should render');
    assert.doesNotMatch(html, /Standard Aircraft Controls|id="controls-fallback-badge"|id="controls-experimental-badge"/, 'generic controls should not render the redundant fallback intro or status pills');
    assert.match(html, /Standard simulator controls are active because this aircraft does not have a dedicated control page\. Some add-ons may ignore these commands\./, 'collapsed diagnostics should retain the useful generic-control context');
    assert.match(html, /Control diagnostics/, 'status disclosure should be labeled as secondary diagnostics');
    assert.match(html, /<details id="controls-diagnostics"/, 'control status should render as a disclosure');
    assert.doesNotMatch(html, /<details id="controls-diagnostics"[^>]*\sopen(?:\s|>)/, 'control diagnostics should be collapsed by default');
    assert.match(html, /<summary id="controls-diagnostics-toggle"/, 'control diagnostics should expose a native keyboard-accessible toggle');
    assert.doesNotMatch(html, /Experimental Write Controls|Experimental Write Surface/, 'control tab should not repeat experimental write wording');
    assert.match(html, /id="controls-last-action"/, 'last action feedback target should render');
    assert.match(html, /id="controls-last-route"/, 'last route feedback target should render');
    assert.match(html, /id="controls-last-profile"/, 'last profile feedback target should render');
    assert.match(html, /class="controls-status-panel"/, 'control availability and feedback should render in one consolidated status panel');
    assert.equal((html.match(/class="controls-status-item"/g) || []).length, 3, 'consolidated control status panel should render three feedback items');
    assert.match(html, /class="controls-section"/, 'control groups should render in normalized app sections');
    assert.doesNotMatch(html, /Surfaces[\s\S]*id="ap-status-indicator"[\s\S]*Exterior Lights/, 'surface section should not own autopilot status');
    assert.match(html, /Autopilot[\s\S]*id="ap-status-indicator"/, 'autopilot section should own autopilot status');
    assert.equal((html.match(/controls-command-tooltip-anchor/g) || []).length, 2, 'surface command buttons should render without tooltip anchors');
    assert.match(html, /id="ap-capability-note"[\s\S]*Standard simulator writes are enabled for this profile\./, 'autopilot section should render a compact profile capability note');
    assert.doesNotMatch(html, /Profile-gated experimental write path/, 'autopilot header should not repeat experimental write-path wording');
    assert.doesNotMatch(html, /Selector writes use the currently displayed MCP targets/, 'autopilot header should not include implementation-detail copy');
    assert.match(html, /Ready\. Commands are checked against the active profile and provider safety gate\./, 'availability state should render from the store');
    assert.match(html, /Selected altitude 12000/, 'last action state should render from the store');
    assert.match(html, /Profile override - K:AP_ALT_VAR_SET_ENGLISH - SimConnect/, 'resolution state should render from the store');
    assert.match(html, /bundled\/msfs\/pmdg-777/, 'profile state should render from the store');
    assert.match(html, /id="ap-master-btn"[^>]*data-mode="master"|data-mode="master"[^>]*id="ap-master-btn"/, 'AP master should keep its data-mode');
    assert.equal((html.match(/class="[^"]*ap-engage-btn/g) || []).length, 4, 'selector hold buttons should render');
    assert.equal((html.match(/class="[^"]*ap-adj-btn/g) || []).length, 16, 'selector adjustment buttons should render');
    assert.equal((html.match(/class="autopilot-target-open ff-touch-target/g) || []).length, 4, 'each selector should expose the focused one-thumb tuner');
    assert.match(html, /Tap the value for large controls/, 'selector cards should explain the mobile tuning affordance');
    assert.match(html, /data-mode="spd"[^>]*data-action="dec10"|data-action="dec10"[^>]*data-mode="spd"/, 'speed decrement command should render');
    assert.match(html, /data-mode="alt"[^>]*data-action="inc1000"|data-action="inc1000"[^>]*data-mode="alt"/, 'altitude large increment command should render');
    assert.match(html, /id="ap-master-state"[^>]*>ON</, 'AP master state should render from the store');
    assert.match(html, /id="ap-athr-state"[^>]*>ACTIVE</, 'A\/T state should render from the store');
    assert.match(html, /id="ap-spd-value"[^>]*>245</, 'speed selector should render from the store');
    assert.match(html, /id="ap-hdg-value"[^>]*>087</, 'heading selector should render padded value from the store');
    assert.match(html, /id="ap-alt-value"[^>]*>12,000</, 'altitude selector should render from the store');
    assert.match(html, /id="ap-vs-value"[^>]*>-700</, 'vertical speed selector should render from the store');
    assert.match(html, /id="ap-spd-engaged"[^>]*>ON</, 'speed hold state should render from the store');
    assert.match(html, /id="ap-alt-engaged"[^>]*>ON</, 'altitude hold state should render from the store');
    assert.match(html, /id="ap-fd-state"[^>]*>ON</, 'flight director state should render from the store');
    assert.match(html, /id="ctrl-gear-up-btn"[^>]*\sdisabled(?:=| |>)/, 'pending surface commands should render disabled from store state');
    assert.match(html, /id="ctrl-gear-up-btn"[\s\S]*Sending\.\.\./, 'pending surface commands should render store-driven busy copy');
    assert.match(html, /id="ctrl-park-brake-set-btn"[\s\S]*Now SET/, 'parking-brake controls should include their live readback');
    assert.match(html, /id="ctrl-spoilers-arm-btn"[\s\S]*Now ARMED/, 'spoiler controls should include their live readback');
    assert.equal((html.match(/data-generic-light=/g) || []).length, 5, 'generic aircraft should render five standard exterior light groups');
    assert.match(html, /data-aircraft-search-label="LANDING light"/, 'compact light cards should remain discoverable by a natural search phrase');
    assert.match(html, /data-generic-light="landing"[\s\S]*>\s*ON\s*</, 'landing-light state should render from generic telemetry');
    assert.match(html, /id="ctrl-light-landing-off-btn"/, 'each generic light should expose an explicit OFF command');
    assert.match(html, /id="ctrl-light-landing-on-btn"/, 'each generic light should expose an explicit ON command');
    assert.match(html, /class="generic-light-command[^"]*"[^>]*aria-pressed="true"/, 'live light state should mark the matching explicit direction pressed');
    assert.match(html, /data-mode="hdg"[^>]*data-action="inc10"[^>]*\sdisabled(?:=| |>)/, 'pending selector adjustments should render disabled from store state');
  });

  await test('AutopilotControlsTab renders unknown autopilot data neutrally', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AutopilotControlsTab.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.updateAutopilot({
          master: null,
          athrArmed: null,
          athrActive: null,
          fdActive: null,
          spdHold: null,
          hdgHold: null,
          altHold: null,
          vsHold: null,
          locHold: null,
          navHold: null,
          apprHold: null,
          lvlChgHold: null,
        });
      },
    );

    assert.match(html, /id="ap-status-text"[^>]*>Unknown</, 'unknown AP status should not render as disengaged');
    assert.match(html, /id="ap-master-state"[^>]*>---</, 'unknown AP master should render as neutral placeholder');
    assert.match(html, /id="ap-athr-state"[^>]*>---</, 'unknown A\/T should render as neutral placeholder');
    assert.match(html, /id="ap-spd-engaged"[^>]*>---</, 'unknown speed hold should render as neutral placeholder');
    assert.match(html, /id="ap-fd-state"[^>]*>---</, 'unknown flight director state should render as neutral placeholder');
  });

  await test('AutopilotControlsTab disables unsupported profile AP writes without hiding readbacks', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AutopilotControlsTab.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({
          enabled: true,
          reason: 'Ready.',
        });
        controls.applyControlCapabilities({
          surface: {
            gearUp: false,
          },
          autopilot: {
            flightLevelChange: false,
            loc: false,
            app: false,
            heading: false,
          },
        });
        controls.updateAutopilot({
          master: true,
          fdActive: true,
          locHold: true,
          apprHold: true,
          lvlChgHold: true,
          hdgTarget: 87,
        });
      },
    );

    assert.match(html, /id="ctrl-gear-up-btn"[^>]*\sdisabled(?:=| |>)/, 'unsupported gear write should render disabled');
    assert.match(html, /id="ap-loc-btn"[^>]*\sdisabled(?:=| |>)/, 'unsupported LOC write should render disabled');
    assert.match(html, /id="ap-app-btn"[^>]*\sdisabled(?:=| |>)/, 'unsupported APP write should render disabled');
    assert.match(html, /id="ap-flc-btn"[^>]*\sdisabled(?:=| |>)/, 'unsupported FLC write should render disabled');
    assert.match(html, /data-mode="hdg"[^>]*data-action="inc10"[^>]*\sdisabled(?:=| |>)/, 'unsupported heading selector writes should render disabled');
    assert.match(html, /No mapped action is available for this aircraft profile/, 'unsupported controls should explain why they are disabled');
    assert.match(html, /id="ap-fd-state"[^>]*>ON</, 'flight director readback should still render');
  });

  console.log('\n--- lvar inspector ---\n');
  await test('LvarInspectorTab renders the controller-owned LVAR targets', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'LvarInspectorTab.vue'));
    const ids = [
      'lvars-status',
      'lvars-count',
      'lvars-debug-summary',
      'lvars-debug-input',
      'lvars-debug-apply',
      'lvars-debug-clear',
      'lvars-profile-count',
      'lvars-empty',
      'lvars-table-wrap',
      'lvars-table-body',
      'lvars-debug-count',
      'lvars-debug-empty',
      'lvars-debug-table-wrap',
      'lvars-debug-table-body',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for the LVAR inspector controller`);
    }

    assert.match(html, /No profile-driven LVAR data available/, 'profile empty state should render');
    assert.match(html, /No debug watch LVARs configured/, 'debug empty state should render');
  });

  console.log('\n--- debug telemetry modal ---\n');
  await test('DebugTelemetryModal renders the debug runtime targets', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'DebugTelemetryModal.vue'));
    const modalClass = html.match(/id="debug-modal"[^>]*class="([^"]*)"/)?.[1] || '';
    const ids = [
      'debug-modal',
      'debug-status-dot',
      'debug-status-text',
      'debug-filter',
      'debug-show-null',
      'debug-show-stale',
      'debug-pause',
      'debug-close',
      'debug-poll-rate',
      'debug-total-vars',
      'debug-active-vars',
      'debug-phase',
      'debug-frame-count',
      'debug-menu-indicator',
      'debug-shake-vs',
      'debug-test-shake',
      'debug-shake-status',
      'debug-content',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for the debug runtime`);
    }

    assert.equal(modalClass.split(/\s+/).includes('hidden'), true, 'debug modal should start hidden');
    assert.match(html, /Telemetry Debug/, 'debug modal title should render');
    assert.match(html, /Press Ctrl\+Shift\+D to close/, 'debug shortcut copy should render');
    assert.match(html, /Rate:/, 'debug message-rate label should render');
    assert.match(html, /msg\/s/, 'debug rate should identify websocket message units');
    assert.match(html, /Messages:/, 'debug count should identify websocket messages rather than telemetry frames');
    assert.match(html, /-400 fpm \(normal\)/, 'normal test-shake option should remain available');
    assert.match(html, /Waiting for data\.\.\./, 'debug content empty state should render');
  });

  await test('DebugTelemetryModal renders menu indicator from status store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'DebugTelemetryModal.vue'),
      ({ useStatusStore }) => {
        const status = useStatusStore();
        status.ingestMessage({
          type: 'simState',
          simconnectConnected: true,
          inMenu: true,
          lifecycleState: 'MENU',
          inFlightContext: false,
        });
      },
    );

    assert.match(html, /id="debug-menu-indicator"/, 'debug menu indicator should render');
    assert.doesNotMatch(html, /id="debug-menu-indicator"[^>]*hidden/, 'menu indicator should show when status store reports sim menu');
  });

  await test('DebugTelemetryModal renders modal visibility and connection state from debug store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'DebugTelemetryModal.vue'),
      ({ useDebugStore }) => {
        const debug = useDebugStore();
        debug.setModalOpen(true);
        debug.setConnectionStatus(true);
      },
    );

    const modalClass = html.match(/id="debug-modal"[^>]*class="([^"]*)"/)?.[1] || '';
    assert.equal(modalClass.split(/\s+/).includes('hidden'), false, 'open debug modal should not render hidden');
    assert.match(html, /id="debug-status-dot"[^>]*bg-green-500/, 'connected debug status should render green dot');
    assert.match(html, /id="debug-status-text"[^>]*>SimConnect Active</, 'connected debug status text should render from store');
  });

  await test('DebugTelemetryModal renders grouped live telemetry from the debug store', async () => {
    const now = Date.now();
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'DebugTelemetryModal.vue'),
      ({ useDebugStore }) => {
        const debug = useDebugStore();
        debug.setModalOpen(true);
        debug.setConnectionStatus(true);
        debug.setShowNull(true);
        debug.setTestShakeVs('-700');
        debug.setTestShakeStatus('Sent (-700 fpm)');
        debug.ingestFrame({
          type: 'debug-frame',
          phase: 'APPROACH',
          ias: 141.8,
          crosswind: 16,
          'L:MY_CUSTOM_TEST': true,
          nested: { heading: 87 },
        }, now);
        debug.ingestFrame({
          type: 'debug-frame',
          phase: 'APPROACH',
          ias: 142.2,
          crosswind: 16,
          'L:MY_CUSTOM_TEST': true,
          nested: { heading: 88 },
        }, now + 100);
      },
    );
    const modalClass = html.match(/id="debug-modal"[^>]*class="([^"]*)"/)?.[1] || '';

    assert.equal(modalClass.split(/\s+/).includes('hidden'), false, 'live debug modal should stay visible');
    assert.match(html, /id="debug-poll-rate"[^>]*>10\.0</, 'poll rate should render from ingested frames');
    assert.match(html, /id="debug-total-vars"[^>]*>5</, 'total variable count should render from the store');
    assert.match(html, /id="debug-active-vars"[^>]*>5</, 'active variable count should render from the store');
    assert.match(html, /id="debug-phase"[^>]*>APPROACH</, 'phase should render from the store');
    assert.match(html, /id="debug-frame-count"[^>]*>2</, 'frame count should render from the store');
    assert.match(html, /id="debug-shake-status"[^>]*>Sent \(-700 fpm\)</, 'shake-test status text should render');
    assert.match(html, /-700 fpm \(firm\)/, 'firm shake-test option should render');
    assert.match(html, /data-source="simconnect"/, 'simconnect section should render');
    assert.match(html, /data-source="lvar"/, 'LVAR section should render');
    assert.match(html, /data-source="derived"/, 'derived section should render');
    assert.match(html, /debug-content[\s\S]*ias[\s\S]*142\.2000/, 'simconnect rows should render live values');
    assert.match(html, /debug-content[\s\S]*L:MY_CUSTOM_TEST[\s\S]*TRUE/, 'LVAR rows should render boolean values');
    assert.match(html, /debug-content[\s\S]*crosswind[\s\S]*16/, 'derived rows should render numeric values');
  });

  console.log('\n--- system banners ---\n');
  await test('SystemBanners renders disk and update warning targets from the status store', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'SystemBanners.vue'));
    const ids = [
      'system-banner-stack',
      'disk-warning-banner',
      'disk-warning-message',
      'disk-warning-dismiss',
      'restart-required-banner',
      'restart-required-message',
      'restart-required-restart-btn',
      'restart-required-dismiss',
      'update-banner',
      'update-icon',
      'update-version',
      'update-message',
      'update-dismiss',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for telemetry warnings`);
    }

    assert.match(html, /id="system-banner-stack"[^>]*hidden/, 'banner stack should start hidden');
    assert.match(html, /id="disk-warning-banner"[^>]*hidden/, 'disk warning should start hidden');
    assert.match(html, /id="restart-required-banner"[^>]*hidden/, 'restart-required banner should start hidden');
    assert.match(html, /id="update-banner"[^>]*hidden/, 'update banner should start hidden');
    assert.match(html, /Disk space warning/, 'disk warning fallback copy should render');
    assert.match(html, /App restart required to apply saved settings\./, 'restart-required fallback copy should render');
    assert.match(html, /id="restart-required-restart-btn"[^>]*\sdisabled(?:=| |>)/, 'restart-required restart action should render disabled until desktop restart is available');
    assert.match(html, /id="restart-required-restart-btn"[\s\S]*Restart App/, 'restart-required restart action should render the store-backed label');
    assert.match(html, /v0\.0\.0 Alpha/, 'update version fallback should render');
    assert.doesNotMatch(html, /id="update-download-link"/, 'download link should stay absent without an approved backend URL');
  });

  await test('SystemBanners renders visible warning copy, link, and urgent tone from store state', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'SystemBanners.vue'),
      ({ useSettingsUiStore, useStatusStore }) => {
        const status = useStatusStore();
        status.showDiskWarning({ message: 'Flight log volume is almost full.' });
        status.showRestartRequiredBanner({ restartReasons: ['Telemetry source'] });
        status.showUpdateBanner({
          currentVersion: '0.1.0',
          latestVersion: '0.2.0',
          message: 'Critical recorder fix available',
          downloadUrl: 'https://github.com/yenbuilds/flight-fabric/releases/latest',
          urgent: true,
        });

        const settingsUi = useSettingsUiStore();
        settingsUi.setRestartActionState({
          available: true,
          busy: false,
          title: 'Restart Flight Fabric.',
        });
      },
    );

    assert.doesNotMatch(html, /id="system-banner-stack"[^>]*hidden/, 'banner stack should render when any banner is visible');
    assert.doesNotMatch(html, /id="disk-warning-banner"[^>]*hidden/, 'visible disk warning should not render hidden');
    assert.match(html, /Flight log volume is almost full\./, 'disk warning should render store copy');
    assert.doesNotMatch(html, /id="restart-required-banner"[^>]*hidden/, 'visible restart-required banner should not render hidden');
    assert.match(html, /id="restart-required-banner"[^>]*bg-amber-500\/95/, 'restart-required banner should render warning tone');
    assert.match(html, /App restart required to apply: Telemetry source\./, 'restart-required banner should render store copy');
    assert.doesNotMatch(html, /id="restart-required-restart-btn"[^>]*\sdisabled(?:=| |>)/, 'restart-required restart action should enable when desktop restart is available');
    assert.match(html, /id="restart-required-restart-btn"[\s\S]*Restart App/, 'restart-required restart action should stay with the banner message');
    assert.doesNotMatch(html, /id="update-banner"[^>]*hidden/, 'visible update banner should not render hidden');
    assert.match(html, /id="update-banner"[^>]*bg-red-600\/95/, 'urgent update should render danger tone');
    assert.match(html, /id="update-version"[^>]*>v0\.2\.0 Alpha</, 'update version should render formatted label');
    assert.match(html, /Critical recorder fix available/, 'update message should render store copy');
    assert.match(html, /id="update-download-link"[^>]*href="https:\/\/github\.com\/yenbuilds\/flight-fabric\/releases\/latest"|href="https:\/\/github\.com\/yenbuilds\/flight-fabric\/releases\/latest"[^>]*id="update-download-link"/, 'download link should render the approved store URL');
  });

  console.log('\n--- app feedback toast ---\n');
  await test('AppFeedbackToast renders app-wide toast targets', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'AppFeedbackToast.vue'));

    assert.match(html, /id="app-feedback-toast"[^>]*role="status"/, 'toast root should keep status role');
    assert.match(html, /id="app-feedback-toast"[^>]*hidden/, 'toast should start hidden');
    assert.match(html, /id="app-feedback-toast-title"[^>]*>Completed</, 'toast title fallback should render');
    assert.match(html, /id="app-feedback-toast-copy"[^>]*>Action applied\.</, 'toast copy fallback should render');
    assert.match(html, /aria-live="polite"/, 'toast should keep polite live region semantics');
  });

  await test('AppFeedbackToast renders visible toast state from the feedback store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AppFeedbackToast.vue'),
      ({ useFeedbackStore }) => {
        const feedback = useFeedbackStore();
        feedback.showToast({
          kind: 'error',
          title: 'Action failed',
          message: 'Unable to save the profile.',
        });
        feedback.setToastEntered(true);
      },
    );

    assert.match(html, /id="app-feedback-toast"[^>]*app-feedback-toast--error/, 'toast kind should render from store state');
    assert.match(html, /id="app-feedback-toast"[^>]*is-visible/, 'entered toast should render visible class');
    assert.doesNotMatch(html, /id="app-feedback-toast"[^>]*hidden/, 'visible toast should not render hidden');
    assert.match(html, /id="app-feedback-toast-title"[^>]*>Action failed</, 'toast title should render from store state');
    assert.match(html, /id="app-feedback-toast-copy"[^>]*>Unable to save the profile\.</, 'toast copy should render from store state');
  });

  console.log('\n--- msfs installs modal ---\n');
  await test('MsfsInstallsModal renders settings-runtime detection targets', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'MsfsInstallsModal.vue'));
    const ids = [
      'msfs-installs-modal',
      'msfs-detect-btn',
      'msfs-installs-modal-close',
      'msfs-detect-results',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for MSFS install detection`);
    }

    assert.match(html, /id="msfs-installs-modal"[^>]*hidden/, 'MSFS installs modal should start hidden');
    assert.match(html, /Detection is read-only\./, 'detection safety copy should render');
    assert.match(html, />\s*Detect\s*</, 'detect button should render');
    assert.match(html, /Press Detect to scan for installations\./, 'empty detection state should render');
  });

  await test('MsfsInstallsModal renders store-backed scan progress and results', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'MsfsInstallsModal.vue'),
      ({ useSettingsUiStore }) => {
        const settingsUi = useSettingsUiStore();
        settingsUi.bindDesktopActions({
          async detectMsfsInstalls() {
            return [];
          },
        });
        settingsUi.openMsfsInstallsModal();
        settingsUi.setMsfsDetecting(true);
        settingsUi.setMsfsInstallResults([{
          id: 'store',
          label: 'MSFS Store',
          found: true,
          localCache: 'C:/Users/SimPilot/AppData/Local/Packages/Microsoft.FlightSimulator',
          packagesFolder: 'D:/MSFS/Packages',
          communityFolder: 'D:/MSFS/Packages/Community',
          officialFolder: 'D:/MSFS/Packages/Official',
        }]);
      },
    );

    assert.doesNotMatch(html, /id="msfs-installs-modal"[^>]*hidden/, 'modal should render open when the store says it is visible');
    assert.match(html, /MSFS Store/, 'normalized install labels should render from the store');
    assert.match(html, /Found/, 'normalized install badges should render from the store');
    assert.match(html, /Local Cache/, 'install path labels should render from the store');
    assert.match(html, /D:\/MSFS\/Packages\/Community/, 'install path values should render from the store');
  });

  await test('AppFooter shows the MSFS installs trigger when Electron detection is available', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AppFooter.vue'),
      ({ useSettingsUiStore, useStatusStore }) => {
        const status = useStatusStore();
        status.setConnectionInfo('ws://127.0.0.1:8123');
        const settingsUi = useSettingsUiStore();
        settingsUi.bindDesktopActions({
          async detectMsfsInstalls() {
            return [];
          },
        });
        settingsUi.resetMsfsDetectState();
      },
    );

    assert.doesNotMatch(html, /id="msfs-installs-btn"[^>]*hidden/, 'footer trigger should become visible when the Electron detector is available');
  });

  console.log('\n--- flight telemetry panel ---\n');
  await test('FlightTabShell renders flight tab overlay and embedded panels', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'FlightTabShell.vue'),
      ({ useFlightStore }) => {
        const flight = useFlightStore();
        flight.setFlightState('waiting');
        flight.updateLandingPreview({
          final: true,
          vs: -420,
          icao: 'KBOS',
          runway: '27',
          score: 85,
          ultimateStability: { score: 91 },
        });
      },
    );

    assert.match(html, /SIM IS IN MENUS/, 'flight menu overlay should render');
    assert.match(html, /id="vue-flight-state-root"/, 'flight state wrapper should render');
    assert.match(html, /id="flight-state-title"/, 'embedded flight state panel should render');
    assert.match(html, /id="vue-flight-telemetry-root"/, 'flight telemetry wrapper should render');
    assert.match(html, /id="flight-live-shell"/, 'embedded telemetry panel should render');
    assert.match(html, /id="vue-last-landing-root"/, 'last landing wrapper should render');
    assert.match(html, /Latest touchdown report is ready\./, 'embedded last landing summary should render store state');
    assert.doesNotMatch(html, /id="aircraft-specific-section"/, 'Overview should no longer render aircraft-specific controls');
  });

  await test('AircraftTabShell renders generic controls when no trusted template is active', async () => {
    const shellSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'AircraftTabShell.vue',
    ), 'utf8');
    const searchSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'AircraftPageSearch.vue',
    ), 'utf8');
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
    );

    assert.match(html, /data-aircraft-page-mode="generic"/, 'an unmatched aircraft should select the generic control surface');
    assert.match(html, /aria-label="Find on Aircraft page"/, 'the generic Aircraft page should expose its shared search');
    assert.match(html, />Find controls</, 'Aircraft search should start as a compact discoverable launcher');
    assert.match(html, /data-aircraft-integration-guide-trigger/, 'the generic fallback should expose the shared aircraft integration guide');
    assert.match(html, />Integration guide</, 'the integration guide should use a clear, discoverable launcher label');
    assert.match(html, /aria-controls="aircraft-integration-cheatsheet-modal"/, 'the guide launcher should identify its modal target');
    assert.match(html, /aria-label="Close Aircraft search"/, 'expanded Aircraft search should have an explicit close control');
    assert.match(html, /placeholder="Find a switch, light, or value\.\.\."/, 'Aircraft search should use task-oriented cockpit copy');
    assert.match(html, /aria-label="Previous match"/, 'Aircraft search should expose touch-friendly previous navigation');
    assert.match(html, /aria-label="Next match"/, 'Aircraft search should expose touch-friendly next navigation');
    assert.match(html, /id="controls-diagnostics"/, 'the generic control surface should retain compact diagnostic context');
    assert.doesNotMatch(html, /Standard Aircraft Controls|id="controls-fallback-badge"|id="controls-experimental-badge"/, 'the generic control surface should omit the redundant intro and status pills');
    assert.match(html, /data-aircraft-voice-control-trigger/, 'desktop aircraft pages should expose a compact voice-control launcher');
    assert.match(html, /aria-controls="aircraft-voice-control-modal"/, 'the voice launcher should identify its modal target');
    assert.doesNotMatch(
      shellSource,
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
      'Aircraft presets should never compete with the intrinsic-width utility toolbar in one row',
    );
    assert.match(
      shellSource,
      /\.aircraft-page-presets\s*\{[\s\S]*?width:\s*100%;/,
      'Aircraft presets should own the full content row at every viewport width',
    );
    assert.match(
      shellSource,
      /aircraft-page-tool-actions--search-expanded[\s\S]*?flex-basis:\s*100%;/,
      'expanded Aircraft search should wrap to a full tablet and mobile row',
    );
    assert.match(
      shellSource,
      /@media \(max-width: 760px\), \(max-height: 500px\) and \(pointer: coarse\)/,
      'the voice launcher should stay out of portrait and landscape mobile button workflows',
    );
    assert.match(
      searchSource,
      /MOBILE_SEARCH_HIDDEN_QUERY[\s\S]*?mobileRibbonSearchHidden\.value/,
      'mobile ribbon pages should synchronize search state with the breakpoint that hides the search UI',
    );
    assert.match(
      searchSource,
      /event\.defaultPrevented[\s\S]*?modalDialogIsOpen\(\)/,
      'the page-level search shortcut should yield to an open modal and an already-handled key event',
    );
    assert.match(
      searchSource,
      /searchHadFocus[\s\S]*?focusMobileRibbon\(\)/,
      'hiding Aircraft search for a mobile ribbon should move search focus to visible section navigation',
    );
    assert.match(
      searchSource,
      /\.aircraft-find__clear\s*\{[\s\S]*?min-width:\s*2\.75rem;[\s\S]*?min-height:\s*2\.75rem;/,
      'the search clear action should remain a full touch target',
    );
    assert.match(
      searchSource,
      /\.aircraft-find__field input\s*\{[\s\S]*?min-height:\s*2\.75rem;/,
      'the search input itself should fill a touch-sized field instead of relying on its wrapper',
    );
    assert.match(
      searchSource,
      /\.aircraft-find__field input::placeholder\s*\{[\s\S]*?var\(--muted-foreground\)[\s\S]*?!important;/,
      'the Aircraft placeholder should override the low-contrast global placeholder token',
    );
    assert.match(
      searchSource,
      /@media \(max-width: 640px\)[\s\S]*?\.aircraft-find__field input\s*\{[\s\S]*?font-size:\s*1rem;/,
      'mobile Aircraft search should use a 16px input font to avoid focus zoom',
    );
    assert.match(
      searchSource,
      /@media \(max-width: 480px\)[\s\S]*?\.aircraft-find__field\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/,
      'phone layouts should give the search field its own row before its typing width becomes cramped',
    );
    assert.doesNotMatch(html, /id="voice-input-device"/, 'the closed voice modal should not add its full settings surface to the Aircraft page');
    assert.doesNotMatch(html, /id="aircraft-specific-section"/, 'generic mode should not mount the aircraft-specific section');
  });

  await test('AircraftTabShell reports compact voice states without presenting failures as ready', async () => {
    const renderVoiceState = async (status) => renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
      ({ useVoiceControlStore }) => useVoiceControlStore().setState(status, `Test ${status}.`),
    );
    const cases = [
      ['disabled', 'off', 'Off'],
      ['initializing', 'busy', 'Starting'],
      ['starting', 'busy', 'Starting'],
      ['listening', 'listening', 'Listening'],
      ['finishing', 'busy', 'Processing'],
      ['sending', 'busy', 'Sending'],
      ['ready', 'ready', 'Ready'],
      ['sent', 'ready', 'Command sent'],
      ['failed', 'attention', 'Command failed'],
      ['error', 'attention', 'Needs attention'],
      ['unmatched', 'attention', 'Try again'],
      ['transcribed', 'ready', 'Transcribed'],
      ['blocked', 'attention', 'Check setup'],
      ['unavailable', 'attention', 'Check setup'],
    ];
    const mappedStatuses = new Set(cases.map(([status]) => status));
    const voiceControllerSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'voice',
      'voice-controller.js',
    ), 'utf8');
    const emittedStatuses = new Set(
      [...voiceControllerSource.matchAll(/voiceStore\.setState\(\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1]),
    );

    for (const status of emittedStatuses) {
      assert.equal(mappedStatuses.has(status), true, `voice status ${status} should have an intentional launcher mapping`);
    }

    for (const [status, state, label] of cases) {
      const rendered = await renderVoiceState(status);
      assert.match(
        rendered.html,
        new RegExp(`data-voice-state="${state}"`),
        `${status} should use the ${state} launcher treatment`,
      );
      assert.match(rendered.html, new RegExp(label), `${status} should render the ${label} launcher label`);
    }
  });

  await test('VoiceControlPanel labels capture, recognition, and command phases accurately', async () => {
    const renderPanelState = async (status) => renderComponent(
      path.join('src', 'vue', 'components', 'VoiceControlPanel.vue'),
      ({ useVoiceControlStore }) => {
        const voice = useVoiceControlStore();
        voice.applyRuntimeInfo({
          available: true,
          enabled: true,
          engine: { modelId: 'test-model' },
          pushToTalk: { accelerator: '', registered: false },
        });
        voice.setState(status, `Test ${status}.`);
      },
      { props: { presentation: 'modal' } },
    );

    assert.match((await renderPanelState('initializing')).html, /Starting voice control/, 'runtime initialization should not present an enabled hold-to-talk action');
    assert.match((await renderPanelState('starting')).html, /Release to cancel/, 'microphone startup should explain that an early release cancels capture');
    assert.match((await renderPanelState('listening')).html, /Release to execute/, 'active capture should retain the normal execution copy');
    assert.match((await renderPanelState('finishing')).html, /Processing/, 'recognition should not present another enabled hold-to-talk action');
    assert.match((await renderPanelState('finishing')).html, /bg-sky-400 animate-pulse/, 'recognition should use the shared busy status tone');
    assert.match((await renderPanelState('sending')).html, /Sending command/, 'command dispatch should remain visible on the disabled PTT control');
    assert.match((await renderPanelState('sending')).html, /bg-sky-400 animate-pulse/, 'command dispatch should use the shared busy status tone');
    assert.match((await renderPanelState('unmatched')).html, /bg-amber-400/, 'unmatched speech should use the same attention tone as the launcher');
  });

  await test('VoiceControlPanel records push-to-talk shortcuts instead of accepting accelerator text', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'VoiceControlPanel.vue'),
      ({ useVoiceControlStore }) => useVoiceControlStore().applyRuntimeInfo({
        available: true,
        enabled: true,
        engine: { modelId: 'test-model' },
        pushToTalk: { accelerator: '', registered: false },
      }),
      { props: { presentation: 'modal' } },
    );

    assert.match(html, /<button[^>]*id="voice-ptt-shortcut"[^>]*data-voice-shortcut-recorder/, 'shortcut configuration should expose a keyboard recorder');
    assert.doesNotMatch(html, /<input[^>]*id="voice-ptt-shortcut"/, 'shortcut configuration should not accept raw accelerator text');
    assert.match(html, /Set push-to-talk/, 'an unassigned shortcut should be called out in the settings summary');
    assert.match(html, /Set shortcut/, 'an unassigned shortcut should expose a clear setup action');
    assert.match(html, /No global shortcut is active\. Click to record one\./, 'the recorder should explain that no global shortcut is active');
    assert.match(html, /On-screen only/, 'the main control should explain that its on-screen action remains available');
  });

  await test('VoiceControlPanel keeps push-to-talk disabled while simulator control is unavailable', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'VoiceControlPanel.vue'),
      ({ useAircraftControlsStore, useVoiceControlStore }) => {
        useAircraftControlsStore().setAvailability({
          enabled: false,
          reason: 'Simulator is in a menu or loading state.',
        });
        useVoiceControlStore().setState('failed', 'Verify aircraft state.');
      },
      { props: { presentation: 'modal' } },
    );

    assert.match(
      html,
      /<button[^>]*disabled[^>]*aria-describedby="voice-control-status"/,
      'held failure feedback must not make push-to-talk clickable while simulator writes are blocked',
    );
  });

  await test('VoiceControlPanel keeps push-to-talk disabled when the active catalogue has no voice commands', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'VoiceControlPanel.vue'),
      ({ useAircraftControlsStore, useVoiceControlStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
        useVoiceControlStore().setState('failed', 'Verify aircraft state.');
      },
      { props: { presentation: 'modal' } },
    );

    assert.match(
      html,
      /<button[^>]*disabled[^>]*aria-describedby="voice-control-status"/,
      'held feedback must not expose an actionable PTT button without executable commands',
    );
    assert.match(html, /No voice commands are exposed/, 'the panel should explain why voice execution is blocked');
  });

  await test('AircraftTabShell exposes active aircraft presets as shared UI and voice quick actions', async () => {
    const quickActionsSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'AircraftQuickActions.vue',
    ), 'utf8');
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
      ({ useAircraftControlsStore }) => {
        const aircraftControls = useAircraftControlsStore();
        aircraftControls.setAvailability({ enabled: true, reason: 'Ready.' });
        aircraftControls.applyControlCapabilities({
          aircraftCommands: {
            configurationId: 'pmdg-737',
            profileKey: 'bundled/msfs/pmdg-737',
            profileRevision: 8,
            commands: [
              {
                id: 'configuration.lighting.cockpit',
                label: 'Cockpit lighting',
                group: 'presets',
                kind: 'preset',
                description: 'Set panel and display dimmers to one brightness.',
                input: { kind: 'number', min: 0, max: 100, step: 1, units: 'percent' },
                speech: { patterns: ['set cockpit lighting {value}'] },
              },
              {
                id: 'configuration.lights.takeoff',
                label: 'Takeoff lights',
                group: 'presets',
                kind: 'preset',
                description: 'Landing L/R ON · Runway turnoffs ON · Taxi ON · Position STROBE + STEADY',
                input: { kind: 'none' },
                speech: {
                  patterns: ['set lights for takeoff', 'takeoff lights'],
                  hints: ['TAKEOFF LIGHTS'],
                },
              },
              {
                id: 'configuration.lights.cruise',
                label: 'Cruise lighting',
                group: 'presets',
                kind: 'preset',
                description: 'Logo ON · Cabin signs AUTO',
                input: { kind: 'none' },
                speech: { patterns: ['set lights for cruise'] },
              },
            ],
          },
        });
      },
    );

    assert.match(html, /data-aircraft-quick-actions/, 'the Aircraft page should render its quick-action region');
    assert.match(html, /data-aircraft-preset="configuration.lights.takeoff"/, 'the active takeoff-light preset should be visible');
    assert.match(html, /data-aircraft-preset="configuration.lights.cruise"/, 'a second one-tap preset should render in the shared quick-action grid');
    assert.equal((html.match(/data-aircraft-preset=/g) || []).length, 2, 'only no-input presets should render as one-tap actions');
    assert.doesNotMatch(html, /data-aircraft-preset="configuration.lighting.cockpit"/, 'parameterized presets should not render a button that can only submit empty input');
    assert.match(html, />Takeoff lights</, 'the preset should retain its catalogue label');
    assert.match(html, /Runway turnoffs ON/, 'the UI should show the aircraft-specific recipe before execution');
    assert.match(html, /Say “set lights for takeoff”/, 'the same preset should advertise its voice phrase as spoken copy');
    assert.doesNotMatch(html, /Quick actions|Configure the aircraft by intent|Local Zipformer/, 'the Aircraft page should omit redundant quick-action and engine labels');
    assert.match(html, /data-aircraft-voice-control-trigger/, 'an active voice catalogue should retain the compact desktop voice launcher');
    assert.doesNotMatch(html, /data-voice-control-panel/, 'the full voice surface should remain out of the long Aircraft page until requested');
    assert.doesNotMatch(html, /aria-label="Apply Takeoff lights"[^>]*disabled/, 'a ready preset should be actionable');
    assert.match(
      quickActionsSource,
      /\.aircraft-preset-container\s*\{\s*container-type:\s*inline-size;/,
      'each preset should respond to its own allocated width instead of the viewport',
    );
    assert.match(
      quickActionsSource,
      /command\?\.input\?\.kind === 'none'/,
      'shared one-tap presets should fail closed for parameterized commands',
    );
    assert.match(
      quickActionsSource,
      /minmax\(min\(100%, 30rem\), 1fr\)[\s\S]*?@container \(min-width: 30rem\)/,
      'multi-preset grids should only split when every card can use its horizontal layout',
    );
  });

  await test('Aircraft quick actions expose disabled preset reasons without relying on hover', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftQuickActions.vue'),
      ({ useAircraftControlsStore }) => {
        const aircraftControls = useAircraftControlsStore();
        aircraftControls.applyControlCapabilities({
          aircraftCommands: {
            configurationId: 'generic',
            profileKey: 'bundled/msfs/generic',
            profileRevision: 1,
            commands: [{
              id: 'configuration.lights.takeoff',
              label: 'Takeoff lights',
              group: 'presets',
              kind: 'preset',
              description: 'Runway turnoffs ON · Taxi ON · Strobe ON',
              input: { kind: 'none' },
            }],
          },
        });
        aircraftControls.setAvailability({ enabled: false, reason: 'Simulator telemetry link unavailable.' });
      },
    );

    assert.match(html, /id="aircraft-preset-reason-configuration-lights-takeoff"/, 'disabled preset reason should have a stable description target');
    assert.match(html, /aria-label="Takeoff lights unavailable"/, 'disabled preset accessible name should match its visible state');
    assert.match(html, /aria-describedby="aircraft-preset-reason-configuration-lights-takeoff"/, 'disabled preset should reference its visible reason');
    assert.match(html, /Simulator telemetry link unavailable\./, 'disabled preset should explain why it cannot run');
  });

  await test('Aircraft voice control modal keeps desktop PTT and settings off the main page', async () => {
    const modalSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'AircraftVoiceControlModal.vue',
    ), 'utf8');
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftVoiceControlModal.vue'),
      ({ useAircraftControlsStore, useVoiceControlStore }) => {
        useAircraftControlsStore().applyControlCapabilities({
          aircraftCommands: {
            configurationId: 'pmdg-737',
            profileKey: 'bundled/msfs/pmdg-737',
            profileRevision: 8,
            commands: [{
              id: 'flightGuidance.heading.set',
              label: 'Selected heading',
              group: 'flightGuidance',
              input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
              speech: { patterns: ['set heading {value}'] },
            }],
          },
        });
        const voice = useVoiceControlStore();
        voice.applyRuntimeInfo({
          available: true,
          enabled: true,
          engine: { modelId: 'test-model' },
          pushToTalk: { accelerator: 'Ctrl+Alt+Space', registered: true },
        });
        voice.setState('ready', 'Ready.');
        voice.setInputDevices([{ deviceId: 'desktop-mic', label: 'Desktop microphone' }]);
      },
      { props: { open: true } },
    );

    assert.match(html, /id="aircraft-voice-control-modal"/, 'voice controls should render in a dedicated modal');
    assert.match(html, /role="dialog"[\s\S]*aria-modal="true"/, 'the voice surface should expose modal semantics');
    assert.match(html, /Keep Flight Fabric in the background/, 'the modal should explain the simulator-first workflow');
    assert.match(html, /Browse 1 voice command/, 'the modal should route command discovery into the shared integration guide');
    assert.match(html, /aria-haspopup="dialog"/, 'the command browser should announce that it opens a dialog');
    assert.match(html, /aria-controls="aircraft-integration-cheatsheet-modal"/, 'the command browser should identify the integration guide it opens');
    assert.match(html, /data-voice-control-presentation="modal"/, 'the existing voice controls should use their compact modal presentation');
    assert.match(html, /data-voice-recognition-toggle/, 'the modal should expose the explicit voice-recognition opt-in');
    assert.match(html, /Hold to talk/, 'the on-screen push-to-talk control should remain available on desktop');
    assert.match(html, /id="voice-input-device"/, 'the modal should retain microphone selection');
    assert.match(html, /Local spoken feedback/, 'the modal should expose local spoken command feedback');
    assert.doesNotMatch(html, /Noisy-cockpit processing/, 'the removed browser audio-processing option should stay absent');
    assert.match(html, /Push-to-talk shortcut/, 'the modal should retain shortcut configuration');
    assert.doesNotMatch(html, /aircraft-voice-commands-modal/, 'the voice modal should avoid stacking a second modal for command discovery');
    assert.match(modalSource, /<Teleport to="body"/, 'the voice modal should escape Aircraft-page clipping');
    assert.match(modalSource, /event\.key === 'Escape'/, 'the voice modal should support keyboard dismissal');
  });

  await test('VoiceControlPanel keeps recognition and microphone controls off by default', async () => {
    const panelSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'VoiceControlPanel.vue',
    ), 'utf8');
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'VoiceControlPanel.vue'),
      ({ useVoiceControlStore }) => {
        const voice = useVoiceControlStore();
        voice.applyRuntimeInfo({
          available: false,
          enabled: false,
          engine: { modelId: 'test-model' },
          pushToTalk: { accelerator: '', registered: false },
        });
        voice.setState('disabled', 'Voice control is off. Enable it to use local speech recognition.');
      },
      { props: { presentation: 'modal' } },
    );

    assert.match(html, /Voice control is off\. Enable it to use local speech recognition\./);
    assert.match(html, /data-voice-recognition-toggle[\s\S]*role="switch"/, 'the off state should retain its explicit opt-in control');
    assert.match(html, /data-voice-push-to-talk[^>]*disabled/, 'on-screen push-to-talk should be disabled while recognition is off');
    assert.match(html, /id="voice-input-device"[^>]*disabled/, 'microphone selection should be disabled while recognition is off');
    assert.match(html, /data-voice-shortcut-recorder[^>]*disabled/, 'shortcut capture should be disabled while recognition is off');
    assert.match(
      panelSource,
      /voice\.refreshInputDevices\(\{ requestAccess: true \}\)/,
      'the explicit Refresh action should request bounded device discovery access',
    );
    assert.match(
      panelSource,
      /const target = event\.currentTarget;[\s\S]*await voice\.setRecognitionEnabled\(nextEnabled\);[\s\S]*target\.checked = voice\.runtime\.enabled === true;/,
      'a rejected asynchronous toggle should restore the visible checkbox state through its retained element reference',
    );
  });

  await test('Aircraft integration cheatsheet combines commands, presets, controls, readbacks, and voice status', async () => {
    const modalSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'AircraftIntegrationCheatSheetModal.vue',
    ), 'utf8');
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftIntegrationCheatSheetModal.vue'),
      ({ useAircraftControlsStore, useAircraftSpecificStore }) => {
        useAircraftControlsStore().applyControlCapabilities({
          aircraftCommands: {
            configurationId: 'pmdg-737',
            profileKey: 'bundled/msfs/pmdg-737',
            profileRevision: 11,
            inventory: [{
              id: 'flightGuidance.heading.set',
              label: 'Selected heading',
              group: 'flightGuidance',
              input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
              supported: true,
              actionIds: ['mcp.heading.set'],
              speech: { patterns: ['set heading {value}'] },
            }, {
              id: 'configuration.lights.takeoff',
              label: 'Takeoff lights',
              group: 'presets',
              kind: 'preset',
              description: 'Apply the complete takeoff-light configuration.',
              input: { kind: 'none' },
              supported: true,
              actionIds: ['lights.takeoff.apply'],
              speech: { patterns: ['set lights for takeoff'] },
            }],
            commands: [],
          },
          aircraftIntegration: {
            id: 'pmdg-737',
            vendor: 'PMDG',
            family: '737',
            templateId: 'pmdg-737',
            fields: [{ id: 'mcp.headingDeg' }, { id: 'electrical.batteryOn' }],
            actions: [{
              id: 'mcp.heading.set',
              supported: true,
              verification: 'verified',
              input: { type: 'number', min: 0, max: 359, step: 1 },
            }, {
              id: 'electrical.battery.on',
              supported: true,
              verification: 'partial',
            }, {
              id: 'lighting.panel.set',
              supported: false,
              verification: 'untested',
              input: { type: 'number', min: 0, max: 100, step: 1 },
            }],
          },
        });
        const aircraftSpecific = useAircraftSpecificStore();
        aircraftSpecific.applyProfile({
          _profileKey: 'bundled/msfs/pmdg-737',
          profileRevision: 11,
          aircraftSpecificTemplateId: 'pmdg-737',
        });
        aircraftSpecific.ingestState({
          profileKey: 'bundled/msfs/pmdg-737',
          profileRevision: 11,
          templateId: 'pmdg-737',
          available: true,
          sourceStatus: { overall: 'connected' },
          values: { 'mcp.headingDeg': 271 },
          unavailable: ['electrical.batteryOn'],
        });
      },
      { props: { open: true } },
    );

    assert.match(html, /id="aircraft-integration-cheatsheet-modal"/, 'the integration reference should render as a dedicated modal');
    assert.match(html, /PMDG 737 cheatsheet/, 'the modal should identify the active aircraft integration');
    assert.match(html, /Every mapped control, preset and readback/, 'the modal should explain its complete integration scope');
    assert.match(html, />Setting<\/th>[\s\S]*>Type<\/th>[\s\S]*>Values<\/th>[\s\S]*>Voice<\/th>[\s\S]*>Status<\/th>/, 'desktop users should receive a clear capability table');
    assert.match(html, /Selected heading[\s\S]*set heading &lt;value&gt;/, 'voice-enabled settings should expose their spoken mapping');
    assert.match(html, /Takeoff lights[\s\S]*Preset/, 'presets should be visibly distinguished from ordinary controls');
    assert.match(html, /Battery on[\s\S]*Control/, 'unclaimed adapter actions should remain visible as controls');
    assert.match(html, /Heading deg[\s\S]*Readback[\s\S]*Live now/, 'live adapter fields should remain visible as readbacks');
    assert.match(html, /Battery on[\s\S]*Readback[\s\S]*Unavailable now/, 'temporarily unavailable readbacks should retain their integration row and status');
    assert.equal((html.match(/mcp\.heading\.set/g) || []).length, 0, 'canonical commands should replace duplicate low-level action rows');
    assert.match(modalSource, /<Teleport to="body"/, 'the cheatsheet should escape aircraft-page clipping');
    assert.match(modalSource, /event\.key === 'Escape'/, 'the cheatsheet should support keyboard dismissal');
  });

  await test('Generic aircraft cheatsheet lists its standard live readbacks', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftIntegrationCheatSheetModal.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().applyControlCapabilities({
          aircraftCommands: {
            configurationId: 'generic',
            profileKey: 'bundled/msfs/generic',
            profileRevision: 1,
            inventory: [],
            commands: [],
          },
          aircraftIntegration: {
            id: 'generic',
            family: 'Generic aircraft',
            vendor: '',
            templateId: 'generic',
            fields: [
              { id: 'surfaces.gear' },
              { id: 'lights.landing' },
              { id: 'flightGuidance.selectedHeading' },
            ],
            actions: [],
          },
        });
      },
      { props: { open: true, initialFilter: 'readback' } },
    );

    assert.match(html, /Generic aircraft cheatsheet/);
    assert.match(html, /Gear[\s\S]*Readback[\s\S]*Integrated/);
    assert.match(html, /Landing[\s\S]*Readback[\s\S]*Integrated/);
    assert.match(html, /Selected heading[\s\S]*Readback[\s\S]*Integrated/);
    assert.doesNotMatch(html, /No matching integration settings/);
  });

  await test('AircraftTabShell replaces generic controls with a trusted template through stale data', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
      ({ useAircraftSpecificStore }) => {
        const aircraftSpecific = useAircraftSpecificStore();
        aircraftSpecific.applyProfile({
          _profileKey: 'bundled/msfs/ifly-737-max-8',
          profileRevision: 7,
          aircraftSpecificTemplateId: 'ifly-737-max-8',
        });
        aircraftSpecific.clearSnapshot('stale');
      },
    );

    assert.match(html, /data-aircraft-page-mode="specific"/, 'a registered aircraft template should replace generic controls');
    assert.match(html, /data-mobile-aircraft-navigation="search"/, 'non-PMDG templates should retain mobile Aircraft search');
    assert.match(html, /aria-label="Find on Aircraft page"/, 'trusted aircraft templates should share the centralized Aircraft search');
    assert.doesNotMatch(html, /aircraft-find--mobile-hidden/, 'templates without section navigation should retain mobile search');
    assert.match(html, /id="aircraft-specific-section"/, 'specific mode should mount the trusted aircraft section');
    assert.match(html, /data-aircraft-integration-guide-trigger/, 'trusted aircraft templates should expose the same shared integration guide');
    assert.match(html, /data-aircraft-template="ifly-737-max-8"/, 'the registered iFly template should render');
    assert.match(html, />stale</, 'transient source health should render inside the selected template');
    assert.doesNotMatch(html, /id="controls-diagnostics"/, 'specific mode should not mount the generic controls beneath it');
  });

  await test('AircraftTabShell keeps the PMDG 737 mobile section ribbon and hot-group behavior', async () => {
    const searchSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'AircraftPageSearch.vue',
    ), 'utf8');
    const pmdgSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'aircraft-specific',
      'templates',
      'Pmdg737AircraftPanel.vue',
    ), 'utf8');
    const hotGroupModalSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'aircraft-specific',
      'AircraftHotGroupModal.vue',
    ), 'utf8');
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
      ({ useAircraftSpecificStore }) => {
        const aircraftSpecific = useAircraftSpecificStore();
        aircraftSpecific.applyProfile({
          _profileKey: 'bundled/msfs/pmdg-737-800',
          profileRevision: 4,
          aircraftSpecificTemplateId: 'pmdg-737',
        });
        aircraftSpecific.clearSnapshot('stale');
      },
    );

    assert.match(html, /data-aircraft-template="pmdg-737"/, 'the PMDG 737 template should render');
    assert.match(html, /aircraft-specific-section--mobile-ribbon/, 'the PMDG 737 card should release mobile overflow for its sticky ribbon');
    assert.match(html, /class="pmdg-mobile-section-ribbon-anchor"/, 'the PMDG section ribbon should have a dedicated sticky sub-navigation row');
    assert.match(html, /data-mobile-aircraft-navigation="section-ribbon"/, 'the PMDG 737 page should select the mobile ribbon experiment');
    assert.match(html, /class="aircraft-find aircraft-find--mobile-hidden"/, 'PMDG 737 search should be hidden at the mobile breakpoint');
    assert.match(searchSource, /@media \(max-width: 760px\)[\s\S]*?\.aircraft-find--mobile-hidden\s*\{\s*display:\s*none;/, 'PMDG search should disappear at the viewport breakpoint without depending on pointer detection');
    assert.match(pmdgSource, /@media \(max-width: 760px\)[\s\S]*?\.pmdg-mobile-section-ribbon\s*\{\s*display:\s*grid;/, 'PMDG section navigation should replace search at the same viewport breakpoint');
    assert.match(pmdgSource, /\.pmdg-mobile-section-ribbon-anchor\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?height:\s*2\.75rem;/, 'the mobile ribbon should remain reachable while reserving only its visible control height');
    assert.match(pmdgSource, /Number\.isFinite\(endX\)[\s\S]*Number\.isFinite\(endY\)/, 'coordinate-free pointer activation must not be misread as a swipe to another section');
    assert.match(pmdgSource, /target\?\.closest\?\.\('\.pmdg-mobile-section-ribbon__neighbor'\)/, 'arrow taps should bypass ribbon swipe detection so they always advance one section');
    assert.equal((pmdgSource.match(/@pointerdown\.stop="clearRibbonSwipe"/g) || []).length, 2, 'both arrow targets should stop ribbon swipe tracking before their click');
    assert.equal((pmdgSource.match(/@pointerup\.stop="clearRibbonSwipe"/g) || []).length, 2, 'both arrow targets should end without the ribbon interpreting a tap as a swipe');
    assert.doesNotMatch(pmdgSource, /setPointerCapture/, 'the ribbon must not retarget ordinary button taps away from its arrow and chooser controls');
    assert.match(pmdgSource, /useAircraftSectionMemory/, 'PMDG 737 should use the guarded shared section-memory behavior');
    assert.match(pmdgSource, /memoryKey:\s*\(\) => props\.profileKey/, 'PMDG 737 section memory should be isolated by exact profile key');
    assert.match(pmdgSource, /focus:\s*false,\s*remember:\s*false/, 'restoring a section must not steal focus or rewrite memory');
    assert.match(html, /class="pmdg-mobile-section-ribbon"[^>]*aria-label="PMDG 737 page sections"[^>]*data-no-swipe/, 'the ribbon should own its gesture surface without triggering app tab swipes');
    assert.match(html, /aria-label="Open all PMDG 737 sections"/, 'the center target should expose the complete section chooser');
    assert.match(html, />1 of 8 · All sections</, 'the ribbon should communicate position across only the permanent aircraft sections');
    assert.match(html, /aria-label="Open next section: Navigation Radios"/, 'the next large target should name its permanent-section destination');
    assert.deepEqual(
      [...html.matchAll(/data-pmdg-737-section="([^"]+)"/g)].map((match) => match[1]),
      ['mcp', 'radios', 'exterior', 'cockpit-lighting', 'cabin', 'flight-controls', 'gear-brakes', 'systems'],
      'the ribbon should retain only the eight permanent PMDG aircraft sections',
    );
    assert.match(html, /data-pmdg-hot-group-launcher="initial-power"/, 'Initial power should be exposed as a compact hot-group launcher');
    const launcherStart = html.indexOf('data-pmdg-hot-group-launcher="initial-power"');
    const launcherMarkup = html.slice(launcherStart, html.indexOf('</button>', launcherStart));
    assert.match(launcherMarkup, /Initial power[\s\S]*PMDG readback unavailable[\s\S]*OPEN/, 'the launcher should retain only its title, useful live summary, and open affordance');
    assert.doesNotMatch(launcherMarkup, /PWR|Quick group|>LIVE</, 'the launcher should not accumulate explanatory labels or status pills');
    assert.ok(
      pmdgSource.indexOf('class="pmdg-mobile-section-ribbon-anchor"') < pmdgSource.indexOf('data-pmdg-hot-group-launcher="initial-power"'),
      'the permanent section navigation should appear before the separate Initial power quick group',
    );
    assert.match(html, /data-aircraft-hot-group-modal/, 'Initial power should render through the reusable hot-group modal shell');
    assert.match(html, /data-pmdg-hot-group="initial-power"/, 'the cold-and-dark controls should remain inside their separate hot group');
    assert.doesNotMatch(html, /data-pmdg-737-section="cold-dark"/, 'Initial power must not masquerade as a permanent aircraft section');
    assert.match(hotGroupModalSource, /<Teleport to="body"/, 'hot groups should escape aircraft-card clipping through a body-level modal');
    assert.match(hotGroupModalSource, /role="dialog"[\s\S]*?aria-modal="true"/, 'the reusable hot-group surface should expose modal semantics');
    assert.match(hotGroupModalSource, /@media \(max-width: 760px\)[\s\S]*?height:\s*var\(--ff-visual-viewport-height, 100dvh\)/, 'hot groups should become full-screen sheets on mobile');
    assert.match(html, /data-pmdg-location="glareshield">GLARESHIELD</, 'MCP should expose its real cockpit location as secondary metadata');
    assert.match(html, /data-pmdg-course-both-control/, 'the PMDG MCP should expose coordinated course-window setting');
    assert.match(html, /data-aircraft-command="flightGuidance\.course\.setBoth"/, 'the paired course control should use the canonical command path');
    assert.match(html, /set courses two seven zero/, 'the paired course control should advertise its exact voice form');
    assert.match(pmdgSource, /function mcpControlGroup[\s\S]*bothCourseControlGroup/, 'individual and paired course writes should share one UI pending group');
    assert.match(html, /data-pmdg-location="pedestal">PEDESTAL</, 'navigation radios should expose their pedestal location');
    assert.match(html, /data-pmdg-nav-both-control/, 'the PMDG radio section should expose coordinated active-frequency tuning');
    assert.match(html, /data-aircraft-command="radios\.nav\.setBothActive"/, 'the paired radio control should use the canonical command path');
    assert.match(html, /set nav radios one one zero decimal three/, 'the paired radio control should advertise its exact voice form');
    assert.match(html, /data-pmdg-cockpit-lighting-control/, 'the PMDG page should expose one coordinated cockpit-lighting control');
    assert.match(html, /data-aircraft-command="configuration\.lighting\.cockpit"/, 'cockpit lighting should use the canonical parameterized preset path');
    assert.match(html, /set cockpit lighting fifty percent/, 'the cockpit-lighting control should advertise its exact voice form');
    assert.match(html, /16 DIMMERS/, 'the cockpit-lighting section should disclose its reviewed control scope');
    assert.match(html, /Discrete dome and spot lights/, 'the cockpit-lighting section should name the controls it intentionally leaves unchanged');
    assert.match(html, /data-pmdg-location="aft-overhead">AFT OVERHEAD</, 'IRS should expose its aft-overhead location');
    assert.doesNotMatch(html, /data-pmdg-location="main-panel-overhead"/, 'mixed flight-control locations should not be presented as one cockpit panel');
    assert.doesNotMatch(html, /data-pmdg-location="overhead-glareshield"/, 'overhead system controls should not be presented as glareshield controls');
    for (const actionId of [
      'flightControls.flaps.up',
      'flightControls.speedbrake.disarm',
      'flightControls.speedbrake.arm',
      'flightControls.yawDamper.on',
      'flightControls.stabTrimMainElectric.normal',
      'gear.handle.down',
      'gear.autobrake.max',
      'gear.parkingBrake.released',
      'gear.parkingBrake.set',
      'systems.apu.start',
      'systems.air.packLeft.auto',
      'systems.air.engineBleedLeft.on',
      'systems.ice.wing.on',
    ]) {
      assert.match(html, new RegExp(`data-aircraft-action="${actionId.replaceAll('.', '\\.')}"`), `${actionId} should be exposed as a guarded PMDG control`);
    }
    assert.doesNotMatch(html, /Monitoring-only in this pass/, 'physical PMDG selectors should no longer be presented as a read-only snapshot');
    assert.match(html, /Air &amp; Systems/, 'the final section should describe its interactive control surface');
    assert.equal((html.match(/data-pmdg-location=/g) || []).length, 9, 'location metadata should remain a small fixed set of accurate labels rather than another navigation system');
  });

  await test('AircraftTabShell gives PMDG 777 desktop search and 737-parity mobile section navigation', async () => {
    const searchSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'AircraftPageSearch.vue',
    ), 'utf8');
    const ribbonSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'aircraft-specific',
      'AircraftSectionRibbon.vue',
    ), 'utf8');
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
      ({ useAircraftSpecificStore }) => {
        const aircraftSpecific = useAircraftSpecificStore();
        aircraftSpecific.applyProfile({
          _profileKey: 'bundled/msfs/pmdg-777-300er',
          profileRevision: 4,
          aircraftSpecificTemplateId: 'pmdg-777',
        });
        aircraftSpecific.clearSnapshot('stale');
      },
    );

    assert.match(html, /data-aircraft-template="pmdg-777"/, 'the PMDG 777 template should render');
    assert.match(html, /data-mobile-aircraft-navigation="section-ribbon"/, 'PMDG 777 should select section navigation on mobile');
    assert.match(html, /class="aircraft-find aircraft-find--mobile-hidden"/, 'PMDG 777 should retain desktop search while hiding it at the mobile breakpoint');
    assert.match(html, /aircraft-specific-section--mobile-ribbon/, 'the PMDG 777 card should release overflow for sticky navigation');
    assert.match(html, /data-aircraft-section-ribbon/, 'the reusable mobile section ribbon should render');
    assert.match(html, /aria-label="PMDG 777 page sections"/, 'the ribbon should have aircraft-specific navigation semantics');
    assert.match(html, /aria-label="Open all PMDG 777 sections"/, 'the center target should open the complete 777 section chooser');
    assert.match(html, />1 of 10 /, 'the ribbon should communicate its position across the ten practical 777 groups');
    assert.match(html, /aria-label="Open next section: Lights &amp; Cabin"/, 'the next target should identify the lights and cabin group');
    assert.deepEqual(
      [...html.matchAll(/id="pmdg-777-section-([^" ]+)"/g)].map((match) => match[1]),
      ['mcp', 'lights', 'electrical', 'hydraulics-ice', 'fuel-engines', 'air', 'gear-high-lift', 'displays', 'utilities', 'outcomes'],
      'every 777 navigation destination should map to one stable page anchor',
    );
    assert.match(ribbonSource, /@media \(max-width: 760px\)[\s\S]*?\.aircraft-section-ribbon\s*\{[\s\S]*?display:\s*grid;/, 'the 777 ribbon should replace search at the same mobile breakpoint as the 737');
    assert.equal((ribbonSource.match(/@pointerdown\.stop="clearRibbonSwipe"/g) || []).length, 2, 'both reusable ribbon arrows should bypass swipe tracking');
    assert.equal((ribbonSource.match(/@pointerup\.stop="clearRibbonSwipe"/g) || []).length, 2, 'both reusable ribbon arrows should remain reliable taps');
    assert.match(ribbonSource, /useAircraftSectionMemory/, 'shared aircraft ribbons should use guarded session section memory');
    assert.match(ribbonSource, /!aircraftTabIsActive\(\)/, 'hidden aircraft ribbons must not record scroll from another tab');
    assert.match(ribbonSource, /focus:\s*false,\s*remember:\s*false/, 'shared ribbon restoration must not steal focus or recursively persist');
    assert.match(searchSource, /details:not\(\[open\]\)/, 'Aircraft search should index controls hidden only by a closed details group');
    assert.match(searchSource, /details\.open = true/, 'selecting a result should reveal its closed 777 system group');
  });

  await test('Fenix and FlyByWire pages share compact desktop search and mobile section navigation', async () => {
    const cases = [
      {
        profileKey: 'bundled/msfs/fenix-a320',
        templateId: 'fenix-a32x',
        aircraftLabel: 'Fenix A320',
        sectionPrefix: 'fenix-section-',
        sectionIds: [
          'throttle', 'fcu', 'exterior-lights', 'cabin-visibility', 'cockpit-lighting',
          'electrical-apu', 'fuel', 'pneumatic', 'protection-hydraulics', 'engine-adirs',
          'efis-navigation', 'switching', 'surveillance-radio', 'safety-misc',
        ],
      },
      {
        profileKey: 'bundled/msfs/fbw-a32nx',
        templateId: 'fbw-a32nx',
        aircraftLabel: 'FlyByWire A32NX',
        sectionPrefix: 'fbw-a32nx-section-',
        sectionIds: [
          'throttle', 'fcu', 'flight-guidance', 'lights-signs', 'electrical-apu', 'air-ice',
          'adirs-navigation', 'ground-engines', 'surveillance', 'switching-displays',
          'light-readback', 'status',
        ],
      },
      {
        profileKey: 'bundled/msfs/fbw-a380x',
        templateId: 'fbw-a380x',
        aircraftLabel: 'FlyByWire A380X',
        sectionPrefix: 'fbw-a380x-section-',
        sectionIds: ['throttle', 'fcu-autopilot', 'exterior-lights', 'flight-configuration', 'systems'],
      },
    ];

    for (const fixture of cases) {
      const { html } = await renderComponent(
        path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
        ({ useAircraftSpecificStore }) => {
          const aircraftSpecific = useAircraftSpecificStore();
          aircraftSpecific.applyProfile({
            _profileKey: fixture.profileKey,
            profileRevision: 1,
            aircraftSpecificTemplateId: fixture.templateId,
          });
          aircraftSpecific.clearSnapshot('stale');
        },
      );

      assert.match(html, new RegExp(`data-aircraft-template="${fixture.templateId}"`), `${fixture.aircraftLabel} should render its trusted template`);
      assert.match(html, /data-mobile-aircraft-navigation="section-ribbon"/, `${fixture.aircraftLabel} should use section navigation on mobile`);
      assert.match(html, /class="aircraft-find aircraft-find--mobile-hidden"/, `${fixture.aircraftLabel} should retain compact search on desktop and hide it on mobile`);
      assert.match(html, />Find controls</, `${fixture.aircraftLabel} should retain the compact desktop search launcher`);
      assert.match(html, /aircraft-specific-section--mobile-ribbon/, `${fixture.aircraftLabel} should release overflow for sticky navigation`);
      assert.match(html, /data-aircraft-section-ribbon/, `${fixture.aircraftLabel} should render the shared section ribbon`);
      assert.match(html, new RegExp(`aria-label="${fixture.aircraftLabel} page sections"`), `${fixture.aircraftLabel} ribbon should have specific navigation semantics`);
      assert.deepEqual(
        [...html.matchAll(new RegExp(`id="${fixture.sectionPrefix}([^" ]+)"`, 'g'))].map((match) => match[1]),
        fixture.sectionIds,
        `${fixture.aircraftLabel} ribbon destinations should map exactly to its existing aircraft groups`,
      );
    }
  });

  await test('PMDG 737 cold-and-dark slice stays non-prescriptive and trusts only live SDK readback', async () => {
    const readyValues = {
      'systems.electrical.batteryMode': 'on',
      'systems.electrical.standbyPowerMode': 'auto',
      'systems.electrical.busTransferAuto': true,
      'systems.electrical.groundPowerAvailable': true,
      'systems.electrical.transferBus1Powered': true,
      'systems.electrical.transferBus2Powered': true,
      'systems.electrical.apuGeneratorOffBus': false,
      'systems.electrical.batteryDischarge': false,
      'systems.electrical.standbyPowerOff': false,
      'systems.irs.leftMode': 'nav',
      'systems.irs.rightMode': 'nav',
      'systems.irs.leftAlign': true,
      'systems.irs.rightAlign': true,
      'systems.irs.leftFault': false,
      'systems.irs.rightFault': false,
      'flightControls.yawDamper': true,
      'lights.emergencyMode': 'armed',
      'systems.windowHeatCaptainForward': true,
      'systems.windowHeatFirstOfficerForward': true,
      'systems.windowHeatCaptainSide': true,
      'systems.windowHeatFirstOfficerSide': true,
      'systems.apuMode': 'off',
      'systems.apuEgt': 0,
      'systems.apuLowOilPressure': false,
      'systems.apuFault': false,
      'systems.apuOverspeed': false,
    };
    const actionCapabilities = Object.fromEntries([
      'systems.electrical.battery.on',
      'systems.electrical.standbyPower.auto',
      'systems.electrical.busTransfer.on',
      'systems.electrical.groundPower.connect',
      'systems.apu.start',
      'systems.electrical.apuGenerators.connect',
      'systems.irs.left.nav',
      'systems.irs.right.nav',
      'flightControls.yawDamper.on',
      'lights.emergency.armed',
      'systems.windowHeatCaptainForward.on',
      'systems.windowHeatFirstOfficerForward.on',
      'systems.windowHeatCaptainSide.on',
      'systems.windowHeatFirstOfficerSide.on',
    ].map((actionId) => [actionId, true]));

    const component = path.join(
      'src', 'vue', 'components', 'aircraft-specific', 'templates', 'Pmdg737AircraftPanel.vue',
    );
    const { html: liveHtml } = await renderComponent(component, () => {}, {
      props: {
        values: readyValues,
        unavailable: [],
        sourceStatus: 'connected',
        sourceStatuses: { sdk: 'connected' },
        actionCapabilities,
      },
    });
    assert.match(liveHtml, /Reference shortcuts — use your normal procedure/i, 'the guide should remain subordinate to the simmer\'s own procedure without a chatty preamble');
    assert.doesNotMatch(liveHtml, /PMDG 737 · Quick group|LIVE PMDG READBACK/, 'the modal header should avoid redundant labels and status pills');
    assert.match(liveHtml, /BUS 1 ON/, 'live electrical readback should remain visible');
    assert.match(liveHtml, /Related overhead shortcuts/, 'secondary convenience controls should remain available behind disclosure');
    assert.doesNotMatch(liveHtml, /VERIFIED|INITIAL POWER READY|\d+ \/ \d+/, 'the guide must not render checklist progress or completion claims');

    const { html: staleHtml } = await renderComponent(component, () => {}, {
      props: {
        values: readyValues,
        unavailable: [],
        sourceStatus: 'stale',
        sourceStatuses: { sdk: 'stale' },
        actionCapabilities,
      },
    });
    assert.match(staleHtml, /PMDG readback unavailable/, 'stale state should expose an explicit readback wait in the compact launcher summary');
    assert.match(staleHtml, /READBACK UNAVAILABLE/, 'stale bus state must not be presented as unpowered live data');
    assert.match(staleHtml, /BUS 1 --/, 'stale electrical values should not look live inside the guide');
    assert.doesNotMatch(staleHtml, /VERIFIED|INITIAL POWER READY|\d+ \/ \d+/, 'stale state must not reintroduce checklist semantics');
  });

  await test('AircraftTabShell renders the dedicated iFly MAX 8 page instead of broad generic controls', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
      ({ useAircraftSpecificStore }) => {
        const aircraftSpecific = useAircraftSpecificStore();
        aircraftSpecific.applyProfile({
          _profileKey: 'bundled/msfs/ifly-737-max-8',
          profileRevision: 3,
          aircraftSpecificTemplateId: 'ifly-737-max-8',
        });
        aircraftSpecific.ingestState({
          profileKey: 'bundled/msfs/ifly-737-max-8',
          profileRevision: 3,
          templateId: 'ifly-737-max-8',
          available: true,
          sourceStatus: {
            overall: 'connected',
            sources: { simvar: 'connected', lvar: 'stale' },
          },
          values: { 'mcp.altitudeFt': 28000 },
          unavailable: [],
          actionCapabilities: {},
        });
      },
    );

    assert.match(html, /data-aircraft-page-mode="specific"/, 'the trusted iFly template should own the Aircraft page');
    assert.match(html, /data-aircraft-template="ifly-737-max-8"/, 'the dedicated iFly template should render');
    assert.match(html, /iFly Boeing 737 MAX 8/, 'the page should retain concrete aircraft identity');
    assert.match(html, /Standard mirrors connected/, 'the panel should identify its generic simulator source honestly');
    assert.doesNotMatch(html, /Mode lamps|aircraft-specific alpha telemetry/, 'removed iFly LVAR telemetry must not remain advertised');
    assert.doesNotMatch(html, /id="controls-diagnostics"/, 'the broad generic control surface must not remain mounted beneath the iFly page');
  });

  await test('AircraftTabShell falls back safely when a profile names an unregistered template', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
      ({ useAircraftSpecificStore }) => {
        useAircraftSpecificStore().applyProfile({
          _profileKey: 'bundled/msfs/future-aircraft',
          profileRevision: 3,
          aircraftSpecificTemplateId: 'unregistered-template',
        });
      },
    );

    assert.match(html, /data-aircraft-page-mode="generic"/, 'unregistered templates should fail closed to generic controls');
    assert.match(html, /id="controls-diagnostics"/, 'the fallback control surface should remain usable and expose diagnostics');
    assert.doesNotMatch(html, /id="aircraft-specific-section"/, 'an unregistered template must not mount a trusted component');
  });

  await test('LastLandingSummary renders the full-report action inside the Vue shell', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LastLandingSummary.vue'),
      ({ useFlightStore }) => {
        const flight = useFlightStore();
        flight.updateLandingPreview({
          final: true,
          vs: -243,
          grade: 'PERFECT',
          runwayExcursion: true,
          icao: 'YSSY',
          runway: '34L',
          touchdownDistance: { distanceFt: 600, grade: 'Outstanding', bounceCount: 1, bounceGrade: 'Single Bounce' },
          ultimateStability: { verdict: 'unstable', score: 84, gateStable: false },
        });
      },
    );

    assert.match(html, /id="data-open-landing-btn"/, 'last landing summary should expose the full report action target');
    assert.match(html, /Full Report/, 'last landing summary should render the landing report action label');
    assert.match(html, /Touchdown[\s\S]*id="data-last-landing-grade"[^>]*>\s*PERFECT\s*</, 'last landing summary should explicitly scope the raw touchdown grade');
    assert.match(html, /id="data-last-landing-bounce"[^>]*>1x<\//, 'last landing summary should expose bounce as a peer fact');
    assert.match(html, /id="data-last-landing-stability"[^>]*>UNSTABLE<\//, 'last landing summary should expose the approach verdict independently');
    assert.match(html, /id="data-last-landing-stability"[^>]*class="[^"]*text-red-400[^"]*"/, 'last landing summary should tone an unstable approach as danger');
    assert.match(html, /id="data-last-landing-bounce"[^>]*class="[^"]*text-amber-400[^"]*"/, 'last landing summary should tone a single bounce as a warning');
    assert.match(html, /id="data-last-landing-approach-score"[^>]*>Approach score 84%<\//, 'last landing summary should subordinate and label the approach percentage');
    assert.match(html, /id="data-last-landing-tdz"[^>]*>600 ft<\//, 'last landing summary should expose TDZ distance as a separate fact');
    assert.match(html, /Outstanding/, 'last landing summary should retain the separate TDZ grade');
    assert.match(html, /Runway excursion/, 'last landing summary should retain the separate critical excursion fact');
    assert.match(html, /Touchdown rate/, 'last landing summary should use a source-neutral touchdown-rate label');
  });

  await test('FlightTelemetryPanel renders live telemetry values from the flight store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'FlightTelemetryPanel.vue'),
      ({ useFlightStore }) => {
        const flight = useFlightStore();
        flight.setFlightState('live');
        flight.updateSpeedDisplay({ ias: 141.8, gs: 153.2 });
        flight.updateVerticalSpeedDisplay(-1202);
        flight.updateAltitudeDisplay({
          msl: 3450,
          indicated: 3450,
          calibrated: 3299,
          plane: 3295,
          pressureAlt: 3561,
          ra: 175,
          aircraftAgl: 166,
          aircraftAboveObstacles: 155,
          planeAgl: 155,
          planeAglMinusCg: 148,
          kohlsmanSettingMb: 1013.25,
          kohlsmanTunedMb: 1008.4,
          kohlsmanStd: true,
        });
        flight.updateHeadingDisplay({ mag: 87 });
        flight.updateCrosswindDisplay(-16);
        flight.updateFuelDisplay({ displayValue: '1,250', unit: 'kg', totalGal: 410 });
        flight.updateGear({ nose: 1, left: 1, right: 1, parkingBrake: true });
        flight.updateFlaps({ value: { percent: 20 } });
        flight.updateSpoilers({ state: 'ARMED' });
        flight.updateEngineDisplay({ count: 3, eng1Text: '44%', eng2Text: '45%', eng3Text: '46%' });
        flight.updateEnvironment({ cabinAltFt: 12050, cabinAltRateFpm: 650, oatC: -12 });
        flight.updateLights({ nav: true, beacon: true, strobe: false, landing: true, taxi: false });
        flight.updateSpeedWarning({ type: 'stall', active: true });
        flight.showFuelExhaustedWarning({ exhausted: true });
        flight.updateCabinAltitudeWarning({ active: true, severity: 'critical', cabinAltFt: 14500 });
      },
    );

    assert.match(html, /id="flight-live-shell"/, 'panel root should keep the legacy shell id');
    assert.doesNotMatch(html, /flight-live-shell[^>]*is-muted/, 'live state should remove muted styling');
    assert.doesNotMatch(html, /id="fuel-exhausted-banner"[^>]*hidden/, 'active fuel exhausted banner should not render hidden');
    assert.match(html, /FUEL EXHAUSTED/, 'fuel exhausted banner should render when active');
    assert.doesNotMatch(html, /id="cabin-altitude-banner"[^>]*hidden/, 'active cabin altitude banner should not render hidden');
    assert.match(html, /CABIN ALT 14,500 FT/, 'critical cabin altitude banner should render from store state');
    assert.match(html, /id="ias-value"[^>]*>142</, 'IAS should render from store');
    assert.match(html, /warning-banner[^>]*>\s*<span[^>]*>STALL<\/span>/, 'speed warning overlay should render from store state');
    assert.match(html, /id="vs-value"[^>]*text-danger[^>]*>-1202</, 'descent warning should render danger tone');
    assert.match(html, /id="alt-value"[^>]*>3,450</, 'altitude should render with separators');
    assert.match(html, /id="ra-card"/, 'radio altitude card should render');
    assert.match(html, /id="ra-value"[^>]*>175</, 'radio altitude should render');
    for (const kind of ['airspeed', 'vertical-speed', 'altitude', 'radio-altitude', 'ground-speed', 'heading', 'crosswind', 'fuel']) {
      assert.match(
        html,
        new RegExp(`data-flight-metric-watermark="${kind}"`),
        `flight telemetry should render the ${kind} metric watermark`,
      );
    }
    assert.match(html, /data-watermark-symbol="aircraft-terrain-range"/, 'radio altitude should use a recognizable aircraft-to-terrain range symbol');
    assert.match(html, /data-watermark-symbol="ground-track-vector"/, 'ground speed should use a directional ground-track vector');
    assert.match(html, /<details id="flight-altitude-diagnostics"/, 'altitude diagnostics should render as a disclosure');
    assert.doesNotMatch(html, /<details id="flight-altitude-diagnostics"[^>]*\sopen(?:\s|>)/, 'altitude diagnostics should be collapsed by default');
    assert.match(html, /<summary id="flight-altitude-diagnostics-toggle"/, 'altitude diagnostics should expose a native keyboard-accessible toggle');
    assert.match(html, /id="flight-altitude-diagnostics-grid"/, 'altitude diagnostic grid should render');
    assert.match(html, /id="alt-diag-indicated-value"[^>]*>3,450</, 'explicit cockpit indication should render');
    assert.match(html, /id="alt-diag-calibrated-value"[^>]*>3,299</, 'calibrated indication should render');
    assert.match(html, /id="alt-diag-plane-value"[^>]*>3,295</, 'MSFS plane altitude should render');
    assert.match(html, /id="alt-diag-pressure-value"[^>]*>3,561</, 'pressure altitude should render');
    assert.match(html, /id="alt-diag-obstacles-value"[^>]*>155</, 'obstacle-relative altitude should render');
    assert.match(html, /id="alt-diag-baro-effective-value"[^>]*>1013.25</, 'effective barometer should render');
    assert.match(html, /id="alt-diag-baro-tuned-value"[^>]*>1008.40</, 'tuned barometer should render');
    assert.match(html, /id="alt-diag-baro-mode-value"[^>]*>STD</, 'STD mode should render');
    assert.match(html, /id="hdg-value"[^>]*>087</, 'heading should be padded');
    assert.match(html, /id="xwind-value"[^>]*text-danger[^>]*>16</, 'crosswind tone should render');
    assert.match(html, /id="fuel-unit-btn"[^>]*>kg</, 'fuel unit button should render selected unit');
    assert.match(html, /id="fuel-value"[^>]*text-warning[^>]*>1,250</, 'fuel value should render warning tone');
    assert.match(html, /id="flight-systems-grid"[^>]*telemetry-grid-systems[^>]*lg:grid-cols-4/, 'systems cards should use compact telemetry-grid sizing');
    assert.match(html, /id="gear-state"[^>]*>DOWN</, 'gear state should render');
    assert.match(html, /id="parking-brake"[^>]*set/, 'parking brake should render set state');
    assert.match(html, /id="flaps-value"[^>]*>20</, 'flaps should render percentage');
    assert.match(html, /id="spoilers-value"[^>]*>ARMED</, 'spoilers should render state');
    assert.match(html, /id="eng3-card"[^>]*>/, 'third engine card should render');
    assert.match(html, /id="eng3-value"[^>]*>46%<\/div>/, 'third engine value should render');
    assert.match(html, /id="eng4-card"[^>]*hidden/, 'fourth engine should stay hidden');
    assert.match(html, /id="cabin-alt-card"[^>]*border-red-500/, 'critical cabin altitude should tint the card red');
    assert.match(html, /id="cabin-alt-value"[^>]*text-warning[^>]*>12,050</, 'cabin altitude should render warning tone');
    assert.match(html, /id="cabin-vs-value"[^>]*text-warning[^>]*>\+650</, 'cabin vertical speed should render warning tone');
    assert.match(html, /id="oat-value"[^>]*>-12</, 'outside air temperature should render');
    assert.match(html, /id="light-nav"[^>]*light-indicator on/, 'nav light should render on');
    assert.match(html, /id="light-bcn"[^>]*light-indicator on/, 'beacon light should render on');
    assert.match(html, /id="lights-na"[^>]*hidden/, 'lights unavailable copy should stay hidden when data is available');
  });

  await test('QuickGlanceBar renders approach values and gear dots from the flight store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'QuickGlanceBar.vue'),
      ({ useFlightStore }) => {
        const flight = useFlightStore();
        flight.updateSpeedDisplay({ ias: 138 });
        flight.updateVerticalSpeedDisplay(-702);
        flight.updateAltitudeDisplay({ ra: 96 });
        flight.updateGear({ nose: 0.5, left: 1, right: 0 });
      },
    );

    assert.match(html, /id="qg-ias"[^>]*>138</, 'quick glance IAS should render');
    assert.match(html, /id="qg-vs"[^>]*>-702</, 'quick glance vertical speed should render');
    assert.match(html, /id="qg-ra"[^>]*>96</, 'quick glance radio altitude should render');
    assert.match(html, /id="qg-gear-l"[^>]*down/, 'left quick glance gear dot should render down');
    assert.match(html, /id="qg-gear-c"[^>]*transit/, 'center quick glance gear dot should render transit');
    assert.match(html, /id="qg-gear-r"[^>]*qg-gear-dot"/, 'right quick glance gear dot should render up/default');
  });

  console.log('\n--- live map header ---\n');
  await test('LiveMapHeader renders paused follow state and route inputs', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LiveMapHeader.vue'),
      ({ useLiveMapStore }) => {
        const store = useLiveMapStore();
        store.setFollowStatus('paused');
        store.setMeta('Tracking live telemetry');
        store.setTargetInput('egll');
        store.setTargetStatus('Target airport set');
        store.setOriginInput('kjfk');
        store.setOriginStatus('Origin airport set');
      },
    );

    assert.match(html, />Paused</, 'paused follow badge should render');
    assert.match(html, />Resume Follow</, 'center button should switch to resume label');
    assert.match(html, /Tracking live telemetry/, 'meta text should render');
    assert.doesNotMatch(html, /live-map-route-details/, 'route disclosure button should not render');
    assert.match(
      html,
      /class="live-map-inline-meta"[\s\S]*id="live-map-meta"[\s\S]*id="live-map-route-inputs"/,
      'route controls should sit in the live-map header grid',
    );
    assert.match(html, /id="live-map-route-inputs" class="live-map-route-inputs"/, 'route inputs should render without collapsed state');
    assert.match(
      html,
      /id="live-map-route-inputs"[\s\S]*id="live-map-origin-icao"[\s\S]*id="live-map-target-icao"/,
      'origin/from controls should render above target/to controls',
    );
    assert.match(html, /value="EGLL"/, 'target ICAO should render sanitized');
    assert.match(html, /value="KJFK"/, 'origin ICAO should render sanitized');
    assert.match(html, /Target airport set/, 'target status copy should render');
    assert.match(html, /Origin airport set/, 'origin status copy should render');
  });

  await test('LiveMapTabShell renders map controller targets and embedded Vue panels', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LiveMapTabShell.vue'),
      ({ useLiveMapStore }) => {
        const liveMap = useLiveMapStore();
        liveMap.setMeta('Lat 39.87440 Lon -75.24230');
        liveMap.setOverlay({ visible: true, rotationDeg: 12, primary: 'KBOS', secondary: '120 NM' });
      },
    );

    assert.match(html, /SIM IS IN MENUS/, 'menu overlay should render');
    assert.match(html, /id="vue-live-map-header-root"/, 'live map header wrapper should render');
    assert.match(html, /id="live-map-meta"[^>]*>Lat 39\.87440 Lon -75\.24230</, 'embedded header should render store metadata');
    assert.match(html, /id="live-map"/, 'Leaflet live map target should render');
    assert.match(html, /id="vue-live-map-overlay-root"/, 'target overlay wrapper should render');
    assert.match(html, /id="live-map-target-overlay"/, 'embedded target overlay should render');
    assert.match(html, /id="live-map-target-primary"[^>]*>KBOS</, 'target overlay should render primary text');
    assert.match(html, /id="live-map-empty"[^>]*>No live GPS position yet</, 'live map empty state target should render');
  });

  await test('aircraft-specific template registry rejects inherited object keys', async () => {
    assert.ok(resolveAircraftSpecificTemplate('asobo-787'), 'registered Microsoft / Asobo 787-10 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('fbw-a32nx'), 'registered FlyByWire A32NX template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('fenix-a32x'), 'registered Fenix A32x compatibility template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('fbw-a380x'), 'registered FlyByWire A380X template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('ifly-737-max-8'), 'registered iFly 737 MAX 8 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('inibuilds-a310'), 'registered Microsoft / iniBuilds A310-300 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('inibuilds-a330'), 'registered iniBuilds A330 family template should resolve');
    assert.equal(resolveAircraftSpecificTemplate('inibuilds-a350'), null, 'deferred iniBuilds A350 integration must not resolve');
    assert.ok(resolveAircraftSpecificTemplate('inibuilds-tristar'), 'registered iniBuilds TriStar template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('microsoft-737-max-8'), 'registered Microsoft 737 MAX 8 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('microsoft-atr-72-600'), 'registered Microsoft ATR 72-600 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('microsoft-inibuilds-a32x'), 'registered Microsoft / iniBuilds A320neo V2 and A321LR template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('pmdg-737'), 'registered PMDG 737 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('pmdg-777'), 'registered PMDG 777 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('tfdi-md-11'), 'registered TFDi Design MD-11 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('workingtitle-747-8'), 'registered Microsoft / Asobo 747-8 template should resolve');
    for (const inheritedObjectKey of ['constructor', 'toString', '__proto__']) {
      assert.equal(resolveAircraftSpecificTemplate(inheritedObjectKey), null);
    }
  });

  await test('Microsoft / iniBuilds A310-300 monitoring page renders exact identity and FCP fields', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'MicrosoftIniBuildsA310AircraftPanel.vue'),
      () => {},
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'fcp.speedKts': 156,
            'fcp.headingDeg': 184,
            'fcp.altitudeFt': 9000,
            'fcp.verticalSpeedFpm': -700,
            'fcp.lnav': true,
            'systems.engine1N1': 91.2,
          },
        },
      },
    );
    assert.match(html, /data-aircraft-template="inibuilds-a310"/);
    assert.match(html, /Microsoft \/ iniBuilds Airbus A310-300/);
    assert.match(html, />156</);
    assert.match(html, />184\u00b0</);
    assert.match(html, /Flight Control Panel/);
    assert.match(html, /NAV/);
    assert.doesNotMatch(html, />LOC\s*</, 'the page must not render a localizer indicator without a supported readback');
    assert.match(html, /Monitoring only/);
  });

  await test('TFDi Design MD-11 page renders vendor AFS modes, AP state, and all three engines', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'TfdiMd11AircraftPanel.vue'),
      () => {},
      {
        props: {
          profileKey: 'bundled/msfs/tfdi-md-11',
          sourceStatus: 'connected',
          values: {
            'afs.speedValue': 0.82,
            'afs.headingValue': 274,
            'afs.altitudeValue': 11000,
            'afs.verticalValue': -2.5,
            'afs.speedMode': 'mach',
            'afs.headingMode': 'track',
            'afs.verticalMode': 'flight-path-angle',
            'afs.altitudeUnit': 'feet',
            'afs.apState': 'dual',
            'afs.apMaster': true,
            'afs.atsClamped': true,
            'performance.v1': 144,
            'performance.vr': 151,
            'performance.v2': 158,
            'performance.vsr': 210,
            'performance.vfr': 190,
            'systems.engine1N1': 83.2,
            'systems.engine2N1': 82.9,
            'systems.engine3N1': 83.1,
            'systems.engine1Running': true,
            'systems.engine2Running': true,
            'systems.engine3Running': true,
            'systems.apuState': 'running',
            'systems.apuN1': 99.4,
            'systems.apuN2': 100,
            'systems.grossWeightLbs': 520000,
          },
        },
      },
    );

    assert.match(html, /data-aircraft-template="tfdi-md-11"/);
    assert.match(html, /TFDi Design MD-11/);
    assert.match(html, /data-tfdi-afs-field="afs\.speedValue"[\s\S]*0\.82[\s\S]*MACH/);
    assert.match(html, /data-tfdi-afs-field="afs\.headingValue"[\s\S]*TRK[\s\S]*274/);
    assert.match(html, /data-tfdi-ap-state[\s\S]*AP 1\+2/);
    assert.match(html, /data-tfdi-engine="2"[\s\S]*TAIL/);
    assert.match(html, /data-tfdi-engine="3"[\s\S]*83\.1/);
    assert.match(html, /data-tfdi-apu-state[\s\S]*RUNNING/);
    assert.match(html, /Monitoring only/);
    assert.doesNotMatch(html, /<button|data-aircraft-action=/, 'TFDi page must expose no unverified writes');
  });

  await test('TFDi Design MD-11 page renders documented dashed-window sentinels as unavailable', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'TfdiMd11AircraftPanel.vue'),
      () => {},
      {
        props: {
          values: {
            'afs.speedValue': -999,
            'afs.headingValue': -999,
            'afs.verticalValue': -9999,
            'afs.speedMode': 'ias',
            'afs.headingMode': 'heading',
            'afs.verticalMode': 'vertical-speed',
          },
        },
      },
    );

    assert.match(html, /data-tfdi-afs-field="afs\.speedValue"[\s\S]*>---\s*</);
    assert.match(html, /data-tfdi-afs-field="afs\.headingValue"[\s\S]*>---(?:&amp;deg;|°|&deg;)/);
    assert.match(html, /data-tfdi-afs-field="afs\.verticalValue"[\s\S]*>----\s*</);
    assert.doesNotMatch(html, /data-tfdi-afs-field="afs\.(?:speedValue|headingValue|verticalValue)"[^>]*>[\s\S]*>-9999?\s*</);
  });

  await test('FlyByWire A380X template renders its exact compact guarded control surface', async () => {
    const actionIds = [
      'flightGuidance.speed.set',
      'flightGuidance.heading.set',
      'flightGuidance.altitude.set',
      'propulsion.throttle.toga',
      'propulsion.throttle.flexMct',
      'propulsion.throttle.climb',
      'propulsion.throttle.idle',
      'flightGuidance.ap1.off',
      'flightGuidance.ap1.on',
      'flightGuidance.autothrust.off',
      'flightGuidance.autothrust.on',
      'flightGuidance.localizer.off',
      'flightGuidance.localizer.on',
      'flightGuidance.approach.off',
      'flightGuidance.approach.on',
      ...['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi']
        .flatMap((lightId) => [`lights.${lightId}.off`, `lights.${lightId}.on`]),
      'controls.gear.up',
      'controls.gear.down',
      'controls.parkingBrake.released',
      'controls.parkingBrake.set',
      'controls.spoilersArmed.off',
      'controls.spoilersArmed.on',
      'controls.flaps.decrease',
      'controls.flaps.increase',
      'controls.spoilers.set',
    ];
    const values = {
      'propulsion.throttleLever1Angle': 35,
      'propulsion.throttleLever2Angle': 35,
      'propulsion.throttleLever3Angle': 35,
      'propulsion.throttleLever4Angle': 35,
      'flightGuidance.speedValue': 287,
      'flightGuidance.headingDeg': 43,
      'flightGuidance.altitudeFt': 37000,
      'flightGuidance.verticalValue': -650.5,
      'flightGuidance.ap1': true,
      'flightGuidance.ap2': false,
      'flightGuidance.autothrust': true,
      'flightGuidance.autothrustStatus': 'active',
      'flightGuidance.localizer': true,
      'flightGuidance.approach': false,
      'lights.strobe': true,
      'lights.beacon': false,
      'lights.nav': true,
      'lights.logo': true,
      'lights.wing': false,
      'lights.landing': true,
      'lights.taxi': false,
      'lights.runwayTurnoff': true,
      'controls.flapsIndex': 2,
      'controls.spoilersHandle': 0.25,
      'controls.spoilersArmed': true,
      'controls.parkingBrake': false,
      'controls.gearHandleDown': true,
      'controls.gearNosePct': 100,
      'controls.gearLeftPct': 100,
      'controls.gearRightPct': 100,
      'systems.engine1N1': 84.1,
      'systems.engine2N1': 84.2,
      'systems.engine3N1': 84.3,
      'systems.engine4N1': 84.4,
      'systems.engine1Running': true,
      'systems.engine2Running': true,
      'systems.engine3Running': true,
      'systems.engine4Running': true,
      'systems.fuelTotalPct': 62.5,
      'systems.fuelTotalWeightLbs': 318000,
      'systems.grossWeightLbs': 1020000,
      'systems.cabinAltitudeFt': 6850,
      'systems.cabinVerticalSpeedFpm': 120,
      'systems.cabinDeltaPressurePsi': 8.32,
      'systems.outsideAirTemperatureC': -52.4,
      'systems.mach': 0.84,
    };
    assert.equal(Object.keys(values).length, 46, 'the fixture should exercise every A380X adapter field');
    assert.equal(actionIds.length, 38, 'the fixture should exercise every A380X adapter action capability');

    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FbwA380xAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fbw-a380x',
          sourceStatus: 'connected',
          values,
          actionCapabilities: Object.fromEntries(actionIds.map((actionId) => [actionId, true])),
        },
      },
    );

    assert.match(html, /data-aircraft-template="fbw-a380x"/, 'template should identify the exact trusted adapter');
    assert.match(html, /FlyByWire A380X/, 'the exact aircraft title should render');
    const throttleHtml = html.match(/<section(?=[^>]*data-fbw-section="virtual-throttle")[\s\S]*?<\/section>/)?.[0] || '';
    assert.match(throttleHtml, /all 4 levers \u00b7 calibrated forward detents/i);
    assert.match(throttleHtml, /ENG 1 FLX \/ MCT/);
    assert.match(throttleHtml, /ENG 4 FLX \/ MCT/);
    assert.match(throttleHtml, /data-fbw-throttle-detent="flexMct"[^>]*aria-pressed="true"/);
    assert.doesNotMatch(throttleHtml, /type="range"|drag|slide/i, 'the A380X throttle must remain a one-tap detent control');
    assert.deepEqual(
      [...html.matchAll(/data-a380-section="([^"]+)"/g)].map((match) => match[1]),
      ['fcu-autopilot', 'exterior-lights', 'flight-configuration', 'systems'],
      'the compact page should contain only its four intended sections',
    );
    assert.match(html, /data-a380-selector="speed"[\s\S]*>287 <span[^>]*>kt<\/span>/, 'selected speed should render with its FCU unit');
    assert.match(html, /data-a380-selector="heading"[\s\S]*>043 <span[^>]*>deg<\/span>/, 'selected heading should retain three digits');
    assert.match(html, /data-a380-selector="altitude"[\s\S]*>37,000 <span[^>]*>ft<\/span>/, 'selected altitude should use grouped feet');
    assert.match(html, /AP 2[\s\S]*?OFF[\s\S]*?Read only/, 'AP2 should remain an explicit read-only readback');
    assert.match(html, /VERTICAL TARGET[\s\S]*?-650[\s\S]*?Read only; no unit is inferred/, 'ambiguous V\/S-FPA should remain read-only and unitless');
    assert.match(html, /data-a380-light="runway-turnoff-readonly"[\s\S]*Read only\. A distinct verified write route is not mapped\./, 'runway-turnoff should remain honestly read-only');
    assert.match(html, /data-a380-engine="4"[\s\S]*ENG 4 N1[\s\S]*RUN[\s\S]*84\.4%/, 'the fourth engine should render its running and N1 readbacks');

    const renderedActionIds = [...html.matchAll(/data-aircraft-action="([^"]+)"/g)].map((match) => match[1]);
    const uniqueRenderedActionIds = [...new Set(renderedActionIds)];
    assert.deepEqual(
      [...uniqueRenderedActionIds].sort(),
      [...actionIds].sort(),
      'the panel should expose all and only the 38 adapter actions',
    );
    assert.equal(
      renderedActionIds.filter((actionId) => actionId === 'controls.spoilers.set').length,
      5,
      'the one bounded spoiler action should render at its five supported detents',
    );

    for (const lightActionId of actionIds.filter((actionId) => actionId.startsWith('lights.'))) {
      const lightButton = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${lightActionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
      assert.ok(lightButton, `${lightActionId} should render`);
      assert.doesNotMatch(lightButton, /\saria-pressed=/, `${lightActionId} must not present a lamp output as selector position`);
      assert.doesNotMatch(lightButton, /border-cyan-400\/60|bg-cyan-400\/15/, `${lightActionId} must not style lamp output as selector position`);
    }
    assert.match(html, /data-a380-light="strobe"[\s\S]*OUTPUT ON/, 'live lamp output should remain visible as readback');

    const renderedIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicateIds = renderedIds.filter((id, index) => renderedIds.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicateIds)], [], 'every A380X status and input id should be unique');
    assert.doesNotMatch(html, /A32NX_|FlyByWire A32NX|FbwA32nx|AUTOPILOT |LIGHT |TURB ENG|PRESSURIZATION |MobiFlight|MF\.SimVars/, 'raw simulator routes and A32NX page copy must stay outside Vue');
    assert.doesNotMatch(html, /Monitoring only/, 'the A380X page should not claim to be monitoring-only');
  });

  await test('FlyByWire A380X controls fail closed for missing readback and pending groups', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FbwA380xAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fbw-a380x',
          sourceStatus: 'connected',
          values: {
            'flightGuidance.ap1': true,
            'lights.beacon': false,
          },
          actionCapabilities: {
            'flightGuidance.speed.set': true,
            'flightGuidance.ap1.off': true,
            'flightGuidance.ap1.on': true,
            'lights.beacon.off': true,
            'lights.beacon.on': true,
          },
          isActionPending: (groupId) => groupId === 'lights.beacon',
        },
      },
    );

    const speedSubmit = html.match(/<button(?=[^>]*data-aircraft-action="flightGuidance\.speed\.set")[^>]*>/)?.[0] || '';
    assert.match(speedSubmit, /\sdisabled(?:=| |>)/, 'speed capability must not bypass missing live target readback');
    assert.match(speedSubmit, /title="Live target readback unavailable\."/, 'missing target readback should explain why the write is disabled');

    for (const actionId of ['lights.beacon.off', 'lights.beacon.on']) {
      const button = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} should disable while its physical group is pending`);
      assert.match(button, /aria-busy="true"/, `${actionId} should expose pending state accessibly`);
      assert.match(button, /title="Command in progress\."/, `${actionId} should explain its pending guard`);
    }
  });

  await test('FlyByWire A380X controls expose and obey the global disabled reason', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FbwA380xAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({
          enabled: false,
          reason: 'Aircraft writes disabled by operator.',
        });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fbw-a380x',
          sourceStatus: 'connected',
          values: { 'flightGuidance.ap1': true },
          actionCapabilities: {
            'flightGuidance.ap1.off': true,
            'flightGuidance.ap1.on': true,
          },
        },
      },
    );

    assert.match(html, /Aircraft writes disabled by operator\./, 'the page should expose the store-provided global reason');
    for (const actionId of ['flightGuidance.ap1.off', 'flightGuidance.ap1.on']) {
      const button = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} should obey global write availability`);
      assert.match(button, /title="Aircraft writes disabled by operator\."/, `${actionId} should expose the global disabled reason`);
    }
  });

  await test('Microsoft / iniBuilds shared A32x panel renders both exact variants and only its compact 42-action surface', async () => {
    const guidancePrefixes = [
      'flightGuidance.apMaster',
      'flightGuidance.flightDirector',
      'flightGuidance.autothrottleArmed',
      'flightGuidance.speedHold',
      'flightGuidance.headingHold',
      'flightGuidance.altitudeHold',
      'flightGuidance.verticalSpeedHold',
      'flightGuidance.navHold',
      'flightGuidance.approachHold',
    ];
    const lightIds = ['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi'];
    const actionIds = [
      ...guidancePrefixes.flatMap((prefix) => [`${prefix}.off`, `${prefix}.on`]),
      'flightGuidance.speed.set',
      'flightGuidance.heading.set',
      'flightGuidance.altitude.set',
      'flightGuidance.verticalSpeed.set',
      ...lightIds.flatMap((lightId) => [`lights.${lightId}.off`, `lights.${lightId}.on`]),
      'controls.gear.up',
      'controls.gear.down',
      'controls.flaps.decrease',
      'controls.flaps.increase',
      'controls.parkingBrake.off',
      'controls.parkingBrake.on',
    ];
    assert.equal(actionIds.length, 42, 'the shared compact contract should contain exactly 42 actions');
    assert.equal(new Set(actionIds).size, 42, 'the expected action contract should not contain duplicates');

    const variants = [
      {
        profileKey: 'bundled/msfs/inibuilds-a320neo-v2',
        expectedTitle: 'Microsoft / iniBuilds Airbus A320neo V2',
        unexpectedTitle: 'Microsoft / iniBuilds Airbus A321LR',
        speed: 151,
        heading: 43,
      },
      {
        profileKey: 'bundled/msfs/inibuilds-a321lr',
        expectedTitle: 'Microsoft / iniBuilds Airbus A321LR',
        unexpectedTitle: 'Microsoft / iniBuilds Airbus A320neo V2',
        speed: 162,
        heading: 278,
      },
    ];
    const baseValues = {
      'fcu.altitudeFt': 11000,
      'fcu.verticalSpeedFpm': -650,
      'flightGuidance.apMaster': true,
      'flightGuidance.flightDirector': true,
      'flightGuidance.autothrottleActive': true,
      'flightGuidance.autothrottleArmed': true,
      'flightGuidance.speedHold': true,
      'flightGuidance.headingHold': false,
      'flightGuidance.navHold': true,
      'flightGuidance.altitudeHold': false,
      'flightGuidance.verticalSpeedHold': true,
      'flightGuidance.flightLevelChange': false,
      'flightGuidance.approachHold': false,
      'lights.strobe': true,
      'lights.beacon': false,
      'lights.nav': true,
      'lights.logo': true,
      'lights.wing': false,
      'lights.landing': false,
      'lights.taxi': false,
      'lights.runwayTurnoff': true,
      'controls.flapsPercent': 25,
      'controls.flapsIndex': 1,
      'controls.flapAngleDeg': 10,
      'controls.speedbrakePercent': 0,
      'controls.gearHandleDown': true,
      'controls.gearNosePct': 100,
      'controls.gearLeftPct': 100,
      'controls.gearRightPct': 100,
      'controls.parkingBrake': false,
      'systems.engine1N1': 88.6,
      'systems.engine2N1': 88.4,
      'systems.engine1Running': true,
      'systems.engine2Running': true,
    };

    for (const variant of variants) {
      const { html } = await renderComponent(
        path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'MicrosoftIniBuildsA32xAircraftPanel.vue'),
        ({ useAircraftControlsStore }) => {
          useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
        },
        {
          props: {
            profileKey: variant.profileKey,
            sourceStatus: 'connected',
            values: {
              ...baseValues,
              'fcu.speedKts': variant.speed,
              'fcu.headingDeg': variant.heading,
            },
            actionCapabilities: Object.fromEntries(actionIds.map((actionId) => [actionId, true])),
          },
        },
      );

      assert.match(html, /data-aircraft-template="microsoft-inibuilds-a32x"/, 'template should identify the shared exact-profile adapter');
      assert.ok(html.includes(`data-aircraft-profile-key="${variant.profileKey}"`), 'the exact trusted profile key should be visible on the page root');
      assert.ok(html.includes(variant.expectedTitle), `${variant.expectedTitle} should render`);
      assert.ok(!html.includes(variant.unexpectedTitle), `${variant.unexpectedTitle} should not render`);
      assert.match(html, new RegExp(`data-microsoft-inibuilds-a32x-selector="speed"[\\s\\S]*?>${variant.speed} <span[^>]*>kt<\\/span>`), 'FCU speed should render with its unit');
      assert.match(html, new RegExp(`data-microsoft-inibuilds-a32x-selector="heading"[\\s\\S]*?>${String(variant.heading).padStart(3, '0')} <span[^>]*>deg<\\/span>`), 'FCU heading should retain three digits');
      assert.match(html, /data-microsoft-inibuilds-a32x-selector="altitude"[\s\S]*?>11,000 <span[^>]*>ft<\/span>/, 'FCU altitude should use grouped feet');
      assert.match(html, /data-microsoft-inibuilds-a32x-selector="vertical-speed"[\s\S]*?>-650 <span[^>]*>fpm<\/span>/, 'FCU vertical speed should render as a typed target');
      assert.deepEqual(
        [...html.matchAll(/data-microsoft-inibuilds-a32x-selector="([^"]+)"/g)].map((match) => match[1]),
        ['speed', 'heading', 'altitude', 'vertical-speed'],
        'the page should expose exactly four typed FCU targets',
      );
      assert.equal((html.match(/type="text"/g) || []).length, 4, 'all four targets should use text entry rather than increment/decrement controls');

      assert.deepEqual(
        [...html.matchAll(/data-microsoft-inibuilds-a32x-mode="([^"]+)"/g)].map((match) => match[1]),
        ['ap', 'fd', 'athr', 'speed', 'heading', 'altitude', 'vertical-speed', 'nav', 'approach'],
        'the page should expose exactly nine standard guidance mode pairs',
      );
      assert.deepEqual(
        [...html.matchAll(/data-microsoft-inibuilds-a32x-light="([^"]+)"/g)].map((match) => match[1]),
        [...lightIds, 'runway-turnoff-readonly'],
        'the page should expose seven writable light outputs and one read-only turnoff output',
      );
      assert.deepEqual(
        [...html.matchAll(/data-microsoft-inibuilds-a32x-surface="([^"]+)"/g)].map((match) => match[1]),
        ['gear', 'parking-brake', 'flaps'],
        'gear, parking brake, and flaps should be the only writable configuration groups',
      );

      const renderedActionIds = [...html.matchAll(/data-aircraft-action="([^"]+)"/g)].map((match) => match[1]);
      assert.equal(renderedActionIds.length, 42, 'every compact action should render exactly once');
      assert.equal(new Set(renderedActionIds).size, 42, 'rendered aircraft action ids should be unique');
      assert.deepEqual([...renderedActionIds].sort(), [...actionIds].sort(), 'the panel should expose all and only the shared 42-action contract');
      for (const prefix of guidancePrefixes) {
        assert.ok(renderedActionIds.includes(`${prefix}.off`), `${prefix}.off should render`);
        assert.ok(renderedActionIds.includes(`${prefix}.on`), `${prefix}.on should render`);
      }

      for (const lightId of lightIds) {
        assert.match(html, new RegExp(`data-microsoft-inibuilds-a32x-light="${lightId}"[\\s\\S]*?OUTPUT (?:ON|OFF)`), `${lightId} should expose lamp-output readback`);
        for (const suffix of ['off', 'on']) {
          const actionId = `lights.${lightId}.${suffix}`;
          const button = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
          assert.ok(button, `${actionId} should render`);
          assert.doesNotMatch(button, /\saria-pressed=/, `${actionId} must not present lamp output as cockpit selector position`);
          assert.doesNotMatch(button, /border-cyan-400\/60|bg-cyan-400\/15/, `${actionId} must not use selected-state styling from lamp output`);
        }
      }

      assert.match(html, /A\/THR ACTIVE[\s\S]*?Read only/, 'active autothrust should remain a read-only state separate from armed control');
      assert.match(html, /FLC[\s\S]*?Read only/, 'flight-level change should remain read-only');
      assert.match(html, /data-microsoft-inibuilds-a32x-light="runway-turnoff-readonly"[\s\S]*?Read only\. No distinct compatible write route is mapped\./, 'runway turnoff should remain read-only');
      assert.match(html, /SPEEDBRAKE[\s\S]*?Read only/, 'speedbrake should remain read-only');
      assert.match(html, /data-aircraft-action="controls\.gear\.down"/, 'gear commands should render');
      assert.match(html, /data-aircraft-action="controls\.flaps\.increase"/, 'flap commands should render');
      assert.match(html, /data-aircraft-action="controls\.parkingBrake\.on"/, 'parking-brake commands should render');

      const renderedIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
      const duplicateIds = renderedIds.filter((id, index) => renderedIds.indexOf(id) !== index);
      assert.deepEqual([...new Set(duplicateIds)], [], 'every shared-A32x input and status id should be unique');
      assert.doesNotMatch(html, /AUTOPILOT_(?:ON|OFF)|AP_(?:SPD|HDG|ALT|VS|NAV|APR)|HEADING_BUG_SET|LIGHTS_SET|GEAR_(?:UP|DOWN)|FLAPS_(?:INCR|DECR)|PARKING_BRAKE_SET|TURB ENG|PRESSURIZATION |MobiFlight|MF\.SimVars/, 'raw simulator routes must stay outside Vue');
      assert.doesNotMatch(html, /data-aircraft-action="(?:flightGuidance\.(?:ap1|ap2|flightLevelChange)|lights\.runwayTurnoff|controls\.(?:speedbrake|spoilers)|systems\.)/, 'AP1/AP2, FLC, turnoff, spoiler, and deep-system writes must stay absent');
      assert.doesNotMatch(html, /data-aircraft-action="[^"]*(?:managed|selected|push|pull)/i, 'managed/selected and push/pull controls must stay absent');
      assert.doesNotMatch(html, /Monitoring only/, 'the compact shared page should no longer claim to be monitoring-only');
    }
  });

  await test('Microsoft / iniBuilds shared A32x controls fail closed across readback, capability, and pending boundaries', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'MicrosoftIniBuildsA32xAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/inibuilds-a320neo-v2',
          sourceStatus: 'connected',
          values: {
            'lights.nav': true,
            'controls.gearHandleDown': true,
          },
          actionCapabilities: {
            'flightGuidance.speed.set': true,
            'lights.beacon.off': true,
            'lights.beacon.on': true,
            'controls.gear.up': true,
            'controls.gear.down': true,
          },
          isActionPending: (groupId) => groupId === 'controls.gear',
        },
      },
    );
    const buttonFor = (actionId) => html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';

    const speedSubmit = buttonFor('flightGuidance.speed.set');
    assert.match(speedSubmit, /\sdisabled(?:=| |>)/, 'numeric capability must not bypass missing target readback');
    assert.match(speedSubmit, /title="Live target readback unavailable\."/, 'missing numeric readback should expose its reason');
    for (const actionId of ['lights.beacon.off', 'lights.beacon.on']) {
      const button = buttonFor(actionId);
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} capability must not bypass missing lamp readback`);
      assert.match(button, /title="Live aircraft readback unavailable\."/, `${actionId} should explain its missing readback`);
    }
    for (const actionId of ['lights.nav.off', 'lights.nav.on']) {
      const button = buttonFor(actionId);
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} readback must not bypass missing capability`);
      assert.match(button, /title="Compatible aircraft control unavailable\."/, `${actionId} should explain its missing capability`);
    }
    for (const actionId of ['flightGuidance.headingHold.off', 'flightGuidance.headingHold.on']) {
      const button = buttonFor(actionId);
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} should fail closed when both capability and readback are absent`);
      assert.match(button, /title="Live aircraft readback unavailable\."/, `${actionId} should report the first missing safety prerequisite`);
    }
    for (const actionId of ['controls.gear.up', 'controls.gear.down']) {
      const button = buttonFor(actionId);
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} should disable while its physical group is pending`);
      assert.match(button, /aria-busy="true"/, `${actionId} should expose pending state accessibly`);
      assert.match(button, /title="Command in progress\."/, `${actionId} should explain its pending guard`);
    }
  });

  await test('Microsoft / iniBuilds shared A32x controls expose and obey the global disabled reason', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'MicrosoftIniBuildsA32xAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({
          enabled: false,
          reason: 'Aircraft writes disabled by operator.',
        });
      },
      {
        props: {
          profileKey: 'bundled/msfs/inibuilds-a321lr',
          sourceStatus: 'connected',
          values: {
            'fcu.speedKts': 250,
            'lights.beacon': false,
            'controls.parkingBrake': false,
          },
          actionCapabilities: {
            'flightGuidance.speed.set': true,
            'lights.beacon.off': true,
            'lights.beacon.on': true,
            'controls.parkingBrake.off': true,
            'controls.parkingBrake.on': true,
          },
        },
      },
    );

    assert.match(html, /Aircraft writes disabled by operator\./, 'the page should expose the store-provided global reason');
    for (const actionId of [
      'flightGuidance.speed.set',
      'lights.beacon.off',
      'lights.beacon.on',
      'controls.parkingBrake.off',
      'controls.parkingBrake.on',
    ]) {
      const button = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} should obey global write availability`);
      assert.match(button, /title="Aircraft writes disabled by operator\."/, `${actionId} should expose the global disabled reason`);
    }
  });

  await test('Microsoft 737 MAX 8 typed targets dispatch only exact bounded values', async () => {
    const calls = [];
    const cases = [
      {
        config: {
          actionId: 'flightGuidance.speed.set', fieldId: 'mcp.speedKts', min: 100, max: 399, step: 1,
        },
        groupId: 'flightGuidance.speed', valid: '250', expected: 250, invalid: ['99', '399.5', '400'],
      },
      {
        config: {
          actionId: 'flightGuidance.heading.set', fieldId: 'mcp.headingDeg', min: 0, max: 359, step: 1,
        },
        groupId: 'flightGuidance.heading', valid: '043', expected: 43, invalid: ['-1', '43.5', '360'],
      },
      {
        config: {
          actionId: 'flightGuidance.altitude.set', fieldId: 'mcp.altitudeFt', min: 0, max: 49000, step: 100,
        },
        groupId: 'flightGuidance.altitude', valid: '41000', expected: 41000, invalid: ['-100', '41050', '49100'],
      },
      {
        config: {
          actionId: 'flightGuidance.verticalSpeed.set', fieldId: 'mcp.verticalSpeedFpm', min: -6000, max: 6000, step: 100,
        },
        groupId: 'flightGuidance.verticalSpeed', valid: '-900', expected: -900, invalid: ['-6100', '-650', '6100'],
      },
    ];

    for (const targetCase of cases) {
      assert.equal(submitMcpDraft({
        config: targetCase.config,
        disabled: false,
        groupId: targetCase.groupId,
        rawValue: targetCase.valid,
        requestAction: (...args) => {
          calls.push(args);
          return true;
        },
      }), true, `${targetCase.config.actionId} should accept its aligned in-range target`);
      assert.deepEqual(
        calls.at(-1),
        [targetCase.config.actionId, targetCase.groupId, targetCase.expected],
        `${targetCase.config.actionId} should retain its exact action, group, and numeric value`,
      );
      for (const invalidValue of targetCase.invalid) {
        assert.equal(submitMcpDraft({
          config: targetCase.config,
          disabled: false,
          groupId: targetCase.groupId,
          rawValue: invalidValue,
          requestAction: (...args) => calls.push(args),
        }), false, `${targetCase.config.actionId} should reject invalid target ${invalidValue}`);
      }
    }
    assert.equal(calls.length, cases.length, 'invalid MAX targets must never dispatch');
  });

  await test('Microsoft 737 MAX 8 numeric drafts discard stale intent and reconcile pending readback', async () => {
    const componentPath = path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'aircraft-specific',
      'templates',
      'Microsoft737Max8AircraftPanel.vue',
    );
    const componentUrl = `${pathToFileURL(compileVueComponent(componentPath)).href}?t=max-draft-lifecycle-${Date.now()}`;
    const { reconcileMicrosoft737Max8NumericDraftState } = await import(componentUrl);
    const profileKey = 'bundled/msfs/microsoft-737-max-8';
    const snapshot = (overrides = {}) => ({
      rawValue: 12000,
      unavailable: false,
      profileKey,
      sourceStatus: 'connected',
      pending: false,
      ...overrides,
    });
    const previous = (overrides = {}) => {
      const value = snapshot(overrides);
      return [value.rawValue, value.unavailable, value.profileKey, value.sourceStatus, value.pending];
    };

    const rejected = { draft: '13500', dirty: true, error: 'Command could not be sent.' };
    assert.deepEqual(
      reconcileMicrosoft737Max8NumericDraftState(rejected, snapshot(), previous()),
      rejected,
      'a rejected live MAX target should remain editable with its inline error',
    );
    assert.deepEqual(
      reconcileMicrosoft737Max8NumericDraftState(
        rejected,
        snapshot({ unavailable: true, pending: true }),
        previous(),
      ),
      { draft: '', dirty: false, error: '' },
      'field loss must clear stale MAX target intent even while the group is pending',
    );
    assert.deepEqual(
      reconcileMicrosoft737Max8NumericDraftState(
        rejected,
        snapshot({ profileKey: 'bundled/msfs/another-aircraft' }),
        previous(),
      ),
      { draft: '12000', dirty: false, error: '' },
      'an aircraft-context change must discard stale MAX intent and restore live readback',
    );
    assert.deepEqual(
      reconcileMicrosoft737Max8NumericDraftState(
        rejected,
        snapshot({ sourceStatus: 'stale' }),
        previous(),
      ),
      { draft: '', dirty: false, error: '' },
      'loss of a connected source must clear stale MAX target intent',
    );

    const accepted = { draft: '13500', dirty: false, error: '' };
    assert.deepEqual(
      reconcileMicrosoft737Max8NumericDraftState(
        accepted,
        snapshot({ pending: true }),
        previous(),
      ),
      accepted,
      'an accepted MAX target should remain visible until pending readback completes',
    );
    assert.deepEqual(
      reconcileMicrosoft737Max8NumericDraftState(
        accepted,
        snapshot({ rawValue: 13500 }),
        previous({ pending: true }),
      ),
      { draft: '13500', dirty: false, error: '' },
      'pending completion should reconcile the MAX input to fresh live readback',
    );
  });

  await test('Microsoft 737 MAX 8 panel renders only its compact 44-action standard-control contract', async () => {
    const guidancePrefixes = [
      'flightGuidance.apMaster',
      'flightGuidance.flightDirector',
      'flightGuidance.autothrottleArmed',
      'flightGuidance.speedHold',
      'flightGuidance.headingHold',
      'flightGuidance.altitudeHold',
      'flightGuidance.verticalSpeedHold',
      'flightGuidance.navHold',
      'flightGuidance.approachHold',
      'flightGuidance.flightLevelChange',
    ];
    const lightIds = ['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi'];
    const actionIds = [
      'flightGuidance.speed.set',
      'flightGuidance.heading.set',
      'flightGuidance.altitude.set',
      'flightGuidance.verticalSpeed.set',
      ...guidancePrefixes.flatMap((prefix) => [`${prefix}.off`, `${prefix}.on`]),
      ...lightIds.flatMap((lightId) => [`lights.${lightId}.off`, `lights.${lightId}.on`]),
      'controls.gear.up',
      'controls.gear.down',
      'controls.parkingBrake.off',
      'controls.parkingBrake.on',
      'controls.flaps.decrease',
      'controls.flaps.increase',
    ];
    assert.equal(actionIds.length, 44, 'the compact MAX contract should contain exactly 44 actions');
    assert.equal(new Set(actionIds).size, 44, 'the expected MAX action contract should contain no duplicates');
    assert.ok(resolveAircraftSpecificTemplate('microsoft-737-max-8'), 'the registered Microsoft 737 MAX 8 template should resolve');

    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'Microsoft737Max8AircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/microsoft-737-max-8',
          sourceStatus: 'connected',
          values: {
            'mcp.speedKts': 145,
            'mcp.headingDeg': 271,
            'mcp.altitudeFt': 12000,
            'mcp.verticalSpeedFpm': -900,
            'afds.apMaster': true,
            'afds.flightDirector': true,
            'afds.autothrottleArmed': true,
            'afds.autothrottleActive': true,
            'afds.speed': true,
            'afds.headingSelect': false,
            'afds.altitudeHold': true,
            'afds.verticalSpeed': false,
            'afds.lnav': true,
            'afds.approach': false,
            'afds.levelChange': true,
            'lights.strobe': true,
            'lights.beacon': false,
            'lights.nav': true,
            'lights.logo': false,
            'lights.wing': true,
            'lights.landing': false,
            'lights.taxi': true,
            'lights.runwayTurnoff': false,
            'controls.flapsPercent': 25,
            'controls.flapsIndex': 2,
            'controls.flapAngleDeg': 10,
            'controls.speedbrakePercent': 0,
            'controls.gearHandleDown': true,
            'controls.gearNosePct': 100,
            'controls.gearLeftPct': 100,
            'controls.gearRightPct': 100,
            'controls.parkingBrake': false,
            'systems.engine1N1': 87.4,
            'systems.engine2N1': 87.2,
            'systems.engine1Running': true,
            'systems.engine2Running': true,
            'systems.fuelTotalPct': 62.5,
            'systems.fuelTotalWeightLbs': 28000,
            'systems.grossWeightLbs': 152000,
            'systems.cabinAltitudeFt': 6800,
            'systems.cabinVerticalSpeedFpm': 120,
            'systems.cabinDeltaPressurePsi': 7.82,
            'systems.outsideAirTemperatureC': -48.5,
            'systems.mach': 0.79,
          },
          actionCapabilities: Object.fromEntries(actionIds.map((actionId) => [actionId, true])),
        },
      },
    );

    assert.match(html, /data-aircraft-template="microsoft-737-max-8"/, 'the page should identify its exact trusted adapter');
    assert.match(html, /data-aircraft-profile-key="bundled\/msfs\/microsoft-737-max-8"/, 'the trusted profile key should remain visible');
    assert.match(html, /Microsoft \/ Asobo Studio Boeing 737 MAX 8/, 'the exact first-party product identity should render');
    assert.match(html, /generic simulator controls; they do not represent Boeing CMD A\/B channel selection/, 'the page must distinguish standard AP control from Boeing channel semantics');
    assert.match(html, /aria-live="polite"[^>]*>\s*Controls ready\./, 'the page should announce readiness only when every exposed action has its prerequisites');

    assert.deepEqual(
      [...html.matchAll(/data-microsoft-737-max-8-selector="([^"]+)"/g)].map((match) => match[1]),
      ['speed', 'heading', 'altitude', 'vertical-speed'],
      'the panel should expose exactly four typed MCP targets',
    );
    assert.equal((html.match(/type="text"/g) || []).length, 4, 'all four MCP targets should use bounded text entry');
    assert.match(html, /data-microsoft-737-max-8-selector="speed"[\s\S]*?>145 <span[^>]*>kt<\/span>/, 'selected speed should render with its unit');
    assert.match(html, /data-microsoft-737-max-8-selector="heading"[\s\S]*?>271 <span[^>]*>deg<\/span>/, 'selected heading should retain three digits');
    assert.match(html, /data-microsoft-737-max-8-selector="altitude"[\s\S]*?>12,000 <span[^>]*>ft<\/span>/, 'selected altitude should use grouped feet');
    assert.match(html, /data-microsoft-737-max-8-selector="vertical-speed"[\s\S]*?>-900 <span[^>]*>fpm<\/span>/, 'selected vertical speed should render with its unit');
    assert.match(html, /Enter 100 to 399 in 1 kt increments\./, 'speed should expose its exact bounded target contract');
    assert.match(html, /Enter 0 to 359 in 1 deg increments\./, 'heading should expose its exact bounded target contract');
    assert.match(html, /Enter 0 to 49,000 in 100 ft increments\./, 'altitude should expose its exact bounded target contract');
    assert.match(html, /Enter -6,000 to 6,000 in 100 fpm increments\./, 'vertical speed should expose its exact bounded target contract');
    const selectorInputs = [...html.matchAll(/<input(?=[^>]*id="microsoft-737-max-8-target-[^"]+")[^>]*>/g)].map((match) => match[0]);
    assert.equal(selectorInputs.length, 4, 'all four MAX selector inputs should render');
    for (const input of selectorInputs) {
      assert.doesNotMatch(input, /\sdisabled(?:=| |>)/, 'a fully ready MAX selector input should be enabled');
    }

    assert.deepEqual(
      [...html.matchAll(/data-microsoft-737-max-8-mode="([^"]+)"/g)].map((match) => match[1]),
      ['ap-master', 'flight-director', 'autothrottle-arm', 'speed', 'heading', 'altitude', 'vertical-speed', 'nav', 'approach', 'flight-level-change'],
      'the panel should expose exactly ten standard guidance mode pairs, including FLC',
    );
    for (const prefix of guidancePrefixes) {
      assert.match(html, new RegExp(`data-aircraft-action="${prefix.replaceAll('.', '\\.')}\\.off"`), `${prefix}.off should render`);
      assert.match(html, new RegExp(`data-aircraft-action="${prefix.replaceAll('.', '\\.')}\\.on"`), `${prefix}.on should render`);
    }

    assert.deepEqual(
      [...html.matchAll(/data-microsoft-737-max-8-light="([^"]+)"/g)].map((match) => match[1]),
      [...lightIds, 'runway-turnoff-readonly'],
      'the panel should expose seven writable light outputs and read-only runway-turnoff output',
    );
    for (const lightId of lightIds) {
      assert.match(html, new RegExp(`data-microsoft-737-max-8-light="${lightId}"[\\s\\S]*?OUTPUT (?:ON|OFF)`), `${lightId} should expose lamp-output readback`);
      for (const suffix of ['off', 'on']) {
        const actionId = `lights.${lightId}.${suffix}`;
        const button = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
        assert.ok(button, `${actionId} should render`);
        assert.doesNotMatch(button, /\saria-(?:pressed|selected)=/, `${actionId} must not present lamp output as selector state`);
        assert.doesNotMatch(button, /border-cyan-400\/60|bg-cyan-400\/15/, `${actionId} must not use lamp output as selected-state styling`);
      }
    }

    assert.deepEqual(
      [...html.matchAll(/data-microsoft-737-max-8-surface="([^"]+)"/g)].map((match) => match[1]),
      ['gear', 'parking-brake', 'flaps'],
      'gear, parking brake, and flaps should be the only writable configuration groups',
    );
    const renderedActionIds = [...html.matchAll(/data-aircraft-action="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(renderedActionIds.length, 44, 'each compact MAX action should render exactly once');
    assert.equal(new Set(renderedActionIds).size, 44, 'rendered MAX action IDs should be unique');
    assert.deepEqual([...renderedActionIds].sort(), [...actionIds].sort(), 'the panel should expose all and only the exact 44-action contract');
    for (const actionId of actionIds) {
      const button = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
      assert.ok(button, `${actionId} should render in the fully ready fixture`);
      assert.doesNotMatch(button, /\sdisabled(?:=| |>)/, `${actionId} should enable when global, capability, readback, and pending prerequisites are ready`);
    }

    assert.match(html, /A\/T ACTIVE[\s\S]*?Read only/, 'active autothrottle should remain a separate read-only state');
    assert.match(html, /data-microsoft-737-max-8-light="runway-turnoff-readonly"[\s\S]*?Read only\. No distinct compatible write route is mapped\./, 'runway-turnoff should remain read-only');
    assert.match(html, /SPEEDBRAKE[\s\S]*?Read only/, 'speedbrake should remain read-only');
    assert.match(html, /Engine, fuel and pressurization data are concise read-only telemetry; no deep-system writes are exposed\./, 'deep-system telemetry should state its read-only boundary');
    assert.deepEqual(
      [...html.matchAll(/data-microsoft-737-max-8-engine="([0-9]+)"/g)].map((match) => Number(match[1])),
      [1, 2],
      'the MAX panel should render exactly its two physical engines',
    );
    assert.match(html, /data-microsoft-737-max-8-engine="1"[\s\S]*?ENG 1 N1[\s\S]*?87\.4%/, 'engine 1 N1 should render from its own readback');
    assert.match(html, /data-microsoft-737-max-8-engine="2"[\s\S]*?ENG 2 N1[\s\S]*?87\.2%/, 'engine 2 N1 should render from its own readback');
    assert.doesNotMatch(html, /data-aircraft-action="[^"]*(?:cmd[ab]?|vnav|autobrake|runway.?turnoff|speedbrake|spoiler|systems\.)/i, 'CMD A/B, VNAV, autobrake, turnoff, speedbrake, spoiler, and deep-system writes must stay absent');
    assert.doesNotMatch(html, /AUTOPILOT_(?:ON|OFF)|AP_(?:SPD|HDG|ALT|VS|NAV|APR)|HEADING_BUG_SET|LIGHTS_SET|GEAR_(?:UP|DOWN)|FLAPS_(?:INCR|DECR)|PARKING_BRAKE_SET/, 'raw simulator event names must stay outside Vue');
    assert.doesNotMatch(html, /Monitoring only/, 'the compact panel should no longer claim to be monitoring-only');

    const renderedIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicateIds = renderedIds.filter((id, index) => renderedIds.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicateIds)], [], 'every MAX target and status id should be unique');
  });

  await test('Microsoft 737 MAX 8 controls fail closed across readback, capability, and pending boundaries', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'Microsoft737Max8AircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/microsoft-737-max-8',
          sourceStatus: 'connected',
          values: {
            'lights.nav': true,
            'controls.gearHandleDown': true,
          },
          actionCapabilities: {
            'flightGuidance.speed.set': true,
            'lights.beacon.off': true,
            'lights.beacon.on': true,
            'controls.gear.up': true,
            'controls.gear.down': true,
          },
          isActionPending: (groupId) => groupId === 'controls.gear',
        },
      },
    );
    const buttonFor = (actionId) => html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';

    assert.match(html, /aria-live="polite"[^>]*>\s*Command in progress\./, 'a pending MAX group should replace the page-level ready claim');
    assert.doesNotMatch(html, /aria-live="polite"[^>]*>\s*Controls ready\./, 'a sparse pending MAX surface must not announce full readiness');
    const speedSubmit = buttonFor('flightGuidance.speed.set');
    assert.match(speedSubmit, /\sdisabled(?:=| |>)/, 'numeric capability must not bypass missing target readback');
    assert.match(speedSubmit, /title="Live target readback unavailable\."/, 'missing numeric readback should expose its reason');
    for (const actionId of ['lights.beacon.off', 'lights.beacon.on']) {
      const button = buttonFor(actionId);
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} capability must not bypass missing light readback`);
      assert.match(button, /title="Live aircraft readback unavailable\."/, `${actionId} should explain its missing readback`);
    }
    for (const actionId of ['lights.nav.off', 'lights.nav.on']) {
      const button = buttonFor(actionId);
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} readback must not bypass missing capability`);
      assert.match(button, /title="Compatible aircraft control unavailable\."/, `${actionId} should explain its missing capability`);
    }
    for (const actionId of ['controls.gear.up', 'controls.gear.down']) {
      const button = buttonFor(actionId);
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} should disable while its physical group is pending`);
      assert.match(button, /aria-busy="true"/, `${actionId} should expose pending state accessibly`);
      assert.match(button, /title="Command in progress\."/, `${actionId} should explain its pending guard`);
    }
  });

  await test('Microsoft 737 MAX 8 page status distinguishes partial and unavailable action surfaces', async () => {
    const componentPath = path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'Microsoft737Max8AircraftPanel.vue');
    const configure = ({ useAircraftControlsStore }) => {
      useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
    };
    const baseProps = {
      profileKey: 'bundled/msfs/microsoft-737-max-8',
      sourceStatus: 'connected',
    };

    const { html: partialHtml } = await renderComponent(componentPath, configure, {
      props: {
        ...baseProps,
        values: { 'controls.gearHandleDown': true },
        actionCapabilities: {
          'controls.gear.up': true,
          'controls.gear.down': true,
        },
      },
    });
    assert.match(partialHtml, /aria-live="polite"[^>]*>\s*Some controls unavailable\./, 'a partially actionable MAX surface should announce degraded readiness');
    assert.doesNotMatch(partialHtml, /aria-live="polite"[^>]*>\s*Controls ready\./, 'partial action readiness must not claim full readiness');

    const { html: unavailableHtml } = await renderComponent(componentPath, configure, {
      props: baseProps,
    });
    assert.match(unavailableHtml, /aria-live="polite"[^>]*>\s*Controls unavailable\./, 'a MAX surface with no actionable controls should announce unavailability');
    assert.doesNotMatch(unavailableHtml, /aria-live="polite"[^>]*>\s*Controls ready\./, 'an unavailable action surface must not claim readiness');
  });

  await test('Microsoft 737 MAX 8 controls expose and obey global write availability', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'Microsoft737Max8AircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({
          enabled: false,
          reason: 'Aircraft writes disabled by operator.',
        });
      },
      {
        props: {
          profileKey: 'bundled/msfs/microsoft-737-max-8',
          sourceStatus: 'connected',
          values: {
            'mcp.speedKts': 250,
            'afds.levelChange': false,
            'lights.beacon': false,
            'controls.parkingBrake': false,
          },
          actionCapabilities: {
            'flightGuidance.speed.set': true,
            'flightGuidance.flightLevelChange.off': true,
            'flightGuidance.flightLevelChange.on': true,
            'lights.beacon.off': true,
            'lights.beacon.on': true,
            'controls.parkingBrake.off': true,
            'controls.parkingBrake.on': true,
          },
        },
      },
    );

    assert.match(html, /Aircraft writes disabled by operator\./, 'the page should expose the store-provided global reason');
    for (const actionId of [
      'flightGuidance.speed.set',
      'flightGuidance.flightLevelChange.off',
      'flightGuidance.flightLevelChange.on',
      'lights.beacon.off',
      'lights.beacon.on',
      'controls.parkingBrake.off',
      'controls.parkingBrake.on',
    ]) {
      const button = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
      assert.match(button, /\sdisabled(?:=| |>)/, `${actionId} should obey global write availability`);
      assert.match(button, /title="Aircraft writes disabled by operator\."/, `${actionId} should expose the global disabled reason`);
    }
  });

  await test('Microsoft / Asobo Boeing 747-8 page renders exact ownership and all four engines', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'MicrosoftBoeing747_8AircraftPanel.vue'),
      () => {},
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'mcp.speedKts': 168,
            'mcp.headingDeg': 273,
            'mcp.altitudeFt': 14000,
            'mcp.verticalSpeedFpm': -700,
            'afds.navLockMirror': true,
            'systems.engine1N1': 84.1,
            'systems.engine2N1': 84.2,
            'systems.engine3N1': 84.3,
            'systems.engine4N1': 84.4,
          },
        },
      },
    );
    assert.match(html, /data-aircraft-template="workingtitle-747-8"/);
    assert.ok(html.includes('Microsoft / Asobo Studio Boeing 747-8i / 747-8F'));
    assert.match(html, /Included MSFS 2024 Standard aircraft with Working Title avionics/);
    assert.match(html, /data-aircraft-engine="1"[\s\S]*84\.1%/);
    assert.match(html, /data-aircraft-engine="2"[\s\S]*84\.2%/);
    assert.match(html, /data-aircraft-engine="3"[\s\S]*84\.3%/);
    assert.match(html, /data-aircraft-engine="4"[\s\S]*84\.4%/);
    assert.doesNotMatch(html, /data-aircraft-engine="5"/);
    assert.match(html, /NAV \(SIM\)/);
    assert.match(html, /not a complete synoptic of the 747-8 body and wing main-gear bogies/);
    assert.match(html, /Monitoring only/);
    assert.doesNotMatch(html, /<button|data-aircraft-action=/, 'stock 747-8 page must expose no unverified writes');
  });

  await test('Microsoft / Asobo Boeing 787-10 page renders Premium Deluxe identity and exactly two engines', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'MicrosoftBoeing787_10AircraftPanel.vue'),
      () => {},
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'mcp.speedKts': 152,
            'mcp.headingDeg': 91,
            'mcp.altitudeFt': 10000,
            'mcp.verticalSpeedFpm': -800,
            'afds.navLockMirror': true,
            'systems.engine1N1': 81.7,
            'systems.engine2N1': 81.9,
          },
        },
      },
    );
    assert.match(html, /data-aircraft-template="asobo-787"/);
    assert.ok(html.includes('Microsoft / Asobo Studio Boeing 787-10 Dreamliner'));
    assert.ok(html.includes('Included MSFS 2024 Premium Deluxe/Aviator aircraft with Working Title avionics'));
    assert.match(html, /data-aircraft-engine="1"[\s\S]*81\.7%/);
    assert.match(html, /data-aircraft-engine="2"[\s\S]*81\.9%/);
    assert.doesNotMatch(html, /data-aircraft-engine="3"/);
    assert.match(html, /NAV \(SIM\)/);
    assert.match(html, /Monitoring only/);
    assert.doesNotMatch(html, /<button|data-aircraft-action=/, 'stock 787-10 page must expose no unverified writes');
  });

  await test('Microsoft ATR 72-600 monitoring page renders exact Expert Series identity and FGCP fields', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'MicrosoftAtr72_600AircraftPanel.vue'),
      () => {},
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'fgcp.speedKts': 180,
            'fgcp.headingDeg': 92,
            'fgcp.altitudeFt': 7000,
            'fgcp.verticalSpeedFpm': 600,
            'fgcp.apMaster': true,
            'systems.engine1Running': true,
          },
        },
      },
    );
    assert.match(html, /data-aircraft-template="microsoft-atr-72-600"/);
    assert.match(html, /Microsoft \/ S&amp;H Software ATR 72-600/);
    assert.doesNotMatch(html, /ATR 72-800/);
    assert.match(html, />180</);
    assert.match(html, />092°</);
    assert.match(html, /Flight Guidance Control Panel/);
    assert.doesNotMatch(html, />VNAV\s*</, 'the page must not render VNAV without a supported ATR readback');
    assert.match(html, /data-aircraft-field="lights\.taxi"/);
    assert.doesNotMatch(html, /data-aircraft-field="lights\.runwayTurnoff"|TURN OFF/);
    assert.match(html, /Monitoring only/);
  });

  await test('iFly 737 MAX 8 template renders all monitoring groups and only narrow surface commands', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'Ifly737Max8AircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({
          enabled: true,
          reason: 'Ready. Commands are checked against the active iFly profile.',
        });
        controls.applyControlCapabilities({
          surface: {
            gearUp: false,
            gearDown: true,
            flapsDecrease: true,
            flapsIncrease: true,
          },
        });
        controls.setCommandPending({ type: 'control', id: 'flapsIncrease' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/ifly-737-max-8',
          sourceStatus: 'connected',
          sourceStatuses: { simvar: 'connected', lvar: 'connected' },
          values: {
            'mcp.speed': 250,
            'mcp.headingDeg': 87,
            'mcp.altitudeFt': 12000,
            'mcp.verticalSpeedFpm': -1200,
            'afds.cmdA': true,
            'afds.autothrottleArm': false,
            'afds.lnav': true,
            'afds.approach': true,
            'afds.headingSelect': true,
            'afds.altitudeHold': false,
            'afds.verticalSpeed': true,
            'afds.levelChange': false,
            'lights.strobe': true,
            'lights.beacon': true,
            'lights.nav': true,
            'lights.logo': false,
            'lights.wing': false,
            'lights.landing': false,
            'lights.taxi': true,
            'lights.runwayTurnoff': false,
            'controls.flapsPercent': 62,
            'controls.flapsIndex': 6,
            'controls.flapAngleDeg': 25,
            'controls.speedbrakePercent': 0,
            'controls.gearHandleDown': true,
            'controls.gearNosePct': 100,
            'controls.gearLeftPct': 100,
            'controls.gearRightPct': 100,
            'controls.parkingBrake': false,
            'systems.engine1N1': 81.4,
            'systems.engine2N1': 81.3,
            'systems.engine1Running': true,
            'systems.engine2Running': true,
            'systems.fuelTotalPct': 58.2,
            'systems.fuelTotalWeightLbs': 30200,
            'systems.grossWeightLbs': 160000,
            'systems.cabinAltitudeFt': 7100,
            'systems.cabinVerticalSpeedFpm': 120,
            'systems.cabinDeltaPressurePsi': 7.85,
            'systems.outsideAirTemperatureC': -48.5,
            'systems.mach': 0.79,
          },
        },
      },
    );

    assert.match(html, /data-aircraft-template="ifly-737-max-8"/, 'template should identify its trusted adapter key');
    assert.match(html, /data-ifly-mcp-field="mcp\.headingDeg"[\s\S]*087/, 'MCP heading should retain three digits');
    assert.match(html, /data-ifly-mcp-field="mcp\.altitudeFt"[\s\S]*12,000/, 'MCP altitude should use grouped feet');
    assert.equal((html.match(/data-ifly-afds-indicator=/g) || []).length, 8, 'all supported standard AFDS mirrors should render');
    assert.match(html, /data-ifly-afds-indicator="afds\.lnav"[^>]*><span>LNAV<\/span><span[^>]*>ON<\/span>/, 'a true LNAV lamp should render explicitly on');
    assert.doesNotMatch(html, /data-ifly-afds-indicator="afds\.(?:vnav|vorLoc)"/, 'unsupported iFly modes must be omitted instead of rendered permanently unknown');
    assert.match(html, /MCP and AFDS status may not match the cockpit/, 'the page should give users a concise status caveat');
    assert.match(html, /FLAP DETENT<\/div>[\s\S]*>25<\/div>/, 'MAX handle index six should map to flap 25');
    assert.match(html, /data-ifly-engine="2"[\s\S]*81\.3/, 'both LEAP engine N1 indications should render');
    assert.equal((html.match(/data-ifly-light=/g) || []).length, 8, 'all profile-presented exterior lights should render');
    assert.match(html, /GROSS WEIGHT<\/div>[\s\S]*72\.6/, 'gross weight should be converted from pounds to tonnes');

    assert.equal((html.match(/data-ifly-generic-command=/g) || []).length, 4, 'the page should preserve exactly the four supported generic surface commands');
    for (const commandKey of ['gearUp', 'gearDown', 'flapsDecrease', 'flapsIncrease']) {
      assert.match(html, new RegExp(`data-ifly-generic-command="${commandKey}"`), `${commandKey} should remain present`);
    }
    assert.match(html, /<button(?=[^>]*data-ifly-generic-command="gearUp")(?=[^>]*\sdisabled(?:=| |>))[^>]*>/, 'a capability-blocked surface command should fail closed');
    assert.doesNotMatch(html, /<button(?=[^>]*data-ifly-generic-command="gearDown")(?=[^>]*\sdisabled(?:=| |>))[^>]*>/, 'an available supported gear command should remain enabled');
    assert.match(html, /<button(?=[^>]*data-ifly-generic-command="flapsIncrease")(?=[^>]*\sdisabled(?:=| |>))(?=[^>]*aria-busy="true")[^>]*>Sending\.\.\.<\/button>/, 'a pending flap command should disable itself and expose progress');
    assert.doesNotMatch(html, /data-ifly-generic-command="(?:autopilot|autothrottle|flightDirector|speedHold|headingHold|altitudeHold|verticalSpeedHold|loc|app|flc)/, 'the page must not broaden the profile into autopilot writes');
    assert.doesNotMatch(html, /data-aircraft-action=|aria-pressed=/, 'generic momentary surface commands must not masquerade as aircraft-specific stateful actions');
    assert.doesNotMatch(html, /VC_|AUTOPILOT AIRSPEED|TURB ENG|PRESSURIZATION CABIN|PMDG|MobiFlight|MF\.SimVars/, 'raw routes and unrelated vendor contracts must remain outside Vue');
  });

  await test('iFly 737 MAX 8 template keeps unavailable values neutral and gates commands on global availability', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'Ifly737Max8AircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({ enabled: false, reason: 'Simulator offline.' });
        controls.applyControlCapabilities({
          surface: {
            gearUp: true,
            gearDown: true,
            flapsDecrease: true,
            flapsIncrease: true,
          },
        });
      },
      {
        props: {
          sourceStatus: 'stale',
          values: {
            'mcp.speed': 250,
            'afds.cmdA': true,
            'controls.flapsIndex': 6,
            'systems.engine2N1': 81.3,
            'systems.grossWeightLbs': 160000,
          },
          unavailable: [
            'mcp.speed',
            'afds.cmdA',
            'controls.flapsIndex',
            'systems.engine2N1',
            'systems.grossWeightLbs',
          ],
        },
      },
    );

    assert.match(html, /data-ifly-mcp-field="mcp\.speed"[^>]*>[\s\S]*>--<\/span>/, 'unavailable MCP speed must not retain stale readback');
    assert.match(html, /data-ifly-afds-indicator="afds\.cmdA"[^>]*><span>CMD A<\/span><span[^>]*>--<\/span>/, 'unavailable CMD A state must remain unknown');
    assert.match(html, /FLAP DETENT<\/div>\s*<div[^>]*>--<\/div>/, 'unavailable flap index must not retain a stale detent');
    assert.match(html, /data-ifly-engine="2"[\s\S]*N1<\/span>\s*<span[^>]*>--<span/, 'unavailable engine N1 must remain unknown');
    assert.match(html, /GROSS WEIGHT<\/div>\s*<div[^>]*>-- <span/, 'unavailable gross weight must not retain a stale conversion');
    for (const commandKey of ['gearUp', 'gearDown', 'flapsDecrease', 'flapsIncrease']) {
      assert.match(
        html,
        new RegExp(`<button(?=[^>]*data-ifly-generic-command="${commandKey}")(?=[^>]*\\sdisabled(?:=| |>))[^>]*>`),
        `${commandKey} should be disabled while the global control service is unavailable`,
      );
    }
  });

  await test('iniBuilds A330 template renders its guarded standard-event controls and typed targets', async () => {
    const modePrefixes = [
      'flightGuidance.apMaster',
      'flightGuidance.flightDirector',
      'flightGuidance.autothrottleArmed',
      'flightGuidance.speedHold',
      'flightGuidance.headingHold',
      'flightGuidance.altitudeHold',
      'flightGuidance.verticalSpeedHold',
      'flightGuidance.navHold',
      'flightGuidance.approachHold',
      'flightGuidance.flightLevelChange',
    ];
    const lightPrefixes = ['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi']
      .map((id) => `lights.${id}`);
    const actionIds = [
      ...modePrefixes.flatMap((prefix) => [`${prefix}.off`, `${prefix}.on`]),
      'flightGuidance.speed.set',
      'flightGuidance.heading.set',
      'flightGuidance.altitude.set',
      'flightGuidance.verticalSpeed.set',
      ...lightPrefixes.flatMap((prefix) => [`${prefix}.off`, `${prefix}.on`]),
      'controls.gear.up',
      'controls.gear.down',
      'controls.flaps.decrease',
      'controls.flaps.increase',
      'controls.parkingBrake.off',
      'controls.parkingBrake.on',
      'controls.spoilersArmed.off',
      'controls.spoilersArmed.on',
      'controls.speedbrake.set',
    ];
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsA330AircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/inibuilds-a330',
          sourceStatus: 'connected',
          values: {
            'flightGuidance.speedValue': 270,
            'flightGuidance.headingDeg': 87,
            'flightGuidance.altitudeFt': 37000,
            'flightGuidance.verticalSpeedFpm': -800,
            'flightGuidance.apMaster': true,
            'flightGuidance.flightDirector': true,
            'flightGuidance.autothrottleArmed': true,
            'flightGuidance.autothrottleActive': true,
            'flightGuidance.navHold': true,
            'flightGuidance.approachHold': false,
            'lights.strobe': true,
            'lights.beacon': false,
            'lights.nav': true,
            'lights.logo': true,
            'lights.wing': false,
            'lights.landing': false,
            'lights.taxi': false,
            'lights.runwayTurnoff': false,
            'controls.flapsPercent': 0,
            'controls.flapsIndex': 0,
            'controls.flapAngleDeg': 0,
            'controls.speedbrakePercent': 0,
            'controls.spoilersArmed': false,
            'controls.gearHandleDown': false,
            'controls.gearNosePct': 0,
            'controls.gearLeftPct': 100,
            'controls.gearRightPct': 42,
            'controls.parkingBrake': false,
            'systems.engine1N1': 84.2,
            'systems.engine2N1': 84.1,
            'systems.engine1Running': true,
            'systems.engine2Running': true,
            'systems.fuelTotalPct': 63.5,
            'systems.fuelTotalWeightLbs': 98000,
            'systems.grossWeightLbs': 450000,
            'systems.cabinAltitudeFt': 7100,
            'systems.cabinVerticalSpeedFpm': 50,
            'systems.cabinDeltaPressurePsi': 8.21,
            'systems.outsideAirTemperatureC': -54.2,
            'systems.mach': 0.82,
          },
          actionCapabilities: Object.fromEntries(actionIds.map((actionId) => [actionId, true])),
        },
      },
    );

    assert.match(html, /data-aircraft-template="inibuilds-a330"/, 'template should identify its trusted adapter key');
    assert.match(html, /iniBuilds Airbus A330 Family/, 'template should render the family heading');
    assert.match(html, /A330-200, A330-300 and A330-300P2F/, 'included variants should be explicit');
    assert.match(html, /37,000/, 'standard selected-altitude candidate should be formatted');
    assert.match(html, /204\.1/, 'gross weight should be converted from pounds to tonnes');
    assert.match(html, /Standard controls/, 'standard-event write boundary should be prominent');
    assert.match(html, /Experimental/, 'live-validation status should be prominent');
    assert.equal((html.match(/data-aircraft-action=/g) || []).length, 47, 'the exact 47-action adapter surface should render once');
    for (const selectorId of ['speed', 'heading', 'altitude', 'vertical-speed', 'speedbrake']) {
      assert.match(html, new RegExp(`data-a330-selector="${selectorId}"`), `${selectorId} should render as a typed target form`);
    }
    assert.equal((html.match(/type="text"/g) || []).length, 5, 'all numeric targets should be text-entry fields');
    assert.doesNotMatch(html, /data-a330-selector=[^>]*>[\s\S]*?aria-label="(?:Decrease|Increase)/, 'numeric target cards must not use decrement/increment buttons');
    assert.match(html, /data-aircraft-action="flightGuidance\.altitude\.set"/, 'typed altitude should dispatch one exact target action');
    assert.match(html, /data-aircraft-action="controls\.gear\.down"/, 'gear commands should no longer disappear on the dedicated page');
    assert.match(html, /data-aircraft-action="controls\.flaps\.increase"/, 'flap commands should no longer disappear on the dedicated page');
    assert.match(html, /data-a330-light="runway-turnoff-readonly"[\s\S]*Read only/, 'turnoff should remain honestly read-only without a distinct route');
    assert.match(html, /AP1\/AP2, managed push\/pull and EXPED/, 'unsupported Airbus-specific semantics should remain explicit');
    assert.doesNotMatch(html, /Behavior Debug|InputEvents|real-system readback/, 'development details should not appear in end-user copy');
    assert.doesNotMatch(html, /AUTOPILOT |LIGHT |PRESSURIZATION |INI_|MobiFlight|MF\.SimVars/, 'raw routes must remain encapsulated outside Vue');

    const renderedIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicateIds = renderedIds.filter((id, index) => renderedIds.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicateIds)], [], 'every A330 status and input id should be unique');
    assert.match(html, /id="a330-status-flightGuidance-navHold"/, 'guidance NAV should own a distinct status id');
    assert.match(html, /id="a330-status-lights-nav"/, 'exterior-light NAV should own a distinct status id');

    for (const lightActionId of lightPrefixes.flatMap((prefix) => [`${prefix}.off`, `${prefix}.on`])) {
      const lightButton = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${lightActionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
      assert.ok(lightButton, `${lightActionId} should render`);
      assert.doesNotMatch(lightButton, /\saria-pressed=/, `${lightActionId} must not claim the lamp output is the cockpit selector position`);
      assert.doesNotMatch(lightButton, /border-cyan-400\/60|bg-cyan-400\/15/, `${lightActionId} must not use selected-state styling from lamp output`);
    }
    assert.match(html, /data-a330-light="strobe"[\s\S]*OUTPUT ON/, 'live lamp state should remain visible as output readback');

    const mainGearReadback = html.match(/<div(?=[^>]*data-a330-gear-readback="mains")[^>]*>/)?.[0] || '';
    assert.match(mainGearReadback, /border-amber-500\/50/, 'a disagreeing left/right gear pair should render as transitional or unsafe');
    assert.doesNotMatch(mainGearReadback, /border-emerald-500\/50/, 'one down main gear must not make the pair look safely down');
  });

  await test('iniBuilds A330 renders unavailable values as unknown and fails controls closed', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsA330AircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: false, reason: 'Read-only access.' });
      },
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'flightGuidance.speedValue': 250,
            'flightGuidance.apMaster': false,
            'controls.gearHandleDown': true,
          },
          unavailable: ['flightGuidance.speedValue'],
          actionCapabilities: {
            'flightGuidance.speed.set': true,
            'flightGuidance.apMaster.off': true,
            'flightGuidance.apMaster.on': true,
            'controls.gear.up': true,
            'controls.gear.down': true,
          },
        },
      },
    );

    assert.match(html, /data-a330-selector="speed"[\s\S]*?>--\s*<span/, 'unavailable FCU speed must not retain its stale value');
    assert.match(html, /GROSS WEIGHT<\/div>\s*<div[^>]*>-- <span/, 'missing gross weight must not render as zero tonnes');
    assert.match(html, /CAB ALT <span[^>]*>-- ft<\/span>/, 'missing cabin altitude must remain unknown');
    assert.match(html, /Read-only access\./, 'the global availability reason should be visible');
    for (const actionId of ['flightGuidance.speed.set', 'flightGuidance.apMaster.on', 'controls.gear.up']) {
      assert.match(
        html,
        new RegExp(`<button(?=[^>]*data-aircraft-action="${actionId.replace(/\./g, '\\.')}"` + ')(?=[^>]*\\sdisabled(?:=| |>))[^>]*>'),
        `${actionId} should fail closed when this browser is read-only`,
      );
    }
  });

  await test('iniBuilds L-1011-500 template renders monitoring, documented selector steps, and momentary AFCS keys', async () => {
    const selectorActionIds = [
      'afcs.speed.decrease',
      'afcs.speed.increase',
      'afcs.heading.decrease',
      'afcs.heading.increase',
      'afcs.altitude.decrease',
      'afcs.altitude.increase',
      'afcs.verticalSpeed.decrease',
      'afcs.verticalSpeed.increase',
      'navigation.course1.decrease',
      'navigation.course1.increase',
      'navigation.course2.decrease',
      'navigation.course2.increase',
    ];
    const lightActionIds = [
      'lights.landing.setOff',
      'lights.landing.setOn',
      'lights.taxi.setOff',
      'lights.taxi.setOn',
      'lights.strobe.setOff',
      'lights.strobe.setOn',
      'lights.beacon.setOff',
      'lights.beacon.setOn',
      'lights.nav.setOff',
      'lights.nav.setOn',
      'lights.wing.setOff',
      'lights.wing.setOn',
      'lights.logo.setOff',
      'lights.logo.setOn',
    ];
    const pulseCommandIds = [
      'autothrottle',
      'verticalSpeedHold',
      'altitudeHold',
      'machHold',
      'headingHold',
      'flightDirector',
      'apMaster',
      'apDisconnect',
      'app',
      'loc',
      'nav1',
      'ins',
      'backcourse',
    ];
    const pulseAccessibleLabels = {
      autothrottle: 'Autothrottle momentary control',
      verticalSpeedHold: 'Vertical speed hold momentary control',
      altitudeHold: 'Altitude hold momentary control',
      machHold: 'Mach hold momentary control',
      headingHold: 'Heading hold momentary control',
      flightDirector: 'Captain flight director momentary control',
      apMaster: 'Autopilot A momentary control',
      apDisconnect: 'Autopilot disconnect momentary control',
      app: 'ILS approach momentary control',
      loc: 'Localizer momentary control',
      nav1: 'VOR navigation momentary control',
      ins: 'INS course capture momentary control',
      backcourse: 'Back course momentary control',
    };
    const actionCapabilities = Object.fromEntries(
      [...selectorActionIds, ...lightActionIds].map((actionId) => [actionId, true]),
    );
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsTriStarAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({
          enabled: true,
          reason: 'Ready. Commands are checked against the active TriStar profile.',
        });
        controls.applyControlCapabilities({
          surface: {
            gearUp: true,
            gearDown: true,
            flapsDecrease: true,
            flapsIncrease: true,
          },
          autopilotPulse: Object.fromEntries(pulseCommandIds.map((commandId) => [commandId, true])),
        });
      },
      {
        props: {
          profileKey: 'bundled/msfs/inibuilds-tristar',
          sourceStatus: 'connected',
          values: {
            'lights.strobe': true,
            'lights.beacon': true,
            'lights.nav': true,
            'lights.wing': true,
            'lights.logo': false,
            'lights.landing': false,
            'lights.taxi': false,
            'controls.flapsPercent': 78,
            'controls.flapsIndex': 4,
            'controls.flapAngleDeg': 33,
            'controls.gearHandleDown': true,
            'controls.gearNosePct': 100,
            'controls.gearLeftPct': 100,
            'controls.gearRightPct': 100,
            'controls.parkingBrake': false,
            'systems.engine1N1': 73.4,
            'systems.engine2N1': 73.5,
            'systems.engine3N1': 73.6,
            'systems.engine1Epr': 1.23,
            'systems.engine2Epr': 1.24,
            'systems.engine3Epr': 1.25,
            'systems.engine1N2': 91.1,
            'systems.engine2N2': 91.2,
            'systems.engine3N2': 91.3,
            'systems.engine1FuelFlowPph': 9870,
            'systems.engine2FuelFlowPph': 9880,
            'systems.engine3FuelFlowPph': 9890,
            'systems.engine1ReversePct': 0,
            'systems.engine2ReversePct': 0.5,
            'systems.engine3ReversePct': 1,
            'systems.engine1Running': true,
            'systems.engine2Running': true,
            'systems.engine3Running': true,
            'systems.fuelTotalPct': 61.2,
            'systems.fuelTotalWeightLbs': 92000,
            'systems.grossWeightLbs': 430000,
            'systems.cabinAltitudeFt': 7200,
            'systems.cabinVerticalSpeedFpm': 75,
            'systems.cabinDeltaPressurePsi': 8.15,
            'systems.outsideAirTemperatureC': -51.4,
            'systems.mach': 0.82,
          },
          actionCapabilities,
        },
      },
    );

    assert.match(html, /data-aircraft-template="inibuilds-tristar"/, 'template should identify its trusted adapter key');
    assert.match(html, /data-inibuilds-tristar-scope="msfs-2024-l-1011-500"/, 'template should scope compatibility to the actual -500 product');
    assert.match(html, /iniBuilds L-1011-500 compatibility/, 'template should render concrete aircraft identity');
    assert.equal((html.match(/data-tristar-afcs-selector=/g) || []).length, 6, 'all documented selector knobs should render');
    assert.doesNotMatch(html, /data-tristar-selector-input=|Enter to set|\.set"/, 'unsupported direct target inputs and actions must stay absent');
    assert.match(html, /Use the cockpit windows as the source of truth\./, 'the selector surface should state its telemetry boundary');
    assert.match(html, /Ready\. Each press sends one documented knob event; confirm the value on the cockpit display\./, 'selector steps should describe acknowledgement-only behavior');

    const engineOneHtml = html.match(/<article(?=[^>]*data-tristar-engine="1")[\s\S]*?<\/article>/)?.[0] || '';
    const engineTwoHtml = html.match(/<article(?=[^>]*data-tristar-engine="2")[\s\S]*?<\/article>/)?.[0] || '';
    const engineThreeHtml = html.match(/<article(?=[^>]*data-tristar-engine="3")[\s\S]*?<\/article>/)?.[0] || '';
    assert.match(engineOneHtml, /1\.23/, 'engine one should render the EPR primary readback');
    assert.match(engineOneHtml, /73\.4%/, 'engine one should retain N1 monitoring');
    assert.match(engineOneHtml, /91\.1%/, 'engine one should render N2');
    assert.match(engineOneHtml, /9,870 lb\/h/, 'engine one should render formatted fuel flow');
    assert.match(engineOneHtml, /0\.0%/, 'engine one should render reverser percentage');
    assert.match(engineTwoHtml, /TAIL/, 'the center engine should be presented as the tail engine');
    assert.match(engineThreeHtml, /1\.25[\s\S]*73\.6%[\s\S]*91\.3%[\s\S]*9,890 lb\/h[\s\S]*1\.0%/, 'the third engine card should carry its complete live readback');
    assert.match(html, /FLAP DETENT<\/div>[\s\S]*>33<\/div>/, 'flap index four should map to the source-backed 33 detent');
    assert.match(html, /GROSS WEIGHT<\/div>[\s\S]*195\.0/, 'gross weight should be converted from pounds to tonnes');
    assert.match(html, /data-tristar-light-control="wing"[\s\S]*>ON<\/button>/, 'wing lights should expose fixed OFF and ON intent');

    const renderedActionIds = [...html.matchAll(/data-aircraft-action="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(renderedActionIds.length, 26, 'the panel should expose 12 documented selector steps and 14 fixed light targets');
    assert.deepEqual([...renderedActionIds].sort(), [...selectorActionIds, ...lightActionIds].sort(), 'the aircraft-specific write surface should stay exact');
    for (const lightActionId of lightActionIds) {
      const button = html.match(new RegExp(`<button(?=[^>]*data-aircraft-action="${lightActionId.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
      assert.match(button, /aria-pressed="(?:true|false)"/, `${lightActionId} should expose fixed-position readback`);
    }

    const renderedPulseIds = [...html.matchAll(/data-tristar-pulse-command="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(renderedPulseIds, pulseCommandIds, 'all and only the documented momentary AFCS keys should render');
    for (const pulseId of pulseCommandIds) {
      const button = html.match(new RegExp(`<button(?=[^>]*data-tristar-pulse-command="${pulseId}")[^>]*>`))?.[0] || '';
      assert.doesNotMatch(button, /aria-pressed=/, `${pulseId} is momentary and must never claim engagement state`);
      assert.match(button, new RegExp(`aria-label="${pulseAccessibleLabels[pulseId]}"`), `${pulseId} should expand its cockpit abbreviation for assistive technology`);
      assert.match(button, /aria-describedby="tristar-afcs-mode-status tristar-afcs-mode-help"/, `${pulseId} should reference visible availability and safety help`);
    }
    assert.match(html, /data-tristar-pulse-command="autothrottle"[^>]*>AT<\/button>/, 'AP_AIRSPEED_HOLD should use the aircraft-correct AT label');
    assert.match(html, /data-tristar-pulse-command="ins"[^>]*>INS<\/button>/, 'the repurposed water-rudder event should use the aircraft-correct INS label');
    assert.doesNotMatch(html, /SPD HOLD|YAW DAMPER/, 'the panel must not retain the two misleading legacy labels');

    assert.equal((html.match(/data-tristar-generic-command=/g) || []).length, 4, 'generic writes should be limited to gear and flaps');
    for (const commandKey of ['gearUp', 'gearDown', 'flapsDecrease', 'flapsIncrease']) {
      assert.match(html, new RegExp(`data-tristar-generic-command="${commandKey}"`), `${commandKey} should remain available through the profile-gated surface path`);
    }
    assert.match(html, /Delivery does not prove engagement/, 'momentary AFCS commands should carry a cockpit-confirmation warning');
    assert.match(html, /id="tristar-afcs-mode-status"[^>]*>\s*Ready\. Each press sends one bounded momentary event; repeated presses are briefly throttled\./, 'momentary AFCS commands should expose a visible ready/throttle status');
    assert.match(html, /not affiliated with or endorsed by iniBuilds/, 'the unofficial compatibility boundary should remain visible');
    assert.doesNotMatch(html, /TURB ENG|ENG COMBUSTION|AUTOPILOT AIRSPEED|PRESSURIZATION CABIN|INI_|MobiFlight|MF\.SimVars/, 'raw routes must remain encapsulated outside Vue');
  });

  await test('iniBuilds L-1011-500 controls respect source, capability, and trusted-readback boundaries', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsTriStarAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({ enabled: true, reason: 'Ready.' });
        controls.applyControlCapabilities({
          surface: {
            gearUp: true,
            gearDown: false,
          },
          autopilotPulse: {
            apMaster: true,
            autothrottle: false,
          },
        });
      },
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'lights.strobe': true,
            'lights.beacon': false,
            'controls.flapsIndex': 4,
            'systems.engine3Epr': 1.5,
            'systems.engine3N1': 88.8,
            'systems.grossWeightLbs': 430000,
          },
          actionCapabilities: {
            'afcs.speed.decrease': true,
            'afcs.altitude.decrease': true,
            'lights.landing.setOff': true,
            'lights.beacon.setOff': true,
            'lights.beacon.setOn': true,
          },
          unavailable: [
            'controls.flapsIndex',
            'systems.engine3Epr',
            'systems.engine3N1',
            'systems.grossWeightLbs',
          ],
        },
      },
    );

    assert.doesNotMatch(html, /data-tristar-selector-input=|afcs\.speed\.set/, 'unsupported selector inputs must not reappear through capabilities or values');
    assert.match(html, /FLAP DETENT<\/div>\s*<div[^>]*>--<\/div>/, 'unavailable flap index must not retain a stale detent');
    const engineThreeHtml = html.match(/<article(?=[^>]*data-tristar-engine="3")[\s\S]*?<\/article>/)?.[0] || '';
    assert.match(engineThreeHtml, /EPR<\/div>\s*<div[^>]*>--<\/div>/, 'unavailable EPR must remain unknown');
    assert.match(engineThreeHtml, /N1<\/dt><dd[^>]*>--%<\/dd>/, 'unavailable engine three N1 must remain unknown');
    assert.match(html, /GROSS WEIGHT<\/div>\s*<div[^>]*>-- <span/, 'unavailable gross weight must not retain a stale conversion');

    const buttonFor = (attribute, value) => html.match(new RegExp(`<button(?=[^>]*${attribute}="${value.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
    const hasDisabledAttribute = (button) => /\sdisabled(?:=| |>)/.test(button);
    assert.equal(hasDisabledAttribute(buttonFor('data-aircraft-action', 'afcs.speed.decrease')), false, 'a documented selector pulse should enable with its exact capability');
    assert.equal(hasDisabledAttribute(buttonFor('data-aircraft-action', 'afcs.heading.decrease')), true, 'a missing selector capability must fail closed');
    assert.equal(hasDisabledAttribute(buttonFor('data-aircraft-action', 'afcs.altitude.decrease')), false, 'an acknowledged selector pulse must not depend on unreliable generic readback');
    assert.equal(hasDisabledAttribute(buttonFor('data-aircraft-action', 'lights.landing.setOff')), true, 'light capability must not bypass missing live light readback');
    assert.equal(hasDisabledAttribute(buttonFor('data-aircraft-action', 'lights.strobe.setOn')), true, 'live light readback must not bypass a missing light capability');
    assert.equal(hasDisabledAttribute(buttonFor('data-aircraft-action', 'lights.beacon.setOff')), false, 'fixed light intent should enable only with readback and capability');
    assert.equal(hasDisabledAttribute(buttonFor('data-tristar-pulse-command', 'apMaster')), false, 'supported momentary AP key should remain enabled while connected');
    assert.equal(hasDisabledAttribute(buttonFor('data-tristar-pulse-command', 'autothrottle')), true, 'unsupported momentary AT key should fail closed');
    assert.match(html, /id="tristar-afcs-mode-status"[^>]*>\s*12 AFCS mode controls are unavailable for this exact aircraft profile\./, 'disabled pulse reasons should be visible outside inaccessible native button titles');
    assert.equal(hasDisabledAttribute(buttonFor('data-tristar-generic-command', 'gearUp')), false, 'supported surface command should remain enabled');
    assert.equal(hasDisabledAttribute(buttonFor('data-tristar-generic-command', 'gearDown')), true, 'unsupported surface command should fail closed');

    const { html: staleHtml } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsTriStarAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({ enabled: true, reason: 'Ready.' });
        controls.applyControlCapabilities({
          surface: { gearUp: true },
          autopilotPulse: { apMaster: true },
        });
      },
      {
        props: {
          sourceStatus: 'stale',
          values: {
            'lights.beacon': false,
          },
          actionCapabilities: {
            'afcs.altitude.decrease': true,
            'lights.beacon.setOff': true,
          },
        },
      },
    );
    const staleButtonFor = (attribute, value) => staleHtml.match(new RegExp(`<button(?=[^>]*${attribute}="${value.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
    assert.equal(hasDisabledAttribute(staleButtonFor('data-aircraft-action', 'afcs.altitude.decrease')), true, 'stale source status should disable selector actions');
    assert.equal(hasDisabledAttribute(staleButtonFor('data-aircraft-action', 'lights.beacon.setOff')), true, 'stale source status should disable fixed light actions');
    assert.equal(hasDisabledAttribute(staleButtonFor('data-tristar-pulse-command', 'apMaster')), true, 'stale source status should disable momentary AP keys');
    assert.match(staleHtml, /Waiting for live aircraft data; AFCS mode controls are disabled\./, 'stale AFCS reason should remain visible on mobile and to assistive technology');
    assert.match(staleHtml, /data-tristar-afcs-readiness[^>]*data-ready="false"[^>]*>Unavailable<\/span>/, 'stale source status must not leave the AFCS readiness badge claiming ready');
    assert.equal(hasDisabledAttribute(staleButtonFor('data-tristar-generic-command', 'gearUp')), true, 'stale source status should disable generic surface commands');

    const { html: unavailableHtml } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsTriStarAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({
          enabled: false,
          reason: 'This browser has read-only access.',
        });
        controls.applyControlCapabilities({
          surface: { gearUp: true },
          autopilotPulse: { apMaster: true },
        });
      },
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'lights.beacon': false,
          },
          actionCapabilities: {
            'afcs.altitude.decrease': true,
            'lights.beacon.setOff': true,
          },
        },
      },
    );
    const unavailableButtonFor = (attribute, value) => unavailableHtml.match(new RegExp(`<button(?=[^>]*${attribute}="${value.replaceAll('.', '\\.')}")[^>]*>`))?.[0] || '';
    assert.equal(hasDisabledAttribute(unavailableButtonFor('data-aircraft-action', 'afcs.altitude.decrease')), true, 'global control availability should gate selector adapter actions');
    assert.equal(hasDisabledAttribute(unavailableButtonFor('data-aircraft-action', 'lights.beacon.setOff')), true, 'global control availability should gate light adapter actions');
    assert.match(unavailableHtml, /tristar-control-status-afcs-altitude[^>]*>This browser has read-only access\.<\/p>/, 'selector status should expose the global availability reason');
    assert.match(unavailableHtml, /tristar-control-status-lights-beacon[^>]*>This browser has read-only access\.<\/p>/, 'light status should expose the global availability reason');
    assert.match(unavailableHtml, /data-tristar-afcs-readiness[^>]*data-ready="false"[^>]*>Unavailable<\/span>/, 'global control unavailability should keep the AFCS readiness badge closed');
  });

  await test('FlyByWire A32NX template renders broad guarded controls and explicit safety boundaries', async () => {
    const actionCapabilities = Object.fromEntries([
      'propulsion.throttle.toga',
      'propulsion.throttle.flexMct',
      'propulsion.throttle.climb',
      'propulsion.throttle.idle',
      'lights.strobe.off',
      'lights.strobe.auto',
      'lights.strobe.on',
      'lights.runwayTurnoff.on',
      'lights.nose.taxi',
      'lights.landingLeft.on',
      'lights.landingRight.retract',
      'cabin.emergencyExit.off',
      'cabin.emergencyExit.auto',
      'cabin.emergencyExit.on',
      'systems.apuMaster.off',
      'systems.apuMaster.on',
      'systems.packFlow.low',
      'systems.packFlow.normal',
      'systems.packFlow.high',
      'systems.autobrake.disarm',
      'systems.autobrake.low',
      'systems.autobrake.medium',
      'systems.autobrake.max',
      'navigation.ndCaptainMode.arc',
      'surveillance.tcasMode.taRa',
      'controls.engineMode.normal',
      'displays.ecamPage.electrical',
    ].map((actionId) => [actionId, true]));
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FbwA32nxAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'propulsion.throttleLever1Angle': 25,
            'propulsion.throttleLever2Angle': 25,
            'flightGuidance.speedValue': 250,
            'flightGuidance.speedDashes': false,
            'flightGuidance.machMode': false,
            'flightGuidance.headingDeg': 87,
            'flightGuidance.headingDashes': false,
            'flightGuidance.altitudeFt': 12000,
            'flightGuidance.verticalValue': -500,
            'flightGuidance.verticalDashes': false,
            'flightGuidance.trkFpaMode': false,
            'flightGuidance.ap1': true,
            'flightGuidance.ap2': false,
            'flightGuidance.autothrust': true,
            'flightGuidance.speedManaged': true,
            'flightGuidance.headingManaged': false,
            'flightGuidance.altitudeManaged': true,
            'lights.strobeMode': 'auto',
            'lights.strobeAuto': true,
            'lights.strobeActive': false,
            'lights.beacon': true,
            'lights.nav': true,
            'lights.logo': false,
            'lights.wing': false,
            'lights.runwayTurnoff': true,
            'lights.noseMode': 'taxi',
            'lights.landingLeftMode': 'off',
            'lights.landingRightMode': 'retract',
            'cabin.noSmokingMode': 'auto',
            'cabin.emergencyExitMode': 'auto',
            'systems.battery1': true,
            'systems.battery2': true,
            'systems.battery1Voltage': 27.8,
            'systems.battery2Voltage': 27.6,
            'systems.externalPowerAvailable': true,
            'systems.externalPower': false,
            'systems.apuMaster': true,
            'systems.apuStart': false,
            'systems.apuAvailable': false,
            'systems.apuBleed': false,
            'systems.pack1': true,
            'systems.pack2': true,
            'systems.pack1ValveOpen': true,
            'systems.pack2ValveOpen': true,
            'systems.packFlowMode': 'normal',
            'systems.autobrakeMode': 'medium',
            'systems.engineAntiIce1': false,
            'systems.engineAntiIce2': false,
            'systems.wingAntiIce': false,
            'systems.ir1Mode': 'nav',
            'systems.ir2Mode': 'nav',
            'systems.ir3Mode': 'nav',
            'systems.adirsAlignmentSeconds': 0,
            'systems.adirsOnBattery': false,
            'systems.parkingBrake': true,
            'systems.apuMasterFault': false,
            'systems.apuBleedFault': false,
            'systems.pack1Fault': false,
            'systems.pack2Fault': false,
            'systems.ir1Fault': false,
            'systems.ir2Fault': false,
            'systems.ir3Fault': false,
            'navigation.ndCaptainMode': 'arc',
            'surveillance.tcasMode': 'taRa',
            'controls.engineMode': 'normal',
            'displays.ecamPage': 'electrical',
          },
          actionCapabilities,
        },
      },
    );

    assert.match(html, /data-aircraft-template="fbw-a32nx"/, 'template should identify its trusted registry key');
    assert.match(html, /FlyByWire Airbus A32NX/, 'template should render the aircraft heading');
    const renderedActionIds = [...html.matchAll(/data-aircraft-action="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(renderedActionIds.length, 245, 'the page should render every reviewed A32NX action');
    assert.equal(new Set(renderedActionIds).size, 245, 'every rendered A32NX action ID should be unique');
    const throttleHtml = html.match(/<section(?=[^>]*data-fbw-section="virtual-throttle")[\s\S]*?<\/section>/)?.[0] || '';
    assert.ok(
      html.indexOf('data-fbw-section="virtual-throttle"') < html.indexOf('id="fbw-a32nx-section-fcu"'),
      'the high-value calibrated throttle should lead the A32NX controls',
    );
    assert.match(throttleHtml, /both levers \u00b7 calibrated forward detents/i);
    assert.match(throttleHtml, /L CLB/);
    assert.match(throttleHtml, /R CLB/);
    assert.match(throttleHtml, /data-fbw-throttle-detent="climb"[^>]*aria-pressed="true"/);
    assert.doesNotMatch(throttleHtml, /type="range"|drag|slide/i, 'the A32NX throttle must remain a one-tap detent control');
    assert.match(html, /12,000/, 'authoritative FCU altitude should be formatted');
    assert.match(html, /data-aircraft-action="lights\.strobe\.auto"[^>]*aria-pressed="true"/, 'strobe readback should select AUTO');
    assert.doesNotMatch(html, /data-aircraft-action="lights\.strobe\.on"[^>]*disabled/, 'supported controls with readback should be enabled');
    assert.match(html, /data-aircraft-action="lights\.runwayTurnoff\.on"[^>]*aria-pressed="true"/, 'runway-turnoff readback should select ON');
    assert.doesNotMatch(html, /data-aircraft-action="lights\.runwayTurnoff\.on"[^>]*disabled/, 'runway-turnoff control should be usable');
    assert.match(html, /data-aircraft-action="lights\.nose\.taxi"[^>]*aria-pressed="true"/, 'nose-light readback should select TAXI');
    assert.doesNotMatch(html, /data-aircraft-action="lights\.nose\.taxi"[^>]*disabled/, 'nose-light control should be usable');
    assert.doesNotMatch(html, /data-aircraft-action="lights\.landingLeft\.on"[^>]*disabled/, 'left landing-light control should be usable');
    assert.match(html, /data-aircraft-action="lights\.landingRight\.retract"[^>]*aria-pressed="true"/, 'right landing-light readback should select RETRACT');
    assert.match(html, /data-aircraft-action="cabin\.emergencyExit\.auto"[^>]*aria-pressed="true"/, 'emergency-light ARM readback should select the matching control');
    assert.doesNotMatch(html, /data-aircraft-action="cabin\.emergencyExit\.auto"[^>]*disabled/, 'documented sign writes should be enabled with readback and capability');
    assert.match(html, /data-aircraft-action="systems\.apuMaster\.on"[^>]*aria-pressed="true"/, 'APU master state should select ON');
    assert.doesNotMatch(html, /data-aircraft-action="systems\.apuMaster\.on"[^>]*disabled/, 'documented APU write should be enabled with readback and capability');
    assert.match(html, /data-aircraft-action="systems\.packFlow\.normal"[^>]*aria-pressed="true"/, 'pack-flow state should select NORM');
    assert.doesNotMatch(html, /data-aircraft-action="systems\.packFlow\.normal"[^>]*disabled/, 'documented pack-flow write should be enabled with readback and capability');
    assert.match(html, /data-aircraft-action="systems\.autobrake\.medium"[^>]*aria-pressed="true"/, 'autobrake MED readback should select its guarded action');
    assert.doesNotMatch(html, /data-aircraft-action="navigation\.ndCaptainMode\.arc"[^>]*disabled/, 'documented captain ND selector should be enabled');
    assert.doesNotMatch(html, /data-aircraft-action="surveillance\.tcasMode\.taRa"[^>]*disabled/, 'documented TCAS selector should be enabled');
    assert.match(html, /data-aircraft-action="controls\.engineMode\.normal"[^>]*aria-pressed="true"/, 'engine mode readback should select NORM');
    assert.match(html, /data-aircraft-action="displays\.ecamPage\.electrical"[^>]*aria-pressed="true"/, 'ECAM ELEC page readback should select its action');
    assert.match(html, /AUTO armed; actual strobe output is OFF/, 'AUTO mode should distinguish selector state from actual output');
    assert.match(html, /Landing lights take about 9 seconds to extend/, 'landing-light extension timing should be clear');
    assert.doesNotMatch(html, /lights are read-only/, 'usable exterior lights must not be described as read-only');
    assert.match(html, /A32NX updates can affect compatibility/, 'the compatibility warning should remain concise and user-facing');
    assert.doesNotMatch(html, /adapter-owned|documentation-backed|logical readback|indexed wiper circuits/, 'implementation details should not appear in end-user copy');
    assert.doesNotMatch(html, /A32NX_|LIGHTING_|XMLVAR_|MF\.SimVars|MobiFlight/, 'raw aircraft routes must remain encapsulated outside the Vue contract');
  });

  await test('FlyByWire A32NX write controls fail closed without matching readback and capability', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FbwA32nxAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          sourceStatus: 'connected',
          values: { 'systems.apuMaster': false },
          actionCapabilities: { 'lights.strobe.on': true },
        },
      },
    );

    assert.match(html, /data-aircraft-action="lights\.strobe\.on"[^>]*disabled/, 'capability alone must not bypass missing live readback');
    assert.match(html, /data-aircraft-action="systems\.apuMaster\.on"[^>]*disabled/, 'live readback must not bypass a missing capability');
    assert.match(html, /Current aircraft state unavailable\./, 'the fail-closed state should be explained plainly');
  });

  await test('FlyByWire A32NX write controls honor global availability and expose its reason', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FbwA32nxAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({
          enabled: false,
          reason: 'This browser has read-only access.',
        });
      },
      {
        props: {
          sourceStatus: 'connected',
          values: { 'lights.strobeMode': 'off' },
          actionCapabilities: { 'lights.strobe.on': true },
        },
      },
    );

    const button = html.match(/<button(?=[^>]*data-aircraft-action="lights\.strobe\.on")[^>]*>/)?.[0] || '';
    assert.match(button, /\sdisabled(?:=| |>)/, 'global control availability must gate a supported action with live readback');
    assert.match(button, /title="This browser has read-only access\."/, 'the disabled button should expose the backend availability reason');
    assert.match(
      html,
      /id="fbw-control-status-lights-strobe"[^>]*>\s*This browser has read-only access\.<\/p>/,
      'the availability reason should remain visible outside the disabled button tooltip',
    );
  });

  await test('FlyByWire A32NX renders unavailable numeric telemetry as unknown', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FbwA32nxAircraftPanel.vue'),
      () => {},
      { props: { sourceStatus: 'connected', values: {} } },
    );

    assert.match(html, /SPD \/ MACH<\/div>\s*<div[^>]*>--<\/div>/, 'missing FCU speed must not render as zero');
    assert.match(html, /BAT 1 <span[^>]*>--<\/span>/, 'missing battery voltage must not render as zero volts');
    assert.match(html, /ADIRS ALIGNMENT <span[^>]*>--<\/span>/, 'missing ADIRS telemetry must not be reported as aligned');
  });

  await test('Fenix A32x template renders actionable guarded FCU controls before its broad persistent surface', async () => {
    const fcuModeActionIds = [
      'flightGuidance.ap1.off',
      'flightGuidance.ap1.on',
      'flightGuidance.ap2.off',
      'flightGuidance.ap2.on',
      'flightGuidance.autothrust.off',
      'flightGuidance.autothrust.on',
      'flightGuidance.localizer.off',
      'flightGuidance.localizer.on',
      'flightGuidance.approach.off',
      'flightGuidance.approach.on',
      'flightGuidance.expedite.off',
      'flightGuidance.expedite.on',
    ];
    const managedActionIds = [
      'flightGuidance.speedManaged.off',
      'flightGuidance.speedManaged.on',
      'flightGuidance.headingManaged.off',
      'flightGuidance.headingManaged.on',
      'flightGuidance.altitudeManaged.off',
      'flightGuidance.altitudeManaged.on',
    ];
    const selectorActionIds = [
      'flightGuidance.speed.set',
      'flightGuidance.heading.set',
      'flightGuidance.altitudeHundred.set',
    ];
    const throttleActionIds = [
      'propulsion.throttle.toga',
      'propulsion.throttle.flexMct',
      'propulsion.throttle.climb',
      'propulsion.throttle.idle',
    ];
    const actionCapabilities = Object.fromEntries([
      ...throttleActionIds,
      ...fcuModeActionIds,
      ...managedActionIds,
      ...selectorActionIds,
      'lights.beacon.on',
      'lights.strobe.auto',
      'lights.nose.taxi',
      'systems.engineMode.start',
      'lighting.overhead.half',
    ].map((actionId) => [actionId, true]));
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FenixA32xAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fenix-a320',
          sourceStatus: 'connected',
          values: {
            'propulsion.throttleLever1Position': 3,
            'propulsion.throttleLever2Position': 3,
            'flightGuidance.ap1': true,
            'flightGuidance.ap2': false,
            'flightGuidance.autothrust': true,
            'flightGuidance.localizer': true,
            'flightGuidance.approach': false,
            'flightGuidance.expedite': false,
            'flightGuidance.speedValue': 250,
            'flightGuidance.headingDeg': 271,
            'flightGuidance.altitudeFt': 12000,
            'flightGuidance.verticalValue': -700,
            'flightGuidance.speedManaged': true,
            'flightGuidance.headingManaged': false,
            'flightGuidance.altitudeManaged': true,
            'flightGuidance.altitudeIncrementMode': 'hundred',
            'lights.beacon': false,
            'lights.strobeMode': 'auto',
            'lights.noseMode': 'taxi',
            'systems.engineMode': 'start',
            'lighting.overhead': 0.5,
          },
          actionCapabilities,
        },
      },
    );

    assert.match(html, /data-aircraft-template="fenix-a32x"/);
    assert.match(html, /data-fenix-variant="a320"/);
    assert.match(html, /Fenix A320 compatibility/);
    assert.ok(
      html.indexOf('data-fenix-section="virtual-throttle"') < html.indexOf('data-fenix-section="flight-guidance-fcu"'),
      'the high-value virtual throttle should lead the Fenix controls',
    );
    const throttleHtml = html.match(/<section(?=[^>]*data-fenix-section="virtual-throttle")[\s\S]*?<\/section>/)?.[0] || '';
    const renderedThrottleActionIds = [...throttleHtml.matchAll(/data-aircraft-action="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(renderedThrottleActionIds, throttleActionIds, 'the virtual throttle should expose only four fixed forward detents');
    assert.match(throttleHtml, /Both levers · forward detents/);
    assert.match(throttleHtml, /L CLB/);
    assert.match(throttleHtml, /R CLB/);
    assert.match(throttleHtml, /data-fenix-throttle-detent="climb"[^>]*aria-pressed="true"/);
    assert.match(throttleHtml, /min-h-\[84px\]/, 'fat-finger throttle targets should remain substantially larger than ordinary controls');
    assert.doesNotMatch(throttleHtml, /type="range"|drag|slide/i, 'the detent control must stay one-tap rather than pretending to be a sliding axis');
    assert.doesNotMatch(throttleHtml, /reverse[^<]*data-aircraft-action/i, 'reverse thrust must not be actionable');
    const throttleComponentSource = fs.readFileSync(path.join(
      frontendRoot,
      'src',
      'vue',
      'components',
      'aircraft-specific',
      'templates',
      'FenixThrottleControl.vue',
    ), 'utf8');
    assert.match(throttleComponentSource, /@click="commit\(detent\)"/, 'each detent should be a direct one-tap action');
    assert.match(throttleComponentSource, /\.fenix-throttle-button\s*\{\s*touch-action:\s*none;/, 'a touch started on a detent must not scroll the page');
    assert.doesNotMatch(throttleComponentSource, /@pointermove|type="range"/, 'the virtual throttle must not grow hidden drag or slider behavior');
    assert.ok(
      html.indexOf('data-fenix-section="flight-guidance-fcu"') < html.indexOf('data-aircraft-control-section="exterior-lights"'),
      'the high-value FCU controls should precede secondary aircraft systems',
    );
    assert.match(html, /Flight Guidance &amp; FCU/);
    assert.doesNotMatch(html, /FCU pushbuttons remain monitoring-only/, 'the restored FCU must not retain obsolete read-only copy');
    const fcuHtml = html.match(/<section(?=[^>]*data-fenix-section="flight-guidance-fcu")[\s\S]*?<\/section>/)?.[0] || '';
    const renderedFcuActionIds = [...fcuHtml.matchAll(/data-aircraft-action="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(renderedFcuActionIds.length, 21, 'the active FCU view should expose 12 mode targets, 6 managed targets, and 3 validated selector applies');
    assert.deepEqual(
      [...renderedFcuActionIds].sort(),
      [...fcuModeActionIds, ...managedActionIds, ...selectorActionIds].sort(),
      'the A320 FCU surface should render only the expected adapter-owned actions for the live 100-foot step',
    );
    assert.match(html, /data-aircraft-action="flightGuidance\.ap1\.on"[^>]*aria-label="AUTOPILOT 1: ENGAGE"[^>]*aria-pressed="true"[^>]*aria-busy="false"/);
    assert.doesNotMatch(html, /data-aircraft-action="flightGuidance\.ap1\.on"[^>]*disabled/, 'AP1 engage should be actionable with live state and capability');
    assert.match(html, /data-aircraft-action="flightGuidance\.ap2\.off"[^>]*aria-pressed="true"/, 'AP2 must retain independent state and disconnect intent');
    assert.match(html, /data-aircraft-action="flightGuidance\.speedManaged\.on"[^>]*aria-pressed="true"/, 'speed managed readback should select PUSH MANAGED');
    assert.match(html, /data-aircraft-action="flightGuidance\.headingManaged\.off"[^>]*aria-pressed="true"/, 'heading selected readback should select PULL SELECTED');
    assert.match(html, /<input(?=[^>]*data-fenix-selector-input="speed")(?=[^>]*value="250")(?=[^>]*inputmode="numeric")(?=[^>]*enterkeyhint="done")(?=[^>]*aria-label="Set Fenix SPD target in KTS")[^>]*>/, 'speed should use an accessible typed target with mobile Enter submission');
    assert.match(html, /<input(?=[^>]*data-fenix-selector-input="heading")(?=[^>]*value="271")[^>]*>/, 'heading should initialize from the live FCU target');
    assert.match(html, /<input(?=[^>]*data-fenix-selector-input="altitude")(?=[^>]*value="12000")[^>]*>/, 'altitude should initialize from the live FCU target');
    assert.doesNotMatch(html, /data-fenix-selector-input="(?:speed|heading|altitude)"[^>]*disabled/, 'typed targets should enable only after global availability, readback, and capability are all ready');
    assert.match(html, /data-aircraft-action="flightGuidance\.altitudeHundred\.set"/, 'the live 100-foot FCU step should choose the bounded hundred-step action');
    assert.match(html, /data-fenix-fcu-readback="vertical"[\s\S]*-700[\s\S]*Units are mode-dependent/, 'V\/S-FPA should remain clearly read-only because its units depend on cockpit mode');
    assert.doesNotMatch(fcuHtml, /vertical(?:Speed)?\.set/, 'no raw V\/S-FPA write should leak into the Fenix panel');
    assert.doesNotMatch(html, /Fixed target|FCU lamp readback|Live lamp &amp; target readback|Aircraft-system effect/, 'repeated implementation and warning labels should stay out of the control cards');
    assert.match(html, /data-aircraft-action="lights\.strobe\.auto"[^>]*aria-pressed="true"/);
    assert.match(html, /data-aircraft-action="lights\.nose\.taxi"[^>]*aria-pressed="true"/);
    assert.match(html, /data-aircraft-action="systems\.engineMode\.start"[^>]*aria-pressed="true"/);
    assert.match(html, /data-aircraft-action="lighting\.overhead\.half"[^>]*aria-pressed="true"/);
    assert.match(html, /Unofficial Fenix A32X compatibility\. Flight Fabric is not affiliated with FenixSim\./);
    assert.match(html, /Most expanded controls still need live testing across every A319, A320, and A321 release\./);
    assert.doesNotMatch(html, /S_OH_|I_FCU_|MF\.SimVars|MobiFlight/);
  });

  await test('Fenix A32x controls fail closed without their own live readback', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FenixA32xAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fenix-a319',
          sourceStatus: 'connected',
          values: {},
          actionCapabilities: { 'lights.beacon.on': true },
        },
      },
    );

    assert.match(html, /data-aircraft-action="lights\.beacon\.on"[^>]*disabled/);
    assert.match(html, /Live switch readback unavailable; control disabled\./);
    assert.match(html, /data-aircraft-action="flightGuidance\.ap1\.on"[^>]*disabled/, 'FCU capability must not bypass missing lamp readback');
    assert.match(html, /data-fenix-selector-input="speed"[^>]*disabled/, 'selector input must not fabricate a target without live FCU readback');
    assert.doesNotMatch(html, /data-fenix-selector-input="speed"[^>]*value="0"/, 'missing FCU target must remain blank rather than becoming zero');
    assert.match(html, /data-aircraft-action="propulsion\.throttle\.toga"[^>]*disabled/, 'throttle capability must not bypass either missing lever readback');
    assert.match(html, /Both live throttle-lever readbacks are required\./);
  });

  await test('Fenix FCU setup state names the required MobiFlight transport', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FenixA32xAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fenix-a320',
          sourceStatus: 'connected',
          values: { 'flightGuidance.speedValue': 250 },
          actionCapabilities: {},
          controlSetupRequired: true,
        },
      },
    );

    assert.match(html, /id="fenix-fcu-status"[^>]*>Requires MobiFlight Event Module setup for Fenix FCU writes\.<\/p>/, 'global FCU status must surface required setup instead of claiming readiness');
    assert.match(html, /id="fenix-selector-status-speed"[^>]*>Requires MobiFlight Event Module setup for Fenix FCU writes\.<\/p>/, 'disabled selector status must name the required Fenix write transport');
  });

  await test('Fenix FCU selectors respect Mach mode, altitude-step routing, pending state, and global availability', async () => {
    const componentPath = path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FenixA32xAircraftPanel.vue');
    const hasDisabledAttribute = (tag) => /\sdisabled(?:=| |>)/.test(tag);
    const tagFor = (html, element, attribute, value) => html.match(
      new RegExp(`<${element}(?=[^>]*${attribute}="${value.replaceAll('.', '\\.')}")[^>]*>`),
    )?.[0] || '';

    const { html: machHtml } = await renderComponent(
      componentPath,
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fenix-a320',
          sourceStatus: 'connected',
          values: {
            'flightGuidance.speedValue': 0.78,
            'flightGuidance.headingDeg': 90,
            'flightGuidance.altitudeFt': 12000,
            'flightGuidance.altitudeIncrementMode': 'thousand',
            'flightGuidance.ap1': true,
          },
          actionCapabilities: {
            'flightGuidance.speed.set': true,
            'flightGuidance.heading.set': true,
            'flightGuidance.altitudeThousand.set': true,
            'flightGuidance.ap1.off': true,
            'flightGuidance.ap1.on': true,
          },
          isActionPending: (groupId) => groupId === 'flightGuidance.ap1',
        },
      },
    );

    assert.equal(hasDisabledAttribute(tagFor(machHtml, 'input', 'data-fenix-selector-input', 'speed')), true, 'a sub-100 Fenix speed value denotes Mach mode and must block knot writes');
    assert.match(machHtml, /Mach mode detected\. Switch the FCU to SPD in the cockpit before setting knots\./, 'Mach blocking must tell the pilot how to enable a knot target');
    assert.match(machHtml, /LIVE MACH RAW 0\.78/, 'ambiguous fractional Mach readback should be shown exactly as a raw value');
    assert.doesNotMatch(machHtml, /LIVE (?:1|0\.78) KTS/, 'ambiguous Mach readback must never be rounded or labelled as knots');
    assert.match(machHtml, /data-aircraft-action="flightGuidance\.altitudeThousand\.set"/, 'the live 1000-foot selector state must choose the thousand-step backend action');
    assert.doesNotMatch(machHtml, /data-aircraft-action="flightGuidance\.altitudeHundred\.set"/, 'the inactive altitude-step action must not be exposed');
    assert.match(machHtml, /Valid 1,000 ft increments/, 'the visible constraint must agree with the live altitude-step route');
    const pendingApButton = tagFor(machHtml, 'button', 'data-aircraft-action', 'flightGuidance.ap1.on');
    assert.equal(hasDisabledAttribute(pendingApButton), true, 'a pending AP1 command must block another AP1 dispatch');
    assert.match(pendingApButton, /aria-busy="true"/, 'pending AP state must be exposed to assistive technology');
    assert.match(machHtml, /FCU command in progress; waiting for a fresh aircraft readback\./, 'pending status should be visible through an aria-live region');

    const { html: rawMachHtml } = await renderComponent(
      componentPath,
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fenix-a320',
          sourceStatus: 'connected',
          values: { 'flightGuidance.speedValue': 78 },
          actionCapabilities: { 'flightGuidance.speed.set': true },
        },
      },
    );

    assert.equal(hasDisabledAttribute(tagFor(rawMachHtml, 'input', 'data-fenix-selector-input', 'speed')), true, 'an integer raw Mach-like value must also fail closed');
    assert.match(rawMachHtml, /LIVE MACH RAW 78/, 'integer-scaled ambiguous Mach readback should stay raw');
    assert.doesNotMatch(rawMachHtml, /LIVE 78 KTS/, 'integer-scaled ambiguous Mach readback must not be presented as knots');

    const { html: untrustedBaselineHtml } = await renderComponent(
      componentPath,
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fenix-a320',
          sourceStatus: 'connected',
          values: {
            'flightGuidance.speedValue': 250,
            'flightGuidance.headingDeg': 360,
            'flightGuidance.altitudeFt': 12500,
            'flightGuidance.altitudeIncrementMode': 'thousand',
          },
          actionCapabilities: {
            'flightGuidance.speed.set': true,
            'flightGuidance.heading.set': true,
            'flightGuidance.altitudeThousand.set': true,
          },
        },
      },
    );

    assert.equal(hasDisabledAttribute(tagFor(untrustedBaselineHtml, 'input', 'data-fenix-selector-input', 'speed')), false, 'a trusted in-range, on-step speed baseline should stay editable');
    assert.equal(hasDisabledAttribute(tagFor(untrustedBaselineHtml, 'input', 'data-fenix-selector-input', 'heading')), true, 'heading 360 must be rejected because the backend domain ends at 359');
    assert.match(untrustedBaselineHtml, /Live FCU value is outside the trusted 0-359 DEG range; selector disabled\./, 'out-of-range baseline status must explain the trusted backend range');
    assert.equal(hasDisabledAttribute(tagFor(untrustedBaselineHtml, 'input', 'data-fenix-selector-input', 'altitude')), true, '12,500 feet must be rejected while the live selector uses 1,000-foot steps');
    assert.match(untrustedBaselineHtml, /Live FCU value is not aligned to the active 1,000 FT increment; selector disabled\./, 'off-step baseline status must explain the active trusted increment');

    const { html: readOnlyHtml } = await renderComponent(
      componentPath,
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({
          enabled: false,
          reason: 'This browser has read-only access.',
        });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fenix-a320',
          sourceStatus: 'connected',
          values: {
            'flightGuidance.ap1': false,
            'flightGuidance.speedValue': 250,
            'flightGuidance.altitudeIncrementMode': 'hundred',
            'lights.beacon': false,
          },
          actionCapabilities: {
            'flightGuidance.ap1.on': true,
            'flightGuidance.speed.set': true,
            'lights.beacon.on': true,
          },
        },
      },
    );

    assert.equal(hasDisabledAttribute(tagFor(readOnlyHtml, 'button', 'data-aircraft-action', 'flightGuidance.ap1.on')), true, 'global read-only state must gate FCU mode buttons');
    assert.equal(hasDisabledAttribute(tagFor(readOnlyHtml, 'input', 'data-fenix-selector-input', 'speed')), true, 'global read-only state must gate FCU target inputs');
    assert.equal(hasDisabledAttribute(tagFor(readOnlyHtml, 'button', 'data-aircraft-action', 'lights.beacon.on')), true, 'global read-only state must gate the rest of the Fenix panel too');
    assert.match(readOnlyHtml, /This browser has read-only access\./, 'the availability reason must remain visible outside disabled native controls');
  });

  await test('Fenix FCU pending state follows each shared physical knob group', async () => {
    const componentPath = path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FenixA32xAircraftPanel.vue');
    const hasDisabledAttribute = (tag) => /\sdisabled(?:=| |>)/.test(tag);
    const tagFor = (html, element, attribute, value) => [...html.matchAll(new RegExp(`<${element}[^>]*>`, 'g'))]
      .map((match) => match[0])
      .find((tag) => tag.includes(`${attribute}="${value}"`)) || '';
    const actionIds = [
      'flightGuidance.speed.set',
      'flightGuidance.speedManaged.off',
      'flightGuidance.speedManaged.on',
      'flightGuidance.heading.set',
      'flightGuidance.headingManaged.off',
      'flightGuidance.headingManaged.on',
      'flightGuidance.altitudeHundred.set',
      'flightGuidance.altitudeManaged.off',
      'flightGuidance.altitudeManaged.on',
      'flightGuidance.altitudeIncrement.hundred',
      'flightGuidance.altitudeIncrement.thousand',
    ];
    const { html } = await renderComponent(
      componentPath,
      ({ useAircraftControlsStore }) => {
        useAircraftControlsStore().setAvailability({ enabled: true, reason: 'Ready.' });
      },
      {
        props: {
          profileKey: 'bundled/msfs/fenix-a320',
          sourceStatus: 'connected',
          values: {
            'flightGuidance.speedValue': 250,
            'flightGuidance.speedManaged': false,
            'flightGuidance.headingDeg': 90,
            'flightGuidance.headingManaged': false,
            'flightGuidance.altitudeFt': 12000,
            'flightGuidance.altitudeManaged': true,
            'flightGuidance.altitudeIncrementMode': 'hundred',
          },
          actionCapabilities: Object.fromEntries(actionIds.map((actionId) => [actionId, true])),
          isActionPending: (groupId) => (
            groupId === 'flightGuidance.speed' || groupId === 'flightGuidance.altitude'
          ),
        },
      },
    );

    assert.equal((html.match(/data-aircraft-control-group="flightGuidance\.speed"/g) || []).length, 2, 'speed target and push/pull controls should share the physical speed-knob group');
    assert.equal((html.match(/data-aircraft-control-group="flightGuidance\.heading"/g) || []).length, 2, 'heading target and push/pull controls should share the physical heading-knob group');
    assert.equal((html.match(/data-aircraft-control-group="flightGuidance\.altitude"/g) || []).length, 3, 'altitude target, push/pull, and 100/1000 controls should share the physical altitude-knob group');
    const statusIds = [...html.matchAll(/id="(fenix-control-status-[^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(statusIds).size, statusIds.length, 'shared physical groups must retain unique status element IDs');

    const pendingSpeedInput = tagFor(html, 'input', 'data-fenix-selector-input', 'speed');
    const pendingSpeedManaged = tagFor(html, 'button', 'data-aircraft-action', 'flightGuidance.speedManaged.on');
    assert.equal(hasDisabledAttribute(pendingSpeedInput), true, 'a pending speed-knob write must block typed speed entry');
    assert.match(pendingSpeedInput, /aria-busy="true"/, 'shared speed pending state should reach the typed input');
    assert.equal(hasDisabledAttribute(pendingSpeedManaged), true, 'a pending speed target must also block speed push/pull');
    assert.match(pendingSpeedManaged, /aria-busy="true"/, 'shared speed pending state should reach push/pull controls');

    const pendingAltitudeInput = tagFor(html, 'input', 'data-fenix-selector-input', 'altitude');
    const pendingAltitudeManaged = tagFor(html, 'button', 'data-aircraft-action', 'flightGuidance.altitudeManaged.off');
    const pendingAltitudeStep = tagFor(html, 'button', 'data-aircraft-action', 'flightGuidance.altitudeIncrement.thousand');
    assert.equal(hasDisabledAttribute(pendingAltitudeInput), true, 'a pending altitude-knob write must block typed altitude entry');
    assert.equal(hasDisabledAttribute(pendingAltitudeManaged), true, 'a pending altitude target must block altitude push/pull');
    assert.equal(hasDisabledAttribute(pendingAltitudeStep), true, 'a pending altitude target must block the 100/1000 selector');
    assert.match(pendingAltitudeStep, /aria-busy="true"/, 'shared altitude pending state should reach the 100/1000 selector');
    const altitudeManagedStatusId = pendingAltitudeManaged.match(/aria-describedby="([^"]+)/)?.[1]?.split(' ')[0] || '';
    const altitudeStepStatusId = pendingAltitudeStep.match(/aria-describedby="([^"]+)/)?.[1]?.split(' ')[0] || '';
    assert.notEqual(altitudeManagedStatusId, altitudeStepStatusId, 'altitude push/pull and step controls must describe themselves with distinct status nodes');
    assert.ok(statusIds.includes(altitudeManagedStatusId), 'altitude push/pull aria-describedby must resolve to a rendered status node');
    assert.ok(statusIds.includes(altitudeStepStatusId), 'altitude step aria-describedby must resolve to a rendered status node');

    assert.equal(hasDisabledAttribute(tagFor(html, 'input', 'data-fenix-selector-input', 'heading')), false, 'pending speed and altitude knobs must not block the independent heading knob');
  });

  await test('LiveMapTabShell renders store-backed live-map empty-state visibility and copy', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LiveMapTabShell.vue'),
      ({ useLiveMapStore }) => {
        const liveMap = useLiveMapStore();
        liveMap.setMapEmptyState({
          visible: false,
          message: 'Waiting for GPS lock',
        });
      },
    );

    assert.match(html, /id="live-map-empty"[^>]*hidden/, 'live-map empty state should hide when the store collapses it');
    assert.match(html, /id="live-map-empty"[^>]*>Waiting for GPS lock</, 'live-map empty-state copy should render from the store');
  });

  console.log('\n--- landing panel ---\n');
  await test('LandingPanel does not render a live approach monitor', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'LandingPanel.vue'));

    assert.doesNotMatch(html, /id="current-approach-debug-panel"/, 'landing panel should not render the removed live monitor root');
    assert.doesNotMatch(html, /Approach Monitor/, 'landing panel should not render live approach monitor copy');
  });

  await test('LandingPanel renders waiting and landing-card visibility from the landing store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingPanel.vue'),
      ({ useLandingStore }) => {
        const landing = useLandingStore();
        landing.setLandingCardVisible(true);
      },
    );
    const landingCardClass = html.match(/id="landing-card"[^>]*class="([^"]*)"/)?.[1] || '';
    const waitingClass = html.match(/id="landing-waiting-state"[^>]*class="([^"]*)"/)?.[1] || '';
    const emptyClass = html.match(/id="landing-empty"[^>]*class="([^"]*)"/)?.[1] || '';

    assert.equal(landingCardClass.split(/\s+/).includes('hidden'), false, 'landing card should be visible when the landing store enables it');
    assert.equal(waitingClass.split(/\s+/).includes('hidden'), true, 'waiting state should hide when the landing card is visible');
    assert.equal(emptyClass.split(/\s+/).includes('hidden'), true, 'mobile landing empty-state should hide when the landing card is visible');
  });

  await test('LandingPanel renders landing-card summary and in-flight detail from the landing store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingPanel.vue'),
      ({ useLandingStore }) => {
        const landing = useLandingStore();
        landing.applyLandingCardMessage({
          final: true,
          vs: -467.3,
          color: '#00ff88',
          grade: 'Firm',
          gforce: 1.23,
          icao: 'YSSY',
          runway: '34L',
          iasKts: 136,
          gsKts: 142,
          crosswind: -8,
          windSpeed: 12,
          windDirectionTrueDeg: 240,
          approachType: 'ILS',
          pitchDeg: 3.1,
          bankDeg: -1.4,
          centerlineDev: 0.4,
          touchdownDistance: {
            distanceFt: 305,
            grade: 'Outstanding',
            lateralOffsetFt: 3,
            lateralOffsetGrade: 'Outstanding',
            lateralOffsetScore: 98,
            bounceGrade: 'Clean',
            bounceCount: 0,
            bounceScore: 100,
          },
          rolloutAnalysis: {
            assessment: 'caution',
            maxBankDeg: 3.3,
            maxBankRateDegS: 4.6,
            maxHeadingDeviationDeg: 14.6,
            maxHeadingDeviationSide: 'right',
            conservativeRunwayEdgeMarginFt: 27,
            flags: [{ code: 'rollout_bank', label: 'Noticeable bank during rollout' }],
          },
          ultimateStability: { score: 91, gateStable: true },
          flightSummary: {
            max_alt_ft: 12000,
            max_ias_kts: 250,
            go_around_count: 1,
            overspeed_count: 2,
            violations: [{ rule_id: 'bank_angle', severity: 'warning', label: 'Bank Angle', duration_ms: 4200 }],
          },
        }, {
          flightUpsetCount: 2,
        });
      },
    );

    assert.match(html, /Touchdown[\s\S]*id="landing-grade"[^>]*>FIRM</, 'landing summary should explicitly scope the raw touchdown-rate grade');
    assert.match(html, /Touchdown zone[\s\S]*id="landing-summary-tdz"[^>]*>305 ft</, 'landing summary should present touchdown distance as a peer metric');
    assert.match(html, /id="landing-summary-tdz-detail"[^>]*>Outstanding</, 'landing summary should subordinate the touchdown-zone quality to its distance');
    assert.match(html, /id="landing-summary-approach"[^>]*>STABLE</, 'landing summary should show the approach verdict as a peer fact');
    assert.match(html, /id="landing-summary-approach-score"[^>]*>\s*Approach score 91%\s*</, 'landing summary should label the subordinate approach percentage');
    assert.match(html, /id="landing-summary-bounce"[^>]*>Clean</, 'landing summary should show bounce as a peer fact');
    assert.doesNotMatch(html, /id="landing-summary-bounce-detail"/, 'landing summary should not repeat Clean as bounce detail');
    assert.match(html, /id="landing-gforce"[^>]*>G: 1\.23</, 'landing gforce should render from store state');
    assert.match(html, /id="landing-vs"[^>]*>-467</, 'landing vertical speed should render from store state');
    assert.match(html, /id="landing-airport"[^>]*>YSSY</, 'landing airport should render from store state');
    assert.match(html, /id="landing-runway"[^>]*>RWY 34L</, 'landing runway should render from store state');
    assert.match(html, /id="landing-tdz-value"[^>]*>305 ft</, 'landing touchdown distance should render from store state');
    assert.match(html, /1,000 ft target/, 'landing card should label the ideal target separately from the formal TDZ');
    assert.match(html, /id="landing-tdz-achieved"[^>]*>YES</, 'landing first-1,000-ft target should render from store state');
    assert.match(html, /id="landing-stability-score"[^>]*>STABLE</, 'landing approach verdict should render from store state');
    assert.match(html, /id="landing-ias"[^>]*>136 kt</, 'landing IAS should render from store state');
    assert.match(html, /id="landing-gs"[^>]*>GS: 142</, 'landing GS should render from store state');
    assert.match(html, /id="landing-crosswind"[^>]*>8 kt L</, 'landing crosswind should render from store state');
    assert.match(html, /id="landing-wind-context"[^>]*aria-label="Wind at touchdown, from 240 degrees true, WSW, 12 knots, crosswind 8 knots from left"/, 'wind context should describe direction, speed, and crosswind accessibly');
    assert.match(html, /id="landing-wind-direction-prefix"[^>]*>FROM</, 'wind context should make the meteorological from convention explicit');
    assert.match(html, /id="landing-wind-direction"[^>]*>\s*240°T\s*</, 'wind context should render the true touchdown direction prominently');
    assert.match(html, /id="landing-wind-speed"[^>]*>\s*12 kt\s*</, 'wind context should render touchdown wind speed prominently');
    assert.match(html, /<path d="M32 55V19"><\/path>/, 'the zero-degree compass vector should point toward the north wind source');
    assert.match(html, /<path d="m25 27 7-8 7 8"><\/path>/, 'the compass arrowhead should point to the meteorological FROM bearing');
    assert.match(html, /id="landing-wind-reference"[^>]*>\s*True north · wind source WSW\s*</, 'wind context should spell out its reference and cardinal source');
    assert.match(html, /id="landing-wind-crosswind"[^>]*>\s*XW 8 kt from left\s*</, 'wind context should retain runway-relative crosswind');
    assert.match(html, /transform:rotate\(240deg\)/, 'wind compass arrow should rotate to the wind-from bearing');
    assert.match(html, /id="landing-wind-total"[^>]*>FROM 240°T · 12 kt</, 'detailed metrics should repeat the absolute wind summary');
    assert.match(html, /id="landing-approach-type"[^>]*>ILS</, 'landing approach type should render from store state');
    assert.match(html, /id="landing-pitch"[^>]*>\+3\.1 deg</, 'landing pitch should render from store state');
    assert.match(html, /id="landing-bank"[^>]*>1\.4 deg L</, 'landing bank should render from store state');
    assert.match(html, /id="landing-centerline"[^>]*>ALIGNED</, 'landing runway alignment should render from store state');
    assert.match(html, /id="landing-upset-count"[^>]*>2</, 'landing upset count should render from store state');
    assert.match(html, /id="landing-debrief-factors"/, 'landing debrief factors section should render');
    assert.match(html, /id="landing-debrief-reasons"[\s\S]*Firm touchdown[\s\S]*Stabilized approach/, 'landing debrief reasons should render from store state');
    assert.match(html, /Telemetry confidence/, 'landing confidence label should explicitly describe telemetry quality');
    assert.match(html, /id="landing-data-confidence"[^>]*>\s*High\s*</, 'landing data confidence should render from store state');
    assert.match(html, /id="landing-rollout-analysis"(?![^>]*hidden)/, 'separate rollout analysis should be visible');
    assert.match(html, /id="landing-rollout-assessment"[^>]*>CAUTION</, 'rollout assessment should render from store state');
    assert.match(html, /id="landing-rollout-metrics"[\s\S]*Peak bank[\s\S]*3\.3 deg[\s\S]*Heading deviation[\s\S]*14\.6 deg right/, 'rollout metrics should render independently of touchdown attitude');
    assert.match(html, /Conservative edge margin[\s\S]*27 ft/, 'rollout metrics should render the uncertainty-adjusted runway-edge margin');
    assert.match(html, /id="landing-inflight-stats"[^>]*class="[^"]*grid[^"]*xl:grid-cols-4[^"]*"/, 'in-flight stats should use a structured responsive grid');
    assert.match(html, /id="landing-inflight-stat-max-alt"[\s\S]*Max Alt[\s\S]*12,000 ft/, 'in-flight metrics should render as individually labelled cards');
    assert.match(html, /id="landing-inflight-stat-go-arounds"[\s\S]*Possible Go-Arounds[\s\S]*1/, 'possible go-arounds should retain their own summary card');
    assert.doesNotMatch(html, /id="landing-inflight-stats"[^>]*class="[^"]*flex-wrap/, 'in-flight stats should not fall back to the dense inline fact stream');
    assert.match(html, /Flight Summary[\s\S]*Events[\s\S]*id="landing-inflight-violations"/, 'flight metrics and recorded events should have separate visual hierarchy');
    assert.match(html, /id="landing-inflight-violations"[\s\S]*Overspeed[\s\S]*2x[\s\S]*Bank Angle[\s\S]*warning - 4s/, 'in-flight violation rows should render from store state');
  });

  await test('LandingPanel scopes touchdown, approach, and bounce as equal-weight facts', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingPanel.vue'),
      ({ useLandingStore }) => {
        useLandingStore().applyLandingCardMessage({
          final: true,
          vs: -243,
          grade: 'PERFECT',
          touchdownDistance: {
            distanceFt: 600,
            grade: 'Outstanding',
            bounceGrade: 'Single Bounce',
            bounceCount: 1,
          },
          ultimateStability: {
            verdict: 'unstable',
            score: 84,
            gateStable: false,
            gateFailures: ['speed_ok', 'vs_ok', 'glidepath_ok'],
          },
        });
      },
    );

    assert.match(html, /Touchdown[\s\S]*id="landing-grade"[^>]*class="[^"]*text-2xl[^"]*"[^>]*>PERFECT</, 'card should explicitly label the raw touchdown grade at peer visual weight');
    assert.match(html, /Approach[\s\S]*id="landing-summary-approach"[^>]*class="[^"]*text-2xl[^"]*"[^>]*>UNSTABLE</, 'card should give the failed approach verdict equal visual weight');
    assert.match(html, /Bounce[\s\S]*id="landing-summary-bounce"[^>]*class="[^"]*text-2xl[^"]*"[^>]*>1x</, 'card should give the bounce result equal visual weight');
    assert.match(html, /id="landing-summary-tdz"[^>]*>600 ft</, 'TDZ distance should remain a separate touchdown-position fact');
    assert.match(html, /id="landing-summary-tdz-detail"[^>]*>Outstanding</, 'TDZ quality should remain secondary to the touchdown distance');
    assert.match(html, /id="landing-summary-bounce-detail"[^>]*>Single Bounce</, 'a non-redundant bounce classification should remain visible');
    for (const kind of ['grade', 'rate', 'zone', 'approach', 'bounce']) {
      assert.match(
        html,
        new RegExp(`data-landing-summary-watermark="${kind}"`),
        `landing summary should render the ${kind} metric watermark`,
      );
    }
    assert.match(html, /id="landing-stability-score"[^>]*>UNSTABLE</, 'approach tile should lead with the gate verdict');
    assert.match(html, /3 substantial\/required findings · Approach score 84%/, 'approach tile should keep the labelled average score as secondary context');
  });

  await test('LandingPanel visually isolates detailed metrics that need attention', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingPanel.vue'),
      ({ useLandingStore }) => {
        useLandingStore().applyLandingCardMessage({
          final: true,
          vs: -320,
          grade: 'GOOD',
          touchdownDistance: {
            distanceFt: 1603,
            grade: 'Good',
            lateralOffsetFt: 2,
            lateralOffsetGrade: 'Outstanding',
            lateralOffsetScore: 98,
            bounceGrade: 'Clean',
            bounceCount: 0,
            bounceScore: 100,
          },
          ultimateStability: {
            verdict: 'unstable',
            score: 86,
            gateStable: false,
            gateFailures: ['speed_ok', 'vs_ok', 'glidepath_ok'],
          },
        });
      },
    );

    assert.match(html, /id="detailed-metrics-attention-count"[^>]*>2 items need attention</, 'detailed metrics should summarize the number of flagged tiles');
    assert.match(html, /<div(?=[^>]*data-detail-metric="touchdown-target")(?=[^>]*data-attention="warning")(?=[^>]*class="[^"]*landing-detail-metric--warning)[^>]*>/, 'a missed touchdown target should render as a warning callout');
    assert.match(html, /<div(?=[^>]*data-detail-metric="approach-verdict")(?=[^>]*data-attention="danger")(?=[^>]*class="[^"]*landing-detail-metric--danger)[^>]*>/, 'an unstable approach should render as a danger callout');
    assert.match(html, /<div(?=[^>]*data-detail-metric="approach-speed")(?![^>]*data-attention)[^>]*>/, 'neutral metrics should remain visually quiet');
  });

  await test('LandingPanel renders stability breakdown rows from the landing store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingPanel.vue'),
      ({ useLandingStore }) => {
        const landing = useLandingStore();
        landing.setStabilityBreakdown({
          metrics: [{
            key: 'speed_ok',
            label: 'Airspeed',
            valueText: '82%',
            valueClass: 'text-warning',
            backgroundClass: 'bg-warning/10',
            explanation: 'A little fast through the gate',
            tooltip: 'IAS within +/-5 kt of the gate-sample IAS - click for details',
            modal: {
              label: 'Airspeed',
              scoreText: 'Score: 82%',
              descriptionText: 'IAS should stay near the gate speed.',
              criteriaText: 'Within +/-5 kt.',
              detailText: 'Observed 8 kt above target.',
            },
          }],
          samplesText: '34',
        });
      },
    );

    assert.doesNotMatch(html, /id="stability-breakdown-section"[^>]*hidden/, 'stability breakdown section should show when metric rows exist');
    assert.match(html, /id="stability-breakdown-grid"[\s\S]*Airspeed[\s\S]*82%/, 'stability metric cards should render from store state');
    assert.match(html, /id="stability-breakdown-grid"[\s\S]*A little fast through the gate/, 'stability metric explanations should render from store state');
    assert.match(html, /Samples analyzed[\s\S]*34/, 'stability sample summary should render from store state');
  });

  await test('LandingPanel renders store-backed approach profile and top-down SVG sections', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingPanel.vue'),
      ({ useLandingStore }) => {
        const landing = useLandingStore();
        landing.setApproachProfile({
          svgHtml: '<svg viewBox="0 0 10 10"><path d="M0 10 L10 0" /></svg>',
          gateLabel: 'Gate: 1000 ft above thr',
        });
        landing.setTopdownProfile({
          svgHtml: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2" /></svg>',
        });
      },
    );

    assert.doesNotMatch(html, /id="approach-profile-section"[^>]*hidden/, 'approach profile section should show when the store provides SVG content');
    assert.doesNotMatch(html, /id="approach-profile-content"[^>]*hidden/, 'approach profile SVG body should be expanded by default');
    assert.match(html, /id="approach-profile-gate-label"[^>]*>Gate: 1000 ft above thr</, 'approach profile gate label should render from the store');
    assert.match(html, /id="approach-profile-svg-container"[\s\S]*<svg[\s\S]*<path/, 'approach profile SVG should render from the store');
    assert.doesNotMatch(html, /id="topdown-profile-section"[^>]*hidden/, 'top-down profile section should show when the store provides SVG content');
    assert.doesNotMatch(html, /id="topdown-profile-content"[^>]*hidden/, 'top-down profile SVG body should be expanded by default');
    assert.match(html, /id="topdown-profile-svg-container"[\s\S]*<svg[\s\S]*<circle/, 'top-down profile SVG should render from the store');
  });

  await test('LandingPanel expands every accordion by default and presents clear toggle controls in debrief mode', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingPanel.vue'),
      ({ useLandingStore }) => {
        const landing = useLandingStore();
        landing.setStabilityBreakdown({
          metrics: [{ key: 'speed_ok', label: 'Airspeed', valueText: '100%' }],
        });
        landing.setApproachProfile({ svgHtml: '<svg viewBox="0 0 10 10"></svg>' });
        landing.setTopdownProfile({ svgHtml: '<svg viewBox="0 0 10 10"></svg>' });
      },
      { props: { debriefMode: true } },
    );

    const accordionPairs = [
      ['stability-toggle-btn', 'stability-breakdown-content'],
      ['approach-profile-toggle-btn', 'approach-profile-content'],
      ['topdown-profile-toggle-btn', 'topdown-profile-content'],
      ['detailed-metrics-toggle-btn', 'detailed-metrics-content'],
    ];

    for (const [buttonId, contentId] of accordionPairs) {
      assert.match(
        html,
        new RegExp(`id="${buttonId}"[^>]*class="[^"]*cursor-pointer[^"]*bg-surface-200/60[^"]*text-gray-200[^"]*"[^>]*aria-expanded="true"[^>]*aria-controls="${contentId}"`),
        `${buttonId} should look interactive and expose its expanded state`,
      );
      assert.doesNotMatch(
        html,
        new RegExp(`id="${contentId}"[^>]*class="[^"]*hidden`),
        `${contentId} should be expanded by default`,
      );
    }
  });

  await test('LandingMetricModal renders store-backed metric detail', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingMetricModal.vue'),
      ({ useLandingStore }) => {
        const landing = useLandingStore();
        landing.openStabilityMetricModal({
          title: 'Airspeed',
          scoreText: 'Score: 82%',
          descriptionText: 'IAS should stay near the gate speed.',
          criteriaText: 'Within +/-5 kt.',
          detailText: 'Observed 8 kt above target.',
        });
      },
    );

    assert.doesNotMatch(html, /id="stability-metric-modal"[^>]*hidden/, 'stability metric modal should become visible when store state opens it');
    assert.match(html, /id="stability-metric-modal"[^>]*z-\[240\]/, 'stability metric modal should layer above the landing debrief modal');
    assert.match(html, /id="stability-metric-modal-title"[^>]*>Airspeed</, 'stability metric modal title should render from store state');
    assert.match(html, /id="stability-metric-modal-score"[^>]*>Score: 82%</, 'stability metric modal score should render from store state');
    assert.match(html, /id="stability-metric-modal-desc"[^>]*>IAS should stay near the gate speed\.</, 'stability metric modal description should render from store state');
    assert.match(html, /id="stability-metric-modal-criteria"[^>]*>Within \+\/-5 kt\.</, 'stability metric modal criteria should render from store state');
    assert.match(html, /id="stability-metric-modal-detail"[^>]*>Observed 8 kt above target\.</, 'stability metric modal detail should render from store state');
  });

  await test('LandingModal renders landing debrief overlay state', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingModal.vue'),
      ({ useLandingStore, useTimelineStore }) => {
        const landing = useLandingStore();
        landing.applyLandingCardMessage({
          final: true,
          icao: 'LFPB',
          runway: '07',
          vs: -210,
          grade: 'Good',
        });
        landing.openLandingModal({ loading: false });
        useTimelineStore().setDetail({
          visible: true,
          type: 'Landing',
          title: 'Landing at LFPB 07',
          selectedLandingEvent: { type: 'landing' },
          metricSections: [
            {
              key: 'landing-snapshot',
              rows: [
                { key: 'heading', label: 'Heading', value: '072 deg' },
                { key: 'position', label: 'Position', value: '48.7262, 2.3652' },
                { key: 'runway', label: 'Runway', value: '07 (8,858ft)' },
              ],
            },
            {
              key: 'touchdown-zone-analysis',
              rows: [
                { key: 'score', label: 'TDZ Score', value: '91/100' },
                { key: 'remaining', label: 'Remaining', value: '7,255ft (18.1% down runway)' },
              ],
            },
          ],
        });
      },
    );

    assert.match(html, /id="landing-modal"/, 'landing debrief modal should render when store state opens it');
    assert.match(html, /Landing Debrief/, 'landing debrief modal should render its title');
    assert.match(html, /LFPB[\s\S]*07/, 'landing debrief modal should render the selected landing airport and runway');
    assert.match(html, /id="landing-card"/, 'landing debrief modal should embed the landing panel content');
    assert.match(html, /id="landing-modal-recorded-context"/, 'timeline-only saved-event context should move into a collapsed modal section');
    assert.match(html, /Recorded Context[\s\S]*Heading[\s\S]*072 deg[\s\S]*TDZ Score[\s\S]*91\/100/, 'the modal should retain detailed saved-event fields omitted from the compact timeline panel');
    assert.doesNotMatch(html, /id="landing-modal-recorded-context"[^>]*\sopen(?:\s|>)/, 'additional recorded context should stay collapsed by default');

    const loading = await renderComponent(
      path.join('src', 'vue', 'components', 'LandingModal.vue'),
      ({ useLandingStore }) => {
        useLandingStore().openLandingModal({ loading: true });
      },
    );

    assert.match(loading.html, /id="landing-modal-loading"/, 'landing debrief modal should render loading feedback');
    assert.doesNotMatch(loading.html, /id="landing-card"/, 'loading modal should not render stale landing-card content');
  });

  console.log('\n--- logbook panel ---\n');
  await test('LogbookPanel forwards every saved touchdown scoring field to shared presentation', async () => {
    const source = fs.readFileSync(
      path.join(frontendRoot, 'src', 'vue', 'components', 'LogbookPanel.vue'),
      'utf8',
    );

    assert.match(source, /zone:\s*entry\.touchdownDistanceZone/, 'saved TDZ zone should reach the shared touchdown presentation');
    assert.match(source, /bounceScore:\s*entry\.bounceScore/, 'saved bounce score should reach the shared touchdown presentation');
    assert.match(source, /hasTouchdownData[\s\S]*entry\.touchdownDistanceZone[\s\S]*entry\.bounceScore\s*!=\s*null/, 'zone- or score-only saved results should not be discarded as empty');
  });

  await test('LogbookPanel renders backend aggregate stats and runway text', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'logbook',
          stats: {
            total: 4,
            grades: { FIRM: 2, HARD: 1, 'RUNWAY EXCURSION': 1 },
            longLandingCount: 1,
            avgVsFpm: -592,
            bestVsFpm: -467,
            airports: 2,
            aircraft: 0,
            trends: {
              aircraft: [{ key: 'pmdg-777', label: 'PMDG 777', count: 3, avgVsFpm: -310, avgStabilityScore: 88, stableRatePct: 67, trendVs: 'improving' }],
              airports: [{ key: 'YSSY', label: 'YSSY', count: 2, avgVsFpm: -280, stableRatePct: 100, trendVs: 'stable' }],
              runways: [
                { key: 'YSSY:34L', label: 'YSSY 34L', count: 2, avgVsFpm: -280, stableRatePct: 100, trendVs: 'stable' },
                { key: 'LFPG:27R', label: 'LFPG 27R', count: 1, avgVsFpm: -238, stableRatePct: 0 },
              ],
            },
          },
          entries: [
            {
              id: 'recent',
              timestamp: '2026-05-21T17:16:50.465Z',
              aircraft: null,
              icao: null,
              runway: null,
              vsFpm: -467.3,
              grade: 'FIRM',
              gateStable: null,
            },
            {
              id: 'numeric-runway',
              timestamp: '2026-05-01T11:03:18.775Z',
              aircraft: null,
              icao: 'YPAD',
              runway: '23',
              vsFpm: -700.3,
              grade: 'HARD',
              gateStable: null,
            },
            {
              id: 'unstable',
              timestamp: '2026-04-23T14:22:44.288Z',
              aircraft: null,
              icao: 'KBOS',
              runway: '33R',
              vsFpm: -608.6,
              grade: 'FIRM',
              gateStable: null,
              stabilityScore: 72,
              stabilityGateFailures: ['vs_unstable_after_gate'],
              touchdownDistanceFt: 3862,
              touchdownDistanceGrade: 'Long Landing',
              touchdownDistanceScore: 45,
            },
            {
              id: 'excursion',
              timestamp: '2026-04-22T14:22:44.288Z',
              aircraft: null,
              icao: 'KJFK',
              runway: '04L',
              vsFpm: -800.1,
              grade: 'RUNWAY EXCURSION',
              gateStable: true,
            },
          ],
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.match(html, /4 landings recorded/, 'subtitle should render backend total');
    assert.match(html, /id="logbook-panel-toggle"[\s\S]*aria-expanded="false"/, 'scored landings panel should start collapsed');
    assert.match(html, /id="logbook-panel-body"[^>]*style="display:none;"/, 'scored landings body should be hidden by default');
    assert.match(html, /class="logbook-panel[^"]*overflow-hidden/, 'scored landings panel should use rounded app card styling');
    assert.match(html, />4<\/div>/, 'landings count should render');
    assert.match(html, /-592 fpm/, 'average vertical speed should render');
    assert.match(html, /Softest touchdown rate -467 fpm/, 'softest touchdown-rate text should remain factual');
    assert.match(html, />2<\/div>/, 'airport count should render');
    assert.match(html, />0<\/div>/, 'aircraft count should render');
    assert.match(html, /2<\/span><span style="color:\s*#facc15;?">Firm/, 'firm count should reflect raw touchdown-rate grades');
    assert.match(html, /1<\/span><span style="color:\s*#f97316;?">Hard/, 'hard count should render');
    assert.match(html, /Long TDZ[\s\S]*>1<\/div>/, 'long touchdown-zone count should render');
    assert.doesNotMatch(html, /style="color:\s*#f97316;?">Long<\/span>/, 'TDZ outcomes should not be folded into the touchdown-rate legend');
    assert.match(html, /3862 ft/, 'touchdown distance should render in the scored landings table');
    assert.match(html, /Long Landing/, 'touchdown distance grade should render in the scored landings table');
    assert.match(html, /Touchdown Rate Grade/, 'the table should explicitly scope its grade column to touchdown rate');
    assert.match(html, />FIRM<\/span>/, 'a long TDZ should not rewrite the raw touchdown-rate grade');
    assert.match(html, /1<\/span><span style="color:\s*#94a3b8;?">Other/, 'non-rate legacy grades should remain outside touchdown-rate grade buckets');
    assert.match(html, /id="logbook-trends"[\s\S]*Recent Trends[\s\S]*Aircraft[\s\S]*PMDG 777[\s\S]*avg approach score 88%[\s\S]*TD rate improving/, 'aircraft trend rows should scope the average approach percentage');
    assert.match(html, /id="logbook-trends"[\s\S]*Airports[\s\S]*YSSY[\s\S]*100% strict stable/, 'airport trend rows should identify the legacy strict rate');
    assert.match(html, /LFPG 27R[\s\S]*0% strict stable/, 'trend rows without a VS comparison should still show the strict stability rate');
    assert.doesNotMatch(html, /VS\s*--/, 'trend rows without a VS comparison should not render a broken-looking VS placeholder');
    assert.match(html, /YPAD[^<]*<span[^>]*>23<\/span>/, 'numeric runway identifier should render as text');
    assert.match(html, /RUNWAY EXCURSION/, 'runway excursion grade should render as a first-class logbook row');
    assert.match(html, />UNSTABLE<\/span>/, 'unstable approach verdict should render');
    assert.doesNotMatch(html, /logbook-mobile-card__top/, 'desktop logbook render should not include hidden mobile row DOM');
  });

  await test('LogbookPanel does not present an indexed landing history as empty', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'historyIndexStatus',
          status: {
            phase: 'complete',
            generation: 1,
            counts: { flights: 119, landings: 25 },
          },
        });
        logbook.ingestMessage({
          type: 'logbook',
          entries: [],
          stats: {
            total: 0,
            grades: {},
            outcomeGrades: {},
            avgVsFpm: null,
            airports: 0,
            aircraft: 0,
          },
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.match(html, /25 landings recorded/, 'indexed landing count should remain visible when details are temporarily unavailable');
    assert.match(html, /Landings[\s\S]*>25<\/div>/, 'summary should use the known index count instead of a false zero');
    assert.match(html, /25 scored landings are indexed/, 'empty area should explain the temporary detail synchronization state');
    assert.doesNotMatch(html, /No landings recorded yet/, 'known indexed history must not render the genuine empty-history message');
  });

  await test('LogbookPanel grade bar normalizes title-case aggregate grade names', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'logbook',
          stats: {
            total: 1,
            grades: { Good: 1 },
            avgVsFpm: -532,
            airports: 1,
            aircraft: 1,
          },
          entries: [
            {
              id: 'recent',
              timestamp: '2026-05-21T17:16:50.465Z',
              aircraft: '737-800',
              icao: 'LFPG',
              runway: '27R',
              vsFpm: -532,
              grade: 'GOOD',
              gateStable: true,
            },
          ],
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.match(html, /1 landing recorded/, 'aggregate total should still render in the subtitle');
    assert.match(html, /1<\/span><span style="color:\s*#38bdf8;?">Good/, 'title-case Good stats should normalize into the Good bucket');
    assert.match(html, /style="width:100\.0%;min-width:2px;height:100%;"/, 'single known grade segment should fill the grade bar');
  });

  await test('LogbookPanel grade counts use raw touchdown grades when aggregate stats are unavailable', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'logbook',
          stats: {
            total: 20,
            grades: {},
            avgVsFpm: -420,
            airports: 2,
            aircraft: 1,
          },
          entries: [
            {
              id: 'good',
              timestamp: '2026-05-21T17:16:50.465Z',
              aircraft: '737-800',
              icao: 'LFPG',
              runway: '27R',
              vsFpm: -210,
              grade: 'GOOD',
              touchdownDistanceFt: 1835,
              touchdownDistanceGrade: 'Good',
              gateStable: true,
            },
            {
              id: 'acceptable',
              timestamp: '2026-05-20T17:16:50.465Z',
              aircraft: '737-800',
              icao: 'LFPG',
              runway: '09R',
              vsFpm: -407,
              grade: 'GOOD',
              touchdownDistanceFt: 3178,
              touchdownDistanceGrade: 'Acceptable',
              gateStable: false,
            },
            {
              id: 'long',
              timestamp: '2026-05-19T17:16:50.465Z',
              aircraft: '737-800',
              icao: 'LFPG',
              runway: '27R',
              vsFpm: -266,
              grade: 'GOOD',
              touchdownDistanceFt: 3862,
              touchdownDistanceGrade: 'Long Landing',
              gateStable: false,
            },
          ],
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.match(html, /20 landings recorded/, 'aggregate total should remain visible');
    assert.match(html, /3<\/span><span style="color:\s*#38bdf8;?">Good/, 'visible raw GOOD touchdown rows should count as Good');
    assert.match(html, /0<\/span><span style="color:\s*#facc15;?">Firm/, 'Acceptable TDZ position should not rewrite the touchdown grade');
    assert.doesNotMatch(html, /style="color:\s*#f97316;?">Long<\/span>/, 'Long Landing TDZ position should stay out of touchdown-rate counts');
    assert.match(html, /17<\/span><span style="color:\s*#94a3b8;?">Other/, 'uncategorized aggregate remainder should be visible as Other');
    assert.match(html, /Acceptable/, 'title-case TDZ outcomes should remain visible in the TDZ column');
    assert.doesNotMatch(html, /rounded"[^>]*>\s*ACCEPTABLE\s*<\/span>/, 'TDZ outcomes should not replace touchdown-grade pills');
    assert.match(html, /style="[^"]*background:\s*(?!transparent)[^;]+;[^"]*border:\s*1px solid (?!transparent)[^;"]+;?[^"]*"[^>]*>\s*<span>1835 ft/, 'good TDZ rows should use the same boxed badge shell as other TDZ outcomes');
    assert.doesNotMatch(html, /background:\s*transparent;\s*border:\s*1px solid transparent/, 'TDZ badges should not mix boxed and unboxed styling');
    assert.doesNotMatch(html, /min-height:\s*2\.5rem/, 'desktop rows should not render touchdown-grade accent strips');
  });

  await test('LogbookPanel uppercases every raw touchdown-rate grade label', async () => {
    const touchdownGrades = ['Perfect', 'Good', 'Firm', 'Hard', 'Very Hard'];
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'logbook',
          stats: { total: touchdownGrades.length },
          entries: touchdownGrades.map((grade, index) => ({
            id: `touchdown-grade-${index}`,
            timestamp: `2026-05-${String(index + 1).padStart(2, '0')}T17:16:50.465Z`,
            vsFpm: null,
            grade,
            touchdownDistanceGrade: 'Outstanding',
            gateStable: null,
            stabilityScore: index === 0 ? 91 : null,
          })),
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.match(html, /Touchdown Rate Grade/, 'the table should explicitly scope the grade column');
    assert.match(html, />NO VERDICT<\/span>/, 'a score without a gate result should remain explicitly verdict-free');
    for (const grade of touchdownGrades) {
      const label = grade.toUpperCase();
      assert.match(html, new RegExp(`rounded"[^>]*>\\s*${label}\\s*<\\/span>`), `${grade} should render as ${label}`);
    }
  });

  await test('LogbookPanel keeps raw touchdown grades separate from approach and bounce facts', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        useLogbookStore().ingestMessage({
          type: 'logbook',
          stats: {
            total: 1,
            grades: { PERFECT: 1 },
            avgVsFpm: -243,
            airports: 1,
            aircraft: 1,
          },
          entries: [{
            id: 'capped-perfect',
            timestamp: '2026-08-07T10:00:00.000Z',
            aircraft: 'A32NX',
            icao: 'LFPG',
            runway: '09L',
            vsFpm: -243,
            grade: 'PERFECT',
            touchdownDistanceFt: 600,
            touchdownDistanceGrade: 'Outstanding',
            bounceCount: 1,
            bounceGrade: 'Single Bounce',
            runwayExcursion: true,
            stabilityVerdict: 'unstable',
            gateStable: false,
            stabilityScore: 84,
            stabilityGateFailures: ['speed_proxy_unstable_after_gate'],
          }],
        });
      },
      { matchMedia: () => ({ matches: true }) },
    );

    assert.match(html, />PERFECT<\/span>/, 'an unstable or bounced row should preserve its raw touchdown-rate grade');
    assert.doesNotMatch(html, /min-height:2\.5rem/, 'desktop rows should not render touchdown-grade accent strips');
    assert.match(html, /RUNWAY EXCURSION/, 'runway excursion should remain visible as a separate TDZ fact');
    assert.match(html, />1x<\/td>/, 'the row should expose its bounce count in a dedicated column');
    assert.match(html, />UNSTABLE<\/span>/, 'the failed approach gate should remain prominent');
    assert.match(html, /1<\/span><span style="color:\s*#22c55e;?">Perfect/, 'raw PERFECT results should remain in the touchdown-grade distribution');
    assert.match(html, /Touchdown rate grade breakdown/, 'the aggregate chart should explicitly scope its grade counts');
  });

  await test('LogbookPanel names runway excursions in the mobile TDZ fact', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        useLogbookStore().ingestMessage({
          type: 'logbook',
          stats: { total: 1, grades: { GOOD: 1 }, airports: 1, aircraft: 1 },
          entries: [{
            id: 'mobile-excursion',
            timestamp: '2026-08-07T10:00:00.000Z',
            aircraft: 'A32NX',
            icao: 'LFPG',
            vsFpm: -349,
            grade: 'GOOD',
            runwayExcursion: true,
          }],
        });
      },
    );

    assert.match(
      html,
      /logbook-mobile-card__stat-label">TDZ<\/span>[\s\S]*RUNWAY EXCURSION/,
      'mobile history should name an excursion even when no TDZ geometry is available',
    );
  });

  await test('LogbookPanel distinguishes marginal and unstable approaches with visible desktop causes', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'logbook',
          stats: {
            total: 4,
            grades: { Good: 4 },
            avgVsFpm: -260,
            airports: 1,
            aircraft: 1,
          },
          entries: [
            {
              id: 'minor-issue',
              timestamp: '2026-05-21T17:16:50.465Z',
              aircraft: '737-800',
              icao: 'LFPG',
              runway: '27R',
              vsFpm: -210,
              grade: 'GOOD',
              gateStable: false,
              stabilityScore: 96,
              stabilityGateFailures: ['thrust_unstable_after_gate'],
              stabilityBreakdown: { thrust_ok: 79 },
            },
            {
              id: 'path-rate-issue',
              timestamp: '2026-05-20T18:16:50.465Z',
              aircraft: '737-800',
              icao: 'LFPG',
              runway: '27L',
              vsFpm: -240,
              grade: 'GOOD',
              gateStable: false,
              stabilityScore: 92,
              stabilityGateFailures: [
                'glidepath_proxy_unstable_after_gate',
                'glidepath_too_low_after_gate',
              ],
              stabilityBreakdown: { glidepath_ok: 56, glidepath_below_ok: 79 },
            },
            {
              id: 'major-config',
              timestamp: '2026-05-20T17:16:50.465Z',
              aircraft: '737-800',
              icao: 'LFPG',
              runway: '09R',
              vsFpm: -310,
              grade: 'GOOD',
              gateStable: false,
              stabilityScore: 91,
              stabilityGateFailures: ['gear_not_down_at_gate'],
            },
            {
              id: 'major-speed',
              timestamp: '2026-05-19T17:16:50.465Z',
              aircraft: '737-800',
              icao: 'LFPG',
              runway: '09L',
              vsFpm: -280,
              grade: 'GOOD',
              gateStable: false,
              stabilityScore: 84,
              stabilityGateFailures: ['speed_proxy_unstable_after_gate'],
              stabilityBreakdown: { speed_ok: 38 },
            },
          ],
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.strictEqual(
      (html.match(/>MARGINAL<\/span>/g) || []).length,
      2,
      'soft/proxy-only misses should render as marginal',
    );
    assert.strictEqual((html.match(/>UNSTABLE<\/span>/g) || []).length, 2, 'hard and substantial direct deviations should remain unstable');
    assert.match(html, /MARGINAL[\s\S]*Throttle movement 79%/, 'desktop rows should show a marginal throttle cause without requiring a tooltip');
    assert.match(html, /MARGINAL[\s\S]*Path rate 56% · Path rate steep 79%/, 'desktop rows should show the two leading proxy causes');
    assert.match(html, /UNSTABLE[\s\S]*Speed 38%/, 'desktop rows should show a substantial direct cause');
    assert.match(html, /Stable requires every applicable strict check[\s\S]*Marginal means a strict check was missed[\s\S]*no hard or substantial deviation/, 'Logbook should explain the four-state policy');
  });

  await test('LogbookPanel shows the persisted marginal verdict and cause on mobile', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        useLogbookStore().ingestMessage({
          type: 'logbook',
          stats: { total: 1, grades: { Good: 1 }, airports: 1, aircraft: 1 },
          entries: [{
            id: 'mobile-marginal',
            timestamp: '2026-05-21T17:16:50.465Z',
            aircraft: '737-800',
            icao: 'YSCB',
            runway: '35',
            vsFpm: -177,
            grade: 'GOOD',
            stabilityVerdict: 'marginal',
            gateStable: false,
            stabilityScore: 96,
            stabilityGateFailures: ['thrust_unstable_after_gate'],
            stabilityBreakdown: { thrust_ok: 79 },
          }],
        });
      },
      { matchMedia: () => ({ matches: false }) },
    );

    assert.match(html, /logbook-mobile-card__stat-label">Approach<\/span>[\s\S]*Marginal[\s\S]*Throttle movement 79%/, 'mobile rows should show the verdict and cause directly');
  });

  await test('LogbookPanel hides breakdown causes when stability has no verdict', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        useLogbookStore().ingestMessage({
          type: 'logbook',
          stats: { total: 1, grades: { Good: 1 }, airports: 1, aircraft: 1 },
          entries: [{
            id: 'no-verdict-breakdown',
            timestamp: '2026-05-21T17:16:50.465Z',
            aircraft: '737-800',
            icao: 'YSCB',
            runway: '35',
            vsFpm: -177,
            grade: 'GOOD',
            stabilityVerdict: 'no_verdict',
            stabilityScore: null,
            gateStable: null,
            stabilityBreakdown: { config_ok: 0, flaps_ok: 0, gear_ok: 0 },
          }],
        });
      },
    );

    assert.doesNotMatch(html, /Configuration 0%|Flaps 0%|Gear 0%/, 'unavailable stability should not show misleading breakdown causes');
  });

  console.log('\n--- simbrief panel ---\n');
  await test('SimbriefTab renders fetched OFP data from the store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'SimbriefTab.vue'),
      ({ useSimbriefStore }) => {
        const simbrief = useSimbriefStore();
        simbrief.bindRuntime({
          httpBase: 'http://127.0.0.1:8100',
        });
        simbrief.plan = {
          fetchedAt: Date.UTC(2026, 4, 27, 10, 30, 0),
          origin: 'YSSY',
          originName: 'Sydney',
          departureRunway: '34L',
          destination: 'WSSS',
          destinationName: 'Singapore Changi',
          arrivalRunway: '02C',
          alternate: 'WMKK',
          aircraft: 'A388',
          aircraftName: 'Airbus A380-800',
          callsign: 'QFA81',
          flightNumber: '81',
          route: 'YSSY DCT WSSS',
          cruiseAltFl: 'FL360',
          cruiseMach: '0.84',
          eteSeconds: 28800,
          fuelLbs: 248000,
        };
        simbrief.status = 'OFP loaded successfully.';
      },
    );

    assert.match(html, /id="sb-origin"[^>]*>YSSY</, 'origin ICAO should render from store state');
    assert.match(html, /id="sb-dest"[^>]*>WSSS</, 'destination ICAO should render from store state');
    assert.match(html, /id="sb-alt"[^>]*>WMKK</, 'alternate ICAO should render from store state');
    assert.match(html, /id="sb-departure-runway"[^>]*>34L</, 'departure runway should render from store state when available');
    assert.match(html, /id="sb-arrival-runway"[^>]*>02C</, 'arrival runway should render from store state when available');
    assert.match(html, /id="sb-aircraft"[^>]*>A388</, 'aircraft ICAO should render from store state');
    assert.match(html, /id="sb-cruise"[^>]*>FL360 \/ M0\.84</, 'cruise summary should render from store state');
    assert.match(html, /id="sb-ete"[^>]*>8 h 0 min</, 'ETE should render from store state');
    assert.match(html, /id="sb-fuel"[^>]*>248,000 lbs</, 'fuel summary should render from store state');
    assert.match(html, /id="sb-route"[^>]*>YSSY DCT WSSS</, 'route text should render from store state');
  });

  console.log('\n--- aircraft profile controls ---\n');
  await test('aircraft profile file administration component is removed', async () => {
    assert.equal(
      fs.existsSync(path.join(frontendRoot, 'src', 'vue', 'components', 'AircraftProfileAdvancedTools.vue')),
      false,
      'the retired import/copy/delete component should not remain callable',
    );
  });

  await test('AircraftProfileSelector presents automatic correction and manual override state', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftProfileSelector.vue'),
      ({ useAppSettingsStore, useProfilesStore, useStatusStore }) => {
        useAppSettingsStore().apply({
          settings: { aircraft: { profile: 'bundled/msfs/fss-e175' } },
        });
        const profiles = useProfilesStore();
        profiles.setAuthorizationScope('full-control');
        profiles.installedProfiles = [
          {
            id: 'fss-e175',
            name: 'FlightSim Studio Embraer E170/175',
            namespace: 'bundled',
            simulator: 'msfs',
            qualifiedId: 'bundled/msfs/fss-e175',
          },
        ];
        useStatusStore().ingestMessage({
          type: 'aircraftProfile',
          profile: {
            id: 'fss-e175',
            name: 'FlightSim Studio Embraer E170/175',
            aircraftTitle: 'FSS E175',
          },
          provenance: { verificationStatus: 'verified' },
        });
      },
    );

    assert.match(html, /FlightSim Studio Embraer E170\/175 · Manual override · verified profile/, 'header summary should distinguish manual selection from profile verification');
    assert.match(html, /id="aircraft-profile-correction-select"[^>]*>[\s\S]*Automatic detection \(recommended\)/, 'correction selector should keep automatic detection as the recommended option');
    assert.match(html, /<option[^>]*value="bundled\/msfs\/fss-e175"[^>]*>/, 'the current qualified manual override should remain available in the selector');
    assert.doesNotMatch(html, /Advanced profile tools|Local overrides/, 'selector should expose bundled choices without file administration');
  });

  await test('AircraftProfileSelector hides profile selection controls from remote scopes', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftProfileSelector.vue'),
      ({ useProfilesStore, useStatusStore }) => {
        useProfilesStore().setAuthorizationScope('aircraft-control');
        useStatusStore().ingestMessage({
          type: 'aircraftProfile',
          profile: {
            id: 'fbw-a32nx',
            name: 'FlyByWire A32NX',
            aircraftTitle: 'FlyByWire A32NX',
          },
        });
      },
    );

    assert.match(html, /id="aircraft-profile-name"[^>]*>[^<]*Auto match/, 'remote clients should retain the safe active-profile summary');
    assert.doesNotMatch(html, /id="aircraft-profile-correction"/, 'remote clients should not receive profile selection controls');
    assert.doesNotMatch(html, /Wrong aircraft\?/, 'remote clients should not be offered a privileged profile action');
  });

  console.log('\n--- timeline flights panel ---\n');
  await test('TimelineInspectorShell renders timeline controller targets', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'TimelineInspectorShell.vue'));
    const ids = [
      'timeline-flight-id',
      'timeline-flight-route',
      'timeline-events',
      'timeline-empty',
      'timeline-event-list',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for the timeline controller`);
    }

    assert.match(html, /Timeline Inspector/, 'timeline inspector title should render');
    assert.match(html, /Select a saved flight to view timeline/, 'timeline selection fallback should render');
    assert.doesNotMatch(html, /id="timeline-worst-btn"/, 'worst-jump button should not render');
    assert.doesNotMatch(html, /Jump to Worst/, 'worst-jump copy should stay removed from the inspector');
    assert.match(html, /id="timeline-event-list"[^>]*hidden/, 'event list should start hidden');
    assert.match(html, /No timeline loaded/, 'empty state should render');
  });

  await test('TimelineInspectorShell renders store-backed header and event rows', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineInspectorShell.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setLoadedTimelineIdentity({
          aircraft: 'Standard Cabin',
          aircraftProfileId: 'inibuilds-tristar',
        });
        timeline.setInspectorState({
          flightIdText: '2h 0m',
          routeText: 'YSSY-KJFK',
          routeVisible: true,
          selectedRowKey: 'landing-row',
          emptyVisible: false,
          rows: [{
            rowKey: 'landing-row',
            index: 3,
            type: 'marker',
            title: 'Landing at YSSY 34L',
            subtitle: '136 kts - 305ft TDZ',
            timeOffsetText: '00:12',
            showEndpointDateTime: true,
            localDateTimeText: '2026-07-31 14:48',
            utcDateTimeText: '2026-07-31 13:48',
            badges: [{ text: 'OUTSTANDING', toneClass: 'positive' }],
            countText: 'x2',
          }],
        });
      },
    );

    assert.match(html, /id="timeline-flight-id"[^>]*>2h 0m</, 'timeline inspector should render flight duration without repeating the route');
    assert.match(html, /id="timeline-flight-route"[^>]*>YSSY-KJFK</, 'timeline inspector should render the store-backed route text');
    assert.match(html, /data-aircraft-visual-key="lockheed-l1011-500"/, 'timeline inspector should prefer the recorded profile id over an opaque saved aircraft label');
    assert.equal((html.match(/YSSY-KJFK/g) || []).length, 1, 'timeline inspector should render the route only once');
    assert.doesNotMatch(html, /id="timeline-worst-btn"/, 'worst-jump button should stay removed even when a worst row exists');
    assert.match(html, /id="timeline-empty"[^>]*hidden/, 'empty state should hide when event rows are available');
    assert.doesNotMatch(html, /id="timeline-event-list"[^>]*hidden/, 'event list should show when the store exposes rows');
    assert.match(html, /data-row-key="landing-row"/, 'timeline inspector rows should keep stable row-key attributes');
    assert.match(html, /class="timeline-event block w-full appearance-none border-0 bg-transparent text-left[^"]*selected"/, 'timeline inspector should reflect the selected-row class from store state');
    assert.doesNotMatch(html, /worst-moment/, 'timeline inspector should not decorate an inferred worst-moment row');
    assert.match(html, /Landing at YSSY 34L/, 'timeline inspector should render the event title');
    assert.match(html, /136 kts - 305ft TDZ/, 'timeline inspector should render the event subtitle');
    assert.match(html, /LT 2026-07-31 14:48[\s\S]*UTC 2026-07-31 13:48/, 'timeline endpoint dots should render compact simulator-local and UTC timestamps');
    assert.match(html, /OUTSTANDING/, 'timeline inspector should render score badges from store state');
    assert.match(html, /timeline-count-badge[^>]*>x2</, 'timeline inspector should render repeat-count badges from store state');
  });

  await test('TimelineDetailPanel renders selected-event data in a dedicated inspector drawer', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineDetailPanel.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setDetail({
          visible: true,
          type: 'Landing',
          title: 'Landing at YSSY 34L',
          metricSections: [
            {
              key: 'landing-snapshot',
              title: 'Landing Snapshot',
              rows: [
                { key: 'touchdown-grade', label: 'Touchdown Rate Grade', value: 'FIRM' },
                { key: 'approach-verdict', label: 'Approach', value: 'STABLE' },
                { key: 'bounce', label: 'Bounce', value: 'CLEAN' },
                { key: 'ias', label: 'IAS', value: '136 kts' },
                { key: 'vs', label: 'V/S', value: '-467 fpm', valueClass: 'text-red-400 font-mono' },
              ],
              noteText: 'Touchdown stayed inside the touchdown zone.',
              emptyText: '',
            },
            {
              key: 'touchdown-zone-analysis',
              title: 'Touchdown Zone Analysis',
              rows: [
                { key: 'distance', label: 'Distance', value: '305ft from threshold' },
                { key: 'grade', label: 'TDZ Grade', value: 'Outstanding' },
              ],
              noteText: '',
              emptyText: '',
            },
          ],
          approachProfileHtml: '<svg viewBox=\"0 0 10 10\"><path d=\"M0 10 L10 0\" /></svg>',
          topdownProfileHtml: '<svg viewBox=\"0 0 10 10\"><circle cx=\"5\" cy=\"5\" r=\"2\" /></svg>',
          landingActionVisible: true,
        });
      },
    );

    assert.match(html, /id="timeline-detail-type"[^>]*>Landing</, 'detail type should render from store state');
    assert.match(html, /id="timeline-detail-title"[^>]*>Landing at YSSY 34L</, 'detail title should render from store state');
    assert.match(html, /Touchdown Rate Grade[\s\S]*FIRM/, 'compact landing detail should retain the touchdown-rate grade');
    assert.match(html, /Touchdown Rate[\s\S]*-467 fpm/, 'compact landing detail should retain the touchdown rate');
    assert.match(html, /TDZ[\s\S]*305ft from threshold \/ Outstanding/, 'compact landing detail should combine TDZ distance and quality');
    assert.match(html, /Approach[\s\S]*STABLE[\s\S]*Bounce[\s\S]*CLEAN/, 'compact landing detail should retain approach and bounce essentials');
    assert.doesNotMatch(html, /136 kts|Landing Snapshot|Touchdown Zone Analysis|Touchdown stayed inside/, 'compact landing detail should omit duplicate secondary information');
    assert.doesNotMatch(html, /id="timeline-approach-profile"|id="timeline-topdown-profile"/, 'landing profile images should be reserved for the debrief modal');
    assert.match(html, /id="timeline-open-landing-btn"[^>]*>\s*Open Landing Debrief\s*</, 'landing detail action should remain available');
    assert.match(html, /id="timeline-detail"[^>]*timeline-detail-drawer/, 'event details should render in the out-of-flow inspector drawer');
    assert.match(html, /id="timeline-detail-close"[^>]*>\s*Close\s*</, 'event details should provide a dedicated close action');
    assert.match(html, /id="timeline-detail-content"[^>]*timeline-detail-drawer-content/, 'large event payloads should own a separate scrolling surface');
    assert.doesNotMatch(html, /id="timeline-detail-score"/, 'detail panel should not render the unused score-impact side block');
  });

  await test('TimelineSummaryBar keeps scoring controls compact and out of the event-list flow', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineSummaryBar.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.bindRequestActions({ onRequestTimeline: () => true });
        timeline.setLoadedTimelineIdentity({
          filePath: 'C:/Flights/F-preview.csv',
          flightId: 'F-preview',
          analysisRescore: {
            applied: true,
            revision: 3,
            appliedAt: '2026-08-08T00:00:00.000Z',
            snapshotFingerprint: 'saved-snapshot-3',
          },
        });
        timeline.setSummary({
          visible: true,
          eventCountText: '42',
          violationCountText: '1',
          durationText: '1h 20m',
          distanceText: '500 NM',
        });
      },
    );

    assert.match(html, /id="timeline-open-analysis-rescore-btn"/, 'summary should expose one compact scoring-review launcher');
    assert.match(html, /Scoring saved/, 'saved analysis state should remain visible without expanding the Timeline column');
    assert.match(html, /aria-haspopup="dialog"/, 'scoring review launcher should identify its modal behavior');
    assert.doesNotMatch(html, /id="timeline-analysis-rescore-content"|id="timeline-analysis-rescore-preview-result"/, 'scoring results must not render inline below the event list');
  });

  await test('TimelineAnalysisRescoreModal owns the complete preview, save, and restore flow', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineAnalysisRescoreModal.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.bindRequestActions({ onRequestTimeline: () => true });
        timeline.setLoadedTimelineIdentity({
          filePath: 'C:/Flights/F-preview.csv',
          flightId: 'F-preview',
          route: 'EGLL-LFPG',
          analysisRescore: {
            applied: true,
            revision: 3,
            appliedAt: '2026-08-08T00:00:00.000Z',
            snapshotFingerprint: 'saved-snapshot-3',
          },
        });
        timeline.openAnalysisRescoreModal();
        timeline.analysisRescorePreviewStatus = 'ready';
        timeline.analysisRescorePreview = {
          available: true,
          previewFingerprint: 'preview-fingerprint',
          baseRevision: 3,
          sourceFingerprint: 'source-fingerprint',
          analysisContractFingerprint: 'contract-fingerprint',
          changedMetricCount: 2,
          landingCount: 1,
          groups: [{
            key: '42',
            label: 'Landing at LFPG 26L',
            available: true,
            reason: null,
            metrics: [
              { key: 'touchdown-rate', label: 'Touchdown rate', recorded: 'GOOD', current: 'FIRM', changed: true },
              { key: 'stability', label: 'Approach stability', recorded: 'Stable 86%', current: 'Unstable 72%', changed: true },
              { key: 'bounce', label: 'Bounce', recorded: 'Clean', current: 'Clean', changed: false },
            ],
          }],
          reason: null,
        };
      },
    );

    assert.match(html, /id="timeline-analysis-rescore-modal"[^>]*role="dialog"/, 'flight-level scoring should render in a dedicated modal');
    assert.match(html, /id="timeline-analysis-rescore-close"[^>]*>\s*Close\s*</, 'scoring modal should provide a dedicated close action');
    assert.match(html, /id="timeline-analysis-rescore-content"[^>]*timeline-analysis-modal-content/, 'large scoring comparisons should own a separate scrolling surface');
    assert.match(html, /id="timeline-preview-analysis-rescore-btn"[^>]*>\s*Review current scoring\s*</);
    assert.match(html, /touchdown rate, approach stability, TDZ, lateral offset, bounce, and rollout scoring/);
    assert.match(html, /original recording and recorded results remain unchanged/i);
    assert.match(html, /id="timeline-analysis-rescore-applied-status"[\s\S]*Saved/);
    assert.match(html, /id="timeline-analysis-rescore-preview-result"[\s\S]*2 scoring results change across 1 landing/);
    assert.match(html, /Landing at LFPG 26L[\s\S]*Touchdown rate[\s\S]*GOOD[\s\S]*FIRM/);
    assert.match(html, /Approach stability[\s\S]*Stable 86%[\s\S]*Unstable 72%/);
    assert.match(html, /id="timeline-apply-analysis-rescore-btn"[^>]*>\s*Save all current scoring\s*</);
    assert.match(html, /id="timeline-revert-analysis-rescore-btn"[^>]*>\s*Restore all recorded scoring\s*</);
    assert.doesNotMatch(html, /Save current grade|Restore recorded grade|touchdown-rate rules/, 'no selected-metric mutation controls should remain');
  });

  await test('TimelineTabShell renders the timeline viewer as a mobile fullscreen modal', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineTabShell.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setLoadedTimelineIdentity({
          flightId: 'F1',
          route: 'YSSY-KJFK',
          aircraft: 'Standard Cabin',
          aircraftProfileId: 'inibuilds-tristar',
          startTime: '2026-08-14T07:05:00',
          simDateTimeLocal: '2026-08-13T19:24:36',
          simDateTimeUtc: '2026-08-13T09:24:36Z',
        });
        timeline.openTimelineMobileViewer();
        timeline.setInspectorState({
          flightIdText: 'YSSY-KJFK (12m)',
          routeText: 'YSSY-KJFK',
          routeVisible: true,
          rows: [{
            rowKey: 'landing-row',
            index: 0,
            type: 'landing',
            event: { type: 'landing' },
            title: 'Landing',
            subtitle: 'Touchdown',
            badges: [],
            countText: '',
          }],
          emptyVisible: false,
        });
        timeline.setSummary({
          visible: true,
          eventCountText: '2',
          violationCountText: '0',
          durationText: '12m',
          distanceText: '144 NM',
          fuelBurnText: '--',
          fuelBurnClass: 'font-semibold text-gray-500',
          scoreImpactText: '0',
          scoreImpactClass: 'font-semibold text-gray-400',
        });
        timeline.setDetail({
          visible: true,
          type: 'Landing',
          title: 'Landing at YSSY 34L',
          metricSections: [{
            key: 'landing-snapshot',
            title: 'Landing Snapshot',
            rows: [{ key: 'ias', label: 'IAS', value: '136 kts' }],
            noteText: '',
            emptyText: '',
          }],
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.match(html, /class="timeline-split timeline-mobile-viewer-open"/, 'timeline viewer should carry the fullscreen mobile-open class');
    assert.match(html, /id="timeline-mobile-viewer-header"/, 'mobile timeline viewer should render a fullscreen header');
    assert.match(html, /id="timeline-mobile-viewer-landing-shortcut"[^>]*>\s*LANDING DEBRIEF\s*</, 'replay header should provide a shortcut to the loaded flight landing');
    assert.match(html, /id="timeline-mobile-viewer-close"[^>]*>\s*Close\s*</, 'mobile timeline viewer should provide a close button');
    assert.match(html, /id="timeline-mobile-viewer-title"[^>]*>YSSY-KJFK</, 'mobile timeline viewer should title itself from the loaded flight');
    assert.match(html, /id="timeline-mobile-viewer-aircraft"[^>]*[\s\S]*?Standard Cabin\s*</, 'mobile timeline viewer should show the saved aircraft type beside the route');
    assert.equal((html.match(/data-aircraft-visual-key="lockheed-l1011-500"/g) || []).length, 2, 'both replay headers should receive the recorded aircraft profile id');
    assert.match(html, /id="timeline-mobile-viewer-local-time"[^>]*[\s\S]*?2026-08-13 19:24\s*</, 'mobile timeline viewer should show the simulator-local flight datetime in international 24-hour format');
    assert.match(html, /id="timeline-mobile-viewer-utc-time"[^>]*[\s\S]*?2026-08-13 09:24\s*</, 'mobile timeline viewer should show the simulator UTC flight datetime in international 24-hour format');
    assert.match(html, /Flight start local[\s\S]*Flight start UTC/, 'the replay header should identify its simulator timestamps as flight-start values');
    assert.match(html, /id="timeline-mobile-viewer-recording-time"[^>]*[\s\S]*?2026-08-14 07:05\s*</, 'mobile timeline viewer should distinguish the device-local recording start from simulator time');
    assert.match(html, /Distance[\s\S]*144 NM/, 'mobile timeline viewer should render whole-flight distance in the summary');
    assert.match(html, /id="timeline-card"/, 'mobile fullscreen viewer should include the inspector card');
    assert.match(html, /id="timeline-map-card"/, 'mobile fullscreen viewer should include the replay map');
    assert.doesNotMatch(html, /id="timeline-detail-score"/, 'mobile fullscreen viewer should omit the unused detail score block');
  });

  await test('TimelineTabShell still shows recording time when an older flight has no simulator clock', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineTabShell.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setLoadedTimelineIdentity({
          flightId: 'LEGACY',
          route: 'EGLL-LFPG',
          startTime: '2026-08-01T01:14:00',
        });
        timeline.openTimelineMobileViewer();
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.match(html, /id="timeline-mobile-viewer-recording-time"[^>]*[\s\S]*?2026-08-01 01:14\s*</, 'legacy timeline headers should retain a minimal recording time fallback');
    assert.doesNotMatch(html, /id="timeline-mobile-viewer-local-time"|id="timeline-mobile-viewer-utc-time"/, 'legacy timeline headers should not invent missing simulator clocks');
  });

  await test('TimelineTabShell shows loading placeholders instead of stale timeline data', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineTabShell.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.openTimelineMobileViewer();
        timeline.setLoadedTimelineIdentity({
          flightId: 'OLD',
          route: 'EGLL-LFPG',
          aircraft: 'Old Airbus A320',
          startTime: '2026-01-03T02:45:00',
          simDateTimeLocal: '2026-01-02T15:30:00',
          simDateTimeUtc: '2026-01-02T14:30:00Z',
        });
        timeline.setInspectorState({
          flightIdText: 'EGLL-LFPG (1h)',
          routeText: 'EGLL-LFPG',
          routeVisible: true,
          rows: [{
            rowKey: 'old-row',
            index: 0,
            type: 'landing',
            title: 'Old landing event',
            subtitle: 'Old touchdown',
            badges: [],
            countText: '',
          }],
          selectedRowKey: 'old-row',
          emptyVisible: false,
        });
        timeline.setSummary({
          visible: true,
          eventCountText: '9',
          violationCountText: '1',
          durationText: '1h',
          distanceText: '144 NM',
          fuelBurnText: '365 kg',
          scoreImpactText: '-1',
        });
        timeline.setDetail({
          visible: true,
          type: 'Landing',
          title: 'Old landing detail',
          metricSections: [{
            key: 'old',
            title: 'Old metrics',
            rows: [{ key: 'old-speed', label: 'IAS', value: '136 kts' }],
          }],
        });
        timeline.beginTimelineLoading({
          flightKey: 'new-flight.csv',
          flightLabel: 'YSSY-KJFK',
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.match(html, /id="timeline-mobile-viewer-title"[^>]*>YSSY-KJFK</, 'viewer title should switch to the loading flight label');
    assert.match(html, /id="timeline-flight-id"[^>]*>Opening timeline\.\.\.</, 'inspector should describe the loading state without repeating the route');
    assert.match(html, /Loading timeline replay\.\.\./, 'timeline viewer should show explicit loading copy');
    assert.match(html, /Preparing YSSY-KJFK/, 'loading placeholder should include the requested flight');
    assert.doesNotMatch(html, /Old landing event/, 'loading viewer should not render stale inspector rows');
    assert.doesNotMatch(html, /Old landing detail/, 'loading viewer should not render stale detail content');
    assert.doesNotMatch(html, /Old Airbus A320/, 'loading viewer should not render the previous flight aircraft');
    assert.doesNotMatch(html, /id="timeline-mobile-viewer-flight-times"/, 'loading viewer should not render stale flight datetimes');
    assert.doesNotMatch(html, /Distance[\s\S]*144 NM/, 'loading viewer should not render the old summary');
  });

  await test('TimelineMapShell renders map, controls, PFD, and scrubber targets', async () => {
    const { html } = await renderComponent(path.join('src', 'vue', 'components', 'TimelineMapShell.vue'));
    const ids = [
      'timeline-map-card',
      'vue-timeline-map-controls-root',
      'map-filter-toggle',
      'timeline-map',
      'timeline-map-empty',
      'vue-timeline-pfd-root',
      'timeline-pfd-overlay',
      'timeline-pfd',
      'pfd-hdg-tape',
      'pfd-spd-tape',
      'pfd-alt-tape',
      'pfd-profile-canvas',
      'timeline-altitude-profile',
      'timeline-altitude-profile-svg',
      'timeline-altitude-profile-empty',
      'timeline-altitude-current',
      'timeline-scrubber-wrap',
      'timeline-time-current',
      'timeline-time-scrubber',
      'timeline-time-start',
      'timeline-time-end',
    ];

    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} should render for timeline map runtime`);
    }

    assert.match(html, /Replay View/, 'timeline map title should render');
    assert.match(html, /No positional event data yet/, 'timeline map empty state should render');
    assert.match(html, /id="timeline-altitude-profile"[^>]*hidden/, 'altitude profile should start hidden');
    assert.match(html, /id="timeline-scrubber-wrap"[^>]*hidden/, 'timeline scrubber should start hidden');
    assert.match(html, /id="timeline-time-scrubber"[^>]*disabled/, 'timeline scrubber input should start disabled');
  });

  await test('TimelineMapShell renders store-backed replay empty-state and scrubber values', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineMapShell.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setMapEmptyState({
          visible: true,
          message: 'Using OpenFreeMap dark basemap',
        });
        timeline.setScrubberState({
          visible: true,
          disabled: false,
          min: '0',
          max: '30000',
          step: '250',
          value: '15000',
          currentLabel: '0:15',
          startLabel: '0:00',
          endLabel: '0:30',
        });
        timeline.setAltitudeProfileState({
          visible: true,
          pathD: 'M 22 70 L 624 12',
          fillD: 'M 22 78 L 22 70 L 624 12 L 624 78 Z',
          cursorVisible: true,
          cursorX: '323',
          cursorY: '41',
          currentText: '2,400 ft',
          rangeText: '1,200 ft - 3,600 ft',
          minText: '1,200 ft',
          maxText: '3,600 ft',
        });
      },
    );

    assert.match(html, /Using OpenFreeMap dark basemap/, 'map empty-state copy should render from the timeline store');
    assert.doesNotMatch(html, /id="timeline-altitude-profile"[^>]*hidden/, 'visible altitude profile state should remove the hidden class');
    assert.match(html, /id="timeline-altitude-profile-path"[^>]*d="M 22 70 L 624 12"/, 'altitude profile path should render from the store');
    assert.match(html, /id="timeline-altitude-profile-cursor"/, 'altitude profile cursor should render from the store');
    assert.match(html, /id="timeline-altitude-current"[^>]*>2,400 ft</, 'altitude profile current altitude should render from the store');
    assert.match(html, /id="timeline-altitude-range"[^>]*>1,200 ft - 3,600 ft</, 'altitude profile range should render from the store');
    assert.doesNotMatch(html, /id="timeline-scrubber-wrap"[^>]*hidden/, 'visible scrubber state should remove the hidden class');
    assert.doesNotMatch(html, /id="timeline-time-scrubber"[^>]*disabled/, 'enabled scrubber state should clear the disabled attribute');
    assert.match(html, /id="timeline-time-current"[^>]*>0:15</, 'current scrubber label should render from the store');
    assert.match(html, /id="timeline-time-end"[^>]*>0:30</, 'end scrubber label should render from the store');
    assert.match(html, /id="timeline-time-scrubber"[^>]*max="30000"/, 'scrubber range max should render from the store');
    assert.match(html, /id="timeline-time-scrubber"[^>]*step="250"/, 'scrubber range step should render from the store');
    assert.match(html, /id="timeline-time-scrubber"[^>]*value="15000"/, 'scrubber range value should render from the store');
  });

  await test('TimelineMapShell renders store-backed PFD overlay readouts and transforms', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineMapShell.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setPfdState({
          scale: '0.625',
          overlayOpacity: '1',
          headingDisplay: '087',
          speedDisplay: '142',
          altitudeDisplay: '3,450',
          pitchDisplay: '3',
          rollDisplay: '-1',
          adiTransform: 'rotate(1deg) translateY(12px)',
          rollPointerTransform: 'translateX(-50%) rotate(-1deg)',
        });
      },
    );

    assert.match(html, /id="timeline-pfd-overlay"[^>]*--pfd-scale:\s*0\.625/, 'PFD overlay scale should render from the timeline store');
    assert.match(html, /id="timeline-pfd"[^>]*opacity:\s*1/, 'PFD overlay opacity should render from the timeline store');
    assert.match(html, /id="pfd-hdg-box"[^>]*>087</, 'PFD heading readout should render from the timeline store');
    assert.match(html, /id="pfd-spd-box"[^>]*>142</, 'PFD speed readout should render from the timeline store');
    assert.match(html, /id="pfd-alt-box"[^>]*>3,450</, 'PFD altitude readout should render from the timeline store');
    assert.match(html, /id="pfd-pitch-val"[^>]*>3</, 'PFD pitch readout should render from the timeline store');
    assert.match(html, /id="pfd-roll-val"[^>]*>-1</, 'PFD roll readout should render from the timeline store');
    assert.match(html, /id="pfd-adi-disc"[^>]*rotate\(1deg\) translateY\(12px\)/, 'PFD ADI transform should render from the timeline store');
    assert.match(html, /id="pfd-roll-ptr"[^>]*translateX\(-50%\) rotate\(-1deg\)/, 'PFD roll pointer transform should render from the timeline store');
  });

  await test('TimelineFlightsPanel renders storage summary and visible flights from the store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineFlightsPanel.vue'),
      ({ useLogbookStore, useStatusStore, useTimelineStore }) => {
        const status = useStatusStore();
        status.updateRecording({
          status: 'recording',
          filePath: 'C:/Flights/active-flight.csv',
        });

        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'historyIndexStatus',
          status: { phase: 'indexing', totalFiles: 120, completedFiles: 30, percent: 25 },
        });

        const timeline = useTimelineStore();
        timeline.ingestMessage({
          type: 'timelineList',
          flights: [
            {
              flightId: 'F2',
              route: 'YSSY-KJFK',
              aircraft: 'A320',
              timestamp: '2026-05-25T10:00:00',
              recordingStartIso: '2026-05-25T09:30:00',
              durationMs: 7200000,
              distanceNm: 143.7,
              fuelBurnGal: 120,
              eventCount: 1440,
              sizeBytes: 8192,
              recordingBundleSizeBytes: 10240,
              latestLandingEvent: {
                id: 'landing-ready',
                type: 'landing',
                grade: 'Good',
                vs_fpm: -210,
              },
            },
            {
              flightId: 'F1',
              route: 'EGLL-LFPG',
              aircraft: 'B738',
              timestamp: '2026-05-24T08:00:00',
              durationMs: 3600000,
              fuelBurnGal: 80,
              eventCount: 720,
              sizeBytes: 4096,
            },
          ],
          storage: { dir: 'C:/Flights', exists: true, fileCount: 2, totalBytes: 12288 },
        });
        timeline.bindDetailActions({
          onOpenSelectedLanding() {
            return true;
          },
        });
        timeline.storagePathCopyLabel = 'Copied!';
        timeline.timelineLoadStatus = 'loading';
        timeline.timelineLoadingFlightKey = 'F2';
        timeline.timelineLoadingFlightLabel = 'YSSY-KJFK';
      },
    );

    assert.match(html, /Recent Flights/, 'panel title should render');
    assert.match(html, /id="timeline-flights-card"[^>]*class="ff-card[^"]*overflow-hidden/, 'recent flights panel should use rounded app card styling');
    assert.match(html, /id="timeline-page-refresh-btn"/, 'recent flights panel should expose the page-level refresh action');
    assert.match(html, /Flight In Progress/, 'recent flights panel should explain that a recording is still active');
    assert.match(html, /id="history-index-progress"/, 'recent flights should expose first-time index progress');
    assert.match(html, /Indexing 30 of 120 flights/, 'history progress should show bounded file counts');
    assert.match(html, /Refresh saved flights, events, map, and scored landings/, 'refresh helper copy should describe the full refresh scope');
    assert.match(html, /Showing all 2 saved flights/, 'meta summary should reflect loaded flights');
    assert.match(html, /C:\/Flights/, 'storage path should render');
    assert.match(html, /2 CSV files - 12\.0 KB on disk/, 'storage summary should render');
    assert.match(html, /YSSY-KJFK/, 'most recent route should render');
    assert.match(html, /A320/, 'aircraft label should render');
    assert.match(html, /Recorded 2026-05-25 09:30/, 'current flight rows should identify the recording start in international 24-hour format');
    assert.match(html, /Saved 2026-05-24 08:00/, 'legacy flight rows should identify file-time fallback rather than presenting it as flight time');
    assert.match(html, /144 NM/, 'distance flown should render in recent flight rows');
    assert.match(html, /10\.0 KB/, 'recent flight rows should render the complete recording bundle size');
    assert.doesNotMatch(html, /Burn\s+\d/, 'recent flight rows should not promote fuel-burn estimates');
    assert.doesNotMatch(html, /Fuel Burn: High - Low/, 'hidden fuel-burn values should not be offered as a visible sort');
    assert.match(html, /Open the recorded landing card/, 'eligible saved-flight rows should render a direct landing-card action');
    assert.match(html, /Loading timeline/, 'flight list should render timeline loading feedback');
    assert.match(html, /Please wait while YSSY-KJFK opens/, 'timeline loading feedback should include the selected flight label');
    assert.match(html, />Copied!</, 'copy-path button label should render from the timeline store');
  });

  await test('TimelineSummaryBar wraps responsively without horizontal scrolling and omits score impact', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineSummaryBar.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setSummary({
          visible: true,
          eventCountText: '63',
          violationCountText: '7',
          durationText: '1h 2m',
          distanceText: '144 NM',
          fuelBurnText: '365 kg',
          scoreImpactText: '0',
        });
      },
    );

    assert.match(html, /<dl[^>]*timeline-summary-stats[^>]*grid[^>]*>/, 'timeline summary should use the responsive metric grid');
    assert.doesNotMatch(html, /overflow-x-auto|min-w-max|whitespace-nowrap/, 'timeline summary should never require a horizontal scrollbar');
    assert.match(html, /Events<\/dt>[\s\S]*text-sm[^>]*>63<\/dd>/, 'timeline summary values should use the larger readable text treatment');
    assert.match(html, /Fuel burn<\/dt>[\s\S]*365 kg<\/dd>/, 'fuel burn should remain available inline');
    assert.doesNotMatch(html, /Score Impact|scoreImpactText|scoreImpactClass/, 'score impact should be removed from the summary UI');
  });

  console.log(`\n${'-'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
