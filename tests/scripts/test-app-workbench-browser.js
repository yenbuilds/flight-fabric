#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const { TAKEOFF_SCORING_ENABLED } = require('../../shared/app-settings-shared');
const OUTPUT = path.join(ROOT, '.tmp/app-workbench-browser');
const SIZES = [
  ['desktop-wide', 1920, 1080, false], ['desktop', 1440, 900, false], ['desktop-narrow', 900, 800, false],
  ['desktop-compact', 1280, 720, false],
  ['tablet-portrait', 820, 1180, true], ['tablet-landscape', 1180, 820, true],
  ['phone', 390, 844, true], ['phone-narrow', 320, 700, true],
];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browser() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(OUTPUT, `user-data-${process.pid}`));
  app.disableHardwareAcceleration();
  for (const option of ['disable-gpu', 'disable-gpu-compositing', 'disable-gpu-sandbox']) app.commandLine.appendSwitch(option);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [], checks = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = body => win.webContents.executeJavaScript(`(async () => { ${body} })()`);
  async function capture(name) {
    await win.webContents.capturePage(); await wait(70);
    fs.writeFileSync(path.join(OUTPUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  try {
    await win.loadURL(process.env.FF_WORKBENCH_TEST_URL);
    win.webContents.debugger.attach('1.3');
    for (let n = 0; n < 180; n++) { if (await evaluate('return Boolean(window.workbenchTest);')) break; await wait(50); }
    assert(await evaluate('return Boolean(window.workbenchTest);'), `fixture initialized: ${errors.join('\n')}`);
    await evaluate(`workbenchTest.takeoff.handleTakeoffMessage({ type:'takeoff', final:true, timestampMs:Date.now(),
      aircraft:'PMDG 737-800', icao:'YSSY', runway:'16R', grade:'Recorded', score:null, zone:'Observed runway remaining',
      assessment:'critical', runwayExcursion:true, flags:[{code:'runway_excursion',severity:'critical',label:'Runway excursion during the takeoff roll'},
        {code:'ground_contact_uncertain',severity:'caution',label:'Brief ground-contact indication; contact not confirmed'}],
      runwayUse:{remainingFt:3200,runwayLengthFt:8000,usedPct:60,verified:true},
      roll:{distanceFt:4600,durationS:32,startSource:'standstill'}, liftoff:{iasKts:146,pitchDeg:9},
      rotation:{rateDegS:5,priorMaxRateDegS:8,maxPitchDeg:18},
      lateral:{liftoffOffsetFt:90,liftoffOffsetSide:'right',score:null,grade:'Recorded',verified:true},
      heading:{liftoffDeviationDeg:15,liftoffDeviationSide:'right'},
      screenHeight:{heightFt:35,reached:false}, finalizeReason:'telemetry_gap' }); await workbenchTest.nextTick();`);
    assert.equal(await evaluate("return document.getElementById('dest-progress-label').textContent;"), 'From YSSY RWY 16R -> To YMML RWY 16', 'the shared route label includes the planned runways');
    // Exercise the shell as a keyboard user, including the teleported recording
    // popover. Native key events catch focus paths synthetic clicks cannot.
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const key = async keyCode => {
      const keys = { Return: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27] };
      const [name, windowsVirtualKeyCode] = keys[keyCode];
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode, ...(type==='keyDown' && name==='Enter' ? {text:'\r',unmodifiedText:'\r'} : {}) });
      await wait(70);
    };
    async function pointerActivate(selector, touch) {
      const point = await evaluate(`const el=document.querySelector(${JSON.stringify(selector)}), r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
      const hit = await evaluate(`const el=document.querySelector(${JSON.stringify(selector)}), target=document.elementFromPoint(${point.x},${point.y}); return {matches:el.contains(target), target:target?.outerHTML.slice(0,300)};`);
      assert(hit.matches, `${selector}: native pointer targets the rendered control at ${JSON.stringify(point)}: ${JSON.stringify(hit)}`);
      if (touch) {
        for (const type of ['touchStart', 'touchEnd']) await Promise.race([
          win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type, touchPoints:type==='touchStart' ? [point] : [] }),
          wait(3000).then(() => { throw new Error(`Timed out sending ${type} to ${selector}`); }),
        ]);
      } else {
        const location = { x:Math.round(point.x), y:Math.round(point.y), button:'left', clickCount:1 };
        win.webContents.sendInputEvent({ type:'mouseDown', ...location });
        win.webContents.sendInputEvent({ type:'mouseUp', ...location });
      }
      await wait(70);
    }
    async function checkReplayLayout(name, width) {
      await evaluate(`document.querySelectorAll('.logbook-review-views button')[1].click();
        workbenchTest.timeline.setMapViewMode('3d'); await workbenchTest.nextTick();`);
      await wait(200);
      // Use representative long values: the quiet flight fixture otherwise
      // misses the alert wrapping and five-metric layout in real recordings.
      await evaluate(`Object.assign(workbenchTest.timeline, {cautionCountText:'3', violationCountText:'3 moments (4 triggers)', fuelBurnText:'911.2 gal'});
        await workbenchTest.nextTick(); document.getElementById('vue-main-root').scrollTop=0;
        document.querySelector('.logbook-review-content').scrollTop=0;
        document.getElementById('vue-timeline-map-shell-root').scrollTop=0;`);
      await capture(`${name}-replay-3d`);
      const replay = await evaluate(`const map=document.querySelector('.timeline-map-wrap').getBoundingClientRect();
        const alerts=document.querySelector('.timeline-summary-alerts dd').getBoundingClientRect();
        const summary=document.querySelector('.timeline-summary-container').getBoundingClientRect();
        return {map:map.toJSON(), alertWidth:alerts.width, summaryWidth:summary.width,
          overflow:document.documentElement.scrollWidth>innerWidth+1,
          selected:workbenchTest.timeline.loadedTimelineFlightId};`);
      assert(replay.map.height >= (width > 1100 ? 320 : 256), `${name}: replay keeps a useful map height: ${JSON.stringify(replay)}`);
      assert(replay.alertWidth >= Math.min(260, replay.summaryWidth - 32), `${name}: alerts have room for readable descriptions`);
      assert.equal(replay.overflow, false, `${name}: 3D replay does not overflow horizontally`);
      await evaluate(`window.replaySurface=document.getElementById('timeline-map-3d');
        document.getElementById('timeline-map-3d-settings-toggle').click(); await workbenchTest.nextTick();
        document.getElementById('timeline-map-3d-vertical-scale').scrollIntoView({block:'center'});`);
      assert(await evaluate(`const select=document.getElementById('timeline-map-3d-vertical-scale'), r=select.getBoundingClientRect();
        return select.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));`), `${name}: expanded 3D settings are reachable`);
      await evaluate(`const select=document.getElementById('timeline-map-3d-vertical-scale'); select.value='2'; select.dispatchEvent(new Event('change',{bubbles:true}));
        document.getElementById('timeline-map-3d-settings-toggle').click();
        const profile=document.getElementById('timeline-altitude-profile'); profile.querySelector('summary').click();
        await workbenchTest.nextTick(); profile.scrollIntoView({block:'center'});`);
      assert(await evaluate(`const plot=document.getElementById('timeline-altitude-profile-svg'); return plot.getBoundingClientRect().height>40;`), `${name}: altitude profile is available on demand`);
      assert(await evaluate(`return replaySurface===document.getElementById('timeline-map-3d') && workbenchTest.timeline.map3dOptions.verticalScale===2;`), `${name}: disclosures retain the replay surface and settings`);
      await evaluate(`document.getElementById('timeline-time-scrubber').scrollIntoView({block:'center'});`);
      assert(await evaluate(`const el=document.getElementById('timeline-time-scrubber'), r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));`), `${name}: timeline scrubber remains reachable below the expanded profile`);
      await capture(`${name}-replay-profile`);
      await evaluate(`document.getElementById('timeline-altitude-profile').open=false;
        workbenchTest.timeline.setMapViewMode('2d'); document.querySelectorAll('.logbook-review-views button')[0].click(); await workbenchTest.nextTick();`);
      assert.equal(await evaluate('return workbenchTest.timeline.loadedTimelineFlightId;'), replay.selected, `${name}: changing replay presentation keeps the selected flight`);
    }
    async function checkAircraftCorrection(name, width, height, touch) {
      const trigger = '#aircraft-profile-correction-btn';
      const isOpen = () => evaluate("return document.getElementById('aircraft-profile-correction').open;");
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled:true });
      await pointerActivate(trigger, touch);
      assert.equal(await isOpen(), true, `${name}: aircraft correction opens with ${touch ? 'touch' : 'mouse'}`);
      const correction = await evaluate("const r=document.getElementById('aircraft-profile-correction-panel').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};");
      assert(correction.left >= 0 && correction.right <= width && correction.bottom <= height, `${name}: aircraft correction popover fits the viewport: ${JSON.stringify(correction)}`);
      await pointerActivate('#aircraft-profile-correction-panel p', touch);
      assert.equal(await isOpen(), true, `${name}: interacting inside aircraft correction keeps it open`);
      await evaluate("const select=document.getElementById('aircraft-profile-correction-select'); select.focus(); select.dispatchEvent(new Event('change',{bubbles:true})); await workbenchTest.nextTick();");
      assert.equal(await isOpen(), true, `${name}: using the profile selector does not dismiss the correction panel`);
      await key('Escape');
      assert.equal(await isOpen(), false, `${name}: Escape dismisses aircraft correction`);
      assert.equal(await evaluate('return document.activeElement.id;'), 'aircraft-profile-correction-btn', `${name}: Escape returns focus to Wrong aircraft`);
      await key('Return');
      assert.equal(await isOpen(), true, `${name}: aircraft correction can reopen with the keyboard`);
      await evaluate("document.getElementById('aircraft-profile-correction-select').focus();");
      await key('Tab');
      assert.equal(await isOpen(), false, `${name}: tabbing out dismisses aircraft correction`);
      assert(await evaluate("return document.activeElement.id!=='aircraft-profile-correction-btn' && !document.activeElement.closest('#aircraft-profile-correction') && document.activeElement.getClientRects().length>0;"), `${name}: focus dismissal preserves the next keyboard destination`);
      await pointerActivate(trigger, touch);
      assert.equal(await isOpen(), true, `${name}: aircraft correction reopens after focus leaves`);
      const close = await evaluate("const el=document.getElementById('aircraft-profile-correction-close'),r=el.getBoundingClientRect(); return {label:el.getAttribute('aria-label')||el.textContent,width:r.width,height:r.height};");
      assert(close.label.trim().length > 0, `${name}: explicit correction close control has an accessible name`);
      if (touch) assert(close.width >= 44 && close.height >= 44, `${name}: correction close control has a touch target`);
      await pointerActivate('#aircraft-profile-correction-close', touch);
      assert.equal(await isOpen(), false, `${name}: explicit close dismisses aircraft correction`);
      const closeFocus = await evaluate('return {id:document.activeElement.id,html:document.activeElement.outerHTML.slice(0,250)};');
      assert.equal(closeFocus.id, 'aircraft-profile-correction-btn', `${name}: explicit close returns focus to Wrong aircraft: ${JSON.stringify(closeFocus)}`);
      await pointerActivate(trigger, touch);
      if (width <= 390) await capture(`${name}-aircraft-correction`);
      await pointerActivate('#aircraft-name', touch);
      assert.equal(await isOpen(), false, `${name}: ${touch ? 'tapping' : 'clicking'} outside dismisses aircraft correction`);
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled:false });
    }
    async function checkRecordingPointer(name, touch) {
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled:true });
      const before = await evaluate('return window.recordingEndRequested;');
      await pointerActivate('#recording-details-btn', touch);
      assert.equal(await evaluate("return document.getElementById('recording-details-btn').getAttribute('aria-expanded');"), 'true', `${name}: pointer opens recording details`);
      await win.webContents.capturePage();
      await wait(100);
      await pointerActivate('#end-flight-btn', touch);
      assert.equal(await evaluate('return window.recordingEndRequested;'), before + 1, `${name}: pointer invokes the manual recording action once`);
      assert.equal(await evaluate('return document.activeElement.id;'), 'end-flight-btn', `${name}: focus reaches the recording action without dismissing it`);
      await capture(`${name}-recording-action`);
      await evaluate(`workbenchTest.status.ingestMessage({type:'flightRecording',status:'finalizing'}); await workbenchTest.nextTick();`);
      assert(await evaluate("const button=document.getElementById('end-flight-btn'); return button.disabled && button.textContent.includes('Saving flight');"), `${name}: saving disables the end-flight action with visible progress`);
      await pointerActivate('#end-flight-btn', touch);
      assert.equal(await evaluate('return window.recordingEndRequested;'), before + 1, `${name}: native input cannot send another request while saving`);
      await capture(`${name}-recording-saving`);
      await evaluate(`workbenchTest.status.ingestMessage({type:'flightRecording',status:'error',error:'Save failed'}); await workbenchTest.nextTick();`);
      assert.equal(await evaluate("return document.getElementById('end-flight-btn').disabled;"), false, `${name}: a failed save releases the finalizing guard`);
      await pointerActivate('#recording-details-btn', touch);
      assert.equal(await evaluate("return document.getElementById('recording-details-btn').getAttribute('aria-expanded');"), 'false', `${name}: clicking the trigger again dismisses recording details`);
      await pointerActivate('#recording-details-btn', touch);
      await win.webContents.capturePage(); await wait(100);
      await evaluate(`window.recordingDialogId=document.getElementById('recording-details-btn').getAttribute('aria-controls');
        workbenchTest.status.ingestMessage({type:'flightRecording',status:'stopped'}); await workbenchTest.nextTick();`);
      assert.equal(await evaluate("return Boolean(document.getElementById(recordingDialogId)?.getClientRects().length);"), false, `${name}: stopping recording closes its teleported details`);
      await evaluate("workbenchTest.shell.openNavigator(); await workbenchTest.nextTick();");
      await key('Escape');
      assert.equal(await evaluate('return workbenchTest.shell.navigatorOpen;'), false, `${name}: closed recording details do not intercept another dialog's Escape`);
      await evaluate(`workbenchTest.status.ingestMessage({type:'flightRecording',status:'recording',fileName:'QFA437.csv'}); await workbenchTest.nextTick();`);
      assert.equal(await evaluate("return document.getElementById('recording-details-btn').getAttribute('aria-expanded');"), 'false', `${name}: a new recording does not reopen stale details`);
      await pointerActivate('#recording-details-btn', touch);
      await win.webContents.capturePage(); await wait(100);
      await evaluate("window.recordingStatusBeforeDisconnect={...workbenchTest.status.$state}; workbenchTest.status.resetTelemetry('wsDisconnected'); await workbenchTest.nextTick();");
      assert.equal(await evaluate("return Boolean(document.getElementById(recordingDialogId)?.getClientRects().length);"), false, `${name}: disconnect also closes stale recording details`);
      await evaluate("Object.assign(workbenchTest.status,recordingStatusBeforeDisconnect); await workbenchTest.nextTick();");
      await pointerActivate('#recording-details-btn', touch);
      await key('Escape');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled:false });
    }
    if (!process.env.FF_TOOLBAR_SETUP_ONLY) {
    await evaluate("window.recordingEndRequested=0; workbenchTest.status.bindHeaderActions({onEndFlightManual:()=>{window.recordingEndRequested++;return true;}}); document.getElementById('recording-details-btn').focus();");
    await key('Return');
    const recordingOpened = await evaluate("return {expanded:document.getElementById('recording-details-btn').getAttribute('aria-expanded'),focus:document.activeElement.outerHTML.slice(0,300),dialog:document.getElementById(document.getElementById('recording-details-btn').getAttribute('aria-controls')).outerHTML.slice(0,300)};");
    assert(recordingOpened.expanded==='true' && recordingOpened.focus.includes('app-tooltip'), `Enter opens and focuses labelled recording details: ${JSON.stringify(recordingOpened)}`);
    await capture('desktop-recording-details');
    await key('Tab');
    const recordingTabFocus = await evaluate('return {id:document.activeElement.id,html:document.activeElement.outerHTML.slice(0,350),end:document.getElementById("end-flight-btn")?.getBoundingClientRect().toJSON()};');
    assert.equal(recordingTabFocus.id, 'end-flight-btn', `Tab reaches the manual recording action: ${JSON.stringify(recordingTabFocus)}`);
    await key('Return');
    assert.equal(await evaluate('return window.recordingEndRequested;'), 1, 'keyboard activation invokes the existing guarded recording action');
    await key('Escape');
    assert.equal(await evaluate('return document.activeElement.id;'), 'recording-details-btn', 'recording dismissal returns focus to its trigger');
    assert.equal(await evaluate("return Boolean(document.querySelector('[data-workspace-toggle], #workspace-welcome, #workspace-suggestion'));"), false, 'retired workspace UI is absent even with a saved Planning preference');
    assert(await evaluate("const a=document.querySelector('.sidebar-bottom .app-support-link'),r=a.getBoundingClientRect();return a.href==='https://www.flightfabric.com/support/' && a.textContent.includes('Buy me a coffee') && r.top>=0 && r.bottom<=innerHeight;"), 'desktop support action is visible and uses the stable first-party support URL');
    win.setContentSize(390,844); await win.webContents.capturePage(); await wait(180);
    await evaluate("await workbenchTest.open('flight');");
    assert(await evaluate("return document.querySelector('.mobile-tab[data-tab=livemap]').getAttribute('aria-current')==='page' && !document.querySelector('#mobile-more-btn.active');"), 'Overview belongs to the visible Flight navigation entry');
    await evaluate("document.querySelector('.workspace-view-switch [aria-controls=tab-livemap]').click(); await workbenchTest.nextTick();");
    assert(await evaluate("return document.querySelector('.mobile-tab[data-tab=livemap]').getAttribute('aria-current')==='page';"), 'switching Map/Overview does not change primary navigation ownership');
    await evaluate("document.getElementById('mobile-more-btn').click(); await workbenchTest.nextTick();");
    assert(await evaluate("const a=document.querySelector('.mobile-support-link'),r=a.getBoundingClientRect(),panel=a.closest('[role=dialog]').getBoundingClientRect();return a.href==='https://www.flightfabric.com/support/' && r.top>=panel.top && r.bottom<=innerHeight && r.height>=44;"), 'phone support action uses the stable first-party support URL and is visible at the top of More with a touch target');
    await evaluate("window.stopUxNavigation=workbenchTest.tabs.registerBeforeChangeGuard(()=>false); document.querySelector('#mobile-more-sheet [data-tab=settings]').click(); await workbenchTest.nextTick();");
    assert(await evaluate("return workbenchTest.tabs.moreSheetOpen && workbenchTest.tabs.activeTabId==='livemap';"), 'blocked More selection retains the open menu and current task');
    await evaluate("window.stopUxNavigation(); document.querySelector('#mobile-more-sheet [data-tab=settings]').click(); await workbenchTest.nextTick();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'vue-main-root', 'successful More selection focuses the new workspace');
    await evaluate("document.getElementById('mobile-more-btn').click(); await workbenchTest.nextTick();");
    await key('Escape');
    assert.equal(await evaluate('return document.activeElement.id;'), 'mobile-more-btn', 'cancelling More returns focus to its launcher');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    for (const [name, width, height, touch] of SIZES) {
      win.setContentSize(width, height);
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await wait(150);
      const nav = await evaluate("return {desktop:[...document.querySelectorAll('.desktop-tab')].map(el=>el.dataset.tab),mobile:[...document.querySelectorAll('.mobile-tab[data-tab]')].map(el=>el.dataset.tab),retired:Boolean(document.querySelector('[data-workspace-option], #workspace-welcome, #workspace-suggestion')),legacy:localStorage.getItem('ff_workspace_v1')};");
      assert.deepEqual(nav.desktop, ['livemap', 'autopilot', 'dispatch', 'timeline', 'settings', 'system'], name + ': fixed desktop order');
      assert.deepEqual(nav.mobile, ['livemap', 'autopilot', 'dispatch', 'timeline'], name + ': fixed mobile order');
      assert.equal(nav.retired, false);
      assert.equal(nav.legacy, 'planning', 'old settings remain harmless and untouched');
      for (const tab of ['livemap', 'flight', 'autopilot', 'dispatch', 'timeline', 'system', 'settings']) {
        await evaluate(`await workbenchTest.open(${JSON.stringify(tab)}); document.getElementById('vue-main-root').scrollTop = 0;`);
        await wait(170);
        if (tab === 'livemap') {
          await evaluate("document.getElementById('live-map-center-btn').click(); await workbenchTest.nextTick();");
          await win.webContents.capturePage(); await wait(350);
          for (let n=0;n<20;n++) {
            await win.webContents.capturePage();
            if (await evaluate("const marker=document.querySelector('#live-map .live-plane-icon'); if(!marker)return false; const r=marker.getBoundingClientRect(), map=document.getElementById('live-map').getBoundingClientRect(); return r.left>=map.left && r.right<=map.right && r.top>=map.top && r.bottom<=map.bottom;")) break;
            await wait(50);
          }
        }
        if (tab === 'timeline') {
          await evaluate('await workbenchTest.review();');
          await wait(170);
        }
        const layout = await evaluate(`const rect = selector => { const el = document.querySelector(selector); if (!el || !el.getClientRects().length) return null; const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height }; };
          return { header: rect('#vue-header-root'), main: rect('#vue-main-root'), footer: rect('#vue-footer-root'),
            sidebar: rect('.app-sidebar'), mobile: rect('.mobile-tab-bar'), map: rect('#live-map'), readings: rect('.live-map-readings'),
            routeLabel: rect('#dest-progress-label'), routeProgress: rect('#dest-progress-text'),
            overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
            selected: workbenchTest.tabs.activeTabId,
            takeoffUi: Boolean(document.querySelector('#vue-last-takeoff-root, #vue-takeoff-root, #logbook-takeoffs')),
            overflowing: [...document.querySelectorAll('#tab-${tab} *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0 && r.right>innerWidth+2 && !el.closest('.leaflet-pane, .leaflet-control-container, .flight-scene-surface');}).slice(0,8).map(el=>({tag:el.tagName,id:el.id,cls:el.className})),
            targets: [...document.querySelectorAll(innerWidth > 760 ? '.desktop-tab' : '.mobile-tab')].filter(el=>el.getClientRects().length).map(el=>({label:el.getAttribute('aria-label'),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})),
          };`);
        checks.push({ name, tab, ...layout });
        assert.equal(layout.overflow, false, `${name}/${tab}: page has no horizontal overflow`);
        assert.equal(layout.selected, tab, `${name}/${tab}: guarded navigation arrived`);
        assert(layout.header.bottom <= layout.main.y + 1, `${name}/${tab}: header does not overlap the working area`);
        if (width > 760) {
          for (const region of [layout.routeLabel, layout.routeProgress]) assert(region && region.x >= 0 && region.right <= width && region.bottom <= layout.header.bottom, `${name}/${tab}: route and runways fit the header`);
          assert(layout.routeLabel.right <= layout.routeProgress.x || layout.routeLabel.bottom <= layout.routeProgress.y, `${name}/${tab}: runways and distance remain readable without overlap`);
        } else {
          assert.equal(layout.routeLabel, null, `${name}/${tab}: route strip retains the compact phone header`);
          assert.equal(layout.routeProgress, null, `${name}/${tab}: route progress stays hidden with the phone strip`);
        }
        assert(layout.main.height >= 200, `${name}/${tab}: workspace remains usable`);
        if (width > 760) {
          assert(layout.sidebar?.height > height * 0.6, `${name}/${tab}: persistent sidebar`);
          assert.equal(layout.sidebar.width < 90, width <= 1280, `${name}/${tab}: default navigation adapts to compact windows`);
          assert.equal(await evaluate("return localStorage.getItem('ff_sidebar_collapsed_v1');"), null, 'automatic navigation sizing does not save a manual preference');
          assert(layout.main.bottom <= layout.footer.y + 1, `${name}/${tab}: status footer does not overlap content`);
        } else {
          assert.equal(layout.sidebar, null, `${name}/${tab}: phone uses bottom navigation`);
          assert(layout.mobile && layout.mobile.bottom <= height + 1, `${name}/${tab}: bottom navigation is reachable`);
        }
        if (touch) for (const target of layout.targets) assert(target.height >= 43 && target.width >= 43, `${name}: ${target.label} has a touch target`);
        if (tab === 'livemap') {
          assert(layout.map.height >= (width <= 390 ? 240 : 280), `${name}: map has useful vertical space`);
          assert(layout.map.width > layout.main.width * 0.8, `${name}: map fills available working width`);
          if (width <= 760) assert(layout.readings.bottom <= layout.mobile.y + 1, `${name}: default map readings stay above bottom navigation`);
          assert(await evaluate("return Boolean(document.querySelector('#live-map .leaflet-marker-icon'));"), `${name}: actual Leaflet aircraft marker rendered`);
          assert(await evaluate("const r=document.querySelector('#live-map .live-plane-icon').getBoundingClientRect(), map=document.getElementById('live-map').getBoundingClientRect(); return r.left>=map.left && r.right<=map.right && r.top>=map.top && r.bottom<=map.bottom;"), `${name}: centered aircraft is visible in the representative map capture`);
        }
        assert.equal(layout.takeoffUi, TAKEOFF_SCORING_ENABLED, `${name}/${tab}: takeoff panels follow the release gate even with populated history`);
        if (tab === 'flight' && TAKEOFF_SCORING_ENABLED) {
          const takeoff = await evaluate(`const warning=document.getElementById('data-last-takeoff-assessment');
            const confidence=document.getElementById('data-last-takeoff-confidence');
            const r=warning.getBoundingClientRect(); return {warning:warning.textContent,confidence:confidence.textContent,
              width:r.width,left:r.left,right:r.right,display:getComputedStyle(warning).display};`);
          assert.match(takeoff.warning, /Runway excursion/, `${name}: Overview retains the critical finding beside the measurements`);
          assert.match(takeoff.confidence, /Low confidence.*Telemetry gap/);
          assert(takeoff.width > 0 && takeoff.left >= 0 && takeoff.right <= width, `${name}: warning fits the summary`);
          assert.notEqual(takeoff.display, 'none');
          await evaluate(`document.getElementById('data-last-takeoff-card').scrollIntoView({block:'start'});`);
          await capture(`${name}-takeoff-summary`);
          await evaluate(`document.getElementById('data-open-takeoff-btn').click(); await workbenchTest.nextTick();`);
          await wait(200);
          await evaluate(`document.getElementById('takeoff-card').scrollIntoView({block:'start'});`);
          const report = await evaluate(`const card=document.getElementById('takeoff-card');
            return {tab:workbenchTest.tabs.activeTabId,text:card.textContent,visible:card.getClientRects().length>0,
              aircraftCopyWidth:card.querySelector('.landing-aircraft-hero__copy').getBoundingClientRect().width,
              overflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth+1};`);
          assert.equal(report.tab, 'landing', `${name}: Full Report opens the debrief`);
          assert.equal(report.visible, true);
          assert.equal(report.overflow, false, `${name}: takeoff report fits the viewport`);
          assert.match(report.text, /RUNWAY EXCURSION/);
          assert.match(report.text, /More runway remaining does not mean a better takeoff/);
          assert.match(report.text, /RECORDED/);
          assert.match(report.text, /Earlier liftoff: 8.0 deg\/s/);
          assert.match(report.text, /Brief ground contact not confirmed/);
          assert.match(report.text, /Measured at liftoff/);
          assert.doesNotMatch(report.text, /Steady rotation|Rapid rotation|Outstanding|Runway use grade|Major heading error|Stayed airborne/);
          if (width <= 390) assert(report.aircraftCopyWidth >= 180, `${name}: aircraft identity has readable width`);
          await capture(`${name}-takeoff-report`);
          await evaluate(`await workbenchTest.open('flight'); document.getElementById('vue-main-root').scrollTop=0;`);
        }
        await capture(`${name}-${tab}`);
        if (tab === 'timeline' && ['desktop', 'desktop-compact', 'phone', 'phone-narrow'].includes(name)) await checkReplayLayout(name, width);
      }
      // Long task content scrolls independently of primary navigation.
      const fixedNavigation = await evaluate(`const nav = document.querySelector(innerWidth > 760 ? '.app-sidebar' : '.mobile-tab-bar'); const before = nav.getBoundingClientRect().top;
        const main = document.getElementById('vue-main-root'); main.scrollTop = main.scrollHeight; await workbenchTest.nextTick();
        return {before,after:nav.getBoundingClientRect().top,scroll:main.scrollTop};`);
      assert.equal(fixedNavigation.before, fixedNavigation.after, `${name}: navigation stays in place while task content scrolls`);
      assert(fixedNavigation.scroll > 0, `${name}: settings has exercised real scrolling`);
      if (name === 'desktop' || width <= 390) {
        await checkAircraftCorrection(name, width, height, touch);
        await checkRecordingPointer(name, touch);
      }
    }
    // A manual preference takes priority over compact-window defaults, and the
    // replay must still be usable with the wider navigation beside it.
    win.setContentSize(1280, 720);
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
    await evaluate("workbenchTest.shell.sidebarCollapsed=false; await workbenchTest.open('timeline'); await workbenchTest.review();");
    for (let n=0;n<20;n++) {
      await win.webContents.capturePage();
      if (await evaluate("return document.querySelector('.app-sidebar').getBoundingClientRect().width>170;")) break;
      await wait(50);
    }
    assert(await evaluate("return document.querySelector('.app-sidebar').getBoundingClientRect().width>170;"), 'manual expansion is honoured in a compact window');
    await checkReplayLayout('desktop-compact-expanded', 1280);
    win.setContentSize(1180, 720); await win.webContents.capturePage(); await wait(100);
    assert.equal(await evaluate('return workbenchTest.shell.sidebarCollapsed;'), false, 'resizing retains an explicit expanded navigation choice');
    assert.equal(await evaluate("return localStorage.getItem('ff_sidebar_collapsed_v1');"), 'no', 'explicit expansion persists synchronously');

    // A horizontal gesture belongs to the wide Navlog, including at either edge.
    // Send native touch input so browser scrolling and the global tab listener both run.
    win.setContentSize(390, 844); await wait(120);
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await evaluate("await workbenchTest.open('dispatch'); document.getElementById('sb-navlog-section').open=true; await workbenchTest.nextTick(); document.querySelector('.simbrief-table-wrap').scrollIntoView({block:'center'});");
    await win.webContents.capturePage(); await wait(100);
    const navlogBounds = await evaluate("const table=document.querySelector('.simbrief-table-wrap'), r=table.getBoundingClientRect(), main=document.getElementById('vue-main-root').getBoundingClientRect(); return {left:r.left,right:r.right,y:(Math.max(r.top,main.top)+Math.min(r.bottom,main.bottom))/2,max:table.scrollWidth-table.clientWidth};");
    assert(navlogBounds.max > 80, 'phone Navlog contains columns beyond the viewport');
    async function swipeNavlog(direction) {
      const left=navlogBounds.left+28, right=navlogBounds.right-28;
      const start=direction==='left' ? right : left, finish=direction==='left' ? left : right;
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x:start,y:navlogBounds.y}] });
      for(let step=1;step<=6;step++) {
        await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x:start+(finish-start)*step/6,y:navlogBounds.y}] });
        await wait(20);
      }
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
      await wait(150);
      assert.equal(await evaluate('return workbenchTest.tabs.activeTabId;'), 'dispatch', `Navlog swipe ${direction} retains SimBrief`);
      return evaluate("return document.querySelector('.simbrief-table-wrap').scrollLeft;");
    }
    await evaluate("document.querySelector('.simbrief-table-wrap').scrollLeft=0;");
    const navlogAfterLeft=await swipeNavlog('left');
    assert(navlogAfterLeft>40, 'swiping the Navlog exposes later columns');
    assert((await swipeNavlog('right'))<navlogAfterLeft, 'reverse swipe returns toward earlier columns');
    await evaluate("document.querySelector('.simbrief-table-wrap').scrollLeft=0;");
    await swipeNavlog('right');
    await evaluate("const table=document.querySelector('.simbrief-table-wrap'); table.scrollLeft=table.scrollWidth;");
    await swipeNavlog('left');
    win.setContentSize(700, 390); await wait(120);
    await evaluate("await workbenchTest.open('livemap'); document.getElementById('vue-main-root').scrollTop=0;"); await wait(100);
    await evaluate("document.getElementById('live-map-center-btn').click(); await workbenchTest.nextTick();"); await win.webContents.capturePage(); await wait(350);
    const landscapeMap = await evaluate("const main=document.getElementById('vue-main-root').getBoundingClientRect(), nav=document.querySelector('.mobile-tab-bar').getBoundingClientRect(), map=document.getElementById('live-map').getBoundingClientRect(); return {mainBottom:main.bottom,navTop:nav.top,mapHeight:map.height,overflow:document.documentElement.scrollWidth>innerWidth+1};");
    assert.equal(landscapeMap.overflow, false, 'short landscape map has no horizontal page overflow');
    assert(landscapeMap.mainBottom <= landscapeMap.navTop + 1, 'short landscape reserves space for navigation outside the scrolling main');
    assert(landscapeMap.mapHeight >= 224, 'short landscape keeps a useful map canvas within the sequential scroll flow');
    await capture('phone-landscape-map');
    await evaluate("document.querySelector('.live-map-readings').scrollIntoView({block:'end'});");
    assert(await evaluate("const r=document.querySelector('.live-map-readings').getBoundingClientRect(), nav=document.querySelector('.mobile-tab-bar').getBoundingClientRect(), main=document.getElementById('vue-main-root').getBoundingClientRect(); return r.top>=main.top && r.bottom<=nav.top+1;"), 'short landscape map readings can be scrolled fully above navigation');
    await capture('phone-landscape-map-readings');
    win.setContentSize(390, 844); await wait(100);
    await evaluate("await workbenchTest.open('settings'); document.getElementById('mobile-more-btn').click(); await workbenchTest.nextTick();");
    assert(await evaluate("return workbenchTest.tabs.moreSheetOpen && Boolean(document.activeElement.closest('#mobile-more-sheet'));"), 'More navigation opens with focus inside its dialog');
    await capture('phone-more-navigation');
    win.setContentSize(1440, 900); await wait(150);
    const moreRecovery = await evaluate("await workbenchTest.nextTick(); const main=document.getElementById('vue-main-root'); main.scrollTop=0; main.scrollTop=main.scrollHeight; const event=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}); document.activeElement.dispatchEvent(event); return {open:workbenchTest.tabs.moreSheetOpen,overflow:getComputedStyle(main).overflowY,scroll:main.scrollTop,focusVisible:document.activeElement.getClientRects().length>0,focusTab:document.activeElement.dataset.tab,focusId:document.activeElement.id,tabPrevented:event.defaultPrevented};");
    assert.equal(moreRecovery.open, false, 'resizing to desktop dismisses the phone-only More dialog');
    assert(moreRecovery.overflow !== 'hidden' && moreRecovery.scroll > 0, 'resizing releases the main workspace scroll lock');
    assert(moreRecovery.focusVisible && (moreRecovery.focusTab === 'settings' || moreRecovery.focusId === 'vue-main-root'), `resizing restores useful visible desktop focus: ${JSON.stringify(moreRecovery)}`);
    assert.equal(moreRecovery.tabPrevented, false, 'dismissed mobile sheet does not retain its Tab trap');
    win.setContentSize(390, 844); await wait(100);
    await evaluate("await workbenchTest.open('dispatch'); document.getElementById('mobile-more-btn').click(); await workbenchTest.nextTick();");
    await evaluate("document.getElementById('sb-username-input').focus();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'sb-username-input', 'visible input has focus before resizing');
    win.setContentSize(1440, 900); await wait(150);
    for (let n=0;n<25;n++) {
      await win.webContents.capturePage();
      if (!await evaluate('return workbenchTest.tabs.moreSheetOpen;')) break;
      await wait(50);
    }
    assert.equal(await evaluate('return document.activeElement.id;'), 'sb-username-input', 'breakpoint recovery preserves an already focused visible input');
    assert.equal(await evaluate('return workbenchTest.tabs.moreSheetOpen;'), false, 'input focus does not prevent mobile dialog cleanup');
    await evaluate("await workbenchTest.open('flight'); document.querySelector('.sidebar-collapse').click(); await workbenchTest.nextTick();");
    // Hidden Electron windows can defer layout when crossing the mobile breakpoint.
    // Wait for the actual rendered rail width, with a hard bound, before assessing it.
    for (let n=0;n<30;n++) {
      await win.webContents.capturePage();
      if (await evaluate("return document.querySelector('.app-sidebar').getBoundingClientRect().width < 90;")) break;
      await wait(50);
    }
    assert.equal(await evaluate("return localStorage.getItem('ff_sidebar_collapsed_v1');"), 'yes', 'sidebar collapse is saved per device');
    const collapsed = await evaluate("const style=getComputedStyle(document.querySelector('.app-workbench')); return {width:document.querySelector('.app-sidebar').getBoundingClientRect().width, viewport:innerWidth, classes:document.querySelector('.app-workbench').className, grid:style.gridTemplateColumns,variable:style.getPropertyValue('--sidebar-width')};");
    assert(collapsed.width < 90, `collapsed sidebar returns width to the task: ${JSON.stringify(collapsed)}`);
    await capture('desktop-navigation-collapsed');
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    for (let n = 0; n < 180; n++) { if (await evaluate('return Boolean(window.workbenchTest);')) break; await wait(50); }
    assert.equal(await evaluate('return workbenchTest.shell.sidebarCollapsed;'), true, 'navigation collapse survives reload');
    await evaluate("document.querySelector('.sidebar-search').focus(); document.querySelector('.sidebar-search').click(); await workbenchTest.nextTick();");
    assert.equal(await evaluate('return document.activeElement.id;'), 'app-navigator-query', 'view search receives keyboard focus');
    await evaluate("const query = document.getElementById('app-navigator-query'); query.value='briefing'; query.dispatchEvent(new Event('input',{bubbles:true})); await workbenchTest.nextTick();");
    assert.equal(await evaluate("return document.querySelectorAll('.app-navigator-result').length;"), 1, 'task descriptions find a view');
    await capture('desktop-view-search');
    await evaluate("document.getElementById('app-navigator-query').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); await workbenchTest.nextTick();");
    assert.equal(await evaluate('return workbenchTest.tabs.activeTabId;'), 'dispatch', 'search navigates through the guarded tab action');
    assert.equal(await evaluate('return document.activeElement.id;'), 'vue-main-root', 'search returns keyboard focus to the new workspace');
    await evaluate("await workbenchTest.open('livemap'); workbenchTest.flight.setFlightState('inMenu'); await workbenchTest.nextTick();");
    assert(await evaluate("return [...document.querySelectorAll('.live-map-readings dd')].slice(0,4).every(el => el.textContent.trim().startsWith('--'));"), 'muted telemetry does not present cached measurements as current');
    assert(await evaluate("return document.querySelector('.live-map-readings').textContent.includes('Simulator is in menus');"), 'muted map explains the unavailable readings');
    await capture('desktop-muted-map');
    }
    // Real shell + settings runtime, with only the installer IPC stubbed.
    // Discovery must work before the user has ever opened Settings.
    win.setContentSize(1440, 900);
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
    await win.loadURL(`${process.env.FF_WORKBENCH_TEST_URL}?toolbar=1`);
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    for (let n=0;n<180;n++) { if(await evaluate('return Boolean(window.workbenchTest?.toolbar.hasLoaded);')) break; await wait(50); }
    await evaluate("workbenchTest.shell.sidebarCollapsed=false; await workbenchTest.open('flight');");
    await capture('toolbar-setup-desktop');
    assert(await evaluate('return workbenchTest.toolbarFixture.reads > 0;'), 'toolbar status is checked at startup');
    const setupButton = '.app-sidebar .toolbar-setup-open';
    assert(await evaluate(`return Boolean(document.querySelector(${JSON.stringify(setupButton)}));`), 'sidebar advertises toolbar installation');
    async function settleToolbarNavigation() {
      // Hidden Electron windows can defer the frame used after tab scroll restoration.
      for (let n=0;n<30;n++) {
        await win.webContents.capturePage();
        if (await evaluate("return document.activeElement.id === 'settings-toolbar-panel';")) return;
        await wait(30);
      }
    }
    await evaluate('window.releaseToolbarGuard = workbenchTest.tabs.registerBeforeChangeGuard(() => false);');
    await pointerActivate(setupButton, false);
    assert.equal(await evaluate('return workbenchTest.tabs.activeTabId;'), 'flight', 'setup link honours unsaved-edit guards');
    await evaluate('releaseToolbarGuard();');
    await pointerActivate(setupButton, false);
    await settleToolbarNavigation();
    assert.equal(await evaluate('return document.activeElement.id;'), 'settings-toolbar-panel', `setup link focuses the installation section: ${await evaluate('return document.activeElement.outerHTML.slice(0,300);')}`);
    assert(await evaluate("const r=document.getElementById('settings-toolbar-panel').getBoundingClientRect(), main=document.getElementById('vue-main-root').getBoundingClientRect(); return r.top>=main.top && r.top<main.top+60;"), 'setup section is scrolled into view');
    assert.deepEqual(await evaluate('return workbenchTest.toolbarFixture.writes;'), [], 'discovery does not install automatically');
    await capture('toolbar-setup-instructions');
    await pointerActivate('[data-toolbar-action="install"]', false);
    assert.equal(await evaluate('return workbenchTest.toolbar.setupTask;'), null, 'successful installation clears the task');
    assert(await evaluate("return document.getElementById('toolbar-panel-result').textContent.includes('Restart');"), 'installer retains restart guidance');
    await evaluate("workbenchTest.toolbarFixture.status='update_available'; await workbenchTest.toolbar.refresh(); await workbenchTest.open('flight'); workbenchTest.shell.sidebarCollapsed=true;");
    await capture('toolbar-setup-collapsed');
    await pointerActivate(setupButton, false);
    await settleToolbarNavigation();
    assert.equal(await evaluate('return document.activeElement.id;'), 'settings-toolbar-panel', 'collapsed rail retains the setup route');
    await evaluate("workbenchTest.toolbarFixture.status='not_installed'; await workbenchTest.toolbar.refresh(); workbenchTest.shell.sidebarCollapsed=false;");
    await pointerActivate('.app-sidebar .toolbar-setup-meta button', false);
    assert.equal(await evaluate('return workbenchTest.toolbar.setupTask;'), null, 'Not now dismisses the optional suggestion');
    assert.equal(await evaluate("return document.activeElement.dataset.tab;"), 'settings', 'dismissal preserves useful keyboard focus');
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    for (let n=0;n<180;n++) { if(await evaluate('return Boolean(window.workbenchTest?.toolbar.hasLoaded);')) break; await wait(50); }
    assert.equal(await evaluate('return workbenchTest.toolbar.setupTask;'), null, 'dismissal survives a new app session');
    await evaluate("workbenchTest.shell.openNavigator(); await workbenchTest.nextTick(); const q=document.getElementById('app-navigator-query'); q.value='toolbar'; q.dispatchEvent(new Event('input',{bubbles:true})); await workbenchTest.nextTick();");
    assert.equal(await evaluate("return document.querySelectorAll('.app-navigator-result').length;"), 1, 'dismissed setup remains searchable');
    await key('Return');
    await settleToolbarNavigation();
    assert.equal(await evaluate('return document.activeElement.id;'), 'settings-toolbar-panel', 'search focuses the same installation section');
    win.setContentSize(320, 700);
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await evaluate("workbenchTest.toolbar.setupDismissed=false; workbenchTest.shell.sidebarCollapsed=true; await workbenchTest.open('flight'); workbenchTest.tabs.toggleMoreSheet(); await workbenchTest.nextTick();");
    await capture('toolbar-setup-phone-more');
    assert(await evaluate("const el=document.querySelector('.mobile-toolbar-setup-task strong'),r=el.getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth;"), 'narrow More sheet shows the full task despite a collapsed desktop preference');
    await pointerActivate('.mobile-toolbar-setup-task .toolbar-setup-open', true);
    await settleToolbarNavigation();
    assert.equal(await evaluate('return workbenchTest.tabs.moreSheetOpen;'), false, 'phone setup closes More');
    assert.equal(await evaluate('return document.activeElement.id;'), 'settings-toolbar-panel', 'phone setup focuses the instructions');
    assert(await evaluate('return document.documentElement.scrollWidth <= innerWidth;'), 'setup does not overflow a narrow phone');
    await capture('toolbar-setup-phone-instructions');
    await evaluate("workbenchTest.toolbar.bindDesktopActions(null); await workbenchTest.nextTick();");
    assert.equal(await evaluate("return document.querySelectorAll('.toolbar-setup-task').length;"), 0, 'desktop-only tasks disappear when installer access is unavailable');
    if (process.env.FF_TOOLBAR_SETUP_ONLY) {
      assert.deepEqual(errors, [], 'no browser runtime or asset errors');
      console.log(`Toolbar setup passed: startup discovery, guarded navigation, install completion, collapsed rail, dismissal persistence, view search and narrow phone guidance. Screenshots: ${OUTPUT}`);
      app.exit(0);
      return;
    }
    const remoteCases = [
      ['remote-viewer', 'read-only', 'not-requested', false], ['remote-paired', 'aircraft-control', 'accepted', false],
      ['remote-expired', 'read-only', 'expired', false], ['remote-disconnected', 'read-only', 'expired', true],
    ];
    for (const [name, scope, pairing, disconnected] of remoteCases) {
      win.setContentSize(390, 844);
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const origin = new URL(process.env.FF_WORKBENCH_TEST_URL).origin;
      await win.loadURL(`${origin}/remote?scope=${scope}&pairing=${pairing}&disconnected=${disconnected ? '1' : '0'}`);
      for (let n=0;n<180;n++) { if(await evaluate('return Boolean(window.workbenchTest);')) break; await wait(50); }
      await evaluate("await workbenchTest.open('livemap');"); await wait(150);
      if (!disconnected) { await evaluate("document.getElementById('live-map-center-btn').click(); await workbenchTest.nextTick();"); await win.webContents.capturePage(); await wait(350); }
      assert.equal(await evaluate('return workbenchTest.profiles.authorizationScope;'), scope, `${name}: acknowledged scope`);
      assert.equal(await evaluate("return Boolean(document.querySelector('#live-map-route-inputs, #aircraft-profile-correction, #start-recording-btn, #end-flight-btn'));"), false, `${name}: desktop writes are not offered`);
      if (disconnected) {
        assert.equal(await evaluate('return workbenchTest.controls.availability.enabled;'), false, 'disconnected aircraft controls are unavailable');
        assert(await evaluate("return [...document.querySelectorAll('.live-map-readings dd')].slice(0,4).every(el => el.textContent.trim().startsWith('--'));"), 'disconnected map readings are clearly unavailable');
        assert(await evaluate("return document.querySelector('.live-map-readings').textContent.includes('Waiting for a connection');"), 'disconnected map states why telemetry is unavailable');
        assert.equal(await evaluate("return document.getElementById('device-pairing-request-btn').disabled;"), true, 'pairing waits for reconnection');
      } else if (scope === 'aircraft-control') {
        assert.equal(await evaluate('return workbenchTest.controls.availability.enabled;'), true, 'paired aircraft controls retain their existing permission');
      } else assert.equal(await evaluate('return workbenchTest.controls.availability.enabled;'), false, 'viewer cannot write aircraft controls');
      await capture(`${name}-flight`);
      await evaluate("await workbenchTest.open('timeline');"); await wait(100);
      assert.equal(await evaluate("return getComputedStyle(document.querySelector('.timeline-split')).display;"), 'none', `${name}: history is restricted`);
      await capture(`${name}-history`);
      await evaluate("await workbenchTest.open('settings');"); await wait(100);
      const usableSettings = await evaluate("return [...document.querySelectorAll('#settings-form input, #settings-form select, #settings-save-btn')].filter(el=>el.getClientRects().length && !el.disabled).map(el=>el.id);");
      assert.deepEqual(usableSettings, [], `${name}: unsupported settings mutation is not presented as usable`);
      assert.equal(await evaluate("return Boolean(document.querySelector('#settings-workspace, #setting-workspace'));"), false, 'remote devices have no retired workspace selector');
      assert(await evaluate("return Boolean(document.getElementById('settings-pc-managed-note'));"), `${name}: desktop settings explain where to manage them`);
      await evaluate("document.getElementById('settings-pc-managed-note').scrollIntoView({block:'end'});");
      await capture(`${name}-settings`);
      await evaluate("await workbenchTest.open('system'); document.getElementById('system-refresh-btn').click(); await workbenchTest.nextTick();");
      assert.equal(await evaluate("return Boolean(document.querySelector('#system-history-index, #system-start-all-btn, #system-device-pairing-requests'));"), false, `${name}: PC administration is not offered`);
      assert.deepEqual(await evaluate("return workbenchTest.sent.filter(message=>['requestHistoryIndexStatus','requestDevicePairingRequests','requestAppSettings'].includes(message.type));"), [], `${name}: remote view makes no privileged administration requests`);
      await capture(`${name}-phone-setup`);
    }
    // A real connection starts without authorization, then can grant or revoke it.
    // Keep the mounted fields and runtime bindings across this transition.
    win.setContentSize(1440, 900);
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
    await win.loadURL(`${new URL(process.env.FF_WORKBENCH_TEST_URL).origin}/remote?scope=unknown`);
    for (let n=0;n<180;n++) { if(await evaluate('return Boolean(window.workbenchTest);')) break; await wait(50); }
    await evaluate("await workbenchTest.open('settings'); window.originalSettingsField=document.getElementById('setting-recording-auto-start');");
    assert(await evaluate("return originalSettingsField.matches(':disabled') && !document.getElementById('settings-form').getClientRects().length;"), 'unknown authorization starts with desktop settings unavailable');
    await evaluate("await workbenchTest.authorize('full-control');"); await wait(80);
    assert(await evaluate("return originalSettingsField===document.getElementById('setting-recording-auto-start') && !originalSettingsField.matches(':disabled') && originalSettingsField.getClientRects().length > 0 && originalSettingsField.checked;"), 'acknowledged full control reveals the same bound settings fields with the received settings');
    await capture('authorization-granted-settings');
    await evaluate("await workbenchTest.open('system'); document.getElementById('system-refresh-btn').click(); await workbenchTest.nextTick();");
    assert(await evaluate("return Boolean(document.getElementById('system-history-index'));"), 'full control restores PC history maintenance');
    assert(await evaluate("return workbenchTest.sent.some(message=>message.type==='requestHistoryIndexStatus');"), 'full control requests available administration data');
    await evaluate("await workbenchTest.authorize('read-only','expired'); workbenchTest.sent.length=0; document.getElementById('system-refresh-btn').click(); await workbenchTest.nextTick();");
    await wait(2600);
    assert.deepEqual(await evaluate("return workbenchTest.sent.filter(message=>['requestHistoryIndexStatus','requestDevicePairingRequests','requestAppSettings'].includes(message.type));"), [], 'revocation stops manual and interval administration requests');
    assert.equal(await evaluate("return Boolean(document.getElementById('system-history-index'));"), false, 'revocation removes history maintenance');
    await evaluate("await workbenchTest.open('settings'); document.getElementById('settings-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); await workbenchTest.nextTick();");
    assert(await evaluate("return originalSettingsField===document.getElementById('setting-recording-auto-start') && originalSettingsField.matches(':disabled') && !originalSettingsField.getClientRects().length;"), 'revocation disables and hides the retained settings bindings');
    assert.equal(await evaluate("return workbenchTest.sent.some(message=>message.type==='saveAppSettings');"), false, 'revoked settings submit cannot send a save request');
    await capture('authorization-revoked-settings');
    assert.deepEqual(errors, [], 'no browser runtime or asset errors');
    fs.writeFileSync(path.join(OUTPUT, 'layout-results.json'), JSON.stringify(checks, null, 2));
    console.log(`App workbench passed: ${checks.length} populated views across ${SIZES.length} desktop, tablet and phone layouts; compact 3D replay, adaptive navigation, map, touch targets, view search, four remote states, muted telemetry and authorization grant/revocation. Screenshots: ${OUTPUT}`);
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    fs.writeFileSync(path.join(OUTPUT, 'layout-results.json'), JSON.stringify(checks, null, 2));
    await capture('failure');
    app.exit(1);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const css = fs.readFileSync(path.join(ROOT, 'frontend-dist/tailwind.css'), 'utf8');
  const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
  const profile = require(runtime('aircraft/aircraft-profile-loader.js')).loadProfile('bundled/msfs/pmdg-737');
  const { buildAircraftControlCapabilities } = require(runtime('aircraft/aircraft-control-service.js'));
  const capabilities = buildAircraftControlCapabilities(profile, { profileRevision: 1, capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event', 'lvar'], integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] } });
  const integration = require(runtime('aircraft/aircraft-integrations/index.js')).defaultAircraftIntegrationRegistry.getById('pmdg-737');
  const values = Object.fromEntries(Object.values(integration.fields).map(field => {
    const decode = field.sources[0]?.decode;
    return [field.id, decode?.type === 'boolean' ? false : decode?.type === 'enum' ? Object.values(decode.values)[0] : 0];
  }));
  Object.assign(values, { 'aircraft.model': '737-800', 'mcp.headingDeg': 221, 'mcp.altitudeFt': 34000, 'mcp.speed': 284, 'mcp.courseCaptainDeg': 160, 'mcp.courseFirstOfficerDeg': 160, 'radios.nav1ActiveMhz': 109.7, 'radios.nav1StandbyMhz': 110.3 });
  Object.assign(values, { 'systems.electrical.batteryMode': 'on', 'systems.electrical.standbyPowerMode': 'auto',
    'systems.electrical.busTransferAuto': true, 'systems.electrical.transferBus1Powered': true, 'systems.electrical.transferBus2Powered': true,
    'systems.irs.leftMode': 'nav', 'systems.irs.rightMode': 'nav', 'systems.irsAligned': true, 'systems.apuMode': 'off' });
  const { createViteTestServer } = require('./vite-test-server');
  const { default: vue } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  const server = await createViteTestServer({ configFile: false, root: ROOT, logLevel: 'error', cacheDir: path.join(OUTPUT, 'vite-cache'),
    optimizeDeps: { entries: ['tests/fixtures/app-workbench-browser.js'] },
    plugins: [vue(), { name: 'workbench-fixture', configureServer(vite) {
      vite.middlewares.use('/workbench-tailwind.css', (_req, res) => { res.setHeader('Content-Type', 'text/css'); res.end(css); });
      vite.middlewares.use('/workbench-fixture', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ capabilities, values })); });
      vite.middlewares.use('/remote', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(ROOT, 'tests/fixtures/app-workbench-browser.html'), 'utf8')); });
      vite.middlewares.use('/assets', (req, res, next) => { const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''); const asset = path.resolve(ROOT, 'frontend/assets', name); const root = path.resolve(ROOT, 'frontend/assets');
        if (!asset.startsWith(`${root}${path.sep}`) || !fs.existsSync(asset) || !fs.statSync(asset).isFile()) return next();
        res.setHeader('Content-Type', asset.endsWith('.svg') ? 'image/svg+xml' : asset.endsWith('.png') ? 'image/png' : asset.endsWith('.webp') ? 'image/webp' : 'application/octet-stream'); res.end(fs.readFileSync(asset)); });
    } }], resolve: { alias: { '/assets': path.join(ROOT, 'frontend/assets'), vue: path.join(ROOT, 'frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'), pinia: path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs'), leaflet: path.join(ROOT, 'frontend/node_modules/leaflet') } },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  await server.listen();
  try {
    const env = { ...process.env, FF_WORKBENCH_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/app-workbench-browser.html` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    // Native input and lifecycle checks now run alongside all eight layouts.
    // Leave headroom for a cold browser in the full pre-commit/CI suite.
    const timeoutMs = 180000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(timedOut, false, `full application workbench browser checks exceeded ${timeoutMs / 1000}s`);
    assert.equal(code, 0, 'full application workbench browser checks');
  } finally { await server.close(); }
}
(process.versions.electron ? browser() : main()).catch(error => { console.error(error); process.exit(1); });
