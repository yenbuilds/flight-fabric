'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function ({ win, evaluate, ready, settled, output }) {
  const panelText = () => evaluate(`return document.querySelector('[data-pmdg-sdk-setup]').textContent;`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); await layoutTest.settle();`);
  const checked = () => settled(`return document.querySelector('[data-pmdg-check]')?.getAttribute('aria-disabled');`, value => value === 'false');
  const recheck = async () => { await click('[data-pmdg-check]'); assert.equal(await checked(), 'false'); };
  await evaluate(`
    window.pmdgTest = { calls: [], opens: [], copied: [], choices: [], status: 'disabled', section: 'present', count: 1 };
    pmdgTest.response = family => ({ supported: true, files: Array.from({ length: pmdgTest.count }, (_, index) => ({
      id: family + ':fixture-' + index,
      filename: family === 'pmdg-737' ? '737_Options.ini' : '777_Options.ini',
      label: 'MSFS 2024 — ' + (index ? 'Microsoft Store' : 'Steam') + ' · PMDG ' + (family === 'pmdg-737' ? '737-800' : '777-300ER'),
      path: 'C:/Users/simpilot/AppData/Roaming/Microsoft Flight Simulator 2024/WASM/MSFS2024/pmdg-aircraft-' + (family === 'pmdg-737' ? '738/work/737_Options.ini' : '77w/work/777_Options.ini'),
      settings: { section: pmdgTest.section, data: pmdgTest.status, cduLeft: 'missing', cduRight: 'disabled' }, canReveal: true,
    })).concat(pmdgTest.selected?.family === family ? [pmdgTest.selected] : []) });
    window.electronAPI = { pmdgSdk: {
      async getStatus(family, profileId) {
        pmdgTest.calls.push([family, profileId]);
        if (pmdgTest.pending) return new Promise(resolve => { pmdgTest.resolve = resolve; });
        if (pmdgTest.fail) throw new Error('fixture failure');
        return pmdgTest.response(family);
      },
      async revealFile(family, id) { pmdgTest.opens.push([family, id]); return { success: !pmdgTest.openFail, error: 'Location changed. Check again.' }; },
      async chooseFile(family, profileId) {
        pmdgTest.choices.push([family, profileId]);
        if (pmdgTest.choosePending) return new Promise(resolve => { pmdgTest.resolveChoose = resolve; });
        if (pmdgTest.choice?.success) pmdgTest.selected = pmdgTest.choice.file;
        return pmdgTest.choice || { canceled: true };
      },
    } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text) {
      if (pmdgTest.copyFail) throw new Error('clipboard denied');
      if (pmdgTest.copyPending) await new Promise(resolve => { pmdgTest.resolveCopy = resolve; });
      pmdgTest.copied.push(text);
    } } });
    layoutTest.setSdkStatus('awaiting-values');
    await layoutTest.remount();
  `);
  await ready('[data-pmdg-open]');
  await checked();
  assert.deepEqual(await evaluate('return pmdgTest.calls[0];'), ['pmdg-737', 'pmdg-737'], 'detection names the active variant');
  assert.equal(await evaluate(`return document.querySelector('[data-pmdg-sdk-setup]').open;`), true, 'disabled setting opens guidance');
  assert.equal(await evaluate(`return document.querySelector('.pmdg-sdk-file details').open;`), false, 'long file paths are secondary');
  for (const width of [1440, 390, 320]) {
    win.setSize(width, width === 1440 ? 1000 : 844);
    await settled('return innerWidth;', value => value === width);
    await win.webContents.capturePage();
    const layout = await evaluate(`const el = document.querySelector('[data-pmdg-sdk-setup]');
      return { width: el.clientWidth, scroll: el.scrollWidth, steps: el.querySelectorAll('ol > li').length,
        buttons: [...el.querySelectorAll('button')].filter(b => b.getClientRects().length).map(b => b.getBoundingClientRect().height) };`);
    assert(layout.scroll <= layout.width + 1, width + 'px setup has no overflow');
    assert.equal(layout.steps, 3);
    assert(layout.buttons.every(height => height >= 44), width + 'px buttons meet touch target');
    await evaluate(`document.querySelector('[data-pmdg-sdk-setup]').scrollIntoView({ block: 'start' });`);
    fs.writeFileSync(path.join(output, `pmdg-sdk-setup-${width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await click('.pmdg-sdk-file summary');
  assert.equal(await settled(`const el = document.querySelector('[data-pmdg-sdk-setup]'); return el.scrollWidth <= el.clientWidth + 1;`, Boolean), true, 'expanded path wraps at 320px');
  await click('[data-pmdg-copy]');
  assert.equal(await evaluate('return pmdgTest.copied.at(-1);'), 'EnableDataBroadcast=1\r\n\r\n', 'existing section is not duplicated');
  await click('.pmdg-sdk-cdu input');
  await click('[data-pmdg-copy]');
  assert.equal(await evaluate('return pmdgTest.copied.at(-1);'), 'EnableDataBroadcast=1\r\nEnableCDUBroadcast.0=1\r\nEnableCDUBroadcast.1=1\r\n\r\n');
  await evaluate('pmdgTest.section = "missing";'); await recheck();
  await click('[data-pmdg-copy]');
  assert.match(await evaluate('return pmdgTest.copied.at(-1);'), /^\[SDK\]\r\n/);
  await evaluate('pmdgTest.copyFail = true;'); await click('[data-pmdg-copy]');
  assert.match(await panelText(), /Select and copy the settings below/);
  await evaluate('pmdgTest.copyFail = false;');
  await click('[data-pmdg-open]');
  assert.deepEqual(await evaluate('return pmdgTest.opens;'), [['pmdg-737', 'pmdg-737:fixture-0']], 'reveal sends IDs only');
  const beforeReturn = await evaluate('return pmdgTest.calls.length;');
  await evaluate(`window.dispatchEvent(new Event('focus')); await layoutTest.settle();`);
  await checked();
  assert.equal(await evaluate('return pmdgTest.calls.length;'), beforeReturn + 1, 'return from Explorer refreshes automatically');
  await evaluate(`window.dispatchEvent(new Event('focus')); await layoutTest.settle();`);
  assert.equal(await evaluate('return pmdgTest.calls.length;'), beforeReturn + 1, 'ordinary focus does not keep probing disk');
  await evaluate('pmdgTest.openFail = true;'); await click('[data-pmdg-open]');
  assert.match(await panelText(), /Location changed/);
  // Refresh retains the file card and keyboard focus; duplicate requests coalesce in the UI.
  await evaluate(`pmdgTest.pending = true; document.querySelector('[data-pmdg-check]').focus();`);
  await click('[data-pmdg-check]');
  const requests = await evaluate('return pmdgTest.calls.length;');
  await click('[data-pmdg-check]');
  assert.equal(await evaluate('return pmdgTest.calls.length;'), requests);
  assert.equal(await evaluate(`return document.activeElement.matches('[data-pmdg-check]') && !!document.querySelector('[data-pmdg-open]');`), true);
  await evaluate(`pmdgTest.pending = false; pmdgTest.resolve(pmdgTest.response('pmdg-737')); await layoutTest.settle();`); await checked();
  // Clipboard completion is independent of a concurrent refresh.
  await evaluate('pmdgTest.copyPending = true;'); await click('[data-pmdg-copy]'); await recheck();
  await evaluate(`pmdgTest.copyPending = false; pmdgTest.resolveCopy(); await layoutTest.settle();`);
  assert.equal(await evaluate(`return document.querySelector('[data-pmdg-copy]').textContent;`), 'Copied');
  await click('.pmdg-sdk-cdu input');
  await evaluate('pmdgTest.status = "enabled";'); await recheck();
  assert.match(await panelText(), /Data broadcast is enabled/);
  assert.equal(await evaluate(`return document.querySelector('[data-pmdg-sdk-setup] ol') === null;`), true, 'successful setup gives the next step instead of editing instructions');
  // A connected aircraft stays compact, even if another file setting needs attention.
  await evaluate(`layoutTest.setSdkStatus('connected'); await layoutTest.remount();`); await checked();
  assert.equal(await evaluate(`return document.querySelector('[data-pmdg-sdk-setup]').open;`), false);
  assert.match(await panelText(), /No change is needed for aircraft controls/);
  await evaluate(`document.querySelector('.pmdg-sdk-summary').focus();`);
  const healthy = await settled(`const el = document.querySelector('[data-pmdg-sdk-setup]'); el.scrollIntoView({ block: 'start', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = el.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, viewportHeight: innerHeight };`, box => box.top >= 0 && box.bottom < box.viewportHeight);
  assert(healthy.top >= 0 && healthy.bottom < healthy.viewportHeight, 'healthy setup is in the screenshot viewport');
  assert(healthy.height < 80, 'healthy connection remains compact on a narrow phone');
  fs.writeFileSync(path.join(output, 'pmdg-connected-320.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await settled(`return document.querySelector('[data-pmdg-sdk-setup]').open;`, Boolean), true, 'keyboard can expand setup');
  await click('.pmdg-sdk-show-steps');
  assert.equal(await evaluate(`return document.querySelector('.pmdg-sdk-cdu input').checked;`), true, 'CDU setup shortcut includes both screens');
  // More than one installation needs an explicit choice, never a guessed file.
  await evaluate(`layoutTest.setSdkStatus('awaiting-values'); pmdgTest.count = 2; pmdgTest.status = 'disabled'; await layoutTest.remount();`); await checked();
  assert.equal(await evaluate(`return document.querySelector('[data-pmdg-open]') === null;`), true);
  await evaluate(`const choice = document.querySelector('[data-pmdg-file-choice]'); choice.value = 'pmdg-737:fixture-1'; choice.dispatchEvent(new Event('change', { bubbles: true })); await layoutTest.settle();`);
  await recheck();
  assert.equal(await evaluate(`return document.querySelector('[data-pmdg-file-choice]').value;`), 'pmdg-737:fixture-1');
  await evaluate('pmdgTest.count = 0;'); await recheck();
  assert.match(await panelText(), /No options file found for this aircraft/);
  await evaluate('pmdgTest.fail = true;'); await recheck();
  assert.match(await panelText(), /Could not refresh/);
  // A failed automatic check can recover through a picker without sending paths.
  await click('[data-pmdg-choose]');
  assert.match(await panelText(), /No options file found/);
  assert.equal(await evaluate(`return document.querySelector('[data-pmdg-open]') === null;`), true, 'cancel creates no selection');
  await evaluate(`pmdgTest.choice = { success: false, error: 'Choose this aircraft’s options INI.' };`);
  await click('[data-pmdg-choose]');
  assert.match(await panelText(), /Choose this aircraft’s options INI/);
  await evaluate(`pmdgTest.choice = { success: true, file: {
    id: 'selected:fixture', family: 'pmdg-737', profileId: 'pmdg-737', filename: '737_Options.ini',
    path: 'D:/WpSystem/Simulator/AppData/Local/Packages/Microsoft.Limitless_8wekyb3d8bbwe/LocalState/WASM/MSFS2024/pmdg-aircraft-738/work/737_Options.ini',
    label: 'PMDG 737-800 · Selected file', settings: { section: 'present', data: 'disabled', cduLeft: 'missing', cduRight: 'missing' }, canReveal: true,
  } }; pmdgTest.fail = false; pmdgTest.openFail = false;`);
  await click('[data-pmdg-choose]'); await checked();
  assert.deepEqual(await evaluate('return pmdgTest.choices.at(-1);'), ['pmdg-737', 'pmdg-737']);
  assert.match(await panelText(), /remembered until you close FlightFabric/);
  await recheck(); await click('[data-pmdg-open]');
  assert.deepEqual(await evaluate('return pmdgTest.opens.at(-1);'), ['pmdg-737', 'selected:fixture']);
  await evaluate(`pmdgTest.choice = { canceled: true };`); await click('[data-pmdg-choose]');
  assert.match(await panelText(), /Selected file/, 'cancel preserves the verified file');
  // Picker busy state blocks all other local actions and survives keyboard focus.
  await evaluate(`pmdgTest.choosePending = true; document.querySelector('[data-pmdg-choose]').focus();`);
  await click('[data-pmdg-choose]');
  const duringPicker = await evaluate('return [pmdgTest.choices.length, pmdgTest.calls.length, pmdgTest.opens.length];');
  await click('[data-pmdg-choose]'); await click('[data-pmdg-check]'); await click('[data-pmdg-open]');
  assert.deepEqual(await evaluate('return [pmdgTest.choices.length, pmdgTest.calls.length, pmdgTest.opens.length];'), duringPicker);
  await evaluate(`pmdgTest.choosePending = false; pmdgTest.resolveChoose({ canceled: true }); await layoutTest.settle();`); await checked();
  assert.equal(await evaluate(`return document.activeElement.matches('[data-pmdg-choose]');`), true);
  for (const width of [1440, 320]) {
    win.setSize(width, width === 1440 ? 1000 : 844);
    await settled('return innerWidth;', value => value === width);
    await evaluate(`document.querySelector('[data-pmdg-sdk-setup]').scrollIntoView({ block: 'start' }); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`);
    assert.equal(await evaluate(`const el = document.querySelector('[data-pmdg-sdk-setup]'); return el.scrollWidth <= el.clientWidth + 1;`), true);
    fs.writeFileSync(path.join(output, 'pmdg-selected-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  await evaluate('pmdgTest.selected = null;');
  // A late result must not reopen a panel the user has already closed.
  await evaluate(`pmdgTest.fail = false; pmdgTest.count = 1; pmdgTest.pending = true; await layoutTest.remount();`);
  await click('.pmdg-sdk-summary'); await click('.pmdg-sdk-summary');
  await evaluate(`pmdgTest.pending = false; pmdgTest.resolve(pmdgTest.response('pmdg-737')); await layoutTest.settle();`); await checked();
  assert.equal(await evaluate(`return document.querySelector('[data-pmdg-sdk-setup]').open;`), false);
  // Delayed responses from the previous aircraft are discarded.
  await evaluate(`pmdgTest.pending = true; document.querySelector('[data-pmdg-check]').click(); await layoutTest.settle();
    pmdgTest.pending = false; await layoutTest.scenario('pmdg-777'); await layoutTest.settle();
    pmdgTest.resolve({ supported: true, files: [] }); await layoutTest.settle();`); await checked();
  assert.match(await panelText(), /777_Options.ini/);
  assert.doesNotMatch(await panelText(), /No options file found|737_Options.ini/);
  // A file picker completed for an old aircraft cannot replace the current card.
  await evaluate(`pmdgTest.choosePending = true; document.querySelector('[data-pmdg-choose]').click(); await layoutTest.settle();
    pmdgTest.choosePending = false; await layoutTest.scenario('pmdg-737'); await layoutTest.settle();
    pmdgTest.resolveChoose({ success: true, file: { ...pmdgTest.choice.file, filename: '777_Options.ini' } }); await layoutTest.settle();`); await checked();
  assert.doesNotMatch(await panelText(), /777_Options.ini/);
  await evaluate(`await layoutTest.scenario('fenix-a320');`);
  assert.equal(await evaluate(`return !!document.querySelector('[data-pmdg-sdk-setup]');`), false);
  await evaluate(`delete window.electronAPI; await layoutTest.scenario('pmdg-737'); document.querySelector('[data-pmdg-sdk-setup]').open = true; await layoutTest.settle();`);
  assert.equal(await evaluate(`return document.querySelectorAll('[data-pmdg-open], [data-pmdg-check], [data-pmdg-choose]').length;`), 0, 'remote browser cannot invoke local actions');
  assert.match(await panelText(), /Windows desktop app/);
  await evaluate(`delete navigator.clipboard; layoutTest.setSdkStatus('connected'); await layoutTest.remount();`);
  win.setSize(1440, 1000);
  console.log('PMDG setup UX: responsive layout, profile selection, clipboard, focus, auto-refresh, recovery and remote fallback passed.');
};
