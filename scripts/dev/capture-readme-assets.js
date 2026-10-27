#!/usr/bin/env node
'use strict';

// Capture the real app components with the existing offline workbench fixture.
// No simulator connection, native desktop cursor or automation overlay is used.
// Review every PNG and GIF frame before publishing. See readme-assets/README.md.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SCENES = ['overview', 'aircraft-controls', 'logbook-timeline', 'landing-debrief'];
const README_DETAILS = new Set(['overview-window', 'presets-window', 'voice-window', 'cockpit-window', 'logbook-window', 'debrief-window']);

function captureDate(value) {
  if (!/^\d{8}$/.test(value || '')) throw new Error('Use an eight-digit capture date: node scripts/dev/capture-readme-assets.js 20260929');
  return value;
}

async function capture({ win, evaluate }) {
  const date = captureDate(process.env.FF_README_CAPTURE_DATE);
  const staging = path.join(ROOT, '.tmp', `readme-assets-${date}`);
  const website = path.join(ROOT, 'site/flightfabric/assets', `app-${date}`);
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(website, { recursive: true });
  const fixtureUrl = new URL(process.env.FF_WORKBENCH_TEST_URL);
  fixtureUrl.search = '?desktop=1&onboarding=1&completed=1&toolbar=1';
  await win.loadURL(fixtureUrl.href);
  for (let n = 0; n < 180 && !await evaluate('return Boolean(window.workbenchTest);'); n++) await wait(50);
  win.setContentSize(1440, 900);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  // The generic fixture deliberately simulates an old backend. Use the current
  // source version for this development preview, without changing product UI.
  await evaluate(`const { useAppSettingsStore } = await import('/frontend/src/vue/stores/app-settings.js');
    useAppSettingsStore().backendVersion = ${JSON.stringify(require('../../package.json').version)};
    workbenchTest.settingsUi.aboutVersion = ${JSON.stringify(require('../../package.json').version)};
    workbenchTest.voice.setBridgeAvailable(true);
    workbenchTest.voice.applyRuntimeInfo({ available: true, enabled: true, pushToTalk: { accelerator: 'Control+Shift+F8', registered: true, controllerEnabled: true } });
    workbenchTest.voice.setState('ready');
    const { useVoiceFirstCommandStore } = await import('/frontend/src/vue/stores/voice-first-command.js');
    useVoiceFirstCommandStore().dismiss();
    const { useLandingStore } = await import('/frontend/src/vue/stores/landing.js');
    const { createLandingController } = await import('/frontend/src/landing/controller.js');
    const controller = createLandingController({
      flightStore: workbenchTest.flight, landingStore: useLandingStore(), tabsStore: workbenchTest.tabs });
    // Use the same recorded-landing action as the app runtime. The basic layout
    // fixture does not bind it because its normal checks do not open debriefs.
    workbenchTest.timeline.bindDetailActions({ onOpenSelectedLanding(event) {
      controller.showTimelineLanding({ ...event, aircraftProfileId: 'pmdg-737',
        gs_kts: 143, bank_deg: 0.6, centerlineDev: 1.2, gforce: 1.12,
        wind_dir_deg: 240, wind_speed_kts: 15, xwind_kts: 14.8,
        runway: { ...event.runway, heading_true_deg: 160, width_ft: 148 },
      }, { openModal: true });
      return true;
    } });
    await workbenchTest.nextTick();`);
  const report = [];
  const framed = [];
  async function save(scene, selector = null, maxHeight = 2000) {
    await evaluate("document.getElementById('voice-first-command-dismiss')?.click(); document.activeElement?.blur(); await document.fonts.ready; await workbenchTest.nextTick();");
    await win.webContents.capturePage();
    await wait(600);
    // The first-command suggestion is scheduled after the first telemetry tick.
    await evaluate("document.getElementById('voice-first-command-dismiss')?.click(); await workbenchTest.nextTick();");
    await win.webContents.capturePage();
    await wait(80);
    const layout = await evaluate(`return {
      tab: workbenchTest.tabs.activeTabId,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
      brokenImages: [...document.images].filter(img => img.getClientRects().length && (!img.complete || !img.naturalWidth)).map(img => img.src),
      firstCommandPrompt: Boolean(document.getElementById('voice-first-command-card')),
    };`);
    if (layout.overflow || layout.brokenImages.length || layout.firstCommandPrompt) throw new Error(`${scene}: invalid capture layout ${JSON.stringify(layout)}`);
    const region = selector ? await evaluate(`const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      const x=Math.max(0,Math.floor(r.left)),y=Math.max(0,Math.floor(r.top));
      return {x,y,width:Math.min(innerWidth-x,Math.ceil(r.width)),height:Math.min(innerHeight-y-32,Math.ceil(r.height),${maxHeight})};`) : null;
    if (region && (region.width < 100 || region.height < 100)) throw new Error(`${scene}: crop is not visible`);
    const image = await win.webContents.capturePage(region || undefined);
    const index = SCENES.indexOf(scene);
    if (index >= 0) {
      fs.writeFileSync(path.join(staging, `${String(index).padStart(2, '0')}.png`), image.toPNG());
      fs.writeFileSync(path.join(ROOT, 'readme-assets', `${scene}-${date}.png`), image.toPNG());
    }
    fs.writeFileSync(path.join(staging, `${scene}.png`), image.toPNG());
    if (selector || scene.startsWith('phone-') || scene === 'tablet-plan') {
      fs.writeFileSync(path.join(website, `${scene}.png`), image.toPNG());
    }
    if (selector || scene.startsWith('phone-')) framed.push({ scene, image, phone: scene.startsWith('phone-') });
    report.push({ scene, ...layout, region, size: image.getSize() });
  }
  await evaluate("await workbenchTest.open('flight'); document.getElementById('vue-main-root').scrollTop = 0;");
  await save('overview');
  await save('overview-window', '#tab-flight', 570);
  await evaluate("await workbenchTest.open('autopilot'); document.getElementById('vue-main-root').scrollTop = 0;");
  await save('aircraft-controls');
  await evaluate("document.querySelector('[data-aircraft-presets-section]').scrollIntoView({block:'start',behavior:'instant'});");
  await save('presets-window', '[data-aircraft-presets-section]', 506);
  await evaluate("document.querySelector('[data-aircraft-view=controls]').click(); await workbenchTest.nextTick(); document.getElementById('pmdg-737-section-mcp').scrollIntoView({block:'start',behavior:'instant'});");
  await save('cockpit-window', '#pmdg-737-section-mcp');
  await evaluate("await workbenchTest.open('timeline'); await workbenchTest.review(); document.getElementById('vue-main-root').scrollTop = 0;");
  await wait(700);
  await evaluate("workbenchTest.timeline.setMapViewMode('3d'); const scrubber = document.getElementById('timeline-time-scrubber'); scrubber.value = Number(scrubber.max) * 0.62; scrubber.dispatchEvent(new Event('input', { bubbles: true })); await workbenchTest.nextTick();");
  await save('logbook-timeline');
  await save('logbook-window', '#tab-timeline');
  const landingReady = await evaluate("const button = document.getElementById('timeline-mobile-viewer-landing-shortcut'); if (!button) return false; button.click(); await workbenchTest.nextTick(); return true;");
  if (!landingReady) throw new Error('The recorded flight has no landing debrief action.');
  await save('landing-debrief');
  await save('debrief-window', '.landing-modal-content', 610);
  win.setContentSize(390, 844);
  await save('phone-debrief');
  await evaluate("document.getElementById('landing-modal-close').click(); await workbenchTest.open('settings'); const {focusVoiceSettings}=await import('/frontend/src/vue/settings-navigation.js'); await focusVoiceSettings(workbenchTest.tabs);");
  win.setContentSize(1440, 1150);
  await evaluate("const {focusVoiceSettings}=await import('/frontend/src/vue/settings-navigation.js'); await focusVoiceSettings(workbenchTest.tabs);");
  await save('voice-settings');
  await save('voice-window', '#settings-voice-control');
  await evaluate("workbenchTest.voice.setVoiceTestState({phase:'complete',transcript:'set heading two seven zero',recognized:true,heardAudio:true,playbackAvailable:true,message:'Phrase recognized. No command was sent.'}); await workbenchTest.nextTick();");
  await save('voice-test');
  await save('voice-test-window', '#settings-voice-control');
  await evaluate(`await workbenchTest.toolbar.refresh(); workbenchTest.toolbar.packageVersion=${JSON.stringify(require('../../package.json').version)}; const {focusSettingsSection}=await import('/frontend/src/vue/settings-navigation.js'); await focusSettingsSection('settings-toolbar-panel');`);
  await save('toolbar-window', '#settings-toolbar-panel');
  await evaluate(`workbenchTest.toolbarFixture.status='installed'; await workbenchTest.toolbar.refresh(); workbenchTest.toolbar.packageVersion=${JSON.stringify(require('../../package.json').version)}; await workbenchTest.nextTick();`);
  await save('toolbar-installed-window', '#settings-toolbar-panel');
  await evaluate("await workbenchTest.open('flight'); workbenchTest.settingsUi.requestIntro(); await workbenchTest.nextTick();");
  win.setContentSize(1440, 900);
  await save('setup');
  await save('setup-window', '.onboarding-dialog');
  // Reload as a browser client so phone captures show the actual remote UI.
  fixtureUrl.search = '';
  await win.loadURL(fixtureUrl.href);
  for (let n = 0; n < 180 && !await evaluate('return Boolean(window.workbenchTest);'); n++) await wait(50);
  await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  win.setContentSize(820, 1180);
  await evaluate("await workbenchTest.open('dispatch'); document.getElementById('vue-main-root').scrollTop=0;");
  await save('tablet-plan');
  win.setContentSize(390, 844);
  await evaluate("await workbenchTest.open('autopilot'); document.getElementById('vue-main-root').scrollTop=0;");
  await evaluate("document.querySelector('[data-aircraft-view=presets]').click(); await workbenchTest.nextTick(); document.querySelector('[data-aircraft-presets-section]').scrollIntoView({block:'start',behavior:'instant'});");
  await save('phone-presets');
  await evaluate("await workbenchTest.open('flight'); document.getElementById('vue-main-root').scrollTop=0;");
  await save('phone-overview');
  await evaluate("await workbenchTest.open('timeline'); await workbenchTest.review(); workbenchTest.timeline.setMapViewMode('3d'); await workbenchTest.nextTick();");
  await wait(700);
  await save('phone-logbook');
  // Frame actual, unretouched crops with a static Windows-style title bar.
  // This is publication artwork only; it does not change the app's own window.
  const logo = `data:image/svg+xml;base64,${fs.readFileSync(path.join(ROOT, 'readme-assets/flightfabric-logo.svg')).toString('base64')}`;
  for (const { scene, image, phone } of framed) {
    const size = image.getSize();
    win.setContentSize(size.width + (phone ? 20 : 0), size.height + (phone ? 48 : 36));
    const html = phone ? `<!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;background:#10151c}.device{position:relative;padding:28px 9px 18px;border:1px solid #46515e;border-radius:34px;background:#050709}
      .speaker{position:absolute;top:12px;left:calc(50% - 28px);width:56px;height:5px;border-radius:4px;background:#303943}
      .home{position:absolute;bottom:7px;left:calc(50% - 48px);width:96px;height:4px;border-radius:3px;background:#717986}
      img{display:block;width:100%;border-radius:22px}</style></head><body><div class="device"><span class="speaker"></span><img src="${image.toDataURL()}"><span class="home"></span></div></body></html>`
      : `<!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;background:#10151c;color:#e5e7eb;font:12px 'Segoe UI',sans-serif}
      header{height:36px;background:#1b2028;border-bottom:1px solid #343c49;display:flex;align-items:center;padding-left:14px;gap:9px}
      .icon{height:18px;width:18px}svg{margin-left:auto}img{display:block;width:100%}
      </style></head><body><header><img class="icon" src="${logo}">FlightFabric
      <svg width="138" height="36" viewBox="0 0 138 36" fill="none" stroke="#cdd3db" stroke-width="1"><path d="M18 18h10M64 13h10v10H64zM110 13l10 10m0-10l-10 10"/></svg>
      </header><img src="${image.toDataURL()}"></body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await win.webContents.executeJavaScript('Promise.all([...document.images].map(img=>img.decode()))');
    const output = await win.webContents.capturePage();
    fs.writeFileSync(path.join(website, `${scene}.png`), output.toPNG());
    if (README_DETAILS.has(scene)) fs.writeFileSync(path.join(ROOT, 'readme-assets', `${scene}-${date}.png`), output.toPNG());
    report.find(entry => entry.scene === scene).size = output.getSize();
  }
  fs.writeFileSync(path.join(staging, 'capture-report.json'), JSON.stringify({ date, source: 'Current app components; offline sample data', report }, null, 2));
  console.log(`Captured ${report.length} current README and website scenes. Inspect each image before publishing.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, windowsHide: true, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function main() {
  const date = captureDate(process.argv[2]);
  run(process.execPath, ['tests/scripts/test-app-workbench-browser.js'], {
    env: { ...process.env, FF_README_CAPTURE_DATE: date },
  });
  run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-framerate', '1/4',
    '-i', path.join(ROOT, '.tmp', `readme-assets-${date}`, '%02d.png'),
    '-filter_complex', 'scale=1080:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', path.join(ROOT, 'readme-assets', 'flight-fabric-tour.gif')]);
  console.log('Rebuilt flight-fabric-tour.gif: four scenes, four seconds each, continuous loop.');
}

module.exports = { capture };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
