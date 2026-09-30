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

function captureDate(value) {
  if (!/^\d{8}$/.test(value || '')) throw new Error('Use an eight-digit capture date: node scripts/dev/capture-readme-assets.js 20260929');
  return value;
}

async function capture({ win, evaluate }) {
  const date = captureDate(process.env.FF_README_CAPTURE_DATE);
  const staging = path.join(ROOT, '.tmp', `readme-assets-${date}`);
  fs.mkdirSync(staging, { recursive: true });
  win.setContentSize(1440, 900);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  // The generic fixture deliberately simulates an old backend. Use the current
  // source version for this development preview, without changing product UI.
  await evaluate(`const { useAppSettingsStore } = await import('/frontend/src/vue/stores/app-settings.js');
    useAppSettingsStore().backendVersion = ${JSON.stringify(require('../../package.json').version)};
    workbenchTest.voice.setBridgeAvailable(true);
    workbenchTest.voice.applyRuntimeInfo({ available: true, enabled: true, pushToTalk: { accelerator: 'Control+Shift+F8', registered: true } });
    workbenchTest.voice.setState('ready');
    const { useLandingStore } = await import('/frontend/src/vue/stores/landing.js');
    const { createLandingController } = await import('/frontend/src/landing/controller.js');
    const controller = createLandingController({ $: id => document.getElementById(id), windowRef: window,
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
  async function save(scene) {
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
    const image = await win.webContents.capturePage();
    const index = SCENES.indexOf(scene);
    fs.writeFileSync(path.join(staging, `${String(index).padStart(2, '0')}.png`), image.toPNG());
    fs.writeFileSync(path.join(ROOT, 'readme-assets', `${scene}-${date}.png`), image.toPNG());
    report.push({ scene, ...layout, size: image.getSize() });
  }
  await evaluate("await workbenchTest.open('flight'); document.getElementById('vue-main-root').scrollTop = 0;");
  await save('overview');
  await evaluate("await workbenchTest.open('autopilot'); document.getElementById('vue-main-root').scrollTop = 0;");
  await save('aircraft-controls');
  await evaluate("await workbenchTest.open('timeline'); await workbenchTest.review(); document.getElementById('vue-main-root').scrollTop = 0;");
  await wait(700);
  await evaluate("workbenchTest.timeline.setMapViewMode('3d'); const scrubber = document.getElementById('timeline-time-scrubber'); scrubber.value = Number(scrubber.max) * 0.62; scrubber.dispatchEvent(new Event('input', { bubbles: true })); await workbenchTest.nextTick();");
  await save('logbook-timeline');
  const landingReady = await evaluate("const button = document.getElementById('timeline-mobile-viewer-landing-shortcut'); if (!button) return false; button.click(); await workbenchTest.nextTick(); return true;");
  if (!landingReady) throw new Error('The recorded flight has no landing debrief action.');
  await save('landing-debrief');
  fs.writeFileSync(path.join(staging, 'capture-report.json'), JSON.stringify({ date, source: 'Current app components; offline sample data', report }, null, 2));
  console.log(`Captured ${report.length} current README scenes at 1440 × 900. Inspect each image before publishing.`);
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
