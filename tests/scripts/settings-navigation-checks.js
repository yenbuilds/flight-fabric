'use strict';
const assert = require('node:assert/strict');

module.exports = async function checkSettingsNavigation({ win, evaluate, capture, wait }) {
  const fixtureUrl = new URL(process.env.FF_WORKBENCH_TEST_URL);
  fixtureUrl.search = '?desktop=1&toolbar=1';
  for (const width of [1440, 1280, 900, 320]) {
    win.setContentSize(width, width === 1280 ? 720 : 900);
    await win.loadURL(fixtureUrl.href);
    for (let n = 0; n < 180 && !await evaluate('return Boolean(window.workbenchTest);'); n++) await wait(50);
    assert(await evaluate('return Boolean(window.workbenchTest);'), 'settings fixture mounted');
    await evaluate(`
      workbenchTest.voice.setBridgeAvailable(true);
      workbenchTest.voice.applyRuntimeInfo({enabled:true,available:true,mode:'offline',pushToTalk:{accelerator:'Control+Shift+Space',registered:true}});
      workbenchTest.voice.setState('ready');
      workbenchTest.toolbarFixture.status='installed'; await workbenchTest.toolbar.refresh();
      window.settingsSaves=[];
      const {setAppService}=await import('/frontend/app-shared.js');
      setAppService('getWs',()=>({readyState:WebSocket.OPEN,send:text=>settingsSaves.push(JSON.parse(text))}));
      await workbenchTest.open('settings');
      window.originalSettingsInput=document.getElementById('setting-recording-auto-start');
      document.getElementById('vue-main-root').scrollTop=0;
    `);
    await capture(`settings-navigation-${width}-general`);
    assert(await evaluate(`return document.querySelectorAll('#setting-recording-auto-start').length===1 &&
      [...document.querySelectorAll('#tab-settings input[id^="setting-"],#tab-settings select[id^="setting-"]')].every(el=>el.form?.id==='settings-form') &&
      !document.querySelector('form form');`), 'all preferences share one form without nesting the voice forms');
    assert(await evaluate("return getComputedStyle(document.getElementById('voice-settings-configuration')).display==='none';"), 'voice starts with a compact overview');
    assert(await evaluate("return !document.querySelector('#settings-toolbar-panel details').open;"), 'installed toolbar starts with status and actions');
    const sectionIds = await evaluate("return [...document.querySelectorAll('.settings-section-links a')].map(a=>a.hash.slice(1));");
    assert.deepEqual(sectionIds, ['settings-general','settings-voice-control','settings-phone-tablet-access','settings-cabin-audio','settings-advanced','vue-settings-about-root']);
    await evaluate("document.getElementById('setting-recording-auto-start').click(); await workbenchTest.nextTick();");
    for (const id of sectionIds) {
      await evaluate(`
        const id=${JSON.stringify(id)};
        if(innerWidth<=1000){const select=document.querySelector('.settings-section-select select');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));}
        else document.querySelector('.settings-section-links a[href="#'+id+'"]').click();
        await workbenchTest.nextTick();
      `);
      await capture(`settings-navigation-${width}-${id}`);
      const bounds = await evaluate(`const nav=document.querySelector('.settings-section-nav').getBoundingClientRect(),
        target=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(),main=document.querySelector('#vue-main-root').getBoundingClientRect();
        return {navTop:nav.top,mainTop:main.top,navBottom:nav.bottom,targetTop:target.top,active:document.querySelector('.settings-section-links [aria-current]')?.hash.slice(1),
          overflow:document.querySelector('#vue-main-root').scrollWidth>document.querySelector('#vue-main-root').clientWidth+1};`);
      assert.equal(bounds.overflow, false, `${width}/${id}: no horizontal overflow`);
      assert(bounds.targetTop >= bounds.navBottom - 1, `${width}/${id}: heading clears sticky navigation: ${JSON.stringify(bounds)}`);
      assert.equal(bounds.active, id, `${width}/${id}: active section follows the jump`);
      if (id !== 'settings-general') assert(Math.abs(bounds.navTop-bounds.mainTop)<2, 'navigation stays at the top of the content viewport');
      assert(await evaluate("return originalSettingsInput===document.getElementById('setting-recording-auto-start') && workbenchTest.settingsForm.pendingVisible;"), 'section changes retain mounted controls and unsaved drafts');
    }
    await evaluate(`
      const {focusVoiceSettings}=await import('/frontend/src/vue/voice-settings-navigation.js');
      await focusVoiceSettings(workbenchTest.tabs);
    `);
    assert(await evaluate("return document.activeElement.id==='settings-voice-control' && getComputedStyle(document.getElementById('voice-settings-configuration')).display!=='none';"), 'existing Voice shortcut reveals setup and focuses its section');
    await evaluate("workbenchTest.voice.voiceTest.phase='listening'; await workbenchTest.nextTick();");
    assert(await evaluate("return document.querySelector('[data-voice-configuration-toggle]').disabled;"), 'an active voice test cannot be hidden by collapsing setup');
    await evaluate("workbenchTest.voice.voiceTest.phase='idle';document.querySelector('[data-voice-open-test]').click();await workbenchTest.nextTick();");
    assert.equal(await evaluate('return workbenchTest.voice.voiceTest.phase;'), 'idle', 'Test voice opens the controls without recording automatically');
    await evaluate(`
      const {focusToolbarPanelSettings}=await import('/frontend/src/vue/toolbar-panel-navigation.js');
      await focusToolbarPanelSettings(workbenchTest.tabs);
    `);
    await capture(`settings-navigation-${width}-toolbar`);
    assert.equal(await evaluate('return document.activeElement.id;'), 'settings-toolbar-panel', 'existing toolbar shortcut still focuses installation');
    assert.deepEqual(await evaluate('return workbenchTest.toolbarFixture.writes;'), [], 'navigation never installs or removes a package');
    await evaluate(`const delay=document.getElementById('setting-cabin-announcements-startup-grace-ms');delay.value='1.001';delay.dispatchEvent(new Event('input',{bubbles:true}));await workbenchTest.nextTick();`);
    assert.equal(await evaluate('return workbenchTest.settingsEditor.serializeSettings().cabinAnnouncements.startupGraceMs;'), 1001, 'converting seconds preserves existing millisecond precision');
    await evaluate(`
      document.getElementById('setting-remote-access').click();
      const delay=document.getElementById('setting-cabin-announcements-startup-grace-ms');delay.value='12.5';delay.dispatchEvent(new Event('input',{bubbles:true}));
      const port=document.getElementById('setting-ws-port');port.value='9001';port.dispatchEvent(new Event('input',{bubbles:true}));
      await workbenchTest.nextTick(); document.getElementById('settings-save-btn').click(); await workbenchTest.nextTick();
    `);
    const saves=await evaluate("return settingsSaves.filter(message=>message.type==='saveAppSettings');");
    assert.equal(saves.length, 1, 'one save submits edits across every preference section');
    assert.equal(saves[0].settings.recording.autoStart, false);
    assert.equal(saves[0].settings.network.remoteAccess, true);
    assert.equal(saves[0].settings.network.wsPort, 9001);
    assert.equal(saves[0].settings.cabinAnnouncements.startupGraceMs, 12500, 'seconds are stored as milliseconds without changing the backend contract');
    await evaluate(`
      const {emitAppSettingsSaved}=await import('/frontend/src/app/runtime-signals.js');
      const saved=settingsSaves.find(message=>message.type==='saveAppSettings');
      emitAppSettingsSaved({ok:false,requestId:saved.requestId,error:'Save could not be confirmed. Try again.'});
      await workbenchTest.nextTick();
    `);
    assert(await evaluate("return document.querySelector('#settings-pending-meta').textContent.includes('Try again') && !workbenchTest.settingsForm.saveBusy;"), 'save errors stay visible beside the persistent retry action');
    await capture(`settings-navigation-${width}-save-error`);
    assert(await evaluate(`const bar=document.querySelector('.settings-pending-shell').getBoundingClientRect(),main=document.querySelector('#vue-main-root').getBoundingClientRect();return bar.bottom<main.bottom;`), 'save feedback leaves the app footer and phone navigation available');
    await evaluate(`
      document.getElementById('settings-pending-save-btn').click();await workbenchTest.nextTick();
      const {emitAppSettingsSaved}=await import('/frontend/src/app/runtime-signals.js');
      const saved=settingsSaves.filter(message=>message.type==='saveAppSettings').at(-1);
      emitAppSettingsSaved({ok:true,requestId:saved.requestId,settings:saved.settings});await workbenchTest.nextTick();
    `);
    assert(await evaluate("return !workbenchTest.settingsForm.pendingVisible && !workbenchTest.settingsForm.saveBusy && workbenchTest.settingsForm.statusMessage.includes('saved');"), 'retry and acknowledgement settle the shared form and clear the Save bar');
    await evaluate(`const target=document.getElementById('settings-cabin-audio'),main=document.querySelector('#vue-main-root'),nav=document.querySelector('.settings-section-nav');main.scrollTop+=target.getBoundingClientRect().top-main.getBoundingClientRect().top-nav.getBoundingClientRect().height;`);
    await capture(`settings-navigation-${width}-manual-scroll`);
    assert.equal(await evaluate("return document.querySelector('.settings-section-links [aria-current]').hash;"), '#settings-cabin-audio', 'ordinary scrolling updates the section marker');
    await evaluate("await workbenchTest.authorize('read-only');");
    assert(await evaluate(`return [...document.querySelectorAll('#tab-settings input[id^="setting-"],#tab-settings select[id^="setting-"]')].every(el=>el.matches(':disabled') && !el.getClientRects().length)
      && !document.querySelector('.settings-section-nav') && !!document.getElementById('settings-voice-control');`), 'revocation hides and disables all app preferences while keeping local voice available');
    await evaluate("await workbenchTest.authorize('full-control');");
    assert(await evaluate("return originalSettingsInput===document.getElementById('setting-recording-auto-start') && !originalSettingsInput.disabled && document.querySelectorAll('.settings-section-links a').length===6;"), 'reconnect restores navigation and the same controls');
  }
  console.log('Settings navigation passed: 1440/1280/900/320px, sticky jumps, active sections, mounted drafts, voice/toolbar entry points, cross-section save, seconds conversion, errors and authorization recovery.');
};
