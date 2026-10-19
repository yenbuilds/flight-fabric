'use strict';
const assert = require('node:assert/strict');

module.exports = async function checkOnboarding({ win, evaluate, capture, wait, fixtureUrl }) {
  // Check the actual SVG documents so reduced motion is verified inside the
  // image, not just on its parent element. No wall-clock animation assertions.
  for (const artwork of ['voice', 'recording', 'toolbar']) {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await win.loadURL(new URL(`/frontend/assets/onboarding/${artwork}.svg`, fixtureUrl).href);
    const timing = await evaluate('return document.getAnimations().map(a => { const t=a.effect.getTiming(); return { duration:t.duration, iterations:t.iterations, delay:t.delay }; });');
    assert(timing.length > 0, `${artwork}: the illustration has its intended motion`);
    assert(timing.every(t => Number.isFinite(t.iterations) && t.delay + t.duration * t.iterations <= 4000), `${artwork}: motion settles within four seconds`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate('return document.getAnimations().length;'), 0, `${artwork}: reduced motion produces a static illustration`);
    if (artwork === 'recording') assert.equal(await evaluate('return getComputedStyle(document.querySelector(".saved")).opacity;'), '1', 'the saved badge stays visible with reduced motion');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await win.loadURL(new URL(`/frontend/assets/onboarding/${artwork}.svg?motion=still#still`, fixtureUrl).href);
    assert.equal(await evaluate('return document.getAnimations().length;'), 0, `${artwork}: the explicit static source does not depend on inherited media preferences`);
  }
  // Capture the settled artwork while exercising setup; the animation checks
  // above independently cover users who have not requested reduced motion.
  const isOpen = () => evaluate("return document.querySelector('.onboarding-dialog').matches(':modal');");
  async function load(query = '', width = 1440, height = 900, remote = false) {
    const url = new URL(fixtureUrl);
    if (remote) url.pathname = '/remote';
    url.search = `?onboarding=1&${query}`;
    win.setContentSize(width, height);
    await win.loadURL(url.href);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (let n = 0; n < 180 && !await evaluate('return Boolean(window.workbenchTest);'); n++) await wait(50);
    assert(await evaluate('return Boolean(window.workbenchTest);'), 'setup fixture mounted');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait(80);
  }
  async function key(name, code, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code, modifiers });
    }
    await wait(30);
  }
  async function click(selector, touch = false, count = 1) {
    const point = await evaluate(`const el=document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
    for (let n = 0; n < count; n++) {
      if (touch) {
        for (const type of ['touchStart', 'touchEnd']) await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? [point] : [] });
      } else {
        for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: n + 1 });
      }
    }
    await wait(50);
  }
  const next = '.onboarding-actions button[type="submit"]';
  const back = '.onboarding-actions button[type="button"]';
  const voiceOn = '[name="onboarding-voice"][value="true"]';
  const voiceOff = '[name="onboarding-voice"][value="false"]';
  const automatic = '[name="onboarding-recording"][value="true"]';
  const manual = '[name="onboarding-recording"][value="false"]';
  const install = '[data-onboarding-toolbar-action]';
  const keepVoice = '[name="onboarding-voice-unavailable"]';
  const toolbarNow = '[name="onboarding-toolbar"][value="install"]';
  const toolbarLater = '[name="onboarding-toolbar"][value="later"]';
  async function toolbarStep(choice = toolbarLater) {
    await click(next);
    await click(next);
    await click(choice);
  }
  async function assertCompletionBlocked(label) {
    const title = await evaluate('return document.getElementById("onboarding-title").textContent;');
    assert(await evaluate(`return document.querySelector(${JSON.stringify(next)}).disabled;`), `${label}: finish is disabled until the selected setup is ready`);
    await click(next);
    await key('Enter', 13);
    await evaluate('document.querySelector(".onboarding-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); await workbenchTest.nextTick();');
    assert.equal(await evaluate('return document.getElementById("onboarding-title").textContent;'), title, `${label}: clicks, Enter and form submission cannot bypass incomplete setup`);
    assert.equal(await evaluate('return workbenchTest.setupFixture.requests.length;'), 0, `${label}: incomplete setup cannot write completion`);
    assert(await isOpen(), `${label}: incomplete setup keeps the app modal`);
  }
  async function checkGeometry(name, width, height) {
    const artwork = await evaluate("const img=document.querySelector('.onboarding-illustration img'); await img.decode(); return {loaded:img.naturalWidth>0,src:img.currentSrc,source:img.previousElementSibling.srcset,reduced:matchMedia('(prefers-reduced-motion:reduce)').matches};");
    assert(artwork.loaded && artwork.src.endsWith('#still'), `${name}: the local image loads its static version for reduced motion: ${JSON.stringify(artwork)}`);
    const geometry = await evaluate(`const d=document.querySelector('.onboarding-dialog'),r=d.getBoundingClientRect(); const b=document.querySelector('.onboarding-actions button[type="submit"]').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:d.scrollWidth>d.clientWidth+1,buttonHeight:b.height,buttonVisible:b.top>=r.top&&b.bottom<=r.bottom};`);
    assert(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= height, `${name}: dialog fits ${JSON.stringify(geometry)}`);
    assert.equal(geometry.overflow, false, `${name}: no horizontal scrolling`);
    assert(geometry.buttonHeight >= 44, 'finish has a touch target');
    assert(geometry.buttonVisible, `${name}: the next action stays visible while instructions scroll`);
  }

  async function assertSavedSettings(voiceEnabled, autoStart) {
    await evaluate("workbenchTest.whatsNew.dismiss(); await workbenchTest.open('settings');");
    assert.deepEqual(await evaluate(`return {
      savedVoice: workbenchTest.voice.runtime.enabled,
      savedRecording: workbenchTest.settings.settings.recording.autoStart,
      editorRecording: workbenchTest.settingsEditor.recordingAutoStart,
      recordingCheckbox: document.getElementById('setting-recording-auto-start').checked,
      voiceSwitch: document.querySelector('[data-voice-recognition-toggle] input').checked,
    };`), {
      savedVoice: voiceEnabled, savedRecording: autoStart, editorRecording: autoStart,
      recordingCheckbox: autoStart, voiceSwitch: voiceEnabled,
    }, 'saved values and both normal Settings controls match the intro selections');
    await click('#settings-show-intro');
    assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceEnabled ? voiceOn : voiceOff)}).checked;`), 'reopened intro restores the saved voice selection');
    await click(next);
    assert(await evaluate(`return document.querySelector(${JSON.stringify(autoStart ? automatic : manual)}).checked;`), 'reopened intro restores the saved recording selection');
    await click('[data-close-intro]');
  }

  for (const choice of ['waiting', 'keep', 'back']) {
    await load('delayVoice=1&firstVoicePreference=1&toolbar=1');
    assert(await evaluate(`return document.querySelector(${JSON.stringify(keepVoice)}).checked;`), 'pending desktop preferences keep the current choice');
    if (choice === 'keep') await click(keepVoice);
    if (choice === 'back') {
      await click(next);
      await click(back);
    }
    await evaluate('workbenchTest.voice.applyRuntimeInfo({enabled:false,needsInitialPreference:true,available:false}); await workbenchTest.nextTick();');
    assert.equal(await evaluate(`return document.querySelector(${JSON.stringify(voiceOn)}).checked;`), choice === 'waiting', `late voice reply must preserve an explicit Keep current or Next/Back choice (${choice})`);
    assert.equal(await evaluate('return workbenchTest.voice.runtime.enabled;'), false, 'a late default selection cannot activate recognition');
    await toolbarStep();
    await click(next);
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites;'), [
      { value: choice === 'waiting', options: { requestMicrophoneAccess: false } },
    ], 'finishing saves the reviewed choice after a delayed desktop reply');
    await evaluate('await workbenchTest.completeSetupSave();');
  }

  await load('firstVoicePreference=1&toolbar=1');
  await toolbarStep();
  await evaluate('workbenchTest.setupFixture.deferVoiceSave=true;');
  await click(next, false, 2);
  await key('Enter', 13);
  await evaluate('document.querySelector(".onboarding-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); await workbenchTest.nextTick();');
  assert.equal(await evaluate('return workbenchTest.setupFixture.voiceWrites.length;'), 1, 'slow initial enablement admits only one save across clicks, Enter and submit');
  assert.equal(await evaluate('return workbenchTest.setupFixture.requests.length;'), 0, 'completion waits for the pending native preference save');
  assert(await evaluate(`return document.querySelector(${JSON.stringify(back)}).disabled;`), 'Back cannot change the draft while the voice save is pending');
  await evaluate('workbenchTest.voice.applyRuntimeInfo({enabled:true,needsInitialPreference:false,available:true}); await workbenchTest.nextTick();');
  assert(await isOpen(), 'an early runtime broadcast does not finish setup');
  assert.equal(await evaluate('return workbenchTest.settingsUi.initialSetupReady;'), false, 'recognition becoming ready cannot unlock input before completion');
  await evaluate('workbenchTest.setupFixture.finishVoiceSave();');
  for (let attempt = 0; attempt < 100 && !await evaluate('return workbenchTest.setupFixture.requests.length;'); attempt++) await wait(10);
  assert.equal(await evaluate('return workbenchTest.setupFixture.requests.length;'), 1, 'the completed native save advances to one backend save');
  await evaluate('await workbenchTest.completeSetupSave(false);');
  assert(await isOpen(), 'a later backend failure leaves setup open');
  await click(next);
  assert.equal(await evaluate('return workbenchTest.setupFixture.voiceWrites.length;'), 1, 'retrying completion does not repeat the successful native enablement');
  await evaluate('await workbenchTest.completeSetupSave();');
  assert.equal(await isOpen(), false);

  // Hold startup replies independently. Native input must not reach the app
  // before we know whether this PC still needs its initial preferences.
  for (const [name, width, height, touch] of [['desktop', 1440, 900, false], ['phone', 320, 700, true]]) {
    await load('delaySettings=1&delayAuthorization=1', width, height);
    assert(await isOpen(), `${name}: startup is modal before either reply arrives`);
    assert.equal(await evaluate('return workbenchTest.settingsUi.initialSetupReady;'), false, 'global voice input waits for resolved setup');
    const initialTab = await evaluate('return workbenchTest.tabs.activeTabId;');
    assert.match(await evaluate("return document.querySelector('.onboarding-dialog').textContent;"), /Loading your preferences/);
    assert.equal(await evaluate("return Boolean(document.querySelector('[data-start-service]'));"), false, 'browsers cannot invoke desktop service actions');
    assert.equal(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), false, 'ordinary startup does not suggest a connection failure');
    assert(await evaluate('const d=document.querySelector(".onboarding-dialog"),r=d.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.scrollWidth<=d.clientWidth+1;'), 'loading fits without horizontal scrolling');
    assert(await evaluate('const indicator=document.querySelector(".onboarding-loading-indicator"); return indicator.getAttribute("aria-hidden")==="true" && getComputedStyle(indicator).pointerEvents==="none";'), 'the loading indicator leaves announcements and input to the existing status message');
    assert.equal(await evaluate('return document.querySelector(".onboarding-loading-indicator").getAnimations().length;'), 0, 'reduced motion keeps the loading indicator still');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    assert(await evaluate('return document.querySelector(".onboarding-loading-indicator").getAnimations().some(a=>a.playState==="running");'), 'ordinary loading visibly signals activity');
    await capture(`${name}-onboarding-loading-motion`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await capture(`${name}-onboarding-loading`);
    await click(width > 700 ? '.desktop-tab[data-tab="settings"]' : '.mobile-tab[data-tab="autopilot"]', touch);
    await key('k', 75, 2);
    await key('Escape', 27);
    await key('Tab', 9);
    assert.equal(await evaluate('return workbenchTest.tabs.activeTabId;'), initialTab, 'navigation cannot get ahead of setup');
    assert.equal(await evaluate('return workbenchTest.shell.navigatorOpen;'), false, 'keyboard navigation cannot open over startup');
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.requests;'), [], 'startup never writes guessed preferences');
    assert(await evaluate("return !!document.activeElement.closest('.onboarding-dialog');"), 'startup retains keyboard focus');
    assert.equal(await evaluate("return localStorage.getItem('ff_whats_new_seen_v1');"), null, 'welcome cards also wait for the startup decision');
    // Exercise both arrival orders without relying on an arbitrary network delay.
    const settingsFirst = name === 'desktop';
    await evaluate(settingsFirst ? 'workbenchTest.deliverSettings();' : 'workbenchTest.deliverAuthorization();');
    assert(await isOpen(), 'one startup reply cannot unlock the app');
    assert.match(await evaluate("return document.getElementById('onboarding-intro').textContent;"), /Loading your preferences/, 'both replies are needed to choose setup or completed');
    await evaluate(settingsFirst ? 'workbenchTest.deliverAuthorization();' : 'workbenchTest.deliverSettings();');
    assert(await isOpen(), 'incomplete preferences transition straight into setup');
    assert.equal(await evaluate('return document.activeElement.id;'), 'onboarding-title');
    assert.match(await evaluate("return document.getElementById('onboarding-title').textContent;"), /Fly with your voice/);
  }

  await load('completed=1&delaySettings=1&delayAuthorization=1');
  assert(await isOpen(), 'returning users wait for their saved completion');
  await evaluate('workbenchTest.deliverAuthorization();');
  assert(await isOpen(), 'authorization alone does not skip the saved completion check');
  await evaluate('workbenchTest.deliverSettings();');
  assert.equal(await isOpen(), false, 'saved completion unlocks the app without showing setup');
  await click('.desktop-tab[data-tab="settings"]');
  assert.equal(await evaluate('return workbenchTest.tabs.activeTabId;'), 'settings', 'navigation works after the startup decision');
  await evaluate('workbenchTest.setupFixture.authorizationDelivered=false; workbenchTest.profiles.resetAuthorizationScope(); workbenchTest.settings.apply({settings:null});');
  assert.equal(await isOpen(), false, 'later reconnects do not reopen the startup gate');

  await load('delaySettings=1&delayAuthorization=1&disconnected=1', 320, 700);
  // The service can still be starting when the first socket attempt fails.
  // Automatic retries must not flash recovery controls or failure wording.
  for (const state of ['disconnected', 'connecting', 'error', 'disconnected', 'connecting', 'ready']) {
    await evaluate(`workbenchTest.status.setWebsocket(${JSON.stringify(state)}); await workbenchTest.nextTick();`);
    assert.equal(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), false, `${state}: transient startup states keep retry hidden`);
    assert.match(await evaluate("return document.getElementById('onboarding-intro').textContent;"), /^Loading your preferences…$/);
    assert(await isOpen(), `${state}: unknown preferences still block the app`);
  }
  await capture('phone-onboarding-startup-disconnected');
  await key('Tab', 9);
  assert.equal(await evaluate('return document.activeElement.id;'), 'onboarding-title', 'buttonless loading retains keyboard focus');
  assert.equal(await evaluate('return workbenchTest.setupFixture.reconnects;'), 0, 'transient states do not dispatch manual reconnects');
  await evaluate("await workbenchTest.authorize('full-control');");
  assert.match(await evaluate("return document.getElementById('onboarding-title').textContent;"), /Fly with your voice/, 'recovery continues to setup');

  // A socket can be connected while authorization or settings never arrive.
  // Exercise the actual presentation deadline, without declaring setup done.
  await load('completed=1&delaySettings=1&delayAuthorization=1');
  assert.equal(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), false);
  // The connection owner allows ten seconds for bootstrap/socket opening,
  // then retries after three seconds. Eight seconds can still be ordinary
  // pending work, for which a manual reconnect would be ignored by that owner.
  await wait(8200);
  assert.equal(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), false, 'recovery stays hidden while the initial connection can still be pending');
  for (let n = 0; n < 200 && !await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"); n++) await wait(100);
  assert(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), 'prolonged startup offers manual recovery');
  assert.match(await evaluate("return document.getElementById('onboarding-intro').textContent;"), /taking longer than usual/);
  assert(await isOpen(), 'the recovery deadline never unlocks unknown preferences');
  await capture('desktop-onboarding-startup-slow');
  await click('[data-reconnect]', false, 2);
  assert.equal(await evaluate('return workbenchTest.setupFixture.reconnects;'), 1, 'a rapid double click dispatches one manual reconnect');
  assert.equal(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), false, 'a manual retry resets the slow-start deadline');
  assert.equal(await evaluate('return document.activeElement.id;'), 'onboarding-title', 'hiding the retry action restores loading focus');
  await key('Tab', 9);
  assert.equal(await evaluate('return document.activeElement.id;'), 'onboarding-title', 'retry retains keyboard focus while no action is shown');
  await evaluate("workbenchTest.status.setWebsocket('error'); await workbenchTest.nextTick();");
  assert.equal(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), false, 'a fresh connection error cannot bypass the new grace period');
  assert.match(await evaluate("return document.getElementById('onboarding-intro').textContent;"), /^Loading your preferences…$/);
  // Continued failure still needs a recovery action once the fresh wait ends.
  for (let n = 0; n < 200 && !await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"); n++) await wait(100);
  assert(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), 'persistent failure offers recovery after the new deadline');
  assert(await isOpen(), 'persistent failure never bypasses the startup gate');
  await evaluate("await workbenchTest.authorize('full-control');");
  assert.equal(await isOpen(), false, 'late saved completion resolves the slow-start gate');

  await load('scope=read-only&delayAuthorization=1&delaySettings=1');
  assert(await isOpen(), 'an unacknowledged default scope is still unresolved');
  await evaluate('workbenchTest.deliverAuthorization();');
  assert.equal(await isOpen(), false, 'confirmed viewers do not wait for private PC preferences');
  await click('.desktop-tab[data-tab="autopilot"]');
  await evaluate('workbenchTest.setupFixture.authorizationDelivered=false; workbenchTest.emitWsClose();');
  assert.equal(await isOpen(), false, 'a confirmed viewer stays usable during subsequent reconnects');
  await click('.desktop-tab[data-tab="settings"]');
  assert.equal(await evaluate('return workbenchTest.tabs.activeTabId;'), 'settings', 'viewer navigation remains available offline');
  await evaluate('workbenchTest.deliverAuthorization();');
  assert.equal(await isOpen(), false, 'viewer reconnection does not reopen setup');
  await load('scope=aircraft-control&delayAuthorization=1&delaySettings=1', 320, 700, true);
  assert.equal(await isOpen(), false, 'remote viewers bypass even the pending startup gate');

  // A stopped desktop service cannot be repaired by reconnecting its socket.
  // Keep the existing native start action reachable before preferences load.
  for (const [state, width, touch] of [['stopped', 1440, false], ['error', 320, true]]) {
    await load(`service=${state}&delaySettings=1&delayAuthorization=1`, width, 700);
    const start = '.onboarding-loading [data-start-service]';
    assert(await evaluate(`return Boolean(document.querySelector(${JSON.stringify(start)}));`), `${state}: startup exposes native service recovery`);
    assert.equal(await evaluate('return Boolean(document.querySelector(".onboarding-loading-indicator"));'), false, 'a stopped service does not imply ongoing loading activity');
    assert.equal(await evaluate("return Boolean(document.querySelector('[data-reconnect]'));"), false, 'a stopped service offers Start service instead of socket retry');
    assert.equal(await evaluate('return workbenchTest.serviceFixture.starts;'), 0, 'viewing recovery never starts a service automatically');
    await evaluate(`workbenchTest.serviceFixture.failStart=${state === 'stopped'}; workbenchTest.serviceFixture.returnFalse=${state === 'error'}; workbenchTest.serviceFixture.deferStart=true;`);
    await click(start, touch);
    await click(start, touch);
    assert(await evaluate('return Boolean(document.querySelector(".onboarding-loading-indicator"));'), 'starting the service restores the activity indicator');
    assert.equal(await evaluate('return workbenchTest.serviceFixture.starts;'), 1, 'pending native start is not duplicated');
    assert(await isOpen(), 'pending recovery keeps unknown preferences blocked');
    await evaluate('workbenchTest.serviceFixture.finishStart();');
    await wait(50);
    assert.match(await evaluate("return document.querySelector('.onboarding-loading [role=alert]').textContent;"), /could not start|did not start/);
    assert(await evaluate("return document.activeElement.matches('.onboarding-loading [role=alert]');"), 'recovery error receives focus');
    await capture(`onboarding-service-${state}-${width}`);
    await evaluate('workbenchTest.serviceFixture.failStart=false; workbenchTest.serviceFixture.returnFalse=false; workbenchTest.serviceFixture.deferStart=false;');
    await click(start, touch);
    assert.equal(await evaluate('return workbenchTest.serviceFixture.starts;'), 2, 'failed native recovery can be retried');
    assert.equal(await evaluate('return workbenchTest.setupFixture.reconnects;'), 1, 'successful service start reconnects the waiting app');
    assert(await isOpen(), 'starting the service does not assume setup is complete');
    await evaluate("await workbenchTest.authorize('full-control');");
    assert.match(await evaluate("return document.getElementById('onboarding-title').textContent;"), /Fly with your voice/);
  }

  for (const failStart of [false, true]) {
    await load('service=stopped&delaySettings=1&delayAuthorization=1');
    await evaluate(`workbenchTest.serviceFixture.deferStart=true; workbenchTest.serviceFixture.failStart=${failStart};`);
    await click('.onboarding-loading [data-start-service]');
    // Settings can arrive while the native action is still refreshing status.
    await evaluate("await workbenchTest.authorize('full-control');");
    await click(voiceOff);
    await click(next);
    await click(manual);
    await evaluate('workbenchTest.serviceFixture.finishStart();');
    await wait(50);
    assert.equal(await evaluate('return workbenchTest.setupFixture.reconnects;'), 0, 'late native completion must not restart the recovered connection');
    assert.match(await evaluate("return document.getElementById('onboarding-title').textContent;"), /Choose how flights are recorded/);
    assert(await evaluate(`return document.querySelector(${JSON.stringify(manual)}).checked && document.activeElement.matches(${JSON.stringify(manual)});`), 'late native success or failure preserves the new setup choice and focus');
  }

  // Closing the UI retires its recovery continuation, even though an accepted
  // native service start can still finish. Exercise both terminal outcomes.
  for (const failStart of [false, true]) {
    await load('service=stopped&delaySettings=1&delayAuthorization=1');
    await evaluate(`workbenchTest.serviceFixture.deferStart=true; workbenchTest.serviceFixture.failStart=${failStart};`);
    await click('.onboarding-loading [data-start-service]');
    await evaluate(`window.retiredStartupDialog=document.querySelector('.onboarding-dialog');
      await workbenchTest.unmount();
      const probe=document.createElement('button'); probe.id='after-startup-close'; probe.textContent='Continue';
      probe.addEventListener('click',()=>{probe.dataset.clicked='true';}); document.body.append(probe); probe.focus();`);
    assert(await evaluate("return !window.retiredStartupDialog.open && !document.querySelector('.onboarding-dialog');"), 'unmount closes and removes the native dialog');
    assert.equal(await evaluate('return workbenchTest.serviceFixture.listeners.size;'), 0, 'host status subscription is released with the app');
    await evaluate('workbenchTest.serviceFixture.finishStart();');
    for (let n = 0; n < 100 && await evaluate('return workbenchTest.systemHost.isBusy;'); n++) await wait(10);
    assert.equal(await evaluate('return workbenchTest.systemHost.isBusy;'), false, 'the accepted host action settles after UI closure');
    assert.equal(await evaluate('return workbenchTest.setupFixture.reconnects;'), 0, 'retired recovery never reconnects');
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.requests;'), [], 'closing startup never writes preferences');
    assert.equal(await evaluate('return document.activeElement.id;'), 'after-startup-close', 'late recovery leaves the current focus alone');
    await click('#after-startup-close');
    assert.equal(await evaluate("return document.querySelector('#after-startup-close').dataset.clicked;"), 'true', 'removed startup no longer blocks native input');
  }

  for (const [name, width, height, touch] of [
    ['desktop', 1440, 900, false], ['phone', 390, 844, true], ['phone-narrow', 320, 700, true], ['landscape', 700, 360, true],
  ]) {
    const existing = name === 'desktop';
    await load(existing ? 'toolbar=1&voiceEnabled=1&autoStart=0' : 'toolbar=1&firstVoicePreference=1', width, height);
    assert(await isOpen(), `${name}: incomplete setup is mandatory`);
    assert.equal(await evaluate("return localStorage.getItem('ff_whats_new_seen_v1');"), null, 'other welcome cards wait for setup');
    assert.equal(await evaluate('return document.activeElement.id;'), 'onboarding-title');
    assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceOn)}).checked;`), 'voice is recommended on a fresh install and preserves saved On');
    assert.equal(await evaluate('return workbenchTest.voice.runtime.enabled;'), existing, 'a proposed default cannot activate voice before finishing');
    await key('Escape', 27);
    assert(await isOpen(), 'Escape cannot dismiss setup');
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: 1, y: 1, button: 'left', clickCount: 1 });
    assert(await isOpen(), 'backdrop cannot dismiss setup');
    for (let index = 0; index < 7; index++) {
      await key('Tab', 9, index > 3 ? 8 : 0);
      assert(await evaluate("return !!document.activeElement.closest('.onboarding-dialog');"), 'native keyboard focus remains in the modal');
    }
    await checkGeometry(`${name} voice`, width, height);
    await capture(`${name}-onboarding-voice`);
    await click(existing ? voiceOff : voiceOn, touch);
    await click(next, touch);
    assert(await evaluate(`return document.querySelector(${JSON.stringify(existing ? manual : automatic)}).checked;`), 'recording defaults to automatic on a fresh install and preserves an existing saved choice');
    await click(back, touch);
    assert.equal(await evaluate(`return document.querySelector(${JSON.stringify(voiceOn)}).checked;`), !existing, 'Back preserves the chosen voice preference');
    await click(next, touch);
    await click(existing ? automatic : manual, touch);
    assert(await evaluate("return document.querySelector('.onboarding-dialog').textContent.includes('Restart FlightFabric');"), 'recording restart requirement is explained before saving');
    await checkGeometry(name, width, height);
    await capture(`${name}-onboarding-recording`);
    await click(next, touch);
    assert.match(await evaluate('return document.getElementById("onboarding-title").textContent;'), /MSFS/);
    assert.equal(await evaluate("return document.querySelector('.onboarding-main').scrollTop;"), 0, 'changing steps restores the introduction and progress to the top');
    assert.equal(await evaluate('return workbenchTest.setupFixture.requests.length;'), 0, 'toolbar explanation comes before saving completion');
    assert.match(await evaluate("return document.querySelector('.onboarding-toolbar').textContent;"), /Close MSFS/);
    assert(await evaluate(`return document.querySelector(${JSON.stringify(toolbarLater)}).checked;`), 'toolbar installation is deferred by default');
    await click(back, touch);
    assert.equal(await evaluate(`return document.querySelector(${JSON.stringify(automatic)}).checked;`), existing, 'Back from toolbar keeps recording choice');
    await click(next, touch);
    await click(toolbarLater, touch);
    await checkGeometry(`${name} toolbar`, width, height);
    await capture(`${name}-onboarding-toolbar`);
    await click(next, touch);
    assert.deepEqual(await evaluate('return workbenchTest.toolbarFixture.writes;'), [], 'finishing does not implicitly install the optional toolbar');
    assert(await isOpen(), 'send success alone cannot close setup');
    assert(await evaluate("return document.querySelector('.onboarding-actions button[type=submit]').disabled;"));
    const requests = await evaluate('return workbenchTest.setupFixture.requests;');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].patch, { onboarding: { completed: true }, recording: { autoStart: existing } });
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites;'), [{ value: !existing, options: { requestMicrophoneAccess: false } }]);
    await evaluate("workbenchTest.emitAppSettingsSaved({requestId:'unrelated',ok:true});await workbenchTest.nextTick();");
    assert(await isOpen(), 'unrelated save acknowledgements cannot dismiss setup');
    await evaluate('await workbenchTest.completeSetupSave(false);');
    assert(await isOpen(), 'failed disk write retains setup');
    assert.equal(await evaluate('return workbenchTest.settingsUi.initialSetupReady;'), false, 'saving voice alone does not unlock input when setup fails');
    assert.match(await evaluate("return document.querySelector('.onboarding-error').textContent;"), /Disk is full/);
    assert(await evaluate("const e=document.querySelector('.onboarding-error').getBoundingClientRect(),d=document.querySelector('.onboarding-dialog').getBoundingClientRect();return e.top>=d.top&&e.bottom<=d.bottom;"), 'save errors are scrolled into view, including on narrow phones');
    await capture(`${name}-onboarding-save-failed`);
    await click(next, touch);
    assert.equal(await evaluate('return workbenchTest.setupFixture.voiceWrites.length;'), 1, 'retry does not repeat the successful voice write');
    await evaluate('workbenchTest.settings.apply({settings:{...workbenchTest.settings.settings,onboarding:{completed:true}}});await workbenchTest.nextTick();');
    assert(await isOpen(), 'a broadcast arriving before the save acknowledgement does not close the pending dialog');
    assert.equal(await evaluate('return workbenchTest.settingsUi.initialSetupReady;'), false, 'an early completion broadcast cannot unlock global voice input');
    assert.equal(await evaluate("return localStorage.getItem('ff_whats_new_seen_v1');"), null, 'completion broadcast does not mark welcome cards seen behind the still-pending dialog');
    await evaluate('await workbenchTest.completeSetupSave();');
    assert.equal(await isOpen(), false, 'matching durable success closes setup');
    assert.equal(await evaluate('return workbenchTest.settingsUi.initialSetupReady;'), true, 'confirmed completion unlocks input with the modal');
    // The existing welcome flow uses the asynchronous browser Web Locks API.
    for (let attempt = 0; attempt < 80 && !await evaluate("return Boolean(localStorage.getItem('ff_whats_new_seen_v1'));" ); attempt++) await wait(25);
    assert(await evaluate("return Boolean(localStorage.getItem('ff_whats_new_seen_v1'));"), `welcome flow resumes after the modal closes: ${JSON.stringify(await evaluate("return {version:workbenchTest.settingsUi.aboutVersion,display:workbenchTest.whatsNew.displayAllowed,open:workbenchTest.whatsNew.open,title:workbenchTest.whatsNew.version};"))}`);
  }

  // Accepting the proposed defaults still requires all three screens and a
  // confirmed final save. Existing preferences must not be reset by defaults.
  for (const [query, enabled, autoStart, needsInitialPreference] of [
    ['firstVoicePreference=1', true, true, true],
    ['voiceEnabled=0', false, true, false],
    ['voiceEnabled=1&autoStart=0', true, false, false],
  ]) {
    await load(`${query}&toolbar=1`);
    for (const [choice, title] of [[enabled ? voiceOn : voiceOff, /Fly with your voice/],
      [autoStart ? automatic : manual, /Choose how flights are recorded/], [toolbarLater, /MSFS/]]) {
      assert(await isOpen(), 'preselected preferences never dismiss mandatory setup');
      assert.match(await evaluate('return document.getElementById("onboarding-title").textContent;'), title);
      assert(await evaluate(`return document.querySelector(${JSON.stringify(choice)}).checked;`));
      assert.equal(await evaluate('return workbenchTest.setupFixture.requests.length;'), 0, 'visiting a step does not write completion');
      assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites;'), [], 'visiting a step does not activate voice or save a preference');
      await click(next);
    }
    assert(await isOpen(), 'finishing with defaults waits for the save acknowledgement');
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.requests.map(request=>request.patch);'), [{ onboarding: { completed: true } }], 'accepting current preferences saves only completion');
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites;'), needsInitialPreference
      ? [{ value: true, options: { requestMicrophoneAccess: false } }] : [], 'only a new voice default is saved; existing choices are preserved');
    assert.deepEqual(await evaluate('return workbenchTest.toolbarFixture.writes;'), [], 'the toolbar default never installs implicitly');
    await evaluate('await workbenchTest.completeSetupSave();');
    assert.equal(await isOpen(), false);
    await assertSavedSettings(enabled, autoStart);
  }

  await load('firstVoicePreference=1&toolbar=1', 320, 700);
  await click(voiceOff, true);
  await toolbarStep();
  await click(next, true);
  assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites;'), [
    { value: false, options: { requestMicrophoneAccess: false } },
  ], 'choosing Off on first setup persists the choice even though recognition has not started');
  await evaluate('await workbenchTest.completeSetupSave();');
  await assertSavedSettings(false, true);

  await load('voiceUnavailable=1&firstVoicePreference=1&toolbar=1');
  await click(next);
  await evaluate('workbenchTest.voice.setBridgeAvailable(true); workbenchTest.voice.applyRuntimeInfo({enabled:false,needsInitialPreference:true,available:false}); await workbenchTest.nextTick();');
  await click(back);
  assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceOff)}).checked;`), 'a late first preference cannot enable voice after the user continued with Keep current');
  await toolbarStep();
  await click(next);
  assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites;'), [
    { value: false, options: { requestMicrophoneAccess: false } },
  ], 'the late first preference saves Off without microphone access');
  await evaluate('await workbenchTest.completeSetupSave();');

  await load('firstVoicePreference=1&completed=1&voiceUnavailable=1');
  await evaluate("workbenchTest.whatsNew.dismiss(); await workbenchTest.open('settings');");
  await click('#settings-show-intro');
  await evaluate('workbenchTest.voice.setBridgeAvailable(true); workbenchTest.voice.applyRuntimeInfo({enabled:false,needsInitialPreference:true,available:false}); await workbenchTest.nextTick();');
  assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceOff)}).checked;`), 'replay preserves current Off even when previously absent voice settings arrive late');
  await click('[data-close-intro]');

  // Exercise every independent boolean combination, starting from its opposite
  // so the UI must actually send both changes. Check normal Settings and a new
  // intro visit as consumers, not only the outgoing save request.
  for (const voiceEnabled of [false, true]) {
    for (const autoStart of [false, true]) {
      await load(`voiceEnabled=${Number(!voiceEnabled)}&autoStart=${Number(!autoStart)}&toolbar=1`);
      await click(voiceEnabled ? voiceOn : voiceOff);
      await click(next);
      await click(autoStart ? automatic : manual);
      await click(next);
      await click(next);
      assert.deepEqual(await evaluate('return workbenchTest.setupFixture.requests[0].patch;'), {
        onboarding: { completed: true }, recording: { autoStart },
      }, 'the selected recording value reaches the save boundary unchanged');
      assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites;'), [
        { value: voiceEnabled, options: { requestMicrophoneAccess: false } },
      ], 'the selected voice value reaches its preference owner unchanged');
      await evaluate('await workbenchTest.completeSetupSave();');
      assert.equal(await isOpen(), false);
      await assertSavedSettings(voiceEnabled, autoStart);
    }
  }

  await load('voiceEnabled=1&autoStart=0');
  await click(voiceOff);
  await toolbarStep();
  await evaluate('workbenchTest.setupFixture.voiceSaveOk=false;workbenchTest.setupFixture.mutateVoiceOnFailure=true;');
  await click(next);
  assert(await isOpen());
  assert.equal(await evaluate('return workbenchTest.setupFixture.requests.length;'), 0, 'failed voice write cannot mark onboarding complete');
  await evaluate('workbenchTest.setupFixture.voiceSaveOk=true;');
  await click(next);
  assert.equal(await evaluate('return workbenchTest.setupFixture.voiceWrites.length;'), 2, 'failed disable must retry persistence even if runtime already turned voice off');
  await evaluate('workbenchTest.emitWsClose();await workbenchTest.nextTick();');
  assert(await isOpen(), 'disconnect keeps choices available for retry');
  assert(await evaluate("return document.querySelector('.onboarding-actions button[type=submit]').disabled;"), 'connection loss prevents unauthorized settings writes');
  await evaluate("await workbenchTest.authorize('full-control');");
  await click(next);
  assert.equal(await evaluate('return workbenchTest.setupFixture.requests.length;'), 2, `reconnect retry sends a new request: ${JSON.stringify(await evaluate("return {error:document.querySelector('.onboarding-error')?.textContent,scope:workbenchTest.profiles.authorizationScope,busy:document.querySelector('.onboarding-form').getAttribute('aria-busy')};"))}`);
  await evaluate('await workbenchTest.completeSetupSave(false,workbenchTest.setupFixture.requests[0]);');
  assert(await evaluate("return document.querySelector('.onboarding-actions button[type=submit]').disabled;"), 'late failure from the previous attempt cannot settle this retry');
  await evaluate('await workbenchTest.completeSetupSave();');
  assert.equal(await isOpen(), false);

  await load('voiceUnavailable=1');
  assert(await isOpen());
  assert.equal(await evaluate('return document.querySelectorAll("[name=onboarding-voice]").length;'), 0, 'unknown voice preference is not shown as off');
  assert(await evaluate(`return document.querySelector(${JSON.stringify(keepVoice)}).checked;`), 'unavailable voice defaults to preserving the current preference');
  await toolbarStep();
  assert.match(await evaluate("return document.querySelector('.onboarding-toolbar').textContent;"), /desktop app on your simulator PC/);
  await click(next);
  assert.equal(await evaluate('return workbenchTest.setupFixture.voiceWrites.length;'), 0, 'unavailable voice does not prevent completing other preferences');
  await evaluate('await workbenchTest.completeSetupSave();');
  assert.equal(await isOpen(), false);

  await load('voiceUnavailable=1');
  await toolbarStep();
  await evaluate('workbenchTest.voice.setBridgeAvailable(true); workbenchTest.voice.applyRuntimeInfo({enabled:true,available:false}); await workbenchTest.nextTick();');
  await click(next);
  assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites;'), [], 'a late voice preference reply respects the keep-current default');
  await evaluate('await workbenchTest.completeSetupSave();');
  assert.equal(await isOpen(), false);

  // An explicit installation is independent of saving preferences. Defer the
  // bridge reply to exercise duplicate clicks, errors and keyboard recovery.
  await load('toolbar=1', 320, 700);
  await toolbarStep(toolbarNow);
  await assertCompletionBlocked('toolbar installation not yet performed');
  await evaluate('workbenchTest.toolbarFixture.deferInstall=true;workbenchTest.toolbarFixture.installOk=false;');
  await click(install, true);
  await click(install, true);
  await click(next, true);
  assert.equal(await evaluate('return workbenchTest.toolbarFixture.writes.length;'), 1, 'pending install is not duplicated');
  assert.equal(await evaluate('return workbenchTest.setupFixture.requests.length;'), 0, 'finish waits for an active install');
  assert(await evaluate(`return document.querySelector(${JSON.stringify(back)}).disabled;`), 'Back waits for installation');
  await evaluate('workbenchTest.toolbarFixture.finishInstall();');
  await wait(80);
  assert.match(await evaluate("return document.querySelector('.onboarding-toolbar [role=alert]').textContent;"), /permissions/);
  assert(await evaluate("return document.activeElement.matches('.onboarding-toolbar [role=alert]');"), 'install error receives keyboard focus');
  await assertCompletionBlocked('failed toolbar installation');
  await checkGeometry('toolbar failure', 320, 700);
  await capture('phone-narrow-onboarding-toolbar-failed');
  await evaluate('workbenchTest.toolbarFixture.installOk=true;workbenchTest.toolbarFixture.deferInstall=false;');
  await click(install, true);
  assert.deepEqual(await evaluate('return workbenchTest.toolbarFixture.writes;'), [['install', 'msfs2024-steam'], ['install', 'msfs2024-steam']], 'retry uses the detected installation id');
  assert.equal(await evaluate(`return document.querySelector(${JSON.stringify(install)});`), null, 'successful installation removes the install action');
  assert.match(await evaluate("return document.querySelector('.onboarding-toolbar [role=status]').textContent;"), /Restart Microsoft Flight Simulator 2024/);
  assert(await evaluate("return document.activeElement.matches('.onboarding-toolbar [role=status]');"), 'removed install button transfers focus to the result');
  await capture('phone-narrow-onboarding-toolbar-installed');
  await click(next);
  await evaluate('await workbenchTest.completeSetupSave(false);');
  await click(next);
  assert.equal(await evaluate('return workbenchTest.toolbarFixture.writes.length;'), 2, 'retrying preference save does not reinstall');
  await evaluate('await workbenchTest.completeSetupSave();');
  assert.equal(await isOpen(), false);

  for (const status of ['installed', 'update_available', 'configuration_update_required', 'repair_required', 'foreign_package']) {
    await load(`toolbar=1&toolbarStatus=${status}`);
    await toolbarStep(status === 'installed' ? toolbarNow : toolbarLater);
    const actionable = !['installed', 'foreign_package'].includes(status);
    assert.equal(await evaluate(`return Boolean(document.querySelector(${JSON.stringify(install)}));`), actionable, `${status}: reuse installer availability`);
    assert.deepEqual(await evaluate('return workbenchTest.toolbarFixture.writes;'), [], 'viewing status never changes the package');
    if (status === 'installed') await capture('desktop-onboarding-toolbar-installed');
    await click(next);
    await evaluate('await workbenchTest.completeSetupSave();');
    assert.equal(await isOpen(), false, `${status}: toolbar maintenance stays optional`);
  }

  await load('toolbar=1&noSimulator=1');
  await toolbarStep();
  assert.match(await evaluate("return document.querySelector('.onboarding-toolbar').textContent;"), /No MSFS 2024 installation was found/);
  await click(next);
  await evaluate('await workbenchTest.completeSetupSave();');
  assert.equal(await isOpen(), false, 'missing simulator does not block completion');

  await load('toolbar=1&toolbarStatus=installed');
  await toolbarStep(toolbarNow);
  assert.equal(await evaluate(`return document.querySelector(${JSON.stringify(next)}).disabled;`), false, 'a confirmed installed toolbar satisfies the explicit toolbar choice');
  await evaluate("workbenchTest.toolbarFixture.sourceError='Toolbar package is unavailable.';");
  await click('.onboarding-toolbar-refresh');
  assert.match(await evaluate("return document.querySelector('.onboarding-toolbar [role=alert]').textContent;"), /unavailable/);
  assert.equal(await evaluate(`return Boolean(document.querySelector(${JSON.stringify(install)}));`), false, 'source failures cannot offer install');
  await assertCompletionBlocked('unavailable toolbar package');
  await click(toolbarLater);
  await click(next);
  await evaluate('await workbenchTest.completeSetupSave();');
  assert.equal(await isOpen(), false, 'toolbar detection errors do not block preference setup');

  // Replay the completed introduction through the actual General settings
  // button. Opening/cancelling must not reset completion or save a draft.
  for (const width of [1440, 320]) {
    await load('completed=1&voiceEnabled=1&autoStart=0&toolbar=1', width, 900);
    await evaluate("workbenchTest.whatsNew.dismiss(); await workbenchTest.open('settings');");
    const showIntro = '#settings-show-intro';
    await evaluate("document.getElementById('settings-show-intro').scrollIntoView({block:'center'});");
    const introButton = await evaluate("const b=document.getElementById('settings-show-intro').getBoundingClientRect(); return {height:b.height,left:b.left,right:b.right};");
    assert(introButton.height >= 44 && introButton.left >= 0 && introButton.right <= width, `Settings replay button fits and has a touch target: ${JSON.stringify(introButton)}`);
    await click(showIntro);
    assert(await isOpen(), 'General settings reopens completed setup immediately');
    assert.equal(await evaluate('return document.activeElement.id;'), 'onboarding-title');
    assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceOn)}).checked;`), 'replay starts with the current saved voice preference');
    await checkGeometry(`replay-${width}-voice`, width, 900);
    await capture(`replay-${width}-voice`);
    await click(voiceOff);
    await click(next);
    assert(await evaluate(`return document.querySelector(${JSON.stringify(manual)}).checked;`), 'replay starts with the current saved recording preference');
    await click(automatic);
    await checkGeometry(`replay-${width}-recording`, width, 900);
    assert(await evaluate("const d=document.querySelector('.onboarding-dialog').getBoundingClientRect(); return [...document.querySelectorAll('.onboarding-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=d.left&&r.right<=d.right&&r.top>=d.top&&r.bottom<=d.bottom;});"), 'Close, Back and Next all fit inside the replay dialog');
    await capture(`replay-${width}-recording`);
    await click('[data-close-intro]');
    assert.equal(await isOpen(), false, 'Close dismisses optional replay');
    assert.equal(await evaluate('return document.activeElement.id;'), 'settings-show-intro', 'focus returns to the Settings button');
    assert.deepEqual(await evaluate('return [workbenchTest.setupFixture.requests, workbenchTest.setupFixture.voiceWrites];'), [[], []], 'cancelling sends no writes');
    assert(await evaluate('return workbenchTest.settings.settings.onboarding.completed;'), 'replay never resets durable completion');

    // Preferences can change elsewhere between visits. Reload the current
    // saved choices on each visit.
    await evaluate(`workbenchTest.voice.applyRuntimeInfo({enabled:false,available:false});
      workbenchTest.settings.apply({settings:{...workbenchTest.settings.settings,recording:{autoStart:true}}});
      await workbenchTest.nextTick();`);
    await click(showIntro);
    assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceOff)}).checked;`), 'a new visit reloads the current voice choice');
    await key('Escape', 27);
    assert.equal(await isOpen(), false, 'Escape closes optional replay');
    await click(showIntro);
    await click(next);
    assert(await evaluate(`return document.querySelector(${JSON.stringify(automatic)}).checked;`), 'a new visit reloads the current recording choice');
    await click(manual);
    await click(next);
    await click(toolbarLater);
    await checkGeometry(`replay-${width}-toolbar`, width, 900);
    await capture(`replay-${width}-toolbar`);
    await click(next);
    assert(await evaluate('return document.querySelector("[data-close-intro]").disabled;'), 'cannot close while saving');
    await key('Escape', 27);
    assert(await isOpen(), 'Escape cannot interrupt an active save');
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.requests[0].patch;'), { onboarding: { completed: true }, recording: { autoStart: false } });
    await evaluate('await workbenchTest.completeSetupSave(false);');
    assert(await isOpen(), 'failed replay save remains open with its choices');
    await click(next);
    await evaluate('await workbenchTest.completeSetupSave();');
    assert.equal(await isOpen(), false, 'confirmed replay save closes');
    assert.equal(await evaluate('return workbenchTest.settingsEditor.updateChecks;'), true, 'replay preserves unrelated preferences');
    assert.equal(await evaluate('return workbenchTest.settingsForm.pendingVisible;'), false, 'General follows the confirmed intro save without a competing draft');
    await capture(`replay-${width}-settings`);
    await evaluate("await workbenchTest.authorize('read-only'); workbenchTest.settingsUi.introOpen=true; await workbenchTest.nextTick();");
    assert.equal(await isOpen(), false, 'replay is rejected after settings authorization is lost');
  }

  // Use one editor at a time: save or discard General before replay. Check
  // both native controls and the dialog entry guard, with no lost drafts.
  for (const width of [1440, 320]) {
    for (const resolveDraft of ['save', 'discard']) {
      await load('completed=1&toolbar=1', width, 900);
      await evaluate("workbenchTest.whatsNew.dismiss(); await workbenchTest.open('settings');");
      await click('#setting-recording-auto-start');
      await click('#setting-update-checks');
      assert(await evaluate('return document.getElementById("settings-show-intro").disabled;'));
      assert.match(await evaluate('return document.getElementById("settings-intro-help").textContent;'), /Save or discard/);
      await click('#settings-show-intro');
      await evaluate('workbenchTest.settingsUi.introOpen=true; await workbenchTest.nextTick();');
      assert.equal(await isOpen(), false, 'dirty Settings cannot enter the intro through either entry path');
      assert.deepEqual(await evaluate('return [workbenchTest.settingsEditor.recordingAutoStart, workbenchTest.settingsEditor.updateChecks, workbenchTest.setupFixture.requests.length];'), [false, false, 0], 'refusal preserves the exact draft and writes nothing');
      await capture(`replay-draft-${width}-${resolveDraft}`);
      if (resolveDraft === 'save') {
        await click('#settings-pending-save-btn');
        const request = await evaluate("return workbenchTest.sent.filter(message=>message.type==='saveAppSettings').at(-1);");
        assert.equal(request.settings.recording.autoStart, false);
        await evaluate('workbenchTest.settingsUi.introOpen=true; await workbenchTest.nextTick();');
        assert.equal(await isOpen(), false, 'replay waits for save confirmation');
        await evaluate(`await workbenchTest.completeSetupSave(false, {requestId:${JSON.stringify(request.requestId)}});`);
        assert.match(await evaluate('return document.getElementById("settings-intro-help").textContent;'), /Save or discard/, 'failed save keeps the draft and replay blocked');
        await click('#settings-pending-save-btn');
        const retry = await evaluate("return workbenchTest.sent.filter(message=>message.type==='saveAppSettings').at(-1);");
        await evaluate(`await workbenchTest.completeSetupSave(true, {requestId:${JSON.stringify(retry.requestId)},patch:${JSON.stringify(retry.settings)}});`);
      } else {
        await click('#settings-pending-reload-btn');
        await evaluate('workbenchTest.settingsUi.introOpen=true; await workbenchTest.nextTick();');
        assert.equal(await isOpen(), false, 'replay waits for the discard reload');
        await evaluate('workbenchTest.deliverSettings(); await workbenchTest.nextTick();');
      }
      assert.equal(await evaluate('return document.getElementById("settings-show-intro").disabled;'), false);
      await click('#settings-show-intro');
      assert(await isOpen(), 'settled Settings can open the intro');
      assert.equal(await evaluate('return await workbenchTest.settingsForm.requestSave();'), false, 'General cannot start a competing save while replay is open');
      await click(next);
      const expected = resolveDraft === 'save' ? manual : automatic;
      assert(await evaluate(`return document.querySelector(${JSON.stringify(expected)}).checked;`), 'intro starts with the confirmed saved or discarded recording value');
      await click(manual);
      await click(next);
      await click(next);
      await evaluate('await workbenchTest.completeSetupSave();');
      await assertSavedSettings(false, false);
      assert.equal(await evaluate('return workbenchTest.settingsEditor.updateChecks;'), resolveDraft !== 'save', 'intro preserves the unrelated saved preference');
    }
  }

  // Native voice startup may take time. Finish that Settings operation before
  // replay, so there is one unambiguous voice preference to initialize from.
  for (const width of [1440, 320]) {
    await load('completed=1&voiceEnabled=0&toolbar=1', width, 900);
    await evaluate("workbenchTest.whatsNew.dismiss(); await workbenchTest.open('settings'); workbenchTest.setupFixture.deferVoiceSave=true;");
    await click('[data-voice-recognition-toggle]');
    assert.equal(await evaluate('return workbenchTest.voice.recognitionChanging;'), true);
    assert(await evaluate('return document.getElementById("settings-show-intro").disabled;'));
    assert.match(await evaluate('return document.getElementById("settings-intro-help").textContent;'), /Wait for your settings update/);
    await click('#settings-show-intro');
    await evaluate('workbenchTest.settingsUi.introOpen=true; await workbenchTest.nextTick();');
    assert.equal(await isOpen(), false, 'pending voice change cannot open replay');
    await capture(`replay-voice-pending-${width}`);
    await evaluate('workbenchTest.setupFixture.deferVoiceSave=false; workbenchTest.setupFixture.finishVoiceSave(); await workbenchTest.nextTick();');
    for (let n = 0; n < 100 && await evaluate('return workbenchTest.voice.recognitionChanging;'); n++) await wait(10);
    await click('#settings-show-intro');
    assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceOn)}).checked;`), 'intro initializes from the completed voice change');
    await click(voiceOff);
    await toolbarStep();
    await click(next);
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites.map(write=>write.value);'), [true, false]);
    await evaluate('await workbenchTest.completeSetupSave();');
    await assertSavedSettings(false, true);
  }

  // Failed native disable stops voice immediately even if the disk still has
  // On. Replaying and accepting Off must retry that failed preference write.
  for (const width of [1440, 320]) {
    await load('completed=1&voiceEnabled=1&toolbar=1', width, 900);
    await evaluate("workbenchTest.whatsNew.dismiss(); await workbenchTest.open('settings'); workbenchTest.setupFixture.voiceSaveOk=false; workbenchTest.setupFixture.mutateVoiceOnFailure=true;");
    await click('[data-voice-recognition-toggle]');
    assert.equal(await evaluate('return workbenchTest.voice.runtime.enabled;'), false);
    assert.equal(await evaluate('return workbenchTest.voice.recognitionSaveFailed;'), true, 'the failed disk write remains known outside the original Settings control');
    await click('#settings-show-intro');
    assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceOff)}).checked;`));
    await toolbarStep();
    await evaluate('workbenchTest.setupFixture.voiceSaveOk=true;');
    await click(next);
    assert.deepEqual(await evaluate('return workbenchTest.setupFixture.voiceWrites.map(write=>write.value);'), [false, false], 'accepting Off retries durability even though the runtime is already off');
    await evaluate('await workbenchTest.completeSetupSave();');
    assert.equal(await isOpen(), false);
    assert.equal(await evaluate('return workbenchTest.voice.recognitionSaveFailed;'), false);
    await assertSavedSettings(false, true);
    assert.doesNotMatch(await evaluate('return document.querySelector("#settings-voice-control").textContent;'), /Voice control could not be updated/, 'successful intro retry clears the earlier Settings error');
  }

  // A backend reply includes the already-completed onboarding metadata, even
  // though General only submits its editable settings. It must still restart.
  for (const width of [1440, 320]) {
    await load('completed=1&toolbar=1&restart=1', width, 900);
    await evaluate("workbenchTest.whatsNew.dismiss(); await workbenchTest.open('settings');");
    await click('#setting-recording-auto-start');
    await click('#settings-restart-app-btn');
    const request = await evaluate("return workbenchTest.sent.filter(message=>message.type==='saveAppSettings').at(-1);");
    assert(request, 'Save & Restart sends the edited settings');
    assert.equal(request.settings.recording.autoStart, false);
    assert.equal(Object.hasOwn(request.settings, 'onboarding'), false, 'General does not write intro completion');
    assert.equal(await evaluate('return workbenchTest.setupFixture.restarts;'), 0, 'restart waits for confirmed persistence');
    await evaluate(`workbenchTest.emitAppSettingsSaved({requestId:${JSON.stringify(request.requestId)},ok:true,settings:{...${JSON.stringify(request.settings)},onboarding:{completed:true}},restartRequired:true}); await workbenchTest.nextTick();`);
    assert.equal(await evaluate('return workbenchTest.setupFixture.restarts;'), 1, 'completed onboarding does not reject a valid save-before-restart');
    assert.equal(await evaluate('return workbenchTest.settingsForm.pendingVisible;'), false, 'confirmed restart save clears the draft');
  }

  await load('firstVoicePreference=1');
  await click(voiceOff);
  await click(next);
  await load('firstVoicePreference=1');
  assert(await isOpen(), 'unfinished setup returns after relaunch');
  assert(await evaluate(`return document.querySelector(${JSON.stringify(voiceOn)}).checked;`), 'relaunch restores the proposed default instead of an unsaved choice');
  await load('completed=1');
  assert.equal(await isOpen(), false, 'completion restored from app settings suppresses setup after relaunch');
  assert.equal(await evaluate('return workbenchTest.settingsUi.initialSetupReady;'), true, 'returning users can use voice after saved completion loads');
  await load('scope=aircraft-control', 320, 700, true);
  assert.equal(await isOpen(), false, 'paired phones are not asked to edit PC-owned preferences');
  await load('scope=read-only');
  assert.equal(await isOpen(), false, 'read-only clients cannot edit preferences');
  await evaluate("await workbenchTest.authorize('full-control');");
  assert(await isOpen(), 'desktop setup appears after authorization recovers');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
};
