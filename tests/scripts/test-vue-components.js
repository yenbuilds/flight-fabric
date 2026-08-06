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
  ] = await Promise.all([
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-form.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-ui.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'settings-editor.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'tabs.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'live-map.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'app-settings.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'aircraft-controls.js')),
    import(toFrontendUrl('src', 'vue', 'stores', 'aircraft-specific.js')),
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

  await test('Timeline replay modal reserves useful mobile space for map and events', async () => {
    const css = fs.readFileSync(path.join(frontendRoot, 'index.css'), 'utf8');

    assert.match(
      css,
      /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.timeline-split\.timeline-mobile-viewer-open\s*\{[\s\S]*?grid-template-rows:\s*auto\s+minmax\(18rem,\s*48dvh\)\s+minmax\(0,\s*1fr\);/,
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
    assert.match(html, /Turn this off to avoid third-party map tile traffic/, 'online map tile help should describe third-party tile traffic');
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
          localOverrideUpdateStatus: 'changed',
        }];
      },
    );

    assert.doesNotMatch(html, /data-tab="profiles"/, 'Profiles should not render as a primary workspace tab');
    assert.doesNotMatch(html, /id="profiles-update-badge"/, 'stale local profiles should be reviewed from advanced Settings instead');
  });

  console.log('\n--- main content shell ---\n');
  await test('MainContentShell renders the tab scaffold and embedded Vue panels', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'MainContentShell.vue'),
      ({ useTabsStore }) => {
        const tabs = useTabsStore();
        tabs.setActiveTab('livemap');
      },
    );
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
    assert.match(html, /id="tab-livemap" class="tab-section active"/, 'live map tab should keep the state-driven active marker for pre-runtime paint');
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
    assert.doesNotMatch(html, /id="system-remote-qr"/, 'system tab should not render a stale QR before a phone URL is known');
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
          getSettings: async () => ({ success: true, settingsFile: 'C:\\Users\\Pilot\\settings.json' }),
          getBackendBootstrap: async () => ({
            ok: true,
            body: { aircraftControlToken: 'fixture-aircraft-token' },
          }),
        };

        const store = useSystemHostStore();
        await store.refresh();
      },
    );

    assert.match(html, /id="system-remote-url"[^>]*>\s*http:\/\/192\.168\.1\.42:8100\/remote\?wsPort=9199&amp;aircraftControlToken=fixture-aircraft-token\s*</, 'system tab should render the paired primary phone URL with its custom WebSocket port');
    assert.match(html, /id="system-mobile-pairing-note"[^>]*>[\s\S]*Session-paired link/, 'system tab should label the QR as a private session-paired link');
    assert.match(html, /id="system-alt-ips"[^>]*>\s*Other IPs: 10\.0\.0\.5\s*</, 'system tab should keep alternate IP fallback copy');
    assert.match(html, /id="system-remote-qr"/, 'system tab should render the QR container');
    assert.match(html, /role="img"[^>]*aria-label="QR code for http:\/\/192\.168\.1\.42:8100\/remote\?wsPort=9199&amp;aircraftControlToken=fixture-aircraft-token"/, 'QR should describe the paired encoded URL and custom WebSocket port');
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
      assert.match(html, /This browser is session-paired for aircraft controls/, 'paired phone should describe its actual current control state');
      assert.match(html, /displayed share link and QR code remain read-only/, 'paired phone should distinguish its current state from the share link');
    } finally {
      delete globalThis.location;
      globalThis.fetch = originalFetch;
    }
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
  await test('AutopilotControlsTab renders the controller-owned control targets', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AutopilotControlsTab.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({
          enabled: true,
          reason: 'Ready. Commands are checked against the active profile and provider safety gate.',
        });
        controls.setFeedback({
          actionText: 'Selected altitude 12000',
          routeText: 'Profile override - K:AP_ALT_VAR_SET_ENGLISH - SimConnect',
          profileText: 'bundled/msfs/pmdg-777',
        });
        controls.setCommandPending({ type: 'preset', id: 'gearUp' });
        controls.setCommandPending({ type: 'selector-adjust', mode: 'hdg', action: 'inc10' });
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
    assert.match(html, /id="controls-experimental-badge"[\s\S]*Experimental/, 'control tab should expose a concise experimental badge in the header');
    assert.match(html, /Send supported controls to the simulator\. Availability varies by aircraft\./, 'control tab should explain the experimental surface concisely');
    assert.match(html, /Control Status/, 'status panel should use a functional label instead of repeating the experimental warning');
    assert.doesNotMatch(html, /Experimental Write Controls|Experimental Write Surface/, 'control tab should not repeat experimental write wording');
    assert.match(html, /id="controls-last-action"/, 'last action feedback target should render');
    assert.match(html, /id="controls-last-route"/, 'last route feedback target should render');
    assert.match(html, /id="controls-last-profile"/, 'last profile feedback target should render');
    assert.match(html, /class="controls-status-panel"/, 'control availability and feedback should render in one consolidated status panel');
    assert.equal((html.match(/class="controls-status-item"/g) || []).length, 3, 'consolidated control status panel should render three feedback items');
    assert.match(html, /class="controls-section"/, 'control groups should render in normalized app sections');
    assert.equal((html.match(/controls-command-tooltip-anchor/g) || []).length, 2, 'surface command buttons should render without tooltip anchors');
    assert.match(html, /id="ap-capability-note"[\s\S]*Writes are profile-gated\./, 'autopilot section should render a compact profile capability note');
    assert.doesNotMatch(html, /Profile-gated experimental write path/, 'autopilot header should not repeat experimental write-path wording');
    assert.doesNotMatch(html, /Selector writes use the currently displayed MCP targets/, 'autopilot header should not include implementation-detail copy');
    assert.match(html, /Ready\. Commands are checked against the active profile and provider safety gate\./, 'availability state should render from the store');
    assert.match(html, /Selected altitude 12000/, 'last action state should render from the store');
    assert.match(html, /Profile override - K:AP_ALT_VAR_SET_ENGLISH - SimConnect/, 'resolution state should render from the store');
    assert.match(html, /bundled\/msfs\/pmdg-777/, 'profile state should render from the store');
    assert.match(html, /id="ap-master-btn"[^>]*data-mode="master"|data-mode="master"[^>]*id="ap-master-btn"/, 'AP master should keep its data-mode');
    assert.equal((html.match(/class="[^"]*ap-engage-btn/g) || []).length, 4, 'selector hold buttons should render');
    assert.equal((html.match(/class="[^"]*ap-adj-btn/g) || []).length, 16, 'selector adjustment buttons should render');
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
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'AircraftTabShell.vue'),
    );

    assert.match(html, /data-aircraft-page-mode="generic"/, 'an unmatched aircraft should select the generic control surface');
    assert.match(html, /Flight Controls/, 'the generic control surface should remain available as the fallback');
    assert.match(html, /id="controls-experimental-badge"[\s\S]*Experimental/, 'generic control safety disclosure should remain visible');
    assert.doesNotMatch(html, /id="aircraft-specific-section"/, 'generic mode should not mount the aircraft-specific section');
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
    assert.match(html, /id="aircraft-specific-section"/, 'specific mode should mount the trusted aircraft section');
    assert.match(html, /data-aircraft-template="ifly-737-max-8"/, 'the registered iFly template should render');
    assert.match(html, />stale</, 'transient source health should render inside the selected template');
    assert.doesNotMatch(html, /id="controls-experimental-badge"/, 'specific mode should not mount the generic controls beneath it');
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
    assert.doesNotMatch(html, /id="controls-experimental-badge"/, 'the broad generic control surface must not remain mounted beneath the iFly page');
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
    assert.match(html, /Flight Controls/, 'the fallback control surface should remain usable');
    assert.doesNotMatch(html, /id="aircraft-specific-section"/, 'an unregistered template must not mount a trusted component');
  });

  await test('LastLandingSummary renders the full-report action inside the Vue shell', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LastLandingSummary.vue'),
      ({ useFlightStore }) => {
        const flight = useFlightStore();
        flight.updateLandingPreview({
          final: true,
          vs: -305,
          icao: 'YSSY',
          runway: '34L',
          score: 96,
          ultimateStability: { score: 98 },
        });
      },
    );

    assert.match(html, /id="data-open-landing-btn"/, 'last landing summary should expose the full report action target');
    assert.match(html, /Full Report/, 'last landing summary should render the landing report action label');
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
    assert.equal(resolveAircraftSpecificTemplate('fenix-a32x'), null, 'deferred Fenix integration must not resolve');
    assert.ok(resolveAircraftSpecificTemplate('ifly-737-max-8'), 'registered iFly 737 MAX 8 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('inibuilds-a310'), 'registered Microsoft / iniBuilds A310-300 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('inibuilds-a330'), 'registered iniBuilds A330 family template should resolve');
    assert.equal(resolveAircraftSpecificTemplate('inibuilds-a350'), null, 'deferred iniBuilds A350 integration must not resolve');
    assert.ok(resolveAircraftSpecificTemplate('inibuilds-tristar'), 'registered iniBuilds TriStar template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('microsoft-737-max-8'), 'registered Microsoft 737 MAX 8 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('microsoft-atr-72-600'), 'registered Microsoft ATR 72-600 template should resolve');
    assert.ok(resolveAircraftSpecificTemplate('microsoft-inibuilds-a32x'), 'registered Microsoft / iniBuilds A320neo V2 and A321LR template should resolve');
    assert.equal(resolveAircraftSpecificTemplate('pmdg-737'), null, 'deferred PMDG 737 integration must not resolve');
    assert.equal(resolveAircraftSpecificTemplate('pmdg-777'), null, 'deferred PMDG 777 integration must not resolve');
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

  await test('Microsoft / iniBuilds shared A32x monitoring page routes A320neo V2 and A321LR identities by trusted profile key', async () => {
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

    for (const variant of variants) {
      const { html } = await renderComponent(
        path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'MicrosoftIniBuildsA32xAircraftPanel.vue'),
        () => {},
        {
          props: {
            profileKey: variant.profileKey,
            sourceStatus: 'connected',
            values: {
              'fcu.speedKts': variant.speed,
              'fcu.headingDeg': variant.heading,
              'fcu.altitudeFt': 11000,
              'fcu.verticalSpeedFpm': -650,
              'flightGuidance.navHold': true,
              'systems.engine1N1': 88.6,
            },
          },
        },
      );
      assert.match(html, /data-aircraft-template="microsoft-inibuilds-a32x"/);
      assert.ok(html.includes(variant.expectedTitle), `${variant.expectedTitle} should render`);
      assert.ok(!html.includes(variant.unexpectedTitle), `${variant.unexpectedTitle} should not render`);
      assert.ok(html.includes(`>${variant.speed}<`), 'FCU speed should render');
      assert.match(html, /Flight Control Unit/);
      assert.match(html, /NAV/);
      assert.match(html, /Monitoring only/);
      assert.doesNotMatch(html, /data-aircraft-action=/);
    }
  });

  await test('Microsoft 737 MAX 8 monitoring page renders exact product identity and live fields', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'Microsoft737Max8AircraftPanel.vue'),
      () => {},
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'mcp.speedKts': 145,
            'mcp.headingDeg': 271,
            'mcp.altitudeFt': 12000,
            'mcp.verticalSpeedFpm': -900,
            'afds.lnav': true,
            'systems.engine1N1': 87.4,
          },
        },
      },
    );
    assert.match(html, /data-aircraft-template="microsoft-737-max-8"/);
    assert.match(html, /Microsoft \/ Asobo Studio Boeing 737 MAX 8/);
    assert.match(html, />145</);
    assert.match(html, />271°</);
    assert.match(html, /LNAV/);
    assert.match(html, /data-aircraft-field="lights\.runwayTurnoff"/);
    assert.match(html, /Monitoring only/);
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
        controls.setCommandPending({ type: 'preset', id: 'flapsIncrease' });
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

  await test('iniBuilds A330 template renders its broad monitoring-only MSFS 2024 surface', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsA330AircraftPanel.vue'),
      () => {},
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
            'controls.gearHandleDown': false,
            'controls.gearNosePct': 0,
            'controls.gearLeftPct': 0,
            'controls.gearRightPct': 0,
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
          actionCapabilities: { 'lights.beacon.on': true },
        },
      },
    );

    assert.match(html, /data-aircraft-template="inibuilds-a330"/, 'template should identify its trusted adapter key');
    assert.match(html, /iniBuilds Airbus A330 Family/, 'template should render the family heading');
    assert.match(html, /A330-200, A330-300 and A330-300P2F/, 'included variants should be explicit');
    assert.match(html, /37,000/, 'standard selected-altitude candidate should be formatted');
    assert.match(html, /204\.1/, 'gross weight should be converted from pounds to tonnes');
    assert.match(html, /Monitoring only/, 'write boundary should be prominent');
    assert.doesNotMatch(html, /Behavior Debug|InputEvents|real-system readback/, 'development details should not appear in end-user copy');
    assert.doesNotMatch(html, /data-aircraft-action=/, 'the monitoring-first page must render no aircraft-specific action buttons');
    assert.doesNotMatch(html, /AUTOPILOT |LIGHT |PRESSURIZATION |INI_|MobiFlight|MF\.SimVars/, 'raw routes must remain encapsulated outside Vue');
  });

  await test('iniBuilds A330 renders unavailable numeric telemetry as unknown', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsA330AircraftPanel.vue'),
      () => {},
      { props: { sourceStatus: 'connected', values: {} } },
    );

    assert.match(html, /SPD<\/div>\s*<div[^>]*>--<\/div>/, 'missing FCU speed must not render as zero');
    assert.match(html, /GROSS WEIGHT<\/div>\s*<div[^>]*>-- <span/, 'missing gross weight must not render as zero tonnes');
    assert.match(html, /CAB ALT <span[^>]*>-- ft<\/span>/, 'missing cabin altitude must remain unknown');
  });

  await test('iniBuilds TriStar template renders three-engine monitoring and profile-gated generic commands', async () => {
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
          autopilot: {
            master: true,
            flightDirector: true,
          },
        });
      },
      {
        props: {
          profileKey: 'bundled/msfs/inibuilds-tristar',
          sourceStatus: 'connected',
          values: {
            'flightGuidance.speedValue': 260,
            'flightGuidance.headingDeg': 91,
            'flightGuidance.altitudeFt': 12000,
            'flightGuidance.verticalSpeedFpm': 500,
            'lights.strobe': true,
            'lights.beacon': true,
            'lights.nav': true,
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
        },
      },
    );

    assert.match(html, /data-aircraft-template="inibuilds-tristar"/, 'template should identify its trusted adapter key');
    assert.match(html, /iniBuilds Lockheed L-1011 TriStar/, 'template should render concrete aircraft identity');
    assert.match(html, /data-tristar-engine="2"[\s\S]*TAIL/, 'the center engine should be presented as the tail engine');
    assert.match(html, /data-tristar-engine="3"[\s\S]*73\.6/, 'the live engine deck should include engine three N1');
    assert.match(html, /FLAP DETENT<\/div>[\s\S]*>33<\/div>/, 'flap index four should map to the source-backed 33 detent');
    assert.match(html, /GROSS WEIGHT<\/div>[\s\S]*195\.0/, 'gross weight should be converted from pounds to tonnes');
    assert.match(html, /EPR-rated/, 'the page should disclose that standard N1 is not the primary TriStar thrust reference');
    assert.match(html, /AFCS mode status is unavailable/, 'the AFCS limitation should use concise user-facing language');
    assert.doesNotMatch(html, /SimVar candidates|Monitoring boundaries|Direct Lift Control/, 'implementation details should not appear in end-user copy');
    assert.equal((html.match(/data-tristar-generic-command=/g) || []).length, 12, 'the panel should preserve every generic command that the replaced TriStar control page exposed');
    for (const commandKey of [
      'gearUp',
      'gearDown',
      'flapsDecrease',
      'flapsIncrease',
      'autopilotMasterToggle',
      'flightDirectorToggle',
      'speedHoldToggle',
      'headingHoldToggle',
      'altitudeHoldToggle',
      'verticalSpeedHoldToggle',
      'locToggle',
      'appToggle',
    ]) {
      assert.match(html, new RegExp(`data-tristar-generic-command="${commandKey}"`), `${commandKey} should remain available through the profile-gated generic path`);
    }
    assert.doesNotMatch(html, /data-tristar-generic-command="(?:autothrottleToggle|flcToggle)"/, 'the command strip must not broaden the profile control surface');
    assert.doesNotMatch(html, /aria-pressed=/, 'momentary AFCS commands must not claim an active state');
    assert.doesNotMatch(html, /data-aircraft-action=/, 'the page must not masquerade generic commands as aircraft-specific actions');
    assert.doesNotMatch(html, /TURB ENG|ENG COMBUSTION|AUTOPILOT AIRSPEED|PRESSURIZATION CABIN|INI_|MobiFlight|MF\.SimVars/, 'raw routes must remain encapsulated outside Vue');
  });

  await test('iniBuilds TriStar template keeps unavailable telemetry neutral and fails generic commands closed', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'IniBuildsTriStarAircraftPanel.vue'),
      ({ useAircraftControlsStore }) => {
        const controls = useAircraftControlsStore();
        controls.setAvailability({ enabled: true, reason: 'Ready.' });
        controls.applyControlCapabilities({
          autopilot: {
            master: true,
            flightDirector: false,
            speedHold: false,
            loc: false,
          },
        });
      },
      {
        props: {
          sourceStatus: 'connected',
          values: {
            'flightGuidance.speedValue': 0,
            'controls.flapsIndex': 4,
            'systems.engine3N1': 88.8,
            'systems.grossWeightLbs': 430000,
          },
          unavailable: [
            'flightGuidance.speedValue',
            'controls.flapsIndex',
            'systems.engine3N1',
            'systems.grossWeightLbs',
          ],
        },
      },
    );

    assert.match(html, /SPD<\/div>\s*<div[^>]*>--<\/div>/, 'unavailable selector speed must not render as zero');
    assert.match(html, /FLAP DETENT<\/div>\s*<div[^>]*>--<\/div>/, 'unavailable flap index must not retain a stale detent');
    assert.match(html, /data-tristar-engine="3"[\s\S]*N1<\/span>\s*<span[^>]*>--<span/, 'unavailable engine three N1 must remain unknown');
    assert.match(html, /GROSS WEIGHT<\/div>\s*<div[^>]*>-- <span/, 'unavailable gross weight must not retain a stale conversion');
    assert.match(html, /<button(?=[^>]*data-tristar-generic-command="flightDirectorToggle")(?=[^>]*\sdisabled(?:=| |>))[^>]*>/, 'unsupported flight-director writes should fail closed');
    assert.match(html, /<button(?=[^>]*data-tristar-generic-command="speedHoldToggle")(?=[^>]*\sdisabled(?:=| |>))[^>]*>/, 'unsupported selector-hold writes should fail closed');
    assert.match(html, /<button(?=[^>]*data-tristar-generic-command="locToggle")(?=[^>]*\sdisabled(?:=| |>))[^>]*>/, 'unsupported LOC writes should fail closed');
    assert.doesNotMatch(html, /<button(?=[^>]*data-tristar-generic-command="autopilotMasterToggle")(?=[^>]*\sdisabled(?:=| |>))[^>]*>/, 'a supported available AP toggle should remain enabled');
  });

  await test('FlyByWire A32NX template renders broad guarded controls and explicit safety boundaries', async () => {
    const actionCapabilities = Object.fromEntries([
      'lights.strobe.off',
      'lights.strobe.auto',
      'lights.strobe.on',
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
      () => {},
      {
        props: {
          sourceStatus: 'connected',
          values: {
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
    assert.equal(renderedActionIds.length, 230, 'the page should render every reviewed A32NX action');
    assert.equal(new Set(renderedActionIds).size, 230, 'every rendered A32NX action ID should be unique');
    assert.match(html, /12,000/, 'authoritative FCU altitude should be formatted');
    assert.match(html, /data-aircraft-action="lights\.strobe\.auto"[^>]*aria-pressed="true"/, 'strobe readback should select AUTO');
    assert.doesNotMatch(html, /data-aircraft-action="lights\.strobe\.on"[^>]*disabled/, 'supported controls with readback should be enabled');
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
    assert.match(html, /Landing, nose and runway turnoff lights are read-only/, 'read-only exterior lights should be clear');
    assert.match(html, /A32NX updates can affect compatibility/, 'the compatibility warning should remain concise and user-facing');
    assert.doesNotMatch(html, /adapter-owned|documentation-backed|logical readback|indexed wiper circuits/, 'implementation details should not appear in end-user copy');
    assert.doesNotMatch(html, /A32NX_|LIGHTING_|XMLVAR_|MF\.SimVars|MobiFlight/, 'raw aircraft routes must remain encapsulated outside the Vue contract');
  });

  await test('FlyByWire A32NX write controls fail closed without matching readback and capability', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'aircraft-specific', 'templates', 'FbwA32nxAircraftPanel.vue'),
      () => {},
      {
        props: {
          sourceStatus: 'connected',
          values: {},
          actionCapabilities: { 'lights.strobe.on': true },
        },
      },
    );

    assert.match(html, /data-aircraft-action="lights\.strobe\.on"[^>]*disabled/, 'capability alone must not bypass missing live readback');
    assert.match(html, /data-aircraft-action="systems\.apuMaster\.on"[^>]*disabled/, 'missing capability and readback should disable system controls');
    assert.match(html, /Current aircraft state unavailable\./, 'the fail-closed state should be explained plainly');
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
          ultimateStability: { score: 91 },
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

    assert.match(html, /id="landing-grade"[^>]*>OUTSTANDING</, 'landing grade should render from store state');
    assert.match(html, /id="landing-grade-breakdown"[^>]*>Touchdown: Firm - Distance: Outstanding</, 'landing grade breakdown should render from store state');
    assert.match(html, /id="landing-gforce"[^>]*>G: 1\.23</, 'landing gforce should render from store state');
    assert.match(html, /id="landing-vs"[^>]*>-467</, 'landing vertical speed should render from store state');
    assert.match(html, /id="landing-airport"[^>]*>YSSY</, 'landing airport should render from store state');
    assert.match(html, /id="landing-runway"[^>]*>RWY 34L</, 'landing runway should render from store state');
    assert.match(html, /id="landing-tdz-value"[^>]*>305 ft</, 'landing touchdown distance should render from store state');
    assert.match(html, /1,000 ft target/, 'landing card should label the ideal target separately from the formal TDZ');
    assert.match(html, /id="landing-tdz-achieved"[^>]*>YES</, 'landing first-1,000-ft target should render from store state');
    assert.match(html, /id="landing-stability-score"[^>]*>91</, 'landing stability score should render from store state');
    assert.match(html, /id="landing-ias"[^>]*>136 kt</, 'landing IAS should render from store state');
    assert.match(html, /id="landing-gs"[^>]*>GS: 142</, 'landing GS should render from store state');
    assert.match(html, /id="landing-crosswind"[^>]*>8 kt L</, 'landing crosswind should render from store state');
    assert.match(html, /id="landing-wind-total"[^>]*>From left - 12 kt total</, 'landing wind summary should render from store state');
    assert.match(html, /id="landing-approach-type"[^>]*>ILS</, 'landing approach type should render from store state');
    assert.match(html, /id="landing-pitch"[^>]*>\+3\.1 deg</, 'landing pitch should render from store state');
    assert.match(html, /id="landing-bank"[^>]*>1\.4 deg L</, 'landing bank should render from store state');
    assert.match(html, /id="landing-centerline"[^>]*>ALIGNED</, 'landing runway alignment should render from store state');
    assert.match(html, /id="landing-upset-count"[^>]*>2</, 'landing upset count should render from store state');
    assert.match(html, /id="landing-debrief-factors"/, 'landing debrief factors section should render');
    assert.match(html, /id="landing-debrief-reasons"[\s\S]*Firm touchdown[\s\S]*Stabilized approach/, 'landing debrief reasons should render from store state');
    assert.match(html, /id="landing-data-confidence"[^>]*>\s*High\s*</, 'landing data confidence should render from store state');
    assert.match(html, /id="landing-rollout-analysis"(?![^>]*hidden)/, 'separate rollout analysis should be visible');
    assert.match(html, /id="landing-rollout-assessment"[^>]*>CAUTION</, 'rollout assessment should render from store state');
    assert.match(html, /id="landing-rollout-metrics"[\s\S]*Peak bank[\s\S]*3\.3 deg[\s\S]*Heading deviation[\s\S]*14\.6 deg right/, 'rollout metrics should render independently of touchdown attitude');
    assert.match(html, /Conservative edge margin[\s\S]*27 ft/, 'rollout metrics should render the uncertainty-adjusted runway-edge margin');
    assert.match(html, /id="landing-inflight-stats"[\s\S]*Max Alt[\s\S]*12,000 ft[\s\S]*Possible Go-Arounds[\s\S]*1/, 'in-flight stat rows should render from store state');
    assert.match(html, /id="landing-inflight-violations"[\s\S]*Overspeed[\s\S]*2x[\s\S]*Bank Angle[\s\S]*warning - 4s/, 'in-flight violation rows should render from store state');
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
      ({ useLandingStore }) => {
        const landing = useLandingStore();
        landing.applyLandingCardMessage({
          final: true,
          icao: 'LFPB',
          runway: '07',
          vs: -210,
          grade: 'Good',
        });
        landing.openLandingModal({ loading: false });
      },
    );

    assert.match(html, /id="landing-modal"/, 'landing debrief modal should render when store state opens it');
    assert.match(html, /Landing Debrief/, 'landing debrief modal should render its title');
    assert.match(html, /LFPB[\s\S]*07/, 'landing debrief modal should render the selected landing airport and runway');
    assert.match(html, /id="landing-card"/, 'landing debrief modal should embed the landing panel content');

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
              gateStable: false,
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
    assert.match(html, /Best -467 fpm/, 'best landing text should render');
    assert.match(html, />2<\/div>/, 'airport count should render');
    assert.match(html, />0<\/div>/, 'aircraft count should render');
    assert.match(html, /1<\/span><span style="color:\s*#facc15;?">Firm/, 'firm count should reflect outcome grades, not only sink-rate grades');
    assert.match(html, /1<\/span><span style="color:\s*#f97316;?">Hard/, 'hard count should render');
    assert.match(html, /Long TDZ[\s\S]*>1<\/div>/, 'long touchdown-zone count should render');
    assert.match(html, /1<\/span><span style="color:\s*#f97316;?">Long/, 'long landing outcome count should render');
    assert.match(html, /3862 ft/, 'touchdown distance should render in the scored landings table');
    assert.match(html, /Long Landing/, 'touchdown distance grade should render in the scored landings table');
    assert.match(html, />LONG<\/span>/, 'outcome grade should promote long landings above the V/S grade');
    assert.match(html, /1<\/span><span style="color:\s*#ef4444;?">Excursion/, 'runway excursion count should render');
    assert.match(html, /id="logbook-trends"[\s\S]*Recent Trends[\s\S]*Aircraft[\s\S]*PMDG 777[\s\S]*VS improving/, 'aircraft trend rows should render');
    assert.match(html, /id="logbook-trends"[\s\S]*Airports[\s\S]*YSSY[\s\S]*100% stable/, 'airport trend rows should render');
    assert.match(html, /LFPG 27R[\s\S]*0% stable/, 'trend rows without a VS comparison should still show stability rate');
    assert.doesNotMatch(html, /VS\s*--/, 'trend rows without a VS comparison should not render a broken-looking VS placeholder');
    assert.match(html, /YPAD[^<]*<span[^>]*>23<\/span>/, 'numeric runway identifier should render as text');
    assert.match(html, /RUNWAY EXCURSION/, 'runway excursion grade should render as a first-class logbook row');
    assert.match(html, />UNST<\/span>/, 'unstable gate label should render');
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
            outcomeGrades: { Good: 1 },
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

  await test('LogbookPanel grade counts fall back to visible entries when aggregate outcome stats are partial', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'logbook',
          stats: {
            total: 20,
            outcomeGrades: { Good: 1 },
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
    assert.match(html, /1<\/span><span style="color:\s*#38bdf8;?">Good/, 'visible GOOD row should count as Good');
    assert.match(html, /1<\/span><span style="color:\s*#facc15;?">Firm/, 'visible Acceptable row should count in the Firm bucket');
    assert.match(html, /1<\/span><span style="color:\s*#f97316;?">Long/, 'visible Long Landing row should count in the Long bucket');
    assert.match(html, /17<\/span><span style="color:\s*#94a3b8;?">Other/, 'uncategorized aggregate remainder should be visible as Other');
    assert.match(html, />\s*ACCEPTABLE\s*<\/span>/, 'title-case touchdown outcomes should render as uppercase grade labels');
    assert.doesNotMatch(html, /rounded"[^>]*>\s*Acceptable\s*<\/span>/, 'grade pills should not leak title-case outcome labels');
    assert.match(html, /style="[^"]*background:\s*(?!transparent)[^;]+;[^"]*border:\s*1px solid (?!transparent)[^;"]+;?[^"]*"[^>]*>\s*<span>1835 ft/, 'good TDZ rows should use the same boxed badge shell as other TDZ outcomes');
    assert.doesNotMatch(html, /background:\s*transparent;\s*border:\s*1px solid transparent/, 'TDZ badges should not mix boxed and unboxed styling');
    assert.match(html, /background:\s*#38bdf8;[^"]*min-height:\s*2\.5rem/, 'GOOD rows should render a visible cyan left accent strip');
  });

  await test('LogbookPanel uppercases every touchdown-derived outcome grade label', async () => {
    const touchdownGrades = [
      'Outstanding',
      'Good',
      'Acceptable',
      'Marginal',
      'Poor',
      'Dangerous',
      'Short Landing',
    ];
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'logbook',
          stats: { total: touchdownGrades.length },
          entries: touchdownGrades.map((touchdownDistanceGrade, index) => ({
            id: `touchdown-grade-${index}`,
            timestamp: `2026-05-${String(index + 1).padStart(2, '0')}T17:16:50.465Z`,
            vsFpm: null,
            grade: null,
            touchdownDistanceGrade,
            gateStable: null,
          })),
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    for (const grade of touchdownGrades) {
      const label = grade.toUpperCase();
      assert.match(html, new RegExp(`rounded"[^>]*>\\s*${label}\\s*<\\/span>`), `${grade} should render as ${label}`);
    }
  });

  await test('LogbookPanel distinguishes minor gate issues from unstable finals', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'LogbookPanel.vue'),
      ({ useLogbookStore }) => {
        const logbook = useLogbookStore();
        logbook.ingestMessage({
          type: 'logbook',
          stats: {
            total: 3,
            outcomeGrades: { Good: 3 },
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
              stabilityScore: 91,
              stabilityGateFailures: [
                'speed_proxy_unstable_after_gate',
                'speed_trend_unstable_after_gate',
              ],
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
          ],
        });
      },
      {
        matchMedia: () => ({ matches: true }),
      },
    );

    assert.strictEqual(
      (html.match(/>1 ISSUE<\/span>/g) || []).length,
      2,
      'related speed and path-rate failures should each collapse to one issue family',
    );
    assert.doesNotMatch(html, />2 ISSUES<\/span>/, 'related speed failures must not be double-counted');
    assert.match(html, />UNST<\/span>/, 'major config gate failure should still render as unstable');
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
        timeline.setInspectorState({
          flightIdText: 'YSSY-KJFK (2h 0m)',
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
            badges: [{ text: 'OUTSTANDING', toneClass: 'positive' }],
            countText: 'x2',
          }],
        });
      },
    );

    assert.match(html, /id="timeline-flight-id"[^>]*>YSSY-KJFK \(2h 0m\)</, 'timeline inspector should render the store-backed header text');
    assert.match(html, /id="timeline-flight-route"[^>]*>YSSY-KJFK</, 'timeline inspector should render the store-backed route text');
    assert.doesNotMatch(html, /id="timeline-worst-btn"/, 'worst-jump button should stay removed even when a worst row exists');
    assert.match(html, /id="timeline-empty"[^>]*hidden/, 'empty state should hide when event rows are available');
    assert.doesNotMatch(html, /id="timeline-event-list"[^>]*hidden/, 'event list should show when the store exposes rows');
    assert.match(html, /data-row-key="landing-row"/, 'timeline inspector rows should keep stable row-key attributes');
    assert.match(html, /class="timeline-event block w-full appearance-none border-0 bg-transparent text-left[^"]*selected"/, 'timeline inspector should reflect the selected-row class from store state');
    assert.doesNotMatch(html, /worst-moment/, 'timeline inspector should not decorate an inferred worst-moment row');
    assert.match(html, /Landing at YSSY 34L/, 'timeline inspector should render the event title');
    assert.match(html, /136 kts - 305ft TDZ/, 'timeline inspector should render the event subtitle');
    assert.match(html, /OUTSTANDING/, 'timeline inspector should render score badges from store state');
    assert.match(html, /timeline-count-badge[^>]*>x2</, 'timeline inspector should render repeat-count badges from store state');
  });

  await test('TimelineDetailPanel renders structured detail sections from the store', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineDetailPanel.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setDetail({
          visible: true,
          type: 'Landing',
          title: 'Landing at YSSY 34L',
          metricSections: [{
            key: 'landing-snapshot',
            title: 'Landing Snapshot',
            rows: [
              { key: 'ias', label: 'IAS', value: '136 kts' },
              { key: 'vs', label: 'V/S', value: '-467 fpm', valueClass: 'text-red-400 font-mono' },
            ],
            noteText: 'Touchdown stayed inside the touchdown zone.',
            emptyText: '',
          }],
          approachProfileHtml: '<svg viewBox=\"0 0 10 10\"><path d=\"M0 10 L10 0\" /></svg>',
          topdownProfileHtml: '<svg viewBox=\"0 0 10 10\"><circle cx=\"5\" cy=\"5\" r=\"2\" /></svg>',
          landingActionVisible: true,
        });
      },
    );

    assert.match(html, /id="timeline-detail-type"[^>]*>Landing</, 'detail type should render from store state');
    assert.match(html, /id="timeline-detail-title"[^>]*>Landing at YSSY 34L</, 'detail title should render from store state');
    assert.match(html, /Landing Snapshot/, 'detail sections should render their headings');
    assert.match(html, /IAS:[\s\S]*136 kts/, 'detail sections should render structured metric rows');
    assert.match(html, /V\/S:[\s\S]*-467 fpm/, 'detail rows should render custom value styling and text');
    assert.match(html, /Touchdown stayed inside the touchdown zone\./, 'detail note text should render from store state');
    assert.match(html, /id="timeline-approach-profile"[\s\S]*<svg/, 'detail panel should continue rendering generated approach-profile SVG');
    assert.match(html, /id="timeline-topdown-profile"[\s\S]*<svg[\s\S]*<circle/, 'detail panel should render generated top-down profile SVG');
    assert.match(html, /id="timeline-open-landing-btn"[^>]*>\s*Open Landing Debrief\s*</, 'landing detail action should remain available');
    assert.doesNotMatch(html, /id="timeline-detail-score"/, 'detail panel should not render the unused score-impact side block');
  });

  await test('TimelineTabShell renders the timeline viewer as a mobile fullscreen modal', async () => {
    const { html } = await renderComponent(
      path.join('src', 'vue', 'components', 'TimelineTabShell.vue'),
      ({ useTimelineStore }) => {
        const timeline = useTimelineStore();
        timeline.setLoadedTimelineIdentity({
          flightId: 'F1',
          route: 'YSSY-KJFK',
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
    assert.match(html, /id="timeline-mobile-viewer-close"[^>]*>\s*Close\s*</, 'mobile timeline viewer should provide a close button');
    assert.match(html, /id="timeline-mobile-viewer-title"[^>]*>YSSY-KJFK</, 'mobile timeline viewer should title itself from the loaded flight');
    assert.match(html, /Distance[\s\S]*144 NM/, 'mobile timeline viewer should render whole-flight distance in the summary');
    assert.match(html, /id="timeline-card"/, 'mobile fullscreen viewer should include the inspector card');
    assert.match(html, /id="timeline-map-card"/, 'mobile fullscreen viewer should include the replay map');
    assert.doesNotMatch(html, /id="timeline-detail-score"/, 'mobile fullscreen viewer should omit the unused detail score block');
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
    assert.match(html, /id="timeline-flight-id"[^>]*>Opening YSSY-KJFK</, 'inspector should name the loading flight');
    assert.match(html, /Loading timeline replay\.\.\./, 'timeline viewer should show explicit loading copy');
    assert.match(html, /Preparing YSSY-KJFK/, 'loading placeholder should include the requested flight');
    assert.doesNotMatch(html, /Old landing event/, 'loading viewer should not render stale inspector rows');
    assert.doesNotMatch(html, /Old landing detail/, 'loading viewer should not render stale detail content');
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
          message: 'Using CARTO fallback tiles',
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

    assert.match(html, /Using CARTO fallback tiles/, 'map empty-state copy should render from the timeline store');
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
              timestamp: '2026-05-25T10:00:00Z',
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
              timestamp: '2026-05-24T08:00:00Z',
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
    assert.match(html, /144 NM/, 'distance flown should render in recent flight rows');
    assert.match(html, /10\.0 KB/, 'recent flight rows should render the complete recording bundle size');
    assert.doesNotMatch(html, /Burn\s+\d/, 'recent flight rows should not promote fuel-burn estimates');
    assert.doesNotMatch(html, /Fuel Burn: High - Low/, 'hidden fuel-burn values should not be offered as a visible sort');
    assert.match(html, /Open the recorded landing card/, 'eligible saved-flight rows should render a direct landing-card action');
    assert.match(html, /Loading timeline/, 'flight list should render timeline loading feedback');
    assert.match(html, /Please wait while YSSY-KJFK opens/, 'timeline loading feedback should include the selected flight label');
    assert.match(html, />Copied!</, 'copy-path button label should render from the timeline store');
  });

  await test('TimelineSummaryBar keeps fuel burn as secondary modal detail', async () => {
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

    assert.match(html, /Estimated fuel burn:\s*<span[^>]*>365 kg<\/span>/, 'timeline modal should still expose fuel burn quietly');
    assert.doesNotMatch(html, /uppercase tracking-wider[^>]*>Fuel Burn</, 'fuel burn should not be a headline summary metric');
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
