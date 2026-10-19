'use strict';

// Used by the toolbar's real loader/browser fixture. All simulator writes are
// recorded by its fake transport; navigation and settings must never add one.
const assert = require('node:assert/strict');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function checkToolbarSections({ win, page, root, click, bounds, mouse, key, press, until, count }) {
  const initialWrites = await count();
  const parentInputs = await root('return parentInputs.slice();');
  const active = () => page('return document.activeElement.id;');
  const emit = event => page(`return await (await fetch('/fixture/exercise?event=${event}')).json();`);
  const tab = async id => {
    await click('#tab-button-' + id);
    assert.equal(await active(), 'tab-button-' + id, 'clicked tab retains focus');
    assert.equal(await page(`return document.querySelector('#tab-${id}').hidden;`), false);
    assert.equal(await root('return keyboardClaimed;'), true, 'tab navigation retains native capture');
  };
  const type = text => {
    for (const char of text) { const code = char === ' ' ? 'Space' : char; key('keyDown', code); key('char', char); key('keyUp', code); }
  };

  for (const width of [1200, 375, 320]) {
    win.setContentSize(width, 900); await wait(100);
    await emit('plan');
    await tab('plan');
    await page('window.focusedTab = document.activeElement;');
    const packet = await emit('plan');
    await until(page, `return document.querySelector('#tab-plan').textContent.includes('${packet.callsign}');`);
    assert.equal(await page('return document.activeElement === window.focusedTab;'), true, 'plan updates retain the actual focused tab node');
    press('Right');
    await until(page, `return document.activeElement.id;`, 'tab-button-voice');
    press('Left');
    await until(page, `return document.activeElement.id;`, 'tab-button-plan');

    for (const id of ['weather', 'fuel', 'times', 'navlog', 'icao']) {
      const selector = '#section-toggle-' + id;
      const before = await page(`return document.querySelector('${selector}').getAttribute('aria-expanded');`);
      await click(selector);
      assert.equal(await page(`return document.querySelector('${selector}').getAttribute('aria-expanded');`), before === 'true' ? 'false' : 'true');
      key('keyDown', 'Space'); key('char', ' '); key('keyUp', 'Space');
      await until(page, `return document.querySelector('${selector}').getAttribute('aria-expanded');`, before);
      // Leave sections open so narrow tables and long reports are exercised.
      if (before !== 'true') { key('keyDown', 'Enter'); key('char', '\r'); key('keyUp', 'Enter'); }
      assert.equal(await active(), 'section-toggle-' + id);
      assert.equal(await root('return keyboardClaimed;'), true);
    }
    const refreshed = await emit('plan');
    await until(page, `return document.querySelector('#tab-plan').textContent.includes('${refreshed.callsign}');`);
    assert.equal(await active(), 'section-toggle-icao', 'plan replacement retains the focused disclosure');
    const table = await bounds('#section-navlog .table-wrap');
    const tableOverflow = await page(`const n = document.querySelector('#section-navlog .table-wrap'); return n.scrollWidth > n.clientWidth;`);
    if (tableOverflow) {
      mouse('mouseMove', table.x + table.width / 2, table.y + table.height / 2);
      mouse('mouseWheel', table.x + table.width / 2, table.y + table.height / 2, { deltaX: -200, deltaY: 0 });
      await until(page, `return document.querySelector('#section-navlog .table-wrap').scrollLeft > 0;`);
    }
    assert.equal(await page('return document.documentElement.scrollWidth > innerWidth;'), false, 'expanded Plan fits ' + width);

    await tab('voice'); await click('#voice-search'); type('apu');
    await until(page, `return document.querySelector('#voice-search').value;`, 'apu');
    assert.ok(await page(`return document.querySelectorAll('.command').length > 0;`));
    await page(`document.querySelector('#voice-search').setSelectionRange(1, 2);`);
    await emit('capabilities'); await wait(80);
    assert.deepEqual(await page(`const n = document.activeElement; return [n.id, n.value, n.selectionStart, n.selectionEnd];`),
      ['voice-search', 'apu', 1, 2], 'capability updates preserve search focus, text and selection');
    await page('window.searchBeforeStatus = document.activeElement;');
    await emit('voice');
    await until(page, `return document.querySelector('#tab-voice').textContent.includes('Input review phrase');`);
    assert.equal(await page('return document.activeElement === window.searchBeforeStatus;'), true, 'voice status never replaces the search');
    press('Backspace');
    await until(page, `return document.querySelector('#voice-search').value;`, 'au');
    key('keyDown', 'A', ['control']); key('keyUp', 'A', ['control']); type('no matching phrase');
    await until(page, `return document.querySelector('#tab-voice').textContent.includes('No commands match.');`);
    key('keyDown', 'A', ['control']); key('keyUp', 'A', ['control']); press('Backspace');
    await until(page, `return document.querySelector('#voice-search').value;`, '');
    assert.equal(await root('return keyboardClaimed;'), true, 'typing, selection and Backspace stay captured');
    assert.equal(await page('return document.documentElement.scrollWidth > innerWidth;'), false, 'Voice fits ' + width);

    await require('./toolbar-taxi-browser')({ win, page, root, click, key, press, until, width });
    await click('#settings-button');
    const settingIds = await page(`return [...document.querySelectorAll('#settings-body button')].map(n => n.id);`);
    assert.equal(settingIds.length, 16, 'all six settings groups are exercised');
    for (const id of settingIds) {
      await click('#' + id);
      assert.equal(await active(), id, 'changing a setting preserves focus on ' + id);
      assert.equal(await page(`return document.querySelector('#${id}').getAttribute('aria-pressed');`), 'true');
      assert.equal(await root('return keyboardClaimed;'), true);
    }
    const controls = await page(`return document.querySelectorAll('#settings-sheet button').length;`);
    for (let step = 0; step < controls + 2; step++) {
      press('Tab');
      assert.equal(await page(`return document.querySelector('#settings-sheet').contains(document.activeElement);`), true, 'Tab stays in Settings');
    }
    for (let step = 0; step < controls + 2; step++) {
      key('keyDown', 'Tab', ['shift']); key('keyUp', 'Tab', ['shift']);
      assert.equal(await page(`return document.querySelector('#settings-sheet').contains(document.activeElement);`), true, 'Shift+Tab stays in Settings');
    }
    await page(`document.querySelector('#tab-button-flight').focus();`);
    assert.equal(await page(`return document.querySelector('#settings-sheet').contains(document.activeElement);`), true, 'background focus cannot bypass the modal');
    const settings = await bounds('#settings-body');
    const backgroundScroll = await page(`return document.querySelector('#content').scrollTop;`);
    mouse('mouseMove', settings.x + settings.width / 2, settings.y + settings.height / 2);
    mouse('mouseWheel', settings.x + settings.width / 2, settings.y + settings.height / 2, { deltaX: 0, deltaY: -300 });
    await wait(80);
    assert.equal(await page(`return document.querySelector('#content').scrollTop;`), backgroundScroll, 'Settings wheel does not scroll background content');
    assert.equal(await page('return document.documentElement.scrollWidth > innerWidth;'), false, 'Settings fits ' + width);
    press('Escape');
    await until(page, `return document.querySelector('#settings-sheet').classList.contains('hidden');`);
    assert.equal(await active(), 'settings-button', 'Escape returns focus to Settings trigger');
    await click('#settings-button'); await click('#settings-reset');
    assert.equal(await active(), 'settings-reset');
    assert.deepEqual(await page(`const p = JSON.parse(localStorage.getItem('ff_toolbar_prefs_v1')); return [p.theme,p.scale,p.density,p.timeZone,p.weightUnit,p.defaultTab];`),
      ['dark', 'l', 'comfortable', 'utc', 'plan', 'flight']);
    await click('#settings-sheet button[data-close-settings]');
    assert.equal(await active(), 'settings-button', 'close button restores focus');
    await click('#settings-button');
    const sheet = await bounds('#settings-sheet');
    mouse('mouseDown', sheet.x + 3, sheet.y + 3, { button: 'left', clickCount: 1 });
    mouse('mouseUp', sheet.x + 3, sheet.y + 3, { button: 'left', clickCount: 1 });
    await until(page, `return document.querySelector('#settings-sheet').classList.contains('hidden');`);
    assert.equal(await active(), 'settings-button', 'scrim close restores focus');
    await tab('flight');
    assert.equal(await count(), initialWrites, 'navigation, search and Settings never execute an aircraft command');
    assert.deepEqual(await root('return parentInputs;'), parentInputs, 'all section input stays inside the iframe');
  }

  // Reconnect/replay must preserve an edit without navigating the iframe.
  await tab('voice'); await click('#voice-search'); type('apu');
  const before = await root(`return document.querySelector('iframe').src;`);
  await emit('disconnect');
  await until(page, `return document.querySelector('#connection-pill').textContent;`, 'Waiting for FlightFabric');
  await until(page, `return document.querySelector('#connection-pill').textContent;`, 'Connected');
  assert.equal(await root(`return document.querySelector('iframe').src;`), before);
  assert.deepEqual(await page(`return [document.activeElement.id, document.activeElement.value];`), ['voice-search', 'apu']);
  assert.equal(await root('return keyboardClaimed;'), true);
  await emit('update');
  await until(root, `return document.querySelector('iframe').src !== ${JSON.stringify(before)} && document.querySelector('flightfabric-panel').ready;`);
  await until(page, `return document.querySelector('#connection-pill').textContent;`, 'Connected');
  assert.equal(await root('return keyboardClaimed;'), false, 'page replacement releases native keyboard capture');
  assert.equal(await count(), initialWrites, 'reconnect and update never replay aircraft writes');
  await tab('flight');
  console.log('Whole toolbar: Flight/Plan/Voice/Taxi, all disclosures, settings, modal focus, search editing/replay, manual guidance, scrolling, reconnect and update passed at desktop/375px/320px.');
};
